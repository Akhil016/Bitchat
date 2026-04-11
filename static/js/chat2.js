const currentUser = document.querySelector('b').innerText;
const socket = io();
let myPrivateKey = null;
let myPublicKeyBase64 = null;
let currentChatTarget = null;
let isGroupChat = false;
let groupMembers = [];

// --- PRODUCTION SAFE BASE64 CONVERTERS ---
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

// --- E2EE ENGINE (RSA for Text and Keys) ---
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

// --- HYBRID AES E2EE ENGINE (For Files) ---
async function generateAESKey() {
    return await window.crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]
    );
}

async function encryptFile(file, aesKey) {
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const content = await file.arrayBuffer();
    const encryptedContent = await window.crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv }, aesKey, content
    );
    return { encryptedContent, iv };
}

// --- CORE FUNCTIONS ---
let contacts = []; 

async function loadPersistentContacts() {
    refreshSidebar(); // Merged logic to keep it DRY
}

async function refreshSidebar() {
    try {
        const [contactsRes, groupsRes] = await Promise.all([
            fetch('/get_contacts'),
            fetch('/get_groups')
        ]);
        const contacts = await contactsRes.json();
        const groups = await groupsRes.json();
        
        const listContainer = document.getElementById('users');
        listContainer.innerHTML = ''; 

        // Render Groups
        groups.forEach(g => {
            const li = document.createElement('li');
            li.className = `contact-item ${currentChatTarget === g._id ? 'active' : ''}`;
            li.onclick = () => selectUser(g._id, true);
            li.innerHTML = `<div class="avatar" style="background:#f59e0b"><i class="fa-solid fa-users"></i></div>
                            <div class="user-details"><b>${g.name}</b><small>Group</small></div>`;
            listContainer.appendChild(li);
        });

        // Render Contacts
        contacts.forEach(user => {
            const li = document.createElement('li');
            li.className = `contact-item ${currentChatTarget === user.username ? 'active' : ''}`;
            li.onclick = () => selectUser(user.username, false);
            li.innerHTML = `
                <div class="avatar">${user.username[0].toUpperCase()}</div>
                <div class="user-details">
                    <b>${user.username}</b>
                    <small>${user.online ? 'Online' : 'Offline'}</small>
                </div>
                <div class="status-dot ${user.online ? 'online' : 'offline'}"></div>`;
            listContainer.appendChild(li);
        });
    } catch (e) { console.error("Sidebar Sync Failed", e); }
}

async function selectUser(id, isGroup = false) {
    currentChatTarget = id;
    isGroupChat = isGroup;
    
    const res = await fetch(`/get_history/${id}`);
    const data = await res.json();
    
    document.getElementById('target-header').innerText = isGroup ? data.name : id;
    if (isGroup) groupMembers = data.members;

    const chatBox = document.getElementById('chat-box');
    chatBox.innerHTML = '';
    
    for (const msg of data.messages) {
        await decryptAndAppend(msg);
    }
}

