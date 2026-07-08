use std::sync::mpsc::channel;

use indexmap::IndexMap;
use rapier2d::prelude::*;
use serde::{Deserialize, Serialize};

use crate::bomb::{Bomb, BombRow};
use crate::bots::controller::BotBrain;
use crate::bots::navigation::NavigationSystem;
use crate::bots::spatial::{SpatialEntity, SpatialGrid};
use crate::config::{CoreConfig, WeaponKind};
use crate::events::CoreEvent;
use crate::map::{GameMap, MapConfig};
use crate::physics::{BodyTag, round1, round2};
use crate::rng::Rng;
use crate::snapshot::{Block, TankRow, TracerRow};
use crate::tank::{PlayerKeyBits, ShotCommand, Tank};

// размер ячейки пространственной сетки ботов (BotManager SPATIAL_CELL_SIZE)
const SPATIAL_CELL_SIZE: f32 = 600.0;

// защита от «спирали смерти» (Game._maxAccumulatedTime)
const MAX_ACCUMULATED_TIME: f32 = 0.1;

/// Состояние симуляции: порт src/server/modules/Game.js.
/// Управляется командами (spawn/remove/input/step), отчитывается
/// событиями (take_events) и бинарными кадрами (pack_body/pack_frame).
pub struct GameState {
    pub cfg: CoreConfig,
    pub key_bits: PlayerKeyBits,
    pub world: PhysicsWorld,
    pub map: Option<GameMap>,
    pub tanks: IndexMap<u32, Tank>,
    pub bots: IndexMap<u32, BotBrain>,
    pub nav: Option<NavigationSystem>,
    pub spatial: SpatialGrid,
    pub rng: Rng,

    time_step: f32,
    accumulator: f32,

    // снаряды и кольцевой буфер их времени жизни
    shots: IndexMap<u32, Bomb>,
    shots_at_time: Vec<Vec<u32>>,
    current_shot_id: u32,
    current_step_tick: usize,
    max_shot_time_in_steps: usize,

    // накопители снапшота между отправками (аналог Game._newShotsData
    // + _lastExpiredShotsData + _lastWeaponEffects, слитые с буфером
    // SnapshotManager: дренируются в pack_body)
    new_tracers: IndexMap<usize, Vec<TracerRow>>,
    new_bombs: IndexMap<usize, IndexMap<u32, Option<BombRow>>>,
    weapon_effects: IndexMap<String, Vec<[f32; 3]>>,
    // null-маркеры удалённых с полотна танков (removedPlayersList)
    pending_null_tanks: Vec<(String, u32)>,

    // события для меты, дренируются в take_events
    pub events: Vec<CoreEvent>,

    // содержал ли последний собранный body событийные блоки (трассеры/бомбы/
    // взрывы/удаления танков) — для классификации канала WebRTC meta/state
    last_body_has_events: bool,

    // кеш строк снапшота игроков (Game._cachedPlayersData)
    cached_players: IndexMap<u32, (String, TankRow)>,

    // очередь тел на удаление после обработки контактов
    bodies_to_destroy: Vec<RigidBodyHandle>,
}

impl GameState {
    pub fn new(cfg: CoreConfig) -> Self {
        let key_bits = PlayerKeyBits::from_config(&cfg.player_keys);
        let time_step = cfg.time_step;

        let mut world = PhysicsWorld::new();

        world.gravity = Vector::ZERO;
        world.integration_parameters.dt = time_step;

        // кольцевой буфер времени жизни снарядов — по максимальному
        // времени жизни не-hitscan оружия с буфером x1.5
        let max_lifetime_ms = cfg
            .weapons
            .values()
            .filter(|w| w.kind != WeaponKind::Hitscan)
            .map(|w| w.time)
            .fold(0.0f32, f32::max);

        let max_lifetime_with_buffer = (max_lifetime_ms / 1000.0) * 1.5;
        let max_shot_time_in_steps =
            ((max_lifetime_with_buffer / time_step).ceil() as usize).max(1);

        let seed = cfg.seed;

        Self {
            key_bits,
            world,
            map: None,
            tanks: IndexMap::new(),
            bots: IndexMap::new(),
            nav: None,
            spatial: SpatialGrid::new(SPATIAL_CELL_SIZE),
            rng: Rng::new(seed),
            time_step,
            accumulator: 0.0,
            shots: IndexMap::new(),
            shots_at_time: vec![Vec::new(); max_shot_time_in_steps],
            current_shot_id: 0,
            current_step_tick: 0,
            max_shot_time_in_steps,
            new_tracers: IndexMap::new(),
            new_bombs: IndexMap::new(),
            weapon_effects: IndexMap::new(),
            pending_null_tanks: Vec::new(),
            events: Vec::new(),
            last_body_has_events: false,
            cached_players: IndexMap::new(),
            bodies_to_destroy: Vec::new(),
            cfg,
        }
    }

