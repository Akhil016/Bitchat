import os
import datetime
from flask import Flask, render_template, request, redirect, url_for, flash, jsonify
from flask_socketio import SocketIO, emit
from flask_login import LoginManager, login_user, logout_user, login_required, current_user
from database import db, create_user, verify_user, User
from bson import ObjectId

app = Flask(__name__)
app.secret_key = os.environ.get("FLASK_SECRET_KEY", "ultimate_secret_key_123")

# Production Tip: Set message_queue='redis://localhost:6379' for multi-server scaling
socketio = SocketIO(app, cors_allowed_origins="*", max_http_buffer_size=1e8)
login_manager = LoginManager(app)
login_manager.login_view = 'login'

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
    # Mark user offline in DB before logging out
    db.users.update_one({"username": current_user.username}, {"$set": {"online": False, "sid": None}})
    logout_user()
    return redirect(url_for('login'))

@app.route('/get_contacts')
@login_required
def get_contacts():
    # 1. Fetch all users except the current one
    # 2. Return their username, online status, and if they have an encryption key
    users = list(db.users.find(
        {"username": {"$ne": current_user.username}}, 
        {"username": 1, "online": 1, "public_key": 1}
    ))
    
    contact_list = []
    for u in users:
        contact_list.append({
            "username": u['username'],
            "online": u.get('online', False),
            "has_key": u.get('public_key') is not None
        })
    
    return jsonify(contact_list)

# Ensure this function is called inside your handle_connect and handle_disconnect
def broadcast_status():
    socketio.emit('status_update') # Tells all clients to refresh their sidebars
@app.route('/get_history/<target>')
@login_required
def get_history(target):
    messages = list(db.messages.find({
        "$or": [
            {"sender": current_user.username, "target": target},
            {"sender": target, "target": current_user.username}
        ]
    }).sort("timestamp", 1))
    for m in messages: m['_id'] = str(m['_id'])
    return jsonify(messages)

# --- SOCKET LOGIC ---

def broadcast_status():
    online = [u['username'] for u in db.users.find({"online": True})]
    socketio.emit('status_update', online)

@socketio.on('connect')
def handle_connect():
    if current_user.is_authenticated:
        db.users.update_one({"username": current_user.username}, {"$set": {"online": True, "sid": request.sid}})
        broadcast_status()

@socketio.on('disconnect')
def handle_disconnect():
    if current_user.is_authenticated:
        # Only mark offline if the SID matches (fixes page refresh bug)
        db.users.update_one({"username": current_user.username, "sid": request.sid}, {"$set": {"online": False, "sid": None}})
        broadcast_status()

@socketio.on('typing')
def handle_typing(data):
    recipient = db.users.find_one({"username": data['target']})
    if recipient and recipient.get('sid'):
        emit('is_typing', {"user": current_user.username, "typing": data['isTyping']}, room=recipient['sid'])

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
    recipient = db.users.find_one({"username": data['target']})
    if recipient and recipient.get('sid'):
        emit('receive_msg', data, room=recipient['sid'])

if __name__ == '__main__':
    socketio.run(app, debug=True)