async function sendText() {
    const text = document.getElementById('msg-input').value;
    if (!text || !currentChatTarget) return;

    let payload = { sender: currentUser, target: currentChatTarget, type: 'text', timestamp: new Date().toISOString() };

    if (isGroupChat) {
        // 1. Generate one AES key for this message
        const aesKey = await generateAESKey();
        const { encryptedContent, iv } = await encryptTextWithAES(text, aesKey);
        
        // 2. Encrypt that AES key for EVERY member in the group
        const keyMap = {};
        for (const member of groupMembers) {
            const res = await socket.emitWithAck('get_pub_key', { target: member });
            if (res.pub_key) {
                keyMap[member] = await encryptAESKeyWithRSA(aesKey, res.pub_key);
            }
        }
        payload.content = bufferToBase64(encryptedContent);
        payload.iv = bufferToBase64(iv);
        payload.keys = keyMap;
        payload.is_group = true;
    } else {
        // Standard 1-on-1 RSA Encryption
        // ... (existing RSA logic)
    }

    socket.emit('send_msg', payload);
    document.getElementById('msg-input').value = '';
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

// --- NEW E2EE MEDIA UPLOAD ---
async function uploadMedia(file) {
    if (!file || !currentChatTarget) return alert("Select a user first");

    socket.emit('get_pub_key', { target: currentChatTarget }, async (response) => {
        if (!response.pub_key) return alert("Recipient encryption unavailable");

        // 1. AES Encryption for the File
        const aesKey = await generateAESKey();
        const { encryptedContent, iv } = await encryptFile(file, aesKey);

        // 2. Encrypt AES key for Recipient
        const pubKeyBuf = base64ToBuffer(response.pub_key);
        const rsaPubKey = await window.crypto.subtle.importKey("spki", pubKeyBuf, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
        const exportedAesKey = await window.crypto.subtle.exportKey("raw", aesKey);
        const encAesKeyTarget = await window.crypto.subtle.encrypt({ name: "RSA-OAEP" }, rsaPubKey, exportedAesKey);

        // 3. Encrypt AES key for Sender (So you can see your own history)
        const myPubKeyBuf = base64ToBuffer(myPublicKeyBase64);
        const myRsaPubKey = await window.crypto.subtle.importKey("spki", myPubKeyBuf, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
        const encAesKeySender = await window.crypto.subtle.encrypt({ name: "RSA-OAEP" }, myRsaPubKey, exportedAesKey);

        // 4. Upload raw encrypted bytes
        const formData = new FormData();
        formData.append('file', new Blob([encryptedContent]));
        
        const uploadRes = await fetch('/upload', { method: 'POST', body: formData });
        const data = await uploadRes.json();
        
        if (data.url) {
            let fileType = file.type.startsWith('image/') ? 'image' : 
                           file.type.startsWith('video/') ? 'video' : 'file';

            const msgData = {
                sender: currentUser,
                target: currentChatTarget,
                type: fileType,
                content: data.url, // URL of the encrypted blob
                aesKey: bufferToBase64(encAesKeyTarget), // Key for them
                sender_aesKey: bufferToBase64(encAesKeySender), // Key for you
                iv: bufferToBase64(iv),
                timestamp: new Date().toISOString(),
                encrypted: true
            };
            
            socket.emit('send_msg', msgData);
            appendMessage(msgData, true); // Render locally
        }
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

// --- MEDIA DECRYPTION & DISPLAY ---
function appendMessage(data, isMine) {
    const chatBox = document.getElementById('chat-box');
    const msgDiv = document.createElement('div');
    msgDiv.className = isMine ? 'mine' : 'theirs';
    
    const time = data.timestamp ? new Date(data.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : "";
    const ticks = isMine ? `<span class="tick" style="color: ${data.read ? '#34b7f1' : '#94a3b8'};">✔✔</span>` : '';
    
    // Check if it's Media
    if (data.type === 'image' || data.type === 'video') {
        const mediaId = `media-${Math.random().toString(36).substr(2, 9)}`;
        msgDiv.innerHTML = `
            <div class="bubble">
                <div id="${mediaId}" style="min-width:150px; min-height:100px; display:flex; align-items:center; justify-content:center; background:rgba(0,0,0,0.1); border-radius:8px;">
                    <span style="font-size:0.8rem;">Decrypting...</span>
                </div>
                <div style="font-size:0.65rem; opacity:0.5; text-align:right; margin-top:4px;">${time} ${ticks}</div>
            </div>
        `;
        chatBox.appendChild(msgDiv);
        decryptAndDisplayMedia(data, mediaId, isMine);
    } else {
        // Plain Text
        msgDiv.innerHTML = `
            <div class="bubble">
                <p class="msg-content" style="word-wrap: break-word;">${data.content}</p>
                <div style="font-size:0.65rem; opacity:0.5; text-align:right; margin-top:4px;">${time} ${ticks}</div>
            </div>
        `;
        chatBox.appendChild(msgDiv);
    }
    chatBox.scrollTop = chatBox.scrollHeight;
}

async function decryptAndDisplayMedia(data, containerId, isMine) {
    const container = document.getElementById(containerId);
    if(!container) return;

    try {
        // Determine which AES key to decrypt based on who is viewing
        const targetAesKeyBase64 = (isMine && data.sender_aesKey) ? data.sender_aesKey : data.aesKey;
        
        if(!targetAesKeyBase64) {
            container.innerHTML = `<span style="color:red; font-size:0.8rem;">Missing Key</span>`;
            return;
        }

        // Decrypt the AES Key
        const encAesKeyBuf = base64ToBuffer(targetAesKeyBase64);
        const aesKeyBuf = await window.crypto.subtle.decrypt({ name: "RSA-OAEP" }, myPrivateKey, encAesKeyBuf);
        const aesKey = await window.crypto.subtle.importKey("raw", aesKeyBuf, { name: "AES-GCM" }, false, ["decrypt"]);

        // Fetch the encrypted blob from server
        const res = await fetch(data.content);
        const encFileBuf = await res.arrayBuffer();
        
        // Decrypt the File
        const iv = base64ToBuffer(data.iv);
        const decFile = await window.crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, aesKey, encFileBuf);

        // Display
        const blob = new Blob([decFile], { type: data.type === 'image' ? 'image/png' : 'video/mp4' });
        const url = URL.createObjectURL(blob);
        
        if (data.type === 'image') {
            container.outerHTML = `<img src="${url}" style="max-width:250px; border-radius:8px; display:block;">`;
        } else {
            container.outerHTML = `<video src="${url}" controls style="max-width:200px; border-radius:8px; display:block;"></video>`;
        }
    } catch (e) {
        console.error("Media Decryption Error:", e);
        container.innerHTML = `<span style="color:red; font-size:0.8rem;">Decryption failed</span>`;
    }
}

// --- SOCKET LISTENERS ---
socket.on('receive_msg', async (data) => {
    if (data.sender === currentChatTarget) {
        if (data.encrypted && data.type === 'text') {
            data.content = await decryptData(data.content);
        }
        appendMessage(data, false);
        socket.emit('read_event', { sender: data.sender, user: currentUser });
    }
});

socket.on('user_status_update', (userList) => {
    const others = userList.filter(u => u !== currentUser);
    renderUserList(others, 'online-users-list', true);
    document.querySelectorAll('#users li').forEach(li => {
        const name = li.querySelector('.contact-name').innerText.split(' ')[0]; // Split to ignore lock icon
        updateSidebarStatus(name, others.includes(name));
    });
});

socket.on('status_update', () => {
    refreshSidebar(); // Silently update the UI dots
});

socket.on('msg_read_confirmed', () => {
    document.querySelectorAll('.mine .tick').forEach(t => t.style.color = '#34b7f1');
});

function updateSidebarStatus(username, isOnline) {
    const sidebarItems = document.querySelectorAll('#users li');
    sidebarItems.forEach(li => {
        const name = li.querySelector('.contact-name').innerText.split(' ')[0]; // Split to ignore lock icon
        if(name === username) {
            let statusDiv = li.querySelector('.status-indicator');
            if(!statusDiv) {
                statusDiv = document.createElement('div');
                statusDiv.className = 'status-indicator';
                statusDiv.style = "font-size: 0.7rem; color: #10b981;";
                li.querySelector('.user-details').appendChild(statusDiv);
            }
            statusDiv.innerText = isOnline ? '● Online' : '';
            
            const dot = li.querySelector('.status-dot');
            if(dot) {
                dot.style.background = isOnline ? '#22c55e' : '#94a3b8';
            }
        }
    });
}

// --- MODAL LOGIC ---
async function openOnlineModal() {
    const modal = document.getElementById('online-modal');
    const onlineList = document.getElementById('online-users-list');
    
    if (!modal || !onlineList) return;
    
    modal.style.display = 'flex';
    onlineList.innerHTML = '<li style="padding:10px;">Searching...</li>';
    
    try {
        const response = await fetch('/get_online_users');
        const users = await response.json();
        
        onlineList.innerHTML = '';
        if (users.length === 0) {
            onlineList.innerHTML = '<li style="padding:10px; color:#94a3b8;">No one else is online.</li>';
            return;
        }

        users.forEach(user => {
            const li = document.createElement('li');
            li.className = 'online-user-item'; 
            li.style.cssText = "display:flex; align-items:center; padding:10px; cursor:pointer; border-bottom:1px solid #eee;";
            li.onclick = () => {
                selectUser(user.username); 
                closeOnlineModal();
            };
            
            li.innerHTML = `
                <div class="avatar" style="width:30px; height:30px; font-size:0.8rem; background:var(--primary); color:white; display:flex; align-items:center; justify-content:center; border-radius:50%;">${user.username[0].toUpperCase()}</div>
                <div style="margin-left:10px;">
                    <b style="font-size:0.9rem; color:var(--text-main);">${user.username}</b>
                    <div style="font-size:0.7rem; color:#22c55e;">Available to chat</div>
                </div>
            `;
            onlineList.appendChild(li);
        });
    } catch (err) { onlineList.innerHTML = '<li>Error loading.</li>'; }
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

// --- STARTUP LOGIC ---
window.onload = async () => {
    try {
        await initCrypto();
    } catch (e) {
        console.warn("Encryption unavailable (Need HTTPS):", e);
        alert("Warning: Encryption disabled. Use HTTPS for private messaging.");
    }
    refreshSidebar(); 
};