    // ***** карта ***** //

    /// Создаёт карту из JSON (масштабирование внутри) и нав-граф ботов.
    pub fn load_map(&mut self, json: &str) -> Result<(), String> {
        let map_cfg: MapConfig =
            serde_json::from_str(json).map_err(|e| format!("bad map json: {e}"))?;

        if let Some(mut old) = self.map.take() {
            old.destroy(&mut self.world);
        }

        let map = GameMap::create(
            &mut self.world,
            &map_cfg,
            self.cfg.map_scale,
            &self.cfg.map_set_id,
        );

        self.nav = Some(NavigationSystem::generate(
            &map.grid,
            &map.physics_static,
            map.step,
        ));

        self.map = Some(map);

        Ok(())
    }

    // ***** участники ***** //

    /// Создаёт танк (Game.createPlayer).
    pub fn spawn_tank(
        &mut self,
        game_id: u32,
        model_name: &str,
        team_id: u8,
        x: f32,
        y: f32,
        angle_deg: f32,
    ) -> Result<(), String> {
        let model = self
            .cfg
            .models
            .get(model_name)
            .ok_or_else(|| format!("unknown model '{model_name}'"))?
            .clone();

        let tank = Tank::new(
            &mut self.world,
            &self.cfg,
            model_name,
            &model,
            game_id,
            team_id,
            x,
            y,
            angle_deg,
        );

        // мета узнаёт стартовые значения панели (как setActiveWeapon +
        // takeDamage(0) в конструкторе JS-версии)
        self.events.push(CoreEvent::ActiveWeapon {
            id: game_id,
            weapon: self
                .cfg
                .weapons
                .get_index(tank.current_weapon)
                .map(|(name, _)| name.clone())
                .unwrap_or_default(),
        });
        self.events.push(CoreEvent::Health {
            id: game_id,
            value: tank.health,
        });

        self.tanks.insert(game_id, tank);

        Ok(())
    }

    /// Удаляет танк (Game.removePlayer) и ставит null-маркер для клиентов.
    pub fn remove_tank(&mut self, game_id: u32) {
        if let Some(tank) = self.tanks.shift_remove(&game_id) {
            self.world.remove_body(tank.body);
            self.cached_players.shift_remove(&game_id);
            self.pending_null_tanks.push((tank.model, game_id));
        }
    }

    /// Перемещает танк при смене команды/респауне (Game.changePlayerData).
    pub fn reset_tank(&mut self, game_id: u32, team_id: u8, x: f32, y: f32, angle_deg: f32) {
        if let Some(tank) = self.tanks.get_mut(&game_id) {
            if let Some(body) = self.world.bodies.get_mut(tank.body) {
                tank.change_player_data(team_id, x, y, angle_deg, body);
            }
        }
    }

    /// Сбрасывает здоровье/боезапас всех танков (аналог Panel.reset).
    pub fn reset_all_vitals(&mut self) {
        let cfg = self.cfg.clone();

        for tank in self.tanks.values_mut() {
            tank.reset_vitals(&cfg, &mut self.events);
        }
    }

    /// Добавляет бота: танк + ИИ-контроллер внутри ядра.
    pub fn add_bot(
        &mut self,
        game_id: u32,
        model_name: &str,
        team_id: u8,
        x: f32,
        y: f32,
        angle_deg: f32,
    ) -> Result<(), String> {
        self.spawn_tank(game_id, model_name, team_id, x, y, angle_deg)?;

        if !self.bots.contains_key(&game_id) {
            let brain = BotBrain::new(game_id, &mut self.rng);

            self.bots.insert(game_id, brain);
        }

        Ok(())
    }

    pub fn remove_bot(&mut self, game_id: u32) {
        self.bots.shift_remove(&game_id);
        self.remove_tank(game_id);
    }

    // ***** ввод ***** //

    /// Применяет ввод игрока (формат wire 'seq:action:name' разбирает JS).
    pub fn apply_input(&mut self, game_id: u32, seq: u32, action: &str, key_name: &str) {
        let bit = self.cfg.player_keys.get(key_name).map(|k| k.key).unwrap_or(0);

        if let Some(tank) = self.tanks.get_mut(&game_id) {
            tank.last_input_seq = seq;
            tank.update_keys(action, bit, &self.key_bits);
        }
    }

    /// Обновление клавиш по биту (внутренний путь ботов).
    pub(crate) fn update_tank_keys(&mut self, game_id: u32, action: &str, bit: u32) {
        if let Some(tank) = self.tanks.get_mut(&game_id) {
            tank.update_keys(action, bit, &self.key_bits);
        }
    }

