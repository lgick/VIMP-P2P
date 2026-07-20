import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  coreAvailable,
  createHost,
  decodeShot,
  connectPlayer,
  joinTeam,
  tick,
  pressKey,
} from './harness.js';

// Интеграция host-фасада поверх реального Rust-ядра (pkg-node): полный
// core-driven путь — онбординг, активный игрок, движение, стрельба, боты,
// проекция событий ядра в мету. Бинарные кадры декодирует клиентское
// ядро (ClientCore.decode_frame). Пропуск без собранного ядра.

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
      .map(f => decodeShot(f.args[0]))
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

    const bots = host._scripted.getBots();

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
      .map(f => decodeShot(f.args[0]))
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
    host._scripted.createScripted(2, 'team1');
    expect(host.isFull).toBe(false);

    // подключение человека вытесняет бота (суммарный лимит был выбран)
    const botsBefore = host._scripted.getCount();

    await connectPlayer(host, { name: 'P2', socketId: 's2' });

    expect(host._scripted.getCount()).toBe(botsBefore - 1);
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

// Эстафета Worker'ов (Этап 5.2): мягкий перенос комнаты в новый Worker на
// границе раунда — без дампа ядра (мир пересоздаётся стартом раунда),
// переносится JS-мета: участники, боты, счёт, карта с остатком, seq кадров.
// Д4.1: гонка «кик → в полёте ещё сообщения клиента до disconnect» — методы
// с participants.get(gameId) не должны кидать TypeError на чужом gameId
describe.skipIf(!coreAvailable)('HostGame: null-guard\'ы (Д4.1)', () => {
  let host;

  beforeEach(async () => {
    ({ host } = await createHost());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it('методы с несуществующим gameId не кидают', () => {
    expect(() => host.updateKeys('999', '1:down:forward')).not.toThrow();
    expect(() => host.pushMessage('999', 'hello')).not.toThrow();
    expect(() => host.parseVote('999', 'teams')).not.toThrow();
    expect(() => host.mapReady('999')).not.toThrow();
    expect(() => host.firstShotReady('999')).not.toThrow();
  });
});

describe.skipIf(!coreAvailable)('HostGame: эстафета Worker\'ов (5.2)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  // комната с двумя игроками, ботом и незавершившим хендшейк гостем;
  // возвращает собранную handoff-мету и данные старого хоста
  const collectHandoffFixture = async () => {
    const { host, socket, core } = await createHost();

    const p1 = await connectPlayer(host, { name: 'P1', socketId: 's1' });
    const p2 = await connectPlayer(host, { name: 'P2', socketId: 's2' });

    joinTeam(host, p1, 'team1');
    joinTeam(host, p2, 'team2');

    // гость, не завершивший хендшейк (isReady=false) — не переносится
    let p3;

    host.createUser({ name: 'P3', model: 'm1' }, 's3', id => {
      p3 = id;
    });
    await new Promise(resolve => queueMicrotask(resolve));

    host._scripted.createScripted(1, 'team2');
    tick(host, 4);

    // заметный счёт — должен пережить эстафету
    host._stat.updateUser(p1, host._participants.get(p1).teamId, { score: 7 });

    let meta = null;

    host.requestHandoff(m => {
      meta = m;
    });

    // граница раунда — единая воронка initiateNewRound
    host._roundManager.initiateNewRound();

    return { host, socket, core, meta, p1, p2, p3 };
  };

  it('requestHandoff отдаёт мету на границе раунда и останавливает игру', async () => {
    const { host, meta, p1, p2, p3 } = await collectHandoffFixture();

    expect(meta).not.toBeNull();
    expect(meta.version).toBe(3);
    expect(meta.gameId).toBe('tanks');
    expect(meta.seq).toBe(host._seq);
    expect(meta.currentMap).toBe(host._roundManager.currentMap);
    expect(meta.mapTimeLeft).toBeGreaterThan(0);

    // переносятся только завершившие хендшейк люди и боты
    const socketIds = meta.humans.map(h => h.socketId).sort();

    expect(socketIds).toEqual(['s1', 's2']);
    expect(meta.humans.map(h => h.gameId).sort()).toEqual([p1, p2].sort());
    expect(meta.humans.find(h => h.gameId === p3)).toBeUndefined();
    expect(meta.scripted).toHaveLength(1);

    // игра остановлена: цикл, раунд, карта, idle
    expect(host._timerManager._hasTimer('gameLoop')).toBe(false);
    expect(host._timerManager._hasTimer('round')).toBe(false);
    expect(host._timerManager._hasTimer('map')).toBe(false);
    expect(host._timerManager._hasTimer('idleCheck')).toBe(false);
  });

  it('resumeAfterHandoff возвращает старый Worker к жизни', async () => {
    const { host, socket } = await collectHandoffFixture();

    socket.clear();
    host.resumeAfterHandoff();

    expect(host._timerManager._hasTimer('gameLoop')).toBe(true);
    expect(host._timerManager._hasTimer('round')).toBe(true);
    expect(host._timerManager._hasTimer('map')).toBe(true);
    expect(host._timerManager._hasTimer('idleCheck')).toBe(true);

    // прерванный раунд перезапущен
    const roundStarts = socket
      .framesOf('sendGameInform')
      .filter(f => f.args[0] === 'roundStart');

    expect(roundStarts.length).toBeGreaterThan(0);
  });

  it('новый HostGame восстанавливает участников, счёт и seq из меты', async () => {
    const old = await collectHandoffFixture();
    const meta = structuredClone(old.meta); // как postMessage

    vi.resetModules(); // «новый Worker»: свежие синглтоны меты

    const { host, socket, core } = await createHost({
      opts: { handoff: meta },
    });

    // участники с исходными id/именами/командами, хендшейк не повторяется
    const p1 = host._participants.get(old.p1);
    const p2 = host._participants.get(old.p2);

    expect(p1).toMatchObject({ name: 'P1', socketId: 's1', isReady: true });
    expect(p2).toMatchObject({ name: 'P2', socketId: 's2', isReady: true });
    expect(p1.team).toBe('team1');
    expect(host._participants.getScripted()).toHaveLength(1);

    // не завершивший хендшейк гость не восстановлен, его строка stat вычищена
    expect(host._participants.get(old.p3)).toBeUndefined();

    const statRows = host._stat.getFull()[0].map(row => row[0]);

    expect(statRows).not.toContain(old.p3);

    // счёт пережил эстафету
    const p1Row = host._stat.getFull()[0].find(row => row[0] === old.p1);

    expect(p1Row[2]).toContain(7);

    // seq продолжен, мир ядра ещё не собран (соберёт completeHandoff)
    expect(host._seq).toBe(meta.seq);
    expect(core.map_info()).toBe('null');
    expect(socket.framesOf('sendMap')).toHaveLength(0);

    // новые подключения получают свободный id (занятые учтены)
    const freshId = host._participants.createHuman(
      { name: 'N', model: 'm1' },
      's9',
    );

    expect([old.p1, old.p2].includes(freshId)).toBe(false);
  });

  it('completeHandoff кикает не переподключившихся и стартует раунд', async () => {
    const old = await collectHandoffFixture();
    const meta = structuredClone(old.meta);
    const botId = meta.scripted[0].gameId;

    vi.resetModules();

    const { host, socket, core } = await createHost({
      opts: { handoff: meta },
    });

    // s2 не переподключился за паузу эстафеты
    host.completeHandoff(new Set(['s1']));

    expect(host._participants.get(old.p2)).toBeUndefined();
    expect(host._participants.get(old.p1)).toBeDefined();

    // мир собран, раунд стартовал: танк игрока и бота живы, кадры идут
    expect(core.map_info()).not.toBe('null');
    expect(core.is_alive(old.p1)).toBe(true);
    expect(core.is_alive(botId)).toBe(true);
    expect(host._timerManager._hasTimer('gameLoop')).toBe(true);

    // карта продолжается с остатком времени, не заново
    expect(host._timerManager.getMapTimeLeft()).toBeLessThanOrEqual(
      meta.mapTimeLeft,
    );

    socket.clear();
    tick(host, 2);

    const frame = socket.lastShot('s1');

    expect(frame).not.toBeNull();
    // seq кадров продолжает нумерацию старого Worker'а
    expect(frame[3]).toBeGreaterThan(meta.seq);
  });

  it('несовместимая версия меты валит init (главный поток вернёт старый Worker)', async () => {
    const old = await collectHandoffFixture();
    const meta = structuredClone(old.meta);

    meta.version = 999;
    vi.resetModules();

    await expect(createHost({ opts: { handoff: meta } })).rejects.toThrow(
      /handoff version/,
    );
  });

  it('чужой gameId в мете валит init (главный поток вернёт старый Worker)', async () => {
    const old = await collectHandoffFixture();
    const meta = structuredClone(old.meta);

    meta.gameId = 'other-game';
    vi.resetModules();

    await expect(createHost({ opts: { handoff: meta } })).rejects.toThrow(
      /game mismatch/,
    );
  });

  it('карта, ушедшая из каталога, валит init с внятной ошибкой', async () => {
    const old = await collectHandoffFixture();
    const meta = structuredClone(old.meta);

    meta.currentMap = 'ghost-map';
    vi.resetModules();

    await expect(createHost({ opts: { handoff: meta } })).rejects.toThrow(
      /missing from catalog/,
    );
  });
});
