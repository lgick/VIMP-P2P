// Обработчик чат-команд (/name, /nr, /timeleft, /mapname, /bot).
// Делегирует round/map-операции RoundManager, голосования — VoteCoordinator.
class CommandProcessor {
  constructor(deps) {
    this._participants = deps.participants;
    this._chat = deps.chat;
    this._bots = deps.bots;
    this._roundManager = deps.roundManager;
    this._voteCoordinator = deps.voteCoordinator;
    this._timerManager = deps.timerManager;

    this._teams = deps.teams;
    this._spectatorTeam = deps.spectatorTeam;
    this._spectatorId = deps.spectatorId;
    this._isDevMode = deps.isDevMode;
  }

  // обрабатывает команду от пользователя
  parseCommand(gameId, message) {
    message = message.replace(/\s\s+/g, ' ');

    const arr = message.split(' ');
    const cmd = arr.shift();

    switch (cmd) {
      // смена ника
      case '/name':
        this._roundManager.changeName(gameId, arr.join(' '));
        break;

      // новый раунд
      case '/nr':
        if (this._isDevMode) {
          this._roundManager.initiateNewRound();
        } else {
          this._chat.pushSystemByUser(gameId, 'COMMANDS_NOT_FOUND');
        }
        break;

      // время карты
      case '/timeleft': {
        function getTime(ms) {
          const totalSeconds = Math.floor(ms / 1000);
          let minutes = Math.floor(totalSeconds / 60);
          let seconds = totalSeconds % 60;

          if (minutes < 10) {
            minutes = '0' + minutes;
          }

          if (seconds < 10) {
            seconds = '0' + seconds;
          }

          return `${minutes}:${seconds}`;
        }

        this._chat.pushSystemByUser(gameId, [
          getTime(this._timerManager.getMapTimeLeft()),
        ]);
        break;
      }

      // название текущей карты
      case '/mapname':
        this._chat.pushSystemByUser(gameId, [this._roundManager.currentMap]);
        break;

      // управление ботами
      // /bot 5 team1     # создаёт 5 ботов в team1
      // /bot 3 team2     # создаёт 3 бота в team2
      // /bot 10          # создаёт 10 ботов, распределив их равномерно
      // /bot 0           # удаляет всех ботов
      case '/bot': {
        const user = this._participants.get(gameId);

        if (user.teamId === this._spectatorId) {
          this._chat.pushSystemByUser(gameId, 'BOT_PLAYERS_ONLY');
          break;
        }

        const count = parseInt(arr[0], 10);
        const team = arr[1] || null;

        if (isNaN(count) || count < 0) {
          this._chat.pushSystemByUser(gameId, 'BOT_INVALID_COUNT');
          break;
        }

        // если команда не соответствует
        if (team && (!this._teams[team] || team === this._spectatorTeam)) {
          this._chat.pushSystemByUser(gameId, 'BOT_INVALID_TEAM');
          break;
        }

        // если команда на удаление ботов, но удалять нечего
        if (count === 0) {
          if (team && this._bots.getBotCountForTeam(team) === 0) {
            this._chat.pushSystemByUser(gameId, 'BOT_REMOVED_FROM_TEAM', [team]);
            break;
          }

          if (this._bots.getBotCount() === 0) {
            this._chat.pushSystemByUser(gameId, 'BOT_REMOVED');
            break;
          }
        }

        // проверка количества активных игроков
        const activePlayerCount = this._participants
          .getHumans()
          .filter(u => u.teamId !== this._spectatorId).length;

        // если игрок один, выполнение команды
        if (activePlayerCount <= 1) {
          this._executeBotCommand(user.name, count, team);
          // иначе игроков больше, запуск голосования
        } else {
          this._initiateBotVote(gameId, count, team);
        }
        break;
      }

      default:
        this._chat.pushSystemByUser(gameId, 'COMMANDS_NOT_FOUND');
    }
  }

  // исполняет команду /bot
  _executeBotCommand(userName, count, team) {
    if (team) {
      this._bots.removeBots(team);

      if (count > 0) {
        count = this._bots.createBots(count, team);
        this._chat.pushSystem('BOT_CREATED_FOR_TEAM', [count, team]);
      } else {
        this._chat.pushSystem('BOT_REMOVED_FROM_TEAM', [team]);
      }
    } else {
      this._bots.removeBots();

      if (count > 0) {
        count = this._bots.createBots(count, null);
        this._chat.pushSystem('BOT_CREATED', [count]);
      } else {
        this._chat.pushSystem('BOT_REMOVED');
      }
    }

    this._roundManager.initiateNewRound();
  }

  // инициирует голосование за ботов
  _initiateBotVote(gameId, count, team) {
    const userName = this._participants.get(gameId).name;
    const voteCategory = 'botManagement';
    let voteName;
    let voteArgs;

    if (!this._voteCoordinator.canCreateVote(voteCategory, gameId)) {
      return;
    }

    if (team) {
      if (count > 0) {
        voteName = 'createBotsForTeam';
        voteArgs = [userName, count, team];
      } else {
        voteName = 'removeBotsForTeam';
        voteArgs = [userName, team];
      }
    } else {
      if (count > 0) {
        voteName = 'createBots';
        voteArgs = [userName, count];
      } else {
        voteName = 'removeBots';
        voteArgs = [userName];
      }
    }

    const payload = { name: voteName, params: voteArgs };
    const userList = this._participants
      .getHumans()
      .map(u => u.gameId)
      .filter(id => id !== gameId);

    this._voteCoordinator.createVote({
      voteName,
      voteCategory,
      payload,
      resultFunc: result => {
        if (result === 'Yes') {
          this._chat.pushSystem('VOTE_PASSED');
          this._executeBotCommand(userName, count, team);
        } else {
          this._chat.pushSystem('VOTE_FAILED');
        }
      },
      userList,
      gameId,
    });
  }
}

export default CommandProcessor;
