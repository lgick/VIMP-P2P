// Чат-команда /bot танков: создание/удаление ботов + голосования.
//   /bot 5 team1   # создаёт 5 ботов в team1
//   /bot 10        # создаёт 10 ботов, распределив их равномерно
//   /bot 0 team2   # удаляет ботов team2
//   /bot 0         # удаляет всех ботов
// Регистрируется в движковом CommandProcessor через HostPlugin.chatCommands.
// Worker-safe.
//
// ctx — контекст меты движка: participants, chat, scripted (модуль ботов),
// roundManager, voteCoordinator, teams, spectatorTeam, spectatorId.

// исполняет команду /bot
function executeBotCommand(ctx, count, team) {
  if (team) {
    ctx.scripted.removeScripted(team);

    if (count > 0) {
      count = ctx.scripted.createScripted(count, team);
      ctx.chat.pushSystem('BOT_CREATED_FOR_TEAM', [count, team]);
    } else {
      ctx.chat.pushSystem('BOT_REMOVED_FROM_TEAM', [team]);
    }
  } else {
    ctx.scripted.removeScripted();

    if (count > 0) {
      count = ctx.scripted.createScripted(count, null);
      ctx.chat.pushSystem('BOT_CREATED', [count]);
    } else {
      ctx.chat.pushSystem('BOT_REMOVED');
    }
  }

  ctx.roundManager.initiateNewRound();
}

// инициирует голосование за ботов
function initiateBotVote(ctx, gameId, count, team) {
  const userName = ctx.participants.get(gameId).name;
  const voteCategory = 'botManagement';
  let voteName;
  let voteArgs;

  if (!ctx.voteCoordinator.canCreateVote(voteCategory, gameId)) {
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
  const userList = ctx.participants
    .getHumans()
    .map(u => u.gameId)
    .filter(id => id !== gameId);

  ctx.voteCoordinator.createVote({
    voteName,
    voteCategory,
    payload,
    resultFunc: result => {
      if (result === 'Yes') {
        ctx.chat.pushSystem('VOTE_PASSED');
        executeBotCommand(ctx, count, team);
      } else {
        ctx.chat.pushSystem('VOTE_FAILED');
      }
    },
    userList,
    gameId,
  });
}

export default {
  name: '/bot',

  handler(ctx, gameId, args) {
    const user = ctx.participants.get(gameId);

    if (user.teamId === ctx.spectatorId) {
      ctx.chat.pushSystemByUser(gameId, 'BOT_PLAYERS_ONLY');
      return;
    }

    const count = parseInt(args[0], 10);
    const team = args[1] || null;

    if (isNaN(count) || count < 0) {
      ctx.chat.pushSystemByUser(gameId, 'BOT_INVALID_COUNT');
      return;
    }

    // если команда не соответствует
    if (team && (!ctx.teams[team] || team === ctx.spectatorTeam)) {
      ctx.chat.pushSystemByUser(gameId, 'BOT_INVALID_TEAM');
      return;
    }

    // если команда на удаление ботов, но удалять нечего
    if (count === 0) {
      if (team && ctx.scripted.getCountForTeam(team) === 0) {
        ctx.chat.pushSystemByUser(gameId, 'BOT_REMOVED_FROM_TEAM', [team]);
        return;
      }

      if (ctx.scripted.getCount() === 0) {
        ctx.chat.pushSystemByUser(gameId, 'BOT_REMOVED');
        return;
      }
    }

    // проверка количества активных игроков
    const activePlayerCount = ctx.participants
      .getHumans()
      .filter(u => u.teamId !== ctx.spectatorId).length;

    // если игрок один — исполнение команды, иначе запуск голосования
    if (activePlayerCount <= 1) {
      executeBotCommand(ctx, count, team);
    } else {
      initiateBotVote(ctx, gameId, count, team);
    }
  },
};