    pub fn last_input_seq(&self, game_id: u32) -> u32 {
        self.tanks
            .get(&game_id)
            .map(|tank| tank.last_input_seq)
            .unwrap_or(0)
    }

    // ***** запросы состояния ***** //

    pub fn tank_alive(&self, game_id: u32) -> bool {
        self.tanks.get(&game_id).is_some_and(|tank| tank.is_alive())
    }

    /// Координаты танка, скруглённые до 2 знаков (Game.getPosition).
    pub fn tank_position_rounded(&self, game_id: u32) -> Option<[f32; 2]> {
        let tank = self.tanks.get(&game_id)?;
        let body = self.world.bodies.get(tank.body)?;
        let pos = body.translation();

        Some([round2(pos.x), round2(pos.y)])
    }

    /// Состояние танка для client-side prediction (без округлений).
    pub fn prediction_state(&self, game_id: u32) -> Option<([f32; 8], bool)> {
        let tank = self.tanks.get(&game_id)?;
        let body = self.world.bodies.get(tank.body)?;

        Some(tank.prediction_state(body))
    }

    pub(crate) fn weapon_index(&self, name: &str) -> Option<usize> {
        self.cfg.weapons.get_index_of(name)
    }

    // ***** игровой тик ***** //

    /// Обновляет физику фиксированными шагами (Game.updateData),
    /// затем ботов и пространственную сетку (VIMP._onShotTick).
    pub fn step(&mut self, dt: f32) {
        self.accumulator = (self.accumulator + dt).min(MAX_ACCUMULATED_TIME);

        while self.accumulator >= self.time_step {
            self.step_fixed();
            self.accumulator -= self.time_step;
        }

        // обновление кеша строк снапшота
        self.refresh_cached_players();

        // ИИ ботов после физики; сетка пересобирается после решений
        // (боты видят состояние прошлого тика, как в JS)
        if !self.bots.is_empty() {
            let ids: Vec<u32> = self.bots.keys().copied().collect();

            for id in ids {
                if let Some(mut brain) = self.bots.shift_remove(&id) {
                    brain.update(self, dt);
                    self.bots.insert(id, brain);
                }
            }

            self.build_spatial_grid();
        }
    }

    /// Один фиксированный шаг физики.
    fn step_fixed(&mut self) {
        let time_step = self.time_step;
        let ids: Vec<u32> = self.tanks.keys().copied().collect();

        for id in ids {
            let shot;

            {
                let Some(tank) = self.tanks.get_mut(&id) else {
                    continue;
                };
                let Some(body) = self.world.bodies.get_mut(tank.body) else {
                    continue;
                };
                let Some(model) = self.cfg.models.get(&tank.model) else {
                    continue;
                };

                shot = tank.update(
                    time_step,
                    body,
                    model,
                    &self.cfg.weapons,
                    &self.key_bits,
                    &mut self.rng,
                    &mut self.events,
                );
            }

            if let Some(shot) = shot {
                // оружие читается после update (быстрая смена в том же
                // тике обрабатывается как в JS-версии)
                let weapon_index = self.tanks[&id].current_weapon;
                let kind = self.cfg.weapons[weapon_index].kind;

                match kind {
                    WeaponKind::Hitscan => {
                        let tracer = self.process_hitscan(id, weapon_index, &shot);

                        self.new_tracers.entry(weapon_index).or_default().push(tracer);
                    }
                    WeaponKind::Explosive => {
                        let (shot_id, row) = self.create_weapon_action(id, weapon_index, &shot);

                        self.new_bombs
                            .entry(weapon_index)
                            .or_default()
                            .insert(shot_id, Some(row));
                    }
                }
            }
        }

        // исчезновение снарядов по времени — до шага мира (как в JS)
        self.process_shots_expired_by_time();

        // шаг физического мира со сбором начавшихся контактов
        let (collision_send, collision_recv) = channel();
        let (force_send, _force_recv) = channel();
        let collector = ChannelEventCollector::new(collision_send, force_send);

        self.world.step_with_events(&(), &collector);

        let mut contacts = Vec::new();

        while let Ok(event) = collision_recv.try_recv() {
            if let CollisionEvent::Started(h1, h2, _) = event {
                contacts.push((h1, h2));
            }
        }

        self.process_contact_events(contacts);
        self.destroy_queued_bodies();
    }

