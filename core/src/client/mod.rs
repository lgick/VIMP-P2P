//! Клиентский режим ядра (срез 2.6): интерполяция снапшотов, предикт
//! своего танка и визуальный спавн снарядов — в одном месте с авторитетной
//! симуляцией. Наружу (ClientCore в lib.rs) отдаётся гибрид: горячие
//! позиции — плоским Float32-буфером (zero-copy), редкие событийные кадры —
//! JSON-строкой в форме, готовой для parse-конвейера клиента.

pub mod interpolator;
pub mod predictor;
pub mod raycast;
pub mod shot;
pub mod unpack;

use serde_json::{Value, json};

use crate::config::ClientConfig;

use interpolator::{FrameData, InterpolatedGame, Interpolator};
use predictor::{Predictor, RenderState};
use shot::ShotPredictor;
use unpack::{BlockData, UnpackError};

// флаги hot-буфера ([0]); зеркалятся в src/config/opcodes.js (HOT_FLAGS)
pub const HOT_HAS_GAME: u32 = 1;
pub const HOT_HAS_CAMERA: u32 = 2;
pub const HOT_HAS_PREDICTED: u32 = 4;
pub const HOT_HAS_FRAMES: u32 = 8;

pub struct ClientState {
    cfg: ClientConfig,
    interpolator: Interpolator,
    predictor: Predictor,
    shot: ShotPredictor,

    // свой танк: id из player-блока, ключ модели из авторизации,
    // дискретные поля из последнего кадра
    my_game_id: Option<u32>,
    my_model_key: Option<String>,
    my_model_key_id: Option<u8>,
    my_tank_meta: Option<(u8, u8, u8)>, // condition, size, teamId

    // очередь событийных кадров на take_frames (в форме applyShot)
    frames_out: Vec<Value>,

    // переиспользуемый плоский буфер рендер-тика
    hot: Vec<f32>,
}

impl ClientState {
    pub fn new(cfg: ClientConfig) -> Self {
        let interpolator = Interpolator::new(&cfg.interpolation, cfg.snapshot.clone());
        let predictor = Predictor::new(cfg.time_step_ms, &cfg.player_keys, &cfg.models);
        let shot = ShotPredictor::new(&cfg.models, &cfg.weapons, cfg.seed);

        Self {
            cfg,
            interpolator,
            predictor,
            shot,
            my_game_id: None,
            my_model_key: None,
            my_model_key_id: None,
            my_tank_meta: None,
            frames_out: Vec::new(),
            hot: Vec::new(),
        }
    }

    /// Бинарный кадр из транспорта: распаковка, вставка в буфер по seq,
    /// reconciliation предикта по player-блоку. false — кадр отброшен
    /// (чужой порт, версия или повреждённые данные).
    pub fn push_frame(&mut self, data: &[u8], local_now: f64) -> bool {
        let frame = match unpack::unpack_frame(data, &self.cfg.snapshot) {
            Ok(frame) => frame,
            Err(UnpackError::WrongVersion | UnpackError::Truncated) => return false,
        };

        if frame.port != self.cfg.snapshot.port {
            return false;
        }

        self.interpolator.push(
            FrameData {
                snapshot: frame.snapshot,
                camera: frame.camera,
            },
            frame.server_time,
            local_now,
            frame.seq,
        );

        if let Some(player) = frame.player {
            self.my_game_id = Some(player.game_id as u32);

            // после push оффсет всегда известен
            let offset = self.interpolator.offset().unwrap_or(0.0);

            self.predictor.on_server_state(
                player.state,
                player.centering,
                frame.server_time,
                offset,
                local_now,
            );
        }

        true
    }

    pub fn my_game_id(&self) -> Option<u32> {
        self.my_game_id
    }

    pub fn offset(&self) -> Option<f64> {
        self.interpolator.offset()
    }

    /// Рендер-тик: выдача пересечённых кадров (фильтр дублей → JSON-очередь),
    /// интерполяция, шаг предикта, запись hot-буфера. Возвращает длину
    /// hot-буфера в f32-элементах.
    pub fn sample(&mut self, local_now: f64) -> usize {
        // оценка задержки для RTT-компенсации бомб
        self.shot.set_server_offset(self.interpolator.offset());

        let result = self.interpolator.sample(local_now);

        // событийные кадры: свой танк → фильтр дублей → очередь → мир raycast
        for frame in result.frames {
            self.track_own_tank(&frame);

            let mut game = unpack::snapshot_to_json(&frame.snapshot);

            self.shot
                .filter_frame_game(&mut game, self.my_game_id, local_now);

            self.frames_out.push(json!({
                "game": game,
                "camera": unpack::camera_to_json(frame.camera.as_ref()),
            }));

            self.shot.update_world(&frame.snapshot);
        }

        if let Some(game) = &result.game {
            self.shot.update_world_interpolated(game);
        }

        self.predictor.update(local_now);

        // предикт поверх интерполяции: без meta своего танка не рендерится
        let predicted = if self.my_game_id.is_some()
            && self.my_tank_meta.is_some()
            && self.my_model_key_id.is_some()
        {
            self.predictor.render_state()
        } else {
            None
        };

        self.write_hot(result.game.as_ref(), result.camera, predicted.as_ref());
        self.hot.len()
    }

