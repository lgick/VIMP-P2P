import { Sprite } from 'pixi.js';
import SmokeEffect from './SmokeEffect.js';
import BaseEffect from '../BaseEffect.js';

// константы для _createFunnelSprite
const FUNNEL_SPRITE_BASE_RADIUS_PX = 50;
const FUNNEL_SPRITE_TARGET_DIAMETER_UNITS = 15;

export default class FunnelEffect extends BaseEffect {
  constructor(x, y, onComplete, assets) {
    super(onComplete);

    this._assets = assets;
    this.x = x;
    this.y = y;
    this._funnelDurationMs = 20000;
    this._funnelFadeDurationMs = 4000;
    this._elapsedMs = 0;
    this._isFading = false;
    this._smokeDurationMs = 4000; // время дыма
    this._smokeSpawningStopped = false;

    this._funnel = this._createFunnelSprite();
    this._smoke = new SmokeEffect(this._assets);

    this.addChild(this._funnel, this._smoke);
  }

  _createFunnelSprite() {
    const funnelTexture = this._assets.funnelTexture;

    const funnelSprite = new Sprite(funnelTexture);
    funnelSprite.anchor.set(0.5);
    funnelSprite.tint = 0x3a3a3a;

    const scale =
      FUNNEL_SPRITE_TARGET_DIAMETER_UNITS / (FUNNEL_SPRITE_BASE_RADIUS_PX * 2);
    funnelSprite.scale.set(scale);

    return funnelSprite;
  }

  _onEffectStart() {
    // переопределение хука из BaseEffect
    // на случай, если в базовом классе появится логика
    super._onEffectStart();
    if (this._smoke) {
      this._smoke.run();
    }
  }

  _update(deltaMs) {
    if (this.isComplete) {
      return;
    }

    this._elapsedMs += deltaMs;

    // если время дыма закончилось
    if (
      !this._smokeSpawningStopped &&
      this._elapsedMs >= this._smokeDurationMs
    ) {
      this._smoke.stopSpawning();
      this._smokeSpawningStopped = true;
    }

    const timeLeft = this._funnelDurationMs - this._elapsedMs;

    if (timeLeft <= this._funnelFadeDurationMs) {
      if (!this._isFading) {
        this._isFading = true;
      }

      const fadeProgress = timeLeft / this._funnelFadeDurationMs;

      this._funnel.alpha = Math.max(0, fadeProgress);
    }

    if (timeLeft <= 0) {
      this._completeEffect(); // метод из BaseEffect
    }
  }

  destroy(options) {
    // уничтожение эффекта перед super.destroy()
    if (this._smoke) {
      this._smoke.destroy();
      this._smoke = null;
    }

    this._funnel = null;

    super.destroy(options);
  }
}
