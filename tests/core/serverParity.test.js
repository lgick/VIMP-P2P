import { describe, it, expect, beforeEach, vi } from 'vitest';
import RAPIER from '../../src/server/physics/rapier.js';
import gameConfig from '../../src/config/game.js';
import models from '../../src/data/models.js';
import { unpackFrame } from '../../src/lib/snapshotCodec.js';
import { coreAvailable, makeCore, frameBuffer } from './helpers.js';

// Поведенческий паритет ядра с текущим сервером (эталон Этапа 2.5):
// реальный Tank в реальном Rapier-compat мире против Rust-ядра при
// одинаковом вводе. Допуски покрывают разницу версий Rapier
// (compat 0.19 против нативного 0.34) и f64-математики JS против f32.

const TIME_STEP_MS = 1000 / 120;
const DT = TIME_STEP_MS / 1000;

const playerKeys = gameConfig.playerKeys;
const bit = name => playerKeys[name].key;

let Tank;

const makePanel = () => ({
  setActiveWeapon: vi.fn(),
  getCurrentValue: () => 100,
  hasResources: () => true,
  updateUser: vi.fn(),
});

const makeRealTank = (world, position = [0, 0], angle = 0) => {
  const keys = {};
  let oneShotMask = 0;

  for (const name in playerKeys) {
    if (Object.hasOwn(playerKeys, name)) {
      keys[name] = playerKeys[name].key;

      if (playerKeys[name].type === 1) {
        oneShotMask |= playerKeys[name].key;
      }
    }
  }

  return new Tank({
    model: 'm1',
    name: 'Server',
    gameId: '1',
    teamId: 1,
    currentWeapon: 'w1',
    weapons: { w1: { type: 'hitscan', fireRate: 0.1, spread: 0 } },
    playerKeys: { keys, oneShotMask },
    services: { panel: makePanel() },
    modelData: models.m1,
    world,
    position,
    angle,
  });
};

// состояние танка ядра [x, y, angle, vx, vy, angvel, gunRot, throttle]
// через player-блок кадра (заодно проверяется wire-путь)
const coreState = core => {
  core.pack_body();
  core.pack_frame(0, 1, false, 0, 0, false, undefined, 1);

  return unpackFrame(frameBuffer(core)).player.state;
};

// прогоняет обе симуляции по расписанию масок { шаг: маска }
const simulate = (steps, schedule) => {
  const world = new RAPIER.World({ x: 0, y: 0 });

  world.timestep = DT;

  const tank = makeRealTank(world);
  const core = makeCore();

  core.spawn_tank(1, 'm1', 1, 0, 0, 0);

  let currentMask = 0;
  let seq = 0;

  const applyMask = newMask => {
    for (const name in playerKeys) {
      if (Object.hasOwn(playerKeys, name)) {
        const keyBit = playerKeys[name].key;
        const was = currentMask & keyBit;
        const now = newMask & keyBit;

        if (!was && now) {
          tank.updateKeys({ action: 'down', name });
          core.apply_input(1, (seq += 1), 'down', name);
        } else if (was && !now) {
          tank.updateKeys({ action: 'up', name });
          core.apply_input(1, (seq += 1), 'up', name);
        }
      }
    }

    currentMask = newMask;
  };

  for (let i = 0; i < steps; i += 1) {
    if (schedule[i] !== undefined) {
      applyMask(schedule[i]);
    }

    tank.updateData(DT);
    world.step();
    core.step(DT);
  }

  return { server: tank.getPredictionState().state, core: coreState(core) };
};

const expectClose = ({ server, core }, tolerance = 0.5) => {
  expect(Math.abs(core[0] - server[0])).toBeLessThan(tolerance); // x
  expect(Math.abs(core[1] - server[1])).toBeLessThan(tolerance); // y
  expect(Math.abs(core[2] - server[2])).toBeLessThan(0.02); // angle
  expect(Math.abs(core[3] - server[3])).toBeLessThan(tolerance); // vx
  expect(Math.abs(core[4] - server[4])).toBeLessThan(tolerance); // vy
  expect(Math.abs(core[6] - server[6])).toBeLessThan(0.01); // gunRotation
  expect(Math.abs(core[7] - server[7])).toBeLessThan(0.001); // throttle
};

beforeEach(async () => {
  vi.resetModules();
  Tank = (await import('../../src/server/parts/Tank.js')).default;
});

describe.skipIf(!coreAvailable)(
  'Паритет ядра с текущим сервером (Rapier-compat)',
  () => {
    it('разгон вперёд (1 секунда)', () => {
      expectClose(simulate(120, { 0: bit('forward') }));
    });

    it('разгон с поворотом направо', () => {
      expectClose(simulate(120, { 0: bit('forward') | bit('right') }));
    });

    it('газ → отпустил → активное торможение', () => {
      expectClose(
        simulate(150, {
          0: bit('forward'),
          90: 0,
        }),
      );
    });

    it('задний ход с поворотом налево', () => {
      expectClose(simulate(120, { 0: bit('back') | bit('left') }));
    });

    it('поворот башни и центрирование (one-shot gunCenter)', () => {
      expectClose(
        simulate(90, {
          0: bit('gunRight'),
          40: bit('gunCenter'),
        }),
      );
    });

    it('без ввода танк остаётся на месте', () => {
      expectClose(simulate(60, {}), 0.001);
    });
  },
);
