import {
  SNAPSHOT_FORMAT_VERSION,
  SNAPSHOT_KEYS,
} from '../config/opcodes.js';
import gameConfig from '../config/game.js';
import wsports from '../config/wsports.js';
import models from '../data/models.js';
import weapons from '../data/weapons.js';

// Сборка JSON-конфига Rust-ядра (core/): куски game.js + данные баланса +
// реестр снапшот-ключей. Единственная точка соответствия JS-конфигов и
// ABI ядра (см. docs/core.md).

/**
 * Собирает объект конфигурации ядра.
 * @param {Object} [overrides] - Переопределения (например, seed
 *   для воспроизводимых прогонов или friendlyFire).
 * @returns {Object} Конфиг для `new GameCore(JSON.stringify(config))`.
 */
export const buildCoreConfig = (overrides = {}) => ({
  timeStep: gameConfig.timers.timeStep / 1000,
  friendlyFire: gameConfig.parts.friendlyFire,
  mapScale: gameConfig.mapScale,
  mapSetId: gameConfig.mapSetId,
  models,
  weapons,
  playerKeys: gameConfig.playerKeys,
  panel: gameConfig.panel,
  snapshot: {
    version: SNAPSHOT_FORMAT_VERSION,
    port: wsports.server.SHOT_DATA,
    keys: SNAPSHOT_KEYS,
  },
  ...overrides,
});
