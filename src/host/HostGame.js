import Panel from '../server/modules/Panel.js';
import Stat from '../server/modules/Stat.js';
import Chat from '../server/modules/chat/index.js';
import Vote from '../server/modules/Vote.js';
import RTTManager from '../server/modules/RTTManager.js';
import TimerManager from '../server/modules/TimerManager.js';
import ParticipantManager from '../server/player/ParticipantManager.js';
import VoteCoordinator from '../server/core/VoteCoordinator.js';
import RoundManager from '../server/core/RoundManager.js';
import CommandProcessor from '../server/core/CommandProcessor.js';
import { sanitizeMessage } from '../lib/sanitizers.js';
import GameCoreAdapter from './GameCoreAdapter.js';
import HostBotManager from './HostBotManager.js';

// Троттлинг отправки кадров (замена SnapshotManager: ядро само копит события
// и дренирует их в pack_body, здесь нужен только контроль частоты).
class SnapshotThrottle {
  constructor(sendRate) {
    this._sendRate = Math.max(1, sendRate || 1);
    this._tick = 0;
  }

  // тик игрового цикла: true — этот кадр отправляем, false — пропуск
  shouldSend() {
    this._tick += 1;

    if (this._tick < this._sendRate) {
      return false;
    }

    this._tick = 0;

    return true;
  }

  // сброс (смена карты) — совместимость с интерфейсом SnapshotManager
  reset() {
    this._tick = 0;
  }
}

// Host-фасад: авторитетная часть матча в Worker'е хоста. Аналог
// src/server/modules/VIMP.js, но симуляция/боты/упаковка снапшотов — в
// Rust-ядре через GameCoreAdapter, мета (RoundManager, участники, чат,
// голосования, статистика, панель) переиспользуется из src/server как есть.
// Питается событиями ядра (adapter._drainEvents → panel/reportKill/shake).
export default class HostGame {
  /**
   * @param {Object} data - конфиг игры (config/game.js).
   * @param {Object} socketManager - транспорт (per-user send/close).
   * @param {GameCore} core - экземпляр WASM-ядра.
   * @param {Object} [opts]
   * @param {string} [opts.hostSocketId] - socketId хоста-игрока (loopback):
   *   исключается из kick-политик — его отключение убивает комнату для всех.
   * @param {Function} [opts.onMapChange] - вызывается с именем карты при её
   *   смене (голосование/таймер) — для актуализации комнаты у мастера.
   */
  constructor(
    data,
    socketManager,
    core,
    { hostSocketId = null, onMapChange = null } = {},
  ) {
    this._isDevMode = data.isDevMode || false;

    this._hostSocketId = hostSocketId;
    this._onMapChange = onMapChange;

    this._maps = data.maps;
    this._mapList = Object.keys(data.maps);
    this._spectatorKeys = data.spectatorKeys;
    this._maxPlayers = data.maxPlayers;
    this._chatMaxLength = data.chatMaxLength;

    this._idleTimeoutForPlayer = data.idleKickTimeout?.player || null;
    this._idleTimeoutForSpectator = data.idleKickTimeout?.spectator || null;

    this._teams = data.teams;
    this._spectatorTeam = data.spectatorTeam;
    this._spectatorId = this._teams[this._spectatorTeam];

    // единый реестр участников (игроки + боты)
    this._participants = new ParticipantManager(
      this._teams,
      this._spectatorTeam,
      this._maxPlayers,
    );

    // симуляция — в ядре; адаптер под интерфейс Game.js
    this._game = new GameCoreAdapter(core, {
      participants: this._participants,
    });

    this._panel = new Panel(data.panel);
    this._stat = new Stat(data.stat, this._teams);
    this._chat = new Chat();
    this._vote = new Vote();

    this._socketManager = socketManager;

    this._snapshotManager = new SnapshotThrottle(data.timers.networkSendRate);

    this._bots = new HostBotManager(
      this._participants,
      this._game,
      this._panel,
      this._stat,
    );

    this._RTTManager = new RTTManager(data.rtt, {
      onKickForMissedPings: gameId => this._kickForMissedPings(gameId),
      onKickForMaxLatency: gameId => this._kickForMaxLatency(gameId),
    });

    this._timerManager = new TimerManager(data.timers, {
      onMapTimeEnd: () => this._roundManager.onMapTimeEnd(),
      onRoundTimeEnd: () => this._roundManager.initiateNewRound(),
      onShotTick: dt => this._onShotTick(dt),
      onIdleCheck: () => this._kickIdleUsers(),
      onSendPing: () => this._sendPing(),
    });

    this._voteCoordinator = new VoteCoordinator({
      vote: this._vote,
      chat: this._chat,
      timerManager: this._timerManager,
    });

    this._roundManager = new RoundManager({
      participants: this._participants,
      game: this._game,
      panel: this._panel,
      stat: this._stat,
      chat: this._chat,
      socketManager: this._socketManager,
      timerManager: this._timerManager,
      bots: this._bots,
      voteCoordinator: this._voteCoordinator,
      snapshotManager: this._snapshotManager,
      teams: this._teams,
      spectatorTeam: this._spectatorTeam,
      spectatorId: this._spectatorId,
      maps: data.maps,
      mapList: this._mapList,
      mapsInVote: data.mapsInVote,
      mapScale: data.mapScale,
      mapSetId: data.mapSetId,
      currentMap: data.currentMap,
    });

    this._commandProcessor = new CommandProcessor({
      participants: this._participants,
      chat: this._chat,
      bots: this._bots,
      roundManager: this._roundManager,
      voteCoordinator: this._voteCoordinator,
      timerManager: this._timerManager,
      teams: this._teams,
      spectatorTeam: this._spectatorTeam,
      spectatorId: this._spectatorId,
      isDevMode: this._isDevMode,
    });

    // инкрементный номер snapshot-кадра
    this._seq = 0;

    // внедрение зависимостей (ядро отдаёт панель/фасад события через адаптер)
    this._socketManager.injectServices(this._game, this._panel, this._stat);
    this._game.injectServices({ vimp: this, panel: this._panel });
    this._panel.injectTimerManager(this._timerManager);

    this._timerManager.startIdleCheckTimer();

    this._roundManager.createMap();

    // отслеживание смены карты (для актуализации комнаты в лобби мастера)
    this._lastReportedMap = this._roundManager.currentMap;
  }

