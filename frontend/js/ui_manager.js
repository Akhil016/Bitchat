const UIManager = {
    // Update the sidebar with the latest message snippet
    updateSidebar(contactName, messageText, time) {
        const chatItem = document.querySelector(`.chat-item[data-name="${contactName}"]`);
        if (chatItem) {
            chatItem.querySelector('.last-msg').innerText = messageText;
            chatItem.querySelector('.time').innerText = time;
            // Move to top of list
            chatItem.parentNode.prepend(chatItem);
        }
    },

    // Handle the "Read Scripts" (Checkmarks)
    updateMessageStatus(msgId, status) {
        const statusElement = document.getElementById(`status-${msgId}`);
        if (!statusElement) return;

        if (status === 'delivered') {
            statusElement.innerText = "✓✓"; // Double grey check
        } else if (status === 'read') {
            statusElement.innerText = "✓✓";
            statusElement.classList.add('blue-check'); // Double blue check
        }
    },

    // Browser Notification
    showNotification(sender, text) {
        if (Notification.permission === "granted") {
            new Notification(sender, { body: text, icon: 'icon.png' });
        }
    }
};