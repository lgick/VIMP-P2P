# ============================================================
# 1. BUILDER — сборка движка
# ============================================================

FROM node:20-slim AS builder

WORKDIR /app

# копирование package.json (включая манифест пакета движка),
# чтобы установить зависимости
COPY package.json package-lock.json ./
COPY packages/engine/package.json ./packages/engine/

# установка зависимостей: npm ci ставит игру-плагин (@vimp/tanks) из
# registry — приносит её уже собранный dist/ (манифест + бандлы + карты +
# звуки), движок больше не собирает WASM игры сам
RUN npm ci

# копирование проекта
COPY . .

# переменная окружения для Vite
ENV NODE_ENV=production

# сборка движка (vite build → packages/engine/dist/)
RUN npm run build:app

# ============================================================
# 2. RUNNER — Production Image
# ============================================================

FROM node:20-slim AS runner

WORKDIR /app

# зависимости: манифест пакета движка нужен npm ci для симлинков @vimp/*
COPY package.json package-lock.json* ./
COPY packages/engine/package.json ./packages/engine/

RUN npm ci --omit=dev

# фронтенд движка (vite build; public копируется Vite внутрь dist)
COPY --from=builder /app/packages/engine/dist ./packages/engine/dist
COPY --from=builder /app/packages/engine/public ./packages/engine/public

# мастер-сервер движка (лобби + сигналинг WebRTC + каталоги)
COPY --from=builder /app/packages/engine/src/config ./packages/engine/src/config
COPY --from=builder /app/packages/engine/src/lib ./packages/engine/src/lib
COPY --from=builder /app/packages/engine/src/master ./packages/engine/src/master

# собранный бандл игры-плагина, поставленный как npm-зависимость (мастер
# читает только dist/manifest.json + dist/maps/*.json через GameCatalog)
COPY --from=builder /app/node_modules/@vimp/tanks/dist ./node_modules/@vimp/tanks/dist

ENV NODE_ENV=production

# запуск мастер-сервера (cwd — пакет движка: dist/assets для WorkerCatalog,
# ../../node_modules/@vimp/tanks — для GameCatalog)
WORKDIR /app/packages/engine

CMD ["node", "src/master/main.js"]
