import { Graphics, Rectangle } from 'pixi.js';

// создает набор текстур для отображения танка на радаре
// params.radius - Радиус круга для живого танка
// params.borderWidth - Толщина обводки круга
// params.crossSize - Размер креста для уничтоженного танка
// params.crossThickness - Толщина линий креста
// params.colors - Объект с цветами для команд
// renderer - PIXI рендерер
export default function tankRadarTexture(params, renderer) {
  const { radius, borderWidth, crossSize, crossThickness, colors } = params;
  const textures = {};
  const fullSize = (radius + borderWidth) * 2;
  const center = fullSize / 2;
  const baseColor = 0xeeeeee;
  const destroyedColor = 0x333333;

  // генерация текстуры живого танка
  const createLiveTankTexture = color => {
    const graphics = new Graphics();

    graphics.circle(center, center, radius).fill(baseColor);
    graphics.circle(center, center, radius - borderWidth).fill(color);

    const texture = renderer.generateTexture({
      target: graphics,
      frame: new Rectangle(0, 0, fullSize, fullSize),
    });

    graphics.destroy(true);

    return texture;
  };

  // генерация текстуры уничтоженного танка
  const createDestroyedTankTexture = () => {
    const graphics = new Graphics();
    const halfSize = crossSize / 2;

    graphics
      .moveTo(center - halfSize, center - halfSize)
      .lineTo(center + halfSize, center + halfSize)
      .moveTo(center - halfSize, center + halfSize)
      .lineTo(center + halfSize, center - halfSize)
      .stroke({ width: crossThickness, color: destroyedColor });

    const texture = renderer.generateTexture({
      target: graphics,
      frame: new Rectangle(0, 0, fullSize, fullSize),
    });

    graphics.destroy(true);

    return texture;
  };

  // создание текстур для каждой команды и состояния
  textures.liveTeamId1 = createLiveTankTexture(colors.teamId1);
  textures.liveTeamId2 = createLiveTankTexture(colors.teamId2);
  textures.destroyed = createDestroyedTankTexture();

  return textures;
}
