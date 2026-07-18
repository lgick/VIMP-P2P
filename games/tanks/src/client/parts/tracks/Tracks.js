import { Container, Ticker } from 'pixi.js';
import TrackMark from './TrackMark.js';
import { normalizeAngle } from '@vimp/engine/lib/math.js';

export default class Tracks extends Container {
  constructor(data, assets) {
    super();
    this.zIndex = 1;

    this._currentX = data[0] || 0;
    this._currentY = data[1] || 0;
    this._currentRotation = data[2] || 0;
    this._engineLoad = data[6] || 0;
    this._condition = data[7];
    this._size = data[8];

    // состояние для расчета дельт и ускорений
    this._prevX = this._currentX;
    this._prevY = this._currentY;
    this._prevRotation = this._currentRotation;
    this._prevSpeed = 0; // предыдущая линейная скорость
    this._prevAngularSpeed = 0; // предыдущая угловая скорость

    this._assets = assets;

    // минимальное время (ms), которое должно пройти между созданием
    // двух последовательных "пачек" следов
    // чем меньше значение, тем больше кол-во следов
    // (создаст больше объектов TrackMark, может повлиять на производительность)
    this._trackMarkCooldown = 2;

    // задержка в ms между созданием последовательных "пачек" следов
    this._lastTrackMarkTime = 0;

    // минимальное изменение линейной скорости, чтобы оставить след
    // скорость измеряется в пикселях за время deltaMs последнего тика
    // при уменьшении значения, следы будут появляться чаще
    // при малейшем маневрировании скоростью
    // (легкий разгон, небольшое торможение)
    this._minAbsAccelerationForMark = 4;

    // минимальная текущая угловая скорость для следов при повороте
    // рекомендуемые значения от 0.02 до 0.06
    // при уменьшении: даже медленные или плавные повороты
    // (при условии достаточной линейной скорости)
    // будут оставлять следы
    this._minAngularSpeedForMark = 0.02;

    // минимальное изменение угловой скорости (угловое ускорение)
    // рекомендуемые значения: 0.01 - 1
    // при уменьшении: танк будет оставлять следы даже
    // при небольших изменениях в скорости поворота
    // при увеличении: следы будут появляться только
    // при очень резком начале или очень резком прекращении вращения
    this._minRotationAccelerationForMark = 0.4;

    // минимальная линейная скорость, чтобы поворот оставлял след
    // рекомендемые значения: min: 0, max: 2
    // при уменьшении: танк будет оставлять следы от поворотов даже
    // при вращении на месте
    // при увеличении: танк должен заметно двигаться вперед или назад,
    // чтобы его повороты оставляли следы
    this._minSpeedForRotationMarks = 1.4;

    // визуальные параметры следов

    // ширина одного сегмента следа
    this._trackWidth = this._size * 0.4;

    // длина одного сегмента следа
    this._trackLength = this._size * 0.5;

    const tankHeight = this._size * 3;

    // расстояние от центральной линии танка до центра каждого из двух следов
    this._trackOffset = (tankHeight / 2) * 0.7;

    // смещение назад точки появления следов от центра танка
    this._backwardOffset = tankHeight * 0.4;

    // начальная прозрачность следа (от 0 до 1), когда он только появляется
    this._trackInitialAlpha = 0.4;

    this._tickListener = ticker => this._internalUpdate(ticker.deltaMS);
    Ticker.shared.add(this._tickListener);
  }

  update(data) {
    this._currentX = data[0];
    this._currentY = data[1];
    this._currentRotation = data[2];
    this._engineLoad = data[6];
    this._condition = data[7];
  }