  // комната заполнена (люди + боты) — новые подключения отклоняются
  get isFull() {
    return this._participants.isFull;
  }

  // лимит участников комнаты (для сообщения об отказе)
  get maxPlayers() {
    return this._maxPlayers;
  }

  // хост-игрок не кикается: закрытие его loopback = смерть комнаты для всех
  _isHostPlayer(user) {
    return this._hostSocketId !== null && user.socketId === this._hostSocketId;
  }

  // кикает за задержку в ответе на ping
  _kickForMaxLatency(gameId) {
    const user = this._participants.get(gameId);

    if (user && !this._isHostPlayer(user)) {
      console.warn(`[RTT] Kick ${user.name} — pong latency exceeded`);
      this._socketManager.close(user.socketId, 4003, 'kickForMaxLatency');
      this.removeUser(gameId);
    }
  }

  // кикает за превышение прокусков ответа на ping
  _kickForMissedPings(gameId) {
    const user = this._participants.get(gameId);

    if (user && !this._isHostPlayer(user)) {
      console.warn(`[RTT] Kick ${user.name} — no response to pings`);
      this._socketManager.close(user.socketId, 4004, 'kickForMissedPings');
      this.removeUser(gameId);
    }
  }

  // создаёт кадр игры (core-driven)
  _onShotTick(dt) {
    // шаг ядра + проекция событий (kill/health/ammo/weapon/shake) в мету
    this._game.updateData(dt);

    // контроль частоты отправки
    if (!this._snapshotManager.shouldSend()) {
      return;
    }

    // смена карты (голосование/таймер) — уведомить главный поток
    const currentMap = this._roundManager.currentMap;

    if (currentMap !== this._lastReportedMap) {
      this._lastReportedMap = currentMap;
      this._onMapChange?.(currentMap);
    }

    // список удаляемых с полотна игроков ведёт RoundManager, но null-маркеры
    // в кадр кладёт само ядро (remove_tank) — здесь лишь опустошаем очередь,
    // чтобы она не росла
    const removedPlayersList = this._roundManager.removedPlayersList;

    while (removedPlayersList.length) {
      removedPlayersList.pop();
    }

    const userList = this._participants.getNetworkedReady();
    const panelUpdates = this._panel.processUpdates();
    const stat = this._stat.getLast();
    const chat = this._chat.shift();
    const vote = this._vote.shift();

    const serverTime = Date.now();
    this._seq = (this._seq + 1) >>> 0;
    const seq = this._seq;
    const activeList = this._participants.getActiveList();

    // broadcast-часть кадра пакуется в ядре один раз за тик
    this._game.packBody();

    // событийные блоки тела (трассеры/бомбы/взрывы/удаления) требуют надёжной
    // доставки (WebRTC meta); чисто позиционный кадр идёт по state
    const bodyHasEvents = this._game.bodyHasEvents();

    // вычисляет камеру наблюдения для пользователя
    const getCamera = user => {
      let camera;

      if (user.isWatching === true) {
        if (activeList.length) {
          if (!activeList.includes(user.watchedGameId)) {
            user.watchedGameId = activeList[0];
          }

          camera = this._game.getPosition(user.watchedGameId);
        } else {
          camera = [0, 0];
        }
      } else {
        camera = this._game.getPosition(user.gameId);
      }

      if (user.forceCameraReset === true) {
        camera[2] = true;
        user.forceCameraReset = false;
      }

      if (user.pendingShake) {
        camera[3] = user.pendingShake;
        user.pendingShake = null;
      }

      return camera;
    };

    userList.forEach(user => {
      const gameId = user.gameId;
      const socketId = user.socketId;

      const camera = getCamera(user);

      // player-блок предикшена собирает ядро по playerId (наблюдатель → -1)
      const playerId = user.isWatching === false ? gameId : null;

      // per-user события кадра: forceReset (camera[2]) и shake (camera[3])
      // тоже требуют надёжной доставки
      const reliable =
        bodyHasEvents || camera[2] === true || Boolean(camera[3]);

      this._socketManager.sendShot(
        socketId,
        this._game.packFrame(camera, serverTime, seq, playerId),
        reliable,
      );

      if (panelUpdates[gameId]) {
        this._socketManager.sendPanel(socketId, panelUpdates[gameId]);
      }

      if (stat) {
        this._socketManager.sendStat(socketId, stat);
      }

      const chatUser = chat || this._chat.shiftByUser(gameId);
      if (chatUser) {
        this._socketManager.sendChat(socketId, chatUser);
      }

      const voteUser = vote || this._vote.shiftByUser(gameId);
      if (voteUser) {
        this._socketManager.sendVote(socketId, voteUser);
      }
    });
  }

