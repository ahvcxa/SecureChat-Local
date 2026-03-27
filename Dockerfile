# ---------- Build ----------
FROM node:18-alpine AS builder

# Build tools required for better-sqlite3 (native module)
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy dependency files first (cache optimization)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---------- Run ----------
FROM node:18-alpine

WORKDIR /app

# better-sqlite3 native modülü için gerekli
RUN apk add --no-cache libstdc++

# Sadece gerekli dosyaları kopyala
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY server.js db.js cleanup.js ./
COPY public/ ./public/

# SQLite veritabanı için volume mount noktası
RUN mkdir -p /app/data
VOLUME ["/app/data"]

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Sağlık kontrolü
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000 || exit 1

CMD ["node", "server.js"]
