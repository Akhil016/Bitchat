from flask_socketio import emit, join_room

def register_socket_events(socketio):
    
    @socketio.on('join_private')
    def handle_join(data):
        room = data['username']
        join_room(room)
        print(f"User {room} joined their private notification room.")

    @socketio.on('typing')
    def handle_typing(data):
        # data: { 'sender': 'Alice', 'receiver': 'Bob' }
        emit('display_typing', {'sender': data['sender']}, room=data['receiver'])

    @socketio.on('stop_typing')
    def handle_stop_typing(data):
        emit('hide_typing', room=data['receiver'])

    @socketio.on('message_delivered')
    def handle_delivered(data):
        # data: { 'msg_id': '123', 'sender': 'Alice' }
        # Notify 'Alice' that her message was delivered to 'Bob'
        emit('msg_status_update', {'msg_id': data['msg_id'], 'status': 'delivered'}, room=data['sender'])

    @socketio.on('message_read')
    def handle_read(data):
        # Notify sender the message is now blue-checked
        emit('msg_status_update', {'msg_id': data['msg_id'], 'status': 'read'}, room=data['sender'])