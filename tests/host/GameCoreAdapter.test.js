/* eslint-disable camelcase -- фейк ядра повторяет snake_case ABI GameCore */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import GameCoreAdapter from '../../src/host/GameCoreAdapter.js';

// Юнит-тесты адаптера ядра: маппинг команд на ABI, различение бот/человек,
// диспетчеризация событий ядра в инъецируемый eventRouter, флаги камеры в
// packFrame. Ядро — фейк (реальный core покрыт интеграционными
// HostGame.test.js и tests/core); игровой роутер — coreEventRouter.test.js.

// Фейк ядра: записывает вызовы, отдаёт заранее заданные события/кадр.
const makeFakeCore = (events = []) => ({
  calls: [],
  events,
  load_map(json) {
    this.calls.push(['load_map', json]);
  },
  clear() {
    this.calls.push(['clear']);
  },
  spawn_tank(...a) {
    this.calls.push(['spawn_tank', ...a]);
  },
  add_bot(...a) {
    this.calls.push(['add_bot', ...a]);
  },
  remove_tank(id) {
    this.calls.push(['remove_tank', id]);
  },
  remove_bot(id) {
    this.calls.push(['remove_bot', id]);
  },
  reset_tank(...a) {
    this.calls.push(['reset_tank', ...a]);
  },
  apply_input(...a) {
    this.calls.push(['apply_input', ...a]);
  },
  remove_players_and_shots() {
    return JSON.stringify(['m1', 'w1']);
  },
  players_data() {
    return JSON.stringify({ m1: { 1: [1, 2, 0, 0, 0, 0, 0, 3, 2, 1] } });
  },
  position_of(id) {
    return id === 99 ? [] : [10, 20];
  },
  is_alive() {
    return true;
  },
  step(dt) {
    this.calls.push(['step', dt]);
  },
  take_events() {
    return JSON.stringify(this.events);
  },
  pack_body() {
    this.calls.push(['pack_body']);
  },
  pack_frame(...a) {
    this.calls.push(['pack_frame', ...a]);
  },
  frame_bytes() {
    return new Uint8Array([5, 3, 0, 0]);
  },
});

const makeParticipants = (bots = new Set()) => ({
  get: id => ({ isBot: bots.has(id) }),
});

const noopRouter = () => {};

