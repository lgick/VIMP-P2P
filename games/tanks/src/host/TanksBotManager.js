// Игровой scripted-модуль танков: тонкий менеджер ботов поверх ядра.
// ИИ, навигация и пространственная сетка живут в Rust-ядре (add_bot создаёт
// танк + контроллер) — здесь только регистрация участников и связка со
// Stat/Panel. Контракт scripted-модуля (дергает движок — RoundManager,
// HostGame, чат-команда /bot): createMap, createBots, removeBots,
// removeOneBotForPlayer, getBots, getBotCount, getBotCountsPerTeam.
// Worker-safe: только изоморфные API.
export default class TanksBotManager {
  /**
   * @param {Object} ctx - контекст движка (в этапе 6 — из createModules):
   *   participants (единый реестр), coreAdapter (спавн/удаление танка),
   *   panel, stat, scripted ({ namePrefix, defaultModel } из конфига игры).
   */
  constructor({ participants, coreAdapter, panel, stat, scripted }) {
    this._participants = participants;
    this._coreAdapter = coreAdapter;
    this._panel = panel;
    this._stat = stat;

    this._model = scripted.defaultModel; // модель танка для ботов
    this._respawns = null; // данные респаунов текущей карты
  }

  // ИИ ботов исполняется внутри ядра на step() — на JS-стороне тика нет работы
  updateBots() {}

  // очистка/заполнение пространственной сетки — забота ядра
  buildSpatialGrid() {}
  clearSpatialGrid() {}

  // запоминает респауны карты (для распределения ботов по командам)
  createMap(mapData) {
    this._respawns = mapData.respawns;
  }

  // создаёт заданное количество ботов-участников (танки в ядре — на старте
  // раунда через RoundManager → coreAdapter.createPlayer → core.add_bot)
  createBots(count, teamName = null) {
    if (!this._respawns) {
      return 0;
    }

    const playableTeams = this._participants.getPlayableTeams();

    let createdCount = 0;

    for (let i = 0; i < count; i += 1) {
      if (this._participants.isFull) {
        break; // достигнут глобальный лимит игроков
      }

      let targetTeam = teamName;

      if (!targetTeam) {
        // равномерное распределение по наименее заполненной команде
        targetTeam = playableTeams.sort(
          (a, b) =>
            this._participants.getTeamSize(a) -
            this._participants.getTeamSize(b),
        )[0];
      }

      if (
        !targetTeam ||
        !this._respawns[targetTeam] ||
        this._participants.getTeamSize(targetTeam) >=
          this._respawns[targetTeam].length
      ) {
        continue; // нет свободных мест в команде или команда не найдена
      }

      const gameId = this._participants.createScripted({
        team: targetTeam,
        model: this._model,
      });
      const participant = this._participants.get(gameId);

      this._stat.addUser(gameId, participant.teamId, {
        name: participant.name,
        status: 'dead',
        latency: 'BOT',
      });
      this._panel.addUser(gameId);

      createdCount += 1;
    }

    return createdCount;
  }

  // удаляет ботов (всех либо конкретной команды)
  removeBots(teamName = null) {
    const botsToRemove = teamName
      ? this._participants.getScripted().filter(bot => bot.team === teamName)
      : this._participants.getScripted();

    botsToRemove.forEach(bot => this._removeBotById(bot.gameId));
  }

  // удаляет одного бота из команды, чтобы освободить место игроку
  removeOneBotForPlayer(teamName) {
    for (const bot of this._participants.getScripted()) {
      if (bot.team === teamName) {
        this._removeBotById(bot.gameId);
        return true;
      }
    }

    return false;
  }

  // удаляет бота по gameId из всех систем и ядра
  _removeBotById(gameId) {
    const participant = this._participants.get(gameId);

    if (!participant || !participant.isScripted) {
      return;
    }

    this._stat.removeUser(gameId, participant.teamId);
    this._panel.removeUser(gameId);
    this._coreAdapter.removePlayer(gameId); // → core.remove_bot (танк + ИИ)

    this._participants.remove(gameId);
  }

  getBotById(gameId) {
    const participant = this._participants.get(gameId);

    return participant && participant.isScripted ? participant : undefined;
  }

  getBots() {
    return this._participants.getScripted();
  }

  getBotCount() {
    return this._participants.getScripted().length;
  }

  getBotCountForTeam(teamName) {
    return this._participants
      .getScripted()
      .filter(bot => bot.team === teamName).length;
  }

  getBotCountsPerTeam() {
    const counts = {};

    for (const bot of this._participants.getScripted()) {
      counts[bot.team] = (counts[bot.team] || 0) + 1;
    }

    return counts;
  }
}
