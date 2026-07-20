// Игровой scripted-модуль фикстуры: зеркало
// games/tanks/src/host/TanksBotManager.js — тот же контракт (createMap,
// createBots, removeBots, removeOneBotForPlayer, getBots, getBotCount,
// getBotCountsPerTeam), проверяющий, что RoundManager/HostGame/CommandProcessor
// работают с любым HostPlugin.createModules(ctx), а не только с ботами
// танков. Worker-safe.
export default class ScriptedManager {
  constructor({ participants, coreAdapter, panel, stat, scripted }) {
    this._participants = participants;
    this._coreAdapter = coreAdapter;
    this._panel = panel;
    this._stat = stat;

    this._model = scripted.defaultModel;
    this._respawns = null;
  }

  updateBots() {}
  buildSpatialGrid() {}
  clearSpatialGrid() {}

  createMap(mapData) {
    this._respawns = mapData.respawns;
  }

  createBots(count, teamName = null) {
    if (!this._respawns) {
      return 0;
    }

    const playableTeams = this._participants.getPlayableTeams();
    let createdCount = 0;

    for (let i = 0; i < count; i += 1) {
      if (this._participants.isFull) {
        break;
      }

      let targetTeam = teamName;

      if (!targetTeam) {
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
        continue;
      }

      const gameId = this._participants.createScripted({
        team: targetTeam,
        model: this._model,
      });
      const participant = this._participants.get(gameId);

      this._stat.addUser(gameId, participant.teamId, {
        name: participant.name,
        status: 'dead',
        latency: 'SCRIPTED',
      });
      this._panel.addUser(gameId);

      createdCount += 1;
    }

    return createdCount;
  }

  removeBots(teamName = null) {
    const botsToRemove = teamName
      ? this._participants.getScripted().filter(bot => bot.team === teamName)
      : this._participants.getScripted();

    botsToRemove.forEach(bot => this._removeBotById(bot.gameId));
  }

  removeOneBotForPlayer(teamName) {
    for (const bot of this._participants.getScripted()) {
      if (bot.team === teamName) {
        this._removeBotById(bot.gameId);
        return true;
      }
    }

    return false;
  }

  _removeBotById(gameId) {
    const participant = this._participants.get(gameId);

    if (!participant || !participant.isScripted) {
      return;
    }

    this._stat.removeUser(gameId, participant.teamId);
    this._panel.removeUser(gameId);
    this._coreAdapter.removePlayer(gameId);

    this._participants.remove(gameId);
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
