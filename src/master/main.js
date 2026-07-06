import fs from 'fs';
import http from 'http';
import https from 'https';
import express from 'express';
import ViteExpress from 'vite-express';
import { WebSocketServer } from 'ws';
import config from '../lib/config.js';
import RateLimiter from '../lib/rateLimiter.js';
import security from '../lib/security.js';
import HostRegistry from './HostRegistry.js';
import SignalingServer from './SignalingServer.js';

config.set('master', (await import('../config/master.js')).default);

const env = process.env;
const isProduction = env.NODE_ENV === 'production';

// если продакшн
if (isProduction) {
  // если не указан домен
  if (!env.VIMP_DOMAIN) {
    console.error(`
      ERROR: VIMP_DOMAIN must be set in the .env file for production.
    `);
    process.exit(1);
  }

  config.set('master:domain', env.VIMP_DOMAIN);

  // порт для мастер-сервера
  if (env.VIMP_MASTER_PORT) {
    config.set('master:port', Number(env.VIMP_MASTER_PORT));
  }
}

console.info('------------------------------------------');
console.info('Master Server Settings:');
console.info(`-> Domain: ${config.get('master:domain')}`);
console.info(`-> Port: ${config.get('master:port')}`);
console.info(`-> Region threshold: ${config.get('master:servers:regionThreshold')}`);
console.info(`-> Max players per host: ${config.get('master:host:maxPlayersLimit')}`);
console.info('------------------------------------------');

const registry = new HostRegistry({
  regionThreshold: config.get('master:servers:regionThreshold'),
  defaultLimit: config.get('master:servers:defaultLimit'),
  maxLimit: config.get('master:servers:maxLimit'),
  maxNameLength: config.get('master:host:maxNameLength'),
  maxPlayersLimit: config.get('master:host:maxPlayersLimit'),
});

const signaling = new SignalingServer(registry, {
  iceServers: config.get('master:iceServers'),
  regionHeader: config.get('master:regionHeader'),
  heartbeatTimeout: config.get('master:host:heartbeatTimeout'),
  pingLimiter: new RateLimiter(config.get('master:pingRateLimit')),
  checkOrigin: security.createOriginValidator({
    protocol: config.get('master:protocol'),
    domain: config.get('master:domain'),
    port: config.get('master:port'),
  }),
});

// EXPRESS
const app = express();
let server;

const port = config.get('master:port');

// REST API: список серверов (пагинация, регионы, поиск)
app.get('/servers', (req, res) => {
  res.json(registry.getList(req.query));
});

// в продакшене обычный HTTP сервер, Nginx будет обрабатывать HTTPS
// для разработки HTTPS сервер с локальными сертификатами
if (isProduction) {
  server = http.createServer(app);
} else {
  try {
    const options = {
      key: fs.readFileSync(config.get('master:httpsOptions:key')),
      cert: fs.readFileSync(config.get('master:httpsOptions:cert')),
    };

    server = https.createServer(options, app);
  } catch (err) {
    console.error(`
      Error creating HTTPS server: ${err.message}.
      Ensure that the paths to the certificate and
      key files in config/master.js are correct and the files exist.

      For local development, creating certificates with mkcert:

      brew install mkcert
      brew install nss
      mkcert -install
      mkdir .certs && cd .certs
      mkcert -key-file key.pem -cert-file cert.pem localhost 127.0.0.1 ::1
    `);

    process.exit(1);
  }
}

const host = isProduction ? '0.0.0.0' : undefined;

server.listen(port, host, () => {
  const protocol = isProduction ? 'http:' : 'https:';
  const displayHost = host || 'localhost';

  console.info(`
    Master server is running for ${env.NODE_ENV || 'development'} mode.
    Listening on ${protocol}//${displayHost}:${port}
  `);
});

// сигнальный WebSocket
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => signaling.handleConnection(ws, req));

// периодическая уборка комнат без heartbeat
setInterval(
  () => signaling.sweepStaleHosts(),
  config.get('master:host:sweepInterval'),
);

// раздача клиентской статики в dev; в prod её отдаёт Nginx
ViteExpress.bind(app, server);
