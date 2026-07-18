import { Sprite } from 'pixi.js';

export default class TrackMark extends Sprite {
  constructor(x, y, rotation, width, length, initialAlpha, texture) {
    super(texture);

    this.anchor.set(0.5);

    this.x = x;
    this.y = y;
    this.rotation = rotation;
    this.width = length;
    this.height = width;
    this.alpha = initialAlpha; // начальная прозрачность
    this._initialAlpha = initialAlpha; // сохранение для расчетов

    this._elapsedTime = 0;

    // время в ms, за которое сегмент следа полностью исчезнет
    // рандомность, чтобы следы исчезали не все одновременно
    this._fadeDuration = 1800 + Math.random() * 700;
  }

  // обновляет состояние следа
  // вызывается извне классом Tracks
  // deltaMs - время, прошедшее с последнего кадра
  // возвращает true, если жизненный цикл следа завершен
  update(deltaMs) {
    this._elapsedTime += deltaMs;
    const progress = Math.min(this._elapsedTime / this._fadeDuration, 1);

    // альфа изменяется от сохраненной начальной альфы до 0
    this.alpha = (1 - progress) * this._initialAlpha;

    return progress >= 1;
  }
}
