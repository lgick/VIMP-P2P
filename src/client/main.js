import './style.css';
import { Application, Ticker } from 'pixi.js';
import InputListener from './InputListener.js';
import AuthModel from './components/model/Auth.js';
import AuthView from './components/view/Auth.js';
import AuthCtrl from './components/controller/Auth.js';
import CanvasManagerModel from './components/model/CanvasManager.js';
import CanvasManagerView from './components/view/CanvasManager.js';
import CanvasManagerCtrl from './components/controller/CanvasManager.js';
import ControlsModel from './components/model/Controls.js';
import ControlsView from './components/view/Controls.js';
import ControlsCtrl from './components/controller/Controls.js';
import GameModel from './components/model/Game.js';
import GameView from './components/view/Game.js';
import GameCtrl from './components/controller/Game.js';
import ChatModel from './components/model/Chat.js';
import ChatView from './components/view/Chat.js';
import ChatCtrl from './components/controller/Chat.js';
import PanelModel from './components/model/Panel.js';
import PanelView from './components/view/Panel.js';
import PanelCtrl from './components/controller/Panel.js';
import StatModel from './components/model/Stat.js';
import StatView from './components/view/Stat.js';
import StatCtrl from './components/controller/Stat.js';
import VoteModel from './components/model/Vote.js';
import VoteView from './components/view/Vote.js';
import VoteCtrl from './components/controller/Vote.js';
import Factory from '../lib/factory.js';
import { formatMessage } from '../lib/formatters.js';
import { sanitizeMessage } from '../lib/sanitizers.js';
import { unpackFrame } from '../lib/snapshotCodec.js';
import { validateAuth } from '../lib/validators.js';
import SoundManager from './SoundManager.js';
import SnapshotInterpolator from './SnapshotInterpolator.js';
import TankPredictor from './TankPredictor.js';
import ShotPredictor from './ShotPredictor.js';
import SignalingClient from './network/SignalingClient.js';
import WebRtcManager from './network/WebRtcManager.js';
import LobbyModel from './components/model/Lobby.js';
import LobbyView from './components/view/Lobby.js';
import LobbyCtrl from './components/controller/Lobby.js';
import BakingProvider from './providers/BakingProvider.js';
import DependencyProvider from './providers/DependencyProvider.js';
import wsports from '../config/wsports.js';
import lobbyConfig from '../config/lobby.js';
import parts from './parts/index.js';

// PS (server ports): порты получения данные от сервера
const PS_CONFIG_DATA = wsports.server.CONFIG_DATA;
const PS_AUTH_DATA = wsports.server.AUTH_DATA;
const PS_AUTH_RESULT = wsports.server.AUTH_RESULT;
const PS_MAP_DATA = wsports.server.MAP_DATA;
const PS_FIRST_SHOT_DATA = wsports.server.FIRST_SHOT_DATA;
const PS_SHOT_DATA = wsports.server.SHOT_DATA;
const PS_SOUND_DATA = wsports.server.SOUND_DATA;
const PS_GAME_INFORM_DATA = wsports.server.GAME_INFORM_DATA;
const PS_TECH_INFORM_DATA = wsports.server.TECH_INFORM_DATA;
const PS_MISC = wsports.server.MISC;
const PS_PING = wsports.server.PING;
const PS_CLEAR = wsports.server.CLEAR;
const PS_CONSOLE = wsports.server.CONSOLE;
const PS_PANEL_DATA = wsports.server.PANEL_DATA;
const PS_STAT_DATA = wsports.server.STAT_DATA;
const PS_CHAT_DATA = wsports.server.CHAT_DATA;
const PS_VOTE_DATA = wsports.server.VOTE_DATA;
const PS_KEYSET_DATA = wsports.server.KEYSET_DATA;

// PC (client ports): порты получения данных от клиента
const PC_CONFIG_READY = wsports.client.CONFIG_READY;
const PC_AUTH_RESPONSE = wsports.client.AUTH_RESPONSE;
const PC_MODULES_READY = wsports.client.MODULES_READY;
const PC_MAP_READY = wsports.client.MAP_READY;
const PC_FIRST_SHOT_READY = wsports.client.FIRST_SHOT_READY;
const PC_KEYS_DATA = wsports.client.KEYS_DATA;
const PC_CHAT_DATA = wsports.client.CHAT_DATA;
const PC_VOTE_DATA = wsports.client.VOTE_DATA;
const PC_PONG = wsports.client.PONG;

