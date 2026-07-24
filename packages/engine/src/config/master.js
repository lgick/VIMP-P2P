import path from 'path';
import { fileURLToPath } from 'url';

// корень репозитория — якорь от расположения файла, не от cwd
const rootDir = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');

export default {
  name: 'VIMP Master Server',
  protocol: 'https:',
  domain: 'localhost',
  // 3000 — игровой сервер, 3001 — Vite HMR (vite.config.js)
  port: 3002,

  // сертификаты для локальной разработки — в .certs корня репозитория
  // (в продакшене обычный HTTP за Nginx)
  httpsOptions: {
    key: path.join(rootDir, '.certs', 'key.pem'),
    cert: path.join(rootDir, '.certs', 'cert.pem'),
  },

  // список игр-плагинов, подключаемых к мастеру (Этап A2 плана разделения):
  // `package` — имя npm-пакета игры, резолвится через node_modules (сейчас —
  // workspace-симлинк games/tanks, после разъезда репозиториев — обычная
  // зависимость); `version` не используется GameCatalog напрямую, это опорная
  // точка для проверки версии при деплое (Этап A4). В проде переопределяется
  // переменной окружения GAMES_MATRIX (JSON), см. master/main.js
  games: [{ id: 'tanks', package: '@vimp/tanks', version: '0.1.0' }],

  // список серверов (GET /servers)
  servers: {
    // если всего комнат <= порога — региональный фильтр
    // и пагинация отключаются, отдаётся весь список
    regionThreshold: 15,
    defaultLimit: 10, // размер страницы по умолчанию
    maxLimit: 50, // максимальный размер страницы
  },

  // ограничения регистрируемых комнат
  host: {
    maxNameLength: 30, // длина имени комнаты
    maxPlayersLimit: 8, // целевой размер комнаты (рамка P2P-плана)
    heartbeatTimeout: 30000, // нет heartbeat дольше — комната удаляется
    sweepInterval: 10000, // период проверки протухших комнат

    // соц-модерация /ban (Этап 5.3): при banThreshold уникальных по IP жалобах
    // за окно reportWindowMs комната банится (выпадает из списка, WS хоста
    // закрывается, IP не может перерегистрироваться до конца окна)
    banThreshold: 5,
    reportWindowMs: 3600000, // окно учёта жалоб и срок бана (1 час)
  },

  // заголовки безопасности (гигиена среды, Этап 5.4). CSP на статику/.wasm в
  // проде ставит Nginx (см. docs/deployment.md) — здесь single source of truth
  // политики; мастер применяет её к своим ответам только в проде (в dev CSP
  // сломала бы Vite HMR). WASM требует 'wasm-unsafe-eval', Worker — 'blob:';
  // connect-src data: — PixiJS фетчит тестовый data:-URL для проверки ImageBitmap.
  // authServiceUrl (Этап B2) — домен central auth-сервиса (packages/auth):
  // лобби делает туда прямой fetch (POST /nick), поэтому connect-src должен
  // его разрешать; сам OAuth-редирект (location.href на auth-сервис/провайдера)
  // CSP не ограничивает — это навигация верхнего уровня, не fetch/XHR
  security: {
    authServiceUrl: 'http://localhost:3010',
    csp: authServiceUrl =>
      [
        "default-src 'self'",
        "script-src 'self' 'wasm-unsafe-eval'",
        "worker-src 'self' blob:",
        `connect-src 'self' wss: data: ${authServiceUrl}`,
        "img-src 'self' data: blob:",
        "style-src 'self' 'unsafe-inline'",
        "object-src 'none'",
        "base-uri 'self'",
        "frame-ancestors 'none'",
      ].join('; '),
    referrerPolicy: 'no-referrer',
  },

  // заголовок с регионом хоста от Nginx/CDN (например, CF-IPCountry);
  // выбран вместо geoip-lite — бесплатнее по памяти
  regionHeader: 'x-region',

  // лимит сигнальных ping-запросов с одного IP (защита от DDOS)
  pingRateLimit: {
    limit: 10,
    windowMs: 1000,
  },

  // ICE-конфигурация для установки P2P-соединений:
  // STUN обязателен; TURN — опциональный релей по итогам Этапа 0
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};
