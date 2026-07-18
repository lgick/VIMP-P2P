export default {
  setId: 'c1',

  scale: 0.2,

  spriteSheet: {
    img: 'tiles3.png',
    frames: [
      [0, 64, 32, 32], // 0: пол
      [0, 192, 32, 32], // 1: стена
      [96, 64, 32, 32], // 2: эффект блиндажа
    ],
  },

  layers: {
    1: [0, 1], // слои под танком
    4: [2], // слой над танком
  },

  step: 32,

  physicsStatic: [1],

  // динамические объекты
  physicsDynamic: (function () {
    const step = 32;
    const dynamicObjectSize = 96;
    const halfSize = dynamicObjectSize / 2;
    const generatedObjects = [];

    const objectSizeInTiles = dynamicObjectSize / step; // 3

    // параметры стены: 1 блок в ширину, 20 в высоту
    const wallWidthInBlocks = 1;
    const wallHeightInBlocks = 20;

    const startX = 104; // центр по горизонтали
    const startY = 45;

    // вертикальный ряд
    for (let y = 0; y < wallHeightInBlocks; y += 1) {
      for (let x = 0; x < wallWidthInBlocks; x += 1) {
        const posX = (startX + x * objectSizeInTiles) * step + halfSize;
        const posY = (startY + y * objectSizeInTiles) * step + halfSize;

        generatedObjects.push({
          density: 20,
          layer: 3,
          position: [posX, posY],
          angle: 0,
          width: dynamicObjectSize,
          height: dynamicObjectSize,
          img: 'b1.png',
          linearDamping: 8.0,
          angularDamping: 16.0,
        });
      }
    }

    return generatedObjects;
  })(),

  respawns: {
    team1: [
      // центральная зона
      [448, 1840, 0],
      [256, 2304, 0],
      [448, 2688, 0],
      [256, 3000, 0],
      // верхняя зона
      [256, 512, 0],
      [448, 832, 0],
      [256, 1152, 0],
      // нижняя зона
      [448, 3648, 0],
      [256, 3968, 0],
      [448, 4288, 0],
    ],
    team2: [
      // центральная зона
      [6272, 1840, 180],
      [6464, 2304, 180],
      [6272, 2688, 180],
      [6464, 3000, 180],
      // верхняя зона
      [6464, 512, 180],
      [6272, 832, 180],
      [6464, 1152, 180],
      // нижняя зона
      [6272, 3648, 180],
      [6464, 3968, 180],
      [6272, 4288, 180],
    ],
  },

  map: (function () {
    const width = 210;
    const height = 150;
    const tiles = { floor: 0, wall: 1, effect: 2 };

    const map = Array.from({ length: height }, () =>
      Array(width).fill(tiles.floor),
    );

    // внешние стены
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (y < 2 || y >= height - 2 || x < 2 || x >= width - 2) {
          map[y][x] = tiles.wall;
        }
      }
    }

    // статические стены
    const buildWall = (x1, y1, x2, y2) => {
      for (let y = y1; y <= y2; y++) {
        for (let x = x1; x <= x2; x++) {
          if (x >= 0 && x < width && y >= 0 && y < height) {
            map[y][x] = tiles.wall;
          }
        }
      }
    };

    // статичные стены
    buildWall(50, 0, 51, 30);
    buildWall(50, height - 31, 51, height - 1);
    buildWall(width - 52, 0, width - 51, 30);
    buildWall(width - 52, height - 31, width - 51, height - 1);
    buildWall(80, 30, 130, 31);
    buildWall(80, height - 32, 130, height - 31);

    // центральный блиндаж
    for (let y = 64; y < 86; y++) {
      for (let x = 2; x < width - 2; x++) {
        if ((x + y) % 2 === 0) {
          map[y][x] = tiles.effect;
        } else {
          map[y][x] = tiles.floor;
        }
      }
    }

    return map;
  })(),
};
