/**
 * crypto.js
 * End-to-End Encryption (E2EE) using Web Crypto API
 * 
 * Security Architecture (v2 — PBKDF2-based):
 * 1. A high-security AES-GCM key is derived from the room secret using PBKDF2.
 * 2. Anyone who knows the same secret shares the same key → message history is always readable.
 * 3. Decryption occurs exclusively in the browser — the server never sees plaintext.
 * 4. This approach works seamlessly across page refreshes, incognito tabs, and different devices.
 */

const CryptoService = (() => {
    // AES-GCM encryption key derived via PBKDF2
    let derivedKey = null;
    // Fixed salt (room-specific, deterministic)
    // In production, this salt should be random and stored securely,
    // but for our use case, the room secret is already unique, so a fixed salt is sufficient.
    const SALT_STRING = 'SecureChatLocal_v2_salt';

    /**
     * Step 1: Derive AES-GCM key from room secret (PBKDF2)
     * Takes the user's room secret and applies PBKDF2 with 100,000 iterations
     * of SHA-256 to produce a strong 256-bit encryption key.
     */
    async function deriveKeyFromPassword(password) {
        try {
            const encoder = new TextEncoder();
            
            // Convert the password to raw key material
            const keyMaterial = await window.crypto.subtle.importKey(
                "raw",
                encoder.encode(password),
                "PBKDF2",
                false,
                ["deriveKey"]
            );

            // Fixed salt (produces deterministic results for a given secret)
            const salt = encoder.encode(SALT_STRING);

            // Derive AES-GCM key using PBKDF2
            derivedKey = await window.crypto.subtle.deriveKey(
                {
                    name: "PBKDF2",
                    salt: salt,
                    iterations: 100000,  // High iteration count against brute-force attacks
                    hash: "SHA-256"
                },
                keyMaterial,
                {
                    name: "AES-GCM",
                    length: 256          // 256-bit security
                },
                false,                   // No need to export the key
                ["encrypt", "decrypt"]
            );

            console.log("AES-GCM key successfully derived from room secret. E2EE active.");
            return derivedKey;
        } catch (error) {
            console.error("Key derivation error:", error);
            throw new Error("Failed to create encryption key.");
        }
    }

    /**
     * Step 2: Message Encryption (AES-GCM)
     * Takes plaintext and encrypts it using AES-GCM with a random IV (Initialization Vector).
     * Returns the IV and ciphertext in base64 format.
     */
    async function encryptMessage(plainTextData) {
        if (!derivedKey) {
            throw new Error("Encryption key is not ready.");
        }

        try {
            const encoder = new TextEncoder();
            const dataToEncrypt = encoder.encode(plainTextData);

            // GCM requires a unique IV (12 bytes recommended)
            const iv = window.crypto.getRandomValues(new Uint8Array(12));

            const encryptedBuffer = await window.crypto.subtle.encrypt(
                {
                    name: "AES-GCM",
                    iv: iv
                },
                derivedKey,
                dataToEncrypt
            );

            // Convert byte arrays to Base64 strings
            const encryptedArray = Array.from(new Uint8Array(encryptedBuffer));
            const ivArray = Array.from(iv);
            
            const ciphertextBase64 = btoa(String.fromCharCode.apply(null, encryptedArray));
            const ivBase64 = btoa(String.fromCharCode.apply(null, ivArray));

            return {
                ciphertext: ciphertextBase64,
                iv: ivBase64
            };
        } catch (error) {
            console.error("Encryption error:", error);
            throw error;
        }
    }

    /**
     * Step 3: Message Decryption (AES-GCM)
     * Takes base64 IV and ciphertext, decrypts with the derived key, and returns plaintext.
     */
    async function decryptMessage(encryptedPayload) {
        if (!derivedKey) {
            throw new Error("No decryption key available.");
        }

        try {
            const { ciphertext, iv } = encryptedPayload;

            // Base64 -> Uint8Array conversion
            const encryptedBytes = new Uint8Array(atob(ciphertext).split("").map(c => c.charCodeAt(0)));
            const ivBytes = new Uint8Array(atob(iv).split("").map(c => c.charCodeAt(0)));

            const decryptedBuffer = await window.crypto.subtle.decrypt(
                {
                    name: "AES-GCM",
                    iv: ivBytes
                },
                derivedKey,
                encryptedBytes
            );

            const decoder = new TextDecoder();
            return decoder.decode(decryptedBuffer);
            
        } catch (error) {
            console.error("Decryption failed:", error);
            throw new Error("Failed to decrypt message.");
        }
    }

    // Helper method to check E2EE readiness
    function isE2EEReady() {
        return derivedKey !== null;
    }

    return {
        deriveKeyFromPassword,
        encryptMessage,
        decryptMessage,
        isE2EEReady
    };
})();
