import { Graphics, Rectangle } from 'pixi.js';

// создает текстуру для сегмента следа от гусеницы
// params.width - Ширина сегмента
// params.length - Длина сегмента
// params.color - Цвет заливки
// renderer - PIXI рендерер
export default function trackMarkTexture(params, renderer) {
  const { width, length, color } = params;
  const graphics = new Graphics();

  // рисуем один сегмент
  graphics.rect(0, 0, length, width).fill(color);

  const texture = renderer.generateTexture({
    target: graphics,
    frame: new Rectangle(0, 0, length, width),
  });

  graphics.destroy(true);

  return texture;
}
