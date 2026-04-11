const currentUser = document.querySelector('b').innerText;
const socket = io();
let myPrivateKey = null;
let myPublicKeyBase64 = null;

// Chat State
let currentChatTarget = null;
let isCurrentChatGroup = false;
let currentGroupMembers = [];

// --- BASE64 CONVERTERS ---
function bufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return window.btoa(binary);
}

function base64ToBuffer(base64) {
    const binary_string = window.atob(base64);
    const bytes = new Uint8Array(binary_string.length);
    for (let i = 0; i < binary_string.length; i++) bytes[i] = binary_string.charCodeAt(i);
    return bytes.buffer;
}

// --- E2EE ENGINE (RSA & AES) ---
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
    } else {
        const privBuf = new Uint8Array(JSON.parse(storedPriv));
        myPrivateKey = await window.crypto.subtle.importKey("pkcs8", privBuf, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["decrypt"]);
        myPublicKeyBase64 = storedPub;
    }
    socket.emit('store_pub_key', { pub_key: myPublicKeyBase64 });
}

// 1-on-1 Text Encryption
async function encryptRSA(plainText, pubKeyBase64) {
    try {
        const binaryKey = base64ToBuffer(pubKeyBase64);
        const pubKey = await window.crypto.subtle.importKey("spki", binaryKey, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
        const encoded = new TextEncoder().encode(plainText);
        const encrypted = await window.crypto.subtle.encrypt({ name: "RSA-OAEP" }, pubKey, encoded);
        return bufferToBase64(encrypted);
    } catch (e) { return null; }
}

async function decryptRSA(encryptedBase64) {
    try {
        const binary = base64ToBuffer(encryptedBase64);
        const decrypted = await window.crypto.subtle.decrypt({ name: "RSA-OAEP" }, myPrivateKey, binary);
        return new TextDecoder().decode(decrypted);
    } catch (e) { return "⚠️ [Decryption Error]"; }
}

// Hybrid N-Way Encryption (Files & Groups)
async function generateAESKey() {
    return await window.crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

// --- SIDEBAR & GROUPS ---
async function refreshSidebar() {
    try {
        // Only one fetch is needed because /get_contacts already includes groups
        const res = await fetch('/get_contacts');
        const data = await res.json(); // This is { users: [...], groups: [...] }
        
        const listContainer = document.getElementById('users');
        if (!listContainer) return; 
        listContainer.innerHTML = ''; 

        // 1. Render Groups
        data.groups.forEach(group => {
            const li = document.createElement('li');
            // Fixed: use 'active-chat' to match your selectUser logic
            li.className = `contact-item ${currentChatTarget === group._id ? 'active-chat' : ''}`;
            li.onclick = () => selectUser(group._id, true);
            li.innerHTML = `
                <div class="avatar" style="width:35px; height:35px; background:#f59e0b; color:white; display:flex; align-items:center; justify-content:center; border-radius:50%; margin-right:12px;">
                    <i class="fa-solid fa-user-group"></i>
                </div>
                <div class="user-details" style="flex:1;">
                    <div class="contact-name" style="font-weight:600;">${group.name}</div>
                    <div class="contact-status" style="font-size:0.75rem;">Group • ${group.members.length} members</div>
                </div>
            `;
            listContainer.appendChild(li);
        });

        // 2. Render Individual Contacts
        data.users.forEach(user => {
            const li = document.createElement('li');
            li.className = `contact-item ${currentChatTarget === user.username ? 'active-chat' : ''}`;
            li.onclick = () => selectUser(user.username, false);
            const statusClass = user.online ? 'online' : 'offline';
            li.innerHTML = `
                <div class="avatar" style="width:35px; height:35px; background:var(--primary); color:white; display:flex; align-items:center; justify-content:center; border-radius:50%; margin-right:12px;">${user.username[0].toUpperCase()}</div>
                <div class="user-details" style="flex:1;">
                    <div class="contact-name" style="font-weight:600;">${user.username}</div>
                    <div class="contact-status" style="font-size:0.8rem;">${user.online ? 'Online' : 'Offline'}</div>
                </div>
                <div class="status-dot ${statusClass}" style="width:10px; height:10px; border-radius:50%; background:${user.online ? '#22c55e' : '#94a3b8'};"></div>
            `;
            listContainer.appendChild(li);
        });
    } catch (err) { 
        console.error("Sidebar load failed:", err); 
    }
}

async function selectUser(targetId, isGroup) {
    currentChatTarget = targetId;
    isCurrentChatGroup = isGroup;
    
    const chatBox = document.getElementById('chat-box');
    const header = document.getElementById('target-header');
    chatBox.innerHTML = '<div style="text-align:center; padding:20px; opacity:0.5;">Loading history...</div>';

    document.querySelectorAll('#users li').forEach(li => li.classList.remove('active-chat'));

    try {
        const res = await fetch(`/get_history/${targetId}`);
        const data = await res.json();
        chatBox.innerHTML = ''; 
        
        if (isGroup) {
            currentGroupMembers = data.members;
            header.innerHTML = `${data.name} <span style="color:green; font-size:0.7rem;">(Group E2EE)</span>`;
        } else {
            header.innerHTML = `${targetId} <span style="color:green; font-size:0.7rem;">(E2EE)</span>`;
        }

        if (data.messages.length === 0) chatBox.innerHTML = '<div style="text-align:center; opacity:0.3; margin-top:20px;">No messages yet. Say hi!</div>';

        for (let msg of data.messages) {
            await decryptMessagePayload(msg);
            appendMessage(msg, msg.sender === currentUser);
        }
    } catch (err) { chatBox.innerHTML = '<div style="color:red; text-align:center;">Failed to load.</div>'; }
}

// --- SENDING MESSAGES ---
async function sendText() {
    const input = document.getElementById('msg-input');
    const content = input.value.trim();
    if (!content || !currentChatTarget) return;
    input.value = "";

    const msgData = {
        sender: currentUser,
        target: currentChatTarget,
        type: 'text',
        is_group: isCurrentChatGroup,
        encrypted: true
    };

    if (isCurrentChatGroup) {
        const aesKey = await generateAESKey();
        const iv = window.crypto.getRandomValues(new Uint8Array(12));
        const encContentBuf = await window.crypto.subtle.encrypt(
            { name: "AES-GCM", iv: iv }, aesKey, new TextEncoder().encode(content)
        );
        msgData.content = bufferToBase64(encContentBuf);
        msgData.iv = bufferToBase64(iv);
        msgData.keys = await encryptAESKeyForMembers(aesKey, currentGroupMembers);
        
        socket.emit('send_msg', msgData);
        // REMOVED: appendMessage(...) 
    } else {
        socket.emit('get_pub_key', { target: currentChatTarget }, async (data) => {
            if (!data.pub_key) return alert("User missing encryption key");
            msgData.content = await encryptRSA(content, data.pub_key);
            msgData.sender_content = await encryptRSA(content, myPublicKeyBase64);
            socket.emit('send_msg', msgData);
            // REMOVED: appendMessage(...)
        });
    }
}

async function uploadMedia(file) {
    if (!file || !currentChatTarget) return;
    
    const fileType = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : 'file';
    const aesKey = await generateAESKey();
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const fileBuf = await file.arrayBuffer();
    const encFileBuf = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, aesKey, fileBuf);

    const formData = new FormData();
    formData.append('file', new Blob([encFileBuf]));
    const uploadRes = await fetch('/upload', { method: 'POST', body: formData });
    const data = await uploadRes.json();

    const msgData = {
        sender: currentUser,
        target: currentChatTarget,
        type: fileType,
        content: data.url,
        is_group: isCurrentChatGroup,
        iv: bufferToBase64(iv),
        encrypted: true
    };

    if (isCurrentChatGroup) {
        msgData.keys = await encryptAESKeyForMembers(aesKey, currentGroupMembers);
    } else {
        msgData.keys = await encryptAESKeyForMembers(aesKey, [currentUser, currentChatTarget]);
    }

    socket.emit('send_msg', msgData);
    appendMessage(msgData, true); // Append before decrypting locally is complex, rely on receive_msg bounce for sender if preferred, or render skeleton
    document.getElementById('media-input').value = '';
}

// --- N-WAY ENCRYPTION HELPER ---
async function encryptAESKeyForMembers(aesKey, membersArr) {
    const rawAes = await window.crypto.subtle.exportKey("raw", aesKey);
    const keysDict = {};
    
    // Fetch all public keys for the array of members
    const res = await fetch('/get_group_keys', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ members: membersArr })
    });
    const memberPubKeys = await res.json();

    for (let member of membersArr) {
        const pubBase64 = memberPubKeys[member];
        if (pubBase64) {
            const rsaPubKey = await window.crypto.subtle.importKey(
                "spki", base64ToBuffer(pubBase64), { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]
            );
            const encRaw = await window.crypto.subtle.encrypt({ name: "RSA-OAEP" }, rsaPubKey, rawAes);
            keysDict[member] = bufferToBase64(encRaw);
        }
    }
    return keysDict;
}

