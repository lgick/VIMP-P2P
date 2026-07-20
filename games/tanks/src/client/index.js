import { ENGINE_API_VERSION } from '@vimp/engine/config/opcodes.js';
import init, { ClientCore } from '../../core/pkg-web/vimp_tanks_core.js';
// игровой CSS (панель/полотна/команды) как строка — движок сам вставляет
// его в DOM (поле styles контракта); ?inline не даёт Vite auto-inject
// <style> при сборке (см. games/tanks/vite.config.js — сборка без index.html)
import styles from './tanks.css?inline';
import parts from './parts/index.js';
import bakers from './bakers/index.js';

// ClientPlugin танков: рендеры сущностей (parts), процедурные текстуры
// (bakers) и игровые хуки клиентского ядра (ClientCore). default export
// client-entry игры (games/tanks/vite.config.js --mode client, Этап 6.1);
// пока подключается статически через gameRegistry.static.js (Этап 5) —
// динамическая загрузка по GameManifest приедет в Этапе 6.3.
// Движок (main.js) не знает игровых методов ядра —
// set_model/sync_panel/try_fire/cycle_weapon зовутся только отсюда.
export default {
  id: 'tanks',
  engineApi: ENGINE_API_VERSION,

  // wasmUrl — из GameManifest.entries.wasm (общий с host-плагином ассет)
  async createClientCore(clientConfigJson, { wasmUrl }) {
    const wasm = await init(wasmUrl);

    return { core: new ClientCore(clientConfigJson), memory: wasm.memory };
  },

  parts,
  bakers,
  styles,
  hooks: {
    // авторизация: модель танка пользователя — для реплик движения и выстрелов
    onAuth(core, authData) {
      core.set_model(authData.model);
    },

    // кадр панели: зеркало боезапаса/активного оружия для гейтов try_fire
    onPanel(core, panelData) {
      core.sync_panel(JSON.stringify(panelData));
    },

    // локальное действие игрока; возвращает JSON спавна выстрела либо null.
    // Гейты в ядре: предикт активен, свой танк жив, хватает боезапаса
    onLocalAction(core, action, name, now) {
      if (action !== 'down') {
        return null;
      }

      if (name === 'fire') {
        return core.try_fire(now) || null;
      }

      if (name === 'nextWeapon' || name === 'prevWeapon') {
        core.cycle_weapon(name === 'prevWeapon');
      }

      return null;
    },
  },
};
