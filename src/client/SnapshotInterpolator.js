import { SNAPSHOT_KEYS } from '../config/opcodes.js';
import { lerp, lerpAngle, clamp } from '../lib/math.js';

// Snapshot-интерполяция: кадры сервера складываются в буфер, мир рендерится
// в прошлом (renderTime = serverNow − delay) с интерполяцией позиций между
// соседними кадрами. Чистая логика без Pixi/DOM — вызывающий (main.js) сам
// применяет результат sample() к сущностям и камере.
//
// sample() возвращает два вида данных:
// - frames: целые кадры, чьё serverTime пересёк renderTime, — выдаются ровно
//   один раз (события w1/w2e, создания/удаления, дискретные поля, reset/shake
//   камеры);
// - game/camera: непрерывная часть (позиции танков/динамики карты, x/y
//   камеры), интерполированная между соседними кадрами, — на каждый вызов.
//
// Транспорт WebRTC (каналы meta/state) не гарантирует порядок и доставку:
// кадры вставляются в буфер по seq с дедупликацией; события опоздавшего
// reliable-кадра, чей serverTime уже позади renderTime, выдаются немедленно
// следующим sample() — «ровно один раз» сохраняется.

// коэффициент EMA-сглаживания оффсета серверного времени
const OFFSET_SMOOTHING = 0.1;

// окно памяти выданных seq для дедупликации (кадров; ~4 c при 30 пакетах/сек)
const SEQ_DEDUP_WINDOW = 128;

// индексы данных танка: 0,1 x/y; 2 angle; 3 gunRotation; 4,5 vx/vy;
// 6 engineLoad; 7..9 condition/size/teamId (дискретные, берутся из кадра A)
const TANK_ANGLE_INDEXES = new Set([2, 3]);
const TANK_LERP_LENGTH = 7;

export default class SnapshotInterpolator {
  /**
   * @param {Object} options
   * @param {number} options.delay - Задержка рендера в прошлом (мс).
   * @param {number} options.maxFrameAge - Максимальный возраст кадра в буфере (мс).
   */
  constructor({ delay, maxFrameAge }) {
    this._delay = delay;
    this._maxFrameAge = maxFrameAge;

    this._frames = []; // [{ seq, serverTime, game, camera, issued }]
    this._offsetEma = null; // сглаженный (serverTime − localNow)
    this._lastRenderTime = null; // renderTime последнего sample()
    this._pendingLate = []; // опоздавшие кадры — на немедленную выдачу
    this._issuedSeqs = new Set(); // seq выданных кадров (дедупликация)
  }

  /**
   * Добавляет кадр сервера в буфер (вставка по seq с дедупликацией).
   * @param {Object} game - gameSnapshot кадра.
   * @param {Array|0} camera - Камера кадра.
   * @param {number} serverTime
   * @param {number} localNow - Локальное время получения (performance.now()).
   * @param {number} seq - Номер кадра (Uint32).
   */
  push(game, camera, serverTime, localNow, seq) {
    if (this._issuedSeqs.has(seq)) {
      return;
    }

    // позиция вставки по seq (кадры почти всегда приходят по порядку —
    // поиск с конца); заодно дедупликация по буферу
    let index = this._frames.length;

    while (index > 0 && this._frames[index - 1].seq >= seq) {
      if (this._frames[index - 1].seq === seq) {
        return;
      }

      index -= 1;
    }

    const offset = serverTime - localNow;

    if (this._offsetEma === null) {
      this._offsetEma = offset;
    } else {
      this._offsetEma += (offset - this._offsetEma) * OFFSET_SMOOTHING;
    }

    // кадр опоздал (renderTime уже прошёл его serverTime): в буфере он
    // сдвинул бы опорный кадр назад — события выдаются немедленно
    if (this._lastRenderTime !== null && serverTime <= this._lastRenderTime) {
      this._issuedSeqs.add(seq);
      this._pendingLate.push({ game, camera });

      return;
    }

    this._frames.splice(index, 0, {
      seq,
      serverTime,
      game,
      camera,
      issued: false,
    });

    // страховочная очистка слишком старых кадров
    const newestTime = this._frames[this._frames.length - 1].serverTime;
    const minTime = newestTime - this._maxFrameAge;

    while (this._frames.length > 2 && this._frames[0].serverTime < minTime) {
      this._frames.shift();
    }
  }

