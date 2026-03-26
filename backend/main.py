from flask import Flask, request, jsonify
from flask_socketio import SocketIO, emit, join_room
from flask_cors import CORS
from routes.auth_routes import auth_bp
import datetime

app = Flask(__name__)
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*")

# Register Auth Routes
app.register_blueprint(auth_bp, url_prefix='/api/auth')

@socketio.on('join')
def on_join(data):
    username = data['username']
    join_room(username)
    print(f"{username} is now online.")
    emit('status_update', {'user': username, 'status': 'online'}, broadcast=True)

@socketio.on('send_msg')
def handle_msg(data):
    # data includes: sender, receiver, encrypted_content, timestamp
    data['status'] = 'sent' 
    # Emit to the specific receiver's room
    emit('receive_msg', data, room=data['receiver'])
    # Send confirmation back to sender
    emit('msg_sent_confirm', {'msg_id': data['msg_id'], 'status': 'sent'}, room=data['sender'])

@socketio.on('read_receipt')
def handle_read(data):
    # When receiver opens chat, notify the sender
    emit('msg_status_change', {'msg_id': data['msg_id'], 'status': 'read'}, room=data['sender'])

from flask import Flask, render_template

app = Flask(__name__)

@app.route('/')
def home():
    # This looks inside the /templates folder automatically
    return render_template('index.html')

if __name__ == '__main__':
    # Use 0.0.0.0 to ensure Windows doesn't block local traffic
    app.run(debug=True, host='0.0.0.0', port=5000)