//! Игровая половина клиентского ядра (срез 2.6, распил на `GameClientDef`
//! в Этапе 4b): client-side prediction своего танка (`Predictor`),
//! визуальный спавн снарядов (`ShotPredictor`) и отслеживание своего танка
//! в кадре. Сетевой буфер, hot-буфер рендер-тика и очередь событийных
//! кадров — движковые, живут в `vimp_engine_core::client::game::ClientState<TanksClient>`.

pub mod predictor;
pub mod shot;

use vimp_engine_core::client::game::{GameClientDef, RenderOverlay};
use vimp_engine_core::client::interpolator::{FrameData, InterpolatedGame};
use vimp_engine_core::client::unpack::{BlockData, DecodedSnapshot};
use vimp_engine_core::config::{EngineClientConfig, FieldValue, PLAYER_STATE_LEN, SnapshotConfig};

use crate::config::TanksClientConfig;
use predictor::Predictor;
use shot::ShotPredictor;

// индексы полей строки m1 (x, y, angle, gunRotation, vx, vy, engineLoad,
// condition, size, teamId) — позиционный контракт со схемой opcodes.js.
const TANK_FIELD_CONDITION: usize = 7;
const TANK_FIELD_SIZE: usize = 8;
const TANK_FIELD_TEAM: usize = 9;

fn field_u8(fields: &[FieldValue], i: usize) -> u8 {
    match fields[i] {
        FieldValue::U8(v) => v,
        _ => 0,
    }
}

/// Игровая реализация `GameClientDef` для танков: связывает `Predictor`
/// (реплика движения своего танка) и `ShotPredictor` (визуальный спавн
/// снарядов/raycast) с generic-оркестрацией `ClientState<G>` движка.
pub struct TanksClient {
    models: indexmap::IndexMap<String, crate::config::ModelConfig>,
    snapshot: SnapshotConfig,
    predictor: Predictor,
    shot: ShotPredictor,

    // свой танк: ключ модели из авторизации + id снапшот-схемы этого ключа,
    // дискретные поля из последнего кадра
    my_model_key: Option<String>,
    my_model_key_id: Option<u8>,
    my_tank_meta: Option<(u8, u8, u8)>, // condition, size, teamId
}

impl TanksClient {
    // гейт визуального спавна/выстрела: предикт активен и свой танк жив
    fn alive_with_state(&self) -> bool {
        self.predictor.has_state() && self.my_tank_meta.is_some_and(|meta| meta.0 != 0)
    }
}

impl GameClientDef for TanksClient {
    type Config = TanksClientConfig;

    fn new(cfg: &Self::Config, engine_cfg: &EngineClientConfig) -> Self {
        let predictor = Predictor::new(engine_cfg.time_step_ms, &cfg.player_keys, &cfg.models);
        let shot = ShotPredictor::new(&cfg.models, &cfg.weapons, cfg.seed);

        Self {
            models: cfg.models.clone(),
            snapshot: engine_cfg.snapshot.clone(),
            predictor,
            shot,
            my_model_key: None,
            my_model_key_id: None,
            my_tank_meta: None,
        }
    }

    fn on_server_state(
        &mut self,
        state: [f32; PLAYER_STATE_LEN],
        centering: bool,
        server_time: f64,
        offset: f64,
        local_now: f64,
    ) {
        self.predictor
            .on_server_state(state, centering, server_time, offset, local_now);
    }

    fn set_server_offset(&mut self, offset: Option<f64>) {
        self.shot.set_server_offset(offset);
    }

    fn update(&mut self, local_now: f64) {
        self.predictor.update(local_now);
    }

