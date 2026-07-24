import path from 'path';
import { fileURLToPath } from 'url';

// корень репозитория — якорь от расположения файла, не от cwd
const rootDir = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');

export default {
  name: 'VIMP Auth Service',
  protocol: 'http:',
  domain: 'localhost',
  port: 3010,

  // RS256-ключ подписи JWT (private) + публичная часть отдаётся на /jwks;
  // сгенерировать локально: openssl genrsa -out .keys/jwt.pem 2048 &&
  // openssl rsa -in .keys/jwt.pem -pubout -out .keys/jwt.pub.pem
  jwt: {
    privateKeyPath: path.join(rootDir, '.keys', 'jwt.pem'),
    publicKeyPath: path.join(rootDir, '.keys', 'jwt.pub.pem'),
    keyId: 'vimp-auth-1', // kid в JWKS; сменить при ротации ключа
    issuer: 'vimp-auth',
    expiresIn: '15m', // короткоживущий токен (host верифицирует по /jwks)
    pendingExpiresIn: '10m', // токен на выбор ника между OAuth-колбэком и POST /nick
  },

  // подключение к PostgreSQL — по умолчанию из переменных окружения
  // (стандартные PG*), см. docs/en/auth.md
  db: {
    connectionString: process.env.VIMP_AUTH_DATABASE_URL || 'postgres://localhost:5432/vimp_auth',
  },

  // OAuth-провайдеры. B1: только github (см. решение — начать с одного
  // провайдера); google/apple добавляются по тому же паттерну провайдера
  // (getAuthorizationUrl/exchangeCode) в src/oauth/
  oauth: {
    github: {
      clientId: process.env.VIMP_AUTH_GITHUB_CLIENT_ID || '',
      clientSecret: process.env.VIMP_AUTH_GITHUB_CLIENT_SECRET || '',
      authorizeUrl: 'https://github.com/login/oauth/authorize',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      userApiUrl: 'https://api.github.com/user',
      scope: 'read:user',
    },
  },

  // ограничения ника — переиспользует NAME_REGEXP движка
  // (packages/engine/src/lib/validators.js), продублирован в src/lib/validators.js
  nick: {
    maxLength: 14,
  },
};
