import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { buildCoreConfig } from '../../src/lib/coreConfig.js';

// Хелперы JS↔WASM харнесса ядра. Node-таргет ядра собирается командой
// `npm run core:build` (нужен Rust-тулчейн); без артефакта тесты
// пропускаются, чтобы `npm test` оставался зелёным без Rust.

const pkgUrl = new URL('../../core/pkg-node/vimp_core.js', import.meta.url);

export const coreAvailable = existsSync(pkgUrl);

/**
 * Загружает класс ядра из nodejs-сборки (CommonJS).
 * @returns {Function} Конструктор GameCore.
 */
export const loadGameCore = () => {
  const require = createRequire(import.meta.url);

  return require('../../core/pkg-node/vimp_core.js').GameCore;
};

/**
 * Создаёт ядро с реальным конфигом проекта и фиксированным сидом.
 * @param {Object} [overrides]
 */
export const makeCore = (overrides = {}) => {
  const GameCore = loadGameCore();

  return new GameCore(JSON.stringify(buildCoreConfig({ seed: 42, ...overrides })));
};

/**
 * Кадр ядра как ArrayBuffer для unpackFrame.
 * @param {Object} core
 * @returns {ArrayBuffer}
 */
export const frameBuffer = core => {
  const bytes = core.frame_bytes();

  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
};

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