    pub fn hot(&self) -> &[f32] {
        &self.hot
    }

    /// Событийные кадры JSON-строкой [{game, camera}, ...]; очередь очищается.
    pub fn take_frames(&mut self) -> String {
        let frames = std::mem::take(&mut self.frames_out);

        serde_json::to_string(&frames).unwrap_or_else(|_| "[]".to_string())
    }

    /// Ввод игрока — в историю предикта.
    pub fn apply_input(&mut self, action: &str, key_name: &str, local_now: f64) {
        self.predictor.apply_input(action, key_name, local_now);
    }

    /// Локальный выстрел (гейт main.js: предикт активен, свой танк жив).
    /// JSON спавна для applyGameData либо None.
    pub fn try_fire(&mut self, local_now: f64) -> Option<String> {
        if !self.alive_with_state() {
            return None;
        }

        let render = self.predictor.render_state()?;
        let spawn = self.shot.try_fire(&render, self.my_game_id?, local_now)?;

        Some(spawn.to_string())
    }

    /// Локальный цикл смены оружия (тот же гейт, что try_fire).
    pub fn cycle_weapon(&mut self, back: bool) {
        if self.alive_with_state() {
            self.shot.cycle_weapon(back);
        }
    }

    /// Модель танка пользователя (авторизация).
    pub fn set_model(&mut self, model_name: &str) {
        self.predictor.set_model(model_name);
        self.shot.set_model(model_name);

        self.my_model_key = self
            .cfg
            .models
            .contains_key(model_name)
            .then(|| model_name.to_string());
        self.my_model_key_id = self.cfg.snapshot.keys.get(model_name).map(|info| info.id);
    }

    /// Смена режима игрок/спектатор (KEYSET_DATA).
    pub fn set_active(&mut self, active: bool) {
        self.predictor.set_active(active);
        self.shot.reset();
    }

    /// Данные карты (MAP_DATA): мир raycast + сброс буфера и предикта.
    pub fn set_map(&mut self, map_json: &str) -> Result<(), String> {
        self.interpolator.reset();
        self.predictor.reset();
        self.frames_out.clear();
        self.shot.set_map(map_json)
    }

    /// Авторитетное состояние панели (PANEL_DATA): патроны, активное оружие.
    pub fn sync_panel(&mut self, panel_json: &str) {
        let Ok(Value::Array(items)) = serde_json::from_str(panel_json) else {
            return;
        };

        let items: Vec<String> = items
            .iter()
            .map(|item| match item {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            })
            .collect();

        self.shot.sync_panel(&items);
    }

    /// Полный сброс (порт CLEAR).
    pub fn reset(&mut self) {
        self.interpolator.reset();
        self.predictor.reset();
        self.shot.reset();
        self.frames_out.clear();
    }

    /// Чистая распаковка кадра v3 в JSON-форму unpackFrame (тесты/харнесс).
    pub fn decode_frame(&self, data: &[u8]) -> String {
        match unpack::unpack_frame(data, &self.cfg.snapshot) {
            Ok(frame) => unpack::frame_to_json(&frame).to_string(),
            Err(_) => "null".to_string(),
        }
    }

    // гейт визуального спавна: предикт активен и свой танк жив
    fn alive_with_state(&self) -> bool {
        self.predictor.has_state() && self.my_tank_meta.is_some_and(|meta| meta.0 != 0)
    }

    // отслеживание своего танка в выданном кадре: reset предикта по
    // forceReset камеры, дискретные поля, freeze при уничтожении
    fn track_own_tank(&mut self, frame: &FrameData) {
        if frame.camera.as_ref().is_some_and(|c| c.force_reset) {
            self.predictor.reset();
        }

        let (Some(my_id), Some(model_key)) = (self.my_game_id, &self.my_model_key) else {
            return;
        };

        if let Some(BlockData::Tanks(items)) = frame.snapshot.block_by_key(model_key)
            && let Some(entry) = items.get(&(my_id as u8))
        {
            match entry {
                // null-маркер: танк удалён с полотна
                None => self.my_tank_meta = None,
                Some(row) => {
                    self.my_tank_meta = Some((row.condition, row.size, row.team));
                    self.predictor.freeze(row.condition == 0);
                }
            }
        }
    }

