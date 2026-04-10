const currentUser = document.querySelector('b').innerText;
const socket = io();
let myPrivateKey = null;
let myPublicKeyBase64 = null;
let currentChatTarget = null;

// --- PRODUCTION SAFE BASE64 CONVERTERS ---
// Prevents "Maximum call stack size exceeded" on large messages
function bufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
}

function base64ToBuffer(base64) {
    const binary_string = window.atob(base64);
    const bytes = new Uint8Array(binary_string.length);
    for (let i = 0; i < binary_string.length; i++) {
        bytes[i] = binary_string.charCodeAt(i);
    }
    return bytes.buffer;
}

// --- E2EE ENGINE ---
async function initCrypto() {
    const storedPriv = localStorage.getItem(`priv_${currentUser}`);
    const storedPub = localStorage.getItem(`pub_${currentUser}`);
    
    if (!storedPriv || !storedPub) {
        const keys = await window.crypto.subtle.generateKey(
            { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
            true, ["encrypt", "decrypt"]
        );
        const privExport = await window.crypto.subtle.exportKey("pkcs8", keys.privateKey);
        const pubExport = await window.crypto.subtle.exportKey("spki", keys.publicKey);
        
        myPublicKeyBase64 = bufferToBase64(pubExport);
        localStorage.setItem(`priv_${currentUser}`, JSON.stringify(Array.from(new Uint8Array(privExport))));
        localStorage.setItem(`pub_${currentUser}`, myPublicKeyBase64);
        
        myPrivateKey = keys.privateKey;
        socket.emit('store_pub_key', { pub_key: myPublicKeyBase64 });
    } else {
        const privBuf = new Uint8Array(JSON.parse(storedPriv));
        myPrivateKey = await window.crypto.subtle.importKey("pkcs8", privBuf, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["decrypt"]);
        myPublicKeyBase64 = storedPub;
        socket.emit('store_pub_key', { pub_key: myPublicKeyBase64 });
    }
}

async function encryptData(plainText, pubKeyBase64) {
    try {
        const binaryKey = base64ToBuffer(pubKeyBase64);
        const pubKey = await window.crypto.subtle.importKey("spki", binaryKey, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
        const encoded = new TextEncoder().encode(plainText);
        const encrypted = await window.crypto.subtle.encrypt({ name: "RSA-OAEP" }, pubKey, encoded);
        return bufferToBase64(encrypted);
    } catch (e) {
        console.error("Encryption failed:", e);
        return null;
    }
}

async function decryptData(encryptedBase64) {
    try {
        const binary = base64ToBuffer(encryptedBase64);
        const decrypted = await window.crypto.subtle.decrypt({ name: "RSA-OAEP" }, myPrivateKey, binary);
        return new TextDecoder().decode(decrypted);
    } catch (e) { 
        return "⚠️ [Decryption Error: Key mismatch or corrupted data]"; 
    }
}

// --- CORE FUNCTIONS ---
async function loadPersistentContacts() {
    const listContainer = document.getElementById('users');
    if (!listContainer) return;

    try {
        const response = await fetch('/get_contacts');
        const data = await response.json();
        
        listContainer.innerHTML = ''; 

        if (data.length === 0) {
            listContainer.innerHTML = '<li style="text-align:center; padding: 20px; color:#94a3b8;">No recent chats.</li>';
            return;
        }

        data.forEach(user => {
            const li = document.createElement('li');
            li.className = `contact-item ${currentChatTarget === user.username ? 'active' : ''}`;
            li.onclick = () => selectUser(user.username);

            const statusClass = user.online ? 'online' : 'offline';
            li.innerHTML = `
                <div class="avatar">${user.username[0].toUpperCase()}</div>
                <div class="user-details">
                    <div class="contact-name">${user.username}</div>
                    <div class="contact-status">${user.online ? 'Online' : 'Offline'}</div>
                </div>
                <div class="status-dot ${statusClass}"></div>
            `;
            listContainer.appendChild(li);
        });
    } catch (err) { console.error("Sidebar load error:", err); }
}
// Add this at the top with your other variables
let contacts = []; 

// --- THE FIX FOR THE SIDEBAR ---
async function refreshSidebar() {
    try {
        const response = await fetch('/get_contacts');
        const data = await response.json();
        
        const listContainer = document.getElementById('users');
        if (!listContainer) return; // Prevent errors if UI isn't ready

        listContainer.innerHTML = ''; // Clear current list

        data.forEach(user => {
            const li = document.createElement('li');
            li.className = `contact-item ${currentChatTarget === user.username ? 'active' : ''}`;
            li.onclick = () => selectUser(user.username);

            // Logic for the Green Online Dot
            const statusClass = user.online ? 'online' : 'offline';
            const lockIcon = user.has_key ? '<i class="fa-solid fa-lock-shield" style="color:#50e887; font-size:0.7rem;"></i>' : '';

            li.innerHTML = `
                <div class="avatar">${user.username[0].toUpperCase()}</div>
                <div class="user-details">
                    <div class="contact-name">${user.username} ${lockIcon}</div>
                    <div class="contact-status">${user.online ? 'Online' : 'Offline'}</div>
                </div>
                <div class="status-dot ${statusClass}"></div>
            `;
            listContainer.appendChild(li);
        });
    } catch (err) {
        console.error("Failed to load contacts:", err);
    }
}


async function selectUser(username) {
    currentChatTarget = username;
    const header = document.getElementById('target-header');
    if (header) header.innerText = username;

    document.querySelectorAll('#users li').forEach(li => {
        li.classList.remove('active-chat'); 
        const nameDiv = li.querySelector('.contact-name');
        if (nameDiv && nameDiv.innerText.trim() === username) li.classList.add('active-chat');
    });

    socket.emit('get_pub_key', { target: username }, (data) => {
        if (!data.pub_key) {
            header.innerHTML = `${username} <span style="color:orange; font-size:0.7rem;">(Not Encrypted - User Offline/No Key)</span>`;
        } else {
            header.innerHTML = `${username} <span style="color:green; font-size:0.7rem;">(Encrypted)</span>`;
        }
    });

    const chatBox = document.getElementById('chat-box');
    chatBox.innerHTML = '<div style="text-align:center; padding:20px; opacity:0.5;">Loading conversation...</div>';

    try {
        const res = await fetch(`/get_history/${username}`);
        const messages = await res.json();
        chatBox.innerHTML = ''; 

        if (messages.length === 0) {
            chatBox.innerHTML = '<div style="text-align:center; padding:20px; opacity:0.3;">No messages yet. Say hi!</div>';
        }

        for (let msg of messages) {
            if (msg.encrypted) {
                if (msg.target === currentUser) {
                    msg.content = await decryptData(msg.content);
                } else if (msg.sender === currentUser && msg.sender_content) {
                    msg.content = await decryptData(msg.sender_content);
                } else {
                    msg.content = "⚠️ [Encrypted Message]";
                }
            }
            appendMessage(msg, msg.sender === currentUser);
        }
        socket.emit('read_event', { sender: username, user: currentUser });
        
    } catch (err) {
        chatBox.innerHTML = '<div style="text-align:center; color:red;">Failed to load messages.</div>';
    }
}

function sendText() {
    const input = document.getElementById('msg-input');
    if (!currentChatTarget) return alert("Select a contact first.");
    
    if (input.value.length > 150) {
        alert("Message too long for RSA encryption. Please keep it under 150 characters.");
        return;
    }

    if (input.value.trim() !== "") {
        sendMessage(input.value, 'text', currentChatTarget);
        input.value = "";
    }
}

function sendMessage(content, type, target) {
    socket.emit('get_pub_key', { target: target }, async (data) => {
        let msgData = { sender: currentUser, target: target, type: type, timestamp: new Date().toISOString() };
        
        if (data.pub_key) {
            msgData.content = await encryptData(content, data.pub_key);
            msgData.sender_content = await encryptData(content, myPublicKeyBase64);
            msgData.encrypted = true;
        } else {
            msgData.content = content; 
            msgData.encrypted = false;
        }

        if(msgData.content === null) return alert("Encryption failed. Try a shorter message.");

        socket.emit('send_msg', msgData);
        appendMessage({...msgData, content: content}, true);
    });
}

function renderUserList(list, elementId, isOnlineList) {
    const container = document.getElementById(elementId);
    if (!container) return;

    if (list.length === 0) {
        container.innerHTML = `<li style="padding:15px; color:#94a3b8; text-align:center; font-size:0.8rem;">No users found</li>`;
        return;
    }

    container.innerHTML = list.map(u => `
        <li onclick="handleUserSelect('${u}')" class="contact-item ${currentChatTarget === u ? 'active-chat' : ''}">
            <div class="user-avatar" style="width: 35px; height: 35px; background: #50e887; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: white; font-weight: bold; margin-right: 12px;">
                ${u[0].toUpperCase()}
            </div>
            <div class="user-details">
                <div class="contact-name" style="font-weight: 600; color: #0f172a;">${u}</div>
                ${isOnlineList ? '<div style="font-size: 0.7rem; color: #10b981;">● Online</div>' : ''}
            </div>
        </li>
    `).join('');
}

function handleUserSelect(username) {
    closeOnlineModal();
    selectUser(username);
}

socket.on('receive_msg', async (data) => {
    if (data.sender === currentChatTarget) {
        if (data.encrypted) data.content = await decryptData(data.content);
        appendMessage(data, false);
        socket.emit('read_event', { sender: data.sender, user: currentUser });
    }
});

socket.on('user_status_update', (userList) => {
    const others = userList.filter(u => u !== currentUser);
    // Update the modal
    renderUserList(others, 'online-users-list', true);
    
    // PRODUCTION FIX: Also update the sidebar indicators in real-time
    document.querySelectorAll('#users li').forEach(li => {
        const name = li.querySelector('.contact-name').innerText;
        updateSidebarStatus(name, others.includes(name));
    });
});

async function uploadMedia(file) {
    if (!file || !currentChatTarget) return;
    let formData = new FormData();
    formData.append('file', file);
    const res = await fetch('/upload', { method: 'POST', body: formData });
    const data = await res.json();
    let type = file.type.startsWith('image') ? 'image' : file.type.startsWith('video') ? 'video' : 'file';
    sendMessage(data.url, type, currentChatTarget);
}
function updateSidebarStatus(username, isOnline) {
    const sidebarItems = document.querySelectorAll('#users li');
    sidebarItems.forEach(li => {
        const name = li.querySelector('.contact-name').innerText;
        if(name === username) {
            // Add or remove a green dot/status text
            let statusDiv = li.querySelector('.status-indicator');
            if(!statusDiv) {
                statusDiv = document.createElement('div');
                statusDiv.className = 'status-indicator';
                statusDiv.style = "font-size: 0.7rem; color: #10b981;";
                li.querySelector('.user-details').appendChild(statusDiv);
            }
            statusDiv.innerText = isOnline ? '● Online' : '';
        }
    });
}
function appendMessage(data, isMine) {
    const chatBox = document.getElementById('chat-box');
    const msgDiv = document.createElement('div');
    msgDiv.className = isMine ? 'mine' : 'theirs';
    
    const time = data.timestamp ? new Date(data.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : "";
    
    let body = '';
    if (data.type === 'image') body = `<img src="${data.content}" style="max-width:250px; border-radius:8px;">`;
    else if (data.type === 'video') body = `<video src="${data.content}" controls style="max-width:200px;"></video>`;
    else body = `<p class="msg-content">${data.content}</p>`;
    
    const ticks = isMine ? `<span class="tick" style="color: ${data.read ? '#34b7f1' : '#94a3b8'};">✔✔</span>` : '';
    
    msgDiv.innerHTML = `
        <div class="bubble">
            ${body}
            <div style="font-size:0.65rem; opacity:0.5; text-align:right; margin-top:4px;">${time} ${ticks}</div>
        </div>
    `;
    
    chatBox.appendChild(msgDiv);
    chatBox.scrollTop = chatBox.scrollHeight;
}

// --- SOCKET LISTENERS ---

socket.on('msg_read_confirmed', () => {
    document.querySelectorAll('.mine .tick').forEach(t => t.style.color = '#34b7f1');
});

window.onload = async () => {
    try {
        await initCrypto();
    } catch (e) {
        console.warn("Encryption unavailable (Need HTTPS):", e);
        alert("Warning: Encryption disabled. Use HTTPS for private messaging.");
    }
    // Always load contacts even if crypto fails
    loadPersistentContacts();
};

function openOnlineModal() {
    const modal = document.getElementById('online-modal');
    if (modal) modal.style.display = 'flex'; 
}

function closeOnlineModal() {
    const modal = document.getElementById('online-modal');
    if (modal) modal.style.display = 'none';
}

window.onclick = function(event) {
    const modal = document.getElementById('online-modal');
    if (event.target == modal) {
        modal.style.display = "none";
    }
}

// When anyone logs in/out, the server says 'status_update'
socket.on('status_update', () => {
    refreshSidebar();
});

// Update your window.onload to use the new name
window.onload = async () => {
    await initCrypto();
    refreshSidebar(); // Use the new function name here!
};