// сигнальный WebSocket мастера (лобби + установка P2P); игровой трафик идёт
// по WebRTC (transport), не через мастер
const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const signaling = new SignalingClient(`${wsProtocol}//${location.host}/`);

// активное P2P-соединение с хостом (создаётся при выборе сервера в лобби)
let transport = null;

const modules = {};

// создание и инициализация SoundManager
const soundManager = new SoundManager();
let soundData = {};

const inputListener = new InputListener();

let modulesConfig = {};
let initIdList = [];
const apps = {};

let gameInformer = null;
let gameInformList = []; // массив игровых сообщений

const techInformer = document.getElementById('tech-informer');
let techInformList = []; // массив системных сообщений

const CTRL = {}; // контроллеры
let gameSets = {}; // наборы конструкторов (id: [наборы])
let entitiesOnCanvas = {}; // сущности, отображаемые на полотнах
let currentMapSetId; // текущий id набора конструкторов для карт
const socketMethods = []; // методы для обработки сокет-данных

// буфер snapshot-интерполяции (создаётся при получении конфига)
let interpolator = null;

// предикшен своего танка (создаётся при получении конфига)
let predictor = null;

// визуальный спавн снарядов своего танка (создаётся при получении конфига)
let shotPredictor = null;
let inputSeq = 0; // номер отправленного ввода (KEYS_DATA)
let myGameId = null; // id своего танка (из player-блока кадра)
let myModelName = null; // модель своего танка (из формы авторизации)
let myTankMeta = null; // последние дискретные поля своего танка из снапшота

// SOCKET МЕТОДЫ

// config data
socketMethods[PS_CONFIG_DATA] = async data => {
  gameSets = data.parts.gameSets;
  entitiesOnCanvas = data.parts.entitiesOnCanvas;

  interpolator = new SnapshotInterpolator(data.interpolation);

  // конфиг предикшена добавляет серверный bootstrap (src/server/main.js)
  if (data.prediction) {
    predictor = new TankPredictor(data.prediction);
    shotPredictor = new ShotPredictor(data.prediction);
  }

  // инициализация сущностей игры
  for (const entity of Object.keys(entitiesOnCanvas)) {
    Factory.add({ [entity]: parts[entity] });
  }

  gameInformer = document.getElementById(data.gameInform.id);
  gameInformList = data.gameInform.list;

  techInformList = data.techInformList;

  modulesConfig = data.modules;
  initIdList = data.initIdList;

  const bakedAssets = data.parts.bakedAssets || {};
  const componentDependencies = data.parts.componentDependencies || {};
  soundData = data.parts.sounds || {};

  // создание полотен игры
  const initPromises = Object.keys(modulesConfig.canvasManager.canvases).map(
    async canvasId => {
      const canvas = document.getElementById(canvasId);
      const app = new Application();
      const assetProvider = new BakingProvider();
      const dependencyProvider = new DependencyProvider();
      const bakingArr = bakedAssets[canvasId];

      await app.init({
        canvas,
        width: canvas.width,
        height: canvas.height,
        antialias: true,
        backgroundAlpha: 0,
        accessibilityOptions: {
          activateOnTab: false,
        },
      });

      // пул всех доступных сервисов в этом контексте
      const availableServices = {
        renderer: app.renderer,
        soundManager,
      };

      // если есть данные для запекания компонентов
      if (bakingArr) {
        assetProvider.bakeAll(bakingArr, app);
      }

      dependencyProvider.collectAll(availableServices, componentDependencies);

      CTRL[canvasId] = makeGameController(
        assetProvider.getAssetsCollection(),
        dependencyProvider.getDependenciesCollection(),
        app,
      );

      apps[canvasId] = app;
    },
  );

  Promise.all(initPromises)
    .then(() => {
      sending(PC_CONFIG_READY); // config ready
    })

    .catch(err => {
      console.error('Initialization error:', err);
    });
};

// auth data
socketMethods[PS_AUTH_DATA] = data => {
  if (typeof data !== 'object' || data === null) {
    return;
  }

  const { elems, params } = data;

  params.forEach(param => {
    const { storage } = param.options;

    if (storage) {
      param.value = localStorage[storage] || param.value || '';
    }
  });

  const clientValidator = authData => validateAuth(authData, params);

  const authModel = new AuthModel(clientValidator);
  const authView = new AuthView(authModel, elems);
  modules.auth = new AuthCtrl(authModel, authView);

  authModel.publisher.on('socket', data => {
    // модель танка пользователя — для реплик движения и выстрелов
    myModelName = data.model;
    predictor?.setModel(data.model);
    shotPredictor?.setModel(data.model);

    sending(PC_AUTH_RESPONSE, data);
  });

  modules.auth.init(params);
};

