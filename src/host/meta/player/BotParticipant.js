import Participant from './Participant.js';

// Участник-бот: управляется ИИ, всегда active-или-удалён, наблюдателем не бывает
class BotParticipant extends Participant {
  constructor({ gameId, name, model, team, teamId }) {
    super({ gameId, name, model, team, teamId });

    this.status = 'dead'; // в статистику бот добавляется как 'dead' до старта раунда
    this.controller = null; // BotController
  }

  get isBot() {
    return true;
  }
}

export default BotParticipant;
