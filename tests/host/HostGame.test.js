import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { unpackFrame } from '../../src/lib/snapshotCodec.js';
import {
  coreAvailable,
  createHost,
  connectPlayer,
  joinTeam,
  tick,
  pressKey,
} from './harness.js';

// Интеграция host-фасада поверх реального Rust-ядра (pkg-node): полный
// core-driven путь — онбординг, активный игрок, движение, стрельба, боты,
// проекция событий ядра в мету. Бинарные кадры декодируются реальным
// unpackFrame в FakeSocketManager. Пропуск без собранного ядра.

describe.skipIf(!coreAvailable)('HostGame (core-driven)', () => {
  let host;
  let socket;
  let core;

  beforeEach(async () => {
    ({ host, socket, core } = await createHost());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it('конструктор грузит карту в ядро', () => {
    expect(core.map_info()).not.toBe('null');
  });

  it('игрок онбордится спектатором и получает первый кадр', async () => {
    const gameId = await connectPlayer(host);

    expect(gameId).toBeDefined();
    expect(socket.framesOf('sendFirstShot')).toHaveLength(1);
    // вход спектатора: приветствие в чат
    expect(socket.framesOf('sendTechInform').length).toBeGreaterThan(0);
  });

  it('вход в команду создаёт танк в ядре и кадр с player-блоком', async () => {
    const gameId = await connectPlayer(host, { socketId: 's1' });

    joinTeam(host, gameId, 'team1');
    tick(host, 2);

    expect(core.is_alive(gameId)).toBe(true);

    const frame = socket.lastFrame('s1');

    expect(frame.player).not.toBeNull();
    // gameId участника — строка, в player-блоке кадра — число (u8)
    expect(frame.player.gameId).toBe(Number(gameId));
  });

  it('движение вперёд смещает танк в ядре', async () => {
    const gameId = await connectPlayer(host, { socketId: 's1' });

    joinTeam(host, gameId, 'team1');
    tick(host, 1);

    const before = core.position_of(gameId);

    pressKey(host, gameId, 'forward');
    tick(host, 60);

    const after = core.position_of(gameId);
    const moved =
      (after[0] - before[0]) ** 2 + (after[1] - before[1]) ** 2;

    expect(moved).toBeGreaterThan(1);
  });

  it('выстрел кладёт трассер w1 в кадр и списывает боезапас с панели', async () => {
    const gameId = await connectPlayer(host, { socketId: 's1' });

    joinTeam(host, gameId, 'team1');
    tick(host, 2);
    socket.clear();

    pressKey(host, gameId, 'fire');
    tick(host, 2);

    // трассер w1 присутствует в одном из кадров после выстрела
    const withTracer = socket
      .framesOf('sendShot')
      .filter(f => f.socketId === 's1')
      .map(f => unpackFrame(f.args[0]))
      .some(frame => frame.snapshot.w1 && frame.snapshot.w1.length > 0);

    expect(withTracer).toBe(true);
    // панель боезапаса обновилась (списание w1)
    expect(socket.framesOf('sendPanel').length).toBeGreaterThan(0);
  });

  it('боты добавляются в статистику и живут в ядре', async () => {
    const gameId = await connectPlayer(host, { socketId: 's1' });

    // /bot доступна только активному игроку — сперва вход в команду
    joinTeam(host, gameId, 'team1');
    tick(host, 1);

    // одиночный активный игрок → команда исполняется сразу (без голосования)
    host.pushMessage(gameId, '/bot 1');
    tick(host, 2);

    const bots = host._bots.getBots();

    expect(bots.length).toBeGreaterThan(0);
    expect(core.is_alive(bots[0].gameId)).toBe(true);
  });

  it('getPlayersData ядра отдаёт активные танки для первого кадра', async () => {
    const gameId = await connectPlayer(host, { socketId: 's1' });

    joinTeam(host, gameId, 'team1');
    tick(host, 2);

    const data = host._game.getPlayersData();
    const models = Object.values(data);

    expect(models.length).toBeGreaterThan(0);
    expect(Object.keys(data.m1)).toContain(String(gameId));
  });
});
