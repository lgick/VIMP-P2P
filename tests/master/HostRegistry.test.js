import { describe, it, expect, beforeEach } from 'vitest';
import HostRegistry from '../../src/master/HostRegistry.js';

// порог отключения регионального фильтра занижен для компактных тестов
const OPTIONS = {
  regionThreshold: 5,
  defaultLimit: 3,
  maxLimit: 4,
  maxNameLength: 10,
  maxPlayersLimit: 8,
};

let registry;

beforeEach(() => {
  registry = new HostRegistry(OPTIONS);
});

// регистрирует count комнат с уникальными IP
const addHosts = (count, region = 'EU') => {
  const hosts = [];

  for (let i = 0; i < count; i += 1) {
    hosts.push(
      registry.add({
        name: `room ${i}`,
        maxPlayers: 8,
        mapName: 'arena',
        region,
        ip: `10.0.${region === 'EU' ? 0 : 1}.${i}`,
      }),
    );
  }

  return hosts;
};

describe('HostRegistry.add', () => {
  it('регистрирует комнату с полным набором полей', () => {
    const host = registry.add({
      name: 'My Room',
      maxPlayers: 4,
      mapName: 'arena',
      region: 'EU',
      ip: '1.2.3.4',
    });

    expect(host.hostId).toBeTypeOf('string');
    expect(host).toMatchObject({
      name: 'My Room',
      maxPlayers: 4,
      currentPlayers: 0,
      mapName: 'arena',
      region: 'EU',
      ip: '1.2.3.4',
      status: 'online',
      reportCount: 0,
    });
    expect(registry.get(host.hostId)).toBe(host);
  });

  it('не даёт создать вторую комнату с того же IP', () => {
    registry.add({ name: 'a', ip: '1.2.3.4' });

    expect(registry.add({ name: 'b', ip: '1.2.3.4' })).toBeNull();
    expect(registry.size).toBe(1);
  });

  it('обрезает имя и подставляет дефолты для мусорных данных', () => {
    const host = registry.add({
      name: '  very long room name\x00 ',
      maxPlayers: 100,
      mapName: 42,
      region: undefined,
      ip: '1.2.3.4',
    });

    // maxNameLength = 10, управляющие символы удалены
    expect(host.name).toBe('very long');
    expect(host.maxPlayers).toBe(8); // clamp к maxPlayersLimit
    expect(host.mapName).toBe('unknown');
    expect(host.region).toBe('unknown');
  });

  it('подставляет "unnamed" для пустого имени', () => {
    const host = registry.add({ name: '   ', ip: '1.2.3.4' });

    expect(host.name).toBe('unnamed');
  });
});

describe('HostRegistry.update', () => {
  it('обновляет currentPlayers/mapName и lastSeen (heartbeat)', () => {
    const host = registry.add({ name: 'a', maxPlayers: 8, ip: '1.1.1.1' }, 0);

    const ok = registry.update(
      host.hostId,
      { currentPlayers: 5, mapName: 'dune' },
      100,
    );

    expect(ok).toBe(true);
    expect(host.currentPlayers).toBe(5);
    expect(host.mapName).toBe('dune');
    expect(host.lastSeen).toBe(100);
  });

  it('clamp числа игроков к maxPlayers комнаты', () => {
    const host = registry.add({ name: 'a', maxPlayers: 4, ip: '1.1.1.1' });

    registry.update(host.hostId, { currentPlayers: 99 });

    expect(host.currentPlayers).toBe(4);
  });

  it('вызов без данных — чистый heartbeat', () => {
    const host = registry.add({ name: 'a', ip: '1.1.1.1' }, 0);

    registry.update(host.hostId, undefined, 500);

    expect(host.lastSeen).toBe(500);
  });

  it('возвращает false для неизвестной комнаты', () => {
    expect(registry.update('nope', {})).toBe(false);
  });
});

describe('HostRegistry.report', () => {
  it('считает жалобы только от уникальных репортёров', () => {
    const host = registry.add({ name: 'a', ip: '1.1.1.1' });

    expect(registry.report(host.hostId, 'reporter1')).toBe(true);
    expect(registry.report(host.hostId, 'reporter1')).toBe(false);
    expect(registry.report(host.hostId, 'reporter2')).toBe(true);
    expect(host.reportCount).toBe(2);
  });

  it('возвращает false для неизвестной комнаты', () => {
    expect(registry.report('nope', 'reporter1')).toBe(false);
  });
});

describe('HostRegistry.sweepStale', () => {
  it('удаляет комнаты без heartbeat дольше таймаута', () => {
    const stale = registry.add({ name: 'stale', ip: '1.1.1.1' }, 0);
    const fresh = registry.add({ name: 'fresh', ip: '2.2.2.2' }, 900);

    const removed = registry.sweepStale(1000, 1500);

    expect(removed).toEqual([stale.hostId]);
    expect(registry.get(stale.hostId)).toBeUndefined();
    expect(registry.get(fresh.hostId)).toBe(fresh);
  });
});

describe('HostRegistry.getList', () => {
  it('поиск по подстроке имени игнорирует регион и пагинацию', () => {
    addHosts(4, 'EU');
    addHosts(4, 'US');

    const result = registry.getList({
      search: 'ROOM 2',
      region: 'EU',
      offset: '100',
      limit: '1',
    });

    // 'room 2' есть в обоих регионах, регистр не учитывается
    expect(result.total).toBe(2);
    expect(result.servers.map(s => s.name)).toEqual(['room 2', 'room 2']);
  });

  it('при малом реестре (<= порога) отдаёт всё без фильтров', () => {
    addHosts(3, 'EU');
    addHosts(2, 'US');

    const result = registry.getList({ region: 'EU', offset: '0', limit: '2' });

    expect(result.total).toBe(5);
    expect(result.servers).toHaveLength(5);
  });

  it('при большом реестре фильтрует по региону и режет страницу', () => {
    addHosts(6, 'EU');
    addHosts(4, 'US');

    const result = registry.getList({ region: 'EU', offset: '2', limit: '3' });

    expect(result.total).toBe(6);
    expect(result.servers.map(s => s.name)).toEqual([
      'room 2',
      'room 3',
      'room 4',
    ]);
    expect(result.servers.every(s => s.region === 'EU')).toBe(true);
  });

  it('без региона отдаёт общий список с дефолтным лимитом страницы', () => {
    addHosts(6, 'EU');

    const result = registry.getList({});

    expect(result.total).toBe(6);
    expect(result.servers).toHaveLength(3); // defaultLimit
  });

  it('ограничивает limit значением maxLimit и терпит мусорные параметры', () => {
    addHosts(6, 'EU');

    const result = registry.getList({ offset: 'junk', limit: '9999' });

    expect(result.servers).toHaveLength(4); // maxLimit
  });

  it('не отдаёт забаненные комнаты', () => {
    const [banned] = addHosts(3, 'EU');
    banned.status = 'banned';

    const result = registry.getList({});

    expect(result.total).toBe(2);
    expect(result.servers.find(s => s.hostId === banned.hostId)).toBeUndefined();
  });

  it('не раскрывает IP и служебные поля в публичном списке', () => {
    addHosts(1, 'EU');

    const [server] = registry.getList({}).servers;

    expect(Object.keys(server).sort()).toEqual([
      'currentPlayers',
      'hostId',
      'mapName',
      'maxPlayers',
      'name',
      'region',
    ]);
  });
});
