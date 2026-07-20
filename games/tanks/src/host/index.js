import { ENGINE_API_VERSION } from '@vimp/engine/config/opcodes.js';
import init, { GameCore } from '../../core/pkg-web/vimp_tanks_core.js';
import gameConfig from '../config/game.js';
import clientConfig from '../config/client.js';
import authSchema from '../config/auth.js';
import botCommand from './botCommand.js';
import systemMessages from './systemMessages.js';
import createModules from './createModules.js';

// HostPlugin танков (Worker-safe): вся игровая половина хоста одним объектом.
// default export host-entry игры (games/tanks/vite.config.js --mode host,
// Этап 6.1); host.worker.js грузит его динамически по entries.host
// GameManifest (Этап 6.4). Танки не используют 'custom'-события ядра —
// onCoreEvent не задан, движок роутит стандартный словарь
// (panelSet/panelActive/death/shake) сам.
export default {
  id: 'tanks',
  engineApi: ENGINE_API_VERSION,

  // wasmUrl — из GameManifest.entries.wasm (мастер, Этап 6.2); init() грузит
  // по явному url, а не через import.meta.url-резолюцию глюe-модуля
  // (риск #3 PLAN.md — важно для рабочего Worker'а)
  async createCore(coreConfigJson, { wasmUrl }) {
    await init(wasmUrl);

    return new GameCore(coreConfigJson);
  },

  gameConfig,
  authSchema,
  chatCommands: [botCommand],
  systemMessages,
  createModules,
  buildClientGameConfig: () => clientConfig,
};
