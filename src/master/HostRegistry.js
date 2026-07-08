import { v4 as uuidv4 } from 'uuid';
import { sanitizeMessage } from '../lib/sanitizers.js';

// приводит значение к целому в диапазоне [min, max] или возвращает fallback
const toInt = (value, fallback, min, max) => {
  const num = Number(value);

  if (!Number.isFinite(num)) {
    return fallback;
  }

  return Math.min(Math.max(Math.trunc(num), min), max);
};

// Реестр активных комнат (браузерных хостов) мастер-сервера.
// Единственный источник истины для GET /servers и сигналинга.
export default class HostRegistry {
  constructor(options = {}) {
    this._regionThreshold = options.regionThreshold ?? 15;
    this._defaultLimit = options.defaultLimit ?? 10;
    this._maxLimit = options.maxLimit ?? 50;
    this._maxNameLength = options.maxNameLength ?? 30;
    this._maxPlayersLimit = options.maxPlayersLimit ?? 8;
    this._banThreshold = options.banThreshold ?? 5;
    this._reportWindowMs = options.reportWindowMs ?? 3600000;
    this._maxReasons = options.maxReasons ?? 20;

    this._hosts = new Map(); // hostId -> HostSession
    this._bannedIps = new Map(); // ip -> срок снятия бана (timestamp)
  }

  get size() {
    return this._hosts.size;
  }

  // регистрирует комнату; null — если с этого IP комната уже создана
  add({ name, maxPlayers, mapName, region, ip }, now = Date.now()) {
    if (this.getByIp(ip)) {
      return null;
    }

    const hostId = uuidv4();

    const session = {
      hostId,
      name: this._sanitizeName(name) || 'unnamed',
      maxPlayers: toInt(maxPlayers, this._maxPlayersLimit, 1, this._maxPlayersLimit),
      currentPlayers: 0,
      mapName: sanitizeMessage(mapName) || 'unknown',
      region: sanitizeMessage(region) || 'unknown',
      ip,
      status: 'online',
      reportCount: 0,
      reporters: new Map(), // ключ репортёра -> ts жалобы (уникальность + окно)
      reportReasons: [], // причины жалоб (аудит, наружу не отдаются)
      lastSeen: now,
    };

    this._hosts.set(hostId, session);

    return session;
  }

  get(hostId) {
    return this._hosts.get(hostId);
  }

  getByIp(ip) {
    for (const host of this._hosts.values()) {
      if (host.ip === ip) {
        return host;
      }
    }

    return undefined;
  }

  remove(hostId) {
    return this._hosts.delete(hostId);
  }

  // обновляет состояние комнаты; любое обновление — heartbeat
  update(hostId, { currentPlayers, mapName } = {}, now = Date.now()) {
    const host = this._hosts.get(hostId);

    if (!host) {
      return false;
    }

    host.lastSeen = now;

    if (currentPlayers !== undefined) {
      host.currentPlayers = toInt(
        currentPlayers,
        host.currentPlayers,
        0,
        host.maxPlayers,
      );
    }

    if (typeof mapName === 'string' && mapName !== '') {
      host.mapName = sanitizeMessage(mapName);
    }

    return true;
  }

  // забанен ли IP (жалобы держатся окно reportWindowMs); лениво чистит протухшие
  isBanned(ip, now = Date.now()) {
    const expiry = this._bannedIps.get(ip);

    if (expiry === undefined) {
      return false;
    }

    if (now >= expiry) {
      this._bannedIps.delete(ip);
      return false;
    }

    return true;
  }

  // жалоба на хоста (/ban); reporterKey — уникальность в окне reportWindowMs.
  // Возвращает { counted, banned }: counted — жалоба учтена (не дубль),
  // banned — хост достиг порога и переведён в бан
  report(hostId, reporterKey, reason, now = Date.now()) {
    const host = this._hosts.get(hostId);

    if (!host) {
      return { counted: false, banned: false };
    }

    // отбросить жалобы старше окна давности
    for (const [key, ts] of host.reporters) {
      if (now - ts >= this._reportWindowMs) {
        host.reporters.delete(key);
      }
    }

    if (host.reporters.has(reporterKey)) {
      return { counted: false, banned: false };
    }

    host.reporters.set(reporterKey, now);
    host.reportCount = host.reporters.size;

    const clean = sanitizeMessage(reason);

    if (clean) {
      host.reportReasons.push(clean);

      if (host.reportReasons.length > this._maxReasons) {
        host.reportReasons.shift();
      }
    }

    if (host.reporters.size >= this._banThreshold) {
      host.status = 'banned';
      this._bannedIps.set(host.ip, now + this._reportWindowMs);

      return { counted: true, banned: true };
    }

    return { counted: true, banned: false };
  }

  // удаляет комнаты без heartbeat дольше timeout; возвращает удалённые id.
  // Заодно чистит протухшие записи бана
  sweepStale(timeout, now = Date.now()) {
    const removed = [];

    for (const [hostId, host] of this._hosts) {
      if (now - host.lastSeen >= timeout) {
        this._hosts.delete(hostId);
        removed.push(hostId);
      }
    }

    for (const [ip, expiry] of this._bannedIps) {
      if (now >= expiry) {
        this._bannedIps.delete(ip);
      }
    }

    return removed;
  }

  // список серверов; приоритет: поиск > малый реестр целиком > регион + срез
  getList({ offset, limit, region, search } = {}) {
    const online = [...this._hosts.values()].filter(
      host => host.status === 'online',
    );

    // прямой поиск по имени игнорирует регионы и пагинацию
    if (typeof search === 'string' && search.trim() !== '') {
      const needle = search.trim().toLowerCase();
      const found = online.filter(host =>
        host.name.toLowerCase().includes(needle),
      );

      return { total: found.length, servers: found.map(this._toPublic) };
    }

    // серверов мало — региональный фильтр и пагинация не нужны
    if (online.length <= this._regionThreshold) {
      return { total: online.length, servers: online.map(this._toPublic) };
    }

    const filtered =
      typeof region === 'string' && region !== ''
        ? online.filter(host => host.region === region)
        : online;

    const off = toInt(offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const lim = toInt(limit, this._defaultLimit, 1, this._maxLimit);

    return {
      total: filtered.length,
      servers: filtered.slice(off, off + lim).map(this._toPublic),
    };
  }

  // публичное представление комнаты (без ip и служебных полей)
  _toPublic({ hostId, name, mapName, currentPlayers, maxPlayers, region }) {
    return { hostId, name, mapName, currentPlayers, maxPlayers, region };
  }

  _sanitizeName(name) {
    return sanitizeMessage(name).trim().slice(0, this._maxNameLength).trim();
  }
}
