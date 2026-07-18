import { Container } from 'pixi.js';
import ExplosionEffect from './ExplosionEffect.js';
import FunnelEffect from './FunnelEffect.js';

export default class ExplosionEffectController extends Container {
  constructor(data, assets, dependencies) {
    super();

    this.originX = data[0];
    this.originY = data[1];
    this.radius = data[2];

    this._assets = assets;
    this._soundManager = dependencies.soundManager;

    this.x = this.originX;
    this.y = this.originY;

    this.explosion = null;
    this.funnel = null;
    this._isDestroyed = false;

    this._soundId = this._soundManager.registerSound('explosion', {
      position: {
        x: this.originX,
        y: this.originY,
      },
    });
  }

  run() {
    if (this._isDestroyed) {
      return;
    }

    const parentContainer = this.parent;

    this.funnel = new FunnelEffect(
      this.originX,
      this.originY,
      this._onFunnelComplete.bind(this),
      this._assets,
    );

    this.funnel.zIndex = 2;
    parentContainer.addChild(this.funnel);

    this.explosion = new ExplosionEffect(
      this.originX,
      this.originY,
      this.radius,
      this._onExplosionComplete.bind(this),
      this._assets,
    );

    this.explosion.zIndex = 4;
    parentContainer.addChild(this.explosion);

    this.funnel.run();
    this.explosion.run();
  }

  _onExplosionComplete() {
    if (this._isDestroyed) {
      return;
    }

    if (this.explosion) {
      this.explosion.destroy();
      this.explosion = null;
    }
  }

  _onFunnelComplete() {
    if (this._isDestroyed) {
      return;
    }

    // когда исчезает воронка (она длится дольше взрыва),
    // уничтожение всего контроллера
    this.destroy();
  }

  destroy() {
    if (this._isDestroyed) {
      return;
    }

    this._isDestroyed = true;

    if (this._soundId) {
      this._soundManager.unregisterSound(this._soundId);
      this._soundId = null;
    }

    if (this.explosion) {
      this.explosion.destroy();
      this.explosion = null;
    }

    if (this.funnel) {
      this.funnel.destroy();
      this.funnel = null;
    }

    if (this.parent) {
      this.parent.removeChild(this);
    }

    super.destroy({
      children: true,
      texture: true,
      baseTexture: true,
    });
  }
}
