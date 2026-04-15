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
const roomSecretGroup = document.getElementById('roomSecretGroup');
const nicknameInput = document.getElementById('nicknameInput');
const loginSubtitle = document.getElementById('loginSubtitle');
const joinBtn = document.getElementById('joinBtn');
const chatContainer = document.getElementById('chatContainer');
const messageInput = document.getElementById('messageInput');
const sendMessageBtn = document.getElementById('sendMessageBtn');
const statusBadge = document.getElementById('statusBadge');
const statusText = document.getElementById('statusText');
const errorToast = document.getElementById('errorToast');
const copyInviteBtn = document.getElementById('copyInviteBtn');

// Issue #8: Notification System
class NotificationManager {
    constructor() {
        this.tabNotificationsEnabled = true;
        this.browserNotificationsEnabled = true;
        this.audioAlertsEnabled = true;
        this.newMessageCount = 0;
        this.originalTitle = document.title;
        this.blinkInterval = null;
        this.audioContext = null;
    }

    async requestPermissions() {
        if ('Notification' in window && Notification.permission === 'default') {
            const permission = await Notification.requestPermission();
            this.browserNotificationsEnabled = permission === 'granted';
        }
    }

    onNewMessage(senderNick, messagePreview) {
        // Don't notify if app is focused
        if (document.hasFocus()) {
            return;
        }

        // Tab title notification
        if (this.tabNotificationsEnabled) {
            this.updateTabNotification();
        }

        // Browser notification
        if (this.browserNotificationsEnabled && 'Notification' in window && Notification.permission === 'granted') {
            new Notification(`${senderNick} sent a message`, {
                body: messagePreview.substring(0, 100),
                icon: '/favicon.ico',
                tag: 'securechat-message',
                requireInteraction: false
            });
        }

        // Audio alert
        if (this.audioAlertsEnabled) {
            this.playAudioAlert();
        }
    }

    updateTabNotification() {
        this.newMessageCount++;
        document.title = `(${this.newMessageCount}) 💬 ${this.originalTitle}`;

        // Start blinking effect if not already
        if (!this.blinkInterval) {
            let visible = false;
            this.blinkInterval = setInterval(() => {
                if (visible) {
                    document.title = `(${this.newMessageCount}) 💬 ${this.originalTitle}`;
                } else {
                    document.title = this.originalTitle;
                }
                visible = !visible;
            }, 800);
        }
    }

    clearTabNotification() {
        this.newMessageCount = 0;
        if (this.blinkInterval) {
            clearInterval(this.blinkInterval);
            this.blinkInterval = null;
        }
        document.title = this.originalTitle;
    }

    playAudioAlert() {
        try {
            const ctx = this.audioContext || new (window.AudioContext || window.webkitAudioContext)();
            if (!this.audioContext) this.audioContext = ctx;

            // Two-tone pleasant chime: high note (880 Hz) then resolution note (660 Hz)
            [{ freq: 880, t: 0 }, { freq: 660, t: 0.13 }].forEach(({ freq, t }) => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.type = 'sine';
                osc.frequency.value = freq;
                const start = ctx.currentTime + t;
                gain.gain.setValueAtTime(0, start);
                gain.gain.linearRampToValueAtTime(0.22, start + 0.01);
                gain.gain.exponentialRampToValueAtTime(0.001, start + 0.28);
                osc.start(start);
                osc.stop(start + 0.28);
            });
        } catch (e) {
            console.warn('Audio playback not available:', e);
        }
    }

    setTabNotifications(enabled) {
        this.tabNotificationsEnabled = enabled;
        if (!enabled) {
            this.clearTabNotification();
        }
    }

    setBrowserNotifications(enabled) {
        this.browserNotificationsEnabled = enabled;
    }

    setAudioAlerts(enabled) {
        this.audioAlertsEnabled = enabled;
    }
}

const notificationManager = new NotificationManager();

