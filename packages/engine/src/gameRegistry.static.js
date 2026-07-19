// Временная статическая композиция движок+игра (этап 5 плана отделения) —
// ЕДИНСТВЕННОЕ место в движке, которому разрешено импортировать @vimp/tanks
// (ESLint no-restricted-imports); удаляется в этапе 6 (динамическая загрузка
// игры по GameManifest мастера).
//
// hostPlugin и данные игры Node/Worker-safe и экспортируются статически;
// ClientPlugin тянет pixi/CSS (браузерный код) — только динамический импорт,
// чтобы мастер (Node) и Worker хоста не тащили клиентский бандл игры.

export { default as hostPlugin } from '@vimp/tanks/host/index.js';
export { default as gameMaps } from '@vimp/tanks/data/maps/index.js';
export { default as authSchema } from '@vimp/tanks/config/auth.js';

// wasm-pack glue игры: Worker-safe (GameCore) — статический экспорт, хост
// крутит его в Worker'е наравне с hostPlugin. ClientCore тянет браузерный
// wasm-бандл — только динамический импорт, чтобы Node/Worker хоста не
// тащили клиентский код.
export {
  default as initGameCore,
  GameCore,
} from '../../../games/tanks/core/pkg-web/vimp_tanks_core.js';

export const loadClientCore = async () =>
  import('../../../games/tanks/core/pkg-web/vimp_tanks_core.js');

export const loadClientPlugin = async () =>
  (await import('@vimp/tanks/client/index.js')).default;
