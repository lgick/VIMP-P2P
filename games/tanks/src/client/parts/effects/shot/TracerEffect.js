import { Graphics } from 'pixi.js';
import BaseEffect from '../BaseEffect.js';
import { lerp, clamp } from '@vimp/engine/lib/math.js';

export default class TracerEffect extends BaseEffect {
  constructor(startX, startY, endX, endY, onComplete) {
    super(onComplete);

    this.startPositionX = startX;
    this.startPositionY = startY;
    this.endPositionX = endX;
    this.endPositionY = endY;

    this.config = {
      // цвет трассера
      color: 0xffff99,
      // начальная прозрачность "головы" трассера
      alphaStart: 1,
      // конечная прозрачность "головы" трассера (когда она достигнет цели)
      alphaEnd: 0.6,
      // фиксированная максимальная длина видимой части хвоста трассера в px
      trailLength: 55,
      // желаемая скорость "головы" трассера в px/second
      tracerSpeed: 19000,
      // минимальная длительность анимации в миллисекундах
      minDuration: 45,
      // максимальная длительность анимации в миллисекундах
      maxDuration: 80,
      // коэффициент для скорости укорачивания хвоста
      // (чем больше, тем быстрее хвост укорачивается к концу пути)
      trailShrinkPower: 1.0,
      // начало появления трассера
      // на этом расстоянии от дула (начальной точки) в px
      trailStartOffset: 30,
      // количество сегментов (кругов), из которых состоит линия трассера
      segmentCount: 12,
      // толщина трассера (радиус каждого сегмента)
      segmentRadius: 1,
      // частота пульсации прозрачности (чем выше, тем чаще пульсирует)
      alphaPulseFrequency: 0.1,
      // амплитуда пульсации прозрачности (насколько сильно меняется альфа)
      alphaPulseAmplitude: 0.15,
    };

    this.graphics = new Graphics();
    this.addChild(this.graphics);

    this.elapsedTime = 0; // время, прошедшее с начала анимации

    // расчет вектора направления и дистанции
    this.dx = this.endPositionX - this.startPositionX;
    this.dy = this.endPositionY - this.startPositionY;

    // общая дистанция полета трассера
    this.totalDist = Math.hypot(this.dx, this.dy);

    // нормализация вектора направления
    if (this.totalDist > 0.001) {
      this.nx = this.dx / this.totalDist;
      this.ny = this.dy / this.totalDist;

      this.animationDuration =
        (this.totalDist / this.config.tracerSpeed) * 1000;
      // иначе, если дистанция очень мала (выстрел в ту же точку)
    } else {
      this.nx = 0;
      this.ny = 0;
      this.totalDist = 0;

      this.animationDuration = this.config.minDuration;
    }

    this.animationDuration = Math.max(
      this.config.minDuration,
      this.animationDuration,
    );

    this.animationDuration = Math.min(
      this.config.maxDuration,
      this.animationDuration,
    );

    if (this.animationDuration <= 0) {
      this.animationDuration = this.config.minDuration;
    }
  }

  _drawSegment(x, y, radius, color, alpha) {
    this.graphics.circle(x, y, radius);
    this.graphics.fill({
      color,
      alpha: clamp(alpha, 0, 1),
    });
  }

  _update(deltaMs) {
    if (this.isComplete) {
      // проверка из BaseEffect
      return;
    }

    this.elapsedTime += deltaMs;
    this.graphics.clear();

    const tracerDrawProgress = Math.min(
      this.elapsedTime / this.animationDuration,
      1.0,
    );

    if (tracerDrawProgress > 0) {
      const headX = lerp(
        this.startPositionX,
        this.endPositionX,
        tracerDrawProgress,
      );

      const headY = lerp(
        this.startPositionY,
        this.endPositionY,
        tracerDrawProgress,
      );

      const baseTracerAlpha = lerp(
        this.config.alphaStart,
        this.config.alphaEnd,
        tracerDrawProgress,
      );

      const pulse =
        Math.sin(this.elapsedTime * this.config.alphaPulseFrequency) *
        this.config.alphaPulseAmplitude;
      let currentTracerAlpha = baseTracerAlpha + pulse;

      currentTracerAlpha = clamp(currentTracerAlpha, 0, this.config.alphaStart);

      const shrinkProgress = Math.pow(
        tracerDrawProgress,
        this.config.trailShrinkPower,
      );

      const currentMaxAllowedTrailLength = lerp(
        this.config.trailLength,
        0,
        shrinkProgress,
      );

      // расстояние, которое прошла голова от начальной точки
      const distCoveredByHead = this.totalDist * tracerDrawProgress;

      // если голова еще не прошла отступ trailStartOffset, не рисуем трассер
      if (distCoveredByHead >= this.config.trailStartOffset) {
        let adjustedDistCoveredByHead = distCoveredByHead;

        if (this.totalDist > 0.001) {
          // применяем отступ только если есть направление
          // дистанция, пройденная головой от *эффективной* начальной точки
          adjustedDistCoveredByHead = Math.max(
            0,
            distCoveredByHead - this.config.trailStartOffset,
          );
        }

        // фактическая видимая длина хвоста, отсчитываемая от effectiveStart
        const actualVisibleTrailLength = Math.min(
          adjustedDistCoveredByHead,
          currentMaxAllowedTrailLength,
        );

        let tailX, tailY;
        // хвост отсчитывается от головы назад на actualVisibleTrailLength
        // если actualVisibleTrailLength = 0, хвост будет в голове
        if (this.totalDist > 0.001) {
          tailX = headX - this.nx * actualVisibleTrailLength;
          tailY = headY - this.ny * actualVisibleTrailLength;
        } else {
          // выстрел в точку
          tailX = headX;
          tailY = headY;
        }

        const trailLineLength = Math.hypot(headX - tailX, headY - tailY);

        if (
          trailLineLength < this.config.segmentRadius * 0.5 &&
          this.totalDist === 0
        ) {
          this._drawSegment(
            headX,
            headY,
            this.config.segmentRadius,
            this.config.color,
            currentTracerAlpha,
          );
        } else if (trailLineLength >= this.config.segmentRadius * 0.5) {
          const numSegments = Math.max(1, this.config.segmentCount);
          for (let i = 0; i < numSegments; i++) {
            let t = 0.5;
            if (numSegments > 1) {
              t = i / (numSegments - 1);
            }

            const segmentX = lerp(tailX, headX, t);
            const segmentY = lerp(tailY, headY, t);
            const segmentAlphaFactor = lerp(1.0, 0.8, t);

            this._drawSegment(
              segmentX,
              segmentY,
              this.config.segmentRadius,
              this.config.color,
              currentTracerAlpha * segmentAlphaFactor,
            );
          }
        }
      }
    }

    if (this.elapsedTime >= this.animationDuration) {
      this.graphics.clear(); // очищаем графику перед вызовом onComplete
      this._completeEffect(); // метод из BaseEffect
    }
  }

  destroy(options) {
    // если graphics существует, требуется clear
    if (this.graphics) {
      this.graphics.clear();
    }

    // BaseEffect по умолчанию использует
    // { children: true, texture: false, baseTexture: false }
    // для Graphics-объектов это подходит
    super.destroy(options);
  }
}
