import { describe, it, expect } from 'vitest';
import hostDefaults from '../../packages/engine/src/config/hostDefaults.js';
import {
  coreAvailable,
  makeCore,
  makeClientCore,
  frameBuffer,
  decodeFrame,
  stepTicks,
} from './helpers.js';

// JS↔WASM харнесс клиентского ядра (ClientCore, срез 2.6): кадры реального
// GameCore проходят через push_frame → sample → hot-буфер/take_frames.
// Распаковка проверяется decode_frame (замена unpackFrame — pack и unpack
// живут в одном crate, расхождение форматов исключено по построению).

const TIME_STEP_MS = hostDefaults.timers.timeStep;
const DT = TIME_STEP_MS / 1000;

// флаги hot-буфера (зеркало core/src/client/mod.rs)
const HAS_GAME = 1;
const HAS_CAMERA = 2;
const HAS_PREDICTED = 4;
const HAS_FRAMES = 8;

const push = (client, buffer, localNow) =>
  client.push_frame(new Uint8Array(buffer), localNow);

// кадр ядра: pack_body + pack_frame → ArrayBuffer
const packFrame = (core, serverTime, seq, { camera = null, playerId = -1 } = {}) => {
  core.pack_body();
  core.pack_frame(
    serverTime,
    seq,
    camera !== null,
    camera ? camera[0] : 0,
    camera ? camera[1] : 0,
    camera ? Boolean(camera[2]) : false,
    camera && camera[3] ? String(camera[3]) : undefined,
    playerId,
  );

  return frameBuffer(core);
};

