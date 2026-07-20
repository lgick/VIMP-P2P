import { vi } from 'vitest';

// Каркас движковых тестов host-фасада поверх фикстурной миниигры
// (Этап 7 плана отделения движка, PLAN.md: «Тесты движковой меты/HostGame
// переводятся на фикстуру») — доказывает, что HostGame и мета не
// завязаны на @vimp/tanks: fake-core (JS, без WASM), поэтому не требует
// собранного Rust-ядра игры и запускается всегда (engine-node, без гейта).
//
// Онбординг/тики/нажатия клавиш — общие с интеграционным харнессом
// (./harness.js): они не завязаны на конкретное ядро.
export {
  FakeSocketManager,
  flushMicro,
  connectPlayer,
  joinTeam,
  tick,
  pressKey,
} from './harness.js';

import { FakeSocketManager } from './harness.js';

// Загружает конфиг фикстуры в свежий синглтон config (зеркало loadConfig
// из ./harness.js, но с миниигрой вместо @vimp/tanks).
export const loadFixtureConfig = async () => {
  const config = (await import('../../packages/engine/src/lib/config.js'))
    .default;

  config.set(
    'auth',
    (await import('../../packages/engine/tests/fixtures/miniGame/config/auth.js'))
      .default,
  );
  config.set(
    'wsports',
    (await import('../../packages/engine/src/config/wsports.js')).default,
  );

  const hostDefaults = (
    await import('../../packages/engine/src/config/hostDefaults.js')
  ).default;
  const miniGameConfig = (
    await import('../../packages/engine/tests/fixtures/miniGame/config/game.js')
  ).default;

  config.set('game', { ...hostDefaults, ...miniGameConfig });
  config.set('game:isDevMode', true);
  config.set('game:timers:networkSendRate', 1);

  return config;
};

// Создаёт свежий HostGame поверх fake-core миниигры-фикстуры и реальных
// (движковых) мета-модулей.
export const createFixtureHost = async ({ seed = 42, game = {}, opts = {} } = {}) => {
  vi.useFakeTimers();

  const config = await loadFixtureConfig();
  const HostGame = (await import('../../packages/engine/src/host/HostGame.js'))
    .default;
  const hostPlugin = (
    await import('../../packages/engine/tests/fixtures/miniGame/host/index.js')
  ).default;
  const core = await hostPlugin.createCore(JSON.stringify({ seed }));
  const socket = new FakeSocketManager();
  const gameConfig = { ...config.get('game'), ...game };
  const host = new HostGame(gameConfig, socket, core, hostPlugin, opts);

  return { host, socket, core, config, hostPlugin };
};
