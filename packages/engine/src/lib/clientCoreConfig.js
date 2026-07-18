import {
  SNAPSHOT_FORMAT_VERSION,
  SNAPSHOT_KEYS,
} from '../config/opcodes.js';
import wsports from '../config/wsports.js';

// Сборка JSON-конфига клиентского ядра (ClientCore, срез 2.6): данные
// prediction/interpolation из CONFIG_DATA хоста + бандловый реестр
// снапшот-ключей. Отдельный модуль (не coreConfig.js): тот тянет
// game.js/models.js/weapons.js, которым не место в клиентском бандле —
// клиент получает параметры по порту 0.

/**
 * Собирает объект конфигурации клиентского ядра.
 * @param {Object} options
 * @param {Object} options.prediction - Секция prediction CONFIG_DATA
 *   (timeStep в мс, playerKeys, models, weapons).
 * @param {Object} options.interpolation - Секция interpolation CONFIG_DATA
 *   (delay, maxFrameAge в мс).
 * @param {Object} [overrides] - Переопределения (например, seed
 *   для воспроизводимых прогонов).
 * @returns {Object} Конфиг для `new ClientCore(JSON.stringify(config))`.
 */
export const buildClientCoreConfig = (
  { prediction, interpolation },
  overrides = {},
) => ({
  // имя поля фиксирует единицы: prediction.timeStep приходит в мс
  timeStepMs: prediction.timeStep,
  playerKeys: prediction.playerKeys,
  models: prediction.models,
  weapons: prediction.weapons,
  snapshot: {
    version: SNAPSHOT_FORMAT_VERSION,
    port: wsports.server.SHOT_DATA,
    keys: SNAPSHOT_KEYS,
  },
  interpolation,
  ...overrides,
});
