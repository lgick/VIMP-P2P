import { v4 as uuidv4 } from 'uuid';

// Signaling Server: маршрутизация WebRTC-координации между клиентами
// и браузерными хостами. Игровой логики нет — только пересылка
// SDP-офферов/ответов, ICE-кандидатов и сигнальных пингов.
export default class SignalingServer {
  constructor(registry, options) {
    this._registry = registry;
    this._iceServers = options.iceServers;
    this._regionHeader = options.regionHeader;
    this._heartbeatTimeout = options.heartbeatTimeout;
    this._pingLimiter = options.pingLimiter;
    this._checkOrigin = options.checkOrigin;
    this._mapsVersion = options.mapsVersion ?? null;

    this._sessions = new Map(); // id соединения -> { id, ws, ip, region, hostId }
    this._hostSessions = new Map(); // hostId -> id соединения

    // обработчики входящих сигнальных сообщений
    this._handlers = {
      'register_host': this._onRegisterHost,
      'update_host': this._onUpdateHost,
      'heartbeat': this._onHeartbeat,
      'webrtc_offer': this._onWebRtcOffer,
      'webrtc_answer': this._onWebRtcAnswer,
      'ice_candidate': this._onIceCandidate,
      'ping_host': this._onPingHost,
      'pong_host': this._onPongHost,
      'report_host': this._onReportHost,
    };
  }

  handleConnection(ws, req) {
    const ipHeader = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const ip = ipHeader.split(',')[0].trim();
    const requestOrigin = req.headers.origin;

    // если origin вообще не пришел (это скорее всего бот)
    if (!requestOrigin) {
      ws.terminate();
      return;
    }

    this._checkOrigin(requestOrigin, err => {
      if (err) {
        console.warn(err);
        ws.close(4001, JSON.stringify(err));
        return;
      }

      const session = {
        id: uuidv4(),
        ws,
        ip,
        region: req.headers[this._regionHeader] || 'unknown',
        hostId: null,
      };

      this._sessions.set(session.id, session);

      this._send(session, {
        type: 'welcome',
        id: session.id,
        iceServers: this._iceServers,
      });

      ws.on('message', data => {
        const msg = this._unpack(data);

        if (msg && this._handlers[msg.type]) {
          this._handlers[msg.type].call(this, session, msg);
        }
      });

      ws.on('close', () => {
        this._removeSession(session);
      });
    });

    ws.on('error', error => {
      console.error('Signaling WebSocket error:', error);
    });
  }

  // удаляет комнаты без heartbeat и закрывает их соединения
  sweepStaleHosts(now = Date.now()) {
    const removed = this._registry.sweepStale(this._heartbeatTimeout, now);

    for (const hostId of removed) {
      const sessionId = this._hostSessions.get(hostId);
      const session = this._sessions.get(sessionId);

      this._hostSessions.delete(hostId);

      if (session) {
        session.hostId = null;
        session.ws.close(4000, 'staleHost');
      }
    }

    return removed;
  }

  // хост сообщает о создании комнаты
  _onRegisterHost(session, { name, maxPlayers, mapName }) {
    if (session.hostId) {
      this._sendError(session, 'alreadyRegistered');
      return;
    }

    // забаненный IP не может поднять комнату, пока действует бан
    if (this._registry.isBanned(session.ip)) {
      this._sendError(session, 'banned');
      return;
    }

    const host = this._registry.add({
      name,
      maxPlayers,
      mapName,
      region: session.region,
      ip: session.ip,
    });

    // лимит: не более одной комнаты с одного IP
    if (!host) {
      this._sendError(session, 'hostLimit');
      return;
    }

    session.hostId = host.hostId;
    this._hostSessions.set(host.hostId, session.id);

    // mapsVersion — актуальная версия каталога карт: при re-register после
    // разрыва хост сравнивает её со своей и при расхождении фетчит карты
    this._send(session, {
      type: 'host_registered',
      hostId: host.hostId,
      mapsVersion: this._mapsVersion,
    });
  }

  // актуализация currentPlayers/mapName (заодно heartbeat)
  _onUpdateHost(session, { currentPlayers, mapName }) {
    if (session.hostId) {
      this._registry.update(session.hostId, { currentPlayers, mapName });
    }
  }

  _onHeartbeat(session) {
    if (session.hostId) {
      this._registry.update(session.hostId);
    }
  }

  // клиент шлёт SDP-оффер конкретному хосту
  _onWebRtcOffer(session, { hostId, sdp }) {
    const host = this._getHostSession(hostId);

    if (!host) {
      this._sendError(session, 'unknownHost');
      return;
    }

    // память о том, к каким комнатам сессия подключалась — право на report_host
    (session.offeredHosts ??= new Set()).add(hostId);

    this._send(host, { type: 'webrtc_offer', clientId: session.id, sdp });
  }

  // хост отвечает клиенту
  _onWebRtcAnswer(session, { clientId, sdp }) {
    const client = this._sessions.get(clientId);

    if (session.hostId && client) {
      this._send(client, {
        type: 'webrtc_answer',
        hostId: session.hostId,
        sdp,
      });
    }
  }

  // обмен ICE-кандидатами в обе стороны:
  // клиент адресует hostId, хост адресует clientId
  _onIceCandidate(session, { targetId, candidate }) {
    const target = this._sessions.get(targetId) ?? this._getHostSession(targetId);

    if (!target) {
      return;
    }

    this._send(target, {
      type: 'ice_candidate',
      fromId: session.hostId ?? session.id,
      candidate,
    });
  }

  // сигнальный пинг: замер приблизительный (клиент→мастер→хост)
  _onPingHost(session, { hostId, pingId }) {
    if (!this._pingLimiter.consume(session.ip)) {
      this._sendError(session, 'rateLimited');
      return;
    }

    const host = this._getHostSession(hostId);

    if (host) {
      this._send(host, { type: 'ping_host', clientId: session.id, pingId });
    }
  }

  _onPongHost(session, { clientId, pingId }) {
    const client = this._sessions.get(clientId);

    if (session.hostId && client) {
      this._send(client, {
        type: 'pong_host',
        hostId: session.hostId,
        pingId,
      });
    }
  }

  // жалоба /ban; уникальность репортёров — по IP. При достижении порога хост
  // переводится в бан и его сигнальный WS закрывается — новые офферы к нему
  // больше не маршрутизируются (уже подключённые P2P-пиры это не рвёт)
  _onReportHost(session, { hostId, reason }) {
    // жалобу принимаем только от сессии, реально подключавшейся к комнате
    // (слала ей оффер) — иначе несколько чужих IP банят хост, не заходя в игру
    if (!session.offeredHosts?.has(hostId)) {
      this._sendError(session, 'reportRejected');
      return;
    }

    const { banned } = this._registry.report(hostId, session.ip, reason);

    if (banned) {
      this._getHostSession(hostId)?.ws.close(4002, 'banned');
    }
  }

  _getHostSession(hostId) {
    return this._sessions.get(this._hostSessions.get(hostId));
  }

  _removeSession(session) {
    if (session.hostId) {
      this._registry.remove(session.hostId);
      this._hostSessions.delete(session.hostId);
    }

    this._sessions.delete(session.id);
  }

  _send(session, message) {
    const { ws } = session;

    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  _sendError(session, code) {
    this._send(session, { type: 'error', code });
  }

  _unpack(data) {
    try {
      const msg = JSON.parse(data);

      return msg && typeof msg.type === 'string' ? msg : undefined;
    } catch (e) {
      return undefined;
    }
  }
}
