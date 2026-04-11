import os
import datetime
from flask import Flask, render_template, request, redirect, url_for, flash, jsonify
from flask_socketio import SocketIO, emit, join_room
from flask_login import LoginManager, login_user, logout_user, login_required, current_user
from database import db, create_user, verify_user, User
from bson import ObjectId
from werkzeug.utils import secure_filename
import uuid
from flask_socketio import SocketIO, emit, join_room, leave_room
from bson import ObjectId

app = Flask(__name__)
app.secret_key = os.environ.get("FLASK_SECRET_KEY", "ultimate_secret_key_123")
app.config['UPLOAD_FOLDER'] = 'static/uploads'

# Production Tip: Set message_queue='redis://localhost:6379' for multi-server scaling
socketio = SocketIO(app, cors_allowed_origins="*", max_http_buffer_size=1e8)
login_manager = LoginManager(app)
login_manager.login_view = 'login'

app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024  # Allow up to 50MB
ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg', 'gif', 'mp4', 'pdf'}

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

@login_manager.user_loader
def load_user(user_id):
    u = db.users.find_one({"_id": ObjectId(user_id)})
    return User(u) if u else None

@app.route('/')
@login_required
def index():
    return render_template('index.html', username=current_user.username)

@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        username = request.form['username']
        password = request.form['password']
        user = verify_user(username, password)
        if user:
            login_user(user)
            return redirect(url_for('index'))
        else:
            flash('Invalid username or password')
    return render_template('login.html')

@app.route('/signup', methods=['GET', 'POST'])
def signup():
    if request.method == 'POST':
        username = request.form['username']
        password = request.form['password']
        if create_user(username, password):
            flash('Account created! Please login.')
            return redirect(url_for('login'))
        else:
            flash('Username already exists.')
    return render_template('signup.html')

@app.route('/logout')
@login_required
def logout():
    db.users.update_one({"username": current_user.username}, {"$set": {"online": False, "sid": None}})
    logout_user()
    return redirect(url_for('login'))

@app.route('/upload', methods=['POST'])
@login_required
def upload_file():
    if 'file' not in request.files:
        return jsonify({"error": "No file"}), 400
    
    file = request.files['file']
    filename = secure_filename(f"{uuid.uuid4()}_{file.filename}")
    
    # Ensure directory exists
    os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)
    
    filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
    file.save(filepath)
    
    return jsonify({
        "url": url_for('static', filename=f'uploads/{filename}'),
        "type": request.form.get('type')
    })

@app.route('/get_contacts')
@login_required
def get_contacts():
    # 1. Get unique usernames from messages where you are either sender or recipient
    sent_to = db.messages.distinct("target", {"sender": current_user.username, "is_group": {"$ne": True}})
    received_from = db.messages.distinct("sender", {"target": current_user.username, "is_group": {"$ne": True}})
    
    # Combine and remove duplicates
    contact_names = list(set(sent_to + received_from))
    
    # 2. Fetch only these specific users to show in the sidebar
    users = list(db.users.find(
        {"username": {"$in": contact_names}}, 
        {"_id": 0, "username": 1, "online": 1}
    ))
    
    # 3. Fetch groups the user is a member of
    groups = list(db.groups.find({"members": current_user.username}))
    for g in groups:
        g['_id'] = str(g['_id'])
        
    return jsonify({"users": users, "groups": groups})

@app.route('/get_online_users')
@login_required
def get_online_users():
    messaged_users = db.messages.distinct("target", {"sender": current_user.username, "is_group": {"$ne": True}}) + \
                     db.messages.distinct("sender", {"target": current_user.username, "is_group": {"$ne": True}})
    
    filter_list = list(set(messaged_users))
    filter_list.append(current_user.username)

    online_non_contacts = list(db.users.find({
        "online": True, 
        "username": {"$nin": filter_list}
    }, {"_id": 0, "username": 1}))

    return jsonify(online_non_contacts)

# --- NEW GROUP ROUTES ---
@app.route('/create_group', methods=['POST'])
@login_required
def create_group():
    data = request.json
    name = data.get('name')
    members = data.get('members', [])
    if current_user.username not in members:
        members.append(current_user.username)
    
    group_id = db.groups.insert_one({
        "name": name,
        "members": members,
        "created_by": current_user.username,
        "timestamp": datetime.datetime.now(datetime.timezone.utc)
    }).inserted_id
    
    return jsonify({"success": True, "group_id": str(group_id)})

