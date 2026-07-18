const dynamicBaseDefenses = [];
const step = 32;

// создает линию из динамических блоков (ящиков)
const createDefenseLine = (startX, startY, count, isVertical) => {
  for (let i = 0; i < count; i += 1) {
    const position = isVertical
      ? [startX * step, (startY + i) * step]
      : [(startX + i) * step, startY * step];

    dynamicBaseDefenses.push({
      density: 100,
      layer: 3,
      position,
      angle: 0,
      img: 'b1.png',
      width: 32,
      height: 32,
      linearDamping: 5.0,
      angularDamping: 14.0,
    });
  }
};

// L-образная стена с разрывом
// база 1 (верхний левый угол)
// верхний левый сегмент (10 блоков)
createDefenseLine(30, 2, 10, true); // вертикальная
createDefenseLine(2, 30, 10, false); // горизонтальная
// нижний правый сегмент (9 блоков)
createDefenseLine(30, 22, 9, true); // вертикальная
createDefenseLine(22, 30, 9, false); // горизонтальная

const end = 120;
const wallPos = 30;
// база 2 (нижний правый угол)
// верхний левый сегмент (10 блоков)
createDefenseLine(end - wallPos - 1, end - 12, 10, true); // вертикальная
createDefenseLine(end - 12, end - wallPos - 1, 10, false); // горизонтальная
// нижний правый сегмент (9 блоков)
createDefenseLine(end - wallPos - 1, end - 31, 9, true); // вертикальная
createDefenseLine(end - 31, end - wallPos - 1, 9, false); // горизонтальная

export default {
  setId: 'c1',

  spriteSheet: {
    img: 'tiles3.png',
    frames: [
      [96, 0, 32, 32], // бетон
      [32, 32, 32, 32], // трава
      [64, 32, 32, 32], // ограждения
      [0, 96, 32, 32], // вода
    ],
  },

  layers: {
    1: [0, 1, 2], // слои под танком
    4: [3], // слой над танком (вода в оазисе)
  },

  step: 32,

  physicsStatic: [2], // препятствия

  physicsDynamic: [...dynamicBaseDefenses],

  respawns: {
    team1: [
      [320, 320, 45],
      [320, 480, 45],
      [320, 640, 45],
      [480, 320, 45],
      [480, 480, 45],
      [480, 640, 45],
      [640, 320, 45],
      [640, 480, 45],
      [640, 640, 45],
      [800, 400, 45],
    ],
    team2: [
      [3520, 3520, 225],
      [3520, 3360, 225],
      [3520, 3200, 225],
      [3360, 3520, 225],
      [3360, 3360, 225],
      [3360, 3200, 225],
      [3200, 3520, 225],
      [3200, 3360, 225],
      [3200, 3200, 225],
      [3040, 3440, 225],
    ],
  },

  map: (function () {
    const width = 120;
    const height = 120;
    const tiles = { stone: 0, grass: 1, wall: 2, water: 3 };

    const map = Array.from({ length: height }, () =>
      Array(width).fill(tiles.grass),
    );

    const drawBorder = () => {
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          if (y === 0 || y === height - 1 || x === 0 || x === width - 1) {
            map[y][x] = tiles.wall;
          }
        }
      }
    };

    const placeRocks = (cx, cy, radius, density = 0.5) => {
      for (let y = cy - radius; y <= cy + radius; y += 1) {
        for (let x = cx - radius; x <= cx + radius; x += 1) {
          if (
            x > 0 &&
            x < width - 1 &&
            y > 0 &&
            y < height - 1 &&
            Math.sqrt((x - cx) ** 2 + (y - cy) ** 2) <= radius
          ) {
            if (Math.random() < density) {
              map[y][x] = tiles.wall;
            }
          }
        }
      }
    };

    drawBorder();

    const oasisCx = Math.floor(width / 2);
    const oasisCy = Math.floor(height / 2);
    const oasisRadius = 22;

    for (let y = oasisCy - oasisRadius; y <= oasisCy + oasisRadius; y += 1) {
      for (let x = oasisCx - oasisRadius; x <= oasisCx + oasisRadius; x += 1) {
        if (Math.sqrt((x - oasisCx) ** 2 + (y - oasisCy) ** 2) <= oasisRadius) {
          map[y][x] = tiles.stone;
        }
      }
    }
    for (let y = oasisCy - 10; y <= oasisCy + 10; y += 1) {
      for (let x = oasisCx - 10; x <= oasisCx + 10; x += 1) {
        if (Math.sqrt((x - oasisCx) ** 2 + (y - oasisCy) ** 2) <= 10) {
          map[y][x] = tiles.water;
        }
      }
    }

    // деревья на карте для укрытий
    placeRocks(35, 85, 12, 0.7);
    placeRocks(85, 35, 12, 0.7);
    placeRocks(20, 60, 8, 0.6);
    placeRocks(60, 20, 8, 0.6);
    placeRocks(width - 20, height - 60, 8, 0.6);
    placeRocks(width - 60, height - 20, 8, 0.6);

    return map;
  })(),
};
