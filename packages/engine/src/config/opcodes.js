// Разметка бинарного snapshot-протокола (порт SHOT_DATA).
// Единый источник для хоста (упаковка) и клиента (распаковка) — обе стороны
// живут в Rust-ядре: packages/engine/core/src/snapshot.rs (pack) и packages/engine/core/src/client/unpack.rs.

// версия контракта движок ↔ игра-плагин (GameManifest, HostPlugin,
// ClientPlugin, Wasm Host ABI — docs/{en,ru}/plugin-api.md);
// проверяется при загрузке плагинов; ломающие изменения контрактов → +1.
// Пока номинальная: код движка и игры ещё монолитен (см. PLAN.md)
export const ENGINE_API_VERSION = 1;

// версия формата кадра: первый байт после порта;
// увеличивать при любом изменении байтовой раскладки в ядре
// v2: per-user player-блок (gameId, inputSeq, состояние своего танка) — Фаза 5b
// v3: id автора в событиях оружия (tracers +shooterId, bombs +ownerId) — Фаза 5c
export const SNAPSHOT_FORMAT_VERSION = 3;

// реестр ключей снапшота: строковый ключ → числовой id + форма блока
// (kind — ширина count/id, наличие null-маркера) + класс (class: 'hot' —
// интерполируется клиентом между кадрами, 'event' — одноразовый, кадром
// как есть) + схема полей строки (fields: порядок байтов в раскладке;
// порядок должен совпадать с полями Row-структуры packages/engine/core/src/snapshot.rs —
// интерпретаторы в packages/engine/core/src/snapshot.rs (pack) и packages/engine/core/src/client/unpack.rs
// + interpolator.rs (lerp/lerpAngle только для class:'hot') читают эту
// схему, а не хардкодят раскладку по каждому kind).
// Новое оружие/карта обязаны быть зарегистрированы здесь.
// ВНИМАНИЕ: порядок и interp полей позиционно привязаны к Row-структурам
// packages/engine/core/src/snapshot.rs — interpolator.rs читает interp по индексу поля
// (schema.fields[i]), не по имени. Переставлять поля местами или менять
// interp без синхронной правки Rust-структур нельзя: validate() проверяет
// только количество и тип полей, не interp и не порядок по смыслу.
export const SNAPSHOT_KEYS = {
  m1: {
    id: 1,
    kind: 'indexed8',
    class: 'hot',
    fields: [
      { name: 'x', ty: 'f32', interp: 'lerp' },
      { name: 'y', ty: 'f32', interp: 'lerp' },
      { name: 'angle', ty: 'f32', interp: 'lerpAngle' },
      { name: 'gunRotation', ty: 'f32', interp: 'lerpAngle' },
      { name: 'vx', ty: 'f32', interp: 'lerp' },
      { name: 'vy', ty: 'f32', interp: 'lerp' },
      { name: 'engineLoad', ty: 'f32', interp: 'lerp' },
      { name: 'condition', ty: 'u8' },
      { name: 'size', ty: 'u8' },
      { name: 'team', ty: 'u8' },
    ],
  },
  w1: {
    id: 2,
    kind: 'list16',
    class: 'event',
    fields: [
      { name: 'startX', ty: 'f32' },
      { name: 'startY', ty: 'f32' },
      { name: 'endX', ty: 'f32' },
      { name: 'endY', ty: 'f32' },
      { name: 'bodyX', ty: 'f32' },
      { name: 'bodyY', ty: 'f32' },
      { name: 'wasHit', ty: 'u8' },
      { name: 'shooterId', ty: 'u8' },
    ],
  },
  w2: {
    id: 3,
    kind: 'indexed32',
    class: 'event',
    fields: [
      { name: 'x', ty: 'f32' },
      { name: 'y', ty: 'f32' },
      { name: 'angle', ty: 'f32' },
      { name: 'size', ty: 'u8' },
      { name: 'time', ty: 'u16' },
      { name: 'ownerId', ty: 'u8' },
    ],
  },
  w2e: {
    id: 4,
    kind: 'list16',
    class: 'event',
    fields: [
      { name: 'x', ty: 'f32' },
      { name: 'y', ty: 'f32' },
      { name: 'radius', ty: 'f32' },
    ],
  },
  c1: {
    id: 5,
    kind: 'indexedNoNull8',
    class: 'hot',
    fields: [
      { name: 'x', ty: 'f32', interp: 'lerp' },
      { name: 'y', ty: 'f32', interp: 'lerp' },
      { name: 'angle', ty: 'f32', interp: 'lerpAngle' },
    ],
  },
  c2: {
    id: 6,
    kind: 'indexedNoNull8',
    class: 'hot',
    fields: [
      { name: 'x', ty: 'f32', interp: 'lerp' },
      { name: 'y', ty: 'f32', interp: 'lerp' },
      { name: 'angle', ty: 'f32', interp: 'lerpAngle' },
    ],
  },
};

// обратный индекс: id → { key, kind }
export const SNAPSHOT_KEYS_BY_ID = Object.fromEntries(
  Object.entries(SNAPSHOT_KEYS).map(([key, { id, kind }]) => [
    id,
    { key, kind },
  ]),
);

// флаги hot-буфера рендер-тика клиентского ядра
// (зеркало games/tanks/core/src/client/mod.rs)
export const HOT_FLAGS = {
  GAME: 1,
  CAMERA: 2,
  PREDICTED: 4,
  FRAMES: 8,
};
