# 🔒 SecureChat Local

End-to-end encrypted (E2EE) private chat application for two users. All messages are encrypted in the browser — the server never sees plaintext.

![Node.js](https://img.shields.io/badge/Node.js-v18+-339933?logo=node.js&logoColor=white)
![Socket.io](https://img.shields.io/badge/Socket.io-v4-010101?logo=socket.io)
![SQLite](https://img.shields.io/badge/SQLite-better--sqlite3-003B57?logo=sqlite)
![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white)
![License](https://img.shields.io/badge/License-ISC-blue)

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🔐 **E2EE Encryption** | PBKDF2 + AES-256-GCM via Web Crypto API |
| 👥 **2-User Limit** | Room is capped at 2 users — guaranteed privacy |
| 💾 **Message History** | SQLite + localStorage hybrid for session-based persistence |
| 🗑️ **Message Deletion** | `/delete` and `/deleteall` commands for secure deletion |
| 🔗 **Invite Link** | One-click auto-join invite link generation |
| 🧹 **Auto Cleanup** | DB is cleared when the room empties + hourly cron safety net |
| 🐳 **Docker Ready** | Single command deployment — `docker compose up` |
| 📱 **Responsive** | Modern, premium dark-mode UI (glassmorphism) |

---

## 🛡️ Security Architecture

```
User A                         Server                        User B
  │                              │                              │
  │  Room Secret → PBKDF2        │        Room Secret → PBKDF2  │
  │  → AES-256-GCM key          │      → AES-256-GCM key       │
  │                              │                              │
  │  Plaintext → Encrypt         │                              │
  │  ─────────────────────────>  │                              │
  │         (encrypted payload)  │  ──────────────────────────> │
  │                              │         (encrypted payload)  │
  │                              │                Decrypt →      │
  │                              │                Plaintext      │
```

- **100,000 iterations** PBKDF2 (brute-force protection)
- **12-byte random IV** per message (replay attack protection)
- **Zero-knowledge server**: Only relays and stores encrypted data

---

## 🚀 Getting Started

### Prerequisites

- **Node.js** v18 or later
- **npm** v9 or later

### Installation

```bash
# 1. Clone the repository
git clone https://github.com/ahvcxa/SecureChat-Local.git
cd SecureChat-Local

# 2. Install dependencies
npm install

# 3. Configure environment variables
cp .env.example .env
# Edit .env — change ROOM_SECRET to your own secret

# 4. Start the server
npm start
```

Open `http://localhost:3000` in your browser.

---

## 🐳 Docker

### Docker Compose (Recommended)

```bash
# Create .env file
cp .env.example .env

# Start
docker compose up -d

# Stop
docker compose down
```

### Manual Docker

```bash
# Build the image
docker build -t securechat-local .

# Run
docker run -d \
  --name securechat \
  -p 3000:3000 \
  -e ROOM_SECRET=your_secret_here \
  securechat-local
```

Open `http://localhost:3000` in your browser.

---

## 🌐 Public Access (Tunnel)

Want to chat with someone on a different network? Use [untun](https://github.com/unjs/untun) to create a public tunnel:

```bash
npx untun@latest tunnel http://localhost:3000
```

This generates a public URL you can share. Works with both local and Docker setups.

> **Note:** The tunnel URL changes each time. Share it privately — anyone with the URL can access the login page (but still needs the room secret to join).

---

## ⚙️ Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `ROOM_SECRET` | `default_room_secret` | Shared room secret (all users must use the same secret) |

---

## 💬 Chat Commands

| Command | Action |
|---------|--------|
| `/delete` | Deletes **all your own messages** (does not affect the other user's messages) |
| `/deleteall` | Sends approval request to the other user — if accepted, **all chat history** is deleted |

---

## 📁 Project Structure

```
SecureChat-Local/
├── server.js              # Express + Socket.io server
├── db.js                  # SQLite database (better-sqlite3)
├── cleanup.js             # Hourly old message cleanup (node-cron)
├── Dockerfile             # Multi-stage Docker build
├── docker-compose.yml     # Docker Compose configuration
├── .env.example           # Environment variables template
├── package.json           # Dependencies and scripts
├── .github/
│   └── workflows/
│       └── ci.yml         # GitHub Actions CI pipeline
└── public/
    ├── index.html         # Main page (UI + CSS)
    ├── chat.js            # Socket.io client + message logic
    └── crypto.js          # Web Crypto API (PBKDF2 + AES-GCM)
```

---

## 📦 Dependencies

| Package | Version | Description |
|---------|---------|-------------|
| [express](https://expressjs.com) | ^5.2.1 | HTTP server framework |
| [socket.io](https://socket.io) | ^4.8.3 | Real-time WebSocket communication |
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | ^12.8.0 | High-performance SQLite3 driver |
| [dotenv](https://github.com/motdotla/dotenv) | ^17.3.1 | Environment variable loader from `.env` |
| [node-cron](https://github.com/node-cron/node-cron) | ^4.2.1 | Scheduled tasks (old message cleanup) |

---

## 🔒 Privacy Notes

- The server **never** has access to plaintext messages
- Only **encrypted payloads** are stored in the database
- Database is **automatically cleared** when the room empties
- `.env` is included in `.gitignore` — your room secret stays safe

---

## 🤖 CI/CD

On every push and pull request, GitHub Actions automatically:

1. Runs **syntax validation** across Node.js 18, 20, and 22
2. Builds the **Docker image** (main/master branch only)

---

## 📄 License

This project is licensed under the [ISC License](https://opensource.org/licenses/ISC).