    // отслеживание своего танка в выданном кадре: reset предикта по
    // forceReset камеры, дискретные поля, freeze при уничтожении
    fn track_frame(&mut self, my_game_id: Option<u32>, frame: &FrameData) {
        if frame.camera.as_ref().is_some_and(|c| c.force_reset) {
            self.predictor.reset();
        }

        let (Some(my_id), Some(model_key)) = (my_game_id, &self.my_model_key) else {
            return;
        };

        if let Some(BlockData::Indexed8(items)) = frame.snapshot.block_by_key(model_key)
            && let Some(entry) = items.get(&(my_id as u8))
        {
            match entry {
                // null-маркер: танк удалён с полотна
                None => self.my_tank_meta = None,
                Some(row) => {
                    let (condition, size, team) = (
                        field_u8(row, TANK_FIELD_CONDITION),
                        field_u8(row, TANK_FIELD_SIZE),
                        field_u8(row, TANK_FIELD_TEAM),
                    );

                    self.my_tank_meta = Some((condition, size, team));
                    self.predictor.freeze(condition == 0);
                }
            }
        }
    }

    fn filter_frame_game(
        &mut self,
        game: &mut serde_json::Map<String, serde_json::Value>,
        my_game_id: Option<u32>,
        local_now: f64,
    ) {
        self.shot.filter_frame_game(game, my_game_id, local_now);
    }

    fn update_world(&mut self, snapshot: &DecodedSnapshot) {
        self.shot.update_world(snapshot);
    }

    fn update_world_interpolated(&mut self, game: &InterpolatedGame) {
        self.shot.update_world_interpolated(game);
    }

    // predicted-хвост hot-буфера: keyId, gameId, x, y, angle, gun, vx, vy,
    // engineLoad, condition, size, teamId (12 f32) — без meta своего танка
    // не рендерится.
    fn render_overlay(&self, my_game_id: Option<u32>) -> Option<RenderOverlay> {
        let my_game_id = my_game_id?;
        let my_model_key_id = self.my_model_key_id?;
        let (condition, size, team) = self.my_tank_meta?;
        let p = self.predictor.render_state()?;

        Some(RenderOverlay {
            camera: [p.x, p.y],
            tail: vec![
                my_model_key_id as f32,
                my_game_id as f32,
                p.x,
                p.y,
                p.angle,
                p.gun_rotation,
                p.vx,
                p.vy,
                p.engine_load,
                condition as f32,
                size as f32,
                team as f32,
            ],
        })
    }

    fn apply_input(&mut self, action: &str, key_name: &str, local_now: f64) {
        self.predictor.apply_input(action, key_name, local_now);
    }

    /// Модель танка пользователя (авторизация).
    fn set_model(&mut self, model_name: &str) {
        self.predictor.set_model(model_name);
        self.shot.set_model(model_name);

        self.my_model_key = self
            .models
            .contains_key(model_name)
            .then(|| model_name.to_string());
        self.my_model_key_id = self.snapshot.keys.get(model_name).map(|info| info.id);
    }

    /// Смена режима игрок/спектатор (KEYSET_DATA).
    fn set_active(&mut self, active: bool) {
        self.predictor.set_active(active);
        self.shot.reset();
    }

    /// Данные карты (MAP_DATA): мир raycast + сброс предикта.
    fn set_map(&mut self, map_json: &str) -> Result<(), String> {
        self.predictor.reset();
        self.shot.set_map(map_json)
    }

    /// Авторитетное состояние панели (PANEL_DATA): патроны, активное оружие.
    fn sync_panel(&mut self, items: &[String]) {
        self.shot.sync_panel(items);
    }

    /// Полный сброс (порт CLEAR).
    fn reset(&mut self) {
        self.predictor.reset();
        self.shot.reset();
    }

    fn cycle_weapon(&mut self, back: bool) {
        if self.alive_with_state() {
            self.shot.cycle_weapon(back);
        }
    }

    /// Локальный выстрел (гейт: предикт активен, свой танк жив).
    /// JSON спавна для applyGameData либо None.
    fn try_fire(&mut self, my_game_id: Option<u32>, local_now: f64) -> Option<String> {
        if !self.alive_with_state() {
            return None;
        }

        let render = self.predictor.render_state()?;
        let spawn = self.shot.try_fire(&render, my_game_id?, local_now)?;

        Some(spawn.to_string())
    }
}

