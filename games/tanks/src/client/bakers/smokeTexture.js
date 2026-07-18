import { Graphics, BlurFilter, Rectangle } from 'pixi.js';

// создает текстуру размытого круга для частицы дыма танка
// params.radius - Радиус круга
// params.blur - Сила размытия
// params.color - Цвет заливки (обычно белый для tinting)
// renderer - PIXI рендерер
export default function tankSmokeParticleTexture(params, renderer) {
  const { radius, blur, color } = params;
  const graphics = new Graphics();

  graphics.circle(radius + blur, radius + blur, radius);
  graphics.fill(color);

  graphics.filters = [new BlurFilter({ strength: blur, quality: 40 })];

  const texture = renderer.generateTexture({
    target: graphics,
    frame: new Rectangle(0, 0, (radius + blur) * 2, (radius + blur) * 2),
  });

  graphics.destroy(true);

  return texture;
}
