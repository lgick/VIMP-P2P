import { Text, Ticker, Container, Sprite } from 'pixi.js';

export default class Bomb extends Container {
  constructor(params, assets, dependencies) {
    super();

    this.zIndex = 2;

    this.body = new Sprite(assets.bombTexture);
    this.body.anchor.set(0.5);

    this.x = params[0];
    this.y = params[1];

    this.rotation = params[2];
    this._size = params[3]; // соотношение сторон 1:1
    this._totalDurationMs = params[4];

    this._soundManager = dependencies.soundManager;
    this._soundId = null;

    // спрайт под нужный размер
    // текстура квадратная
    const textureSize = assets.bombTexture.width;
    const scale = this._size / textureSize;
    this.body.scale.set(scale);

    // фиксированный размер шрифта для рендера текстуры,
    // чтобы текст был четким (векторное качество)
    const renderFontSize = 64;

    // масштаб под размер бомбы
    const fontScale = this._size / 1.2 / renderFontSize;

    this.text = new Text({
      style: {
        fontFamily: 'Arial',
        fontSize: renderFontSize,
        fill: 0xffffff,
        align: 'center',
      },
    });

    this.text.anchor.set(0.5);
    this.text.scale.set(fontScale);
    this.text.x = 0;
    this.text.y = 0;

    // накопленное время с момента создания
    this._accumulatedTimeMs = 0;
    this._secondsLeft = '';

    this.addChild(this.body, this.text);
    this._updateTimerDisplay(this._totalDurationMs);

    this._tickListener = ticker => this._updateTimer(ticker.deltaMS);
    Ticker.shared.add(this._tickListener);

    this._soundId = this._soundManager.registerSound('bombHasBeenPlanted', {
      position: {
        x: this.x,
        y: this.y,
      },
    });
  }

  // обновление таймера и звука
  _updateTimer(deltaMs) {
    this._accumulatedTimeMs += deltaMs;

    const remainingMs = Math.max(
      0,
      this._totalDurationMs - this._accumulatedTimeMs,
    );

    this._updateTimerDisplay(remainingMs);

    if (remainingMs <= 0) {
      this._stopTimer();
      this._updateTimerDisplay(0);
    }
  }

  _updateTimerDisplay(remainingMs) {
    const time = Math.round(remainingMs / 1000);

    if (this._secondsLeft !== time) {
      this._secondsLeft = time;
      this.text.text = `${this._secondsLeft}`;
    }
  }

  update() {}

  _stopTimer() {
    if (this._tickListener) {
      Ticker.shared.remove(this._tickListener);
      this._tickListener = null;
    }
  }

  destroy(options) {
    this._stopTimer();

    if (this._soundId) {
      this._soundManager.unregisterSound(this._soundId);
      this._soundId = null;
    }

    super.destroy({
      children: true,
      texture: false,
      baseTexture: false,
      ...options,
    });

    this.body = null;
    this.text = null;
  }
}