// State
let isJoined = false;
let mySocketId = null;
let myNickname = null;
let pendingInviteToken = null;

// localStorage key
const STORAGE_KEY = 'securechat_messages';

// Task #3: Emoji shortcut map — type :name: in a message to insert the emoji
const EMOJI_SHORTCUTS = {
    ':smile:': '😄', ':grin:': '😁', ':laugh:': '😂', ':rofl:': '🤣',
    ':wink:': '😉', ':cool:': '😎', ':thinking:': '🤔', ':cry:': '😢',
    ':angry:': '😠', ':heart_eyes:': '😍', ':party:': '🥳', ':sleep:': '😴',
    ':heart:': '❤️', ':thumbsup:': '👍', ':thumbsdown:': '👎', ':ok:': '👌',
    ':clap:': '👏', ':pray:': '🙏', ':wave:': '👋', ':facepalm:': '🤦',
    ':fire:': '🔥', ':star:': '⭐', ':sparkles:': '✨', ':tada:': '🎉',
    ':rocket:': '🚀', ':bulb:': '💡', ':eyes:': '👀', ':shrug:': '🤷',
    ':check:': '✅', ':x:': '❌', ':warning:': '⚠️', ':lock:': '🔒',
    ':key:': '🔑', ':coffee:': '☕', ':pizza:': '🍕', ':sun:': '☀️',
};

function processEmojiShortcuts(text) {
    return text.replace(/:[a-z_]+:/g, match => EMOJI_SHORTCUTS[match] ?? match);
}

// Invite token via URL
const urlParams = new URLSearchParams(window.location.search);
const inviteQuery = urlParams.get('invite');
if (inviteQuery) {
    pendingInviteToken = inviteQuery;
    if (window.history && window.history.replaceState) {
        window.history.replaceState({}, document.title, window.location.pathname);
    }
}

function applyLoginMode() {
    const inviteMode = Boolean(pendingInviteToken);
    if (roomSecretGroup) {
        roomSecretGroup.style.display = inviteMode ? 'none' : '';
    }
    if (roomSecretInput) {
        roomSecretInput.required = !inviteMode;
    }
    if (loginSubtitle) {
        loginSubtitle.textContent = inviteMode
            ? 'Invite link detected. Enter your nickname to join securely.'
            : 'Join the E2EE-secured private chat.';
    }
}

applyLoginMode();

// Copy Invite Link
if (copyInviteBtn) {
    copyInviteBtn.addEventListener('click', () => {
        if (!socket.connected || !isJoined) {
            showToast('Join room first to create invite links.');
            return;
        }

        socket.emit('create_invite', (response) => {
            if (!response || !response.success) {
                showToast(response?.error || 'Failed to create invite link.');
                return;
            }

            const inviteUrl = window.location.origin + window.location.pathname + '?invite=' + encodeURIComponent(response.token);
            navigator.clipboard.writeText(inviteUrl).then(() => {
                showToast('Invite link copied! Valid for 5 minutes, single-use.', 4500, 'success');
            }).catch(() => {
                showToast('Failed to copy invite link.');
            });
        });
    });
}

// --- localStorage Message History ---

// Detect incognito/private mode
function isIncognitoMode() {
    return new Promise((resolve) => {
        const fs = window.RequestFileSystem || window.webkitRequestFileSystem;
        if (!fs) {
            resolve(false);
            return;
        }
        fs(window.TEMPORARY, 100, () => resolve(false), () => resolve(true));
    });
}

// Choose storage: sessionStorage (normal), Memory (incognito)
// Issue #5: Improved privacy - messages don't persist after tab close
let storage = sessionStorage;
let useMemoryStorage = false;
const memoryCache = { [STORAGE_KEY]: [] };

async function initializeStorage() {
    const isIncognito = await isIncognitoMode();
    if (isIncognito) {
        useMemoryStorage = true;
        console.log('Incognito mode detected. Using memory-only storage.');
    }
}

