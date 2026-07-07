import Publisher from '../../lib/Publisher.js';

// Клиент сигнального WebSocket мастер-сервера (src/master/SignalingServer.js).
// Только координация установки P2P: приём welcome (id соединения + iceServers),
// обмен SDP-офферами/ответами и ICE-кандидатами, сигнальный ping/pong, жалобы.
// Игровой трафик идёт по WebRTC-каналам (WebRtcManager), не через мастер.
//
// Входящие сообщения ретранслируются подписчикам через Publisher по полю type;
// welcome дополнительно кэширует id/iceServers. Транспорт WebSocket инъекций
// ради тестируемости — фабрика по умолчанию использует глобальный WebSocket.
export default class SignalingClient {
  constructor(url, socketFactory = u => new WebSocket(u)) {
    this._url = url;
    this._socketFactory = socketFactory;

    this._ws = null;
    this._id = null;
    this._iceServers = [];

    this.publisher = new Publisher();
  }

  get id() {
    return this._id;
  }

  get iceServers() {
    return this._iceServers;
  }

  get connected() {
    return this._ws !== null && this._ws.readyState === this._ws.OPEN;
  }

  // открывает соединение; событие 'welcome' — после приёма welcome от мастера
  connect() {
    if (this._ws) {
      return;
    }

    const ws = this._socketFactory(this._url);

    this._ws = ws;

    ws.onopen = () => this.publisher.emit('open');
    ws.onerror = () => this.publisher.emit('socketError');

    ws.onclose = event => {
      this._ws = null;
      this.publisher.emit('close', event);
    };

    ws.onmessage = event => this._onMessage(event.data);
  }

  // клиент → SDP-оффер конкретному хосту
  sendOffer(hostId, sdp) {
    this._send({ type: 'webrtc_offer', hostId, sdp });
  }

  // обмен ICE-кандидатами (targetId — hostId со стороны клиента)
  sendIceCandidate(targetId, candidate) {
    this._send({ type: 'ice_candidate', targetId, candidate });
  }

  // сигнальный ping хосту (замер приблизительный: клиент→мастер→хост)
  pingHost(hostId, pingId) {
    this._send({ type: 'ping_host', hostId, pingId });
  }

  // жалоба /ban напрямую мастеру (минуя хоста-читера)
  reportHost(hostId) {
    this._send({ type: 'report_host', hostId });
  }

  close() {
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
  }

  _onMessage(raw) {
    let msg;

    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }

    if (!msg || typeof msg.type !== 'string') {
      return;
    }

    if (msg.type === 'welcome') {
      this._id = msg.id;
      this._iceServers = msg.iceServers || [];
    }

    this.publisher.emit(msg.type, msg);
  }

  _send(message) {
    if (this.connected) {
      this._ws.send(JSON.stringify(message));
    }
  }
}
