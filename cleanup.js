/**
 * cleanup.js
 * Scheduled Cleanup Job for SecureChat Local
 */

const cron = require('node-cron');
const { deleteOldMessages } = require('./db.js');

function startCleanupJob() {
    // Safety net: Clean up messages older than 24 hours every hour
    // (Primary cleanup mechanism runs when the room empties)
    cron.schedule('0 * * * *', () => {
        console.log("Running hourly safety cleanup...");
        try {
            deleteOldMessages();
        } catch (err) {
            console.error("Failed to execute cleanup job:", err);
        }
    });
    
    console.log("Cleanup cron job started (hourly safety net).");
}

module.exports = { startCleanupJob };