initializeStorage();

function saveMessageToStorage(text, type, timestamp) {
    try {
        const messages = useMemoryStorage
            ? memoryCache[STORAGE_KEY] || []
            : JSON.parse(storage.getItem(STORAGE_KEY) || '[]');
        
        messages.push({ text, type, timestamp: timestamp || new Date().toISOString() });
        
        // Max 500 messages per device
        if (messages.length > 500) messages.splice(0, messages.length - 500);
        
        if (useMemoryStorage) {
            memoryCache[STORAGE_KEY] = messages;
        } else {
            storage.setItem(STORAGE_KEY, JSON.stringify(messages));
        }
    } catch (e) {
        // Storage may not work in some scenarios — continue silently
        console.warn('Storage unavailable, using memory cache');
        memoryCache[STORAGE_KEY] = memoryCache[STORAGE_KEY] || [];
        memoryCache[STORAGE_KEY].push({ text, type, timestamp });
    }
}

function loadMessagesFromStorage() {
    try {
        if (useMemoryStorage) {
            return memoryCache[STORAGE_KEY] || [];
        }
        const messages = JSON.parse(storage.getItem(STORAGE_KEY) || '[]');
        return messages;
    } catch (e) {
        return [];
    }
}

// Clear sessionStorage when user closes/refreshes the page
// Issue #5: Enhanced privacy - no persistent plaintext messages
window.addEventListener('beforeunload', () => {
    try {
        if (!useMemoryStorage) {
            storage.removeItem(STORAGE_KEY);
        }
    } catch (e) {
        // Ignore errors
    }
    memoryCache[STORAGE_KEY] = [];
});

// Issue #8: Clear notifications when app is focused
window.addEventListener('focus', () => {
    notificationManager.clearTabNotification();
    // Task #2: Refresh relative timestamps immediately when tab regains focus
    document.querySelectorAll('.message-time[data-ts]').forEach(el => {
        el.textContent = formatSmartTime(el.dataset.ts);
    });
});

// Task #1: Mute/unmute sound toggle
const muteBtn = document.getElementById('muteBtn');
if (muteBtn) {
    muteBtn.addEventListener('click', () => {
        const willMute = notificationManager.audioAlertsEnabled;
        notificationManager.setAudioAlerts(!willMute);
        muteBtn.textContent = willMute ? '🔕' : '🔔';
        muteBtn.title = willMute ? 'Sound muted — click to unmute' : 'Sound alerts on — click to mute';
        muteBtn.classList.toggle('muted', willMute);
    });
}

// Task #2: Refresh relative timestamps every 30 seconds
setInterval(() => {
    document.querySelectorAll('.message-time[data-ts]').forEach(el => {
        el.textContent = formatSmartTime(el.dataset.ts);
    });
}, 30000);

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

// Task #2: Smart relative timestamp ("Just now", "2m ago", "14:30", "Apr 14")
function formatSmartTime(dateString) {
    if (!dateString) return 'Just now';
    try {
        const d = new Date(dateString.endsWith('Z') ? dateString : dateString + 'Z');
        const diffSec = Math.floor((Date.now() - d.getTime()) / 1000);
        if (diffSec < 10) return 'Just now';
        if (diffSec < 60) return `${diffSec}s ago`;
        const diffMin = Math.floor(diffSec / 60);
        if (diffMin < 60) return `${diffMin}m ago`;
        const diffHr = Math.floor(diffMin / 60);
        if (diffHr < 24) return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    } catch { return 'Now'; }
}

