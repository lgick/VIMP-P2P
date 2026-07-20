import sounds from './sounds.js';

// Игровая половина клиентского CONFIG_DATA: сущности рендера, канвасы,
// keyset игрока, схемы panel/stat, тексты chat/vote/gameInform. Движковые
// дефолты — src/config/clientDefaults.js; merge выполняет buildClientConfig
// (в этапе 6 этот объект соберёт HostPlugin.buildClientGameConfig).
export default {
  // ***** parts ***** //
  parts: {
    // распределение данных в заданные классы
    gameSets: {
      c1: ['Map', 'MapRadar'],
      c2: ['Map'],
      m1: ['Tank', 'TankRadar', 'Smoke', 'Tracks'],
      w1: ['ShotEffect'],
      w2: ['Bomb'],
      w2e: ['ExplosionEffect'],
    },
    // отображение классов на полотнах
    entitiesOnCanvas: {
      Map: 'vimp',
      MapRadar: 'radar',
      TankRadar: 'radar',
      Tank: 'vimp',
      ShotEffect: 'vimp',
      Bomb: 'vimp',
      ExplosionEffect: 'vimp',
      Smoke: 'vimp',
      Tracks: 'vimp',
    },

    // ассеты, которые должны быть "запечены" (созданы один раз) при старте игры
    bakedAssets: {
      vimp: [
        {
          // id доступа к текстуре и название функции "запекания"
          name: 'explosionTexture',
          component: 'ExplosionEffect', // компонент, которому назначен ассет
          params: {
            radius: 50, // радиус круга
            blur: 2, // сила размытия
            color: 0xffffff, // цвет (белый для удобного tinting)
          },
        },
        {
          name: 'impactParticleTexture',
          component: 'ShotEffect',
          params: {
            radius: 4,
            blur: 1,
            color: 0xffffff,
          },
        },
        {
          name: 'funnelTexture',
          component: 'ExplosionEffect',
          params: {
            baseRadius: 25,
            irregularity: 5,
            blur: 40,
            numPoints: 12,
          },
        },
        {
          name: 'smokeTexture',
          component: 'Smoke',
          params: {
            radius: 3, // базовый радиус частицы дыма
            blur: 1, // размытие для мягкости
            color: 0xffffff, // цвет для последующего tint'а
          },
        },
        {
          name: 'tankTexture',
          component: 'Tank',
          params: {
            colors: {
              teamId1: 0x552222,
              teamId2: 0x225522,
            },
          },
        },
        {
          name: 'bombTexture',
          component: 'Bomb',
          params: {
            colorOuter: 0xffffff,
            colorInner: 0x0f0f0f,
          },
        },
        {
          name: 'trackMarkTexture',
          component: 'Tracks',
          params: {
            width: 4,
            length: 5,
            color: 0x1a1a12,
          },
        },
      ],
      radar: [
        {
          name: 'tankRadarTexture',
          component: 'TankRadar',
          params: {
            radius: 6,
            borderWidth: 2,
            crossSize: 9,
            crossThickness: 1.5,
            colors: {
              teamId1: 0x552222,
              teamId2: 0x225522,
            },
          },
        },
      ],
    },

    // карта зависимостей компонентов
    componentDependencies: {
      // Map требует сервис renderer
      renderer: ['Map'],
      // компоненты использующие звук
      soundManager: ['ExplosionEffect', 'ShotEffect', 'Bomb', 'Tank'],
    },

    // звуковые ассеты
    sounds,
  },

  initIdList: ['vimp', 'radar', 'panel', 'chat'],

  // ***** modules ***** //
  modules: {
    canvasManager: {
      // полотна создаёт main.js из этого конфига (canvas#<id> в DOM);
      // width/height — стартовый размер до первого resize
      canvases: {
        vimp: {
          width: 960,
          height: 600,
          aspectRatio: '16:9',
          baseScale: '5:1',
          dynamicCamera: true,
          shakeCamera: true,
        },
        radar: {
          width: 150,
          height: 150,
          fixSize: '150',
          baseScale: '1:8',
        },
      },
    },

    controls: {
      keySetList: [
        // spectator keyset
        {
          78: 'nextPlayer', // next player (n)
          80: 'prevPlayer', // prev player (p)
        },
        // player keyset
        {
          87: 'forward', // forward (w)
          83: 'back', // back (s)
          65: 'left', // left (a)
          68: 'right', // right (d)
          85: 'gunCenter', // gun center (u)
          75: 'gunLeft', // gun left (k)
          76: 'gunRight', // gun right (l)
          74: 'fire', // fire (j)
          78: 'nextWeapon', // next weapon (n)
          80: 'prevWeapon', // prev weapon (p)
        },
      ],
    },

    chat: {
      params: {
        messages: {
          // teams/status
          s: [
            'Team {0} is full. Your current team: {1}', // 0
            'Your team: {0}', // 1
            'Your new team: {0}', // 2
            'Your new status: spectator', // 3
            '⚔️  {0} killed {1}', // 4
            '⚡ {0} joined the game', // 5
            '👋  {0} left the game', // 6
          ],
          // vote
          v: [
            'A vote has been created',
            'Voting has started',
            'Your vote has been accepted',
            'Voting is temporarily unavailable',
            'Vote passed',
            'Vote failed',
          ],
          // map
          m: ['Current map: {0}', 'Next map: {0}'],
          // command
          c: ['Command not found'],
          // name
          n: ['Invalid name', '{0} changed name to {1}'],
          // bots
          b: [
            'Only active players can use /bot',
            'Invalid bot count',
            'Invalid team name',
            '{0} bot(s) created for {1}',
            'All bots removed from {0}',
            '{0} bot(s) created',
            'All bots removed',
          ],
        },
      },
    },

    panel: {
      keys: {
        t: 'time',
        h: 'health',
        wa: 'activeWeapon',
        w1: 'bullet',
        w2: 'bomb',
      },
      // схема DOM панели: PanelView генерирует ячейки в порядке fields;
      // семантику задаёт type ('bar'|'value'|'time'|'weapon'), не имя поля
      fields: [
        { name: 'health', elem: 'panel-health', type: 'bar', max: 100, blocks: 30 },
        { name: 'bullet', elem: 'panel-bullet', type: 'weapon' },
        { name: 'bomb', elem: 'panel-bomb', type: 'weapon' },
        { name: 'time', elem: 'panel-time', type: 'time' },
      ],
    },

    stat: {
      params: {
        // подписи колонок scoreboard (StatView генерирует шапку и таблицы)
        columns: ['names', 'status', 'score', 'deaths', 'latency'],
        heads: {
          1: 'team1',
          2: 'team2',
        },
        bodies: {
          1: 'team1',
          2: 'team2',
          3: 'spectators',
        },
        sortList: {
          team1: [
            [2, true],
            [3, false],
          ],
          team2: [
            [2, true],
            [3, false],
          ],
        },
      },
    },

    vote: {
      params: {
        templates: {
          teamChange: ['Choose a team', 'teams', true],
          mapChangeBySystem: ['Choose the next map'],
          mapChangeByUser: ['{0} suggested the map: {1}', ['Yes', 'No']],
          createBotsForTeam: [
            '{0} suggests creating {1} bot(s) to {2}. Agree?',
            ['Yes', 'No'],
          ],
          removeBotsForTeam: [
            '{0} suggests removing all bots from {1}. Agree?',
            ['Yes', 'No'],
          ],
          createBots: [
            '{0} suggests creating {1} bot(s) to the game. Agree?',
            ['Yes', 'No'],
          ],
          removeBots: [
            '{0} suggests removing all bots from the game. Agree?',
            ['Yes', 'No'],
          ],
        },
        menu: [
          ['teamChange', ['Switch team', 'teams']],
          ['mapChange', ['Suggest map', 'maps']],
        ],
      },
    },
  },

  // game information
  gameInform: {
    list: ['{0} WINS!', 'ROUND START!', 'GAME OVER!'],
  },
};
