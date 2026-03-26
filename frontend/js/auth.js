async function handleSignup() {
    const keys = await Encryption.generateKeys();
    // Export public key to send to server
    const exportedPublic = await window.crypto.subtle.exportKey("spki", keys.publicKey);
    const publicKeyBase64 = btoa(String.fromCharCode(...new Uint8Array(exportedPublic)));

    const userData = {
        username: document.getElementById('reg-username').value,
        // ... other fields
        public_key: publicKeyBase64
    };

    const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(userData)
    });
    // Save private key locally ONLY (SessionStorage or IndexedDB)
    window.myPrivateKey = keys.privateKey;
}