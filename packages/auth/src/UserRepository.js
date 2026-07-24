// доступ к БД auth-сервиса (users/ratings/states). Принимает объект с
// методом query({text, values}) в конструкторе (реальный pg.Pool или мок в
// тестах) — так класс не тянет реальное соединение в юнит-тестах
export class NickTakenError extends Error {
  constructor(nick) {
    super(`nick "${nick}" is already taken`);
    this.name = 'NickTakenError';
    this.nick = nick;
  }
}

export default class UserRepository {
  constructor(db) {
    this._db = db;
  }

  // находит пользователя по (provider, providerUid) или создаёт нового
  // без ника (ник выбирается отдельным шагом, POST /nick)
  async findOrCreateByProvider(provider, providerUid) {
    const existing = await this._db.query(
      'SELECT * FROM users WHERE provider = $1 AND provider_uid = $2',
      [provider, providerUid],
    );

    if (existing.rows[0]) {
      return existing.rows[0];
    }

    const created = await this._db.query(
      'INSERT INTO users (provider, provider_uid) VALUES ($1, $2) RETURNING *',
      [provider, providerUid],
    );

    return created.rows[0];
  }

  // глобальная уникальность ника (заменяет пер-комнатный checkName хоста)
  async setNick(userId, nick) {
    try {
      const result = await this._db.query(
        'UPDATE users SET nick = $1 WHERE id = $2 RETURNING *',
        [nick, userId],
      );

      return result.rows[0];
    } catch (err) {
      // unique_violation — ник заняли между проверкой и записью
      if (err.code === '23505') {
        throw new NickTakenError(nick);
      }

      throw err;
    }
  }

  async getRank(userId, gameId) {
    const result = await this._db.query(
      'SELECT rank FROM ratings WHERE user_id = $1 AND game_id = $2',
      [userId, gameId],
    );

    return result.rows[0]?.rank ?? 0;
  }

  async upsertRank(userId, gameId, rank) {
    await this._db.query(
      `INSERT INTO ratings (user_id, game_id, rank, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (user_id, game_id)
       DO UPDATE SET rank = EXCLUDED.rank, updated_at = now()`,
      [userId, gameId, rank],
    );
  }

  async getState(userId, gameId) {
    const result = await this._db.query(
      'SELECT state FROM states WHERE user_id = $1 AND game_id = $2',
      [userId, gameId],
    );

    return result.rows[0]?.state ?? {};
  }

  async upsertState(userId, gameId, state) {
    await this._db.query(
      `INSERT INTO states (user_id, game_id, state, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (user_id, game_id)
       DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
      [userId, gameId, JSON.stringify(state)],
    );
  }
}
