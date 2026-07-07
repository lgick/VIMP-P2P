import { vi } from 'vitest';
import { FakeSocketManager, loadConfig } from '../server/integration/harness.js';
import { coreAvailable, makeCore } from '../core/helpers.js';

// Каркас интеграционных тестов host-фасада (Этап 4). Как серверный
// harness.js, но строит HostGame поверх реального Rust-ядра (pkg-node) —
// сквозное покрытие core-driven пути (GameCoreAdapter → panel/reportKill,
// pack_body/pack_frame через реальный unpackFrame в FakeSocketManager).
// Пропускается, если core/pkg-node не собран (см. npm run core:build).

export { FakeSocketManager, coreAvailable };

// Создаёт свежий HostGame с реальными мета-модулями, реальным ядром и
// фейковым SocketManager. Fake timers включаются ДО конструктора (тот
// стартует игровой цикл/таймеры). Ядро использует детерминированный seed.
export const createHost = async ({ seed = 42 } = {}) => {
  vi.useFakeTimers();

  const config = await loadConfig();
  const HostGame = (await import('../../src/host/HostGame.js')).default;
  const core = makeCore({ seed });
  const socket = new FakeSocketManager();
  const host = new HostGame(config.get('game'), socket, core);

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