    /// Контакты игрок×снаряд (для не-explosive снарядов).
    fn process_contact_events(&mut self, contacts: Vec<(ColliderHandle, ColliderHandle)>) {
        for (h1, h2) in contacts {
            let tag_of = |handle: ColliderHandle| {
                self.world
                    .colliders
                    .get(handle)
                    .and_then(|collider| collider.parent())
                    .and_then(|parent| {
                        self.world
                            .bodies
                            .get(parent)
                            .map(|body| (parent, BodyTag::decode(body.user_data)))
                    })
            };

            let Some((body_a, tag_a)) = tag_of(h1) else {
                continue;
            };
            let Some((body_b, tag_b)) = tag_of(h2) else {
                continue;
            };

            // определение, кто в кого попал
            let (player_tag, shot_tag, shot_body) = match (tag_a, tag_b) {
                (
                    Some(BodyTag::Player { game_id, .. }),
                    Some(BodyTag::Shot {
                        shot_id,
                        owner_id,
                        weapon,
                        ..
                    }),
                ) => (game_id, (shot_id, owner_id, weapon), body_b),
                (
                    Some(BodyTag::Shot {
                        shot_id,
                        owner_id,
                        weapon,
                        ..
                    }),
                    Some(BodyTag::Player { game_id, .. }),
                ) => (game_id, (shot_id, owner_id, weapon), body_a),
                _ => continue,
            };

            let (_, owner_id, weapon_index) = shot_tag;
            let weapon_index = weapon_index as usize;

            // explosive уничтожается только по таймеру, не при контакте
            if self
                .cfg
                .weapons
                .get_index(weapon_index)
                .is_some_and(|(_, w)| w.kind == WeaponKind::Explosive)
            {
                continue;
            }

            if self.bodies_to_destroy.contains(&shot_body) {
                continue;
            }

            self.apply_damage(player_tag, owner_id, weapon_index, None);
            self.bodies_to_destroy.push(shot_body);
        }
    }

    /// Уничтожает тела из очереди (Game._destroyQueuedBodies).
    fn destroy_queued_bodies(&mut self) {
        if self.bodies_to_destroy.is_empty() {
            return;
        }

        let handles: Vec<RigidBodyHandle> = self.bodies_to_destroy.drain(..).collect();

        for handle in handles {
            let tag = self
                .world
                .bodies
                .get(handle)
                .and_then(|body| BodyTag::decode(body.user_data));

            if let Some(BodyTag::Shot {
                shot_id, weapon, ..
            }) = tag
            {
                self.shots.shift_remove(&shot_id);
                self.new_bombs
                    .entry(weapon as usize)
                    .or_default()
                    .insert(shot_id, None);
            }

            self.world.remove_body(handle);
        }
    }

    /// Урон игроку (Game.applyDamage): дружественный огонь, тряска
    /// камеры, kill-событие.
    pub fn apply_damage(
        &mut self,
        target_id: u32,
        shooter_id: u32,
        weapon_index: usize,
        damage_override: Option<f64>,
    ) {
        if !self.tank_alive(target_id) {
            return;
        }

        let target_team = self.tanks[&target_id].team_id;
        let shooter_team = self.tanks.get(&shooter_id).map(|tank| tank.team_id);

        if !self.cfg.friendly_fire && shooter_team == Some(target_team) {
            return;
        }

        let weapon = &self.cfg.weapons[weapon_index];

        if let Some(shake) = &weapon.camera_shake {
            self.events.push(CoreEvent::Shake {
                id: target_id,
                intensity: shake.intensity,
                duration: shake.duration,
            });
        }

        let damage = damage_override.unwrap_or(weapon.damage);

        let destroyed = {
            let tank = self.tanks.get_mut(&target_id).unwrap();
            let Some(body) = self.world.bodies.get_mut(tank.body) else {
                return;
            };

            tank.take_damage(damage, body, &mut self.events)
        };

        if destroyed {
            self.events.push(CoreEvent::Kill {
                victim: target_id,
                killer: shooter_id,
            });
        }
    }

