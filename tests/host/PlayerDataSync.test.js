import { describe, it, expect, vi } from 'vitest';
import PlayerDataSync from '../../packages/engine/src/host/meta/modules/PlayerDataSync.js';

const makeFetch = responses => {
  let call = 0;
  return vi.fn(async () => responses[call++] ?? responses[responses.length - 1]);
};

describe('PlayerDataSync', () => {
  it('load подгружает rank и state с мастера по Bearer-токену', async () => {
    const fetchImpl = makeFetch([
      { ok: true, json: async () => ({ rank: 7 }) },
      { ok: true, json: async () => ({ state: { skill: 3 } }) },
    ]);
    const sync = new PlayerDataSync('tanks', { fetchImpl });

    await sync.load('p1', 'tok');

    expect(sync.getRank('p1')).toBe(7);
    expect(sync.getState('p1')).toEqual({ skill: 3 });
    expect(fetchImpl).toHaveBeenCalledWith('/auth/rank?game=tanks', {
      method: 'GET',
      headers: { authorization: 'Bearer tok' },
      body: undefined,
    });
  });

  it('load оставляет дефолты при сбое auth-сервиса', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    const sync = new PlayerDataSync('tanks', { fetchImpl, defaultState: { skill: 0 } });

    await sync.load('p1', 'tok');

    expect(sync.getRank('p1')).toBe(0);
    expect(sync.getState('p1')).toEqual({ skill: 0 });
  });

  it('addRank накапливает дельту ранга', async () => {
    const fetchImpl = makeFetch([
      { ok: true, json: async () => ({ rank: 10 }) },
      { ok: true, json: async () => ({ state: {} }) },
    ]);
    const sync = new PlayerDataSync('tanks', { fetchImpl });

    await sync.load('p1', 'tok');
    sync.addRank('p1', 1);
    sync.addRank('p1', -1);
    sync.addRank('p1', 1);

    expect(sync.getRank('p1')).toBe(11);
  });

  it('setState заменяет state участника', async () => {
    const fetchImpl = makeFetch([
      { ok: true, json: async () => ({ rank: 0 }) },
      { ok: true, json: async () => ({ state: {} }) },
    ]);
    const sync = new PlayerDataSync('tanks', { fetchImpl });

    await sync.load('p1', 'tok');
    sync.setState('p1', { skill: 9 });

    expect(sync.getState('p1')).toEqual({ skill: 9 });
  });

  it('flush отправляет PUT rank и state с текущими значениями', async () => {
    const fetchImpl = makeFetch([
      { ok: true, json: async () => ({ rank: 5 }) },
      { ok: true, json: async () => ({ state: {} }) },
      { ok: true, json: async () => ({ ok: true }) },
      { ok: true, json: async () => ({ ok: true }) },
    ]);
    const sync = new PlayerDataSync('tanks', { fetchImpl });

    await sync.load('p1', 'tok');
    sync.addRank('p1', 2);
    await sync.flush('p1');

    expect(fetchImpl).toHaveBeenLastCalledWith('/auth/state?game=tanks', {
      method: 'PUT',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: JSON.stringify({ state: {} }),
    });
    expect(fetchImpl).toHaveBeenCalledWith('/auth/rank?game=tanks', {
      method: 'PUT',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: JSON.stringify({ rank: 7 }),
    });
  });

  it('flush неизвестного участника не бросает исключение', async () => {
    const sync = new PlayerDataSync('tanks', { fetchImpl: vi.fn() });

    await expect(sync.flush('ghost')).resolves.toBeUndefined();
  });

  it('removeUser удаляет запись участника', async () => {
    const fetchImpl = makeFetch([
      { ok: true, json: async () => ({ rank: 0 }) },
      { ok: true, json: async () => ({ state: {} }) },
    ]);
    const sync = new PlayerDataSync('tanks', { fetchImpl });

    await sync.load('p1', 'tok');
    sync.removeUser('p1');

    expect(sync.getRank('p1')).toBe(0);
    expect(sync.getState('p1')).toEqual({});
  });

  it('flushAll синхронизирует всех текущих участников', async () => {
    const fetchImpl = makeFetch([{ ok: true, json: async () => ({}) }]);
    const sync = new PlayerDataSync('tanks', { fetchImpl });

    await sync.load('p1', 'tok1');
    await sync.load('p2', 'tok2');

    fetchImpl.mockClear();
    await sync.flushAll();

    // 2 участника × (rank + state) = 4 запроса
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});
