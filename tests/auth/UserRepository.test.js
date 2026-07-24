import UserRepository, { NickTakenError } from '../../packages/auth/src/UserRepository.js';

function createDbStub(handlers) {
  return { query: vi.fn((text, values) => handlers(text, values)) };
}

describe('UserRepository', () => {
  it('findOrCreateByProvider возвращает существующего пользователя без INSERT', async () => {
    const db = createDbStub(text => {
      if (text.startsWith('SELECT')) {
        return { rows: [{ id: 1, provider: 'github', 'provider_uid': 'u1', nick: 'Player1' }] };
      }

      throw new Error('unexpected query: ' + text);
    });

    const repo = new UserRepository(db);
    const user = await repo.findOrCreateByProvider('github', 'u1');

    expect(user.nick).toBe('Player1');
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('findOrCreateByProvider создаёт нового пользователя без ника', async () => {
    const db = createDbStub(text => {
      if (text.startsWith('SELECT')) {
        return { rows: [] };
      }

      if (text.startsWith('INSERT')) {
        return { rows: [{ id: 2, provider: 'github', 'provider_uid': 'u2', nick: null }] };
      }

      throw new Error('unexpected query: ' + text);
    });

    const repo = new UserRepository(db);
    const user = await repo.findOrCreateByProvider('github', 'u2');

    expect(user.id).toBe(2);
    expect(user.nick).toBeNull();
  });

  it('setNick пробрасывает NickTakenError при unique_violation', async () => {
    const db = createDbStub(() => {
      const err = new Error('duplicate key');
      err.code = '23505';
      throw err;
    });

    const repo = new UserRepository(db);

    await expect(repo.setNick(1, 'Taken')).rejects.toThrow(NickTakenError);
  });

  it('setNick возвращает обновлённого пользователя при успехе', async () => {
    const db = createDbStub(() => ({
      rows: [{ id: 1, nick: 'FreshNick' }],
    }));

    const repo = new UserRepository(db);
    const user = await repo.setNick(1, 'FreshNick');

    expect(user.nick).toBe('FreshNick');
  });

  it('getRank возвращает 0 если записи нет', async () => {
    const db = createDbStub(() => ({ rows: [] }));
    const repo = new UserRepository(db);

    expect(await repo.getRank(1, 'tanks')).toBe(0);
  });

  it('getRank возвращает сохранённый rank', async () => {
    const db = createDbStub(() => ({ rows: [{ rank: 42 }] }));
    const repo = new UserRepository(db);

    expect(await repo.getRank(1, 'tanks')).toBe(42);
  });

  it('getState возвращает {} если записи нет', async () => {
    const db = createDbStub(() => ({ rows: [] }));
    const repo = new UserRepository(db);

    expect(await repo.getState(1, 'tanks')).toEqual({});
  });

  it('upsertRank/upsertState вызывают INSERT ... ON CONFLICT', async () => {
    const db = createDbStub(text => {
      expect(text).toMatch(/ON CONFLICT/);
      return { rows: [] };
    });

    const repo = new UserRepository(db);

    await repo.upsertRank(1, 'tanks', 10);
    await repo.upsertState(1, 'tanks', { skill: 5 });
    expect(db.query).toHaveBeenCalledTimes(2);
  });
});