  // проверяет игроков на бездействие и кикает, если превышен порог
  _kickIdleUsers() {
    const now = Date.now();
    const usersToKick = [];

    for (const user of this._participants.getHumans()) {
      if (user.isReady !== true || this._isHostPlayer(user)) {
        continue;
      }

      const idleThreshold =
        user.teamId === this._spectatorId
          ? this._idleTimeoutForSpectator
          : this._idleTimeoutForPlayer;

      if (idleThreshold !== null) {
        const idleTime = now - user.lastActionTime;

        if (idleTime > idleThreshold) {
          usersToKick.push(user);
        }
      }
    }

    usersToKick.forEach(user => {
      this._socketManager.close(user.socketId, 4005, 'kickIdle');
      this.removeUser(user.gameId);
    });
  }

  // отправляет ping всем пользователям
  _sendPing() {
    const users = this._RTTManager.scheduleNextPing();

    for (const [gameId, { pingIdCounter }] of users) {
      const user = this._participants.get(gameId);

      this._socketManager.sendPing(user.socketId, pingIdCounter);
    }
  }

  // отправляет карту (прокси к RoundManager)
  sendMap(gameId) {
    this._roundManager.sendMap(gameId);
  }

  // сообщает о загрузке карты
  mapReady(gameId) {
    const user = this._participants.get(gameId);

    if (user.currentMap !== this._roundManager.currentMap) {
      this.sendMap(gameId);
      return;
    }

    if (user.isReady === false) {
      this._socketManager.sendFirstShot(user.socketId);
    }
  }

  // сообщает о готовности игрока к игре
  firstShotReady(gameId) {
    const user = this._participants.get(gameId);
    const socketId = user.socketId;

    user.isReady = true;
    this._socketManager.sendTechInform(socketId);
    this._socketManager.sendFirstVote(socketId);
    this._chat.pushSystem('USER_JOINED', [user.name]);
  }

  // обрабатывает уничтожение игрока (прокси к RoundManager; из событий ядра)
  reportKill(victimId, killerId = null) {
    this._roundManager.reportKill(victimId, killerId);
  }

  // обновляет каталог карт (Этап 5.1). Новые данные применяются со следующей
  // смены карты: _maps и _mapList правятся на месте — эти же ссылки держат
  // RoundManager (createMap) и голосования (parseVote 'maps')
  updateMaps(maps) {
    for (const [name, data] of Object.entries(maps)) {
      this._maps[name] = data;
    }

    this._mapList.length = 0;
    this._mapList.push(...Object.keys(this._maps));
  }