// auth errors
socketMethods[PS_AUTH_RESULT] = async err => {
  modules.auth.parseRes(err);

  if (!err) {
    await soundManager.init(soundData);
    runModules(modulesConfig);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    for (const id of initIdList) {
      const elem = document.getElementById(id);

      if (elem) {
        elem.style.display = 'block';
      }
    }

    sending(PC_MODULES_READY);
  }
};

// map data
socketMethods[PS_MAP_DATA] = data => {
  const { scale, layers, map, step, setId, spriteSheet, physicsStatic } = data;

  interpolator.reset();
  predictor?.reset();
  shotPredictor?.setMap(data);

  // удаление данных карт
  const removeMap = setId => {
    const nameArr = gameSets[setId] || [];

    nameArr.forEach(name => {
      CTRL[entitiesOnCanvas[name]].remove(name);
    });
  };

  // создание карт
  const createMap = (setId, staticData) => {
    const nameArr = gameSets[setId];
    const dynamicArr = data.physicsDynamic || [];
    const dynamicData = {};

    dynamicArr.forEach((item, index) => {
      const key = `d${index}`;
      dynamicData[key] = { ...item, type: 'dynamic', scale };
    });

    nameArr.forEach(name => {
      const canvasId = entitiesOnCanvas[name];

      // статические данные карты
      CTRL[canvasId].parse(name, staticData);

      // динамические данные карты
      CTRL[canvasId].parse(name, dynamicData);
    });

    currentMapSetId = setId;
  };

  const staticData = Object.entries(layers).reduce(
    (acc, [layer, tiles], index) => {
      acc[`s${index}`] = {
        type: 'static',
        spriteSheet,
        map,
        step,
        layer,
        tiles,
        physicsStatic,
        scale,
      };

      return acc;
    },
    {},
  );

  removeMap(currentMapSetId);
  createMap(setId, staticData);
  sending(PC_MAP_READY);
};

// первый shot сразу после загрузки карты (JSON; порт 5 идёт бинарным путём);
// применяется немедленно (создание сущностей), в буфер интерполяции не пушится
socketMethods[PS_FIRST_SHOT_DATA] = data => {
  const [game, camera] = data;

  applyShot(game, camera);

  // подтверждение получения первого шота
  sending(PC_FIRST_SHOT_READY);
};

// panel data
socketMethods[PS_PANEL_DATA] = data => {
  modules.panel.update(data);
  shotPredictor?.syncPanel(data);
};

// stat data
socketMethods[PS_STAT_DATA] = data => {
  modules.stat.update(data);
};

// chat data
socketMethods[PS_CHAT_DATA] = data => {
  modules.chat.add(data);
};

// vote data
socketMethods[PS_VOTE_DATA] = data => {
  modules.vote.open(data);
};

// keyset data (смена режима спектатор/игрок)
socketMethods[PS_KEYSET_DATA] = keySet => {
  modules.controls.changeKeySet(keySet);
  predictor?.setActive(keySet === 1);
  shotPredictor?.reset();
};

// sound data
socketMethods[PS_SOUND_DATA] = sample => {
  soundManager.playSystemSound(sample);
};

// game inform data
socketMethods[PS_GAME_INFORM_DATA] = data => {
  if (data) {
    const [key, arr] = data;

    gameInformer.textContent = formatMessage(gameInformList[key], arr);
    gameInformer.style.display = 'block';

    setTimeout(() => {
      gameInformer.textContent = '';
      gameInformer.style.display = 'none';
    }, 3000);
  }
};

// technical inform data
socketMethods[PS_TECH_INFORM_DATA] = data => {
  if (data) {
    let message;

    if (Array.isArray(data)) {
      const [key, arr] = data;

      message = formatMessage(techInformList[key], arr) || 'Unknown error';
    } else {
      message = data;
    }

    modules.controls?.disableKeys();
    techInformer.textContent = message;
    techInformer.style.display = 'block';
  } else {
    modules.controls?.enableKeys();
    techInformer.textContent = '';
    techInformer.style.display = 'none';
  }
};

// misc
socketMethods[PS_MISC] = data => {
  const { key, value } = data;

  if (key === 'localstorageNameReplace') {
    localStorage['userName'] = value;
  }
};

