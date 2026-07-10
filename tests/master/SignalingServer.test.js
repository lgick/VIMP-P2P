import { describe, it, expect, beforeEach } from 'vitest';
import HostRegistry from '../../src/master/HostRegistry.js';
import SignalingServer from '../../src/master/SignalingServer.js';
import RateLimiter from '../../src/lib/rateLimiter.js';

// фейковый ws: собирает отправленные сообщения, позволяет эмитить события
class FakeWs {
  constructor() {
    this.OPEN = 1;
    this.readyState = 1;
    this.sent = [];
    this.closed = null;
    this.terminated = false;
    this.handlers = {};
  }

  on(event, fn) {
    this.handlers[event] = fn;
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close(code, reason) {
    this.closed = { code, reason };
    this.readyState = 3;
    this.handlers.close?.();
  }

  terminate() {
    this.terminated = true;
  }

  // входящее сигнальное сообщение
  message(obj) {
    this.handlers.message(JSON.stringify(obj));
  }

  lastSent() {
    return this.sent[this.sent.length - 1];
  }
}

const nextTick = () => new Promise(resolve => process.nextTick(resolve));

const allowAllOrigins = (requestOrigin, cb) => process.nextTick(() => cb(null));

const ICE_SERVERS = [{ urls: 'stun:stun.test:3478' }];

let registry;
let signaling;

beforeEach(() => {
  registry = new HostRegistry({
    maxPlayersLimit: 8,
    banThreshold: 3,
    reportWindowMs: 100000,
  });
  signaling = new SignalingServer(registry, {
    iceServers: ICE_SERVERS,
    regionHeader: 'x-region',
    heartbeatTimeout: 1000,
    pingLimiter: new RateLimiter({ limit: 2, windowMs: 1000 }),
    checkOrigin: allowAllOrigins,
    mapsVersion: 'v-test',
    codeVersion: 'code-test',
  });
});

// подключает фейковое соединение и возвращает { ws, id }
const connect = async ({ ip = '9.9.9.9', region = 'EU', origin = 'https://localhost:3001' } = {}) => {
  const ws = new FakeWs();
  const req = {
    headers: { origin, 'x-region': region },
    socket: { remoteAddress: ip },
  };

  signaling.handleConnection(ws, req);
  await nextTick();

  return { ws, id: ws.sent[0]?.id };
};

// подключает и регистрирует хоста
const connectHost = async (options = {}) => {
  const conn = await connect({ ip: '1.1.1.1', ...options });

  conn.ws.message({
    type: 'register_host',
    name: 'Room',
    maxPlayers: 8,
    mapName: 'arena',
  });

  conn.hostId = conn.ws.lastSent().hostId;

  return conn;
};

describe('подключение', () => {
  it('шлёт welcome с id соединения и ICE-конфигом', async () => {
    const { ws } = await connect();

    expect(ws.sent[0].type).toBe('welcome');
    expect(ws.sent[0].id).toBeTypeOf('string');
    expect(ws.sent[0].iceServers).toEqual(ICE_SERVERS);
  });

  it('обрывает соединение без origin', async () => {
    const ws = new FakeWs();

    signaling.handleConnection(ws, {
      headers: {},
      socket: { remoteAddress: '1.1.1.1' },
    });

    expect(ws.terminated).toBe(true);
  });

  it('закрывает соединение с чужим origin кодом 4001', async () => {
    const blocking = new SignalingServer(registry, {
      iceServers: ICE_SERVERS,
      regionHeader: 'x-region',
      heartbeatTimeout: 1000,
      pingLimiter: new RateLimiter({ limit: 2, windowMs: 1000 }),
      checkOrigin: (o, cb) => process.nextTick(() => cb('blocked')),
    });

    const ws = new FakeWs();

    blocking.handleConnection(ws, {
      headers: { origin: 'https://evil.test' },
      socket: { remoteAddress: '1.1.1.1' },
    });
    await nextTick();

    expect(ws.closed.code).toBe(4001);
    expect(ws.sent).toHaveLength(0);
  });

  it('игнорирует не-JSON и сообщения без известного type', async () => {
    const { ws } = await connect();

    ws.handlers.message('not json');
    ws.message({ type: 'hack_the_planet' });
    ws.message({ foo: 'bar' });

    expect(ws.sent).toHaveLength(1); // только welcome
  });
});

describe('register_host', () => {
  it('регистрирует комнату с регионом из заголовка и IP соединения', async () => {
    const { ws } = await connectHost({ region: 'US' });

    const reply = ws.lastSent();

    expect(reply.type).toBe('host_registered');
    // версии каталога карт и worker-бандла — для сверки хостом при
    // re-register (Этапы 5.1/5.2)
    expect(reply.mapsVersion).toBe('v-test');
    expect(reply.codeVersion).toBe('code-test');

    const host = registry.get(reply.hostId);

    expect(host).toMatchObject({ name: 'Room', region: 'US', ip: '1.1.1.1' });
  });

  it('отклоняет повторную регистрацию того же соединения', async () => {
    const { ws } = await connectHost();

    ws.message({ type: 'register_host', name: 'Second' });

    expect(ws.lastSent()).toEqual({ type: 'error', code: 'alreadyRegistered' });
    expect(registry.size).toBe(1);
  });

  it('отклоняет вторую комнату с того же IP', async () => {
    await connectHost();
    const second = await connect({ ip: '1.1.1.1' });

    second.ws.message({ type: 'register_host', name: 'Second' });

    expect(second.ws.lastSent()).toEqual({ type: 'error', code: 'hostLimit' });
  });
});

describe('update_host / heartbeat', () => {
  it('update_host актуализирует данные комнаты', async () => {
    const { ws, hostId } = await connectHost();

    ws.message({ type: 'update_host', currentPlayers: 3, mapName: 'dune' });

    expect(registry.get(hostId)).toMatchObject({
      currentPlayers: 3,
      mapName: 'dune',
    });
  });

  it('heartbeat обновляет lastSeen', async () => {
    const { ws, hostId } = await connectHost();
    const host = registry.get(hostId);

    host.lastSeen = 0;
    ws.message({ type: 'heartbeat' });

    expect(host.lastSeen).toBeGreaterThan(0);
  });
});

describe('маршрутизация WebRTC', () => {
  it('пересылает оффер хосту с clientId, ответ — клиенту с hostId', async () => {
    const host = await connectHost();
    const client = await connect();

    client.ws.message({ type: 'webrtc_offer', hostId: host.hostId, sdp: 'OFFER' });

    expect(host.ws.lastSent()).toEqual({
      type: 'webrtc_offer',
      clientId: client.id,
      sdp: 'OFFER',
    });

    host.ws.message({ type: 'webrtc_answer', clientId: client.id, sdp: 'ANSWER' });

    expect(client.ws.lastSent()).toEqual({
      type: 'webrtc_answer',
      hostId: host.hostId,
      sdp: 'ANSWER',
    });
  });

  it('оффер неизвестному хосту возвращает ошибку', async () => {
    const client = await connect();

    client.ws.message({ type: 'webrtc_offer', hostId: 'nope', sdp: 'OFFER' });

    expect(client.ws.lastSent()).toEqual({ type: 'error', code: 'unknownHost' });
  });

  it('пересылает ICE-кандидатов в обе стороны', async () => {
    const host = await connectHost();
    const client = await connect();

    client.ws.message({
      type: 'ice_candidate',
      targetId: host.hostId,
      candidate: 'C1',
    });

    expect(host.ws.lastSent()).toEqual({
      type: 'ice_candidate',
      fromId: client.id,
      candidate: 'C1',
    });

    host.ws.message({
      type: 'ice_candidate',
      targetId: client.id,
      candidate: 'C2',
    });

    expect(client.ws.lastSent()).toEqual({
      type: 'ice_candidate',
      fromId: host.hostId,
      candidate: 'C2',
    });
  });
});

describe('ping_host / pong_host', () => {
  it('пересылает пинг хосту и понг обратно клиенту', async () => {
    const host = await connectHost();
    const client = await connect();

    client.ws.message({ type: 'ping_host', hostId: host.hostId, pingId: 7 });

    expect(host.ws.lastSent()).toEqual({
      type: 'ping_host',
      clientId: client.id,
      pingId: 7,
    });

    host.ws.message({ type: 'pong_host', clientId: client.id, pingId: 7 });

    expect(client.ws.lastSent()).toEqual({
      type: 'pong_host',
      hostId: host.hostId,
      pingId: 7,
    });
  });

  it('ограничивает частоту пингов с одного IP', async () => {
    const host = await connectHost();
    const client = await connect();

    // лимит в тестовом конфиге — 2 за окно
    client.ws.message({ type: 'ping_host', hostId: host.hostId, pingId: 1 });
    client.ws.message({ type: 'ping_host', hostId: host.hostId, pingId: 2 });
    client.ws.message({ type: 'ping_host', hostId: host.hostId, pingId: 3 });

    expect(client.ws.lastSent()).toEqual({ type: 'error', code: 'rateLimited' });

    // третий пинг до хоста не дошёл
    const pings = host.ws.sent.filter(msg => msg.type === 'ping_host');
    expect(pings).toHaveLength(2);
  });
});

describe('report_host', () => {
  // сессия получает право на жалобу, только отправив оффер этой комнате
  const joinRoom = (client, hostId) => {
    client.ws.message({ type: 'webrtc_offer', hostId, sdp: 'offer' });
  };

  it('учитывает жалобу один раз на IP репортёра и хранит причину', async () => {
    const host = await connectHost();
    const client = await connect({ ip: '5.5.5.5' });

    joinRoom(client, host.hostId);

    client.ws.message({
      type: 'report_host',
      hostId: host.hostId,
      reason: 'aimbot',
    });
    client.ws.message({
      type: 'report_host',
      hostId: host.hostId,
      reason: 'aimbot again',
    });

    const room = registry.get(host.hostId);

    expect(room.reportCount).toBe(1);
    expect(room.reportReasons).toEqual(['aimbot']);
  });

  it('отклоняет жалобу от сессии, не подключавшейся к комнате', async () => {
    const host = await connectHost();
    const stranger = await connect({ ip: '7.7.7.7' });

    stranger.ws.message({
      type: 'report_host',
      hostId: host.hostId,
      reason: 'aimbot',
    });

    expect(stranger.ws.lastSent()).toEqual({
      type: 'error',
      code: 'reportRejected',
    });
    expect(registry.get(host.hostId).reportCount).toBe(0);
  });

  it('не учитывает жалобу без причины', async () => {
    const host = await connectHost();
    const client = await connect({ ip: '5.5.5.5' });

    joinRoom(client, host.hostId);
    client.ws.message({ type: 'report_host', hostId: host.hostId });

    expect(registry.get(host.hostId).reportCount).toBe(0);
  });

  it('при достижении порога банит хоста и закрывает его сигнальный WS', async () => {
    const host = await connectHost();

    // banThreshold = 3: жалобы от трёх разных IP
    for (let i = 0; i < 3; i += 1) {
      const client = await connect({ ip: `5.5.5.${i}` });
      joinRoom(client, host.hostId);
      client.ws.message({
        type: 'report_host',
        hostId: host.hostId,
        reason: 'cheat',
      });
    }

    // WS хоста закрыт кодом 4002; его close-хендлер убрал комнату из реестра
    expect(host.ws.closed.code).toBe(4002);
    expect(registry.get(host.hostId)).toBeUndefined();
  });

  it('забаненный IP не может зарегистрировать новую комнату', async () => {
    const host = await connectHost(); // ip 1.1.1.1

    for (let i = 0; i < 3; i += 1) {
      const client = await connect({ ip: `6.6.6.${i}` });
      joinRoom(client, host.hostId);
      client.ws.message({
        type: 'report_host',
        hostId: host.hostId,
        reason: 'cheat',
      });
    }

    // тот же IP 1.1.1.1 пробует поднять новую комнату
    const again = await connect({ ip: '1.1.1.1' });
    again.ws.message({ type: 'register_host', name: 'Evade' });

    expect(again.ws.lastSent()).toEqual({ type: 'error', code: 'banned' });
  });
});

describe('жизненный цикл хоста', () => {
  it('отключение хоста удаляет комнату из реестра', async () => {
    const host = await connectHost();

    host.ws.handlers.close();

    expect(registry.get(host.hostId)).toBeUndefined();

    // адресованные мёртвому хосту сообщения дают unknownHost
    const client = await connect();
    client.ws.message({ type: 'webrtc_offer', hostId: host.hostId, sdp: 'X' });

    expect(client.ws.lastSent()).toEqual({ type: 'error', code: 'unknownHost' });
  });

  it('sweepStaleHosts удаляет протухшую комнату и закрывает её сокет', async () => {
    const host = await connectHost();

    registry.get(host.hostId).lastSeen = 0;

    const removed = signaling.sweepStaleHosts(5000);

    expect(removed).toEqual([host.hostId]);
    expect(registry.get(host.hostId)).toBeUndefined();
    expect(host.ws.closed.code).toBe(4000);
  });
});