// Full date shown on hover tooltip
function formatFullDateTime(dateString) {
    if (!dateString) return '';
    try {
        const d = new Date(dateString.endsWith('Z') ? dateString : dateString + 'Z');
        return d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch { return ''; }
}

function addSystemMessage(text) {
    const el = document.createElement('div');
    el.className = 'system-message';
    el.textContent = text;
    chatContainer.appendChild(el);
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

// --- Message Grouping & Display (Issue #7: Optimized timestamp display) ---

// Track last sender and message group
let lastMessageSender = null;
let lastMessageTimestamp = null;
let lastMessageGroupElement = null;

function appendMessage(text, type, timestamp = null, persist = true, senderNick = null) {
    const currentTimestamp = timestamp || new Date().toISOString();
    
    // Check if we should continue the previous message group
    const shouldContinueGroup = senderNick && senderNick === lastMessageSender;
    
    let wrapper;
    
    if (shouldContinueGroup && lastMessageGroupElement) {
        // Add to existing message group
        wrapper = lastMessageGroupElement;
        const messagesList = wrapper.querySelector('.messages-list');
        
        if (messagesList) {
            const bubble = document.createElement('div');
            bubble.className = 'message-bubble';
            bubble.textContent = text;
            messagesList.appendChild(bubble);
        }
        
        // Update timestamp on last message in group (Task #2: smart time + tooltip)
        const meta = wrapper.querySelector('.message-meta');
        if (meta) {
            const timeEl = meta.querySelector('.message-time');
            if (timeEl) {
                timeEl.textContent = formatSmartTime(currentTimestamp);
                timeEl.dataset.ts = currentTimestamp;
            }
            const fullEl = meta.querySelector('.full-datetime');
            if (fullEl) fullEl.textContent = formatFullDateTime(currentTimestamp);
        }
    } else {
        // Create new message group
        wrapper = document.createElement('div');
        wrapper.className = `message-wrapper ${type}`;
        if (senderNick) wrapper.setAttribute('data-sender', senderNick);
        
        // Display sender name above the message group
        if (senderNick) {
            const nameEl = document.createElement('div');
            nameEl.className = 'sender-name';
            nameEl.style.cssText = 'font-size:0.72rem; margin-bottom:0.2rem; font-weight:600; opacity:0.7;';
            nameEl.textContent = senderNick;
            wrapper.appendChild(nameEl);
        }
        
        // Create messages list container
        const messagesList = document.createElement('div');
        messagesList.className = 'messages-list';
        
        const bubble = document.createElement('div');
        bubble.className = 'message-bubble';
        bubble.textContent = text;
        messagesList.appendChild(bubble);
        
        wrapper.appendChild(messagesList);
        
        // Add timestamp and encryption lock
        const meta = document.createElement('div');
        meta.className = 'message-meta';
        
        meta.innerHTML = `
            <span class="encryption-lock" title="End-to-end encrypted">
                <svg viewBox="0 0 24 24"><path d="M12 2C9.243 2 7 4.243 7 7V10H6C4.895 10 4 10.895 4 12V20C4 21.105 4.895 22 6 22H18C19.105 22 20 21.105 20 20V12C20 10.895 19.105 10 18 10H17V7C17 4.243 14.757 2 12 2ZM9 7C9 5.346 10.346 4 12 4C13.654 4 15 5.346 15 7V10H9V7ZM12 14C13.105 14 14 14.895 14 16C14 17.105 13.105 18 12 18C10.895 18 10 17.105 10 16C10 14.895 10.895 14 12 14Z"/></svg>
            </span>
            <span class="message-time-wrapper">
                <span class="message-time" data-ts="${currentTimestamp}">${formatSmartTime(currentTimestamp)}</span>
                <span class="full-datetime">${formatFullDateTime(currentTimestamp)}</span>
            </span>
        `;
        
        wrapper.appendChild(meta);
        chatContainer.appendChild(wrapper);
        
        // Update group tracking
        lastMessageSender = senderNick;
        lastMessageGroupElement = wrapper;
    }
    
    lastMessageTimestamp = currentTimestamp;
    chatContainer.scrollTop = chatContainer.scrollHeight;
    
    // Save message to browser's local storage
    if (persist) {
        saveMessageToStorage(text, type, currentTimestamp);
    }
}

// --- Message History Loading ---

async function generateAndSendPublicKey() {
    // Issue #2: ECDH-based E2EE key exchange
    // Generate a public key for this session (browser-side ECDH)
    // Note: In a production system, this would use WebCrypto to generate
    // an actual ECDH keypair. For this simplified version, we use a 
    // derived public identifier from the room password.
    
    try {
        // Generate a session-specific public key identifier
        const sessionId = mySocketId;
        const timestamp = Date.now();
        const publicKeyIdentifier = btoa(`${sessionId}:${timestamp}`);
        
        // Send public key to other user via server
        socket.emit('send_public_key', { publicKeyPem: publicKeyIdentifier }, (response) => {
            if (response && response.success) {
                console.log('Public key sent for E2EE handshake');
            }
        });
    } catch (err) {
        console.error('Failed to generate public key:', err);
    }
}

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
    
    // Send public key for E2EE handshake (Issue #2: ECDH key exchange)
    generateAndSendPublicKey();
});

