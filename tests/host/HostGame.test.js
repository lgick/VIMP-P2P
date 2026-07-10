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

  it('removeUser удаляет танк из ядра и клиенты получают null-маркер', async () => {
    const gameId = await connectPlayer(host, { name: 'P1', socketId: 's1' });
    const gameId2 = await connectPlayer(host, { name: 'P2', socketId: 's2' });

    joinTeam(host, gameId, 'team1');
    joinTeam(host, gameId2, 'team2');
    tick(host, 4);

    host.removeUser(gameId);

    expect(core.is_alive(gameId)).toBe(false);
    expect(host._participants.get(gameId)).toBeUndefined();

    socket.clear();
    tick(host, 8);

    // null-маркер ушедшего танка в одном из кадров второго игрока
    const nullMarker = socket
      .framesOf('sendShot')
      .filter(f => f.socketId === 's2')
      .map(f => unpackFrame(f.args[0]))
      .some(frame => frame.snapshot.m1?.[gameId] === null);

    expect(nullMarker).toBe(true);
  });

  it('removeUser наблюдателя не трогает ядро и чистит мету', async () => {
    const gameId = await connectPlayer(host, { socketId: 's1' });

    host.removeUser(gameId);

    expect(host._participants.get(gameId)).toBeUndefined();
    // повторное удаление безвредно
    expect(() => host.removeUser(gameId)).not.toThrow();
  });

  it('isFull считает только людей — боты место не занимают', async () => {
    ({ host, socket, core } = await createHost({ game: { maxPlayers: 2 } }));

    expect(host.isFull).toBe(false);

    await connectPlayer(host, { name: 'P1', socketId: 's1' });

    // комната «полна» ботами, но людей меньше лимита — вход открыт
    host._bots.createBots(2, 'team1');
    expect(host.isFull).toBe(false);

    // подключение человека вытесняет бота (суммарный лимит был выбран)
    const botsBefore = host._bots.getBotCount();

    await connectPlayer(host, { name: 'P2', socketId: 's2' });

    expect(host._bots.getBotCount()).toBe(botsBefore - 1);
    expect(host.isFull).toBe(true);
    expect(host.maxPlayers).toBe(2);
  });

  it('хост-игрок исключён из idle- и RTT-киков', async () => {
    ({ host, socket, core } = await createHost({
      opts: { hostSocketId: 'local' },
    }));

    const hostId = await connectPlayer(host, { name: 'H', socketId: 'local' });
    const guestId = await connectPlayer(host, { name: 'G', socketId: 's2' });

    // RTT-кик хоста-игрока игнорируется, гостя — исполняется
    host._kickForMissedPings(hostId);
    expect(host._participants.get(hostId)).toBeDefined();

    host._kickForMaxLatency(hostId);
    expect(host._participants.get(hostId)).toBeDefined();

    // idle-кик: оба просрочили порог игрока, кикнут только гость
    joinTeam(host, hostId, 'team1');
    joinTeam(host, guestId, 'team2');

    const past = Date.now() - 10 ** 9;
    host._participants.get(hostId).lastActionTime = past;
    host._participants.get(guestId).lastActionTime = past;

    host._kickIdleUsers();

    expect(host._participants.get(hostId)).toBeDefined();
    expect(host._participants.get(guestId)).toBeUndefined();
  });

  it('updateMaps добавляет карту, доступную следующей сменой', async () => {
    const gameId = await connectPlayer(host, { socketId: 's1' });
    const donor = host._maps[host._roundManager.currentMap];

    host.updateMaps({ custom: structuredClone(donor) });

    expect(host._mapList).toContain('custom');

    // единственный человек → немедленный forceChangeMap на новую карту
    host.parseVote(gameId, ['mapChange', 'custom']);
    tick(host, 2);

    expect(host._roundManager.currentMap).toBe('custom');
    expect(core.map_info()).not.toBe('null');
  });

  it('onMapChange вызывается при смене карты', async () => {
    const onMapChange = vi.fn();

    ({ host, socket, core } = await createHost({ opts: { onMapChange } }));

    const gameId = await connectPlayer(host, { socketId: 's1' });
    const nextMap = host._mapList.find(
      map => map !== host._roundManager.currentMap,
    );

    // единственный человек → немедленный forceChangeMap
    host.parseVote(gameId, ['mapChange', nextMap]);
    tick(host, 8);

    expect(onMapChange).toHaveBeenCalledWith(nextMap);
  });
});