  _internalUpdate(deltaMs) {
    if (deltaMs <= 0) {
      return;
    }

    // обновление всех существующих следов в одном цикле
    // итерация в обратном порядке,
    // чтобы безопасно удалять элементы из массива this.children
    for (let i = this.children.length - 1; i >= 0; i -= 1) {
      const mark = this.children[i];
      // если возвращается true, значит время жизни вышло
      if (mark.update(deltaMs)) {
        // уничтожение спрайта
        // метод destroy() автоматически удаляет объект
        // из родительского контейнера
        mark.destroy();
      }
    }

    // текущие скорости
    const deltaX = this._currentX - this._prevX;
    const deltaY = this._currentY - this._prevY;

    // текущая линейная скорость (пикселей за время deltaMs)
    const currentSpeed = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

    const rotationDiff = normalizeAngle(
      this._currentRotation - this._prevRotation,
    );

    // текущая угловая скорость (радианы за время deltaMs)
    const currentAngularSpeed = Math.abs(rotationDiff);

    // линейное ускорение/замедление
    // положительное - ускорение, отрицательное - торможение
    const acceleration = currentSpeed - this._prevSpeed;
    const absAcceleration = Math.abs(acceleration);

    // угловое ускорение/замедление
    const angularAcceleration = currentAngularSpeed - this._prevAngularSpeed;
    const absAngularAcceleration = Math.abs(angularAcceleration);

    const currentTime = performance.now();
    let shouldLeaveMark = false;

    // логика принятия решения об оставлении следа
    if (
      this._condition !== 0 &&
      currentTime - this._lastTrackMarkTime > this._trackMarkCooldown
    ) {
      // если резкое изменение линейной скорости (ускорение или торможение)
      if (absAcceleration > this._minAbsAccelerationForMark) {
        shouldLeaveMark = true;
      }

      // если резкий поворот (высокая текущая угловая скорость
      // ИЛИ высокое угловое ускорение)
      // и при этом есть минимальное движение вперед,
      // чтобы не рисовать следы при вращении на месте.
      if (currentSpeed > this._minSpeedForRotationMarks) {
        if (
          currentAngularSpeed > this._minAngularSpeedForMark ||
          absAngularAcceleration > this._minRotationAccelerationForMark
        ) {
          shouldLeaveMark = true;
        }
      }
    }

    // если танк газует, будучи застрявшим (состояние напряжения)
    // engineLoad > 1.0 означает напряжение (strain)
    if (this._engineLoad > 1.0) {
      shouldLeaveMark = true;
    }

    if (shouldLeaveMark) {
      this.createTrackMarksAtPreviousPosition();
      this._lastTrackMarkTime = currentTime;
    }

    // сохранение текущих значений как предыдущих для следующего вызова
    this._prevX = this._currentX;
    this._prevY = this._currentY;
    this._prevRotation = this._currentRotation;
    this._prevSpeed = currentSpeed;
    this._prevAngularSpeed = currentAngularSpeed;
  }

  createTrackMarksAtPreviousPosition() {
    for (let i = -1; i <= 1; i += 2) {
      const sideOffsetX =
        Math.cos(this._prevRotation + Math.PI / 2) * this._trackOffset * i;
      const sideOffsetY =
        Math.sin(this._prevRotation + Math.PI / 2) * this._trackOffset * i;

      const backwardComponentX =
        -Math.cos(this._prevRotation) * this._backwardOffset;
      const backwardComponentY =
        -Math.sin(this._prevRotation) * this._backwardOffset;

      const markX = this._prevX + sideOffsetX + backwardComponentX;
      const markY = this._prevY + sideOffsetY + backwardComponentY;

      const mark = new TrackMark(
        markX,
        markY,
        this._prevRotation,
        this._trackWidth,
        this._trackLength,
        this._trackInitialAlpha,
        this._assets.trackMarkTexture,
      );

      this.addChild(mark);
    }
  }

  _stopTimer() {
    if (this._tickListener) {
      Ticker.shared.remove(this._tickListener);
      this._tickListener = null;
    }
  }

  destroy(options) {
    this._stopTimer();

    super.destroy({
      children: true,
      texture: false,
      baseTexture: false,
      ...options,
    });
  }
}