describe('GameCoreAdapter', () => {
  let core;
  let panel;
  let vimp;

  beforeEach(() => {
    core = makeFakeCore();
    panel = { updateUser: vi.fn(), setActiveWeapon: vi.fn() };
    vimp = { reportKill: vi.fn(), triggerCameraShake: vi.fn() };
  });

  it('createMap грузит масштабированную карту со scale:1', () => {
    const adapter = new GameCoreAdapter(core, {
      participants: makeParticipants(),
      eventRouter: noopRouter,
    });

    adapter.createMap({ step: 19.2, map: [[0]], scale: 0.6, setId: 'c1' });

    const [, json] = core.calls.find(c => c[0] === 'load_map');
    const parsed = JSON.parse(json);

    expect(parsed.scale).toBe(1); // ядро не масштабирует повторно
    expect(parsed.step).toBe(19.2);
    expect(parsed.setId).toBe('c1');
  });

  it('createPlayer различает человека (spawn_tank) и бота (add_bot)', () => {
    const adapter = new GameCoreAdapter(core, {
      participants: makeParticipants(new Set([2])),
      eventRouter: noopRouter,
    });

    adapter.createPlayer(1, 'm1', 'Human', 1, [10, 20, 0]);
    adapter.createPlayer(2, 'm1', 'Bot', 2, [30, 40, 90]);

    expect(core.calls).toContainEqual(['spawn_tank', 1, 'm1', 1, 10, 20, 0]);
    expect(core.calls).toContainEqual(['add_bot', 2, 'm1', 2, 30, 40, 90]);
  });

  it('removePlayer различает человека (remove_tank) и бота (remove_bot)', () => {
    const adapter = new GameCoreAdapter(core, {
      participants: makeParticipants(new Set([2])),
      eventRouter: noopRouter,
    });

    adapter.removePlayer(1);
    adapter.removePlayer(2);

    expect(core.calls).toContainEqual(['remove_tank', 1]);
    expect(core.calls).toContainEqual(['remove_bot', 2]);
  });

  it('changePlayerData → reset_tank с координатами респауна', () => {
    const adapter = new GameCoreAdapter(core, {
      participants: makeParticipants(),
      eventRouter: noopRouter,
    });

    adapter.changePlayerData(1, { respawnData: [5, 6, 180], teamId: 2 });

    expect(core.calls).toContainEqual(['reset_tank', 1, 2, 5, 6, 180]);
  });

  it('applyInput → apply_input с seq', () => {
    const adapter = new GameCoreAdapter(core, {
      participants: makeParticipants(),
      eventRouter: noopRouter,
    });

    adapter.applyInput(1, 42, 'down', 'forward');

    expect(core.calls).toContainEqual(['apply_input', 1, 42, 'down', 'forward']);
  });

  it('getPosition: [] от ядра → [0, 0]', () => {
    const adapter = new GameCoreAdapter(core, {
      participants: makeParticipants(),
      eventRouter: noopRouter,
    });

    expect(adapter.getPosition(1)).toEqual([10, 20]);
    expect(adapter.getPosition(99)).toEqual([0, 0]);
  });

  it('getPlayersData парсит players_data ядра', () => {
    const adapter = new GameCoreAdapter(core, {
      participants: makeParticipants(),
      eventRouter: noopRouter,
    });

    expect(adapter.getPlayersData()).toEqual({
      m1: { 1: [1, 2, 0, 0, 0, 0, 0, 3, 2, 1] },
    });
  });

  // словарь событий принадлежит игре: адаптер лишь дренирует take_events()
  // и отдаёт каждое событие инъецируемому роутеру вместе с сервисами меты
  it('updateData диспетчеризует события ядра в eventRouter с сервисами', () => {
    const events = [
      { type: 'health', id: 1, value: 80 },
      { type: 'kill', victim: 2, killer: 1 },
    ];

    core = makeFakeCore(events);

    const eventRouter = vi.fn();
    const adapter = new GameCoreAdapter(core, {
      participants: makeParticipants(),
      eventRouter,
    });

    adapter.injectServices({ vimp, panel });
    adapter.updateData(1 / 120);

    expect(core.calls).toContainEqual(['step', 1 / 120]);
    expect(eventRouter).toHaveBeenCalledTimes(2);
    expect(eventRouter).toHaveBeenNthCalledWith(1, events[0], { vimp, panel });
    expect(eventRouter).toHaveBeenNthCalledWith(2, events[1], { vimp, panel });
  });

  it('packFrame прокидывает флаги камеры и playerId, возвращает ArrayBuffer', () => {
    const adapter = new GameCoreAdapter(core, {
      participants: makeParticipants(),
      eventRouter: noopRouter,
    });

    const buf = adapter.packFrame([10, 20, true, '20:200'], 1234.5, 7, 1);

    expect(core.calls).toContainEqual([
      'pack_frame',
      1234.5,
      7,
      true,
      10,
      20,
      true,
      '20:200',
      1,
    ]);
    expect(buf).toBeInstanceOf(ArrayBuffer);
    expect(buf.byteLength).toBe(4);
  });

  it('packFrame наблюдателя: playerId null → -1, без камеры', () => {
    const adapter = new GameCoreAdapter(core, {
      participants: makeParticipants(),
      eventRouter: noopRouter,
    });

    adapter.packFrame(0, 1000, 3, null);

    expect(core.calls).toContainEqual([
      'pack_frame',
      1000,
      3,
      false,
      0,
      0,
      false,
      undefined,
      -1,
    ]);
  });
});