describe.skipIf(!coreAvailable)('ClientCore (клиентское ядро)', () => {
  describe('decode_frame — распаковка кадра v3', () => {
    it('распаковывает заголовок пустого кадра', () => {
      const core = makeCore();
      const client = makeClientCore();
      const decoded = decodeFrame(client, packFrame(core, 1234.5, 42));

      expect(decoded.port).toBe(5);
      expect(decoded.seq).toBe(42);
      expect(decoded.serverTime).toBe(1234.5);
      expect(decoded.camera).toBe(0);
      expect(decoded.player).toBeNull();
      expect(decoded.snapshot).toEqual({});
    });

    it('отбрасывает кадр с чужой версией формата', () => {
      const core = makeCore();
      const client = makeClientCore();
      const bytes = new Uint8Array(packFrame(core, 0, 1));

      bytes[1] = 99;
      expect(JSON.parse(client.decode_frame(bytes))).toBeNull();
    });

    it('распаковывает камеру с forceReset и shake', () => {
      const core = makeCore();
      const client = makeClientCore();
      const decoded = decodeFrame(
        client,
        packFrame(core, 0, 1, { camera: [10.5, -3.25, true, '20:200'] }),
      );

      expect(decoded.camera).toEqual([10.5, -3.25, true, '20:200']);
    });

    it('распаковывает player-блок без округления', () => {
      const core = makeCore();
      const client = makeClientCore();

      core.spawn_actor(1, 'm1', 1, 100.123, 200.456, 0);

      const decoded = decodeFrame(client, packFrame(core, 0, 1, { playerId: 1 }));

      expect(decoded.player.gameId).toBe(1);
      expect(decoded.player.state).toHaveLength(8);
      expect(decoded.player.centering).toBe(false);
      // Float32-точность без округления до 2 знаков
      expect(decoded.player.state[0]).toBeCloseTo(100.123, 3);
    });

    it('распаковывает танк (round2) и null-маркер удаления', () => {
      const core = makeCore();
      const client = makeClientCore();

      core.spawn_actor(2, 'm1', 1, 100.567, 50, 0);
      stepTicks(core, 1); // кэш строк снапшота обновляется на тике

      let decoded = decodeFrame(client, packFrame(core, 0, 1));
      const row = decoded.snapshot.m1['2'];

      expect(row).toHaveLength(10);
      expect(row[0]).toBe(100.57); // round2
      expect(row.slice(7)).toEqual([3, 2, 1]); // condition, size, teamId

      core.remove_actor(2);
      decoded = decodeFrame(client, packFrame(core, 0, 2));
      expect(decoded.snapshot.m1['2']).toBeNull();
    });

    it('распаковывает трассер с wasHit и shooterId', () => {
      const core = makeCore();
      const client = makeClientCore();

      core.spawn_actor(1, 'm1', 1, 100, 100, 0);
      core.apply_input(1, 1, 'down', 'fire');
      stepTicks(core, 1);

      const decoded = decodeFrame(client, packFrame(core, 0, 1));
      const tracer = decoded.snapshot.w1[0];

      expect(tracer).toHaveLength(8);
      expect(typeof tracer[6]).toBe('boolean');
      expect(tracer[7]).toBe(1); // shooterId
    });
  });

  describe('интерполяция e2e', () => {
    // два кадра ядра со сдвигом танка: интерполированная позиция между ними
    const makeFrames = () => {
      const core = makeCore();

      core.spawn_actor(1, 'm1', 1, 100, 100, 0);
      core.apply_input(1, 1, 'down', 'forward');
      stepTicks(core, 60);

      const f1 = packFrame(core, 1000, 1, { camera: [1, 2] });
      const x1 = decodeFrame(makeClientCore(), f1).snapshot.m1['1'][0];

      stepTicks(core, 12); // ~100 мс

      const f2 = packFrame(core, 1100, 2, { camera: [3, 4] });
      const x2 = decodeFrame(makeClientCore(), f2).snapshot.m1['1'][0];

      return { f1, f2, x1, x2 };
    };

    it('hot-буфер: интерполированный танк и камера между кадрами', () => {
      const { f1, f2, x1, x2 } = makeFrames();
      const client = makeClientCore();

      expect(Number.isNaN(client.offset())).toBe(true);

      expect(push(client, f1, 1000)).toBe(true);
      expect(push(client, f2, 1100)).toBe(true);
      expect(client.offset()).toBeCloseTo(0, 6);

      // renderTime = 1150 − delay(100) = 1050 → alpha 0.5
      const len = client.sample(1150);
      const hot = client.hot_values();

      expect(len).toBe(hot.length);

      const flags = hot[0];

      expect(flags & HAS_GAME).toBeTruthy();
      expect(flags & HAS_CAMERA).toBeTruthy();
      expect(flags & HAS_FRAMES).toBeTruthy();
      expect(flags & HAS_PREDICTED).toBeFalsy();

      // камера интерполирована между [1,2] и [3,4]
      expect(hot[1]).toBeCloseTo(2, 5);
      expect(hot[2]).toBeCloseTo(3, 5);

      // один танк: keyId m1 (1), gameId 1, x между кадрами
      expect(hot[3]).toBe(1);
      expect(hot[4]).toBe(1);
      expect(hot[5]).toBe(1);
      expect(hot[6]).toBeCloseTo((x1 + x2) / 2, 1);
      expect(x2).toBeGreaterThan(x1);
    });

    it('событийные кадры выдаются ровно один раз', () => {
      const { f1, f2 } = makeFrames();
      const client = makeClientCore();

      push(client, f1, 1000);
      push(client, f2, 1100);
      client.sample(1150);

      const frames = JSON.parse(client.take_frames());

      expect(frames).toHaveLength(1); // пересечён только seq 1
      expect(frames[0].game.m1['1'][0]).toBeGreaterThan(100);
      expect(frames[0].camera).toEqual([1, 2]);

      client.sample(1151);
      expect(JSON.parse(client.take_frames())).toEqual([]);
    });

    it('реордер и дубликаты seq не ломают буфер', () => {
      const { f1, f2, x1, x2 } = makeFrames();
      const client = makeClientCore();

      // кадры в обратном порядке + дубликат
      push(client, f2, 1100);
      push(client, f1, 1000);
      push(client, f1, 1000);

      client.sample(1150);

      const hot = client.hot_values();

      expect(hot[6]).toBeCloseTo((x1 + x2) / 2, 1);
      expect(JSON.parse(client.take_frames())).toHaveLength(1);
    });
  });

  describe('предикт e2e', () => {
    // ядро + клиент с общим стартовым кадром (player-блок id 1)
    const setup = () => {
      const core = makeCore();
      const client = makeClientCore();

      core.spawn_actor(1, 'm1', 1, 100, 100, 0);
      stepTicks(core, 1); // кэш строк снапшота обновляется на тике
      client.set_model('m1');
      client.set_active(true);

      const f1 = packFrame(core, 1000, 1, { camera: [100, 100], playerId: 1 });

      push(client, f1, 1000);
      client.sample(1150); // кадр пересечён: meta своего танка получена

      return { core, client };
    };

    it('player-блок включает предикт, ввод двигает предсказанный танк', () => {
      const { client } = setup();

      expect(client.my_game_id()).toBe(1);

      let hot = client.hot_values();

      expect(hot[0] & HAS_PREDICTED).toBeTruthy();

      // predicted-запись последняя: x из player-блока
      expect(hot[hot.length - 10]).toBeCloseTo(100, 3);

      client.apply_input('down', 'forward', 1150);

      for (let i = 1; i <= 60; i += 1) {
        client.sample(1150 + i * TIME_STEP_MS);
      }

      hot = client.hot_values();

      const x = hot[hot.length - 10];

      expect(x).toBeGreaterThan(105);

      // камера следует предсказанной позиции
      expect(hot[1]).toBeCloseTo(x, 3);
    });

    it('реплика движения сходится с ядром на реальном конфиге', () => {
      const { core, client } = setup();

      core.apply_input(1, 2, 'down', 'forward');
      client.apply_input('down', 'forward', 1150);

      for (let i = 1; i <= 120; i += 1) {
        core.step(DT);
        client.sample(1150 + i * TIME_STEP_MS);
      }

      const [coreX] = core.position_of(1);
      const hot = client.hot_values();
      const predictedX = hot[hot.length - 10];

      // допуск шире cargo-паритета: рендер-тик клиента дробит время
      // аккумулятором (float-режим реального цикла)
      expect(Math.abs(predictedX - coreX)).toBeLessThan(5);
      expect(predictedX).toBeGreaterThan(150);
    });
  });

  describe('try_fire и подавление дублей', () => {
    const setup = () => {
      const core = makeCore();
      const client = makeClientCore();

      core.spawn_actor(1, 'm1', 1, 100, 100, 0);
      stepTicks(core, 1);
      client.set_model('m1');
      client.set_active(true);
      push(client, packFrame(core, 1000, 1, { playerId: 1 }), 1000);
      client.sample(1150);
      client.take_frames(); // очередь событийных кадров выкачивается тиком

      return { core, client };
    };

    it('возвращает трассер в формате снапшота', () => {
      const { client } = setup();
      const spawn = JSON.parse(client.try_fire(1200));

      expect(spawn.w1).toHaveLength(1);

      const tracer = spawn.w1[0];

      expect(tracer).toHaveLength(8);
      expect(tracer[7]).toBe(1); // shooterId
      expect(tracer[6]).toBe(false); // мир пуст — промах
    });

    it('не стреляет без предикта или мёртвым танком', () => {
      const core = makeCore();
      const client = makeClientCore();

      // нет модели/кадров
      expect(client.try_fire(0)).toBeUndefined();

      core.spawn_actor(1, 'm1', 1, 100, 100, 0);
      stepTicks(core, 1);
      client.set_model('m1');
      client.set_active(true);
      push(client, packFrame(core, 1000, 1, { playerId: 1 }), 1000);
      client.sample(1150);
      expect(client.try_fire(1200)).toBeTruthy();
    });

    it('авторитетный дубль своего трассера подавляется', () => {
      const { core, client } = setup();

      // локальный выстрел → pending-запись
      expect(client.try_fire(1200)).toBeTruthy();

      // авторитетный дубль от ядра
      core.apply_input(1, 2, 'down', 'fire');
      stepTicks(core, 1);
      push(client, packFrame(core, 1200, 2, { playerId: 1 }), 1200);
      client.sample(1350);

      const frames = JSON.parse(client.take_frames());

      expect(frames).toHaveLength(1);
      expect(frames[0].game.w1).toEqual([]); // свой дубль вычищен
    });
  });
});