    /// Мгновенный выстрел лучом (порт HitscanService.processShot).
    fn process_hitscan(&mut self, shooter_id: u32, weapon_index: usize, shot: &ShotCommand) -> TracerRow {
        let weapon = &self.cfg.weapons[weapon_index];
        let range = weapon.range.unwrap_or(1000.0);
        let impulse_magnitude = weapon.impulse_magnitude;

        // вектор луча длиной range: итоговый импульс пропорционален range
        // (поведение сохранено с planck-версии)
        let ray_vector = shot.direction * range;
        let end_point_ray = shot.start_point + ray_vector;
        let ray = Ray::new(shot.start_point, ray_vector);

        let shooter_body = self.tanks[&shooter_id].body;

        // ближайшее пересечение; сенсоры и тело стреляющего исключаются
        let hit = self.world.cast_ray(
            &ray,
            1.0,
            true,
            QueryFilter::new()
                .exclude_sensors()
                .exclude_rigid_body(shooter_body),
        );

        let was_hit = hit.is_some();
        let mut end_x = round1(end_point_ray.x);
        let mut end_y = round1(end_point_ray.y);

        if let Some((collider_handle, toi)) = hit {
            let impact = ray.point_at(toi);

            end_x = round1(impact.x);
            end_y = round1(impact.y);

            let hit_body_handle = self
                .world
                .colliders
                .get(collider_handle)
                .and_then(|collider| collider.parent());

            if let Some(handle) = hit_body_handle {
                let mut hit_player: Option<u32> = None;

                if let Some(body) = self.world.bodies.get_mut(handle) {
                    if impulse_magnitude > 0.0 && body.is_dynamic() {
                        body.apply_impulse_at_point(ray_vector * impulse_magnitude, impact, true);
                    }

                    if let Some(BodyTag::Player { game_id, .. }) = BodyTag::decode(body.user_data) {
                        hit_player = Some(game_id);
                    }
                }

                if let Some(target) = hit_player {
                    self.apply_damage(target, shooter_id, weapon_index, None);
                }
            }
        }

        TracerRow {
            floats: [
                round2(shot.start_point.x),
                round2(shot.start_point.y),
                end_x,
                end_y,
                round2(shot.body_position.x),
                round2(shot.body_position.y),
            ],
            was_hit,
            shooter: shooter_id as u8,
        }
    }

    /// Создаёт взрывной снаряд (Game._createWeaponAction).
    fn create_weapon_action(
        &mut self,
        owner_id: u32,
        weapon_index: usize,
        shot: &ShotCommand,
    ) -> (u32, BombRow) {
        let weapon = self.cfg.weapons[weapon_index].clone();
        let lifetime_seconds = weapon.time / 1000.0;
        let mut lifetime_in_steps = (lifetime_seconds / self.time_step).ceil() as usize;

        if lifetime_in_steps < 1 {
            lifetime_in_steps = 1;
        }

        if lifetime_in_steps >= self.max_shot_time_in_steps {
            // на случай max_shot_time_in_steps == 1 остаётся 0 (как в JS)
            lifetime_in_steps = self.max_shot_time_in_steps - 1;
        }

        self.current_shot_id += 1;

        let shot_id = self.current_shot_id;
        let removal_tick = (self.current_step_tick + lifetime_in_steps) % self.max_shot_time_in_steps;
        let team_id = self.tanks[&owner_id].team_id;

        let bomb = Bomb::new(
            &mut self.world,
            weapon_index,
            &weapon,
            shot_id,
            owner_id,
            team_id,
            shot.body_position,
        );

        let row = bomb.snapshot_row(&self.world, &weapon);

        self.shots.insert(shot_id, bomb);
        self.shots_at_time[removal_tick].push(shot_id);

        (shot_id, row)
    }

    /// Обрабатывает снаряды с истёкшим временем жизни (детонация).
    fn process_shots_expired_by_time(&mut self) {
        let shot_ids = std::mem::take(&mut self.shots_at_time[self.current_step_tick]);

        for shot_id in shot_ids {
            let Some(bomb) = self.shots.shift_remove(&shot_id) else {
                continue; // снаряд уже уничтожен досрочно
            };

            let weapon_index = bomb.weapon;
            let weapon = self.cfg.weapons[weapon_index].clone();

            if let Some(outcome_id) = weapon.shot_outcome_id.clone() {
                let explosion = self.detonate(&bomb, weapon_index);

                self.weapon_effects.entry(outcome_id).or_default().push(explosion);
            }

            self.world.remove_body(bomb.body);

            // null-маркер удаления исходного снаряда
            self.new_bombs
                .entry(weapon_index)
                .or_default()
                .insert(shot_id, None);
        }

        self.current_step_tick = (self.current_step_tick + 1) % self.max_shot_time_in_steps;
    }

