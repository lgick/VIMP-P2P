// Разметка бинарного snapshot-протокола (порт SHOT_DATA).
// Единый источник для хоста (упаковка) и клиента (распаковка) — обе стороны
// живут в Rust-ядре: core/src/snapshot.rs (pack) и core/src/client/unpack.rs.

// версия формата кадра: первый байт после порта;
// увеличивать при любом изменении байтовой раскладки в ядре
// v2: per-user player-блок (gameId, inputSeq, состояние своего танка) — Фаза 5b
// v3: id автора в событиях оружия (tracers +shooterId, bombs +ownerId) — Фаза 5c
export const SNAPSHOT_FORMAT_VERSION = 3;

// реестр ключей снапшота: строковый ключ → числовой id + тип блока (kind);
// kind определяет байтовую раскладку блока в core/src/snapshot.rs;
// новое оружие/карта обязаны быть зарегистрированы здесь
export const SNAPSHOT_KEYS = {
  m1: { id: 1, kind: 'tanks' },
  w1: { id: 2, kind: 'tracers' },
  w2: { id: 3, kind: 'bombs' },
  w2e: { id: 4, kind: 'explosions' },
  c1: { id: 5, kind: 'dynamics' },
  c2: { id: 6, kind: 'dynamics' },
};

// обратный индекс: id → { key, kind }
export const SNAPSHOT_KEYS_BY_ID = Object.fromEntries(
  Object.entries(SNAPSHOT_KEYS).map(([key, { id, kind }]) => [
    id,
    { key, kind },
  ]),
);

// флаги hot-буфера рендер-тика клиентского ядра
// (зеркало core/src/client/mod.rs)
export const HOT_FLAGS = {
  GAME: 1,
  CAMERA: 2,
  PREDICTED: 4,
  FRAMES: 8,
};
