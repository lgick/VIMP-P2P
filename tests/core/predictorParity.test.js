import { describe, it, expect } from 'vitest';
import TankPredictor from '../../src/client/TankPredictor.js';
import gameConfig from '../../src/config/game.js';
import models from '../../src/data/models.js';
import { unpackFrame } from '../../src/lib/snapshotCodec.js';
import { coreAvailable, makeCore, frameBuffer } from './helpers.js';

// Паритет клиентской реплики движения (TankPredictor) с Rust-ядром —
// переориентация TankPredictorParity на «JS-реплика против ядра»
// (п. 2.5 P2P-плана). Живёт до финального среза (2.6), затем уходит
// вместе с JS-репликой. Оригинальный тест против Rapier-compat
// остаётся, пока жив текущий сервер.

const TIME_STEP_MS = 1000 / 120;
const DT = TIME_STEP_MS / 1000;

const playerKeys = gameConfig.playerKeys;
const bit = name => playerKeys[name].key;

const makePredictor = () => {
  const predictor = new TankPredictor({
    timeStep: TIME_STEP_MS,
    playerKeys,
    models,
  });

  predictor.setModel('m1');
  predictor._state = {
    x: 0,
    y: 0,
    angle: 0,
    vx: 0,
    vy: 0,
    angvel: 0,
    gunRotation: 0,
    throttle: 0,
  };
  predictor._hasState = true;

  return predictor;
};

const coreState = core => {
  core.pack_body();
  core.pack_frame(0, 1, false, 0, 0, false, undefined, 1);

  return unpackFrame(frameBuffer(core)).player.state;
};

const simulate = (steps, schedule) => {
  const core = makeCore();

  core.spawn_tank(1, 'm1', 1, 0, 0, 0);

  const predictor = makePredictor();

  let currentMask = 0;
  let seq = 0;

  const applyMask = newMask => {
    for (const name in playerKeys) {
      if (Object.hasOwn(playerKeys, name)) {
        const keyBit = playerKeys[name].key;
        const was = currentMask & keyBit;
        const now = newMask & keyBit;

        if (!was && now) {
          core.apply_input(1, (seq += 1), 'down', name);
        } else if (was && !now) {
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

    core.step(DT);

    // one-shot биты действуют только на шаге назначения
    const oneShotNow = schedule[i] !== undefined ? schedule[i] : 0;

    predictor._step(currentMask | (oneShotNow & predictor._oneShotMask));
  }

  return { core: coreState(core), predictor };
};

const expectClose = ({ core, predictor }, tolerance = 0.5) => {
  const p = predictor._state;

  expect(Math.abs(p.x - core[0])).toBeLessThan(tolerance);
  expect(Math.abs(p.y - core[1])).toBeLessThan(tolerance);
  expect(Math.abs(p.angle - core[2])).toBeLessThan(0.02);
  expect(Math.abs(p.vx - core[3])).toBeLessThan(tolerance);
  expect(Math.abs(p.vy - core[4])).toBeLessThan(tolerance);
  expect(Math.abs(p.gunRotation - core[6])).toBeLessThan(0.01);
  expect(Math.abs(p.throttle - core[7])).toBeLessThan(0.001);
};

describe.skipIf(!coreAvailable)('Паритет реплики движения с Rust-ядром', () => {
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
});
