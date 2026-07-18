import { describe, it, expect, vi, beforeEach } from 'vitest';
import coreEventRouter from '@vimp/tanks/host/coreEventRouter.js';

// Игровой роутер событий ядра (танки): маппинг словаря
// health/ammo/activeWeapon/shake/kill на мету движка. Ядро оперирует
// числовыми id (u32), мета ключует строками — роутер обязан приводить
// id к строкам (иначе kill/shake теряются).

describe('coreEventRouter (tanks)', () => {
  let panel;
  let vimp;
  let services;

  beforeEach(() => {
    panel = { updateUser: vi.fn(), setActiveWeapon: vi.fn() };
    vimp = { reportKill: vi.fn(), triggerCameraShake: vi.fn() };
    services = { panel, vimp };
  });

  it('health → panel.updateUser со строковым id', () => {
    coreEventRouter({ type: 'health', id: 1, value: 80 }, services);

    expect(panel.updateUser).toHaveBeenCalledWith('1', 'health', 80, 'set');
  });

  it('ammo → panel.updateUser по ключу оружия', () => {
    coreEventRouter({ type: 'ammo', id: 1, weapon: 'w1', value: 199 }, services);

    expect(panel.updateUser).toHaveBeenCalledWith('1', 'w1', 199, 'set');
  });

  it('activeWeapon → panel.setActiveWeapon', () => {
    coreEventRouter({ type: 'activeWeapon', id: 1, weapon: 'w2' }, services);

    expect(panel.setActiveWeapon).toHaveBeenCalledWith('1', 'w2');
  });

  it('shake → vimp.triggerCameraShake', () => {
    coreEventRouter(
      { type: 'shake', id: 2, intensity: 20, duration: 200 },
      services,
    );

    expect(vimp.triggerCameraShake).toHaveBeenCalledWith('2', {
      intensity: 20,
      duration: 200,
    });
  });

  it('kill → vimp.reportKill со строковыми victim/killer', () => {
    coreEventRouter({ type: 'kill', victim: 2, killer: 1 }, services);

    expect(vimp.reportKill).toHaveBeenCalledWith('2', '1');
  });

  it('неизвестный тип игнорируется без ошибок', () => {
    expect(() =>
      coreEventRouter({ type: 'unknown', id: 1 }, services),
    ).not.toThrow();

    expect(panel.updateUser).not.toHaveBeenCalled();
    expect(panel.setActiveWeapon).not.toHaveBeenCalled();
    expect(vimp.reportKill).not.toHaveBeenCalled();
    expect(vimp.triggerCameraShake).not.toHaveBeenCalled();
  });
});