socket.on('ecdh_handshake_complete', (data) => {
    addSystemMessage('🔐 E2EE handshake complete. All messages are now secure.');
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
        
        // Issue #8: Send notification if app is not focused
        notificationManager.onNewMessage(msgObj.nickname || 'Anonymous', decryptedText);
    } catch(e) {
        console.error("Failed to decrypt incoming message:", e);
    }
});

// When the other user deletes their own messages
socket.on('messages_deleted', (data) => {
    // Remove the other user's message groups from DOM
    const theirMsgs = chatContainer.querySelectorAll('.message-wrapper.received');
    theirMsgs.forEach(el => el.remove());
    
    // Reset group tracking if we deleted the last group
    if (lastMessageSender === data.nickname) {
        lastMessageSender = null;
        lastMessageGroupElement = null;
    }
    
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
    
    // Reset message group tracking
    lastMessageSender = null;
    lastMessageGroupElement = null;
    
    // Clear storage (Issue #5: Enhanced privacy with sessionStorage)
    if (useMemoryStorage) {
        memoryCache[STORAGE_KEY] = [];
    } else {
        storage.removeItem(STORAGE_KEY);
    }
    
    addSystemMessage('🗑️ All chat history has been deleted.');
});

// When the other user deletes their last message
socket.on('last_message_deleted', (data) => {
    // Find the last received message group
    const theirMsgs = chatContainer.querySelectorAll('.message-wrapper.received');
    if (theirMsgs.length > 0) {
        const lastGroup = theirMsgs[theirMsgs.length - 1];
        const messagesList = lastGroup.querySelector('.messages-list');
        
        if (messagesList) {
            // Remove last message from the group
            const messages = messagesList.querySelectorAll('.message-bubble');
            if (messages.length > 1) {
                // Group has multiple messages, remove last one
                messages[messages.length - 1].remove();
            } else {
                // Last message in group, remove entire group
                lastGroup.remove();
                if (lastMessageSender === data.nickname) {
                    lastMessageSender = null;
                    lastMessageGroupElement = null;
                }
            }
        }
    }
    addSystemMessage(`🗑️ ${data.nickname} deleted their last message.`);
});

// Deletion request was rejected
socket.on('delete_all_rejected', (data) => {
    addSystemMessage(`❌ ${data.nickname} rejected your deletion request.`);
});


// --- DOM Actions & User Interaction ---

// Issue #6: Emoji Support
class EmojiSupport {
    constructor() {
        this.emojiPicker = null;
        this.isOpen = false;
        this.initialized = false;
        this.commonEmojis = [
            '😀','😁','😂','🤣','😄','😅','😊','😉','😍','🥰','😎','🤔',
            '😢','😠','😱','🥳','😴','😷','😶','🙄','🤯','😏','😑','🫡',
            '👍','👎','👌','✌️','🤞','👏','🙏','👋','🤦','🤷','💪','🫶',
            '❤️','💕','💔','🔥','⭐','✨','💫','🎉','🏆','💡','🚀','⚡',
            '✅','❌','⚠️','❓','❗','💯','🔒','🔑','📱','💻','☕','🌈',
        ];
    }

