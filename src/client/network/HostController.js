// Мост главного потока между Worker'ом хоста (авторитетная симуляция) и
// транспортами клиентов. Worker не имеет доступа к RTCPeerConnection — главный
// поток роутит пакеты: исходящие кадры Worker'а (to_client) → нужному клиенту,
// входящие сообщения клиентов → в Worker. В Фазе 1 единственный клиент —
// хост-игрок через LoopbackTransport; в Фазе 2 сюда же подключается
// HostConnectionManager (удалённые клиенты по WebRTC).
export default class HostController {
  /**
   * @param {Object} room - настройки комнаты (имя/карта/лимит/таймеры).
   * @param {Object} [opts]
   * @param {Function} [opts.workerFactory] - фабрика Worker'а (для тестов).
   * @param {Function} [opts.onReady] - вызывается, когда Worker готов
   *   (авторитетная часть поднята) — момент регистрации хоста у мастера.
   */
  constructor(room, { workerFactory, onReady } = {}) {
    this._worker = workerFactory
      ? workerFactory()
      : new Worker(new URL('../../host/host.worker.js', import.meta.url), {
          type: 'module',
        });

    this._onReady = onReady;
    this._ready = false;
    this._deliveries = new Map(); // socketId → { onMessage, onClose }
    this._pendingConnects = []; // socketId, ожидающие готовности Worker'а

    this._worker.onmessage = e => this._onWorkerMessage(e.data);

    // старт авторитетной части в Worker'е
    this._worker.postMessage({ type: 'init', room });
  }

  // регистрирует клиента и (при готовности) поднимает его соединение в Worker'е
  open(socketId, { onMessage, onClose }) {
    this._deliveries.set(socketId, { onMessage, onClose });

    if (this._ready) {
      this._worker.postMessage({ type: 'connect', socketId });
    } else {
      this._pendingConnects.push(socketId);
    }
  }

  // пересылает входящее сообщение клиента в Worker
  send(socketId, data) {
    this._worker.postMessage({ type: 'message', socketId, data });
  }

  // отключает клиента
  disconnect(socketId) {
    this._deliveries.delete(socketId);
    this._worker.postMessage({ type: 'disconnect', socketId });
  }

  // останавливает Worker (закрытие комнаты)
  destroy() {
    this._worker.terminate();
  }

  _onWorkerMessage(msg) {
    switch (msg.type) {
      case 'ready':
        this._ready = true;

        for (const socketId of this._pendingConnects) {
          this._worker.postMessage({ type: 'connect', socketId });
        }

        this._pendingConnects.length = 0;
        this._onReady?.(msg);
        break;

      case 'to_client':
        this._deliveries.get(msg.socketId)?.onMessage(msg.payload, msg.reliable);
        break;

      case 'close_client':
        this._deliveries.get(msg.socketId)?.onClose(msg.code, msg.data);
        break;
    }
  }
}
