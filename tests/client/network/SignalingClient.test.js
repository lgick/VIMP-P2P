import { describe, it, expect, beforeEach } from 'vitest';
import SignalingClient from '../../../src/client/network/SignalingClient.js';

// фейковый WebSocket с ручным управлением событиями
class FakeSocket {
  constructor(url) {
    this.url = url;
    this.OPEN = 1;
    this.readyState = 1;
    this.sent = [];
    this.closed = false;
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }

  // симуляция входящего сообщения от мастера
  receive(obj) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }

  lastSent() {
    return this.sent[this.sent.length - 1];
  }
}

let socket;
let client;

beforeEach(() => {
  socket = null;
  client = new SignalingClient('wss://master/', url => {
    socket = new FakeSocket(url);

    return socket;
  });
});

describe('SignalingClient: подключение и welcome', () => {
  it('connect() открывает сокет с переданным url', () => {
    client.connect();

    expect(socket.url).toBe('wss://master/');
  });

  it('повторный connect() не создаёт второй сокет', () => {
    client.connect();
    const first = socket;

    client.connect();

    expect(socket).toBe(first);
  });

  it('welcome кэширует id и iceServers, эмитит событие', () => {
    const events = [];

    client.publisher.on('welcome', msg => events.push(msg));
    client.connect();

    const ice = [{ urls: 'stun:stun.test' }];

    socket.receive({ type: 'welcome', id: 'conn-1', iceServers: ice });

    expect(client.id).toBe('conn-1');
    expect(client.iceServers).toEqual(ice);
    expect(events[0].id).toBe('conn-1');
  });

  it('open/close/socketError ретранслируются через Publisher', () => {
    const seen = [];

    client.publisher.on('open', () => seen.push('open'));
    client.publisher.on('socketError', () => seen.push('error'));
    client.publisher.on('close', () => seen.push('close'));
    client.connect();

    socket.onopen();
    socket.onerror();
    socket.close();

    expect(seen).toEqual(['open', 'error', 'close']);
  });

  it('connected отражает готовность сокета', () => {
    expect(client.connected).toBe(false);

    client.connect();

    expect(client.connected).toBe(true);

    client.close();

    expect(client.connected).toBe(false);
  });
});

describe('SignalingClient: диспетчеризация сообщений', () => {
  beforeEach(() => {
    client.connect();
    socket.receive({ type: 'welcome', id: 'c1', iceServers: [] });
  });

  it('сообщение эмитится подписчикам по type', () => {
    const answers = [];

    client.publisher.on('webrtc_answer', msg => answers.push(msg));

    socket.receive({ type: 'webrtc_answer', hostId: 'h1', sdp: { x: 1 } });

    expect(answers[0].sdp).toEqual({ x: 1 });
  });

  it('невалидный JSON и сообщения без type игнорируются', () => {
    const seen = [];

    client.publisher.on('error', msg => seen.push(msg));

    socket.onmessage({ data: '{ broken' });
    socket.onmessage({ data: JSON.stringify({ noType: true }) });

    expect(seen).toEqual([]);
  });
});

describe('SignalingClient: исходящие сообщения', () => {
  beforeEach(() => {
    client.connect();
  });

  it('sendOffer шлёт webrtc_offer', () => {
    client.sendOffer('h1', { type: 'offer' });

    expect(socket.lastSent()).toEqual({
      type: 'webrtc_offer',
      hostId: 'h1',
      sdp: { type: 'offer' },
    });
  });

  it('sendIceCandidate шлёт ice_candidate с targetId', () => {
    client.sendIceCandidate('h1', { candidate: 'c' });

    expect(socket.lastSent()).toEqual({
      type: 'ice_candidate',
      targetId: 'h1',
      candidate: { candidate: 'c' },
    });
  });

  it('pingHost и reportHost шлют свои сообщения', () => {
    client.pingHost('h1', 42);
    expect(socket.lastSent()).toEqual({
      type: 'ping_host',
      hostId: 'h1',
      pingId: 42,
    });

    client.reportHost('h1');
    expect(socket.lastSent()).toEqual({ type: 'report_host', hostId: 'h1' });
  });

  it('отправка при закрытом сокете молча игнорируется', () => {
    client.close();
    client.sendOffer('h1', {});

    expect(socket.sent).toEqual([]);
  });
});