@app.route('/get_groups')
@login_required
def get_groups():
    groups = list(db.groups.find({"members": current_user.username}))
    for g in groups: g['_id'] = str(g['_id'])
    return jsonify(groups)

@app.route('/get_group_keys', methods=['POST'])
@login_required
def get_group_keys():
    members = request.json.get('members', [])
    users = list(db.users.find({"username": {"$in": members}}, {"_id": 0, "username": 1, "public_key": 1}))
    keys = {u['username']: u.get('public_key') for u in users}
    return jsonify(keys)

@app.route('/get_history/<target>')
@login_required
def get_history(target):
    # Check if target is a Group (ObjectId) or a Username
    if ObjectId.is_valid(target):
        query = {"target": target}
    else:
        query = {"$or": [
            {"sender": current_user.username, "target": target},
            {"sender": target, "target": current_user.username}
        ]}
    
    msgs = list(db.messages.find(query).sort("timestamp", 1))
    for m in msgs: m['_id'] = str(m['_id'])
    
    # If group, include member info for key exchange
    if ObjectId.is_valid(target):
        group = db.groups.find_one({"_id": ObjectId(target)})
        return jsonify({"messages": msgs, "is_group": True, "members": group['members'], "name": group['name']})
        
    return jsonify({"messages": msgs, "is_group": False})

# --- Group Management Routes ---

@app.route('/manage_group', methods=['POST'])
@login_required
def manage_group():
    data = request.json
    group_id = data.get('group_id')
    action = data.get('action') # 'add' or 'remove'
    target_user = data.get('username')
    
    group = db.groups.find_one({"_id": ObjectId(group_id)})
    if not group:
        return jsonify({"success": False, "error": "Group not found"})
    
    # Check if current user is the admin (creator)
    if group.get('created_by') != current_user.username:
        return jsonify({"success": False, "error": "Only the admin can manage members"})

    if action == 'add':
        db.groups.update_one({"_id": ObjectId(group_id)}, {"$addToSet": {"members": target_user}})
    elif action == 'remove':
        if target_user == group.get('created_by'):
            return jsonify({"success": False, "error": "Admin cannot be removed"})
        db.groups.update_one({"_id": ObjectId(group_id)}, {"$pull": {"members": target_user}})
    
    # Notify clients to update their rooms
    socketio.emit('group_update', {"group_id": group_id, "user": target_user, "action": action})
    return jsonify({"success": True})

# --- SOCKET LOGIC ---
def broadcast_status():
    # Fix: Convert to list and exclude _id to avoid JSON serialization errors
    users = list(db.users.find({}, {"_id": 0, "username": 1, "online": 1}))
    emit('status_update', {"users": users}, broadcast=True)

@socketio.on('connect')
def handle_connect(auth=None): # Fix: Added 'auth' parameter to prevent TypeError
    if current_user.is_authenticated:
        # Join personal room for 1-on-1 messages
        join_room(current_user.username)
        
        # Join rooms for all groups the user belongs to
        groups = db.groups.find({"members": current_user.username})
        for g in groups:
            join_room(str(g['_id']))
            
        db.users.update_one(
            {"username": current_user.username}, 
            {"$set": {"online": True, "sid": request.sid}}
        )
        broadcast_status()

@socketio.on('disconnect')
def handle_disconnect():
    if current_user.is_authenticated:
        db.users.update_one({"username": current_user.username, "sid": request.sid}, {"$set": {"online": False, "sid": None}})
        broadcast_status()

@socketio.on('store_pub_key')
def store_key(data):
    db.users.update_one({"username": current_user.username}, {"$set": {"public_key": data['pub_key']}})

@socketio.on('get_pub_key')
def get_key(data):
    user = db.users.find_one({"username": data['target']})
    return {"pub_key": user.get('public_key') if user else None}

@socketio.on('send_msg')
def handle_msg(data):
    data['timestamp'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    db.messages.insert_one(data.copy())
    
    if data.get('is_group'):
        # Broadcast to the group's room
        emit('receive_msg', data, room=data['target'])
    else:
        # Standard 1-on-1 delivery using the recipient's personal room
        emit('receive_msg', data, room=data['target'])
        if data['sender'] != data['target']:
            emit('receive_msg', data, room=data['sender']) # Bounce back to sender for multiple tabs

@socketio.on('read_event')
def handle_read(data):
    pass # Add read receipt logic here later if needed

if __name__ == '__main__':
    socketio.run(app, debug=True)