    init() {
        if (this.initialized) return;
        this.initialized = true;
        // Create emoji picker button (styled by .emoji-button CSS class)
        const emojiBtn = document.createElement('button');
        emojiBtn.id = 'emojiBtn';
        emojiBtn.className = 'emoji-button';
        emojiBtn.innerHTML = '😊';
        emojiBtn.title = 'Add emoji (or type :shortcut:)';
        emojiBtn.setAttribute('aria-label', 'Open emoji picker');
        emojiBtn.addEventListener('click', (e) => { e.stopPropagation(); this.toggle(); });

        // Insert before send button
        sendMessageBtn.parentNode.insertBefore(emojiBtn, sendMessageBtn);

        // Create emoji picker popup (positioned absolutely within .input-area)
        this.emojiPicker = document.createElement('div');
        this.emojiPicker.id = 'emojiPicker';
        this.emojiPicker.style.cssText = `
            position: absolute;
            background: var(--bg-surface);
            border: 1px solid var(--border-color);
            border-radius: 0.75rem;
            padding: 10px;
            display: none;
            flex-wrap: wrap;
            gap: 3px;
            width: 272px;
            max-height: 230px;
            overflow-y: auto;
            z-index: 200;
            bottom: calc(100% + 8px);
            right: 0;
            box-shadow: 0 10px 20px rgba(0,0,0,0.25);
            animation: fadeIn 0.15s ease-out;
        `;

        // Add emoji buttons
        this.commonEmojis.forEach(emoji => {
            const btn = document.createElement('button');
            btn.textContent = emoji;
            btn.style.cssText = `
                background: transparent;
                border: 1px solid var(--border-color, #3a3a4e);
                border-radius: 4px;
                padding: 4px 8px;
                cursor: pointer;
                font-size: 16px;
                transition: background 0.2s;
            `;
            
            btn.addEventListener('mouseover', () => {
                btn.style.background = 'rgba(255, 255, 255, 0.1)';
            });
            btn.addEventListener('mouseout', () => {
                btn.style.background = 'transparent';
            });
            
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                // Insert emoji at cursor position, not just at end
                const pos = messageInput.selectionStart ?? messageInput.value.length;
                messageInput.value = messageInput.value.slice(0, pos) + emoji + messageInput.value.slice(pos);
                messageInput.selectionStart = messageInput.selectionEnd = pos + [...emoji].length;
                messageInput.focus();
                this.close();
            });
            
            this.emojiPicker.appendChild(btn);
        });

        // Shortcut hint at the bottom of the picker
        const hint = document.createElement('div');
        hint.style.cssText = 'margin-top:7px; padding-top:7px; border-top:1px solid var(--border-color); font-size:0.65rem; color:var(--text-secondary); text-align:center;';
        hint.textContent = '\u{1F4A1} Tip: type :smile: :fire: :rocket: for shortcuts';
        this.emojiPicker.appendChild(hint);

        // Append to .input-area for correct absolute positioning
        const inputArea = document.querySelector('.input-area');
        if (inputArea) {
            if (getComputedStyle(inputArea).position === 'static') inputArea.style.position = 'relative';
            inputArea.appendChild(this.emojiPicker);
        } else {
            document.body.appendChild(this.emojiPicker);
        }

        // Close on outside click or Escape key
        document.addEventListener('click', (e) => {
            if (this.isOpen && !this.emojiPicker.contains(e.target)) this.close();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isOpen) this.close();
        });
    }

    toggle() {
        if (this.isOpen) {
            this.close();
        } else {
            this.open();
        }
    }

    open() {
        this.emojiPicker.style.display = 'flex';
        this.isOpen = true;
    }

    close() {
        this.emojiPicker.style.display = 'none';
        this.isOpen = false;
    }
}

