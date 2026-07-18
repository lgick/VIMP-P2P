import { Sprite } from 'pixi.js';
import BaseEffect from '../BaseEffect.js';

const EFFECT_BASE_RADIUS_PX = 50; // базовый радиус для расчета масштаба

export default class ExplosionEffect extends BaseEffect {
  constructor(x, y, radius, onComplete, assets) {
    super(onComplete); // конструктор BaseEffect

    // ассет взрыва
    const explosionTexture = assets.explosionTexture;

    this.x = x;
    this.y = y;
    this._radius = radius;

    this._durationMs = 3000;
    this._elapsedMs = 0;

    // необходимый масштаб спрайта, чтобы он соответствовал радиусу взрыва
    // делить на EFFECT_BASE_RADIUS_PX,
    // так как базовый радиус в текстуре был 50px
    const desiredScale = this._radius / EFFECT_BASE_RADIUS_PX;

    // спрайты
    // основное тело взрыва (голубое)
    this._mainBody = new Sprite(explosionTexture);
    this._mainBody.anchor.set(0.5);
    this._mainBody.tint = 0xadd8e6; // светло-голубой
    this._mainBody.scale.set(desiredScale);

    // коллапсирующее ядро (серое)
    this._core = new Sprite(explosionTexture);
    this._core.anchor.set(0.5);
    this._core.tint = 0xd3d3d3; // светло-серый
    this._core.scale.set(desiredScale); // начальный размер тот же

    this.addChild(this._mainBody, this._core);
  }

  // обновление анимации
  _update(deltaMs) {
    if (this.isComplete) {
      // проверка из BaseEffect
      return;
    }

    this._elapsedMs += deltaMs;

    if (this._elapsedMs <= this._durationMs) {
      const progress = this._elapsedMs / this._durationMs;
      this._draw(progress);
    } else {
      // метод из BaseEffect
      this._completeEffect();
    }
  }

  // отрисовка
  _draw(progress) {
    const easeInQuad = t => t * t;
    const baseScale = this._radius / EFFECT_BASE_RADIUS_PX;

    // анимация основного тела (затухание)
    this._mainBody.alpha = 0.6 * (1 - easeInQuad(progress));

    // анимация ядра (затухание и сжатие)
    const coreProgress = Math.min(1, progress * 1.5);
    this._core.alpha = 0.7 - coreProgress;
    this._core.scale.set(baseScale * (1 - coreProgress));
  }

  // уничтожение объекта
  destroy(options) {
    // вызов destroy из BaseEffect
    super.destroy(options);
  }
}