/// Клиентское ядро игры: generic-оркестрация движка + игровая предикт-логика.
pub type ClientState = vimp_engine_core::client::game::ClientState<TanksClient>;

#[cfg(test)]
mod tests {
    use super::*;
    use vimp_engine_core::client::{HOT_HAS_CAMERA, HOT_HAS_FRAMES, HOT_HAS_GAME, HOT_HAS_PREDICTED};
    use vimp_engine_core::snapshot::{Block, CameraData, PlayerBlock, SnapshotPacker};

    fn config_json() -> serde_json::Value {
        serde_json::json!({
            "timeStepMs": 1000.0 / 120.0,
            "models": {
                "m1": {
                    "currentWeapon": "w1",
                    "size": 2,
                    "accelerationFactor": 1000,
                    "brakingFactor": 10,
                    "maxForwardSpeed": 260,
                    "maxReverseSpeed": -130,
                    "baseTurnTorqueFactor": 215,
                    "damping": { "linear": 3, "angular": 100.0 },
                    "fixture": { "density": 200, "friction": 0.5, "restitution": 0.1 },
                    "lateralGrip": 20,
                    "turnSpeedThreshold": 10,
                    "baseTurnFactorRatio": 0.8,
                    "reverseTurnMultiplier": 0.7,
                    "throttleIncreaseRate": 2.0,
                    "throttleDecreaseRate": 2.5,
                    "strainFactor": 1.5,
                    "maxGunAngle": 1.4,
                    "gunRotationSpeed": 3.0,
                    "gunCenterSpeed": 10.0
                }
            },
            "weapons": {
                "w1": { "type": "hitscan", "range": 100, "fireRate": 0.5, "spread": 0 },
                "w2": { "type": "explosive", "time": 300, "size": 8, "fireRate": 0.1 }
            },
            "playerKeys": {
                "forward": { "key": 1 },
                "back": { "key": 2 },
                "left": { "key": 4 },
                "right": { "key": 8 },
                "gunCenter": { "key": 16, "type": 1 },
                "gunLeft": { "key": 32 },
                "gunRight": { "key": 64 },
                "fire": { "key": 128, "type": 1 }
            },
            "snapshot": {
                "version": 3,
                "port": 5,
                "keys": {
                    "m1": { "id": 1, "kind": "indexed8", "class": "hot", "fields": [
                        { "name": "x", "ty": "f32", "interp": "lerp" },
                        { "name": "y", "ty": "f32", "interp": "lerp" },
                        { "name": "angle", "ty": "f32", "interp": "lerpAngle" },
                        { "name": "gunRotation", "ty": "f32", "interp": "lerpAngle" },
                        { "name": "vx", "ty": "f32", "interp": "lerp" },
                        { "name": "vy", "ty": "f32", "interp": "lerp" },
                        { "name": "engineLoad", "ty": "f32", "interp": "lerp" },
                        { "name": "condition", "ty": "u8" },
                        { "name": "size", "ty": "u8" },
                        { "name": "team", "ty": "u8" }
                    ] },
                    "w1": { "id": 2, "kind": "list16", "class": "event", "fields": [
                        { "name": "startX", "ty": "f32" },
                        { "name": "startY", "ty": "f32" },
                        { "name": "endX", "ty": "f32" },
                        { "name": "endY", "ty": "f32" },
                        { "name": "bodyX", "ty": "f32" },
                        { "name": "bodyY", "ty": "f32" },
                        { "name": "wasHit", "ty": "u8" },
                        { "name": "shooterId", "ty": "u8" }
                    ] },
                    "w2": { "id": 3, "kind": "indexed32", "class": "event", "fields": [
                        { "name": "x", "ty": "f32" },
                        { "name": "y", "ty": "f32" },
                        { "name": "angle", "ty": "f32" },
                        { "name": "size", "ty": "u8" },
                        { "name": "time", "ty": "u16" },
                        { "name": "ownerId", "ty": "u8" }
                    ] },
                    "w2e": { "id": 4, "kind": "list16", "class": "event", "fields": [
                        { "name": "x", "ty": "f32" },
                        { "name": "y", "ty": "f32" },
                        { "name": "radius", "ty": "f32" }
                    ] },
                    "c1": { "id": 5, "kind": "indexedNoNull8", "class": "hot", "fields": [
                        { "name": "x", "ty": "f32", "interp": "lerp" },
                        { "name": "y", "ty": "f32", "interp": "lerp" },
                        { "name": "angle", "ty": "f32", "interp": "lerpAngle" }
                    ] }
                }
            },
            "interpolation": { "delay": 100, "maxFrameAge": 1000 },
            "seed": 42
        })
    }