    /// Детонация бомбы (порт Bomb.detonate): урон/импульс по целям в
    /// радиусе, данные взрыва для клиента.
    fn detonate(&mut self, bomb: &Bomb, weapon_index: usize) -> [f32; 3] {
        let weapon = &self.cfg.weapons[weapon_index];
        let radius = weapon.radius;
        let damage = weapon.damage;
        let impulse_magnitude = weapon.impulse_magnitude;
        let friendly_fire = self.cfg.friendly_fire;

        let bomb_position = self.world.bodies[bomb.body].translation();

        // потенциальные цели в квадрате взрыва (AABB), затем по дистанции
        struct Target {
            handle: RigidBodyHandle,
            tag: BodyTag,
            distance: f32,
        }

        let mut targets: Vec<Target> = Vec::new();

        {
            let aabb = Aabb::from_half_extents(bomb_position, Vector::new(radius, radius));

            for (_collider_handle, collider) in self
                .world
                .intersect_aabb_conservative(aabb, QueryFilter::new())
            {
                let Some(parent) = collider.parent() else {
                    continue;
                };

                if parent == bomb.body {
                    continue;
                }

                let Some(body) = self.world.bodies.get(parent) else {
                    continue;
                };

                if !body.is_dynamic() {
                    continue;
                }

                let Some(tag) = BodyTag::decode(body.user_data) else {
                    continue;
                };

                let distance = (body.translation() - bomb_position).length();

                if distance < radius && !targets.iter().any(|t| t.handle == parent) {
                    targets.push(Target {
                        handle: parent,
                        tag,
                        distance,
                    });
                }
            }
        }

        for target in targets {
            let falloff = 1.0 - target.distance / radius;
            let actual_damage = (damage * falloff as f64).round();
            let actual_impulse = impulse_magnitude * falloff;

            if let BodyTag::Player { game_id, team_id } = target.tag {
                if friendly_fire || bomb.team_id != team_id {
                    self.apply_damage(game_id, bomb.owner_id, weapon_index, Some(actual_damage));
                }
            }

            if actual_impulse > 0.0 && target.distance > 0.0 {
                if let Some(body) = self.world.bodies.get_mut(target.handle) {
                    let direction = (body.translation() - bomb_position).normalize_or_zero();
                    let impulse_vector = direction * actual_impulse;
                    let point = body.translation();

                    body.apply_impulse_at_point(impulse_vector, point, true);
                }
            }
        }

        [round1(bomb_position.x), round1(bomb_position.y), radius]
    }

    // ***** боты: сетка ***** //

    /// Пересобирает пространственную сетку по живым игрокам.
    fn build_spatial_grid(&mut self) {
        self.spatial.clear();

        for (game_id, tank) in &self.tanks {
            if !tank.is_alive() {
                continue;
            }

            if let Some(body) = self.world.bodies.get(tank.body) {
                let pos = body.translation();

                self.spatial.insert(SpatialEntity {
                    game_id: *game_id,
                    team_id: tank.team_id,
                    x: round2(pos.x),
                    y: round2(pos.y),
                });
            }
        }
    }

    // ***** снапшот ***** //

    fn refresh_cached_players(&mut self) {
        for (game_id, tank) in &self.tanks {
            let Some(body) = self.world.bodies.get(tank.body) else {
                continue;
            };
            let Some(model) = self.cfg.models.get(&tank.model) else {
                continue;
            };

            let (floats, condition, size, team) = tank.snapshot_row(body, model.size);

            self.cached_players.insert(
                *game_id,
                (
                    tank.model.clone(),
                    TankRow {
                        floats,
                        condition,
                        size,
                        team,
                    },
                ),
            );
        }
    }

    /// Собирает блоки тела снапшота, дренируя накопители событий.
    /// Вызывается на каждый отправляемый кадр (throttle — забота JS).
    pub fn build_snapshot_blocks(&mut self) -> Vec<(String, Block)> {
        let mut blocks: Vec<(String, Block)> = Vec::new();

        // событийные блоки (трассеры/бомбы/взрывы/удаления танков) требуют
        // надёжной доставки (канал meta); null-маркеры — уже событие
        let mut has_events = !self.pending_null_tanks.is_empty();

        // танки по моделям (getWorldState) + null-маркеры удалённых
        let mut tanks_by_model: IndexMap<String, Vec<(u8, Option<TankRow>)>> = IndexMap::new();

        for (game_id, (model, row)) in &self.cached_players {
            tanks_by_model
                .entry(model.clone())
                .or_default()
                .push((*game_id as u8, Some(*row)));
        }

        for (model, game_id) in self.pending_null_tanks.drain(..) {
            tanks_by_model
                .entry(model)
                .or_default()
                .push((game_id as u8, None));
        }

        for (model, rows) in tanks_by_model {
            blocks.push((model, Block::Tanks(rows)));
        }

        // события оружия
        for (weapon_index, tracers) in self.new_tracers.drain(..) {
            if tracers.is_empty() {
                continue;
            }

            has_events = true;

            let name = self.cfg.weapons.get_index(weapon_index).unwrap().0.clone();

            blocks.push((name, Block::Tracers(tracers)));
        }

        for (weapon_index, bombs) in self.new_bombs.drain(..) {
            if bombs.is_empty() {
                continue;
            }

            has_events = true;

            let name = self.cfg.weapons.get_index(weapon_index).unwrap().0.clone();

            blocks.push((name, Block::Bombs(bombs.into_iter().collect())));
        }

        for (outcome_id, explosions) in self.weapon_effects.drain(..) {
            if explosions.is_empty() {
                continue;
            }

            has_events = true;

            blocks.push((outcome_id, Block::Explosions(explosions)));
        }

        // динамические элементы карты — каждый отправляемый кадр
        if let Some(map) = &self.map {
            blocks.push((
                map.set_id.clone(),
                Block::Dynamics(map.dynamic_map_data(&self.world)),
            ));
        }

        self.last_body_has_events = has_events;

        blocks
    }

