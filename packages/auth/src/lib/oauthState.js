import crypto from 'crypto';

// подписанный state-параметр OAuth (returnUrl + анти-CSRF nonce) без сессий/
// куки — сервис остаётся stateless, как и весь остальной auth-слой (JWT)
const secret = process.env.VIMP_AUTH_STATE_SECRET || 'dev-oauth-state-secret';

function sign(payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

export function encodeState({ returnUrl }) {
  const payload = Buffer.from(
    JSON.stringify({ returnUrl, nonce: crypto.randomBytes(8).toString('hex') }),
  ).toString('base64url');

  return `${payload}.${sign(payload)}`;
}

export function decodeState(state) {
  const [payload, signature] = String(state).split('.');

  if (!payload || !signature || sign(payload) !== signature) {
    throw new Error('invalid oauth state');
  }

  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

export default { encodeState, decodeState };
