import { describe, it, expect, vi } from 'vitest';
import hostPlugin from '@vimp/tanks/host/index.js';

// HostPlugin танков — статическая сборка игровой половины хоста (этап 3);
// фиксируем поверхность, которую дергает движок (HostGame/host.worker).

describe('HostPlugin танков: поверхность', () => {
  it('несёт id и игровой конфиг', () => {
    expect(hostPlugin.id).toBe('tanks');
    expect(hostPlugin.gameConfig.teams).toBeDefined();
    expect(hostPlugin.gameConfig.panel.activeKey).toBe('wa');
    expect(hostPlugin.gameConfig.scripted).toEqual({
      namePrefix: 'Bot',
      defaultModel: 'm1',
    });
    expect(hostPlugin.gameConfig.roomDefaults.maxPlayers).toBe(8);
  });

  it('authSchema: params + игровые валидаторы', () => {
    expect(Array.isArray(hostPlugin.authSchema.params)).toBe(true);
    expect(hostPlugin.authSchema.validators.isValidModel('m1')).toBe(true);
  });

  it('chatCommands регистрируемы (пары name/handler)', () => {
    for (const command of hostPlugin.chatCommands) {
      expect(command.name.startsWith('/')).toBe(true);
      expect(typeof command.handler).toBe('function');
    }

    expect(hostPlugin.chatCommands.map(c => c.name)).toContain('/bot');
  });

  it('systemMessages — игровая группа кодов b:*', () => {
    for (const code of Object.values(hostPlugin.systemMessages)) {
      expect(code.startsWith('b:')).toBe(true);
    }
  });

  it('не задаёт onCoreEvent: не использует custom-события ядра', () => {
    expect(hostPlugin.onCoreEvent).toBeUndefined();
  });

  it('createModules возвращает scripted-модуль с контрактом движка', () => {
    const ctx = {
      participants: {},
      coreAdapter: { removePlayer: vi.fn() },
      panel: {},
      stat: {},
      scripted: hostPlugin.gameConfig.scripted,
    };
    const { scripted } = hostPlugin.createModules(ctx);

    for (const method of [
      'createMap',
      'createScripted',
      'removeScripted',
      'removeOneForHuman',
      'getCount',
      'getCountsPerTeam',
    ]) {
      expect(typeof scripted[method]).toBe('function');
    }
  });

  it('buildClientGameConfig отдаёт игровую половину CONFIG_DATA', () => {
    const clientConfig = hostPlugin.buildClientGameConfig();

    expect(clientConfig.parts.gameSets).toBeDefined();
    expect(clientConfig.modules.panel.keys).toBeDefined();
    expect(clientConfig.modules.stat.params.columns).toHaveLength(5);
    expect(clientConfig.initIdList).toContain('vimp');
  });
});