    /// Содержал ли последний собранный body событийные блоки — для
    /// классификации канала WebRTC (meta reliable / state unreliable).
    pub fn body_has_events(&self) -> bool {
        self.last_body_has_events
    }

    /// Полный снапшот игроков в форме Game.getPlayersData:
    /// { model: { gameId: [x, y, angle, gun, vx, vy, engineLoad,
    /// condition, size, team] } }. Читает кеш строк, НЕ дренируя
    /// накопители событий — для первого кадра (FIRST_SHOT_DATA).
    pub fn players_json(&self) -> String {
        use serde_json::{Map, Value};

        let mut by_model: Map<String, Value> = Map::new();

        for (game_id, (model, row)) in &self.cached_players {
            let mut arr: Vec<Value> = Vec::with_capacity(10);

            // f32 → f64 расширяется так же, как клиент читает f32 из
            // бинарного кадра (getFloat32 → double), значения совпадают
            for value in row.floats {
                arr.push(Value::from(value as f64));
            }

            arr.push(Value::from(row.condition));
            arr.push(Value::from(row.size));
            arr.push(Value::from(row.team));

            by_model
                .entry(model.clone())
                .or_insert_with(|| Value::Object(Map::new()))
                .as_object_mut()
                .unwrap()
                .insert(game_id.to_string(), Value::Array(arr));
        }

        Value::Object(by_model).to_string()
    }

    // ***** очистка ***** //

    /// Удаляет всех игроков и снаряды, возвращает имена для очистки
    /// полотна клиентов (Game.removePlayersAndShots).
    pub fn remove_players_and_shots(&mut self) -> Vec<String> {
        let mut names: Vec<String> = Vec::new();

        for name in self.remove_shots() {
            if !names.contains(&name) {
                names.push(name);
            }
        }

        // игроки
        let tanks: Vec<Tank> = self.tanks.drain(..).map(|(_, tank)| tank).collect();

        for tank in tanks {
            if !names.contains(&tank.model) {
                names.push(tank.model.clone());
            }

            self.world.remove_body(tank.body);
        }

        self.cached_players.clear();

        // все ключи оружий и эффектов — клиент чистит и «пустые»
        // (zombie-prediction)
        for name in self.cfg.weapons.keys() {
            if !names.contains(name) {
                names.push(name.clone());
            }
        }

        for weapon in self.cfg.weapons.values() {
            if let Some(outcome_id) = &weapon.shot_outcome_id {
                if !names.contains(outcome_id) {
                    names.push(outcome_id.clone());
                }
            }
        }

        names
    }

    /// Удаляет все снаряды, сбрасывает кольцевой буфер (Game._removeShots).
    fn remove_shots(&mut self) -> Vec<String> {
        let mut names: Vec<String> = Vec::new();

        self.current_shot_id = 0;

        let shots: Vec<Bomb> = self.shots.drain(..).map(|(_, bomb)| bomb).collect();

        for bomb in shots {
            let name = self.cfg.weapons.get_index(bomb.weapon).unwrap().0.clone();

            if !names.contains(&name) {
                names.push(name);
            }

            self.world.remove_body(bomb.body);
        }

        for slot in &mut self.shots_at_time {
            slot.clear();
        }

        self.current_step_tick = 0;

        names
    }

    /// Полная очистка игрового мира (Game.clear + сброс ботов).
    pub fn clear(&mut self) {
        // карта и снаряды удаляют свои тела первыми: повторное удаление
        // уже удалённого тела в Rapier недопустимо
        if let Some(mut map) = self.map.take() {
            map.destroy(&mut self.world);
        }

        self.remove_shots();

        let handles: Vec<RigidBodyHandle> = self
            .world
            .rigid_bodies()
            .map(|(handle, _)| handle)
            .collect();

        for handle in handles {
            self.world.remove_body(handle);
        }

        self.tanks.clear();
        self.bots.clear();
        self.nav = None;
        self.spatial.clear();

        self.new_tracers.clear();
        self.new_bombs.clear();
        self.weapon_effects.clear();
        self.pending_null_tanks.clear();
        self.cached_players.clear();
        self.bodies_to_destroy.clear();

        self.accumulator = 0.0;
    }

    // ***** handoff (Spike B / Этап 5.2) ***** //