// --- DECRYPTION ENGINE ---
async function decryptMessagePayload(msg) {
    if (!msg.encrypted) return;

    if (msg.is_group || msg.keys) {
        // HYBRID/N-WAY DECRYPTION (Groups Text/Media, 1on1 Media)
        const myEncAesKey = msg.keys ? msg.keys[currentUser] : null;
        if (!myEncAesKey) {
            msg.content = "⚠️ [Not Encrypted for You]";
            return;
        }
        try {
            const aesKeyBuf = await window.crypto.subtle.decrypt(
                { name: "RSA-OAEP" }, myPrivateKey, base64ToBuffer(myEncAesKey)
            );
            const aesKey = await window.crypto.subtle.importKey("raw", aesKeyBuf, { name: "AES-GCM" }, false, ["decrypt"]);
            
            if (msg.type === 'text') {
                const decTextBuf = await window.crypto.subtle.decrypt(
                    { name: "AES-GCM", iv: base64ToBuffer(msg.iv) }, aesKey, base64ToBuffer(msg.content)
                );
                msg.content = new TextDecoder().decode(decTextBuf);
            } else {
                // Attach key for media elements to decrypt on the fly
                msg.unlockedAesKey = aesKey; 
            }
        } catch (e) { msg.content = "⚠️ [Decryption Failed]"; }
    } else {
        // LEGACY 1-ON-1 RSA TEXT DECRYPTION
        if (msg.target === currentUser) msg.content = await decryptRSA(msg.content);
        else if (msg.sender === currentUser && msg.sender_content) msg.content = await decryptRSA(msg.sender_content);
        else msg.content = "⚠️ [Encrypted]";
    }
}

