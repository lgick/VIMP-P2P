// Адаптер Rust-ядра (GameCore) под интерфейс, который потребляют мета-модули
// хоста (RoundManager, SocketManager) и host-фасад. За поверхностью Game.js
// (+ упаковка снапшотов) стоит WASM-ядро; события ядра (take_events)
// проецируются в те же точки, куда JS-Game писал напрямую: панель и фасад.
//
// Различие бот/человек — по participants.get(gameId).isBot: бот создаётся как
// танк + ИИ-контроллер внутри ядра (add_bot/remove_bot), человек — только
// танк (spawn_tank/remove_tank).
export default class GameCoreAdapter {
  /**
   * @param {GameCore} core - экземпляр WASM-ядра.
   * @param {Object} deps
   * @param {ParticipantManager} deps.participants - реестр участников
   *   (различение бот/человек при спавне и удалении).
   */
  constructor(core, { participants }) {
    this._core = core;
    this._participants = participants;
    this._services = {}; // { vimp, panel } — инъекция как у Game.js
  }

  // получает сервисы (аналог Game.injectServices): { vimp, panel }
  injectServices(services) {
    Object.assign(this._services, services);
  }

  // ***** карта ***** //

  // создаёт карту в ядре. scaledMapData уже отмасштабирован в JS
  // (RoundManager.scaleMapData) — грузим со scale:1, чтобы ядро не
  // масштабировало повторно (геометрия совпадает с легаси-сервером байт-в-байт)
  createMap(scaledMapData) {
    this._core.load_map(JSON.stringify({ ...scaledMapData, scale: 1 }));
  }

  // полная очистка мира (смена карты)
  clear() {
    this._core.clear();
  }

  // ***** участники ***** //

  // создаёт танк (Game.createPlayer). Бот → танк + ИИ в ядре
  createPlayer(gameId, model, name, teamId, data) {
    const [x, y, angle] = data;

    if (this._isBot(gameId)) {
      this._core.add_bot(gameId, model, teamId, x, y, angle);
    } else {
      this._core.spawn_tank(gameId, model, teamId, x, y, angle);
    }
  }

  // удаляет танк (Game.removePlayer). Бот → удаляет и ИИ-контроллер
  removePlayer(gameId) {
    if (this._isBot(gameId)) {
      this._core.remove_bot(gameId);
    } else {
      this._core.remove_tank(gameId);
    }
  }

  // удаляет всех игроков и снаряды, возвращает имена для очистки полотна
  removePlayersAndShots() {
    return JSON.parse(this._core.remove_players_and_shots());
  }

  // имена — мета (ParticipantManager/Stat), ядру не нужны
  changeName() {}

  // перемещает танк при смене команды/респауне (Game.changePlayerData)
  changePlayerData(gameId, data) {
    const [x, y, angle] = data.respawnData;

    this._core.reset_tank(gameId, data.teamId, x, y, angle);
  }

  // ***** ввод ***** //

  // применяет ввод игрока; seq подтверждается ядром в player-блоке кадра
  applyInput(gameId, seq, action, name) {
    this._core.apply_input(gameId, seq, action, name);
  }

  // ***** запросы состояния ***** //

  isAlive(gameId) {
    return this._core.is_alive(gameId);
  }

  // координаты танка [x, y]; [] от ядра → [0, 0] (наблюдение за пустотой)
  getPosition(gameId) {
    const pos = this._core.position_of(gameId);

    return pos.length ? [pos[0], pos[1]] : [0, 0];
  }

  // полные данные всех игроков для первого кадра (SocketManager.sendFirstShot)
  getPlayersData() {
    return JSON.parse(this._core.players_data());
  }

  // ***** игровой тик ***** //

  // шаг симуляции (физика + ИИ ботов в ядре) и проекция событий в мету
  updateData(dt) {
    this._core.step(dt);
    this._drainEvents();
  }

  // проецирует события ядра в панель и фасад (как писал JS-Game напрямую)
  _drainEvents() {
    const events = JSON.parse(this._core.take_events());
    const { panel, vimp } = this._services;

    for (const event of events) {
      switch (event.type) {
        case 'health':
          panel.updateUser(event.id, 'health', event.value, 'set');
          break;

        case 'ammo':
          panel.updateUser(event.id, event.weapon, event.value, 'set');
          break;

        case 'activeWeapon':
          panel.setActiveWeapon(event.id, event.weapon);
          break;

        case 'shake':
          vimp.triggerCameraShake(event.id, {
            intensity: event.intensity,
            duration: event.duration,
          });
          break;

        case 'kill':
          vimp.reportKill(event.victim, event.killer);
          break;
      }
    }
  }

  // ***** упаковка снапшота ***** //

  // пакует broadcast-тело кадра (один раз за отправляемый кадр)
  packBody() {
    this._core.pack_body();
  }

  // содержал ли последний packBody событийные блоки (трассеры/бомбы/взрывы/
  // удаления) — для классификации канала WebRTC (meta reliable / state)
  bodyHasEvents() {
    return this._core.body_has_events();
  }

  /**
   * Пакует per-user кадр v3 и возвращает его ArrayBuffer.
   * @param {Array|number} camera - [x, y, forceReset?, shake?] или 0.
   * @param {number} serverTime
   * @param {number} seq
   * @param {number|null} playerId - id играющего (null/наблюдатель → без
   *   player-блока).
   * @returns {ArrayBuffer}
   */
  packFrame(camera, serverTime, seq, playerId) {
    const hasCamera = Array.isArray(camera);
    const camX = hasCamera ? camera[0] : 0;
    const camY = hasCamera ? camera[1] : 0;
    const forceReset = hasCamera && camera[2] === true;
    const shake = hasCamera && camera[3] ? camera[3] : undefined;

    this._core.pack_frame(
      serverTime,
      seq,
      hasCamera,
      camX,
      camY,
      forceReset,
      shake,
      playerId ?? -1,
    );

    // копия из памяти WASM (target-agnostic: работает и на web, и на nodejs)
    const bytes = this._core.frame_bytes();

    return bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    );
  }

  // бот ли участник (спавн/удаление в ядре различаются)
  _isBot(gameId) {
    const participant = this._participants.get(gameId);

    return Boolean(participant && participant.isBot);
  }
}
