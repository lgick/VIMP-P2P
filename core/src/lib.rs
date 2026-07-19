// VIMP P2P — единое ядро симуляции (Этап 2 P2P-миграции).
// Компилируется в WASM (браузер/Worker хоста и Node.js для тестов).
// Граница ядра — симуляция: физика, танки, оружие, боты, упаковка
// снапшотов. Мета (раунды, чат, статистика, панель) остаётся на JS
// и управляет ядром командами, получая события через take_events().

use wasm_bindgen::prelude::*;

pub mod bomb;
pub mod bots;
pub mod client;
pub mod config;
pub mod events;
pub mod game;
pub mod map;
pub mod motion;
pub mod physics;
pub mod rng;
pub mod sim;
pub mod snapshot;
pub mod tank;
pub mod tanks;

use client::ClientState;
use game::GameState;
use snapshot::{CameraData, PlayerBlock, SnapshotPacker};

/// Публичный ABI ядра для JS-оболочки (Worker хоста / тестовый харнесс).
#[wasm_bindgen]
pub struct GameCore {
    state: GameState,
    packer: SnapshotPacker,
}

#[wasm_bindgen]
impl GameCore {
    /// Создаёт ядро из JSON-конфига (собирается JS-оболочкой из
    /// game.js + models.js + weapons.js + opcodes.js).
    #[wasm_bindgen(constructor)]
    pub fn new(config_json: &str) -> Result<GameCore, JsError> {
        let cfg: config::CoreConfig =
            serde_json::from_str(config_json).map_err(|e| JsError::new(&e.to_string()))?;

        cfg.snapshot.validate().map_err(|e| JsError::new(&e))?;

        let packer = SnapshotPacker::new(cfg.snapshot.clone());

        Ok(GameCore {
            state: GameState::new(cfg),
            packer,
        })
    }

    /// Загружает карту из JSON (см. scripts/export-maps.js).
    pub fn load_map(&mut self, map_json: &str) -> Result<(), JsError> {
        self.state.load_map(map_json).map_err(|e| JsError::new(&e))
    }

    /// Информация о загруженной карте: setId, масштабированные респауны,
    /// размеры мира (JSON).
    pub fn map_info(&self) -> String {
        self.state.map_info_json()
    }

    // ***** участники ***** //

    pub fn spawn_actor(
        &mut self,
        game_id: u32,
        model: &str,
        team_id: u8,
        x: f32,
        y: f32,
        angle_deg: f32,
    ) -> Result<(), JsError> {
        self.state
            .spawn_actor(game_id, model, team_id, x, y, angle_deg)
            .map_err(|e| JsError::new(&e))
    }

    pub fn remove_actor(&mut self, game_id: u32) {
        self.state.remove_actor(game_id);
    }

    /// Респаун/смена команды (аналог Game.changePlayerData).
    pub fn reset_actor(&mut self, game_id: u32, team_id: u8, x: f32, y: f32, angle_deg: f32) {
        self.state.reset_actor(game_id, team_id, x, y, angle_deg);
    }

    /// Сброс здоровья/боезапаса всех танков (аналог Panel.reset).
    pub fn reset_all_vitals(&mut self) {
        self.state.reset_all_vitals();
    }

    pub fn spawn_scripted_actor(
        &mut self,
        game_id: u32,
        model: &str,
        team_id: u8,
        x: f32,
        y: f32,
        angle_deg: f32,
    ) -> Result<(), JsError> {
        self.state
            .spawn_scripted_actor(game_id, model, team_id, x, y, angle_deg)
            .map_err(|e| JsError::new(&e))
    }

    pub fn remove_scripted_actor(&mut self, game_id: u32) {
        self.state.remove_scripted_actor(game_id);
    }

    // ***** ввод и шаг ***** //

    /// Ввод игрока: seq + action ('down'/'up') + имя клавиши
    /// (wire-формат 'seq:action:name' разбирает JS-оболочка).
    pub fn apply_input(&mut self, game_id: u32, seq: u32, action: &str, key_name: &str) {
        self.state.apply_input(game_id, seq, action, key_name);
    }

    /// Шаг симуляции: фиксированные подшаги физики + ИИ ботов.
    pub fn step(&mut self, dt: f32) {
        self.state.step(dt);
    }

    /// События за тик (kill/health/ammo/weapon/shake) одной JSON-строкой;
    /// буфер очищается.
    pub fn take_events(&mut self) -> String {
        let events: Vec<events::CoreEvent> = self.state.events.drain(..).collect();

        serde_json::to_string(&events).unwrap_or_else(|_| "[]".to_string())
    }

    // ***** запросы состояния ***** //

    pub fn last_input_seq(&self, game_id: u32) -> u32 {
        self.state.last_input_seq(game_id)
    }

    pub fn is_alive(&self, game_id: u32) -> bool {
        self.state.tank_alive(game_id)
    }

