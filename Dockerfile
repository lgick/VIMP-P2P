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

# копирование package.json (включая манифесты воркспейсов),
# чтобы установить зависимости
COPY package.json package-lock.json ./
COPY packages/engine/package.json ./packages/engine/
COPY games/tanks/package.json ./games/tanks/

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

# зависимости: манифесты воркспейсов нужны npm ci для симлинков @vimp/*
COPY package.json package-lock.json* ./
COPY packages/engine/package.json ./packages/engine/
COPY games/tanks/package.json ./games/tanks/

RUN npm ci --omit=dev

# фронтенд (vite build движка; public копируется Vite внутрь dist)
COPY --from=builder /app/packages/engine/dist ./packages/engine/dist
COPY --from=builder /app/packages/engine/public ./packages/engine/public

# мастер-сервер движка (лобби + сигналинг WebRTC + каталоги)
COPY --from=builder /app/packages/engine/src/config ./packages/engine/src/config
COPY --from=builder /app/packages/engine/src/lib ./packages/engine/src/lib
COPY --from=builder /app/packages/engine/src/master ./packages/engine/src/master
COPY --from=builder /app/packages/engine/src/gameRegistry.static.js ./packages/engine/src/gameRegistry.static.js

# данные игры (мастер импортирует карты через gameRegistry → @vimp/tanks)
COPY --from=builder /app/games/tanks/src ./games/tanks/src

ENV NODE_ENV=production

# запуск мастер-сервера (cwd — пакет движка: dist/assets для WorkerCatalog)
WORKDIR /app/packages/engine

CMD ["node", "src/master/main.js"]
