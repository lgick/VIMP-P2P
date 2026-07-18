import { Sprite } from 'pixi.js';
import BaseEffect from '../BaseEffect.js';
import { lerp, randomRange } from '@vimp/engine/lib/math.js';

// диаметр "запеченной" текстуры частицы
// рассчитывается как (radius + blur) * 2 из client.js (4 + 1) * 2 = 10
const BAKED_PARTICLE_DIAMETER = 10;

export default class ImpactEffect extends BaseEffect {
  constructor(x, y, impactDirectionX, impactDirectionY, onComplete, assets) {
    super(onComplete);

    this.x = x; // координата X центра эффекта
    this.y = y; // координата Y центра эффекта

    this._assets = assets;
    this._particleTexture = this._assets.impactParticleTexture;

    this.config = {
      particleCount: randomRange(2, 4), // количество осколков
      particleMinSize: 1, // минимальный размер осколка
      particleMaxSize: 3, // максимальный размер осколка

      // начальная скорость разлета
      minInitialSpeed: 10, // пикселей в секунду
      maxInitialSpeed: 300, // пикселей в секунду

      // жизненный цикл осколков
      minLifetime: 8000, // мс
      maxLifetime: 15000, // мс

      color: [0x333333, 0x222222, 0x444444], // массив цветов для осколков

      fadeOutStart: 0.8, // начинать угасание, когда прошло 70% времени жизни

      // управление направлением разлета
      impactDirectionX, // компонента X базового направления отлета
      impactDirectionY, // компонента Y
      spreadAngle: 60, // угол разброса в градусах

      // параметры для управления движением и остановкой
      // коэффициент сопротивления (чем выше, тем быстрее остановка)
      dragCoefficient: 13,
      // порог скорости, ниже которого частица считается "остановившейся"
      minSpeedThreshold: 1.0,
      // сколько времени частица лежит неподвижно перед угасанием (мс)
      lingerDuration: 6000,
    };

    // обработка случая, когда impactDirection (0,0) - например, выстрел в точку
    // в этом случае частицы разлетятся во все стороны
    if (
      this.config.impactDirectionX === 0 &&
      this.config.impactDirectionY === 0
    ) {
      this.useOmnidirectionalSpread = true; // флаг для разлета во все стороны
    } else {
      this.useOmnidirectionalSpread = false;
    }

    this.particlesData = []; // хранение данные для управления логикой
    this.elapsedTime = 0;

    this._createParticles();
  }

  _createParticles() {
    let baseAngleRad;

    if (!this.useOmnidirectionalSpread) {
      baseAngleRad = Math.atan2(
        this.config.impactDirectionY,
        this.config.impactDirectionX,
      );
    }

    const spreadAngleRad = this.config.spreadAngle * (Math.PI / 180);
    const halfSpreadRad = spreadAngleRad / 2;

    for (let i = 0, len = this.config.particleCount; i < len; i += 1) {
      let particleAngle;

      if (this.useOmnidirectionalSpread) {
        particleAngle = Math.random() * Math.PI * 2;
      } else {
        particleAngle =
          baseAngleRad + randomRange(-halfSpreadRad, halfSpreadRad);
      }

      const initialSpeed = randomRange(
        this.config.minInitialSpeed,
        this.config.maxInitialSpeed,
      );

      // спрайт для частицы
      const sprite = new Sprite(this._particleTexture);
      sprite.anchor.set(0.5);

      const particleData = {
        sprite, // ссылка на спрайт
        x: 0,
        y: 0,
        vx: Math.cos(particleAngle) * initialSpeed,
        vy: Math.sin(particleAngle) * initialSpeed,
        size: randomRange(
          this.config.particleMinSize,
          this.config.particleMaxSize,
        ),
        color: Array.isArray(this.config.color)
          ? this.config.color[
              Math.floor(Math.random() * this.config.color.length)
            ]
          : this.config.color,
        lifetime: randomRange(this.config.minLifetime, this.config.maxLifetime),
        age: 0,
        alpha: 1.0,
        active: true,
        isMoving: true,
        timeSinceStopped: 0,
      };

      // начальный цвет
      sprite.tint = particleData.color;

      this.particlesData.push(particleData);
      this.addChild(sprite);
    }
  }

  _update(deltaMs) {
    if (this.isComplete) {
      return;
    }

    this.elapsedTime += deltaMs;
    const deltaSeconds = deltaMs / 1000;
    let activeParticlesCount = 0;

    for (let i = 0, len = this.particlesData.length; i < len; i += 1) {
      const pData = this.particlesData[i];

      if (!pData.active) {
        continue;
      }

      activeParticlesCount += 1;
      pData.age += deltaMs;

      if (pData.isMoving) {
        // сопротивление среды (drag)
        const speed = Math.hypot(pData.vx, pData.vy);

        if (speed > 0) {
          const dragForceMagnitude =
            speed * this.config.dragCoefficient * deltaSeconds;

          const speedReductionFactor = Math.max(
            0,
            1 - dragForceMagnitude / speed,
          );

          pData.vx *= speedReductionFactor;
          pData.vy *= speedReductionFactor;
        }

        pData.x += pData.vx * deltaSeconds;
        pData.y += pData.vy * deltaSeconds;

        const currentSpeed = Math.hypot(pData.vx, pData.vy);

        // если частица остановилась
        if (currentSpeed < this.config.minSpeedThreshold) {
          pData.isMoving = false;
          pData.vx = 0;
          pData.vy = 0;
        }
        // частица остановилась
      } else {
        pData.timeSinceStopped += deltaMs;
      }

      // логика угасания и завершения жизни
      const currentLifetimeProgress = pData.age / pData.lifetime;

      if (
        !pData.isMoving &&
        pData.timeSinceStopped >= this.config.lingerDuration
      ) {
        // ускоренное угасание после остановки и задержки
        const timeIntoFade =
          pData.timeSinceStopped - this.config.lingerDuration;
        // угасание за короткое время, например, 1 секунда после lingerDuration
        const quickFadeDuration = Math.min(
          500,
          pData.lifetime * (1 - this.config.fadeOutStart),
        );
        pData.alpha = lerp(
          1.0,
          0.0,
          Math.min(timeIntoFade / quickFadeDuration, 1.0),
        );
      } else if (currentLifetimeProgress >= this.config.fadeOutStart) {
        // стандартное угасание по lifetime
        const timeIntoFade =
          pData.age - pData.lifetime * this.config.fadeOutStart;
        const fadeDuration = pData.lifetime * (1 - this.config.fadeOutStart);
        pData.alpha =
          fadeDuration > 0
            ? lerp(1.0, 0.0, Math.min(timeIntoFade / fadeDuration, 1.0))
            : 0.0;
      }

      if (pData.age >= pData.lifetime || pData.alpha < 0.01) {
        pData.active = false; // частица неактивна
        pData.alpha = 0; // полностью прозрачна
      }

      // обновление спрайта
      const pSprite = pData.sprite;

      pSprite.position.set(pData.x, pData.y);
      pSprite.alpha = pData.alpha;
      pSprite.visible = pData.active;

      const scale = pData.size / BAKED_PARTICLE_DIAMETER;

      pSprite.scale.set(scale);
    }

    if (activeParticlesCount === 0 && this._isStarted) {
      this._completeEffect();
    }
  }

  destroy(options) {
    this.particlesData = [];
    super.destroy(options);
  }
}