    /// Сериализует состояние симуляции для эстафетной передачи между
    /// инстансами WASM. Накопители снапшота должны быть дренированы
    /// (pack_body) перед вызовом.
    pub fn serialize_state(&self) -> Result<Vec<u8>, String> {
        let dump = StateDump {
            world: WorldDump {
                gravity: [self.world.gravity.x, self.world.gravity.y],
                integration_parameters: self.world.integration_parameters,
                islands: self.world.islands.clone(),
                broad_phase: self.world.broad_phase.clone(),
                narrow_phase: self.world.narrow_phase.clone(),
                bodies: self.world.bodies.clone(),
                colliders: self.world.colliders.clone(),
                impulse_joints: self.world.impulse_joints.clone(),
                multibody_joints: self.world.multibody_joints.clone(),
            },
            map: &self.map,
            tanks: &self.tanks,
            bots: &self.bots,
            rng: &self.rng,
            shots: &self.shots,
            shots_at_time: &self.shots_at_time,
            current_shot_id: self.current_shot_id,
            current_step_tick: self.current_step_tick,
            accumulator: self.accumulator,
        };

        serde_json::to_vec(&dump).map_err(|e| e.to_string())
    }

    /// Восстанавливает состояние из дампа. Конфиг ядра должен совпадать
    /// с конфигом инстанса, создавшего дамп.
    pub fn deserialize_state(&mut self, data: &[u8]) -> Result<(), String> {
        let dump: StateDumpOwned = serde_json::from_slice(data).map_err(|e| e.to_string())?;

        let mut world = PhysicsWorld::new();

        world.gravity = Vector::new(dump.world.gravity[0], dump.world.gravity[1]);
        world.integration_parameters = dump.world.integration_parameters;
        world.islands = dump.world.islands;
        world.broad_phase = dump.world.broad_phase;
        world.narrow_phase = dump.world.narrow_phase;
        world.bodies = dump.world.bodies;
        world.colliders = dump.world.colliders;
        world.impulse_joints = dump.world.impulse_joints;
        world.multibody_joints = dump.world.multibody_joints;

        self.world = world;
        self.map = dump.map;
        self.tanks = dump.tanks;
        self.bots = dump.bots;
        self.rng = dump.rng;
        self.shots = dump.shots;
        self.shots_at_time = dump.shots_at_time;
        self.current_shot_id = dump.current_shot_id;
        self.current_step_tick = dump.current_step_tick;
        self.accumulator = dump.accumulator;

        self.new_tracers.clear();
        self.new_bombs.clear();
        self.weapon_effects.clear();
        self.pending_null_tanks.clear();
        self.cached_players.clear();
        self.bodies_to_destroy.clear();
        self.events.clear();

        // производные структуры не входят в дамп (кортежные ключи не
        // сериализуются в JSON): нав-граф регенерируется из карты,
        // пространственная сетка — из живых игроков
        self.nav = self
            .map
            .as_ref()
            .map(|map| NavigationSystem::generate(&map.grid, &map.physics_static, map.step));

        self.build_spatial_grid();
        self.refresh_cached_players();

        Ok(())
    }
}

#[derive(Serialize)]
struct WorldDump {
    gravity: [f32; 2],
    integration_parameters: IntegrationParameters,
    islands: IslandManager,
    broad_phase: BroadPhaseBvh,
    narrow_phase: NarrowPhase,
    bodies: RigidBodySet,
    colliders: ColliderSet,
    impulse_joints: ImpulseJointSet,
    multibody_joints: MultibodyJointSet,
}

#[derive(Deserialize)]
struct WorldDumpOwned {
    gravity: [f32; 2],
    integration_parameters: IntegrationParameters,
    islands: IslandManager,
    broad_phase: BroadPhaseBvh,
    narrow_phase: NarrowPhase,
    bodies: RigidBodySet,
    colliders: ColliderSet,
    impulse_joints: ImpulseJointSet,
    multibody_joints: MultibodyJointSet,
}

#[derive(Serialize)]
struct StateDump<'a> {
    world: WorldDump,
    map: &'a Option<GameMap>,
    tanks: &'a IndexMap<u32, Tank>,
    bots: &'a IndexMap<u32, BotBrain>,
    rng: &'a Rng,
    shots: &'a IndexMap<u32, Bomb>,
    shots_at_time: &'a Vec<Vec<u32>>,
    current_shot_id: u32,
    current_step_tick: usize,
    accumulator: f32,
}

#[derive(Deserialize)]
struct StateDumpOwned {
    world: WorldDumpOwned,
    map: Option<GameMap>,
    tanks: IndexMap<u32, Tank>,
    bots: IndexMap<u32, BotBrain>,
    rng: Rng,
    shots: IndexMap<u32, Bomb>,
    shots_at_time: Vec<Vec<u32>>,
    current_shot_id: u32,
    current_step_tick: usize,
    accumulator: f32,
}
