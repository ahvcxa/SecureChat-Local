/**
 * chat.js
 * Socket.io & User Interface Integration
 * 
 * v3: PBKDF2 + localStorage hybrid approach
 * - Encryption key is derived from the room secret (works in incognito tabs)
 * - Messages are saved to localStorage (device-level history)
 * - When a user leaves, the DB is cleared (third-party protection)
 * - Original participants retain their history via localStorage
 */

const socket = io({ autoConnect: false });

// UI Elements
const loginOverlay = document.getElementById('loginOverlay');
const loginForm = document.getElementById('loginForm');
const roomSecretInput = document.getElementById('roomSecretInput');
const nicknameInput = document.getElementById('nicknameInput');
const joinBtn = document.getElementById('joinBtn');
const chatContainer = document.getElementById('chatContainer');
const messageInput = document.getElementById('messageInput');
const sendMessageBtn = document.getElementById('sendMessageBtn');
const statusBadge = document.getElementById('statusBadge');
const statusText = document.getElementById('statusText');
const errorToast = document.getElementById('errorToast');
const copyInviteBtn = document.getElementById('copyInviteBtn');

// State
let isJoined = false;
let mySocketId = null;
let myNickname = null;

// localStorage key
const STORAGE_KEY = 'securechat_messages';

// Auto-Login via URL
const urlParams = new URLSearchParams(window.location.search);
const secretQuery = urlParams.get('secret');
if (secretQuery) {
    roomSecretInput.value = secretQuery;
    setTimeout(() => {
        joinBtn.click();
    }, 300);
}

// Copy Invite Link
if (copyInviteBtn) {
    copyInviteBtn.addEventListener('click', () => {
        const inviteUrl = window.location.origin + window.location.pathname + '?secret=' + encodeURIComponent(roomSecretInput.value);
        navigator.clipboard.writeText(inviteUrl).then(() => {
            showToast("Invite link copied! Share it with your friend.", 4000, 'success');
        });
    });
}

// --- localStorage Message History ---

function saveMessageToStorage(text, type, timestamp) {
    try {
        const messages = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
        messages.push({ text, type, timestamp: timestamp || new Date().toISOString() });
        if (messages.length > 500) messages.splice(0, messages.length - 500);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
    } catch (e) {
        // localStorage may not work in incognito mode — continue silently
    }
}

function loadMessagesFromStorage() {
    try {
        const messages = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
        return messages;
    } catch (e) {
        return [];
    }
}

// Clear localStorage when user closes/refreshes the page
window.addEventListener('beforeunload', () => {
    localStorage.removeItem(STORAGE_KEY);
});

// --- Utility Functions ---

function showToast(message, duration = 3000, type = 'error') {
    errorToast.textContent = message;
    errorToast.style.backgroundColor = type === 'success' ? 'var(--accent-success)' : 'var(--accent-danger)';
    errorToast.classList.add('show');
    setTimeout(() => {
        errorToast.classList.remove('show');
    }, duration);
}

function updateStatus(status) {
    statusBadge.className = 'status-badge ' + status;
    if (status === 'connected') statusText.textContent = "Connected";
    else if (status === 'disconnected') statusText.textContent = "Disconnected";
    else if (status === 'e2ee-ready') statusText.textContent = "E2EE Active";
    else if (status === 'waiting') statusText.textContent = "Waiting for Peer";
}

function formatTime(dateString) {
    if (!dateString) return new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    try {
        const d = new Date(dateString.endsWith('Z') ? dateString : dateString + 'Z');
        return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    } catch {
        return new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    }
}

