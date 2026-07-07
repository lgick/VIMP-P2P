import { describe, it, expect, beforeEach } from 'vitest';
import SnapshotInterpolator from '../../src/client/SnapshotInterpolator.js';

// хелпер: данные танка [x, y, angle, gunRotation, vx, vy, engineLoad,
// condition, size, teamId]
const tank = (x, y, angle = 0, rest = {}) => [
  x,
  y,
  angle,
  rest.gun ?? 0,
  rest.vx ?? 0,
  rest.vy ?? 0,
  rest.load ?? 0,
  rest.condition ?? 3,
  rest.size ?? 2,
  rest.teamId ?? 1,
];

let interp;
let seq;

// push с автоинкрементом seq (кадры по порядку, как по reliable-каналу)
const push = (game, camera, serverTime, localNow) => {
  seq += 1;
  interp.push(game, camera, serverTime, localNow, seq);
};

beforeEach(() => {
  // push с localNow === serverTime → оффсет 0, renderTime = localNow − 100
  interp = new SnapshotInterpolator({ delay: 100, maxFrameAge: 1000 });
  seq = 0;
});

describe('SnapshotInterpolator: базовые случаи', () => {
  it('пустой буфер → null-выдача', () => {
    expect(interp.sample(500)).toEqual({ frames: [], game: null, camera: null });
  });

  it('renderTime раньше первого кадра → пустая выдача', () => {
    push({ m1: { 1: tank(0, 0) } }, 0, 1000, 1000);

    // renderTime = 1050 − 100 = 950 < 1000
    const out = interp.sample(1050);

    expect(out.frames).toEqual([]);
    expect(out.game).toBeNull();
  });

  it('reset() очищает буфер и оффсет', () => {
    push({ m1: { 1: tank(0, 0) } }, 0, 1000, 1000);
    interp.reset();

    expect(interp.sample(2000)).toEqual({
      frames: [],
      game: null,
      camera: null,
    });
  });
});

describe('SnapshotInterpolator: интерполяция между кадрами', () => {
  it('позиции лерпятся с корректным alpha', () => {
    push({ m1: { 1: tank(0, 0) } }, 0, 1000, 1000);
    push({ m1: { 1: tank(10, 20) } }, 0, 1100, 1100);

    // renderTime = 1150 − 100 = 1050 → alpha 0.5
    const { game } = interp.sample(1150);

    expect(game.m1['1'][0]).toBeCloseTo(5);
    expect(game.m1['1'][1]).toBeCloseTo(10);
  });

  it('углы лерпятся по кратчайшему пути через ±π', () => {
    push({ m1: { 1: tank(0, 0, 3.0) } }, 0, 1000, 1000);
    push({ m1: { 1: tank(0, 0, -3.0) } }, 0, 1100, 1100);

    const { game } = interp.sample(1150);

    // середина пути 3.0 → −3.0 через π: |angle| ≈ π
    expect(Math.abs(game.m1['1'][2])).toBeCloseTo(Math.PI, 2);
  });

  it('дискретные поля танка берутся из кадра A', () => {
    push({ m1: { 1: tank(0, 0, 0, { condition: 3 }) } }, 0, 1000, 1000);
    push({ m1: { 1: tank(10, 0, 0, { condition: 1 }) } }, 0, 1100, 1100);

    const { game } = interp.sample(1150);

    expect(game.m1['1'][7]).toBe(3); // condition из A
  });

  it('динамика карты лерпится, бомбы и события — нет', () => {
    push(
      {
        c1: { d0: [0, 0, 0] },
        w2: { a1: [1, 1, 0, 8, 300] },
        w1: [[0, 0, 5, 5, 0, 0, true]],
      },
      0,
      1000,
      1000,
    );
    push(
      { c1: { d0: [10, 0, 1.0] }, w2: { a1: [1, 1, 0, 8, 300] }, w1: [] },
      0,
      1100,
      1100,
    );

    const { game } = interp.sample(1150);

    expect(game.c1.d0[0]).toBeCloseTo(5);
    expect(game.c1.d0[2]).toBeCloseTo(0.5);
    expect(game.w2).toBeUndefined();
    expect(game.w1).toBeUndefined();
  });

  it('танк только в одном из кадров не попадает в интерп-часть', () => {
    push({ m1: { 1: tank(0, 0) } }, 0, 1000, 1000);
    push({ m1: { 1: tank(10, 0), 2: tank(50, 50) } }, 0, 1100, 1100);

    const { game } = interp.sample(1150);

    expect(game.m1['1']).toBeDefined();
    expect(game.m1['2']).toBeUndefined(); // появится при выдаче кадра B
  });

  it('null-данные (удаление) не интерполируются', () => {
    push({ m1: { 1: tank(0, 0) } }, 0, 1000, 1000);
    push({ m1: { 1: null } }, 0, 1100, 1100);

    const { game } = interp.sample(1150);

    expect(game.m1['1']).toBeUndefined();
  });
});

