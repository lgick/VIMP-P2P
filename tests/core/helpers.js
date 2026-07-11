import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import clientConfig from '../../src/config/client.js';
import gameConfig from '../../src/config/game.js';
import models from '../../src/data/models.js';
import weapons from '../../src/data/weapons.js';
import { buildClientCoreConfig } from '../../src/lib/clientCoreConfig.js';
import { buildCoreConfig } from '../../src/lib/coreConfig.js';

// Хелперы JS↔WASM харнесса ядра. Node-таргет ядра собирается командой
// `npm run core:build` (нужен Rust-тулчейн); без артефакта тесты
// пропускаются, чтобы `npm test` оставался зелёным без Rust.

const pkgUrl = new URL('../../core/pkg-node/vimp_core.js', import.meta.url);

export const coreAvailable = existsSync(pkgUrl);

const loadPkg = () => {
  const require = createRequire(import.meta.url);

  return require('../../core/pkg-node/vimp_core.js');
};

/**
 * Загружает класс ядра из nodejs-сборки (CommonJS).
 * @returns {Function} Конструктор GameCore.
 */
export const loadGameCore = () => loadPkg().GameCore;

/**
 * Создаёт ядро с реальным конфигом проекта и фиксированным сидом.
 * @param {Object} [overrides]
 */
export const makeCore = (overrides = {}) => {
  const GameCore = loadGameCore();

  return new GameCore(JSON.stringify(buildCoreConfig({ seed: 42, ...overrides })));
};

/**
 * Создаёт клиентское ядро (ClientCore) с реальным конфигом проекта
 * (тот же путь сборки, что у клиента: buildClientCoreConfig).
 * @param {Object} [overrides]
 */
export const makeClientCore = (overrides = {}) => {
  const ClientCore = loadPkg().ClientCore;
  const config = buildClientCoreConfig(
    {
      prediction: {
        timeStep: gameConfig.timers.timeStep,
        playerKeys: gameConfig.playerKeys,
        models,
        weapons,
      },
      interpolation: clientConfig.interpolation,
    },
    { seed: 42, ...overrides },
  );

  return new ClientCore(JSON.stringify(config));
};

/**
 * Кадр ядра как ArrayBuffer.
 * @param {Object} core
 * @returns {ArrayBuffer}
 */
export const frameBuffer = core => {
  const bytes = core.frame_bytes();

  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
};

/**
 * Распаковка кадра v3 клиентским ядром — замена unpackFrame
 * (срез 2.6: JS-кодек удалён, декодер живёт в ядре).
 * @param {Object} clientCore
 * @param {ArrayBuffer} buffer
 * @returns {Object|null} Форма unpackFrame: { port, seq, serverTime,
 *   camera, player, snapshot } либо null (чужая версия/повреждён).
 */
export const decodeFrame = (clientCore, buffer) =>
  JSON.parse(clientCore.decode_frame(new Uint8Array(buffer)));

/**
 * Прогоняет ядро на count тиков фикс-шага.
 */
export const stepTicks = (core, count, dt = 1 / 120) => {
  for (let i = 0; i < count; i += 1) {
    core.step(dt);
  }
};

/**
 * События ядра массивом объектов.
 */
export const takeEvents = core => JSON.parse(core.take_events());