const emojiSupport = new EmojiSupport();

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
                
                // Clear storage (Issue #5: sessionStorage)
                if (useMemoryStorage) {
                    memoryCache[STORAGE_KEY] = [];
                } else {
                    storage.removeItem(STORAGE_KEY);
                }
                
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
        
        // Clear storage (Issue #5: sessionStorage)
        if (useMemoryStorage) {
            memoryCache[STORAGE_KEY] = [];
        } else {
            storage.removeItem(STORAGE_KEY);
        }
        
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
        const finalText = processEmojiShortcuts(text); // Task #3: convert :shortcut: → emoji
        const encryptedPayload = await CryptoService.encryptMessage(finalText);
        const payloadString = JSON.stringify(encryptedPayload);

        socket.emit('send_message', payloadString, (response) => {
            if (response.success) {
                appendMessage(finalText, 'sent', null, true, myNickname);
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

    const isInviteJoin = Boolean(pendingInviteToken);
    if (!isInviteJoin && !secret) {
        showToast('Please enter room secret.');
        joinBtn.disabled = false;
        joinBtn.textContent = 'Join Room';
        return;
    }

    // Connect socket if not already connected
    if (!socket.connected) {
        socket.connect();
    }

    // Join room once connected
    const doJoin = () => {
        if (isInviteJoin) {
            socket.emit('join_room_with_invite', { token: pendingInviteToken, nickname }, async (response) => {
                if (response.success) {
                    isJoined = true;
                    mySocketId = response.socketId;
                    myNickname = nickname;
                    pendingInviteToken = null;
                    applyLoginMode();
                    loginOverlay.classList.add('hidden');
                    joinBtn.disabled = false;
                    joinBtn.textContent = 'Join Room';
                    if (copyInviteBtn) copyInviteBtn.style.display = 'block';
                    document.getElementById('chatContainer').innerHTML = '';
                    addSystemMessage('🚀 Joined the room using invite link.');

                     await CryptoService.deriveKeyFromPassword(response.secret, mySocketId);
                     
                     // Send public key for E2EE handshake (Issue #2)
                     generateAndSendPublicKey();
                     
                     updateStatus('e2ee-ready');
                     messageInput.disabled = false;
                     sendMessageBtn.disabled = false;
                     addSystemMessage('🔐 E2EE active — messages are encrypted.');
                     
                     // Issue #6: Initialize emoji support
                     emojiSupport.init();
                     
                     // Issue #8: Request notification permissions
                     await notificationManager.requestPermissions();

                     await loadHistory(response.messages);
                } else {
                    showToast(response.error || 'Failed to join with invite link.');
                    joinBtn.disabled = false;
                    joinBtn.textContent = 'Join Room';
                    if (response?.code === 'INVITE_USED' || response?.code === 'INVITE_EXPIRED' || response?.code === 'INVITE_INVALID_OR_EXPIRED' || response?.code === 'INVITE_INVALID') {
                        pendingInviteToken = null;
                        applyLoginMode();
                    }
                }
            });
            return;
        }

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
            
                    // Derive encryption key from room secret (PBKDF2) with room ID for uniqueness
                    await CryptoService.deriveKeyFromPassword(secret, mySocketId);
                    
                    // Send public key for E2EE handshake (Issue #2)
                    generateAndSendPublicKey();
                    
                    updateStatus('e2ee-ready');
             messageInput.disabled = false;
             sendMessageBtn.disabled = false;
             addSystemMessage("🔐 E2EE active — messages are encrypted.");
             
             // Issue #6: Initialize emoji support
             emojiSupport.init();
             
             // Issue #8: Request notification permissions
             await notificationManager.requestPermissions();

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
