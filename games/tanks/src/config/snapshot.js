// Снапшот-схема игры (HostPlugin.gameConfig.snapshot): реестр ключей —
// строковый ключ → числовой id + форма блока (kind — ширина count/id,
// наличие null-маркера) + класс (class: 'hot' — интерполируется клиентом
// между кадрами, 'event' — одноразовый, кадром как есть) + схема полей
// строки (fields: порядок байтов в раскладке). Движок читает её из
// gameConfig (lib/coreConfig.js) и шлёт клиенту в CONFIG_DATA
// (lib/buildClientConfig.js) — сам движок раскладку не знает.
// Новое оружие/карта обязаны быть зарегистрированы здесь.
// ВНИМАНИЕ: порядок и interp полей позиционно привязаны к Row-структурам
// packages/engine/core/src/snapshot.rs — interpolator.rs читает interp по
// индексу поля (schema.fields[i]), не по имени. Переставлять поля местами
// или менять interp без синхронной правки Rust-структур нельзя: validate()
// проверяет только количество и тип полей, не interp и не порядок по смыслу.
export default {
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
