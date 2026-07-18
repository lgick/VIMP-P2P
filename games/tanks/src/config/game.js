import maps from '../data/maps/index.js';
import models from '../data/models.js';
import weapons from '../data/weapons.js';

// Игровая половина бывшего src/config/game.js: команды, панель, статистика,
// клавиши игрока, карты и баланс. Движковые дефолты хоста —
// src/config/hostDefaults.js; merge выполняет host.worker.js
// (в этапе 6 этот объект станет HostPlugin.gameConfig).
export default {
  parts: {
    models,
    weapons,
    mapConstructor: 'Map', // название конструктора карт
    hitscanService: 'HitscanService', // сервис вычисления стрельбы hitscan
    friendlyFire: false, // огонь по своей команде
  },

  // маппинг движковых событий на имена звуков игры (SocketManager.sendSoundCue)
  soundCues: {
    roundStart: 'roundStart',
    victory: 'victory',
    defeat: 'defeat',
    frag: 'frag',
    death: 'gameOver',
  },

  // голосование, отправляемое игроку после первого кадра (выбор команды)
  initialVote: 'teamChange',

  maps, // карты игры
  mapScale: 0.3, // масштаб карт
  currentMap: 'pool mini', // название карты по умолчанию
  mapsInVote: 4, // количество карт в голосовании
  mapSetId: 'c1', // дефолтный id конструкторов создания карт

  // рамки настроек комнаты в лобби (будущий GameManifest.roomDefaults, этап 6)
  roomDefaults: {
    maxPlayers: 8, // целевой размер комнаты (рамка P2P-плана)
  },

  stat: {
    name: {
      key: 0,
      bodyMethod: '=',
      headSync: true,
      headMethod: '#',
    },
    status: {
      key: 1,
      bodyMethod: '=',
      bodyValue: '',
      headValue: '',
    },
    score: {
      key: 2,
      bodyMethod: '+',
      bodyValue: 0,
      headMethod: '+',
      headValue: 0,
    },
    deaths: {
      key: 3,
      bodyMethod: '+',
      bodyValue: 0,
      headMethod: '+',
      headValue: 0,
    },
    latency: {
      key: 4,
      bodyMethod: '=',
    },
  },

  panel: {
    health: {
      key: 'h',
      value: 100,
    },
    w1: {
      key: 'w1',
      value: 200,
    },
    w2: {
      key: 'w2',
      value: 100,
    },
  },

  spectatorTeam: 'spectators', // название команды наблюдателя

  teams: {
    team1: 1,
    team2: 2,
    spectators: 3,
  },

  // конфигурация клавиш активного игрока
  // type - тип отработки нажатия на клавишу (по умолчанию 0):
  // 0 : многократное нажатие (начинается на keyDown, завершается на keyUp)
  // 1 : выполняется один раз на keyDown
  playerKeys: {
    // forward (w)
    forward: {
      key: 1 << 0,
    },
    // back (s)
    back: {
      key: 1 << 1,
    },
    // left (a)
    left: {
      key: 1 << 2,
    },
    // right (d)
    right: {
      key: 1 << 3,
    },
    // gun center (u)
    gunCenter: {
      key: 1 << 4,
      type: 1,
    },
    // gun left (k)
    gunLeft: {
      key: 1 << 5,
    },
    // gun right (l)
    gunRight: {
      key: 1 << 6,
    },
    // fire (j)
    fire: {
      key: 1 << 7,
      type: 1,
    },
    // next weapon (n)
    nextWeapon: {
      key: 1 << 8,
      type: 1,
    },
    // prev weapon (p)
    prevWeapon: {
      key: 1 << 9,
      type: 1,
    },
  },
};