// --- RENDERING ---
function appendMessage(data, isMine) {
    const chatBox = document.getElementById('chat-box');
    if (!chatBox) return;
    
    // Check if this message belongs in the current active chat
    const belongsToCurrentChat = isCurrentChatGroup 
        ? data.target === currentChatTarget
        : (data.sender === currentChatTarget || data.target === currentChatTarget);
        
    if (!belongsToCurrentChat && data.sender !== currentUser) return; // Ignore background messages

    const msgDiv = document.createElement('div');
    msgDiv.className = isMine ? 'mine' : 'theirs';
    const time = data.timestamp ? new Date(data.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : "";
    const senderTag = (data.is_group && !isMine) ? `<div style="font-size:0.7rem; color:#f59e0b; font-weight:bold; margin-bottom:4px;">${data.sender}</div>` : '';

    if (data.type === 'text') {
        msgDiv.innerHTML = `<div class="bubble">${senderTag}<p class="msg-content">${data.content}</p><div style="font-size:0.65rem; opacity:0.5; text-align:right;">${time}</div></div>`;
        chatBox.appendChild(msgDiv);
    } else {
        const mediaId = `media-${Math.random().toString(36).substr(2, 9)}`;
        msgDiv.innerHTML = `<div class="bubble">${senderTag}<div id="${mediaId}">Decrypting Media...</div><div style="font-size:0.65rem; opacity:0.5; text-align:right;">${time}</div></div>`;
        chatBox.appendChild(msgDiv);
        if (data.unlockedAesKey) renderDecryptedMedia(data.content, data.iv, data.unlockedAesKey, data.type, mediaId);
    }
    chatBox.scrollTop = chatBox.scrollHeight;
}

async function renderDecryptedMedia(url, ivBase64, aesKey, type, containerId) {
    try {
        const res = await fetch(url);
        const encFileBuf = await res.arrayBuffer();
        const decFileBuf = await window.crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBuffer(ivBase64) }, aesKey, encFileBuf);
        
        const blob = new Blob([decFileBuf], { type: type === 'image' ? 'image/png' : 'video/mp4' });
        const objUrl = URL.createObjectURL(blob);
        const container = document.getElementById(containerId);
        
        if (type === 'image') container.innerHTML = `<img src="${objUrl}" style="max-width:250px; border-radius:8px;">`;
        else container.innerHTML = `<video src="${objUrl}" controls style="max-width:200px; border-radius:8px;"></video>`;
    } catch (e) {
        document.getElementById(containerId).innerHTML = `<span style="color:red">Failed to load media</span>`;
    }
}
// --- Responsive State Management ---
function toggleView(view) {
    const container = document.getElementById('main-container');
    if (view === 'chat') container.classList.add('chat-active');
    else container.classList.remove('chat-active');
}

