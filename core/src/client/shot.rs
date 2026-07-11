//! Клиентский визуальный спавн снарядов своего танка — порт
//! src/client/ShotPredictor.js (срез 2.6): при нажатии fire трассер (w1)
//! и бомба (w2) появляются немедленно, не дожидаясь подтверждения хостом
//! (delay + RTT). Физика/урон/взрыв (w2e) — авторитетные (ядро хоста).
//!
//! try_fire() реплицирует авторитетный гейт (кулдаун/патроны, формулы
//! muzzle/direction из Tank::muzzle_position/fire_direction) и возвращает
//! данные в формате снапшота для обычного parse-конвейера; конечная точка
//! трассера — приближённый raycast по стенам карты, динамике и танкам.
//! filter_frame_game() подавляет авторитетные дубли своих выстрелов
//! (хост помечает события id автора: tracers[7], bombs[5]).

use std::collections::VecDeque;

use indexmap::IndexMap;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::config::{ModelConfig, WeaponConfig, WeaponKind};
use crate::physics::deg_to_rad;
use crate::rng::Rng;

use super::interpolator::InterpolatedGame;
use super::predictor::RenderState;
use super::raycast::{Box2, ray_vs_box, ray_vs_grid};
use super::unpack::{BlockData, DecodedSnapshot};

// максимальный возраст неподтверждённого локального выстрела (мс);
// старше — хост выстрел отклонил, запись не должна съедать чужие дубли
const PENDING_MAX_AGE: f64 = 2000.0;

/// Данные карты для raycast (MAP_DATA клиента; лишние поля игнорируются).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClientMapConfig {
    step: f32,
    #[serde(default = "default_scale")]
    scale: f32,
    map: Vec<Vec<i32>>,
    #[serde(default)]
    physics_static: Vec<i32>,
    #[serde(default)]
    physics_dynamic: Vec<ClientDynamicObject>,
}

