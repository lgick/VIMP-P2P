import { vi } from 'vitest';
import {
  coreAvailable,
  makeCore,
  makeClientCore,
  decodeFrame,
} from '../core/helpers.js';

// Каркас интеграционных тестов host-фасада: строит HostGame поверх
// реального Rust-ядра (pkg-node) — сквозное покрытие core-driven пути
// (GameCoreAdapter → panel/reportKill, pack_body/pack_frame; бинарные
// кадры декодирует клиентское ядро — ClientCore.decode_frame, срез 2.6).
// Пропускается, если games/tanks/core/pkg-node не собран (см. npm run core:build).
//
// Все игровые модули — синглтоны, поэтому тест-файлы обязаны изолироваться
// через vi.resetModules() в beforeEach и импортировать всё ДИНАМИЧЕСКИ
// внутри теста (не статическим top-level import).

export { coreAvailable };

// распаковка бинарного кадра клиентским ядром (лениво: без pkg-node
// тесты скипаются до первого вызова)
let frameDecoder = null;

export const decodeShot = buffer =>
  decodeFrame((frameDecoder ??= makeClientCore()), buffer);

// Загружает реальные конфиги в свежий синглтон config (зеркало init
// host.worker.js). Должна вызываться после vi.resetModules().
export const loadConfig = async () => {
  const config = (await import('../../packages/engine/src/lib/config.js')).default;

  config.set('auth', (await import('@vimp/tanks/config/auth.js')).default);
  config.set('wsports', (await import('../../packages/engine/src/config/wsports.js')).default);

  // merge движок+игра — зеркало applyRoomOverrides из host.worker.js
  const hostDefaults = (await import('../../packages/engine/src/config/hostDefaults.js'))
    .default;
  const tanksGameConfig = (await import('@vimp/tanks/config/game.js')).default;

  config.set('game', { ...hostDefaults, ...tanksGameConfig });

  config.set('game:isDevMode', true);

  // кадр на каждом тике: тесты двигают цикл tick(host, 1) и ждут снапшот
  config.set('game:timers:networkSendRate', 1);

  return config;
};

// Перечень всех отправителей SocketManager, которые дёргает host-фасад.
const SENDER_METHODS = [
  'sendConfig',
  'sendAuthData',
  'sendAuthResult',
  'sendPing',
  'sendClear',
  'sendTechInform',
  'sendMap',
  'sendFirstShot',
  'sendFirstVote',
  'sendShot',
  'sendPanel',
  'sendStat',
  'sendChat',
  'sendVote',
  'sendKeySet',
  'sendPlayerDefaultShot',
  'sendSpectatorDefaultShot',
  'sendGameInform',
  'sendRoundEnd',
  'sendSoundCue',
  'sendName',
];

// Фейковый SocketManager: вместо отправки в сеть пишет все исходящие кадры.
export class FakeSocketManager {
  constructor() {
    this.frames = []; // [{ method, socketId, args }]
    this._game = null;
    this._panel = null;
    this._stat = null;

    for (const method of SENDER_METHODS) {
      this[method] = (socketId, ...args) => {
        this.frames.push({ method, socketId, args });
      };
    }
  }

  injectServices(game, panel, stat) {
    this._game = game;
    this._panel = panel;
    this._stat = stat;
  }

  addUser() {}
  removeUser() {}

  close(socketId, code, key, arr) {
    this.frames.push({ method: 'close', socketId, args: [code, key, arr] });
  }

  // все кадры указанного метода
  framesOf(method) {
    return this.frames.filter(f => f.method === method);
  }

  // последний sendShot для конкретного сокета; бинарный кадр декодируется
  // клиентским ядром в прежнюю форму [snapshot, camera, serverTime, seq]
  lastShot(socketId) {
    const shots = this.frames.filter(
      f => f.method === 'sendShot' && f.socketId === socketId,
    );

    if (!shots.length) {
      return null;
    }

    const frame = decodeShot(shots[shots.length - 1].args[0]);

    return [frame.snapshot, frame.camera, frame.serverTime, frame.seq];
  }

  // последний sendShot целиком (включая player-блок предикшена)
  lastFrame(socketId) {
    const shots = this.frames.filter(
      f => f.method === 'sendShot' && f.socketId === socketId,
    );

    return shots.length
      ? decodeShot(shots[shots.length - 1].args[0])
      : null;
  }

  clear() {
    this.frames.length = 0;
  }
}

// Создаёт свежий HostGame с реальными мета-модулями, реальным ядром и
// фейковым SocketManager. Fake timers включаются ДО конструктора (тот
// стартует игровой цикл/таймеры). Ядро использует детерминированный seed.
// game — поверхностные оверрайды конфига игры (например { maxPlayers: 2 }),
// opts — опции HostGame ({ hostSocketId, onMapChange }).
export const createHost = async ({ seed = 42, game = {}, opts = {} } = {}) => {
  vi.useFakeTimers();

  const config = await loadConfig();
  const HostGame = (await import('../../packages/engine/src/host/HostGame.js')).default;
  const core = makeCore({ seed });
  const socket = new FakeSocketManager();
  const gameConfig = { ...config.get('game'), ...game };
  const host = new HostGame(gameConfig, socket, core, opts);

  return { host, socket, core, config };
};

// Ждёт микрозадачу (HostGame.createUser отвечает через queueMicrotask;
// fake timers её не подделывают).
export const flushMicro = () =>
  new Promise(resolve => queueMicrotask(resolve));

// Полный онбординг игрока до isReady=true. Возвращает gameId.
export const connectPlayer = async (
  host,
  { name = 'P1', model = 'm1', socketId = 's1' } = {},
) => {
  let gameId;

  host.createUser({ name, model }, socketId, id => {
    gameId = id;
  });

  await flushMicro();

  host.sendMap(gameId);
  host.mapReady(gameId);
  host.firstShotReady(gameId);

  return gameId;
};

// Игрок выбирает команду (становится активным).
export const joinTeam = (host, gameId, team = 'team1') => {
  host.parseVote(gameId, ['teamChange', team]);
};

// Прогоняет n тиков игрового цикла с фиксированным dt.
export const tick = (host, n = 1, dt = 1 / 120) => {
  for (let i = 0; i < n; i += 1) {
    host._onShotTick(dt);
  }
};

// Нажатие/отпускание клавиши игрока (формат wire: 'seq:down:forward').
let inputSeq = 0;

export const pressKey = (host, gameId, name, action = 'down') => {
  inputSeq += 1;
  host.updateKeys(gameId, `${inputSeq}:${action}:${name}`);
};
