import { describe, it, expect, vi } from 'vitest';
import CommandProcessor from '../../src/host/meta/core/CommandProcessor.js';

const fakeParticipants = (usersMap = {}) => {
  const map = new Map(Object.entries(usersMap));

  return {
    get: id => map.get(id),
    getHumans: () => [...map.values()].filter(p => !p.isBot),
  };
};

const makeCp = (overrides = {}) =>
  new CommandProcessor({
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
      changeName: vi.fn(),
      initiateNewRound: vi.fn(),
      currentMap: 'm1',
    },
    voteCoordinator: overrides.voteCoordinator || {
      canCreateVote: vi.fn(() => true),
      createVote: vi.fn(),
    },
    timerManager: overrides.timerManager || { getMapTimeLeft: vi.fn(() => 0) },
    teams: overrides.teams || { team1: 1, team2: 2, spectators: 3 },
    spectatorTeam: 'spectators',
    spectatorId: 3,
    isDevMode: overrides.isDevMode ?? false,
  });

describe('CommandProcessor.parseCommand: простые команды', () => {
  it('/name делегирует смену ника RoundManager', () => {
    const cp = makeCp();
    cp.parseCommand('u', '/name NewName');
    expect(cp._roundManager.changeName).toHaveBeenCalledWith('u', 'NewName');
  });

  it('/nr в dev-режиме перезапускает раунд', () => {
    const cp = makeCp({ isDevMode: true });
    cp.parseCommand('u', '/nr');
    expect(cp._roundManager.initiateNewRound).toHaveBeenCalled();
  });

  it('/nr вне dev-режима не найдено', () => {
    const cp = makeCp({ isDevMode: false });
    cp.parseCommand('u', '/nr');
    expect(cp._chat.pushSystemByUser).toHaveBeenCalledWith(
      'u',
      'COMMANDS_NOT_FOUND',
    );
    expect(cp._roundManager.initiateNewRound).not.toHaveBeenCalled();
  });

  it('/mapname отдаёт текущую карту', () => {
    const cp = makeCp();
    cp.parseCommand('u', '/mapname');
    expect(cp._chat.pushSystemByUser).toHaveBeenCalledWith('u', ['m1']);
  });

  it('/timeleft форматирует оставшееся время', () => {
    const cp = makeCp({ timerManager: { getMapTimeLeft: () => 65000 } });
    cp.parseCommand('u', '/timeleft');
    expect(cp._chat.pushSystemByUser).toHaveBeenCalledWith('u', ['01:05']);
  });

  it('неизвестная команда → COMMANDS_NOT_FOUND', () => {
    const cp = makeCp();
    cp.parseCommand('u', '/whatever');
    expect(cp._chat.pushSystemByUser).toHaveBeenCalledWith(
      'u',
      'COMMANDS_NOT_FOUND',
    );
  });
});

describe('CommandProcessor.parseCommand: /bot', () => {
  it('наблюдателю недоступно', () => {
    const cp = makeCp({
      participants: fakeParticipants({ u: { gameId: 'u', teamId: 3 } }),
    });
    cp.parseCommand('u', '/bot 5');
    expect(cp._chat.pushSystemByUser).toHaveBeenCalledWith('u', 'BOT_PLAYERS_ONLY');
  });

  it('некорректное количество', () => {
    const cp = makeCp();
    cp.parseCommand('u', '/bot abc');
    expect(cp._chat.pushSystemByUser).toHaveBeenCalledWith(
      'u',
      'BOT_INVALID_COUNT',
    );
  });

  it('некорректная команда', () => {
    const cp = makeCp();
    cp.parseCommand('u', '/bot 5 spectators');
    expect(cp._chat.pushSystemByUser).toHaveBeenCalledWith(
      'u',
      'BOT_INVALID_TEAM',
    );
  });

  it('один игрок → исполняет команду сразу (создаёт ботов)', () => {
    const cp = makeCp(); // один человек 'u'
    cp.parseCommand('u', '/bot 3 team1');

    expect(cp._bots.removeBots).toHaveBeenCalledWith('team1');
    expect(cp._bots.createBots).toHaveBeenCalledWith(3, 'team1');
    expect(cp._roundManager.initiateNewRound).toHaveBeenCalled();
  });

  it('несколько игроков → запускает голосование', () => {
    const cp = makeCp({
      participants: fakeParticipants({
        u: { gameId: 'u', name: 'A', teamId: 1 },
        u2: { gameId: 'u2', name: 'B', teamId: 2 },
      }),
    });
    cp.parseCommand('u', '/bot 3 team1');

    expect(cp._voteCoordinator.createVote).toHaveBeenCalledWith(
      expect.objectContaining({ voteName: 'createBotsForTeam' }),
    );
    expect(cp._bots.createBots).not.toHaveBeenCalled();
  });
});

describe('CommandProcessor._initiateBotVote', () => {
  it('не создаёт голосование, если категория заблокирована', () => {
    const cp = makeCp({
      voteCoordinator: { canCreateVote: () => false, createVote: vi.fn() },
    });
    cp._initiateBotVote('u', 3, 'team1');
    expect(cp._voteCoordinator.createVote).not.toHaveBeenCalled();
  });

  it('успешный результат голосования исполняет команду', () => {
    const cp = makeCp();
    cp._initiateBotVote('u', 2, null);

    const { resultFunc } = cp._voteCoordinator.createVote.mock.calls[0][0];
    resultFunc('Yes');

    expect(cp._chat.pushSystem).toHaveBeenCalledWith('VOTE_PASSED');
    expect(cp._bots.createBots).toHaveBeenCalledWith(2, null);
  });
});
