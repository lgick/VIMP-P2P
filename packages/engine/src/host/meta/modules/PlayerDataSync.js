import lobbyConfig from '../../../config/lobby.js';

// Rank/state участника (Этап B4). Игрок приходит в игру с ником из JWT —
// rank (числовой рейтинг) и state (непрозрачный для движка JSON, "скиллы")
// подгружаются с мастера (прокси central auth-сервиса) при входе и
// синхронизируются обратно по естественным границам жизненного цикла
// (RoundManager: смена карты, конец раунда). Схему/дефолты state объявляет
// игра — здесь это чёрный ящик.
export default class PlayerDataSync {
  constructor(gameId, { fetchImpl = fetch, defaultState = {} } = {}) {
    this._gameId = gameId;
    this._fetch = fetchImpl;
    this._defaultState = defaultState;
    this._entries = new Map(); // participantId -> { token, rank, state }
  }

  _authedFetch(url, token, { method = 'GET', body } = {}) {
    return this._fetch(`${url}?game=${this._gameId}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  // подгружает rank+state с мастера при входе игрока. Сбой auth-сервиса не
  // должен блокировать вход — участник стартует с дефолтами (rank 0, пустой
  // state) и попробует синхронизироваться на следующем flush
  async load(participantId, token) {
    const entry = { token, rank: 0, state: this._defaultState };
    this._entries.set(participantId, entry);

    try {
      const [rankRes, stateRes] = await Promise.all([
        this._authedFetch(lobbyConfig.auth.rankUrl, token),
        this._authedFetch(lobbyConfig.auth.stateUrl, token),
      ]);

      if (rankRes.ok) {
        entry.rank = (await rankRes.json()).rank ?? 0;
      }

      if (stateRes.ok) {
        const { state } = await stateRes.json();

        entry.state =
          state && Object.keys(state).length ? state : this._defaultState;
      }
    } catch {
      // недоступность auth-сервиса — остаёмся на дефолтах
    }

    return entry;
  }

  getRank(participantId) {
    return this._entries.get(participantId)?.rank ?? 0;
  }

  getState(participantId) {
    return this._entries.get(participantId)?.state ?? this._defaultState;
  }

  // прибавляет к рангу игрока (вызывается из RoundManager.reportKill —
  // тот же чокпоинт, что и Stat score)
  addRank(participantId, delta) {
    const entry = this._entries.get(participantId);

    if (entry) {
      entry.rank += delta;
    }
  }

  setState(participantId, state) {
    const entry = this._entries.get(participantId);

    if (entry) {
      entry.state = state;
    }
  }

  removeUser(participantId) {
    this._entries.delete(participantId);
  }

  // синхронизирует накопленные rank+state участника на мастер. Сбой не
  // бросается дальше — следующий flush попробует снова с уже накопленными
  // (не потерянными) данными
  async flush(participantId) {
    const entry = this._entries.get(participantId);

    if (!entry) {
      return;
    }

    const { token, rank, state } = entry;

    await Promise.allSettled([
      this._authedFetch(lobbyConfig.auth.rankUrl, token, {
        method: 'PUT',
        body: { rank },
      }),
      this._authedFetch(lobbyConfig.auth.stateUrl, token, {
        method: 'PUT',
        body: { state },
      }),
    ]);
  }

  // синхронизирует всех текущих участников (границы раунда/карты)
  flushAll() {
    return Promise.allSettled(
      [...this._entries.keys()].map(id => this.flush(id)),
    );
  }
}