  // меняет и возвращает gameId наблюдаемого игрока
  _getNextActivePlayerForUser(gameId, back) {
    const currentId = this._participants.get(gameId)?.watchedGameId;
    const activeList = this._participants.getActiveList();
    let key = activeList.indexOf(currentId);

    if (key !== -1) {
      key = back ? key - 1 : key + 1;

      if (key < 0) {
        key = activeList.length - 1;
      } else if (key >= activeList.length) {
        key = 0;
      }

      return activeList[key];
    }

    return activeList[0] || null;
  }

  // активирует тряску камеры у игрока (из события ядра)
  triggerCameraShake(gameId, shakeParams) {
    const user = this._participants.get(gameId);

    if (user) {
      user.pendingShake = `${shakeParams.intensity}:${shakeParams.duration}`;
    }
  }

  // создаёт нового игрока
  createUser(params, socketId, cb) {
    const gameId = this._participants.createHuman(params, socketId);
    const name = this._participants.get(gameId).name;

    this._chat.addUser(gameId);
    this._vote.addUser(gameId);
    this._stat.addUser(gameId, this._spectatorId, { name });
    this._panel.addUser(gameId);
    this._RTTManager.addUser(gameId);

    queueMicrotask(() => {
      cb(gameId);
    });
  }

  // удаляет игрока полностью из игры
  removeUser(gameId) {
    const user = this._participants.get(gameId);

    if (!user) {
      return;
    }

    const { team, teamId } = user;

    this._RTTManager.removeUser(gameId);
    this._stat.removeUser(gameId, teamId);
    this._chat.removeUser(gameId);
    this._vote.removeUser(gameId);
    this._panel.removeUser(gameId);

    // если не наблюдатель — удалить танк из ядра (null-маркер ставит ядро)
    if (team !== this._spectatorTeam) {
      this._game.removePlayer(gameId);
    }

    this._participants.remove(gameId);

    this._chat.pushSystem('USER_LEFT', [user.name]);
  }

  // обновляет команды (формат wire: 'seq:action:name')
  updateKeys(gameId, keyStr) {
    const user = this._participants.get(gameId);
    const [seq, action, name] = keyStr.split(':');

    user.lastActionTime = Date.now();
    user.lastInputSeq = Number(seq) >>> 0;

    if (user.isWatching === true) {
      if (action === 'down') {
        if (name === this._spectatorKeys.nextPlayer) {
          user.watchedGameId = this._getNextActivePlayerForUser(gameId);
          user.forceCameraReset = true;
        } else if (name === this._spectatorKeys.prevPlayer) {
          user.watchedGameId = this._getNextActivePlayerForUser(gameId, true);
          user.forceCameraReset = true;
        }
      }
    } else {
      this._game.applyInput(gameId, user.lastInputSeq, action, name);
    }
  }

  // добавляет сообщение
  pushMessage(gameId, message) {
    const user = this._participants.get(gameId);

    if (user.isReady === false) {
      return;
    }

    user.lastActionTime = Date.now();

    message = sanitizeMessage(message);

    if (message.length > this._chatMaxLength) {
      message = message.slice(0, this._chatMaxLength);
    }

    if (message) {
      if (message.charAt(0) === '/') {
        this._commandProcessor.parseCommand(gameId, message);
      } else {
        this._chat.push(message, user.name, user.teamId);
      }
    }
  }

  // обрабатывает vote-данные пользователя
  parseVote(gameId, data) {
    const user = this._participants.get(gameId);

    if (user.isReady === false) {
      return;
    }

    user.lastActionTime = Date.now();

    if (typeof data === 'string') {
      if (data === 'teams') {
        this._vote.pushByUser(gameId, Object.keys(this._teams));
      } else if (data === 'maps') {
        this._vote.pushByUser(
          gameId,
          this._mapList.filter(map => map !== this._roundManager.currentMap),
        );
      }
    } else if (typeof data === 'object' && data !== null) {
      const [type, value] = data;

      if (type === 'mapChange') {
        if (this._participants.getHumans().length === 1) {
          this._roundManager.forceChangeMap(value);
        } else {
          this._roundManager.changeMap(gameId, value);
        }
      } else if (type === 'teamChange') {
        this._roundManager.changeTeam(gameId, value);
      } else {
        this._vote.addInVote(type, value);
        this._chat.pushSystemByUser(gameId, 'VOTE_ACCEPTED');
      }
    }
  }

  // обновляет значение round trip time
  updateRTT(gameId, pingId) {
    const latency = this._RTTManager.handlePong(gameId, pingId);

    if (latency !== null) {
      const user = this._participants.get(gameId);

      if (user) {
        this._stat.updateUser(gameId, user.teamId, { latency });
      }
    }
  }
}
