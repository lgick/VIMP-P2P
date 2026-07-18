import { Graphics, Rectangle } from 'pixi.js';

// создает текстуру для бомбы
// params.colorOuter - Цвет внешней рамки
// params.colorInner - Цвет внутренней заливки
// renderer - PIXI рендерер
export default function bombTexture(params, renderer) {
  const { colorOuter, colorInner } = params;
  const graphics = new Graphics();

  // базовый размер
  const size = 20;
  const borderWidth = 1;

  // внешний контур
  graphics.rect(0, 0, size, size).fill(colorOuter);

  // внутренняя часть
  graphics
    .rect(
      borderWidth,
      borderWidth,
      size - borderWidth * 2,
      size - borderWidth * 2,
    )
    .fill(colorInner);

  const texture = renderer.generateTexture({
    target: graphics,
    frame: new Rectangle(0, 0, size, size),
  });

  graphics.destroy(true);

  return texture;
}
