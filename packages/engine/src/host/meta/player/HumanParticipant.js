import Participant from './Participant.js';

// Участник-человек: поля и поведение, специфичные для реального игрока
class HumanParticipant extends Participant {
  constructor({ gameId, name, model, team, teamId, socketId, watchedGameId }) {
    super({ gameId, name, model, team, teamId });

    this.socketId = socketId;
    this.isReady = false;
    this.currentMap = null;
    this.isWatching = true;
    this.watchedGameId = watchedGameId ?? null;
    this.forceCameraReset = true;
    this.pendingShake = null;
    this.lastActionTime = Date.now();
    this.lastInputSeq = 0; // номер последнего обработанного ввода (предикшен)
  }

  get isNetworked() {
    return true;
  }
}

export default HumanParticipant;
