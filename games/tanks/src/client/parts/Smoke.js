import { Container, Ticker } from 'pixi.js';
import ParticlePool from './ParticlePool.js';
import { lerp, randomRange } from '@vimp/engine/lib/math.js';

// глобальные переменные для ветра
const globalWindX = 0;
const globalWindY = 0;

const SMOKE_CONFIG = {
  // размеры и жизнь частиц
  particleLifetime: { min: 800, max: 1800 },

  // конфигурация размеров:
  // 1 (сильный урон) - самый крупный дым
  // 2 (средний урон) - средний дым
  // 0 (уничтожен) - маленький дым (тление)
  particleStartSizeFactor: { 1: 2.0, 2: 1.0, 0: 0.25 },
  particleEndSizeFactor: { 1: 3.0, 2: 2.0, 0: 1.0 },

  // прозрачность
  particleStartAlpha: 0.08,
  particleEndAlpha: 0.0,

  particleColor: 0x333333,

  // конфигурация спавна (частиц в секунду):
  // 1 - густой поток
  // 2 - умеренный поток
  // 0 - редкий дым
  particleSpawnRate: { 1: 60, 2: 50, 0: 30 },

  // направление дыма
  particleInitialVelocity: {
    away: { min: -10, max: 100 },
    side: { min: -30, max: 30 },
  },

  // сопротивление воздуха
  airResistance: 0.92,

  particleVelocityVariance: 10,

  // сдвиг труб друг относительно друга
  streamOffsetFactor: 0.1,

  // количество частиц при "взрыве" (смене состояния)
  // эффект резкого облака дыма при получении урона
  burstParticleCount: 3,
};

export default class Smoke extends Container {
  constructor(data, assets) {
    super();

    this.zIndex = 4;

    this._smokeTexture = assets.smokeTexture;

    this._emitterX = data[0];
    this._emitterY = data[1];
    this._emitterRotation = data[2];
    this._emitterVX = data[4];
    this._emitterVY = data[5];
    this._engineLoad = data[6];
    this._condition = data[7];

    this._size = data[8];
    this._width = this._size * 4;
    this._height = this._size * 3;

    this._particleScaleMultiplier = Math.max(
      0.5,
      Math.sqrt(this._width * this._height * 0.001),
    );

    this._particles = [];

    this._particleContainer = new Container();
    this.addChild(this._particleContainer);

    this._timeSinceLastSpawn = 0;

    this._tickListener = ticker => this._updateParticles(ticker.deltaMS);
    Ticker.shared.add(this._tickListener);
  }

  update(data) {
    const prevCondition = this._condition;

    this._emitterX = data[0];
    this._emitterY = data[1];
    this._emitterRotation = data[2];
    this._emitterVX = data[4];
    this._emitterVY = data[5];
    this._engineLoad = data[6];
    this._condition = data[7];

    // если состояние изменилось и
    // новое состояние подразумевает наличие дыма (не 3)
    if (this._condition !== prevCondition && this._condition !== 3) {
      this._triggerSmokeBurst();
    }
  }

  // метод для создания мгновенного облака частиц
  _triggerSmokeBurst() {
    let numStreams = 0;

    if (this._condition === 1) {
      numStreams = 2;
    } else if (this._condition === 2) {
      numStreams = 1;
    } else if (this._condition === 0) {
      numStreams = 1;
    }

    if (numStreams > 0) {
      const count = SMOKE_CONFIG.burstParticleCount;
      const particlesPerStream = Math.ceil(count / numStreams);

      for (let i = 0; i < particlesPerStream; i += 1) {
        for (let s = 0; s < numStreams; s += 1) {
          this.spawnParticle(s, numStreams, true);
        }
      }
    }
  }

  _updateParticles(deltaMs) {
    if (deltaMs <= 0) {
      return;
    }

    const deltaTime = deltaMs / 1000.0;
    this._timeSinceLastSpawn += deltaMs;

    let numStreams = 0;

    // норма: дыма нет
    if (this._condition === 3) {
      numStreams = 0;

      // значительные повреждения: сильный дым (из двух труб или просто широкий)
    } else if (this._condition === 1) {
      numStreams = 2;

      // незначительные повреждения: средний дым (один поток)
    } else if (this._condition === 2) {
      numStreams = 1;

      // уничтожен: небольшой остаточный дым
    } else if (this._condition === 0) {
      numStreams = 1;
    }

    // частота спавна или 0, если состояние не определено
    const spawnRate = SMOKE_CONFIG.particleSpawnRate[this._condition] || 0;

    // если spawnRate 0 (или бесконечность),
    // интервал будет Infinity, цикл не запустится
    const spawnInterval = spawnRate > 0 ? 1000.0 / spawnRate : Infinity;

    if (numStreams > 0 && spawnRate > 0) {
      while (this._timeSinceLastSpawn >= spawnInterval) {
        for (let i = 0; i < numStreams; i += 1) {
          this.spawnParticle(i, numStreams);
        }
        this._timeSinceLastSpawn -= spawnInterval;
      }
    } else {
      // сброс таймера, если дыма нет
      this._timeSinceLastSpawn = 0;
    }

    // предварительный расчет трения
    const frictionFactor = Math.pow(SMOKE_CONFIG.airResistance, deltaMs / 16.0);
    const oneMinusFriction = 1 - frictionFactor;

    // обратный цикл для безопасного удаления
    for (let i = this._particles.length - 1; i >= 0; i -= 1) {
      const particle = this._particles[i];
      particle.age += deltaMs;

      if (particle.age >= particle.lifetime) {
        this._particleContainer.removeChild(particle.graphics);
        ParticlePool.release(particle.graphics);
        this._particles.splice(i, 1);
        continue;
      }

      // ветер и трение
      particle.vx =
        particle.vx + (globalWindX - particle.vx) * oneMinusFriction;
      particle.vy =
        particle.vy + (globalWindY - particle.vy) * oneMinusFriction;

      particle.x += particle.vx * deltaTime;
      particle.y += particle.vy * deltaTime;

      // интерполяция параметров
      const lifeProgress = particle.age / particle.lifetime;
      // простое квадратичное затухание
      const ease = 1 - (1 - lifeProgress) * (1 - lifeProgress);

      const currentSizeFactor = lerp(
        particle.startSizeFactor,
        particle.endSizeFactor,
        ease,
      );

      const currentAlpha = lerp(
        particle.startAlpha,
        particle.endAlpha,
        lifeProgress,
      );

      const currentScale = currentSizeFactor * this._particleScaleMultiplier;

      const spr = particle.graphics;
      spr.x = particle.x;
      spr.y = particle.y;
      spr.scale.set(currentScale);
      spr.alpha = currentAlpha;
      spr.rotation += particle.rotSpeed * deltaTime;
    }
  }