fn default_scale() -> f32 {
    1.0
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClientDynamicObject {
    position: [f32; 2],
    angle: f32,
    width: f32,
    height: f32,
}

struct Grid {
    map: Vec<Vec<i32>>,
    solid_tiles: Vec<i32>,
    tile_size: f32,
}

struct TankTarget {
    x: f32,
    y: f32,
    angle: f32,
    size: f32,
}

struct PendingShot {
    time: f64,
    weapon: String,
}

struct PendingBomb {
    time: f64,
    weapon: String,
    local_id: String,
}

pub struct ShotPredictor {
    weapons: IndexMap<String, WeaponConfig>,
    models: IndexMap<String, ModelConfig>,
    model: Option<ModelConfig>,
    current_weapon: Option<String>,

    // локальные кулдауны: имя оружия → localTime готовности
    cooldown_until: IndexMap<String, f64>,

    // патроны из панели: имя оружия → количество (нет ключа = неизвестно)
    ammo: IndexMap<String, f64>,

    // мир для raycast трассера
    grid: Option<Grid>,
    dynamic_sizes: IndexMap<u8, [f32; 2]>,  // index → [halfW, halfH]
    dynamic_states: IndexMap<u8, [f32; 3]>, // index → [x, y, angle]
    tanks: IndexMap<u32, TankTarget>,

    // неподтверждённые локальные выстрелы
    pending_tracers: VecDeque<PendingShot>,
    pending_bombs: VecDeque<PendingBomb>,
    expired_local_bombs: Vec<(String, String)>, // (localId, weapon)
    local_bomb_seq: u32,

    // оценка (serverTime − localNow) интерполятора: RTT-компенсация бомбы
    server_offset: Option<f64>,

    rng: Rng,
}

impl ShotPredictor {
    pub fn new(
        models: &IndexMap<String, ModelConfig>,
        weapons: &IndexMap<String, WeaponConfig>,
        seed: u64,
    ) -> Self {
        Self {
            weapons: weapons.clone(),
            models: models.clone(),
            model: None,
            current_weapon: None,
            cooldown_until: IndexMap::new(),
            ammo: IndexMap::new(),
            grid: None,
            dynamic_sizes: IndexMap::new(),
            dynamic_states: IndexMap::new(),
            tanks: IndexMap::new(),
            pending_tracers: VecDeque::new(),
            pending_bombs: VecDeque::new(),
            expired_local_bombs: Vec::new(),
            local_bomb_seq: 0,
            server_offset: None,
            rng: Rng::new(seed),
        }
    }

    /// Обновляет оценку задержки сети (вызывается из рендер-тика).
    pub fn set_server_offset(&mut self, offset: Option<f64>) {
        self.server_offset = offset;
    }

    /// Модель танка пользователя (известна при авторизации).
    pub fn set_model(&mut self, model_name: &str) {
        self.model = self.models.get(model_name).cloned();
        self.current_weapon = self.model.as_ref().map(|m| m.current_weapon.clone());
    }

    /// Данные карты (MAP_DATA): сетка стен и размеры динамических объектов;
    /// мировые координаты = тайлы × step × scale.
    pub fn set_map(&mut self, map_json: &str) -> Result<(), String> {
        let cfg: ClientMapConfig =
            serde_json::from_str(map_json).map_err(|e| e.to_string())?;

        self.grid = Some(Grid {
            map: cfg.map,
            solid_tiles: cfg.physics_static,
            tile_size: cfg.step * cfg.scale,
        });

        self.dynamic_sizes.clear();
        self.dynamic_states.clear();

        for (index, item) in cfg.physics_dynamic.iter().enumerate() {
            let index = index as u8;

            self.dynamic_sizes.insert(
                index,
                [item.width * cfg.scale / 2.0, item.height * cfg.scale / 2.0],
            );
            self.dynamic_states.insert(
                index,
                [
                    item.position[0] * cfg.scale,
                    item.position[1] * cfg.scale,
                    deg_to_rad(item.angle),
                ],
            );
        }

        self.reset();
        Ok(())
    }

    /// Обновляет позиции целей raycast из дискретного кадра.
    pub fn update_world(&mut self, snapshot: &DecodedSnapshot) {
        for block in &snapshot.blocks {
            match &block.data {
                BlockData::Tanks(items) => {
                    for (id, row) in items {
                        match row {
                            None => {
                                self.tanks.shift_remove(&(*id as u32));
                            }
                            Some(row) => {
                                self.tanks.insert(
                                    *id as u32,
                                    TankTarget {
                                        x: row.floats[0],
                                        y: row.floats[1],
                                        angle: row.floats[2],
                                        size: row.size as f32,
                                    },
                                );
                            }
                        }
                    }
                }
                BlockData::Dynamics(items) => {
                    for (index, values) in items {
                        if self.dynamic_states.contains_key(index) {
                            self.dynamic_states.insert(*index, *values);
                        }
                    }
                }
                _ => {}
            }
        }
    }

    /// Обновляет позиции целей raycast из интерполированного сэмпла.
    pub fn update_world_interpolated(&mut self, game: &InterpolatedGame) {
        for tank in &game.tanks {
            self.tanks.insert(
                tank.id as u32,
                TankTarget {
                    x: tank.floats[0],
                    y: tank.floats[1],
                    angle: tank.floats[2],
                    size: tank.size as f32,
                },
            );
        }

        for item in &game.dynamics {
            if self.dynamic_states.contains_key(&item.index) {
                self.dynamic_states.insert(item.index, item.values);
            }
        }
    }

    /// Синхронизация с панелью (порт PANEL_DATA): патроны и активное оружие.
    pub fn sync_panel(&mut self, items: &[String]) {
        for item in items {
            let mut parts = item.splitn(2, ':');
            let code = parts.next().unwrap_or("");
            let value = parts.next();

            if code == "wa" {
                if let Some(value) = value
                    && self.weapons.contains_key(value)
                {
                    self.current_weapon = Some(value.to_string());
                }
            } else if self.weapons.contains_key(code) {
                match value.and_then(|v| v.parse::<f64>().ok()) {
                    Some(v) => {
                        self.ammo.insert(code.to_string(), v);
                    }
                    None => {
                        self.ammo.shift_remove(code);
                    }
                }
            }
        }
    }

    /// Локальная реплика смены оружия (Tank::turn_weapon);
    /// авторитетное подтверждение придёт панелью ('wa').
    pub fn cycle_weapon(&mut self, back: bool) {
        let Some(current) = &self.current_weapon else {
            return;
        };

        let len = self.weapons.len() as isize;
        let mut key = self.weapons.get_index_of(current).unwrap_or(0) as isize
            + if back { -1 } else { 1 };

        if key < 0 {
            key = len - 1;
        } else if key >= len {
            key = 0;
        }

        self.current_weapon = self
            .weapons
            .get_index(key as usize)
            .map(|(name, _)| name.clone());
    }

    /// Локальный выстрел: гейт (кулдаун/патроны) + данные для рендера
    /// в формате снапшота ({ w1: [...] } или { w2: {...} }).
    pub fn try_fire(
        &mut self,
        render: &RenderState,
        my_game_id: u32,
        local_now: f64,
    ) -> Option<Value> {
        let weapon_name = self.current_weapon.clone()?;
        let weapon = self.weapons.get(&weapon_name)?.clone();

        self.model.as_ref()?;

        // кулдаун (fireRate в секундах)
        if local_now < self.cooldown_until.get(&weapon_name).copied().unwrap_or(0.0) {
            return None;
        }

        // патроны: неизвестное количество не блокирует (хост авторитетен)
        let consumption = weapon.consumption.unwrap_or(1.0);

        if let Some(ammo) = self.ammo.get(&weapon_name).copied() {
            if ammo < consumption {
                return None;
            }

            self.ammo.insert(weapon_name.clone(), ammo - consumption);
        }

        self.cooldown_until
            .insert(weapon_name.clone(), local_now + weapon.fire_rate as f64 * 1000.0);

        match weapon.kind {
            WeaponKind::Hitscan => {
                let tracer = self.build_tracer(&weapon, render, my_game_id);

                self.pending_tracers.push_back(PendingShot {
                    time: local_now,
                    weapon: weapon_name.clone(),
                });

                Some(json!({ weapon_name: [tracer] }))
            }
            WeaponKind::Explosive => {
                // следующий выстрел — только после подтверждения предыдущего
                if self.pending_bombs.iter().any(|p| p.weapon == weapon_name) {
                    return None;
                }

                self.local_bomb_seq += 1;

                // 'L' не встречается в base36-ключах хоста (строчные символы)
                let local_id = format!("L{}", self.local_bomb_seq);

                self.pending_bombs.push_back(PendingBomb {
                    time: local_now,
                    weapon: weapon_name.clone(),
                    local_id: local_id.clone(),
                });

                // RTT/2-компенсация: экстраполяция позиции на время
                // до обработки хостом
                let mut spawn_x = render.x;
                let mut spawn_y = render.y;

                if let Some(offset) = self.server_offset {
                    let lag_ms = -offset as f32;

                    spawn_x += render.vx * (lag_ms / 1000.0);
                    spawn_y += render.vy * (lag_ms / 1000.0);
                }

                Some(json!({
                    weapon_name: {
                        local_id: [spawn_x, spawn_y, 0, weapon.size, weapon.time, my_game_id],
                    },
                }))
            }
        }
    }

    /// Подавляет авторитетные дубли своих выстрелов в JSON-форме кадра
    /// (мутирует game на месте; вызывается до сериализации кадра).
    pub fn filter_frame_game(
        &mut self,
        game: &mut Map<String, Value>,
        my_game_id: Option<u32>,
        local_now: f64,
    ) {
        self.trim_pending(local_now);

        // инъекция null для бомб, чьи pending истекли без подтверждения
        for (local_id, weapon) in std::mem::take(&mut self.expired_local_bombs) {
            match game.get_mut(&weapon) {
                Some(Value::Object(bombs)) => {
                    bombs.insert(local_id, Value::Null);
                }
                _ => {
                    game.insert(weapon, json!({ local_id: null }));
                }
            }
        }

        let Some(my_id) = my_game_id else {
            return;
        };

        let weapon_names: Vec<String> = self.weapons.keys().cloned().collect();

        for weapon_name in weapon_names {
            let kind = self.weapons[&weapon_name].kind;

            match (kind, game.get_mut(&weapon_name)) {
                // трассеры: свой дубль гасит самую старую pending-запись (FIFO)
                (WeaponKind::Hitscan, Some(Value::Array(tracers))) => {
                    tracers.retain(|tracer| {
                        let is_mine = tracer
                            .get(7)
                            .and_then(Value::as_u64)
                            .is_some_and(|id| id == my_id as u64);

                        if is_mine
                            && let Some(index) = self
                                .pending_tracers
                                .iter()
                                .position(|p| p.weapon == weapon_name)
                        {
                            self.pending_tracers.remove(index);

                            return false;
                        }

                        true
                    });
                }
                // бомбы: при первом подтверждении своей — локальная L<n>
                // заменяется авторитетной сущностью; null взрыва проходит
                (WeaponKind::Explosive, Some(Value::Object(bombs))) => {
                    let confirmed: Vec<String> = bombs
                        .iter()
                        .filter(|(_, data)| {
                            data.get(5)
                                .and_then(Value::as_u64)
                                .is_some_and(|id| id == my_id as u64)
                        })
                        .map(|(id, _)| id.clone())
                        .collect();

                    for _ in confirmed {
                        let Some(index) = self
                            .pending_bombs
                            .iter()
                            .position(|p| p.weapon == weapon_name)
                        else {
                            break;
                        };

                        let pending = self.pending_bombs.remove(index).unwrap();

                        // локальная бомба уступает место авторитетной сущности
                        bombs.insert(pending.local_id, Value::Null);
                    }
                }
                _ => {}
            }
        }
    }

    /// Полный сброс (смена карты/clear/keySet).
    pub fn reset(&mut self) {
        self.pending_tracers.clear();
        self.pending_bombs.clear();
        self.expired_local_bombs.clear();
        self.cooldown_until.clear();
        self.ammo.clear();
        self.tanks.clear();
        self.current_weapon = self.model.as_ref().map(|m| m.current_weapon.clone());
    }

    // собирает данные трассера: реплика формул Tank::muzzle_position/
    // fire_direction + приближённый raycast вместо world.cast_ray
    fn build_tracer(&mut self, weapon: &WeaponConfig, render: &RenderState, shooter: u32) -> Value {
        let model = self.model.as_ref().unwrap();
        let total_angle = render.angle + render.gun_rotation;

        // дуло: смещение width·0.55 от центра (width = size·4, как Tank)
        let width = model.size * 4.0;
        let (sin, cos) = total_angle.sin_cos();
        let muzzle = [render.x + cos * width * 0.55, render.y + sin * width * 0.55];

        let mut direction = [cos, sin];

        if weapon.spread > 0.0 {
            let spread = self.rng.range(-weapon.spread, weapon.spread);
            let (s_sin, s_cos) = spread.sin_cos();

            direction = [
                s_cos * direction[0] - s_sin * direction[1],
                s_sin * direction[0] + s_cos * direction[1],
            ];
        }

        let len = direction[0].hypot(direction[1]);

        if len > 0.0 {
            direction = [direction[0] / len, direction[1] / len];
        }

        let range = weapon.range.unwrap_or(1000.0);
        let distance = self.cast_ray(muzzle, direction, range, shooter);
        let hit = distance.is_some();
        let end_distance = distance.unwrap_or(range);

        json!([
            muzzle[0],
            muzzle[1],
            muzzle[0] + direction[0] * end_distance,
            muzzle[1] + direction[1] * end_distance,
            render.x,
            render.y,
            hit,
            shooter,
        ])
    }

    // ближайшее пересечение со стенами, динамикой карты и танками (кроме
    // своего); None = промах в пределах range
    fn cast_ray(&self, origin: [f32; 2], dir: [f32; 2], range: f32, my_id: u32) -> Option<f32> {
        let mut closest: Option<f32> = None;

        let mut consider = |distance: Option<f32>| {
            if let Some(distance) = distance
                && closest.is_none_or(|c| distance < c)
            {
                closest = Some(distance);
            }
        };

        if let Some(grid) = &self.grid {
            consider(ray_vs_grid(
                origin,
                dir,
                range,
                &grid.map,
                &grid.solid_tiles,
                grid.tile_size,
            ));
        }

        for (index, state) in &self.dynamic_states {
            let size = &self.dynamic_sizes[index];

            consider(ray_vs_box(
                origin,
                dir,
                range,
                &Box2 {
                    x: state[0],
                    y: state[1],
                    angle: state[2],
                    half_w: size[0],
                    half_h: size[1],
                },
            ));
        }

        for (id, tank) in &self.tanks {
            if *id == my_id {
                continue;
            }

            // габариты танка: width = size·4, height = size·3 (как Tank)
            consider(ray_vs_box(
                origin,
                dir,
                range,
                &Box2 {
                    x: tank.x,
                    y: tank.y,
                    angle: tank.angle,
                    half_w: tank.size * 2.0,
                    half_h: tank.size * 1.5,
                },
            ));
        }

        closest
    }

    // отбрасывает протухшие неподтверждённые выстрелы
    fn trim_pending(&mut self, local_now: f64) {
        let min_time = local_now - PENDING_MAX_AGE;

        while self
            .pending_tracers
            .front()
            .is_some_and(|p| p.time < min_time)
        {
            self.pending_tracers.pop_front();
        }

        // истёкшие бомбы собираются в очередь на null-инъекцию (очистка холста)
        while self
            .pending_bombs
            .front()
            .is_some_and(|p| p.time < min_time)
        {
            let expired = self.pending_bombs.pop_front().unwrap();

            self.expired_local_bombs
                .push((expired.local_id, expired.weapon));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // модель size 2 (width 8) + hitscan w1 и explosive w2
    fn make_shot() -> ShotPredictor {
        let models: IndexMap<String, ModelConfig> = serde_json::from_value(serde_json::json!({
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
        }))
        .unwrap();
        let weapons: IndexMap<String, WeaponConfig> = serde_json::from_value(serde_json::json!({
            "w1": {
                "type": "hitscan",
                "range": 100,
                "fireRate": 0.5,
                "spread": 0,
                "consumption": 1
            },
            "w2": {
                "type": "explosive",
                "time": 300,
                "size": 8,
                "fireRate": 0.1
            }
        }))
        .unwrap();

        let mut shot = ShotPredictor::new(&models, &weapons, 42);

        shot.set_model("m1");
        shot
    }

    fn render_at(x: f32, y: f32) -> RenderState {
        RenderState {
            x,
            y,
            angle: 0.0,
            gun_rotation: 0.0,
            vx: 0.0,
            vy: 0.0,
            engine_load: 0.0,
        }
    }

    fn tracer_of(value: &Value) -> &Vec<Value> {
        value["w1"].as_array().unwrap()[0].as_array().unwrap()
    }

    #[test]
    fn fire_without_model_is_blocked() {
        let models = IndexMap::new();
        let weapons: IndexMap<String, WeaponConfig> = serde_json::from_value(
            serde_json::json!({ "w1": { "type": "hitscan", "fireRate": 0.5 } }),
        )
        .unwrap();
        let mut shot = ShotPredictor::new(&models, &weapons, 42);

        assert!(shot.try_fire(&render_at(0.0, 0.0), 1, 0.0).is_none());
    }

    #[test]
    fn cooldown_blocks_next_shot() {
        let mut shot = make_shot();

        assert!(shot.try_fire(&render_at(0.0, 0.0), 1, 0.0).is_some());
        // fireRate 0.5 c → до 500 мс выстрел заблокирован
        assert!(shot.try_fire(&render_at(0.0, 0.0), 1, 400.0).is_none());
        assert!(shot.try_fire(&render_at(0.0, 0.0), 1, 500.0).is_some());
    }

    #[test]
    fn ammo_gates_and_decrements() {
        let mut shot = make_shot();

        // неизвестный боезапас не блокирует (хост авторитетен)
        assert!(shot.try_fire(&render_at(0.0, 0.0), 1, 0.0).is_some());

        shot.sync_panel(&["w1:1".to_string()]);
        assert!(shot.try_fire(&render_at(0.0, 0.0), 1, 1000.0).is_some());
        // патроны списаны локально: 1 − 1 = 0
        assert!(shot.try_fire(&render_at(0.0, 0.0), 1, 2000.0).is_none());
    }

    #[test]
    fn tracer_muzzle_formula_and_miss() {
        let mut shot = make_shot();
        let spawn = shot.try_fire(&render_at(10.0, 20.0), 2, 0.0).unwrap();
        let tracer = tracer_of(&spawn);

        // дуло: x + width·0.55 (width = size·4 = 8) при angle 0
        assert!((tracer[0].as_f64().unwrap() - 14.4).abs() < 1e-3);
        assert!((tracer[1].as_f64().unwrap() - 20.0).abs() < 1e-3);
        // промах: конец на дистанции range
        assert!((tracer[2].as_f64().unwrap() - 114.4).abs() < 1e-3);
        assert_eq!(tracer[6], Value::Bool(false));
        assert_eq!(tracer[7].as_u64(), Some(2));
        // центр танка для визуализации
        assert_eq!(tracer[4].as_f64(), Some(10.0));
        assert_eq!(tracer[5].as_f64(), Some(20.0));
    }

    #[test]
    fn tracer_clips_on_wall() {
        let mut shot = make_shot();
        let mut grid = vec![vec![0; 10]; 3];

        for row in &mut grid {
            row[5] = 1; // стена на x = 50–60
        }

        shot.set_map(
            &serde_json::json!({
                "step": 10,
                "scale": 1,
                "map": grid,
                "physicsStatic": [1],
                "physicsDynamic": []
            })
            .to_string(),
        )
        .unwrap();

        let spawn = shot.try_fire(&render_at(0.0, 15.0), 1, 0.0).unwrap();
        let tracer = tracer_of(&spawn);

        assert_eq!(tracer[6], Value::Bool(true));
        assert!((tracer[2].as_f64().unwrap() - 50.0).abs() < 1e-3);
    }

    #[test]
    fn tracer_hits_tank_but_not_own() {
        use super::super::unpack::{BlockData, DecodedBlock, DecodedSnapshot};
        use crate::snapshot::TankRow;

        let mut shot = make_shot();
        let mut items = IndexMap::new();

        // свой танк (id 1) на пути луча — игнорируется; чужой (id 2) — цель
        items.insert(
            1u8,
            Some(TankRow {
                floats: [30.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
                condition: 3,
                size: 2,
                team: 1,
            }),
        );
        items.insert(
            2u8,
            Some(TankRow {
                floats: [60.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
                condition: 3,
                size: 2,
                team: 2,
            }),
        );

        shot.update_world(&DecodedSnapshot {
            blocks: vec![DecodedBlock {
                key: "m1".to_string(),
                key_id: 1,
                data: BlockData::Tanks(items),
            }],
        });

        let spawn = shot.try_fire(&render_at(0.0, 0.0), 1, 0.0).unwrap();
        let tracer = tracer_of(&spawn);

        // чужой танк: центр 60, halfW = size·2 = 4 → грань на 56
        assert_eq!(tracer[6], Value::Bool(true));
        assert!((tracer[2].as_f64().unwrap() - 56.0).abs() < 1e-3);
    }

    #[test]
    fn bomb_spawn_gate_and_rtt_compensation() {
        let mut shot = make_shot();

        shot.cycle_weapon(false); // w1 → w2

        let mut render = render_at(10.0, 0.0);

        render.vx = 100.0;

        // RTT-компенсация: offset −50 мс → x + vx·0.05
        shot.set_server_offset(Some(-50.0));

        let spawn = shot.try_fire(&render, 3, 0.0).unwrap();
        let bomb = &spawn["w2"]["L1"];

        assert!((bomb[0].as_f64().unwrap() - 15.0).abs() < 1e-3);
        assert_eq!(bomb[3].as_f64(), Some(8.0)); // size
        assert_eq!(bomb[5].as_u64(), Some(3)); // ownerId

        // вторая бомба до подтверждения первой — заблокирована
        assert!(shot.try_fire(&render, 3, 1000.0).is_none());
    }

    #[test]
    fn filter_suppresses_own_tracer_fifo() {
        let mut shot = make_shot();

        shot.try_fire(&render_at(0.0, 0.0), 2, 0.0); // pending w1

        let mut game = serde_json::json!({
            "w1": [
                [0, 0, 1, 1, 0, 0, false, 2], // свой дубль
                [9, 9, 5, 5, 9, 9, true, 3]   // чужой
            ]
        });
        let map = game.as_object_mut().unwrap();

        shot.filter_frame_game(map, Some(2), 100.0);

        let tracers = map["w1"].as_array().unwrap();

        assert_eq!(tracers.len(), 1);
        assert_eq!(tracers[0][7].as_u64(), Some(3));

        // pending исчерпан: следующий свой трассер проходит (не подавляется)
        let mut game = serde_json::json!({ "w1": [[0, 0, 1, 1, 0, 0, false, 2]] });

        shot.filter_frame_game(game.as_object_mut().unwrap(), Some(2), 200.0);
        assert_eq!(game["w1"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn filter_remaps_own_bomb_to_local_null() {
        let mut shot = make_shot();

        shot.cycle_weapon(false);
        shot.try_fire(&render_at(0.0, 0.0), 2, 0.0); // pending L1

        let mut game = serde_json::json!({
            "w2": { "a1": [5.0, 5.0, 0, 8, 300, 2] }
        });
        let map = game.as_object_mut().unwrap();

        shot.filter_frame_game(map, Some(2), 100.0);

        // авторитетная сущность остаётся, локальная гасится null'ом
        assert!(map["w2"]["a1"].is_array());
        assert!(map["w2"]["L1"].is_null());

        // гейт снят: следующая бомба разрешена
        assert!(shot.try_fire(&render_at(0.0, 0.0), 2, 1000.0).is_some());
    }

    #[test]
    fn filter_passes_nulls_and_foreign_bombs() {
        let mut shot = make_shot();

        shot.cycle_weapon(false);
        shot.try_fire(&render_at(0.0, 0.0), 2, 0.0);

        let mut game = serde_json::json!({
            "w2": { "b2": null, "c3": [1.0, 1.0, 0, 8, 300, 5] }
        });
        let map = game.as_object_mut().unwrap();

        shot.filter_frame_game(map, Some(2), 100.0);

        // null взрыва и чужая бомба проходят, pending не тронут
        assert!(map["w2"]["b2"].is_null());
        assert!(map["w2"]["c3"].is_array());
        assert!(shot.try_fire(&render_at(0.0, 0.0), 2, 1000.0).is_none());
    }

    #[test]
    fn expired_local_bomb_injects_null() {
        let mut shot = make_shot();

        shot.cycle_weapon(false);
        shot.try_fire(&render_at(0.0, 0.0), 2, 0.0); // pending L1

        // спустя PENDING_MAX_AGE подтверждения нет — null очищает холст
        let mut game = serde_json::json!({});

        shot.filter_frame_game(game.as_object_mut().unwrap(), Some(2), 3000.0);
        assert!(game["w2"]["L1"].is_null());
    }

    #[test]
    fn cycle_weapon_wraps_and_panel_syncs() {
        let mut shot = make_shot();

        assert_eq!(shot.current_weapon.as_deref(), Some("w1"));

        shot.cycle_weapon(false);
        assert_eq!(shot.current_weapon.as_deref(), Some("w2"));

        shot.cycle_weapon(false); // wrap вперёд
        assert_eq!(shot.current_weapon.as_deref(), Some("w1"));

        shot.cycle_weapon(true); // wrap назад
        assert_eq!(shot.current_weapon.as_deref(), Some("w2"));

        // авторитетное оружие панели
        shot.sync_panel(&["wa:w1".to_string()]);
        assert_eq!(shot.current_weapon.as_deref(), Some("w1"));

        // неизвестное оружие игнорируется
        shot.sync_panel(&["wa:zzz".to_string()]);
        assert_eq!(shot.current_weapon.as_deref(), Some("w1"));
    }

    #[test]
    fn reset_restores_default_weapon_and_clears_state() {
        let mut shot = make_shot();

        shot.cycle_weapon(false);
        shot.sync_panel(&["w1:5".to_string()]);
        shot.try_fire(&render_at(0.0, 0.0), 1, 0.0);
        shot.reset();

        assert_eq!(shot.current_weapon.as_deref(), Some("w1"));
        assert!(shot.ammo.is_empty());
        assert!(shot.pending_bombs.is_empty());
        // кулдаун сброшен
        assert!(shot.try_fire(&render_at(0.0, 0.0), 1, 1.0).is_some());
    }
}
