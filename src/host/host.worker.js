// Web Worker браузерного хоста (Этап 4). Крутит авторитетную часть матча:
// WASM-ядро симуляции (core/pkg-web) + JS-мету (HostGame поверх мета-модулей
// src/server) + игровой цикл ~120 Гц (таймеры Worker'а не троттлятся в
// фоновой вкладке). RTCPeerConnection живут в главном потоке — сюда приходят
// уже разобранные пакеты клиентов, обратно уходят wire-кадры (JSON-строки и
// бинарные ArrayBuffer'ы через Transferable). Порт-машина — как socket/index.js.

import init, { GameCore } from '../../core/pkg-web/vimp_core.js';
import gameConfig from '../config/game.js';
import clientConfig from '../config/client.js';
import authConfig from '../config/auth.js';
import wsports from '../config/wsports.js';
import { buildClientConfig } from '../lib/buildClientConfig.js';
import { buildCoreConfig } from '../lib/coreConfig.js';
import { validateAuth } from '../lib/validators.js';
import SocketManager from '../server/socket/SocketManager.js';
import HostGame from './HostGame.js';

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

const MAX_ROOM_PLAYERS = 8; // целевой размер комнаты (рамка P2P-плана)

let host = null;
let socketManager = null;
let clientCfg = null;

// состояние подключений: socketId → { gameId, methods, enabled }
const clients = new Map();

// применяет пользовательские настройки комнаты к конфигу игры
function applyRoomOverrides(room = {}) {
  const game = structuredClone(gameConfig);

  if (Number.isFinite(room.maxPlayers)) {
    game.maxPlayers = Math.max(1, Math.min(MAX_ROOM_PLAYERS, room.maxPlayers));
  }

  if (room.map && game.maps[room.map]) {
    game.currentMap = room.map;
  }

  if (Number.isFinite(room.roundTime)) {
    game.timers.roundTime = room.roundTime;
  }

  if (Number.isFinite(room.mapTime)) {
    game.timers.mapTime = room.mapTime;
  }

  if (typeof room.friendlyFire === 'boolean') {
    game.parts.friendlyFire = room.friendlyFire;
  }

  return game;
}

// wire-сокет пользователя: пишет кадры в главный поток (роутер WebRTC/loopback)
function makeWorkerSocket(socketId) {
  return {
    // JSON-сообщение [port, payload] — строкой (как ws.send); всегда надёжно
    send: (port, data) => {
      self.postMessage({
        type: 'to_client',
        socketId,
        payload: JSON.stringify([port, data]),
        reliable: true,
      });
    },

    // бинарный кадр — Transferable ArrayBuffer (без копии); reliable решает
    // канал WebRTC (meta/state) в главном потоке
    sendBinary: (buffer, reliable) => {
      self.postMessage(
        { type: 'to_client', socketId, payload: buffer, reliable },
        [buffer],
      );
    },

    // закрытие соединения
    close: (code, data) => {
      self.postMessage({ type: 'close_client', socketId, code, data });
    },
  };
}

// инициализация хоста: ядро, мета, игровой цикл
async function onInit(room) {
  await init();

  const game = applyRoomOverrides(room);
  const seed = (Math.random() * 2 ** 32) >>> 0;

  const core = new GameCore(
    JSON.stringify(
      buildCoreConfig({ friendlyFire: game.parts.friendlyFire, seed }),
    ),
  );

  clientCfg = buildClientConfig(game, clientConfig);
  socketManager = new SocketManager(wsports.server);
  host = new HostGame(game, socketManager, core);

  // мастеру нужна фактическая карта комнаты (разрешена из overrides/дефолта)
  self.postMessage({ type: 'ready', mapName: game.currentMap });
}

// новое подключение клиента: порт-машина как в socket/index.js
function onConnect(socketId) {
  if (!host || clients.has(socketId)) {
    return;
  }

  const socket = makeWorkerSocket(socketId);

  socketManager.addUser(socketId, socket);

  const state = {
    gameId: undefined,
    enabled: new Array(9).fill(false),
  };

  clients.set(socketId, state);

  // порт-обработчики (замыкание над gameId через state)
  state.methods = [
    // 0: config ready
    () => {
      state.enabled[PC_AUTH_RESPONSE] = true;
      socketManager.sendAuthData(socketId, authConfig);
      state.enabled[PC_CONFIG_READY] = false;
    },

    // 1: auth response
    data => {
      if (data && typeof data === 'object') {
        const err = validateAuth(data, authConfig.params);

        if (!err) {
          state.enabled[PC_AUTH_RESPONSE] = false;
          state.enabled[PC_MODULES_READY] = true;

          host.createUser(data, socketId, createdId => {
            state.gameId = createdId;
          });

          socketManager.sendTechInform(socketId, 'loading');
        }

        socketManager.sendAuthResult(socketId, err);
      }
    },

    // 2: modules ready
    () => {
      state.enabled[PC_MODULES_READY] = false;
      state.enabled[PC_MAP_READY] = true;
      state.enabled[PC_FIRST_SHOT_READY] = true;
      state.enabled[PC_KEYS_DATA] = true;
      state.enabled[PC_CHAT_DATA] = true;
      state.enabled[PC_VOTE_DATA] = true;
      state.enabled[PC_PONG] = true;

      host.sendMap(state.gameId);
    },

    // 3: map ready
    () => host.mapReady(state.gameId),

    // 4: first shot ready
    () => host.firstShotReady(state.gameId),

    // 5: keys data ('seq:action:name')
    keyEventString => {
      if (typeof keyEventString === 'string') {
        host.updateKeys(state.gameId, keyEventString);
      }
    },

    // 6: chat data
    message => host.pushMessage(state.gameId, message),

    // 7: vote data
    data => {
      if (data) {
        host.parseVote(state.gameId, data);
      }
    },

    // 8: pong
    pingId => host.updateRTT(state.gameId, pingId),
  ];

  state.enabled[PC_CONFIG_READY] = true;
  socketManager.sendConfig(socketId, clientCfg);
}

// входящее сообщение клиента (wire-строка [port, payload])
function onClientMessage(socketId, data) {
  const state = clients.get(socketId);

  if (!state) {
    return;
  }

  let msg;

  try {
    msg = JSON.parse(data);
  } catch (e) {
    return;
  }

  if (msg && state.enabled[msg[0]]) {
    state.methods[msg[0]](msg[1]);
  }
}

// отключение клиента
function onDisconnect(socketId) {
  const state = clients.get(socketId);

  if (!state) {
    return;
  }

  socketManager.removeUser(socketId);

  if (state.gameId !== undefined) {
    host.removeUser(state.gameId);
  }

  clients.delete(socketId);
}

self.onmessage = async e => {
  const msg = e.data;

  switch (msg.type) {
    case 'init':
      await onInit(msg.room);
      break;

    case 'connect':
      onConnect(msg.socketId);
      break;

    case 'message':
      onClientMessage(msg.socketId, msg.data);
      break;

    case 'disconnect':
      onDisconnect(msg.socketId);
      break;
  }
};
