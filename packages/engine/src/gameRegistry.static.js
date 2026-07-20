// Временная статическая композиция движок+игра (этап 5 плана отделения) —
// ЕДИНСТВЕННОЕ место в движке, которому разрешено импортировать @vimp/tanks
// (ESLint no-restricted-imports). Клиентская половина (ClientPlugin, wasm-glue
// клиентского ядра, authSchema) удалена в этапе 6.3 — main.js грузит их
// динамически по GameManifest мастера (packages/engine/src/lib/gamePlugin.js).
// Хостовая половина ниже удалится в этапе 6.4 (host.worker.js).
//
// hostPlugin и данные игры Node/Worker-safe и экспортируются статически.

export { default as hostPlugin } from '@vimp/tanks/host/index.js';
export { default as gameMaps } from '@vimp/tanks/data/maps/index.js';

// wasm-pack glue игры: Worker-safe (GameCore) — статический экспорт, хост
// крутит его в Worker'е наравне с hostPlugin.
export {
  default as initGameCore,
  GameCore,
} from '../../../games/tanks/core/pkg-web/vimp_tanks_core.js';
