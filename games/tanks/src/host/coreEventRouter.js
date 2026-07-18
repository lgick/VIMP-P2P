// Игровой роутер событий Rust-ядра: словарь танковой игры
// (health/ammo/activeWeapon/shake/kill) → мета-модули движка.
// Временный мост (PR 3.1) до стандартных событий Wasm ABI
// (panelSet/panelActive/death/shake/custom, этап 4a): движковый
// GameCoreAdapter дренирует take_events() и отдаёт каждое событие сюда,
// не зная игрового словаря.
//
// Ядро оперирует числовыми id (u32), мета (Panel, Stat, ParticipantManager)
// ключует строками — id приводятся к строкам на этой границе.
// Worker-safe: чистая функция, без DOM и Node-глобалов.

/**
 * @param {Object} event - событие ядра из take_events().
 * @param {Object} services - сервисы движка: { panel, vimp }.
 */
export default function coreEventRouter(event, { panel, vimp }) {
  switch (event.type) {
    case 'health':
      panel.updateUser(String(event.id), 'health', event.value, 'set');
      break;

    case 'ammo':
      panel.updateUser(String(event.id), event.weapon, event.value, 'set');
      break;

    case 'activeWeapon':
      panel.setActiveWeapon(String(event.id), event.weapon);
      break;

    case 'shake':
      vimp.triggerCameraShake(String(event.id), {
        intensity: event.intensity,
        duration: event.duration,
      });
      break;

    case 'kill':
      vimp.reportKill(String(event.victim), String(event.killer));
      break;
  }
}