    /// Координаты танка [x, y] (скруглены до 2 знаков) или пустой массив.
    pub fn position_of(&self, game_id: u32) -> Vec<f32> {
        self.state
            .tank_position_rounded(game_id)
            .map(|p| p.to_vec())
            .unwrap_or_default()
    }

    /// Полные данные всех игроков (Game.getPlayersData) одной JSON-строкой
    /// для первого кадра (FIRST_SHOT_DATA). Не дренирует накопители.
    pub fn players_data(&self) -> String {
        self.state.players_json()
    }

    /// Живые игроки плоским массивом [id, teamId, x, y, ...]
    /// (аналог Game.getAlivePlayers для меты).
    pub fn alive_players(&self) -> Vec<f32> {
        self.state.alive_players_flat()
    }

    // ***** снапшот ***** //

    /// Пакует broadcast-тело кадра, дренируя накопленные события
    /// снапшота. Вызывать один раз на отправляемый кадр (throttle
    /// частоты отправки — забота JS-оболочки).
    pub fn pack_body(&mut self) -> Result<(), JsError> {
        let blocks = self.state.build_snapshot_blocks();

        self.packer
            .pack_body(&blocks)
            .map_err(|e| JsError::new(&e))
    }

    /// Собирает per-user кадр v3 во внутренний буфер, возвращает длину.
    /// Кадр читается zero-copy через frame_ptr() + память WASM.
    /// player_id < 0 — кадр без player-блока (наблюдатель).
    #[allow(clippy::too_many_arguments)]
    pub fn pack_frame(
        &mut self,
        server_time: f64,
        seq: u32,
        has_camera: bool,
        camera_x: f32,
        camera_y: f32,
        force_reset: bool,
        shake: Option<String>,
        player_id: i32,
    ) -> usize {
        let camera = has_camera.then_some(CameraData {
            x: camera_x,
            y: camera_y,
            force_reset,
            shake,
        });

        let player = if player_id >= 0 {
            let game_id = player_id as u32;

            self.state
                .prediction_state(game_id)
                .map(|(state, centering)| PlayerBlock {
                    game_id: game_id as u8,
                    input_seq: self.state.last_input_seq(game_id),
                    state,
                    centering,
                })
        } else {
            None
        };

        self.packer
            .pack_frame(server_time, seq, camera.as_ref(), player.as_ref())
            .len()
    }

    /// Содержал ли последний `pack_body()` событийные блоки (трассеры/бомбы/
    /// взрывы/удаления). JS-Worker вызывает после `pack_body()` для выбора
    /// канала WebRTC: события → meta (reliable), только позиции → state.
    pub fn body_has_events(&self) -> bool {
        self.state.body_has_events()
    }

    /// Указатель на буфер последнего кадра (zero-copy чтение из JS:
    /// new Uint8Array(wasm.memory.buffer, ptr, len)).
    pub fn frame_ptr(&self) -> *const u8 {
        self.packer.frame_bytes().as_ptr()
    }

    /// Копия последнего кадра (nodejs-таргет не отдаёт память наружу;
    /// горячий путь браузера использует frame_ptr + память WASM).
    pub fn frame_bytes(&self) -> Vec<u8> {
        self.packer.frame_bytes().to_vec()
    }

    // ***** очистка и handoff ***** //

    /// Удаляет игроков и снаряды, возвращает JSON-массив имён для
    /// очистки полотна клиентов (Game.removePlayersAndShots).
    pub fn remove_players_and_shots(&mut self) -> String {
        serde_json::to_string(&self.state.remove_players_and_shots())
            .unwrap_or_else(|_| "[]".to_string())
    }

    /// Полная очистка мира (смена карты).
    pub fn clear(&mut self) {
        self.state.clear();
    }

    /// Дамп состояния симуляции (Worker Handoff, Этап 5.2).
    pub fn serialize_state(&self) -> Result<Vec<u8>, JsError> {
        self.state.serialize_state().map_err(|e| JsError::new(&e))
    }

    pub fn deserialize_state(&mut self, data: &[u8]) -> Result<(), JsError> {
        self.state
            .deserialize_state(data)
            .map_err(|e| JsError::new(&e))
    }
}

impl GameCore {
    /// Доступ к состоянию для нативных тестов (не экспортируется в JS).
    pub fn state(&self) -> &GameState {
        &self.state
    }

    pub fn state_mut(&mut self) -> &mut GameState {
        &mut self.state
    }
}

/// Клиентский режим ядра (срез 2.6): интерполяция снапшотов, предикт
/// своего танка, визуальный спавн снарядов и распаковка кадров v3.
/// Живёт в главном потоке вкладки клиента; горячие позиции читаются
/// zero-copy плоским Float32-буфером, событийные кадры — JSON-строкой.
#[wasm_bindgen]
pub struct ClientCore {
    state: ClientState,
}

