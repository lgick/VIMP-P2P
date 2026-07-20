# ============================================================
# 1. CORE-BUILDER — Rust-ядро игры (WASM для браузера)
# ============================================================

FROM rust:slim AS core-builder

# wasm-pack + target wasm32 для сборки ядра
RUN rustup target add wasm32-unknown-unknown \
    && cargo install wasm-pack --locked

WORKDIR /app

# cargo workspace: движковый rlib (vimp-engine-core) + игровой cdylib
# (vimp-tanks-core); wasm-pack собирает игровой crate, движковый тянется
# как path-зависимость
COPY Cargo.toml ./Cargo.toml
COPY packages/engine/core ./packages/engine/core
COPY games/tanks/core ./games/tanks/core

RUN wasm-pack build games/tanks/core --release --target web --out-dir pkg-web

# ============================================================
# 2. BUILDER — сборка игры-плагина и движка, обработка аудио
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

# WASM-ядро игры из core-builder (бандлится в games/tanks/dist при сборке
# плагина; и в host-, и в client-бандл ссылается на один hashed .wasm)
COPY --from=core-builder /app/games/tanks/core/pkg-web ./games/tanks/core/pkg-web

# переменная окружения для Vite
ENV NODE_ENV=production

# сборка игры-плагина (client/host-бандлы, wasm, карты, звуки, manifest.json
# → games/tanks/dist/) и движка (audio + vite build → packages/engine/dist/)
RUN npm run game:build && npm run build:app

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

# фронтенд движка (vite build; public копируется Vite внутрь dist)
COPY --from=builder /app/packages/engine/dist ./packages/engine/dist
COPY --from=builder /app/packages/engine/public ./packages/engine/public

# мастер-сервер движка (лобби + сигналинг WebRTC + каталоги)
COPY --from=builder /app/packages/engine/src/config ./packages/engine/src/config
COPY --from=builder /app/packages/engine/src/lib ./packages/engine/src/lib
COPY --from=builder /app/packages/engine/src/master ./packages/engine/src/master

# собранный бандл игры-плагина (мастер читает только dist/manifest.json +
# dist/maps/*.json через GameCatalog — исходники games/tanks/src раннеру
# не нужны, статической композиции движок↔игра больше нет)
COPY --from=builder /app/games/tanks/dist ./games/tanks/dist

ENV NODE_ENV=production

# запуск мастер-сервера (cwd — пакет движка: dist/assets для WorkerCatalog,
# ../../games — для GameCatalog)
WORKDIR /app/packages/engine

CMD ["node", "src/master/main.js"]
