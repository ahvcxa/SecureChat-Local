/**
 * server.js
 * Express + Socket.io Server for SecureChat Local
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { insertMessage, getAllMessages, deleteAllMessages, deleteMessagesBySender } = require('./db.js');
const { startCleanupJob } = require('./cleanup.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const CHAT_ROOM = 'secure_chat_room';

// Dynamic room password (set by the first user, reset when room empties)
let currentRoomSecret = null;

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

        if (numClients >= 2) {
            console.log(`User ${socket.id} rejected. Room is full.`);
            callback({ success: false, error: "Room is full (maximum 2 users)." });
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

        const userNick = (nickname || 'Anonymous').substring(0, 20);
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

    // Handle incoming encrypted messages
    socket.on('send_message', (payload, callback) => {
        if (!socket.rooms.has(CHAT_ROOM)) {
            if (callback) callback({ success: false, error: "You have not joined a room." });
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
                console.log('Both users left. All messages cleared and room password reset.');
            }
        }
    });
});

server.listen(PORT, () => {
    console.log(`SecureChat Local server running on port ${PORT}`);
});