describe('SnapshotInterpolator: дискретные кадры (frames)', () => {
  it('пересечённые кадры выдаются целиком, ровно один раз и по порядку', () => {
    push({ m1: { 1: tank(0, 0) } }, 0, 1000, 1000);
    push({ m1: { 1: tank(1, 0) }, w1: [[0, 0, 5, 5, 0, 0, true]] }, 0, 1050, 1050);
    push({ m1: { 1: tank(2, 0) } }, 0, 1100, 1100);

    // renderTime = 1060 → пересечены кадры 1000 и 1050
    const first = interp.sample(1160);

    expect(first.frames.length).toBe(2);
    expect(first.frames[0].game.m1['1'][0]).toBe(0);
    expect(first.frames[1].game.m1['1'][0]).toBe(1);
    expect(first.frames[1].game.w1).toBeDefined(); // событие в составе кадра

    // повторный sample — те же кадры не выдаются снова
    const second = interp.sample(1165);

    expect(second.frames).toEqual([]);
  });

  it('hold на последнем кадре: без экстраполяции и без повторных событий', () => {
    push(
      { m1: { 1: tank(7, 8, 0.5) }, w1: [[0, 0, 5, 5, 0, 0, false]] },
      0,
      1000,
      1000,
    );

    const first = interp.sample(1200); // renderTime 1100 > 1000, B нет

    expect(first.frames.length).toBe(1);
    expect(first.game.m1['1'][0]).toBe(7); // hold позиции A
    expect(first.game.w1).toBeUndefined(); // события в hold не дублируются

    const second = interp.sample(1300);

    expect(second.frames).toEqual([]); // событие выдано один раз
    expect(second.game.m1['1'][0]).toBe(7);
  });

  it('кадры старше maxFrameAge вычищаются без выдачи', () => {
    push({ m1: { 1: tank(0, 0) } }, 0, 1000, 1000);
    push({ m1: { 1: tank(1, 0) } }, 0, 1100, 1100);
    push({ m1: { 1: tank(2, 0) } }, 0, 5000, 5000);

    // кадр 1000 старше 5000 − 1000 → удалён; renderTime = 4901
    const out = interp.sample(5001);

    expect(out.frames.length).toBe(1);
    expect(out.frames[0].game.m1['1'][0]).toBe(1); // выдан только кадр 1100
  });
});

