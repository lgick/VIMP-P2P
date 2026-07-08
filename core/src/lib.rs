// VIMP Tank Battle — единое ядро симуляции (Этап 2 P2P-миграции).
// Компилируется в WASM (браузер/Worker хоста и Node.js для тестов).
// Граница ядра — симуляция: физика, танки, оружие, боты, упаковка
// снапшотов. Мета (раунды, чат, статистика, панель) остаётся на JS
// и управляет ядром командами, получая события через take_events().

use wasm_bindgen::prelude::*;

pub mod bomb;
pub mod bots;
pub mod config;
pub mod events;
pub mod game;
pub mod map;
pub mod physics;
pub mod rng;
pub mod snapshot;
pub mod tank;

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
        let Some(map) = &self.state.map else {
            return "null".to_string();
        };

        let width = map.grid.first().map(|row| row.len()).unwrap_or(0) as f32 * map.step;
        let height = map.grid.len() as f32 * map.step;

        serde_json::json!({
            "setId": map.set_id,
            "step": map.step,
            "width": width,
            "height": height,
            "respawns": map.respawns,
        })
        .to_string()
    }

    // ***** участники ***** //

    pub fn spawn_tank(
        &mut self,
        game_id: u32,
        model: &str,
        team_id: u8,
        x: f32,
        y: f32,
        angle_deg: f32,
    ) -> Result<(), JsError> {
        self.state
            .spawn_tank(game_id, model, team_id, x, y, angle_deg)
            .map_err(|e| JsError::new(&e))
    }

    pub fn remove_tank(&mut self, game_id: u32) {
        self.state.remove_tank(game_id);
    }

    /// Респаун/смена команды (аналог Game.changePlayerData).
    pub fn reset_tank(&mut self, game_id: u32, team_id: u8, x: f32, y: f32, angle_deg: f32) {
        self.state.reset_tank(game_id, team_id, x, y, angle_deg);
    }

    /// Сброс здоровья/боезапаса всех танков (аналог Panel.reset).
    pub fn reset_all_vitals(&mut self) {
        self.state.reset_all_vitals();
    }

    pub fn add_bot(
        &mut self,
        game_id: u32,
        model: &str,
        team_id: u8,
        x: f32,
        y: f32,
        angle_deg: f32,
    ) -> Result<(), JsError> {
        self.state
            .add_bot(game_id, model, team_id, x, y, angle_deg)
            .map_err(|e| JsError::new(&e))
    }

    pub fn remove_bot(&mut self, game_id: u32) {
        self.state.remove_bot(game_id);
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
        let mut out = Vec::new();

        for (id, tank) in &self.state.tanks {
            if !tank.is_alive() {
                continue;
            }

            if let Some(pos) = self.state.tank_position_rounded(*id) {
                out.push(*id as f32);
                out.push(tank.team_id as f32);
                out.push(pos[0]);
                out.push(pos[1]);
            }
        }

        out
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
