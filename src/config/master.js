export default {
  name: 'VIMP Master Server',
  protocol: 'https:',
  domain: 'localhost',
  // 3000 — игровой сервер, 3001 — Vite HMR (vite.config.js)
  port: 3002,

  // сертификаты для локальной разработки
  // (в продакшене обычный HTTP за Nginx)
  httpsOptions: {
    key: './.certs/key.pem',
    cert: './.certs/cert.pem',
  },

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
