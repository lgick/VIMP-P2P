// ClientPlugin танков: игровые хуки клиентского ядра (ClientCore).
// Пока импортируется статически (этап 3); в этапе 6 станет default export
// динамически загружаемого client-entry игры (плюс createClientCore/parts/
// bakers/styles). Движок (main.js) не знает игровых методов ядра —
// set_model/sync_panel/try_fire/cycle_weapon зовутся только отсюда.
export default {
  id: 'tanks',
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
