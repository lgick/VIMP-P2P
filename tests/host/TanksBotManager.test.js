import { describe, it, expect, beforeEach, vi } from 'vitest';
import TanksBotManager from '@vimp/tanks/host/TanksBotManager.js';
import ParticipantManager from '../../packages/engine/src/host/meta/player/ParticipantManager.js';

// Юнит-тесты игрового scripted-модуля: реальный ParticipantManager +
// фейки coreAdapter/panel/stat (спавн танков в ядре — на старте раунда,
// модуль его не трогает; removePlayer — при удалении бота).

const TEAMS = { team1: 1, team2: 2, spectators: 3 };
const SCRIPTED = { namePrefix: 'Bot', defaultModel: 'm1' };

const RESPAWNS = {
  team1: [[0, 0, 0], [1, 1, 0]],
  team2: [[2, 2, 0], [3, 3, 0]],
};

let participants;
let coreAdapter;
let panel;
let stat;
let bots;

beforeEach(() => {
  participants = new ParticipantManager(TEAMS, 'spectators', 8, SCRIPTED);
  coreAdapter = { removePlayer: vi.fn() };
  panel = { addUser: vi.fn(), removeUser: vi.fn() };
  stat = { addUser: vi.fn(), removeUser: vi.fn() };
  bots = new TanksBotManager({
    participants,
    coreAdapter,
    panel,
    stat,
    scripted: SCRIPTED,
  });
  bots.createMap({ respawns: RESPAWNS });
});

describe('TanksBotManager.createBots', () => {
  it('без карты не создаёт (нет респаунов)', () => {
    const fresh = new TanksBotManager({
      participants,
      coreAdapter,
      panel,
      stat,
      scripted: SCRIPTED,
    });

    expect(fresh.createBots(2)).toBe(0);
  });

  it('создаёт в указанной команде и регистрирует в stat/panel', () => {
    expect(bots.createBots(2, 'team1')).toBe(2);

    expect(bots.getBotCountForTeam('team1')).toBe(2);
    expect(stat.addUser).toHaveBeenCalledTimes(2);
    expect(stat.addUser).toHaveBeenCalledWith('0', 1, {
      name: 'Bot0',
      status: 'dead',
      latency: 'BOT',
    });
    expect(panel.addUser).toHaveBeenCalledWith('0');
  });

  it('без команды распределяет по наименее заполненным', () => {
    expect(bots.createBots(2)).toBe(2);

    expect(bots.getBotCountsPerTeam()).toEqual({ team1: 1, team2: 1 });
  });

  it('не создаёт сверх мест в респаунах команды', () => {
    expect(bots.createBots(3, 'team1')).toBe(2); // respawns team1 = 2 места
  });

  it('останавливается на глобальном лимите участников', () => {
    const small = new ParticipantManager(TEAMS, 'spectators', 1, SCRIPTED);
    const manager = new TanksBotManager({
      participants: small,
      coreAdapter,
      panel,
      stat,
      scripted: SCRIPTED,
    });
    manager.createMap({ respawns: RESPAWNS });

    expect(manager.createBots(3)).toBe(1);
  });
});

describe('TanksBotManager: удаление', () => {
  it('removeBots(team) удаляет только команду, из ядра — removePlayer', () => {
    bots.createBots(2, 'team1');
    bots.createBots(1, 'team2');

    bots.removeBots('team1');

    expect(bots.getBotCount()).toBe(1);
    expect(coreAdapter.removePlayer).toHaveBeenCalledTimes(2);
    expect(stat.removeUser).toHaveBeenCalledTimes(2);
    expect(panel.removeUser).toHaveBeenCalledTimes(2);
  });

  it('removeBots() без аргумента удаляет всех', () => {
    bots.createBots(2);
    bots.removeBots();

    expect(bots.getBots()).toEqual([]);
  });

  it('removeOneBotForPlayer освобождает одно место в команде', () => {
    bots.createBots(2, 'team1');

    expect(bots.removeOneBotForPlayer('team1')).toBe(true);
    expect(bots.getBotCountForTeam('team1')).toBe(1);
    expect(bots.removeOneBotForPlayer('team2')).toBe(false);
  });

  it('людей не трогает', () => {
    const humanId = participants.createHuman({ name: 'A', model: 'm1' }, 's1');

    bots.removeBots();

    expect(participants.get(humanId)).toBeDefined();
    expect(bots.getBotById(humanId)).toBeUndefined();
  });
});
