import http from 'http';
import express from 'express';
import config from './config/auth.js';
import jwtLib from './lib/jwt.js';
import oauthState from './lib/oauthState.js';
import { getProvider } from './oauth/index.js';
import dbPool from './db/pool.js';
import UserRepository, { NickTakenError } from './UserRepository.js';
import { isValidNick } from './lib/validators.js';

const env = process.env;
const isProduction = env.NODE_ENV === 'production';

if (isProduction && env.VIMP_AUTH_PORT) {
  config.port = Number(env.VIMP_AUTH_PORT);
}

const userRepo = new UserRepository(dbPool.getPool());

function callbackUrl(provider) {
  return `${config.protocol}//${config.domain}:${config.port}/oauth/${provider}/callback`;
}

// извлекает и проверяет Bearer identity-токен, кладёт { id, nick } в req.user
function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  try {
    const payload = jwtLib.verifyToken(token);

    if (payload.pending) {
      res.status(401).json({ error: 'nickRequired' });
      return;
    }

    req.user = { id: Number(payload.sub), nick: payload.nick };
    next();
  } catch {
    res.status(401).json({ error: 'invalidToken' });
  }
}

const app = express();

app.use(express.json());

// GET /oauth/:provider/start?returnUrl=... — редирект на страницу провайдера
app.get('/oauth/:provider/start', (req, res) => {
  const { provider: providerName } = req.params;
  const returnUrl = req.query.returnUrl;

  if (typeof returnUrl !== 'string' || !returnUrl) {
    res.status(400).json({ error: 'returnUrlRequired' });
    return;
  }

  try {
    const provider = getProvider(providerName);
    const state = oauthState.encodeState({ returnUrl });

    res.redirect(provider.getAuthorizationUrl(state, callbackUrl(providerName)));
  } catch {
    res.status(404).json({ error: 'unknownProvider' });
  }
});

// GET /oauth/:provider/callback — обмен code, поиск/создание пользователя,
// редирект обратно на returnUrl с identity- или pending-токеном
app.get('/oauth/:provider/callback', async (req, res) => {
  const { provider: providerName } = req.params;
  const { code, state } = req.query;

  let decodedState;

  try {
    decodedState = oauthState.decodeState(state);
  } catch {
    res.status(400).json({ error: 'invalidState' });
    return;
  }

  try {
    const provider = getProvider(providerName);
    const { providerUid } = await provider.exchangeCode(code, callbackUrl(providerName));
    const user = await userRepo.findOrCreateByProvider(providerName, providerUid);

    const redirectUrl = new URL(decodedState.returnUrl);

    if (user.nick) {
      redirectUrl.searchParams.set(
        'token',
        jwtLib.signIdentityToken({ sub: user.id, nick: user.nick }),
      );
    } else {
      redirectUrl.searchParams.set('pendingToken', jwtLib.signPendingToken({ sub: user.id }));
    }

    res.redirect(redirectUrl.toString());
  } catch (err) {
    console.error('[oauth callback]', err);
    res.status(502).json({ error: 'oauthFailed' });
  }
});

// POST /nick { nick } — первый вход: привязывает глобально уникальный ник
// к pending-токену и выдаёт полноценный identity-токен
app.post('/nick', async (req, res) => {
  const header = req.get('authorization') || '';
  const pendingToken = header.startsWith('Bearer ') ? header.slice(7) : null;
  const { nick } = req.body || {};

  if (!pendingToken) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  if (!isValidNick(nick)) {
    res.status(400).json({ error: 'invalidNick' });
    return;
  }

  let payload;

  try {
    payload = jwtLib.verifyToken(pendingToken);
  } catch {
    res.status(401).json({ error: 'invalidToken' });
    return;
  }

  try {
    const user = await userRepo.setNick(Number(payload.sub), nick);

    res.json({ token: jwtLib.signIdentityToken({ sub: user.id, nick: user.nick }) });
  } catch (err) {
    if (err instanceof NickTakenError) {
      res.status(409).json({ error: 'nickTaken' });
      return;
    }

    throw err;
  }
});

// GET /jwks — публичный ключ для верификации identity-токена хостом
app.get('/jwks', (req, res) => {
  res.json(jwtLib.getJwks());
});

app.get('/rank', requireAuth, async (req, res) => {
  const gameId = req.query.game;

  if (!gameId) {
    res.status(400).json({ error: 'gameRequired' });
    return;
  }

  res.json({ rank: await userRepo.getRank(req.user.id, gameId) });
});

app.put('/rank', requireAuth, async (req, res) => {
  const gameId = req.query.game;

  if (!gameId) {
    res.status(400).json({ error: 'gameRequired' });
    return;
  }

  const rank = Number(req.body?.rank);

  if (!Number.isFinite(rank)) {
    res.status(400).json({ error: 'invalidRank' });
    return;
  }

  await userRepo.upsertRank(req.user.id, gameId, rank);
  res.json({ ok: true });
});

app.get('/state', requireAuth, async (req, res) => {
  const gameId = req.query.game;

  if (!gameId) {
    res.status(400).json({ error: 'gameRequired' });
    return;
  }

  res.json({ state: await userRepo.getState(req.user.id, gameId) });
});

app.put('/state', requireAuth, async (req, res) => {
  const gameId = req.query.game;

  if (!gameId) {
    res.status(400).json({ error: 'gameRequired' });
    return;
  }

  await userRepo.upsertState(req.user.id, gameId, req.body?.state ?? {});
  res.json({ ok: true });
});

const server = http.createServer(app);

server.listen(config.port, () => {
  console.info(`
    Auth service is running for ${env.NODE_ENV || 'development'} mode.
    Listening on http://localhost:${config.port}
  `);
});

export default app;