#[wasm_bindgen]
impl ClientCore {
    /// Создаёт клиентское ядро из JSON-конфига
    /// (собирается src/lib/clientCoreConfig.js из CONFIG_DATA + opcodes).
    #[wasm_bindgen(constructor)]
    pub fn new(config_json: &str) -> Result<ClientCore, JsError> {
        let cfg: config::ClientConfig =
            serde_json::from_str(config_json).map_err(|e| JsError::new(&e.to_string()))?;

        cfg.snapshot.validate().map_err(|e| JsError::new(&e))?;

        Ok(ClientCore {
            state: ClientState::new(cfg),
        })
    }

    // ***** сеть ***** //

    /// Бинарный кадр из транспорта: распаковка, вставка в буфер по seq
    /// (+дедупликация/опоздавшие), reconciliation предикта по player-блоку.
    /// false — кадр отброшен (чужой порт/версия/повреждён).
    pub fn push_frame(&mut self, data: &[u8], local_now: f64) -> bool {
        self.state.push_frame(data, local_now)
    }

    /// Свой gameId из последнего player-блока; -1, если ещё не приходил.
    pub fn my_game_id(&self) -> i32 {
        self.state.my_game_id().map(|id| id as i32).unwrap_or(-1)
    }

    /// EMA-оценка (serverTime − localNow); NaN, если кадров ещё не было.
    pub fn offset(&self) -> f64 {
        self.state.offset().unwrap_or(f64::NAN)
    }

    // ***** рендер-тик ***** //

    /// Весь рендер-тик: выдача пересечённых кадров (фильтр дублей своих
    /// выстрелов → JSON-очередь), интерполяция, шаг предикта, запись
    /// hot-буфера. Возвращает длину hot-буфера в f32-элементах.
    pub fn sample(&mut self, local_now: f64) -> usize {
        self.state.sample(local_now)
    }

    /// Указатель на hot-буфер (zero-copy чтение из JS:
    /// new Float32Array(wasm.memory.buffer, ptr, len) — view пересоздавать
    /// каждый тик, рост памяти WASM инвалидирует buffer).
    pub fn hot_ptr(&self) -> *const f32 {
        self.state.hot().as_ptr()
    }

    /// Копия hot-буфера (nodejs-таргет; горячий путь браузера — hot_ptr).
    pub fn hot_values(&self) -> Vec<f32> {
        self.state.hot().to_vec()
    }

    /// Событийные кадры JSON-строкой [{game, camera}, ...] в форме,
    /// готовой для applyShot; вызывать при флаге hasFrames hot-буфера,
    /// очередь очищается.
    pub fn take_frames(&mut self) -> String {
        self.state.take_frames()
    }

    // ***** ввод и выстрелы ***** //

    /// Ввод игрока: action ('down'/'up') + имя клавиши — в историю предикта.
    pub fn apply_input(&mut self, action: &str, key_name: &str, local_now: f64) {
        self.state.apply_input(action, key_name, local_now);
    }

    /// Локальный визуальный выстрел: гейты (кулдаун/патроны/pending-бомба/
    /// жив/активен) внутри. JSON спавна для applyGameData либо None.
    pub fn try_fire(&mut self, local_now: f64) -> Option<String> {
        self.state.try_fire(local_now)
    }

    /// Локальный цикл смены оружия (авторитетное подтверждение — панелью).
    pub fn cycle_weapon(&mut self, back: bool) {
        self.state.cycle_weapon(back);
    }

    // ***** жизненный цикл ***** //

    /// Модель танка пользователя (известна при авторизации).
    pub fn set_model(&mut self, model: &str) {
        self.state.set_model(model);
    }

    /// Смена режима игрок/спектатор (KEYSET_DATA).
    pub fn set_active(&mut self, active: bool) {
        self.state.set_active(active);
    }

    /// Данные карты (MAP_DATA): мир raycast + сброс буфера и предикта.
    pub fn set_map(&mut self, map_json: &str) -> Result<(), JsError> {
        self.state.set_map(map_json).map_err(|e| JsError::new(&e))
    }

    /// Авторитетное состояние панели (PANEL_DATA): патроны/активное оружие.
    pub fn sync_panel(&mut self, panel_json: &str) {
        self.state.sync_panel(panel_json);
    }

    /// Полный сброс (порт CLEAR).
    pub fn reset(&mut self) {
        self.state.reset();
    }

    // ***** тесты и харнесс ***** //

    /// Чистая распаковка кадра v3 → JSON {port, seq, serverTime, camera,
    /// player, snapshot} (замена unpackFrame в тестах); 'null' при
    /// несовпадении версии или повреждённом кадре.
    pub fn decode_frame(&self, data: &[u8]) -> String {
        self.state.decode_frame(data)
    }
}