  spawnParticle(streamIndex, numStreams, isBurst = false) {
    const lifetime = randomRange(
      SMOKE_CONFIG.particleLifetime.min,
      SMOKE_CONFIG.particleLifetime.max,
    );

    // параметры из конфига или дефолтные маленькие значения
    let startSizeFactor =
      SMOKE_CONFIG.particleStartSizeFactor[this._condition] || 0.3;
    let endSizeFactor =
      SMOKE_CONFIG.particleEndSizeFactor[this._condition] || 1.0;

    // параметры по умолчанию
    let startAlpha = SMOKE_CONFIG.particleStartAlpha;
    let velocityMultiplier = 1.0;

    // если эффект взрыва
    if (isBurst) {
      // огромный размер
      startSizeFactor *= 2.0;
      endSizeFactor *= 2.5;

      // густота (дым непрозрачный)
      startAlpha = 0.8;

      // дальность полета (мощный импульс скорости)
      velocityMultiplier = 2.0;
    }

    const angle = this._emitterRotation;

    // векторы направления
    const backAngle = angle + Math.PI;
    const cosBack = Math.cos(backAngle);
    const sinBack = Math.sin(backAngle);

    const rightAngle = angle + Math.PI / 2;
    const cosRight = Math.cos(rightAngle);
    const sinRight = Math.sin(rightAngle);

    // смещение вбок
    let offsetSide = 0;
    const streamDisplacement =
      (this._width / 2) * SMOKE_CONFIG.streamOffsetFactor;

    if (numStreams === 2) {
      offsetSide = streamIndex === 0 ? -streamDisplacement : streamDisplacement;
    } else if (numStreams === 3) {
      offsetSide = (streamIndex - 1) * streamDisplacement;
    }

    // смещение назад
    const offsetBack = this._height * 0.22;

    // точка спавна
    const spawnX =
      this._emitterX + cosBack * offsetBack + cosRight * offsetSide;
    const spawnY =
      this._emitterY + sinBack * offsetBack + sinRight * offsetSide;

    // скорость
    let ejectionSpeed = randomRange(
      SMOKE_CONFIG.particleInitialVelocity.away.min,
      SMOKE_CONFIG.particleInitialVelocity.away.max,
    );
    let sideSpeed = randomRange(
      SMOKE_CONFIG.particleInitialVelocity.side.min,
      SMOKE_CONFIG.particleInitialVelocity.side.max,
    );

    // ускорение для взрыва
    ejectionSpeed *= velocityMultiplier;
    sideSpeed *= velocityMultiplier;

    let vx = cosBack * ejectionSpeed + cosRight * sideSpeed;
    let vy = sinBack * ejectionSpeed + sinRight * sideSpeed;

    const variance = SMOKE_CONFIG.particleVelocityVariance;

    vx += randomRange(-variance, variance);
    vy += randomRange(-variance, variance);

    // дым не наследует скорость танка (0), чтобы оставаться "в воздухе"
    vx += this._emitterVX;
    vy += this._emitterVY;

    const graphics = ParticlePool.get(this._smokeTexture);
    graphics.anchor.set(0.5);
    graphics.tint = SMOKE_CONFIG.particleColor;
    graphics.x = spawnX;
    graphics.y = spawnY;
    graphics.alpha = startAlpha;
    graphics.scale.set(startSizeFactor * this._particleScaleMultiplier);
    graphics.rotation = randomRange(0, Math.PI * 2);

    const particle = {
      graphics,
      x: spawnX,
      y: spawnY,
      vx,
      vy,
      age: 0,
      lifetime,
      startSizeFactor,
      endSizeFactor,
      startAlpha,
      endAlpha: SMOKE_CONFIG.particleEndAlpha,
      rotSpeed: randomRange(-1, 1),
    };

    this._particleContainer.addChild(graphics);
    this._particles.push(particle);
  }

  _stopTimer() {
    if (this._tickListener) {
      Ticker.shared.remove(this._tickListener);
      this._tickListener = null;
    }
  }

  destroy(options) {
    this._stopTimer();

    // все активные частицы в пул
    for (let i = 0; i < this._particles.length; i += 1) {
      ParticlePool.release(this._particles[i].graphics);
    }

    this._particles = [];

    super.destroy({
      children: true,
      texture: false,
      baseTexture: false,
      ...options,
    });
  }
}
