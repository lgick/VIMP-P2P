import { Graphics, Container, Rectangle } from 'pixi.js';

// создает набор текстур для танка
// (нормальное состояние для команд и уничтоженное)
// params.colors - Объект с цветами для команд
// renderer - PIXI рендерер
export default function tankTexture(params, renderer) {
  const { colors } = params;
  const textures = {};

  // фиксированный размер
  const _size = 10;
  const _width = _size * 4;
  const _height = _size * 3;

  const baseColor = 0xeeeeee;

  // генерация текстур для живого танка
  const createLiveTankTextures = color => {
    const bodyGraphics = new Graphics();
    const gunGraphics = new Graphics();

    // рисование корпуса (body)
    const bodyWidth = _width;
    const bodyHeight = _height;

    bodyGraphics
      .rect(-bodyWidth / 2, -bodyHeight / 2, bodyWidth, bodyHeight)
      .fill(0x555555)
      .rect(
        -bodyWidth / 2 + 1,
        -bodyHeight / 2 + 1,
        bodyWidth - 2,
        bodyHeight - 2,
      )
      .fill(0x999999)
      .rect(
        -bodyWidth / 2 + 2,
        -bodyHeight / 2 + 2,
        bodyWidth - 4,
        bodyHeight - 4,
      )
      .fill(0xcccccc)
      .rect(
        -bodyWidth / 2 + 3,
        -bodyHeight / 2 + 3,
        bodyWidth - 6,
        bodyHeight - 6,
      )
      .fill(baseColor);

    // рисование пушки (gun)
    gunGraphics
      .moveTo(1.33 * _size, -0.42 * _size)
      .lineTo(0.42 * _size, -1 * _size)
      .lineTo(-0.42 * _size, -1 * _size)
      .lineTo(-1.33 * _size, -0.42 * _size)
      .lineTo(-1.33 * _size, 0.42 * _size)
      .lineTo(-0.42 * _size, 1 * _size)
      .lineTo(0.42 * _size, 1 * _size)
      .lineTo(1.33 * _size, 0.42 * _size)
      .closePath()
      .fill(color)
      .stroke({ width: 0.17 * _size, color: 0xaaaaaa })
      .moveTo(2.33 * _size, -0.25 * _size)
      .lineTo(0.25 * _size, -0.25 * _size)
      .lineTo(0.25 * _size, 0.25 * _size)
      .lineTo(2.33 * _size, 0.25 * _size)
      .closePath()
      .stroke({ width: 0.17 * _size, color: 0xaaaaaa })
      .fill(color);

    // генерация текстур нормального состояния
    const bodyBounds = bodyGraphics.getBounds();
    const bodyTexture = renderer.generateTexture({
      target: bodyGraphics,
      frame: new Rectangle(
        bodyBounds.x,
        bodyBounds.y,
        bodyBounds.width,
        bodyBounds.height,
      ),
    });

    const gunBounds = gunGraphics.getBounds();
    const gunTexture = renderer.generateTexture({
      target: gunGraphics,
      frame: new Rectangle(
        gunBounds.x,
        gunBounds.y,
        gunBounds.width,
        gunBounds.height,
      ),
    });

    // вычисление якоря для пушки
    // gunBounds.x - это смещение левого края текстуры
    // относительно (0,0) Graphics.
    const gunAnchor = {
      x: -gunBounds.x / gunBounds.width,
      y: -gunBounds.y / gunBounds.height,
    };

    bodyGraphics.destroy(true);
    gunGraphics.destroy(true);

    return {
      body: bodyTexture,
      gun: gunTexture,
      gunAnchor,
    };
  };

  // генерация текстуры для уничтоженного состояния
  const createDestroyedTankTexture = () => {
    const destroyedContainer = new Container();
    const destroyedBody = new Graphics();
    const destroyedGun = new Graphics();

    destroyedContainer.addChild(destroyedBody, destroyedGun);

    const bodyColorDark = 0x3a3a3a;
    const bodyColorDarker = 0x252525;
    const gunColorDark = 0x303030;
    const damageColor = 0x181818;
    const edgeColor = 0x505050;

    const w = _width;
    const h = _height;
    const s = _size;

    // поврежденный корпус
    destroyedBody
      .moveTo(-w / 2 - s * 0.1, -h / 2 + s * 0.2)
      .lineTo(w / 2 + s * 0.2, -h / 2 - s * 0.1)
      .lineTo(w / 2 - s * 0.1, h / 2 + s * 0.3)
      .lineTo(-w / 2 + s * 0.3, h / 2 - s * 0.2)
      .closePath()
      .fill(bodyColorDark)
      .stroke({ width: s * 0.2, color: edgeColor, alignment: 0.5 });

    destroyedBody
      .moveTo(-w / 2 + s * 0.4, -h / 2 + s * 0.5)
      .lineTo(w / 2 - s * 0.3, -h / 2 + s * 0.2)
      .lineTo(w / 2 - s * 0.4, h / 2 - s * 0.1)
      .lineTo(-w / 2 + s * 0.2, h / 2 - s * 0.4)
      .closePath()
      .fill(bodyColorDarker);

    destroyedBody.circle(w * 0.15, h * 0.1, s * 1.2).fill(damageColor);

    destroyedBody.circle(-w * 0.3, -h * 0.25, s * 0.5).fill(damageColor);

    // поврежденная башня
    destroyedGun.position.set(s * 0.3, -s * 0.2);

    const gunBasePoints = [
      s * 1.1,
      -s * 0.7,
      s * 0.2,
      -s * 1.0,
      -s * 0.6,
      -s * 0.9,
      -s * 1.3,
      -s * 0.2,
      -s * 1.1,
      s * 0.6,
      -s * 0.2,
      s * 1.0,
      s * 0.7,
      s * 0.8,
      s * 1.3,
      s * 0.1,
    ];

    destroyedGun
      .poly(gunBasePoints)
      .fill(gunColorDark)
      .stroke({ width: s * 0.15, color: edgeColor, alignment: 0 });

    const barrelPoints = [
      s * 0.8,
      -s * 0.25,
      s * 1.5,
      -s * 0.4,
      s * 1.4,
      s * 0.15,
      s * 0.7,
      s * 0.05,
    ];

    destroyedGun
      .poly(barrelPoints)
      .fill(gunColorDark)
      .stroke({ width: s * 0.1, color: edgeColor, alignment: 0 });

    destroyedGun.circle(s * 0.1, -s * 0.2, s * 0.4).fill(damageColor);

    // генерация единой текстуры для уничтоженного состояния
    const destroyedBounds = destroyedContainer.getBounds();
    const destroyedTexture = renderer.generateTexture({
      target: destroyedContainer,
      frame: new Rectangle(
        destroyedBounds.x,
        destroyedBounds.y,
        destroyedBounds.width,
        destroyedBounds.height,
      ),
    });

    destroyedContainer.destroy({ children: true });

    return destroyedTexture;
  };

  // создание текстур для каждой команды и состояния
  textures.liveTeamId1 = createLiveTankTextures(colors.teamId1);
  textures.liveTeamId2 = createLiveTankTextures(colors.teamId2);
  textures.destroyed = createDestroyedTankTexture();

  return textures;
}
