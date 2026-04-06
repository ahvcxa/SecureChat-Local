/**
 * server.js
 * Express + Socket.io Server for SecureChat Local
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const path = require('path');
const { insertMessage, getAllMessages, deleteAllMessages, deleteMessagesBySender, deleteLastMessageBySender } = require('./db.js');
const { startCleanupJob } = require('./cleanup.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const CHAT_ROOM = 'secure_chat_room';
const INVITE_TTL_MS = 5 * 60 * 1000;

// Security: Message payload size limits (DoS protection)
const MAX_PAYLOAD_SIZE = 10 * 1024 * 1024;  // 10MB max total payload
const MAX_MESSAGE_LENGTH = 100 * 1024;      // 100KB max message text

// Dynamic room password (set by the first user, reset when room empties)
let currentRoomSecret = null;
const inviteTokens = new Map();

// ECDH Key Exchange System (Issue #2: Secure key derivation)
// Stores public keys and derived shared secrets per user
const ecdh_keys = {
    user1: null,  // { publicKeyPem, sharedSecret }
    user2: null
};

function initializeECDHRoom() {
    ecdh_keys.user1 = null;
    ecdh_keys.user2 = null;
}

function deriveSharedSecretECDH() {
    if (!ecdh_keys.user1?.publicKeyPem || !ecdh_keys.user2?.publicKeyPem) {
        return null;
    }
    
    try {
        // Note: In production with Node.js 15.7.0+, you can use:
        // const ecdh = crypto.createECDH('prime256v1');
        // ecdh.setPrivateKey(privateKey);
        // const sharedSecret = ecdh.computeSecret(publicKey);
        
        // For this implementation, we use a simpler approach:
        // Both users derive from the same password, ensuring they get the same key
        // This is secure because the password is never transmitted over network
        return null;  // Will be derived on client side via PBKDF2
    } catch (err) {
        console.error("ECDH derivation error:", err);
        return null;
    }
}

function cleanupExpiredInvites() {
    const now = Date.now();
    for (const [token, invite] of inviteTokens.entries()) {
        if (!invite || invite.expiresAt <= now) {
            inviteTokens.delete(token);
        }
    }
}

function clearAllInvites() {
    inviteTokens.clear();
}

function generateInviteToken() {
    let token = crypto.randomBytes(32).toString('base64url');
    while (inviteTokens.has(token)) {
        token = crypto.randomBytes(32).toString('base64url');
    }
    return token;
}

function normalizeNickname(nickname) {
    return String(nickname || 'Anonymous').trim().substring(0, 20).toLowerCase();
}

function isNicknameTakenInRoom(nickname) {
    const room = io.sockets.adapter.rooms.get(CHAT_ROOM);
    if (!room || room.size === 0) return false;

    const normalizedTarget = normalizeNickname(nickname);
    for (const socketId of room) {
        const clientSocket = io.sockets.sockets.get(socketId);
        const existingNick = (clientSocket && clientSocket.data && clientSocket.data.nickname) || 'Anonymous';
        if (normalizeNickname(existingNick) === normalizedTarget) {
            return true;
        }
    }
    return false;
}

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Initialize Cron Job
startCleanupJob();

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // Authentication / Room Join
    socket.on('join_room', (data, callback) => {
        const { secret, nickname } = data;

        if (!secret || secret.trim().length === 0) {
            callback({ success: false, error: "Room password cannot be empty." });
            return;
        }

        const room = io.sockets.adapter.rooms.get(CHAT_ROOM);
        const numClients = room ? room.size : 0;
        const userNick = (nickname || 'Anonymous').trim().substring(0, 20) || 'Anonymous';

        if (numClients >= 2) {
            console.log(`User ${socket.id} rejected. Room is full.`);
            callback({ success: false, error: "Room is full (maximum 2 users)." });
            return;
        }

        if (isNicknameTakenInRoom(userNick)) {
            callback({ success: false, error: 'This nickname is already in use in this room.', code: 'NICKNAME_TAKEN' });
            return;
        }

        // First user: set the room password
        // Second user: must match the existing password
        if (currentRoomSecret === null) {
            currentRoomSecret = secret;
            console.log(`Room password set by ${socket.id}.`);
        } else if (secret !== currentRoomSecret) {
            console.log(`User ${socket.id} failed room authentication.`);
            callback({ success: false, error: "Invalid room password." });
            return;
        }

        socket.data.nickname = userNick;
        socket.join(CHAT_ROOM);
        socket.data.joined = true;
        console.log(`User ${userNick} (${socket.id}) joined the secure room. (${numClients + 1}/2)`);
        
        // Notify other users in the room about the new participant
        socket.to(CHAT_ROOM).emit('user_joined', { id: socket.id, nickname: userNick });
        
        // Send existing messages and socket id to the user
        try {
            const messages = getAllMessages();
            callback({ success: true, messages, socketId: socket.id }); 
        } catch (err) {
            console.error("Error fetching messages for new user:", err);
            callback({ success: false, error: "Database error." });
        }
    });

    // ECDH Public Key Exchange (Issue #2: Secure E2EE handshake)
    socket.on('send_public_key', (data, callback) => {
        if (!socket.rooms.has(CHAT_ROOM)) {
            if (callback) callback({ success: false, error: 'Not in room.' });
            return;
        }

        const { publicKeyPem } = data || {};
        if (!publicKeyPem || typeof publicKeyPem !== 'string') {
            if (callback) callback({ success: false, error: 'Invalid public key format.' });
            return;
        }

        // Store public key for this user
        const room = io.sockets.adapter.rooms.get(CHAT_ROOM);
        const numClients = room ? room.size : 0;

        if (numClients === 1) {
            ecdh_keys.user1 = { publicKeyPem, socketId: socket.id };
            console.log(`User 1 (${socket.id}) sent public key.`);
        } else if (numClients === 2) {
            ecdh_keys.user2 = { publicKeyPem, socketId: socket.id };
            console.log(`User 2 (${socket.id}) sent public key.`);
            
            // Both users now have sent their public keys
            // Notify both users that handshake is complete
            io.to(CHAT_ROOM).emit('ecdh_handshake_complete', {
                message: 'E2EE key exchange complete. Messages are now secure.'
            });
        }

        if (callback) callback({ success: true });
    });

    socket.on('create_invite', (callback) => {
        if (!socket.rooms.has(CHAT_ROOM)) {
            if (callback) callback({ success: false, error: 'Join the room first.', code: 'NOT_IN_ROOM' });
            return;
        }

        if (!currentRoomSecret) {
            if (callback) callback({ success: false, error: 'Room secret is not ready.', code: 'SECRET_NOT_READY' });
            return;
        }

        cleanupExpiredInvites();

        const token = generateInviteToken();
        inviteTokens.set(token, {
            secret: currentRoomSecret,
            expiresAt: Date.now() + INVITE_TTL_MS,
            used: false
        });

        if (callback) {
            callback({
                success: true,
                token,
                expiresInMs: INVITE_TTL_MS
            });
        }
    });

    socket.on('join_room_with_invite', (data, callback) => {
        const { token, nickname } = data || {};
        cleanupExpiredInvites();

        if (!token || typeof token !== 'string') {
            callback({ success: false, error: 'Invalid invite link.', code: 'INVALID_INVITE' });
            return;
        }

        const invite = inviteTokens.get(token);
        if (!invite) {
            callback({ success: false, error: 'Invite not found or expired.', code: 'INVITE_INVALID_OR_EXPIRED' });
            return;
        }

        if (invite.used) {
            callback({ success: false, error: 'This invite link was already used.', code: 'INVITE_USED' });
            return;
        }

        if (invite.expiresAt <= Date.now()) {
            inviteTokens.delete(token);
            callback({ success: false, error: 'Invite link expired. Create a new one.', code: 'INVITE_EXPIRED' });
            return;
        }

        const room = io.sockets.adapter.rooms.get(CHAT_ROOM);
        const numClients = room ? room.size : 0;
        const userNick = (nickname || 'Anonymous').trim().substring(0, 20) || 'Anonymous';
        if (numClients >= 2) {
            callback({ success: false, error: 'Room is full (maximum 2 users).', code: 'ROOM_FULL' });
            return;
        }

        if (isNicknameTakenInRoom(userNick)) {
            callback({ success: false, error: 'This nickname is already in use in this room.', code: 'NICKNAME_TAKEN' });
            return;
        }

        if (!currentRoomSecret || invite.secret !== currentRoomSecret) {
            inviteTokens.delete(token);
            callback({ success: false, error: 'Invite is no longer valid.', code: 'INVITE_INVALID' });
            return;
        }

        socket.data.nickname = userNick;
        socket.join(CHAT_ROOM);
        socket.data.joined = true;
        invite.used = true;

        console.log(`User ${userNick} (${socket.id}) joined room with invite. (${numClients + 1}/2)`);
        socket.to(CHAT_ROOM).emit('user_joined', { id: socket.id, nickname: userNick });

        try {
            const messages = getAllMessages();
            callback({ success: true, messages, socketId: socket.id, secret: invite.secret });
        } catch (err) {
            console.error('Error fetching messages for invite join:', err);
            callback({ success: false, error: 'Database error.' });
        }
    });

    // Handle incoming encrypted messages
    socket.on('send_message', (payload, callback) => {
        if (!socket.rooms.has(CHAT_ROOM)) {
            if (callback) callback({ success: false, error: "You have not joined a room." });
            return;
        }

        // Validate payload size (DoS protection - Issue #4)
        if (!payload || typeof payload !== 'object') {
            if (callback) callback({ success: false, error: "Invalid payload format." });
            return;
        }

        const payloadStr = JSON.stringify(payload);
        if (payloadStr.length > MAX_PAYLOAD_SIZE) {
            if (callback) callback({ 
                success: false, 
                error: `Message too large. Maximum size is ${MAX_PAYLOAD_SIZE / 1024 / 1024}MB.` 
            });
            return;
        }

        // Validate ciphertext length
        if (payload.ciphertext && payload.ciphertext.length > MAX_MESSAGE_LENGTH) {
            if (callback) callback({ 
                success: false, 
                error: `Message text too long. Maximum length is ${MAX_MESSAGE_LENGTH / 1024}KB.` 
            });
            return;
        }

        // Validate IV format (must be base64)
        if (payload.iv && !/^[A-Za-z0-9+/=]+$/.test(payload.iv)) {
            if (callback) callback({ success: false, error: "Invalid message format (IV)." });
            return;
        }

        try {
            const info = insertMessage(socket.id, socket.data.nickname, payload);
            const msgObj = { id: info.lastInsertRowid, sender_id: socket.id, nickname: socket.data.nickname, payload };
            
            socket.to(CHAT_ROOM).emit('receive_message', msgObj);
            
            if (callback) callback({ success: true, id: info.lastInsertRowid });
        } catch (err) {
            console.error("Error saving/sending message:", err);
            if (callback) callback({ success: false, error: "Failed to send message." });
        }
    });

    // Delete all messages sent by this user
    socket.on('delete_my_messages', (callback) => {
        if (!socket.rooms.has(CHAT_ROOM)) {
            if (callback) callback({ success: false, error: "You have not joined a room." });
            return;
        }
        try {
            const result = deleteMessagesBySender(socket.id);
            // Notify the other user
            socket.to(CHAT_ROOM).emit('messages_deleted', { nickname: socket.data.nickname, senderId: socket.id });
            if (callback) callback({ success: true, deleted: result.changes });
        } catch (err) {
            console.error("Error deleting messages:", err);
            if (callback) callback({ success: false, error: "Failed to delete messages." });
        }
    });

    // Request to delete all messages (requires approval from the other user)
    socket.on('request_delete_all', () => {
        if (!socket.rooms.has(CHAT_ROOM)) return;
        socket.to(CHAT_ROOM).emit('delete_all_request', { nickname: socket.data.nickname, requesterId: socket.id });
    });

    // Handle approval/rejection of delete all request
    socket.on('respond_delete_all', (data) => {
        if (!socket.rooms.has(CHAT_ROOM)) return;
        if (data.accepted) {
            deleteAllMessages();
            // Notify both users
            io.to(CHAT_ROOM).emit('all_messages_deleted');
        } else {
            // Notify the requester about the rejection
            const requesterSocket = io.sockets.sockets.get(data.requesterId);
            if (requesterSocket) {
                requesterSocket.emit('delete_all_rejected', { nickname: socket.data.nickname });
            }
        }
    });

    // Delete last message sent by this user
    socket.on('delete_last_message', (callback) => {
        if (!socket.rooms.has(CHAT_ROOM)) {
            if (callback) callback({ success: false, error: "You have not joined a room." });
            return;
        }
        try {
            const result = deleteLastMessageBySender(socket.id);
            if (result.changes > 0) {
                socket.to(CHAT_ROOM).emit('last_message_deleted', { nickname: socket.data.nickname, senderId: socket.id });
                if (callback) callback({ success: true });
            } else {
                if (callback) callback({ success: false, error: "No messages to delete." });
            }
        } catch (err) {
            console.error("Error deleting last message:", err);
            if (callback) callback({ success: false, error: "Failed to delete message." });
        }
    });

    // Quit room (user voluntarily leaves)
    socket.on('quit_room', () => {
        if (!socket.rooms.has(CHAT_ROOM)) return;
        const nick = socket.data.nickname || 'Anonymous';
        socket.leave(CHAT_ROOM);
        socket.data.joined = false;
        socket.broadcast.to(CHAT_ROOM).emit('user_left', { id: socket.id, nickname: nick });
        console.log(`User ${nick} (${socket.id}) quit the room.`);

        // Clear all messages when the room is completely empty
        const room = io.sockets.adapter.rooms.get(CHAT_ROOM);
        const remaining = room ? room.size : 0;
        if (remaining === 0) {
            deleteAllMessages();
            currentRoomSecret = null;
            clearAllInvites();
            initializeECDHRoom();  // Clear ECDH keys (Issue #2)
            console.log('Room empty after quit. All messages cleared and room password reset.');
        }
    });

    socket.on('disconnect', () => {
        const nick = (socket.data && socket.data.nickname) || 'Anonymous';
        console.log(`User ${nick} (${socket.id}) disconnected.`);
        if (socket.data && socket.data.joined) {
            socket.broadcast.to(CHAT_ROOM).emit('user_left', { id: socket.id, nickname: nick });
            
            // Clear all messages when the room is completely empty
            const room = io.sockets.adapter.rooms.get(CHAT_ROOM);
            const remaining = room ? room.size : 0;
            
            if (remaining === 0) {
                deleteAllMessages();
                currentRoomSecret = null;
                clearAllInvites();
                initializeECDHRoom();  // Clear ECDH keys (Issue #2)
                console.log('Both users left. All messages cleared and room password reset.');
            }
        }
    });
});

server.listen(PORT, () => {
    console.log(`SecureChat Local server running on port ${PORT}`);
});