    fn engine_client_config() -> EngineClientConfig {
        serde_json::from_value(config_json()).unwrap()
    }

    fn game_client_config() -> TanksClientConfig {
        serde_json::from_value(config_json()).unwrap()
    }

    fn make_state() -> ClientState {
        ClientState::new(engine_client_config(), &game_client_config())
    }

    fn tank_row(x: f32, condition: u8) -> Vec<FieldValue> {
        vec![
            FieldValue::F32(x),
            FieldValue::F32(0.0),
            FieldValue::F32(0.0),
            FieldValue::F32(0.0),
            FieldValue::F32(0.0),
            FieldValue::F32(0.0),
            FieldValue::F32(0.0),
            FieldValue::U8(condition),
            FieldValue::U8(2),
            FieldValue::U8(1),
        ]
    }

    // кадр с танком id 2 (+опционально player-блок id 2 и камера)
    fn frame_bytes(
        server_time: f64,
        seq: u32,
        x: f32,
        condition: u8,
        with_player: bool,
        force_reset: bool,
    ) -> Vec<u8> {
        let cfg = engine_client_config();
        let mut packer = SnapshotPacker::new(cfg.snapshot.clone());

        packer
            .pack_body(&[(
                "m1".to_string(),
                Block::Indexed8(vec![(2, Some(tank_row(x, condition)))]),
            )])
            .unwrap();

        let camera = CameraData {
            x,
            y: 0.0,
            force_reset,
            shake: None,
        };
        let player = PlayerBlock {
            game_id: 2,
            input_seq: 0,
            state: [x, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            centering: false,
        };

        packer
            .pack_frame(
                server_time,
                seq,
                Some(&camera),
                with_player.then_some(&player),
            )
            .to_vec()
    }

    #[test]
    fn push_frame_rejects_foreign_port_and_version() {
        let mut state = make_state();
        let mut frame = frame_bytes(1000.0, 1, 0.0, 3, false, false);

        frame[0] = 9; // чужой порт
        assert!(!state.push_frame(&frame, 1000.0));

        let mut frame = frame_bytes(1000.0, 1, 0.0, 3, false, false);

        frame[1] = 99; // чужая версия
        assert!(!state.push_frame(&frame, 1000.0));

        let frame = frame_bytes(1000.0, 1, 0.0, 3, false, false);

        assert!(state.push_frame(&frame, 1000.0));
    }

    #[test]
    fn sample_writes_hot_layout_and_queues_frames() {
        let mut state = make_state();

        state.push_frame(&frame_bytes(1000.0, 1, 10.0, 3, false, false), 1000.0);
        state.push_frame(&frame_bytes(1100.0, 2, 20.0, 3, false, false), 1100.0);

        // renderTime = 1150 − 100 = 1050 → alpha 0.5
        let len = state.sample(1150.0);
        let hot = state.hot().to_vec();

        assert_eq!(len, hot.len());

        let flags = hot[0] as u32;

        assert!(flags & HOT_HAS_GAME != 0);
        assert!(flags & HOT_HAS_CAMERA != 0);
        assert!(flags & HOT_HAS_FRAMES != 0);
        assert!(flags & HOT_HAS_PREDICTED == 0);

        // камера интерполирована
        assert_eq!(hot[1], 15.0);
        assert_eq!(hot[2], 0.0);

        // один танк: keyId 1, gameId 2, x = 15 (лерп)
        assert_eq!(hot[3], 1.0);
        assert_eq!(hot[4], 1.0);
        assert_eq!(hot[5], 2.0);
        assert_eq!(hot[6], 15.0);

        // динамики нет
        assert_eq!(hot[4 + 12], 0.0);

        // событийные кадры: пересечён кадр seq 1
        let frames: Vec<serde_json::Value> =
            serde_json::from_str(&state.take_frames()).unwrap();

        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0]["game"]["m1"]["2"][0], 10.0);
        assert_eq!(frames[0]["camera"][0], 10.0);

