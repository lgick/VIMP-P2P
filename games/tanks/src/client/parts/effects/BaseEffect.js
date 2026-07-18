import { Container, Ticker } from 'pixi.js';

export default class BaseEffect extends Container {
  constructor(onCompleteCallback) {
    super();

    this._tickListener = null;
    this._isStarted = false;
    this.isComplete = false;
    this.onComplete = onCompleteCallback;
  }

  run() {
    if (this.isComplete || this._isStarted) {
      return;
    }

    this._isStarted = true;
    this._tickListener = ticker => this._update(ticker.deltaMS);
    Ticker.shared.add(this._tickListener);

    this._onEffectStart();

    // если эффект не был завершен сразу в _onEffectStart
    // начальный вызов для немедленной отрисовки/установки состояния
    if (!this.isComplete) {
      this._update(0);
    }
  }

  // хук для дополнительной логики старта в наследниках
  // по умолчанию ничего не делает, может быть переопределен
  _onEffectStart() {}

  // этот метод должен быть переопределен в классах-наследниках
  _update() {}

  _completeEffect() {
    if (this.isComplete) {
      return;
    }

    this.isComplete = true;

    if (this._tickListener) {
      Ticker.shared.remove(this._tickListener);
      this._tickListener = null;
    }

    if (typeof this.onComplete === 'function') {
      this.onComplete();
    }
  }

  destroy(options) {
    this.isComplete = true;

    if (this._tickListener) {
      Ticker.shared.remove(this._tickListener);
      this._tickListener = null;
    }

    if (this.parent) {
      this.parent.removeChild(this);
    }

    // уничтожение дочерних элементов по умолчанию, но не текстур,
    // т.к. они могут быть общими
    super.destroy({
      children: true,
      texture: false,
      baseTexture: false,
      ...options,
    });
  }
}