    // плоский Float32-буфер рендер-тика:
    // [0] flags, [1..2] камера x/y, [3] N танков, N×12
    // (keyId, gameId, x, y, angle, gun, vx, vy, engineLoad,
    //  condition, size, teamId), затем M динамики, M×5
    // (keyId, index, x, y, angle), последней — predicted-запись (12,
    // перезаписывает свой танк — предикт поверх интерполяции)
    fn write_hot(
        &mut self,
        game: Option<&InterpolatedGame>,
        camera: Option<[f32; 2]>,
        predicted: Option<&RenderState>,
    ) {
        self.hot.clear();

        let mut flags = 0u32;

        if game.is_some() {
            flags |= HOT_HAS_GAME;
        }

        if !self.frames_out.is_empty() {
            flags |= HOT_HAS_FRAMES;
        }

        if predicted.is_some() {
            flags |= HOT_HAS_PREDICTED;
        }

        // камера: предсказанная позиция либо интерполированная
        let camera = predicted.map(|p| [p.x, p.y]).or(camera);

        if camera.is_some() {
            flags |= HOT_HAS_CAMERA;
        }

        self.hot.push(flags as f32);

        let camera = camera.unwrap_or([0.0, 0.0]);

        self.hot.push(camera[0]);
        self.hot.push(camera[1]);

        let empty = InterpolatedGame::default();
        let game = game.unwrap_or(&empty);

        self.hot.push(game.tanks.len() as f32);

        for tank in &game.tanks {
            self.hot.push(tank.key_id as f32);
            self.hot.push(tank.id as f32);
            self.hot.extend_from_slice(&tank.floats);
            self.hot.push(tank.condition as f32);
            self.hot.push(tank.size as f32);
            self.hot.push(tank.team as f32);
        }

        self.hot.push(game.dynamics.len() as f32);

        for item in &game.dynamics {
            self.hot.push(item.key_id as f32);
            self.hot.push(item.index as f32);
            self.hot.extend_from_slice(&item.values);
        }

        if let Some(p) = predicted {
            let (condition, size, team) = self.my_tank_meta.unwrap();

            self.hot.push(self.my_model_key_id.unwrap() as f32);
            self.hot.push(self.my_game_id.unwrap() as f32);
            self.hot.extend_from_slice(&[
                p.x,
                p.y,
                p.angle,
                p.gun_rotation,
                p.vx,
                p.vy,
                p.engine_load,
            ]);
            self.hot.push(condition as f32);
            self.hot.push(size as f32);
            self.hot.push(team as f32);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::snapshot::{Block, CameraData, PlayerBlock, SnapshotPacker, TankRow};

    fn client_config() -> ClientConfig {
        serde_json::from_value(serde_json::json!({
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
                    "m1": { "id": 1, "kind": "tanks", "class": "hot", "fields": [
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
                    "w1": { "id": 2, "kind": "tracers", "class": "event", "fields": [
                        { "name": "startX", "ty": "f32" },
                        { "name": "startY", "ty": "f32" },
                        { "name": "endX", "ty": "f32" },
                        { "name": "endY", "ty": "f32" },
                        { "name": "bodyX", "ty": "f32" },
                        { "name": "bodyY", "ty": "f32" },
                        { "name": "wasHit", "ty": "u8" },
                        { "name": "shooterId", "ty": "u8" }
                    ] },
                    "w2": { "id": 3, "kind": "bombs", "class": "event", "fields": [
                        { "name": "x", "ty": "f32" },
                        { "name": "y", "ty": "f32" },
                        { "name": "angle", "ty": "f32" },
                        { "name": "size", "ty": "u8" },
                        { "name": "time", "ty": "u16" },
                        { "name": "ownerId", "ty": "u8" }
                    ] },
                    "w2e": { "id": 4, "kind": "explosions", "class": "event", "fields": [
                        { "name": "x", "ty": "f32" },
                        { "name": "y", "ty": "f32" },
                        { "name": "radius", "ty": "f32" }
                    ] },
                    "c1": { "id": 5, "kind": "dynamics", "class": "hot", "fields": [
                        { "name": "x", "ty": "f32", "interp": "lerp" },
                        { "name": "y", "ty": "f32", "interp": "lerp" },
                        { "name": "angle", "ty": "f32", "interp": "lerpAngle" }
                    ] }
                }
            },
            "interpolation": { "delay": 100, "maxFrameAge": 1000 },
            "seed": 42
        }))
        .unwrap()
    }

    fn make_state() -> ClientState {
        ClientState::new(client_config())
    }

    fn tank_row(x: f32, condition: u8) -> TankRow {
        TankRow {
            floats: [x, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            condition,
            size: 2,
            team: 1,
        }
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
        let cfg = client_config();
        let mut packer = SnapshotPacker::new(cfg.snapshot.clone());

        packer
            .pack_body(&[(
                "m1".to_string(),
                Block::Tanks(vec![(2, Some(tank_row(x, condition)))]),
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