// --- MODALS & SOCKET LISTENERS ---
socket.on('receive_msg', async (data) => {
    // Only decrypt if it's meant for our eyes
    if (data.is_group || data.target === currentUser || data.sender === currentUser) {
        await decryptMessagePayload(data);
        appendMessage(data, data.sender === currentUser);
    }
});

socket.on('group_update', (data) => {
    // If I am the user affected, join/leave the room
    if (data.user === currentUser) {
        if (data.action === 'add') {
            socket.emit('join_group_room', { group_id: data.group_id });
        } else {
            socket.emit('leave_group_room', { group_id: data.group_id });
        }
    }
    refreshSidebar();
});

socket.on('status_update', () => refreshSidebar());

// Group Creation
function openGroupModal() { document.getElementById('group-modal').style.display = 'flex'; }
function closeGroupModal() { document.getElementById('group-modal').style.display = 'none'; }
async function submitCreateGroup() {
    const name = document.getElementById('group-name').value;
    const membersRaw = document.getElementById('group-members').value;
    const members = membersRaw.split(',').map(s => s.trim()).filter(s => s);
    
    if(!name || members.length === 0) return alert("Fill all fields");
    
    const res = await fetch('/create_group', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({name, members})
    });
    if((await res.json()).success) {
        closeGroupModal();
        refreshSidebar();
    }
}

// Online Modal (Legacy code intact)
async function openOnlineModal() {
    const modal = document.getElementById('online-modal');
    modal.style.display = 'flex';
    const list = document.getElementById('online-users-list');
    list.innerHTML = '<li>Loading...</li>';
    try {
        const res = await fetch('/get_online_users');
        const users = await res.json();
        list.innerHTML = users.map(u => `<li onclick="selectUser('${u.username}', false); closeOnlineModal()" style="padding:10px; cursor:pointer;">${u.username} (Online)</li>`).join('');
    } catch(e) { list.innerHTML = '<li>Error</li>'; }
}
function closeOnlineModal() { document.getElementById('online-modal').style.display = 'none'; }

// Init
window.onload = async () => {
    await initCrypto();
    refreshSidebar();
};
