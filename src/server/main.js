import fs from 'fs';
import http from 'http';
import https from 'https';
import express from 'express';
import config from '../lib/config.js';
import { buildClientConfig } from '../lib/buildClientConfig.js';
import ViteExpress from 'vite-express';

config.set('auth', (await import('../config/auth.js')).default);
config.set('server', (await import('../config/server.js')).default);
config.set('wsports', (await import('../config/wsports.js')).default);
config.set('game', (await import('../config/game.js')).default);
config.set('client', (await import('../config/client.js')).default);

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

  config.set('server:domain', env.VIMP_DOMAIN);

  // порт для Node.js приложения
  if (env.VIMP_PORT) {
    config.set('server:port', Number(env.VIMP_PORT));
  }

  // максимальное количество игроков
  if (env.VIMP_PLAYERS) {
    config.set('game:maxPlayers', Number(env.VIMP_PLAYERS));
  }

  // стартовая карта
  if (env.VIMP_MAP && config.get('game:maps')[env.VIMP_MAP]) {
    config.set('game:currentMap', env.VIMP_MAP);
  }

  // время раунда
  if (env.VIMP_ROUND_TIME) {
    config.set('game:timers:roundTime', Number(env.VIMP_ROUND_TIME));
  }

  // время карты
  if (env.VIMP_MAP_TIME) {
    config.set('game:timers:mapTime', Number(env.VIMP_MAP_TIME));
  }

  // "огонь по своим" (friendly fire)
  if (env.VIMP_FRIENDLY_FIRE) {
    config.set('game:parts:friendlyFire', env.VIMP_FRIENDLY_FIRE === 'true');
  }

  // если задан режим разработки
} else {
  config.set('server:oneConnection', false);
  config.set('game:isDevMode', true);
}

console.info('------------------------------------------');
console.info('Server Settings:');
console.info(`-> Domain: ${config.get('server:domain')}`);
console.info(`-> Port: ${config.get('server:port')}`);
console.info(`-> Player limit: ${config.get('game:maxPlayers')}`);
console.info(`-> Current map: ${config.get('game:currentMap')}`);
console.info(`-> Round time: ${config.get('game:timers:roundTime')}`);
console.info(`-> Map time: ${config.get('game:timers:mapTime')}`);
console.info(`-> Friendly fire: ${config.get('game:parts:friendlyFire')}`);
console.info('------------------------------------------');

// клиентский CONFIG_DATA: базовый конфиг + время голосования + данные
// client-side prediction (общий билдер с Worker хоста)
config.set(
  'client',
  buildClientConfig(config.get('game'), config.get('client')),
);

// EXPRESS
const app = express();
let server;

const port = config.get('server:port');

// в продакшене обычный HTTP сервер, Nginx будет обрабатывать HTTPS
// для разработки HTTPS сервер с локальными сертификатами
if (isProduction) {
  server = http.createServer(app);
} else {
  try {
    const options = {
      key: fs.readFileSync(config.get('server:httpsOptions:key')),
      cert: fs.readFileSync(config.get('server:httpsOptions:cert')),
    };

    server = https.createServer(options, app);
  } catch (err) {
    console.error(`
      Error creating HTTPS server: ${err.message}.
      Ensure that the paths to the certificate and
      key files in config/server.js are correct and the files exist.

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

// для продакшена localhost, чтобы сервер не был доступен извне напрямую
const host = isProduction ? '0.0.0.0' : undefined;

server.listen(port, host, () => {
  const protocol = isProduction ? 'http:' : 'https:';
  const displayHost = host || 'localhost';

  console.info(`
    Server is running for ${env.NODE_ENV || 'development'} mode.
    Listening on ${protocol}//${displayHost}:${port}
  `);
});

const socket = (await import('./socket/index.js')).default;
socket(server);

ViteExpress.bind(app, server);
