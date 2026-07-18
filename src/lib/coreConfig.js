import {
  SNAPSHOT_FORMAT_VERSION,
  SNAPSHOT_KEYS,
} from '../config/opcodes.js';
import models from '@vimp/tanks/data/models.js';
import weapons from '@vimp/tanks/data/weapons.js';
import tanksGameConfig from '@vimp/tanks/config/game.js';
import hostDefaults from '../config/hostDefaults.js';
import wsports from '../config/wsports.js';

// Сборка JSON-конфига Rust-ядра (core/): движковый timeStep + игровой конфиг
// и данные баланса + реестр снапшот-ключей. Единственная точка соответствия
// JS-конфигов и ABI ядра (см. docs/core.md).

/**
 * Собирает объект конфигурации ядра.
 * @param {Object} [overrides] - Переопределения (например, seed
 *   для воспроизводимых прогонов или friendlyFire).
 * @returns {Object} Конфиг для `new GameCore(JSON.stringify(config))`.
 */
export const buildCoreConfig = (overrides = {}) => ({
  timeStep: hostDefaults.timers.timeStep / 1000,
  friendlyFire: tanksGameConfig.parts.friendlyFire,
  mapScale: tanksGameConfig.mapScale,
  mapSetId: tanksGameConfig.mapSetId,
  models,
  weapons,
  playerKeys: tanksGameConfig.playerKeys,
  panel: tanksGameConfig.panel.fields,
  snapshot: {
    version: SNAPSHOT_FORMAT_VERSION,
    port: wsports.server.SHOT_DATA,
    keys: SNAPSHOT_KEYS,
  },
  ...overrides,
});
