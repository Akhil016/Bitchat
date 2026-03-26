// Listen for typing status
socket.on('display_typing', (data) => {
    if (currentChatUser === data.sender) {
        document.getElementById('chat-status').innerText = 'typing...';
    }
});

socket.on('hide_typing', () => {
    document.getElementById('chat-status').innerText = 'online';
});

// Listen for the "Blue Checks" update
socket.on('msg_status_update', (data) => {
    const checkmark = document.querySelector(`#msg-${data.msg_id} .status-icon`);
    if (checkmark) {
        if (data.status === 'delivered') {
            checkmark.innerText = '✓✓';
        } else if (data.status === 'read') {
            checkmark.innerText = '✓✓';
            checkmark.classList.add('blue-check');
        }
    }
});

// Detect when user is typing to emit event
document.getElementById('msg-input').onkeypress = () => {
    socket.emit('typing', { sender: myUsername, receiver: currentChatUser });
    
    // Clear typing status after 2 seconds of no activity
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
        socket.emit('stop_typing', { receiver: currentChatUser });
    }, 2000);
};