describe('SnapshotInterpolator: вставка по seq (транспорт без порядка)', () => {
  it('кадр с меньшим seq встаёт на своё место в буфере', () => {
    interp.push({ m1: { 1: tank(0, 0) } }, 0, 1000, 1000, 1);
    // кадр seq 3 обогнал кадр seq 2 (localNow === serverTime → оффсет 0)
    interp.push({ m1: { 1: tank(20, 0) } }, 0, 1100, 1100, 3);
    interp.push({ m1: { 1: tank(10, 0) } }, 0, 1050, 1050, 2);

    // renderTime = 1175 − 100 = 1075 → A = кадр seq 2, B = кадр seq 3
    const out = interp.sample(1175);

    expect(out.frames.length).toBe(2); // seq 1 и seq 2 пересечены по порядку
    expect(out.frames[1].game.m1['1'][0]).toBe(10);
    expect(out.game.m1['1'][0]).toBeCloseTo(15); // alpha 0.5 между 10 и 20
  });

  it('дубликат seq отбрасывается (и в буфере, и после выдачи)', () => {
    interp.push({ m1: { 1: tank(0, 0) } }, 0, 1000, 1000, 1);
    interp.push({ m1: { 1: tank(99, 99) } }, 0, 1000, 1005, 1); // дубль в буфере

    const first = interp.sample(1200);

    expect(first.frames.length).toBe(1);
    expect(first.frames[0].game.m1['1'][0]).toBe(0);

    interp.push({ m1: { 1: tank(99, 99) } }, 0, 1000, 1210, 1); // дубль выданного

    expect(interp.sample(1250).frames).toEqual([]);
  });

  it('события опоздавшего кадра выдаются немедленно, ровно один раз', () => {
    interp.push({ m1: { 1: tank(0, 0) } }, 0, 1000, 1000, 1);
    interp.push({ m1: { 1: tank(2, 0) } }, 0, 1100, 1100, 3);

    // renderTime = 1250 − 100 = 1150: оба кадра позади
    interp.sample(1250);

    // кадр seq 2 (serverTime 1050) опоздал — его событие нельзя потерять
    interp.push(
      { m1: { 1: tank(1, 0) }, w1: [[0, 0, 5, 5, 0, 0, true]] },
      0,
      1050,
      1255,
      2,
    );

    const out = interp.sample(1260);

    expect(out.frames.length).toBe(1);
    expect(out.frames[0].game.w1).toBeDefined();
    expect(out.game.m1['1'][0]).toBe(2); // интерполяция не дёрнулась назад

    // повторная доставка того же кадра — уже дубль
    interp.push(
      { m1: { 1: tank(1, 0) }, w1: [[0, 0, 5, 5, 0, 0, true]] },
      0,
      1050,
      1270,
      2,
    );

    expect(interp.sample(1280).frames).toEqual([]);
  });

  it('reset() очищает опоздавшие кадры и память дедупликации', () => {
    interp.push({ m1: { 1: tank(0, 0) } }, 0, 1000, 1000, 1);
    interp.sample(1200);
    interp.push({ m1: { 1: tank(1, 0) } }, 0, 1050, 1205, 2); // опоздал
    interp.reset();

    expect(interp.sample(1300).frames).toEqual([]); // pending очищен

    // после reset прежние seq снова валидны
    interp.push({ m1: { 1: tank(5, 0) } }, 0, 2000, 2000, 1);

    const out = interp.sample(2200);

    expect(out.frames.length).toBe(1);
    expect(out.frames[0].game.m1['1'][0]).toBe(5);
  });
});

describe('SnapshotInterpolator: камера', () => {
  it('координаты камеры лерпятся', () => {
    push({}, [0, 0], 1000, 1000);
    push({}, [10, 30], 1100, 1100);

    const { camera } = interp.sample(1150);

    expect(camera[0]).toBeCloseTo(5);
    expect(camera[1]).toBeCloseTo(15);
  });

  it('камера 0 (нет камеры) остаётся 0', () => {
    push({}, 0, 1000, 1000);
    push({}, 0, 1100, 1100);

    expect(interp.sample(1150).camera).toBe(0);
  });

  it('флаги reset/shake не попадают в интерп-камеру (только в frames)', () => {
    const cameraWithFlags = [5, 5];

    cameraWithFlags[2] = true;
    cameraWithFlags[3] = '5:300';

    push({}, cameraWithFlags, 1000, 1000);

    const out = interp.sample(1200); // hold

    expect(out.frames[0].camera[2]).toBe(true); // кадр целиком — с флагами
    expect(out.camera).toEqual([5, 5]); // hold-камера — без флагов
  });
});

describe('SnapshotInterpolator: оценка серверного времени', () => {
  it('первый кадр задаёт оффсет напрямую', () => {
    // serverTime 1000 при localNow 0 → оффсет 1000
    push({ m1: { 1: tank(3, 4) } }, 0, 1000, 0);

    // renderTime = 100 + 1000 − 100 = 1000 → кадр пересечён
    const out = interp.sample(100);

    expect(out.frames.length).toBe(1);
    expect(out.game.m1['1'][0]).toBe(3);
  });

  it('оффсет сглаживается EMA (джиттер не сдвигает renderTime скачком)', () => {
    push({ m1: { 1: tank(0, 0) } }, 0, 1000, 1000); // оффсет 0
    // кадр пришёл с опозданием 50 мс (оффсет −50): EMA сдвинется лишь на −5
    push({ m1: { 1: tank(10, 0) } }, 0, 1100, 1150);

    // renderTime = 1150 + (−5) − 100 = 1045 → alpha 0.45
    const { game } = interp.sample(1150);

    expect(game.m1['1'][0]).toBeCloseTo(4.5);
  });
});
