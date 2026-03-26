document.getElementById('send-btn').onclick = async () => {
    const text = document.getElementById('msg-input').value;
    const receiver = currentChatUser;
    
    // 1. Encrypt text for E2EE
    const encrypted = await Encryption.encryptMessage(text, receiverPublicKey);
    
    // 2. Send via Socket
    const msgData = {
        msg_id: Date.now(),
        sender: myUsername,
        receiver: receiver,
        content: encrypted,
        timestamp: new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})
    };
    
    socket.emit('send_msg', msgData);
    
    // 3. Clear input and render locally
    document.getElementById('msg-input').value = "";
    renderMessage(myUsername, text, msgData.timestamp, msgData.msg_id);
};

// Handle Video/Photo Sharing
async function shareMedia(file) {
    const formData = new FormData();
    formData.append('file', file);

    const res = await fetch('http://localhost:5000/api/media/upload', {
        method: 'POST',
        body: formData
    });
    const data = await res.json();

    // Broadcast the URL as a message
    socket.emit('send_msg', {
        type: 'media',
        url: data.url,
        receiver: currentChatUser
    });
}