function addSystemMessage(text) {
    const el = document.createElement('div');
    el.className = 'system-message';
    el.textContent = text;
    chatContainer.appendChild(el);
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

function appendMessage(text, type, timestamp = null, persist = true, senderNick = null) {
    const wrapper = document.createElement('div');
    wrapper.className = `message-wrapper ${type}`;
    // Store sender info in DOM (for deletion)
    if (senderNick) wrapper.setAttribute('data-sender', senderNick);

    // Display sender name above the message
    if (senderNick) {
        const nameEl = document.createElement('div');
        nameEl.style.cssText = 'font-size:0.72rem; margin-bottom:0.2rem; font-weight:600; opacity:0.7;';
        nameEl.textContent = senderNick;
        wrapper.appendChild(nameEl);
    }

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    bubble.textContent = text;

    const meta = document.createElement('div');
    meta.className = 'message-meta';
    
    meta.innerHTML = `
        <span class="encryption-lock" title="End-to-end encrypted">
            <svg viewBox="0 0 24 24"><path d="M12 2C9.243 2 7 4.243 7 7V10H6C4.895 10 4 10.895 4 12V20C4 21.105 4.895 22 6 22H18C19.105 22 20 21.105 20 20V12C20 10.895 19.105 10 18 10H17V7C17 4.243 14.757 2 12 2ZM9 7C9 5.346 10.346 4 12 4C13.654 4 15 5.346 15 7V10H9V7ZM12 14C13.105 14 14 14.895 14 16C14 17.105 13.105 18 12 18C10.895 18 10 17.105 10 16C10 14.895 10.895 14 12 14Z"/></svg>
        </span>
        ${formatTime(timestamp)}
    `;

    wrapper.appendChild(bubble);
    wrapper.appendChild(meta);
    chatContainer.appendChild(wrapper);
    chatContainer.scrollTop = chatContainer.scrollHeight;
    
    // Save message to browser's local storage
    if (persist) {
        saveMessageToStorage(text, type, timestamp);
    }
}

// --- Message History Loading ---

async function loadHistory(serverMessages) {
    // Priority order:
    // 1. Encrypted messages from the server (if available and decryptable)
    // 2. Messages from localStorage (device backup, if server has none)
    
    let loaded = false;
    
    // Attempt to decrypt messages from the server
    if (serverMessages && serverMessages.length > 0) {
        addSystemMessage(`📜 Loading ${serverMessages.length} messages from server...`);
        let decoded = 0;
        for (const msg of serverMessages) {
            try {
                const encryptedPayload = JSON.parse(msg.payload);
                const decryptedText = await CryptoService.decryptMessage(encryptedPayload);
                const type = (msg.nickname === myNickname) ? 'sent' : 'received';
                appendMessage(decryptedText, type, msg.timestamp, false, msg.nickname || 'Anonymous');
                decoded++;
            } catch (err) {
                console.warn("Failed to decrypt message:", err.message);
            }
        }
        if (decoded > 0) {
            addSystemMessage(`✅ ${decoded} messages loaded from server.`);
            loaded = true;
        }
    }
    
    // If no server messages, load from localStorage (local backup)
    if (!loaded) {
        const localMessages = loadMessagesFromStorage();
        if (localMessages.length > 0) {
            addSystemMessage(`📱 Loading ${localMessages.length} messages from device history...`);
            for (const msg of localMessages) {
                appendMessage(msg.text, msg.type, msg.timestamp, false);
            }
            addSystemMessage(`✅ ${localMessages.length} messages loaded from device history.`);
        }
    }
}

// --- Socket Events ---

socket.on('connect', () => {
    console.log('Socket connected', socket.id);
    if (!isJoined) updateStatus('connected');
});

socket.on('disconnect', () => {
    updateStatus('disconnected');
    isJoined = false;
    loginOverlay.classList.remove('hidden');
    messageInput.disabled = true;
    sendMessageBtn.disabled = true;
    addSystemMessage("⚠️ Server connection lost.");
});

// When another user leaves
socket.on('user_left', (data) => {
    addSystemMessage(`👋 ${data.nickname || 'User'} left the chat.`);
    updateStatus('waiting');
});

// When a new user joins the room
socket.on('user_joined', (data) => {
    addSystemMessage(`🟢 ${data.nickname || 'User'} joined the room!`);
    updateStatus('e2ee-ready');
});

socket.on('receive_message', async (msgObj) => {
    if (!CryptoService.isE2EEReady()) {
        console.warn("Message received but E2EE is not active!", msgObj);
        return;
    }

    try {
        const encryptedPayload = JSON.parse(msgObj.payload);
        const decryptedText = await CryptoService.decryptMessage(encryptedPayload);
        appendMessage(decryptedText, 'received', null, true, msgObj.nickname || 'Anonymous');
    } catch(e) {
        console.error("Failed to decrypt incoming message:", e);
    }
});

// When the other user deletes their own messages
socket.on('messages_deleted', (data) => {
    // Remove the other user's messages from DOM
    const theirMsgs = chatContainer.querySelectorAll('.message-wrapper.received');
    theirMsgs.forEach(el => el.remove());
    addSystemMessage(`🗑️ ${data.nickname} deleted their messages.`);
});

// When the other user requests to delete all messages (show modal)
socket.on('delete_all_request', (data) => {
    const modal = document.getElementById('deleteAllModal');
    const msgEl = document.getElementById('deleteAllMsg');
    msgEl.textContent = `${data.nickname} wants to delete the entire chat history. Do you approve?`;
    modal.classList.remove('hidden');

    // Accept button
    document.getElementById('deleteAllAccept').onclick = () => {
        socket.emit('respond_delete_all', { accepted: true, requesterId: data.requesterId });
        modal.classList.add('hidden');
    };
    // Reject button
    document.getElementById('deleteAllReject').onclick = () => {
        socket.emit('respond_delete_all', { accepted: false, requesterId: data.requesterId });
        modal.classList.add('hidden');
        addSystemMessage('❌ You rejected the deletion request.');
    };
});

// All messages deleted (on both sides)
socket.on('all_messages_deleted', () => {
    // Remove all messages from DOM
    const allMsgs = chatContainer.querySelectorAll('.message-wrapper');
    allMsgs.forEach(el => el.remove());
    localStorage.removeItem(STORAGE_KEY);
    addSystemMessage('🗑️ All chat history has been deleted.');
});

// When the other user deletes their last message
socket.on('last_message_deleted', (data) => {
    // Remove the last received message from DOM
    const theirMsgs = chatContainer.querySelectorAll('.message-wrapper.received');
    if (theirMsgs.length > 0) {
        theirMsgs[theirMsgs.length - 1].remove();
    }
    addSystemMessage(`🗑️ ${data.nickname} deleted their last message.`);
});

// Deletion request was rejected
socket.on('delete_all_rejected', (data) => {
    addSystemMessage(`❌ ${data.nickname} rejected your deletion request.`);
});


// --- DOM Actions & User Interaction ---

messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

sendMessageBtn.addEventListener('click', sendMessage);

async function sendMessage() {
    const text = messageInput.value.trim();
    if (!text) return;

    messageInput.value = '';
    messageInput.focus();

    // --- Command handling ---

    // /delete — delete all your own messages
    if (text === '/delete') {
        socket.emit('delete_my_messages', (response) => {
            if (response && response.success) {
                // Remove your messages from DOM
                const myMsgs = chatContainer.querySelectorAll('.message-wrapper.sent');
                myMsgs.forEach(el => el.remove());
                // Clear localStorage
                localStorage.removeItem(STORAGE_KEY);
                addSystemMessage(`🗑️ Your messages have been deleted (${response.deleted} messages).`);
            } else {
                showToast(response?.error || 'Failed to delete messages.');
            }
        });
        return;
    }

    // /deleteall — send approval request to the other user
    if (text === '/deleteall') {
        socket.emit('request_delete_all');
        addSystemMessage('⏳ Delete all request sent to the other user. Waiting for approval...');
        return;
    }

    // /deletelast — delete the last message you sent
    if (text === '/deletelast') {
        socket.emit('delete_last_message', (response) => {
            if (response && response.success) {
                // Remove last sent message from DOM
                const myMsgs = chatContainer.querySelectorAll('.message-wrapper.sent');
                if (myMsgs.length > 0) {
                    myMsgs[myMsgs.length - 1].remove();
                }
                addSystemMessage('🗑️ Your last message has been deleted.');
            } else {
                showToast(response?.error || 'No messages to delete.');
            }
        });
        return;
    }

    // /quit — leave the chat room
    if (text === '/quit') {
        socket.emit('quit_room');
        isJoined = false;
        mySocketId = null;
        loginOverlay.classList.remove('hidden');
        messageInput.disabled = true;
        sendMessageBtn.disabled = true;
        chatContainer.innerHTML = '';
        localStorage.removeItem(STORAGE_KEY);
        updateStatus('disconnected');
        addSystemMessage('👋 You left the room.');
        return;
    }

    // --- Normal message sending ---
    if (!CryptoService.isE2EEReady()) {
        showToast("Encryption key is not ready.");
        return;
    }

    try {
        const encryptedPayload = await CryptoService.encryptMessage(text);
        const payloadString = JSON.stringify(encryptedPayload);

        socket.emit('send_message', payloadString, (response) => {
            if (response.success) {
                appendMessage(text, 'sent', null, true, myNickname);
            } else {
                showToast("Server error: " + response.error);
            }
        });
    } catch (err) {
        showToast("Failed to encrypt message!");
        console.error(err);
    }
}

loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const secret = roomSecretInput.value.trim();
    if (!secret) return;

    joinBtn.disabled = true;
    joinBtn.textContent = "Connecting...";

    // Require nickname
    const nickname = nicknameInput.value.trim();
    if (!nickname) {
        showToast("Please enter a nickname.");
        joinBtn.disabled = false;
        joinBtn.textContent = "Join Room";
        return;
    }

    // Connect socket if not already connected
    if (!socket.connected) {
        socket.connect();
    }

    // Join room once connected
    const doJoin = () => {
        socket.emit('join_room', { secret, nickname }, async (response) => {
        if (response.success) {
            isJoined = true;
            mySocketId = response.socketId;
            myNickname = nickname;
            loginOverlay.classList.add('hidden');
            joinBtn.disabled = false;
            joinBtn.textContent = "Join Room";
            if (copyInviteBtn) copyInviteBtn.style.display = 'block';
            document.getElementById('chatContainer').innerHTML = '';
            addSystemMessage("🚀 Joined the room.");
            
            // Derive encryption key from room secret (PBKDF2)
            await CryptoService.deriveKeyFromPassword(secret);
            updateStatus('e2ee-ready');
            messageInput.disabled = false;
            sendMessageBtn.disabled = false;
            addSystemMessage("🔐 E2EE active — messages are encrypted.");

            // Load message history (server or localStorage)
            await loadHistory(response.messages);

        } else {
            showToast(response.error || "Failed to join room.");
            joinBtn.disabled = false;
            joinBtn.textContent = "Join Room";
        }
    });
    };

    if (socket.connected) {
        doJoin();
    } else {
        socket.once('connect', doJoin);
    }
});