  /**
   * Выборка состояния мира на текущий момент рендера.
   * @param {number} localNow - Локальное время (performance.now()).
   * @returns {{frames: Array, game: Object|null, camera: Array|0|null}}
   *   frames — невыданные кадры с serverTime <= renderTime (целиком);
   *   game/camera — интерполированная непрерывная часть (null, если буфер пуст).
   */
  sample(localNow) {
    // опоздавшие кадры выдаются немедленно, даже если буфер пуст
    const frames = this._pendingLate;

    this._pendingLate = [];

    if (this._offsetEma === null || this._frames.length === 0) {
      return { frames, game: null, camera: null };
    }

    const renderTime = localNow + this._offsetEma - this._delay;

    this._lastRenderTime = renderTime;

    // индекс кадра A: последний с serverTime <= renderTime
    let indexA = -1;

    for (let i = 0; i < this._frames.length; i += 1) {
      if (this._frames[i].serverTime <= renderTime) {
        indexA = i;
      } else {
        break;
      }
    }

    // renderTime раньше первого кадра — мир ещё «не начался»
    if (indexA === -1) {
      return { frames, game: null, camera: null };
    }

    // невыданные кадры, пересечённые renderTime (события — ровно один раз)
    for (let i = 0; i <= indexA; i += 1) {
      const frame = this._frames[i];

      if (!frame.issued) {
        frame.issued = true;
        this._issuedSeqs.add(frame.seq);
        frames.push({ game: frame.game, camera: frame.camera });
      }
    }

    // кадры до A больше не нужны (A остаётся опорным)
    this._frames.splice(0, indexA);
    this._pruneIssuedSeqs();

    const frameA = this._frames[0];
    const frameB = this._frames[1];

    // нет следующего кадра — hold на A без экстраполяции;
    // отдаётся только непрерывная часть (события кадра уже выданы через frames)
    if (!frameB) {
      return {
        frames,
        game: this._interpolateGame(frameA.game, frameA.game, 0),
        camera: this._stripCamera(frameA.camera),
      };
    }

    const alpha = clamp(
      (renderTime - frameA.serverTime) /
        (frameB.serverTime - frameA.serverTime),
      0,
      1,
    );

    return {
      frames,
      game: this._interpolateGame(frameA.game, frameB.game, alpha),
      camera: this._interpolateCamera(frameA.camera, frameB.camera, alpha),
    };
  }

  // текущая оценка (serverTime − localNow); null, если кадров ещё не было
  get offset() {
    return this._offsetEma;
  }

  // сбрасывает буфер и оценку времени (смена карты, очистка полотна)
  reset() {
    this._frames = [];
    this._offsetEma = null;
    this._lastRenderTime = null;
    this._pendingLate = [];
    this._issuedSeqs.clear();
  }

  // выкидывает из памяти дедупликации seq далеко позади опорного кадра
  _pruneIssuedSeqs() {
    const minSeq = this._frames[0].seq - SEQ_DEDUP_WINDOW;

    for (const seq of this._issuedSeqs) {
      if (seq < minSeq) {
        this._issuedSeqs.delete(seq);
      }
    }
  }

  // интерполирует непрерывную часть снапшота (танки + динамика карты)
  _interpolateGame(gameA, gameB, alpha) {
    const result = {};

    for (const key in gameA) {
      if (!Object.hasOwn(gameA, key) || !Object.hasOwn(gameB, key)) {
        continue;
      }

      const kind = SNAPSHOT_KEYS[key]?.kind;

      if (kind === 'tanks') {
        result[key] = this._interpolateTanks(gameA[key], gameB[key], alpha);
      } else if (kind === 'dynamics') {
        result[key] = this._interpolateDynamics(gameA[key], gameB[key], alpha);
      }
      // bombs (позиция только при создании), tracers/explosions (события) —
      // не интерполируются
    }

    return result;
  }

  // танки: id, присутствующие с данными в обоих кадрах
  _interpolateTanks(tanksA, tanksB, alpha) {
    const result = {};

    for (const id in tanksA) {
      if (!Object.hasOwn(tanksA, id)) {
        continue;
      }

      const dataA = tanksA[id];
      const dataB = tanksB[id];

      if (!dataA || !dataB) {
        continue;
      }

      const data = [];

      for (let i = 0; i < TANK_LERP_LENGTH; i += 1) {
        data.push(
          TANK_ANGLE_INDEXES.has(i)
            ? lerpAngle(dataA[i], dataB[i], alpha)
            : lerp(dataA[i], dataB[i], alpha),
        );
      }

      // дискретные поля (condition, size, teamId) — из кадра A
      data.push(dataA[7], dataA[8], dataA[9]);

      result[id] = data;
    }

    return result;
  }

  // динамика карты: [x, y, angle]
  _interpolateDynamics(itemsA, itemsB, alpha) {
    const result = {};

    for (const key in itemsA) {
      if (!Object.hasOwn(itemsA, key)) {
        continue;
      }

      const dataA = itemsA[key];
      const dataB = itemsB[key];

      if (!dataA || !dataB) {
        continue;
      }

      result[key] = [
        lerp(dataA[0], dataB[0], alpha),
        lerp(dataA[1], dataB[1], alpha),
        lerpAngle(dataA[2], dataB[2], alpha),
      ];
    }

    return result;
  }

  // камера: lerp x/y; reset/shake не дублируются (уже выданы кадрами)
  _interpolateCamera(cameraA, cameraB, alpha) {
    if (cameraA === 0 || cameraB === 0) {
      return this._stripCamera(cameraA);
    }

    return [
      lerp(cameraA[0], cameraB[0], alpha),
      lerp(cameraA[1], cameraB[1], alpha),
    ];
  }

  // оставляет от камеры только координаты (без флагов reset/shake)
  _stripCamera(camera) {
    return camera === 0 ? 0 : [camera[0], camera[1]];
  }
}
