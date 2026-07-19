import {
  SNAPSHOT_FORMAT_VERSION,
  SNAPSHOT_KEYS,
} from '../config/opcodes.js';
// временная статическая композиция движок+игра (до этапа 6 —
// createCore/buildCoreGameConfig у HostPlugin)
import { hostPlugin } from '../gameRegistry.static.js';
import hostDefaults from '../config/hostDefaults.js';
import wsports from '../config/wsports.js';

const tanksGameConfig = hostPlugin.gameConfig;
const { models, weapons } = tanksGameConfig.parts;

// Сборка JSON-конфига Rust-ядра (packages/engine/core + games/tanks/core):
// движковая половина (timeStep/mapScale/mapSetId/snapshot/seed) + игровая
// (models/weapons/playerKeys/panel/friendlyFire) — форма {engine, game} из
// PLAN.md §3.4. Единственная точка соответствия JS-конфигов и ABI ядра
// (см. docs/core.md).

/**
 * Собирает объект конфигурации ядра.
 * @param {Object} [overrides] - Переопределения плоским объектом (например,
 *   seed для воспроизводимых прогонов или friendlyFire) — распределяются
 *   по движковой/игровой половине автоматически.
 * @returns {Object} Конфиг для `new GameCore(JSON.stringify(config))`.
 */
export const buildCoreConfig = (overrides = {}) => {
  const flat = {
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
    seed: undefined,
    ...overrides,
  };

  return {
    engine: {
      timeStep: flat.timeStep,
      mapScale: flat.mapScale,
      mapSetId: flat.mapSetId,
      snapshot: flat.snapshot,
      seed: flat.seed,
    },
    game: {
      friendlyFire: flat.friendlyFire,
      models: flat.models,
      weapons: flat.weapons,
      playerKeys: flat.playerKeys,
      panel: flat.panel,
    },
  };
};