// ping
socketMethods[PS_PING] = pingId => {
  sending(PC_PONG, pingId);
};

// clear
socketMethods[PS_CLEAR] = function (setIdList) {
  // если есть список setId (учитывается в том числе пустой список)
  if (Array.isArray(setIdList)) {
    for (let i = 0, len = setIdList.length; i < len; i += 1) {
      const nameArr = gameSets[setIdList[i]] || [];

      nameArr.forEach(name => {
        CTRL[entitiesOnCanvas[name]].remove(name);
      });
    }
  } else {
    for (const p in CTRL) {
      if (Object.hasOwn(CTRL, p)) {
        CTRL[p].remove();
      }
    }
  }

  interpolator.reset();
  predictor?.reset();
  shotPredictor?.reset();
  soundManager.reset();
};

// console
socketMethods[PS_CONSOLE] = data => {
  console.log(data);
};

// ФУНКЦИИ

// применяет игровые данные к сущностям
function applyGameData(game) {
  Object.entries(game).forEach(([p, instances]) => {
    const nameArr = gameSets[p];

    nameArr.forEach(name => {
      CTRL[entitiesOnCanvas[name]].parse(name, instances);
    });
  });
}

// применяет данные камеры (позиция слушателя звука + полотно)
function applyCamera(camera) {
  if (camera && camera !== 0) {
    soundManager.setListenerPosition(camera[0], camera[1]);
    modules.canvasManager.updateCoords(camera);
  }
}

// применяет кадр целиком (первый кадр и дискретные кадры интерполяции)
function applyShot(game, camera) {
  applyGameData(game);
  applyCamera(camera);
}

// отслеживает свой танк в дискретном кадре: дискретные поля для предикшена,
// заморозка при уничтожении, сброс предикта при reset камеры
function trackOwnTank(frame) {
  if (!predictor) {
    return;
  }

  // reset камеры (respawn/телепорт/смена наблюдения) → сброс предсказания
  if (frame.camera !== 0 && frame.camera[2] === true) {
    predictor.reset();
  }

  if (myGameId === null || !myModelName) {
    return;
  }

  const ownData = frame.game[myModelName]?.[myGameId];

  if (ownData === null) {
    myTankMeta = null; // танк удалён с полотна
  } else if (ownData) {
    myTankMeta = [ownData[7], ownData[8], ownData[9]];
    predictor.freeze(ownData[7] === 0); // танк уничтожен — предикт заморожен
  }
}

// рендер-тик: проигрывает пересечённые кадры (события, создания/удаления),
// применяет интерполированные позиции/камеру и перекрывает свой танк
// предсказанным состоянием
function renderTick() {
  const now = performance.now();
  const { frames, game, camera } = interpolator.sample(now);

  shotPredictor?.setServerOffset(interpolator.offset);

  frames.forEach(frame => {
    trackOwnTank(frame);

    // серверные дубли локально заспавненных выстрелов подавляются
    const frameGame = shotPredictor
      ? shotPredictor.filterServerSnapshot(frame.game, myGameId, now)
      : frame.game;

    applyShot(frameGame, frame.camera);
    shotPredictor?.updateWorld(frameGame);
  });

  if (game) {
    applyGameData(game);
    shotPredictor?.updateWorld(game);
  }

  predictor?.update(now);

  const predicted = predictor?.getRenderState() ?? null;

  if (predicted && myGameId !== null && myTankMeta) {
    // свой танк рендерится предсказанным состоянием поверх интерполяции
    applyGameData({
      [myModelName]: {
        [myGameId]: [
          predicted.x,
          predicted.y,
          predicted.angle,
          predicted.gunRotation,
          predicted.vx,
          predicted.vy,
          predicted.engineLoad,
          ...myTankMeta,
        ],
      },
    });

    // камера следует предсказанному танку (reset/shake — дискретными кадрами)
    applyCamera([predicted.x, predicted.y]);
  } else {
    applyCamera(camera);
  }

  soundManager.processAudibility();
  soundManager.updateActiveSounds();
}

