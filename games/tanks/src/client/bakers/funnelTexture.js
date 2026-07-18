import { Graphics, BlurFilter, Rectangle } from 'pixi.js';
import { randomRange } from '@vimp/engine/lib/math.js';

// создаёт процедурную текстуру размытой кляксы для эффекта воронки
// params.baseRadius - Базовый радиус фигуры.
// params.irregularity - Степень неровности краев.
// params.blur - Сила размытия.
// params.numPoints - Количество точек для построения кривой.
// renderer - Рендерер PIXI.
export default function funnelTexture(params, renderer) {
  const { baseRadius, irregularity, blur, numPoints } = params;

  const graphics = new Graphics();
  const canvasSize = (baseRadius + irregularity + blur) * 2;
  const center = canvasSize / 2;
  const path = [];

  for (let i = 0; i < numPoints; i += 1) {
    const angle = (i / numPoints) * Math.PI * 2;
    const r = baseRadius + randomRange(-irregularity, irregularity);

    path.push(center + r * Math.cos(angle), center + r * Math.sin(angle));
  }

  graphics.poly(path).fill(0xffffff);
  graphics.filters = [new BlurFilter({ strength: blur, quality: 10 })];

  const texture = renderer.generateTexture({
    target: graphics,
    frame: new Rectangle(0, 0, canvasSize, canvasSize),
  });

  graphics.destroy(true);

  return texture;
}
