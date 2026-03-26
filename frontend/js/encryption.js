const Encryption = {
    // Generate RSA Key Pair for the user
    async generateKeys() {
        const keys = await window.crypto.subtle.generateKey(
            {
                name: "RSA-OAEP",
                modulusLength: 2048,
                publicExponent: new Uint8Array([1, 0, 1]),
                hash: "SHA-256",
            },
            true,
            ["encrypt", "decrypt"]
        );
        return keys;
    },

    async encryptMessage(text, publicKeyBuf) {
        const encoder = new TextEncoder();
        const data = encoder.encode(text);
        const encrypted = await window.crypto.subtle.encrypt(
            { name: "RSA-OAEP" },
            publicKeyBuf,
            data
        );
        return btoa(String.fromCharCode(...new Uint8Array(encrypted)));
    },

    async decryptMessage(encryptedBase64, privateKey) {
        const encryptedData = Uint8Array.from(atob(encryptedBase64), c => c.charCodeAt(0));
        const decrypted = await window.crypto.subtle.decrypt(
            { name: "RSA-OAEP" },
            privateKey,
            encryptedData
        );
        return new TextDecoder().decode(decrypted);
    }
};