// создает пользователя
function runModules(data) {
  const {
    canvasManager: canvasManagerData,
    controls: controlsData,
    chat: chatData,
    panel: panelData,
    stat: statData,
    vote: voteData,
  } = data;

  //==========================================//
  // CanvasManager Module
  //==========================================//

  const canvasManagerModel = new CanvasManagerModel(canvasManagerData);

  const canvasManagerView = new CanvasManagerView(canvasManagerModel, apps);

  modules.canvasManager = new CanvasManagerCtrl(
    canvasManagerModel,
    canvasManagerView,
  );
  modules.canvasManager.resize({
    width: innerWidth,
    height: innerHeight,
  });

  //==========================================//
  // Controls Module
  //==========================================//

  const controlsModel = new ControlsModel(controlsData);
  const controlsView = new ControlsView(controlsModel);

  modules.controls = new ControlsCtrl(controlsModel, controlsView);
  modules.controls.resetCursorHideTimer();

  //==========================================//
  // Chat Module
  //==========================================//

  const chatModel = new ChatModel({
    listLimit: chatData.params.listLimit,
    lineTime: chatData.params.lineTime,
    cacheMin: chatData.params.cacheMin,
    cacheMax: chatData.params.cacheMax,
    messages: chatData.params.messages,
    sanitizeMessage,
    formatMessage,
  });

  const chatView = new ChatView(chatModel, chatData.elems);

  modules.chat = new ChatCtrl(chatModel, chatView);

  //==========================================//
  // Panel Module
  //==========================================//

  const panelModel = new PanelModel(panelData.keys);
  const panelView = new PanelView(panelModel, panelData.elems);

  modules.panel = new PanelCtrl(panelModel, panelView);

  //==========================================//
  // Stat Module
  //==========================================//

  const statModel = new StatModel(statData.params);
  const statView = new StatView(statModel, statData.elems);

  modules.stat = new StatCtrl(statModel, statView);

  //==========================================//
  // Vote Module
  //==========================================//

  const voteModel = new VoteModel({ ...voteData.params, formatMessage });
  const voteView = new VoteView(voteModel, voteData.elems);

  modules.vote = new VoteCtrl(voteModel, voteView);

  //==========================================//
  // Подписка на события
  //==========================================//

  // событие активации режима
  controlsModel.publisher.on('mode', openMode);

  // подписка на данные от пользователя для режимов
  controlsModel.publisher.on('chat', modules.chat.updateCmd.bind(modules.chat));
  controlsModel.publisher.on('stat', modules.stat.close.bind(modules.stat));
  controlsModel.publisher.on('vote', modules.vote.assignKey.bind(modules.vote));

  inputListener.publisher.on(
    'keyDown',
    modules.controls.add.bind(modules.controls),
  );
  inputListener.publisher.on(
    'keyUp',
    modules.controls.remove.bind(modules.controls),
  );
  inputListener.publisher.on(
    'mouseAction',
    modules.controls.resetCursorHideTimer.bind(modules.controls),
  );
  inputListener.publisher.on(
    'resize',
    modules.canvasManager.resize.bind(modules.canvasManager),
  );

  chatModel.publisher.on(
    'mode',
    modules.controls.switchMode.bind(modules.controls),
  );
  statModel.publisher.on(
    'mode',
    modules.controls.switchMode.bind(modules.controls),
  );
  voteModel.publisher.on(
    'mode',
    modules.controls.switchMode.bind(modules.controls),
  );

  controlsModel.publisher.on('socket', data => {
    // формат wire: 'seq:action:name' (seq — подтверждение ввода сервером)
    const [action, name] = data.split(':');
    const now = performance.now();

    inputSeq = (inputSeq + 1) >>> 0;
    predictor?.applyInput(action, name, now);

    // визуальный спавн своего выстрела и локальная смена оружия
    // (только живой танк: myTankMeta[0] — condition)
    if (
      action === 'down' &&
      shotPredictor &&
      predictor?.hasState &&
      myTankMeta &&
      myTankMeta[0] !== 0
    ) {
      if (name === 'fire') {
        const spawn = shotPredictor.tryFire(
          predictor.getRenderState(),
          myGameId,
          now,
        );

        if (spawn) {
          applyGameData(spawn);
        }
      } else if (name === 'nextWeapon' || name === 'prevWeapon') {
        shotPredictor.cycleWeapon(name === 'prevWeapon');
      }
    }

    sending(PC_KEYS_DATA, `${inputSeq}:${data}`);
  });
  chatModel.publisher.on('socket', data => sending(PC_CHAT_DATA, data));
  voteModel.publisher.on('socket', data => sending(PC_VOTE_DATA, data));

  //==========================================//
  // Рендер-цикл интерполяции
  //==========================================//

  Ticker.shared.add(renderTick);
}

