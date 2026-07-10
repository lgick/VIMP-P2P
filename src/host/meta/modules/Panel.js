// Singleton Panel

let panel;

class Panel {
  constructor(config) {
    if (panel) {
      return panel;
    }

    panel = this;

    this._config = config;

    this._data = {};
    this._timerManager = null;

    this._emptyPanel = Object.values(this._config).map(item => item.key);
    this._defaultPanel = {};

    this._lastSentRoundTime = -1; // кеширование последнего значения времени

    for (const key of Object.keys(this._config)) {
      this._defaultPanel[key] = this._config[key].value;
    }
  }

  // внедряет зависимость TimerManager
  injectTimerManager(timerManager) {
    this._timerManager = timerManager;
    this._lastSentRoundTime = this._timerManager.getRoundTimeLeft();
  }

  // сбрасывает внутреннее состояние пользователей к дефолтному
  reset() {
    for (const gameId in this._data) {
      if (Object.hasOwn(this._data, gameId)) {
        const user = this._data[gameId];

        user.values = { ...this._defaultPanel };
        user.pendingChanges = {}; // очистка, без добавления новых данных
      }
    }
  }

  // добавляет пользователя
  addUser(gameId) {
    this._data[gameId] = {
      values: { ...this._defaultPanel },
      pendingChanges: {}, // объект для хранения только измененных данных
    };
  }

  // удаляет пользователя
  removeUser(gameId) {
    delete this._data[gameId];
  }

  // очищает ожидающие изменения для пользователя
  // требуется, когда состояние пользователя резко меняется
  // (например при уничтожении)
  invalidate(gameId) {
    const user = this._data[gameId];

    if (user) {
      user.pendingChanges = {};
    }
  }

  // обновляет данные пользователя
  // param: имя параметра из _config (например, 'health', 'w1')
  // value: значение
  // operation: 'set', 'decrement', 'increment'
  updateUser(gameId, param, value, operation = 'decrement') {
    const user = this._data[gameId];
    const values = user.values;
    const currentValue = values[param];
    let newValue;

    if (operation === 'set') {
      newValue = value;
    } else if (operation === 'decrement') {
      newValue = currentValue - value;
    } else if (operation === 'increment') {
      newValue = currentValue + value;
    }

    if (newValue < 0) {
      newValue = 0;
    }

    values[param] = newValue;
    user.pendingChanges[this._config[param].key] = newValue;
  }

  // устанавливает активное оружие
  setActiveWeapon(gameId, weaponKey) {
    const user = this._data[gameId];
    user.pendingChanges['wa'] = weaponKey;
  }

  // проверяет, достаточно ли у пользователя ресурсов для действия
  hasResources(gameId, param, value) {
    const user = this._data[gameId];
    const currentValue = user.values[param];

    return currentValue >= value;
  }

  // возвращает текущее значение параметра для пользователя
  getCurrentValue(gameId, param) {
    const user = this._data[gameId];

    return user.values[param];
  }

  // вычисляет все обновления панели за один тик
  processUpdates() {
    const updates = {};
    const currentTime = this._timerManager.getRoundTimeLeft();
    const timeChanged = currentTime !== this._lastSentRoundTime;

    if (timeChanged) {
      this._lastSentRoundTime = currentTime;
    }

    for (const gameId in this._data) {
      if (Object.hasOwn(this._data, gameId)) {
        const user = this._data[gameId];
        const userChanges = user.pendingChanges;
        const userData = [];

        if (timeChanged) {
          userData.push(`t:${currentTime}`);
        }

        for (const key in userChanges) {
          if (Object.hasOwn(userChanges, key)) {
            userData.push(`${key}:${userChanges[key]}`);
          }
        }

        if (userData.length) {
          updates[gameId] = userData;
        }

        user.pendingChanges = {};
      }
    }

    return updates;
  }

  // возвращает полный набор данных для инициализации панели игрока
  getFullPanel(gameId) {
    const user = this._data[gameId];
    user.pendingChanges = {}; // очистка старых изменений

    const panelData = [`t:${this._lastSentRoundTime}`];
    const values = user.values;

    for (const param in values) {
      if (Object.hasOwn(values, param)) {
        const key = this._config[param].key;
        const value = values[param];

        panelData.push(`${key}:${value}`);
      }
    }
    return panelData;
  }

  // возвращает пустые данные (ключи без значений)
  getEmptyPanel() {
    return [`t:${this._lastSentRoundTime}`].concat(this._emptyPanel);
  }
}

export default Panel;
