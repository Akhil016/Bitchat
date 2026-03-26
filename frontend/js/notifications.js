const NotificationManager = {
    init() {
        if (Notification.permission !== "granted") {
            Notification.requestPermission();
        }
    },

    send(title, body, icon = 'default-avatar.png') {
        if (Notification.permission === "granted" && document.hidden) {
            const notification = new Notification(title, {
                body: body,
                icon: icon,
                silent: false
            });

            notification.onclick = () => {
                window.focus();
                // Logic to open the specific chat
            };
        }
    }
};

// Initialize on script load
NotificationManager.init();