// создает экземпляр игры
function makeGameController(assetsCollection, dependenciesCollection, app) {
  const model = new GameModel(assetsCollection, dependenciesCollection);
  const view = new GameView(model, app);
  const controller = new GameCtrl(model, view);

  return controller;
}

// открывает режим
function openMode(mode) {
  if (modules[mode]) {
    modules[mode].open();
  }
}

// отправляет данные хосту (весь клиентский протокол — по надёжному каналу meta)
function sending(name, data) {
  transport?.send(JSON.stringify([name, data]));
}

// распаковывает данные
function unpacking(pack) {
  return JSON.parse(pack);
}

// обработчик видимости вкладки
function handleVisibilityChange() {
  // если вкладка неактивна, выключение звука
  if (document.visibilityState === 'hidden') {
    soundManager.mute();
    // иначе включение звука при возвращении
  } else {
    soundManager.unmute();
  }
}

// ДАННЫЕ ОТ ХОСТА (WebRTC-транспорт)

// обрабатывает входящий пакет: ArrayBuffer → кадр снапшота, строка → JSON-порт
function handleMessage(data) {
  // бинарный кадр (snapshot, порт SHOT_DATA) — в буфер интерполяции
  if (data instanceof ArrayBuffer) {
    const frame = unpackFrame(data);

    if (frame && frame.port === PS_SHOT_DATA) {
      const now = performance.now();

      interpolator.push(
        frame.snapshot,
        frame.camera,
        frame.serverTime,
        now,
        frame.seq,
      );

      // authoritative-состояние своего танка → reconciliation предикшена
      if (frame.player && predictor) {
        myGameId = frame.player.gameId;
        predictor.onServerState(
          frame.player,
          frame.serverTime,
          interpolator.offset,
          now,
        );
      }
    }

    return;
  }

  // JSON-сообщение [portId, payload]
  const msg = unpacking(data);

  socketMethods[msg[0]](msg[1]);
}

// разрыв P2P: выход хоста = смерть комнаты (host-migration нет). Останавливаем
// рендер, показываем заглушку и возвращаемся в лобби перезагрузкой
function handleDisconnect() {
  Ticker.shared.remove(renderTick);

  for (const id in apps) {
    if (Object.hasOwn(apps, id)) {
      apps[id].stop();
    }
  }

  document.removeEventListener('visibilitychange', handleVisibilityChange);
  soundManager.destroy();
  modules.controls?.disableKeys();

  socketMethods[PS_TECH_INFORM_DATA](
    'Host left — the room is closed. Returning to lobby…',
  );

  setTimeout(() => location.reload(), 3000);
}

// БУТСТРАП: лобби и установка P2P через мастер-сервер

let lobby = null;

// устанавливает P2P-соединение с выбранным хостом и уходит из лобби
function connectToHost(hostId) {
  transport = new WebRtcManager(signaling, {
    iceServers: signaling.iceServers,
  });

  transport.publisher.on('message', handleMessage);
  transport.publisher.on('close', handleDisconnect);
  transport.connect(hostId);

  lobby.close();
}

// REST-запрос списка серверов у мастера (поиск игнорирует пагинацию)
async function fetchServers({ offset, limit, search }) {
  const params = new URLSearchParams();

  if (search) {
    params.set('search', search);
  } else {
    params.set('offset', offset);
    params.set('limit', limit);
  }

  try {
    const res = await fetch(`${lobbyConfig.serversUrl}?${params}`);

    return res.ok ? await res.json() : null;
  } catch (e) {
    return null;
  }
}

// поднимает лобби после welcome от мастера (iceServers уже получены)
function initLobby() {
  const lobbyModel = new LobbyModel(lobbyConfig);
  const lobbyView = new LobbyView(lobbyModel, lobbyConfig.elems);

  lobby = new LobbyCtrl(lobbyModel, lobbyView);

  // список серверов — REST-запросом к мастеру
  lobbyModel.publisher.on('fetch', async query => {
    const list = await fetchServers(query);

    if (list) {
      lobbyModel.setList(list, query.append);
    }
  });

  // умный пинг видимого сервера — сигнальным путём (замер приблизительный)
  lobbyModel.publisher.on('ping-request', ({ hostId, pingId }) => {
    signaling.pingHost(hostId, pingId);
  });

  signaling.publisher.on('pong_host', msg => {
    lobbyModel.resolvePong(msg.pingId, performance.now());
  });

  // выбор сервера → установка P2P
  lobbyModel.publisher.on('join', connectToHost);

  lobby.open();
}

signaling.publisher.on('welcome', initLobby);
signaling.connect();
