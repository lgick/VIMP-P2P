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

describe('TanksBotManager.createScripted', () => {
  it('без карты не создаёт (нет респаунов)', () => {
    const fresh = new TanksBotManager({
      participants,
      coreAdapter,
      panel,
      stat,
      scripted: SCRIPTED,
    });

    expect(fresh.createScripted(2)).toBe(0);
  });

  it('создаёт в указанной команде и регистрирует в stat/panel', () => {
    expect(bots.createScripted(2, 'team1')).toBe(2);

    expect(bots.getCountForTeam('team1')).toBe(2);
    expect(stat.addUser).toHaveBeenCalledTimes(2);
    expect(stat.addUser).toHaveBeenCalledWith('0', 1, {
      name: 'Bot0',
      status: 'dead',
      latency: 'BOT',
    });
    expect(panel.addUser).toHaveBeenCalledWith('0');
  });

  it('без команды распределяет по наименее заполненным', () => {
    expect(bots.createScripted(2)).toBe(2);

    expect(bots.getCountsPerTeam()).toEqual({ team1: 1, team2: 1 });
  });

  it('не создаёт сверх мест в респаунах команды', () => {
    expect(bots.createScripted(3, 'team1')).toBe(2); // respawns team1 = 2 места
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

    expect(manager.createScripted(3)).toBe(1);
  });
});

describe('TanksBotManager: удаление', () => {
  it('removeScripted(team) удаляет только команду, из ядра — removePlayer', () => {
    bots.createScripted(2, 'team1');
    bots.createScripted(1, 'team2');

    bots.removeScripted('team1');

    expect(bots.getCount()).toBe(1);
    expect(coreAdapter.removePlayer).toHaveBeenCalledTimes(2);
    expect(stat.removeUser).toHaveBeenCalledTimes(2);
    expect(panel.removeUser).toHaveBeenCalledTimes(2);
  });

  it('removeScripted() без аргумента удаляет всех', () => {
    bots.createScripted(2);
    bots.removeScripted();

    expect(bots.getBots()).toEqual([]);
  });

  it('removeOneForHuman освобождает одно место в команде', () => {
    bots.createScripted(2, 'team1');

    expect(bots.removeOneForHuman('team1')).toBe(true);
    expect(bots.getCountForTeam('team1')).toBe(1);
    expect(bots.removeOneForHuman('team2')).toBe(false);
  });

  it('людей не трогает', () => {
    const humanId = participants.createHuman({ name: 'A', model: 'm1' }, 's1');

    bots.removeScripted();

    expect(participants.get(humanId)).toBeDefined();
    expect(bots.getBotById(humanId)).toBeUndefined();
  });
});
