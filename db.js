/**
 * db.js
 * SQLite Database Layer for SecureChat Local
 */

const Database = require('better-sqlite3');
const path = require('path');

// Initialize the SQLite database connection
const dbPath = path.join(__dirname, 'chat.db');
const db = new Database(dbPath);

// Define the schema
try {
    db.pragma('journal_mode = WAL');
    
    // Drop and recreate table on startup (ephemeral by design)
    db.exec(`DROP TABLE IF EXISTS messages`);

    const createTableStmt = `
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sender_id TEXT NOT NULL,
            nickname TEXT NOT NULL DEFAULT 'Anonymous',
            payload TEXT NOT NULL,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `;
    db.exec(createTableStmt);
    console.log("Database initialized successfully.");
} catch (err) {
    console.error("Database initialization failed:", err);
}

// Prepare statements for SQL injection prevention
const insertMessageStmt = db.prepare('INSERT INTO messages (sender_id, nickname, payload) VALUES (?, ?, ?)');
const getAllMessagesStmt = db.prepare('SELECT id, sender_id, nickname, payload, timestamp FROM messages ORDER BY id ASC');
const deleteOldMessagesStmt = db.prepare("DELETE FROM messages WHERE timestamp < datetime('now', '-1 day')");
const deleteAllMessagesStmt = db.prepare('DELETE FROM messages');
const deleteMessagesBySenderStmt = db.prepare('DELETE FROM messages WHERE sender_id = ?');
const deleteLastMessageBySenderStmt = db.prepare('DELETE FROM messages WHERE id = (SELECT id FROM messages WHERE sender_id = ? ORDER BY id DESC LIMIT 1)');

module.exports = {
    db,
    insertMessage: (senderId, nickname, payload) => insertMessageStmt.run(senderId, nickname, payload),
    getAllMessages: () => getAllMessagesStmt.all(),
    deleteOldMessages: () => {
        const result = deleteOldMessagesStmt.run();
        console.log(`Deleted ${result.changes} old messages from database.`);
    },
    deleteAllMessages: () => {
        const result = deleteAllMessagesStmt.run();
        console.log(`All messages cleared from database (${result.changes} deleted).`);
    },
    deleteMessagesBySender: (senderId) => {
        const result = deleteMessagesBySenderStmt.run(senderId);
        console.log(`Deleted ${result.changes} messages from sender ${senderId}.`);
        return result;
    },
    deleteLastMessageBySender: (senderId) => {
        const result = deleteLastMessageBySenderStmt.run(senderId);
        console.log(`Deleted last message from sender ${senderId}.`);
        return result;
    }
};
