import { describe, it, expect, vi } from 'vitest';
import botCommand from '@vimp/tanks/host/botCommand.js';

// Игровая чат-команда /bot (танки): валидация, немедленное исполнение при
// одном активном игроке, голосование при нескольких. Вызывается движковым
// CommandProcessor как handler(ctx, gameId, args).

const fakeParticipants = (usersMap = {}) => {
  const map = new Map(Object.entries(usersMap));

  return {
    get: id => map.get(id),
    getHumans: () => [...map.values()].filter(p => !p.isScripted),
  };
};

const makeCtx = (overrides = {}) => ({
  participants:
    overrides.participants ||
    fakeParticipants({ u: { gameId: 'u', name: 'A', teamId: 1 } }),
  chat: overrides.chat || {
    pushSystem: vi.fn(),
    pushSystemByUser: vi.fn(),
  },
  bots: overrides.bots || {
    getBotCountForTeam: vi.fn(() => 0),
    getBotCount: vi.fn(() => 0),
    removeBots: vi.fn(),
    createBots: vi.fn(() => 0),
  },
  roundManager: overrides.roundManager || {
    initiateNewRound: vi.fn(),
  },
  voteCoordinator: overrides.voteCoordinator || {
    canCreateVote: vi.fn(() => true),
    createVote: vi.fn(),
  },
  teams: overrides.teams || { team1: 1, team2: 2, spectators: 3 },
  spectatorTeam: 'spectators',
  spectatorId: 3,
});

const run = (ctx, gameId, args) => botCommand.handler(ctx, gameId, args);

describe('botCommand: валидация', () => {
  it('имя команды — /bot', () => {
    expect(botCommand.name).toBe('/bot');
  });

  it('наблюдателю недоступно', () => {
    const ctx = makeCtx({
      participants: fakeParticipants({ u: { gameId: 'u', teamId: 3 } }),
    });

    run(ctx, 'u', ['5']);
    expect(ctx.chat.pushSystemByUser).toHaveBeenCalledWith(
      'u',
      'BOT_PLAYERS_ONLY',
    );
  });

  it('некорректное количество', () => {
    const ctx = makeCtx();

    run(ctx, 'u', ['abc']);
    expect(ctx.chat.pushSystemByUser).toHaveBeenCalledWith(
      'u',
      'BOT_INVALID_COUNT',
    );
  });

  it('некорректная команда', () => {
    const ctx = makeCtx();

    run(ctx, 'u', ['5', 'spectators']);
    expect(ctx.chat.pushSystemByUser).toHaveBeenCalledWith(
      'u',
      'BOT_INVALID_TEAM',
    );
  });

  it('удаление, когда ботов нет — только сообщение', () => {
    const ctx = makeCtx();

    run(ctx, 'u', ['0']);
    expect(ctx.chat.pushSystemByUser).toHaveBeenCalledWith('u', 'BOT_REMOVED');
    expect(ctx.bots.removeBots).not.toHaveBeenCalled();
  });
});

describe('botCommand: исполнение и голосование', () => {
  it('один игрок → исполняет команду сразу (создаёт ботов)', () => {
    const ctx = makeCtx(); // один человек 'u'

    run(ctx, 'u', ['3', 'team1']);

    expect(ctx.bots.removeBots).toHaveBeenCalledWith('team1');
    expect(ctx.bots.createBots).toHaveBeenCalledWith(3, 'team1');
    expect(ctx.roundManager.initiateNewRound).toHaveBeenCalled();
  });

  it('несколько игроков → запускает голосование', () => {
    const ctx = makeCtx({
      participants: fakeParticipants({
        u: { gameId: 'u', name: 'A', teamId: 1 },
        u2: { gameId: 'u2', name: 'B', teamId: 2 },
      }),
    });

    run(ctx, 'u', ['3', 'team1']);

    expect(ctx.voteCoordinator.createVote).toHaveBeenCalledWith(
      expect.objectContaining({ voteName: 'createBotsForTeam' }),
    );
    expect(ctx.bots.createBots).not.toHaveBeenCalled();
  });

  it('не создаёт голосование, если категория заблокирована', () => {
    const ctx = makeCtx({
      participants: fakeParticipants({
        u: { gameId: 'u', name: 'A', teamId: 1 },
        u2: { gameId: 'u2', name: 'B', teamId: 2 },
      }),
      voteCoordinator: { canCreateVote: () => false, createVote: vi.fn() },
    });

    run(ctx, 'u', ['3', 'team1']);
    expect(ctx.voteCoordinator.createVote).not.toHaveBeenCalled();
  });

  it('успешный результат голосования исполняет команду', () => {
    const ctx = makeCtx({
      participants: fakeParticipants({
        u: { gameId: 'u', name: 'A', teamId: 1 },
        u2: { gameId: 'u2', name: 'B', teamId: 2 },
      }),
    });

    run(ctx, 'u', ['2']);

    const { resultFunc } = ctx.voteCoordinator.createVote.mock.calls[0][0];

    resultFunc('Yes');

    expect(ctx.chat.pushSystem).toHaveBeenCalledWith('VOTE_PASSED');
    expect(ctx.bots.createBots).toHaveBeenCalledWith(2, null);
    expect(ctx.roundManager.initiateNewRound).toHaveBeenCalled();
  });

  it('проваленное голосование не исполняет команду', () => {
    const ctx = makeCtx({
      participants: fakeParticipants({
        u: { gameId: 'u', name: 'A', teamId: 1 },
        u2: { gameId: 'u2', name: 'B', teamId: 2 },
      }),
    });

    run(ctx, 'u', ['2']);

    const { resultFunc } = ctx.voteCoordinator.createVote.mock.calls[0][0];

    resultFunc('No');

    expect(ctx.chat.pushSystem).toHaveBeenCalledWith('VOTE_FAILED');
    expect(ctx.bots.createBots).not.toHaveBeenCalled();
  });
});