        // очередь очищена
        assert_eq!(state.take_frames(), "[]");
    }

    #[test]
    fn player_block_enables_prediction_overlay() {
        let mut state = make_state();

        state.set_model("m1");
        state.set_active(true);

        state.push_frame(&frame_bytes(1000.0, 1, 10.0, 3, true, false), 1000.0);

        assert_eq!(state.my_game_id(), Some(2));

        // кадр пересечён: meta своего танка получена, предикт рендерится
        state.sample(1150.0);

        let hot = state.hot().to_vec();
        let flags = hot[0] as u32;

        assert!(flags & HOT_HAS_PREDICTED != 0);

        // predicted-запись последняя: keyId, gameId, x, ..., condition/size/team
        let p = &hot[hot.len() - 12..];

        assert_eq!(p[0], 1.0);
        assert_eq!(p[1], 2.0);
        assert_eq!(p[2], 10.0); // x из player-блока
        assert_eq!(p[9], 3.0); // condition из кадра

        // камера следует предсказанной позиции
        assert_eq!(hot[1], 10.0);
    }

    #[test]
    fn try_fire_gated_by_own_tank_state() {
        let mut state = make_state();

        state.set_model("m1");
        state.set_active(true);

        // без кадров (нет meta) выстрел невозможен
        assert!(state.try_fire(0.0).is_none());

        state.push_frame(&frame_bytes(1000.0, 1, 10.0, 3, true, false), 1000.0);
        state.sample(1150.0);

        let spawn = state.try_fire(1200.0).unwrap();

        assert!(spawn.contains("\"w1\""));

        // уничтоженный танк (condition 0) стрелять не может
        state.push_frame(&frame_bytes(1200.0, 2, 10.0, 0, true, false), 1200.0);
        state.sample(1350.0);
        assert!(state.try_fire(2000.0).is_none());
    }

    #[test]
    fn force_reset_camera_resets_predictor_pending() {
        let mut state = make_state();

        state.set_model("m1");
        state.set_active(true);

        state.push_frame(&frame_bytes(1000.0, 1, 10.0, 3, true, false), 1000.0);
        state.sample(1150.0);

        // ввод перед телепортом
        state.apply_input("down", "forward", 1160.0);

        // forceReset: история должна быть сброшена, состояние взято без replay
        state.push_frame(&frame_bytes(1200.0, 2, 500.0, 3, true, true), 1200.0);
        state.sample(1350.0);

        let hot = state.hot().to_vec();
        let p = &hot[hot.len() - 12..];

        // предсказанная позиция снаплена в 500 (без визуальной ошибки)
        assert_eq!(p[2], 500.0);
    }

    #[test]
    fn decode_frame_returns_unpack_frame_shape() {
        let state = make_state();
        let frame = frame_bytes(1234.5, 7, 10.57, 3, true, false);
        let decoded: serde_json::Value =
            serde_json::from_str(&state.decode_frame(&frame)).unwrap();

        assert_eq!(decoded["port"], 5);
        assert_eq!(decoded["seq"], 7);
        assert_eq!(decoded["serverTime"], 1234.5);
        assert_eq!(decoded["camera"][0], 10.57);
        assert_eq!(decoded["player"]["gameId"], 2);
        assert_eq!(decoded["snapshot"]["m1"]["2"][7], 3);

        // повреждённый кадр → 'null'
        assert_eq!(state.decode_frame(&frame[..5]), "null");
    }
}
