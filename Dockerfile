# ============================================================
# 1. CORE-BUILDER — Rust-ядро симуляции (WASM для браузера)
# ============================================================

FROM rust:slim AS core-builder

# wasm-pack + target wasm32 для сборки ядра
RUN rustup target add wasm32-unknown-unknown \
    && cargo install wasm-pack --locked

WORKDIR /app

COPY core ./core

RUN wasm-pack build core --release --target web --out-dir pkg-web

# ============================================================
# 2. BUILDER — фронтенд, обработка аудио
# ============================================================

FROM node:20-slim AS builder

# ffmpeg для process-audio.js
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# копирование package.json, чтобы установить зависимости
COPY package.json package-lock.json ./

# установка зависимостей
RUN npm ci

# копирование проекта
COPY . .

# WASM-ядро из core-builder (бандлится в host.worker при vite build)
COPY --from=core-builder /app/core/pkg-web ./core/pkg-web

# переменная окружения для Vite
ENV NODE_ENV=production

# запуск обработки аудио и сборки фронтенда (ядро уже собрано)
RUN npm run build:app

# ============================================================
# 3. RUNNER — Production Image
# ============================================================

FROM node:20-slim AS runner

WORKDIR /app

# зависимости
COPY package.json package-lock.json* ./

RUN npm ci --omit=dev

# фронтенд
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public

# мастер-сервер (лобби + сигналинг WebRTC)
COPY --from=builder /app/src/config ./src/config
COPY --from=builder /app/src/data ./src/data
COPY --from=builder /app/src/lib ./src/lib
COPY --from=builder /app/src/master ./src/master

ENV NODE_ENV=production

# запуск мастер-сервера
CMD ["node", "src/master/main.js"]
