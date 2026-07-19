import { describe, it, expect, beforeEach } from 'vitest';
import poolMini from '@vimp/tanks/data/maps/pool_mini.js';
import {
  coreAvailable,
  makeCore,
  makeClientCore,
  decodeFrame,
  frameBuffer,
  stepTicks,
  takeEvents,
} from './helpers.js';

// JS↔WASM интеграционный харнесс ядра (Этап 2.5): команды/события ABI
// и round-trip бинарного кадра v3 — ядро пакует (Rust), распаковывает
// клиентское ядро (ClientCore.decode_frame, срез 2.6).

const DT = 1 / 120;

// распаковка кадров клиентским ядром (лениво: без pkg-node тесты скипаются)
let decoder = null;
const decode = buffer => decodeFrame((decoder ??= makeClientCore()), buffer);

describe.skipIf(!coreAvailable)('GameCore (nodejs-таргет)', () => {
  let core;

  beforeEach(() => {
    core = makeCore();
  });

  describe('карта', () => {
    it('load_map масштабирует карту и отдаёт map_info', () => {
      core.load_map(JSON.stringify(poolMini));

      const info = JSON.parse(core.map_info());

      // pool_mini: scale 0.6, step 32 → 19.2
      expect(info.setId).toBe('c1');
      expect(info.step).toBeCloseTo(32 * 0.6, 4);
      // респауны масштабированы: [130, 520, 0] → [78, 312, 0]
      expect(info.respawns.team1[0]).toEqual([78, 312, 0]);
    });

    it('map_info без карты — null', () => {
      expect(core.map_info()).toBe('null');
    });
  });

  describe('вертикальный MVP: танк ездит через WASM', () => {
    it('танк разгоняется вперёд и подтверждает seq ввода', () => {
      core.spawn_actor(1, 'm1', 1, 0, 0, 0);
      core.apply_input(1, 15, 'down', 'forward');

      stepTicks(core, 120);

      const [x, y] = core.position_of(1);

      expect(x).toBeGreaterThan(100);
      expect(Math.abs(y)).toBeLessThan(1);
      expect(core.last_input_seq(1)).toBe(15);
    });

    it('стена карты останавливает танк', () => {
      core.load_map(JSON.stringify(poolMini));
      // едет влево в стену (внутренняя грань стены x = 19.2)
      core.spawn_actor(1, 'm1', 1, 78, 312, 180);
      core.apply_input(1, 1, 'down', 'forward');

      stepTicks(core, 400);

      const [x] = core.position_of(1);

      expect(x).toBeGreaterThan(19.2);
    });
  });

  describe('round-trip кадра v3 через decode_frame', () => {
    it('кадр играющего: заголовок, камера, player-блок, танки, динамика', () => {
      core.load_map(JSON.stringify(poolMini));
      core.spawn_actor(1, 'm1', 1, 78, 312, 0);
      core.apply_input(1, 3, 'down', 'forward');
      stepTicks(core, 10);

      core.pack_body();

      const serverTime = 1234567.5;
      const [cx, cy] = core.position_of(1);

      core.pack_frame(serverTime, 42, true, cx, cy, false, undefined, 1);

      const decoded = decode(frameBuffer(core));

      expect(decoded.port).toBe(5);
      expect(decoded.seq).toBe(42);
      expect(decoded.serverTime).toBe(serverTime);
      // позиции ядра — f32, декодер камеры округляет до 2 знаков
      expect(decoded.camera[0]).toBeCloseTo(cx, 2);
      expect(decoded.camera[1]).toBeCloseTo(cy, 2);

      // player-блок предикшена
      expect(decoded.player.gameId).toBe(1);
      expect(decoded.player.inputSeq).toBe(3);
      expect(decoded.player.state).toHaveLength(8);
      expect(decoded.player.centering).toBe(false);

      // танк в блоке m1: формат Tank.getData
      const tank = decoded.snapshot.m1[1];

      expect(tank).toHaveLength(10);
      expect(tank[0]).toBeCloseTo(decoded.player.state[0], 1); // x
      expect(tank[7]).toBe(3); // condition
      expect(tank[8]).toBe(2); // size
      expect(tank[9]).toBe(1); // teamId

      // динамика карты присутствует всегда (пустой объект для pool_mini)
      expect(decoded.snapshot.c1).toEqual({});
    });

    it('кадр наблюдателя: камера с reset и shake, без player-блока', () => {
      core.pack_body();
      core.pack_frame(1000, 7, true, 10.5, -3.25, true, '20:200', -1);

      const decoded = decode(frameBuffer(core));

      expect(decoded.camera[0]).toBe(10.5);
      expect(decoded.camera[1]).toBe(-3.25);
      expect(decoded.camera[2]).toBe(true);
      expect(decoded.camera[3]).toBe('20:200');
      expect(decoded.player).toBeNull();
    });

    it('трассер w1 несёт shooterId и wasHit (формат v3)', () => {
      core.spawn_actor(1, 'm1', 1, 0, 0, 0);
      core.spawn_actor(2, 'm1', 2, 60, 0, 0);
      stepTicks(core, 1); // прогрев broad-phase

      core.apply_input(1, 1, 'down', 'fire');
      stepTicks(core, 1);

      core.pack_body();
      core.pack_frame(0, 1, false, 0, 0, false, undefined, -1);

      const decoded = decode(frameBuffer(core));
      const tracers = decoded.snapshot.w1;

      expect(tracers).toHaveLength(1);

      const [startX, , endX, , bodyX, , wasHit, shooterId] = tracers[0];

      expect(wasHit).toBe(true);
      expect(shooterId).toBe(1);
      expect(startX).toBeGreaterThan(bodyX); // дуло впереди корпуса
      expect(endX).toBeGreaterThan(startX);
      expect(endX).toBeLessThanOrEqual(60); // попадание в цель
    });

    it('бомба w2: создание с ownerId, затем взрыв w2e и null-маркер', () => {
      core.spawn_actor(1, 'm1', 1, 0, 0, 0);
      stepTicks(core, 1);

      core.apply_input(1, 1, 'down', 'nextWeapon');
      stepTicks(core, 1);
      core.apply_input(1, 2, 'down', 'fire');
      stepTicks(core, 1);

      core.pack_body();
      core.pack_frame(0, 1, false, 0, 0, false, undefined, -1);

      let decoded = decode(frameBuffer(core));
      const bombs = decoded.snapshot.w2;
      const ids = Object.keys(bombs);

      expect(ids).toHaveLength(1);

      // [x, y, angle, size, time, ownerId]
      const bomb = bombs[ids[0]];

      expect(bomb[3]).toBe(8);
      expect(bomb[4]).toBe(300);
      expect(bomb[5]).toBe(1);

      // 300 мс + запас: детонация
      stepTicks(core, 50);
      core.pack_body();
      core.pack_frame(0, 2, false, 0, 0, false, undefined, -1);
      decoded = decode(frameBuffer(core));

      expect(decoded.snapshot.w2[ids[0]]).toBeNull(); // удаление с полотна
      expect(decoded.snapshot.w2e).toHaveLength(1);

      const [ex, ey, radius] = decoded.snapshot.w2e[0];

      expect(radius).toBe(50);
      expect(Math.abs(ex)).toBeLessThan(2);
      expect(Math.abs(ey)).toBeLessThan(2);
    });

    it('remove_actor даёт null-маркер в следующем кадре', () => {
      core.spawn_actor(1, 'm1', 1, 0, 0, 0);
      stepTicks(core, 1);
      core.remove_actor(1);

      core.pack_body();
      core.pack_frame(0, 1, false, 0, 0, false, undefined, -1);

      const decoded = decode(frameBuffer(core));

      expect(decoded.snapshot.m1[1]).toBeNull();
    });

    it('события снапшота копятся между pack_body (throttle на JS)', () => {
      core.spawn_actor(1, 'm1', 1, 0, 0, 0);
      core.spawn_actor(2, 'm1', 2, 60, 0, 0);
      stepTicks(core, 1);

      // два выстрела в разных тиках между отправками
      core.apply_input(1, 1, 'down', 'fire');
      stepTicks(core, 2);
      core.apply_input(1, 2, 'down', 'fire');
      stepTicks(core, 2);

      core.pack_body();
      core.pack_frame(0, 1, false, 0, 0, false, undefined, -1);

      let decoded = decode(frameBuffer(core));

      expect(decoded.snapshot.w1).toHaveLength(2);

      // после дренажа — событий нет
      core.pack_body();
      core.pack_frame(0, 2, false, 0, 0, false, undefined, -1);
      decoded = decode(frameBuffer(core));

      expect(decoded.snapshot.w1).toBeUndefined();
    });

    it('body_has_events классифицирует кадр (события → meta, позиции → state)', () => {
      core.spawn_actor(1, 'm1', 1, 0, 0, 0);
      core.step(DT);
      core.pack_body();

      expect(core.body_has_events()).toBe(false); // только позиции

      core.apply_input(1, 1, 'down', 'fire');
      core.step(DT);
      core.pack_body();

      expect(core.body_has_events()).toBe(true); // трассер

      core.pack_body();

      expect(core.body_has_events()).toBe(false); // события дренированы

      core.remove_actor(1);
      core.pack_body();

      expect(core.body_has_events()).toBe(true); // null-маркер удаления
    });
  });

  describe('события ядра для меты', () => {
    it('спавн сообщает активное оружие и здоровье', () => {
      core.spawn_actor(1, 'm1', 1, 0, 0, 0);

      const events = takeEvents(core);

      expect(events).toContainEqual({ type: 'activeWeapon', id: 1, weapon: 'w1' });
      expect(events).toContainEqual({ type: 'health', id: 1, value: 100 });
    });

    it('убийство: ammo/shake/health/kill', () => {
      core.spawn_actor(1, 'm1', 1, 0, 0, 0);
      core.spawn_actor(2, 'm1', 2, 60, 0, 0);
      stepTicks(core, 1);
      core.take_events();

      for (let seq = 1; seq <= 3; seq += 1) {
        core.apply_input(1, seq, 'down', 'fire');
        stepTicks(core, 4);
      }

      const events = takeEvents(core);
      const kill = events.find(e => e.type === 'kill');

      expect(kill).toEqual({ type: 'kill', victim: 2, killer: 1 });
      expect(core.is_alive(2)).toBe(false);

      const ammo = events
        .filter(e => e.type === 'ammo' && e.id === 1)
        .map(e => e.value);

      expect(ammo).toEqual([199, 198, 197]);

      const shakes = events.filter(e => e.type === 'shake' && e.id === 2);

      expect(shakes).toHaveLength(3);
      expect(shakes[0]).toMatchObject({ intensity: 20, duration: 200 });
    });

    it('reset_all_vitals восстанавливает панель', () => {
      core.spawn_actor(1, 'm1', 1, 0, 0, 0);
      core.spawn_actor(2, 'm1', 2, 60, 0, 0);
      stepTicks(core, 1);
      core.apply_input(1, 1, 'down', 'fire');
      stepTicks(core, 2);
      core.take_events();

      core.reset_all_vitals();

      const events = takeEvents(core);

      expect(events).toContainEqual({ type: 'health', id: 2, value: 100 });
      expect(events).toContainEqual({ type: 'ammo', id: 1, weapon: 'w1', value: 200 });
    });
  });

  describe('боты', () => {
    it('бот патрулирует карту без внешнего ввода', () => {
      core.load_map(JSON.stringify(poolMini));
      core.spawn_scripted_actor(1, 'm1', 1, 78, 312, 0);

      const [sx, sy] = core.position_of(1);

      stepTicks(core, 360);

      const [ex, ey] = core.position_of(1);
      const distSq = (ex - sx) ** 2 + (ey - sy) ** 2;

      expect(distSq).toBeGreaterThan(100);
    });

    it('alive_players отдаёт плоский список для меты', () => {
      core.spawn_actor(1, 'm1', 1, 10, 20, 0);
      core.spawn_actor(2, 'm1', 2, 30, 40, 0);

      expect(Array.from(core.alive_players())).toEqual([1, 1, 10, 20, 2, 2, 30, 40]);
    });
  });

  describe('очистка и смена карты', () => {
    it('remove_players_and_shots возвращает имена для очистки полотна', () => {
      core.spawn_actor(1, 'm1', 1, 0, 0, 0);

      const names = JSON.parse(core.remove_players_and_shots());

      expect(names).toEqual(expect.arrayContaining(['m1', 'w1', 'w2', 'w2e']));
      expect(core.position_of(1)).toHaveLength(0);
    });

    it('clear готовит мир к новой карте', () => {
      core.load_map(JSON.stringify(poolMini));
      core.spawn_actor(1, 'm1', 1, 78, 312, 0);
      stepTicks(core, 5);

      core.clear();

      expect(core.map_info()).toBe('null');
      expect(core.position_of(1)).toHaveLength(0);

      core.load_map(JSON.stringify(poolMini));
      core.spawn_actor(2, 'm1', 2, 960, 312, 180);
      stepTicks(core, 5);

      expect(core.position_of(2)).toHaveLength(2);
    });
  });

  describe('handoff (Spike B)', () => {
    it('serialize/deserialize продолжает симуляцию бит-в-бит', () => {
      core.load_map(JSON.stringify(poolMini));
      core.spawn_actor(1, 'm1', 1, 78, 312, 0);
      core.spawn_scripted_actor(2, 'm1', 2, 960, 312, 180);
      core.apply_input(1, 1, 'down', 'forward');
      stepTicks(core, 60);

      core.pack_body(); // дренаж накопителей
      core.take_events();

      const dump = core.serialize_state();
      const restored = makeCore();

      restored.deserialize_state(dump);

      stepTicks(core, 120);
      stepTicks(restored, 120);

      expect(Array.from(core.position_of(1))).toEqual(
        Array.from(restored.position_of(1)),
      );
      expect(Array.from(core.position_of(2))).toEqual(
        Array.from(restored.position_of(2)),
      );
    });
  });
});
