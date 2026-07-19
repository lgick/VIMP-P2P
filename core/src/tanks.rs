//! Игровая симуляция «танки» поверх движкового каркаса `EngineSim`
//! (core/src/game.rs). Владеет участниками, снарядами, ботами и
//! снапшот-накопителями; движок зовёт callback'ы через `SimCtx`
//! (см. core/src/sim.rs, PLAN.md §3.6).

use indexmap::IndexMap;
use rapier2d::prelude::*;
use serde::{Deserialize, Serialize};

use crate::bomb::{Bomb, BombRow};
use crate::bots::controller::BotBrain;
use crate::bots::navigation::NavigationSystem;
use crate::bots::spatial::{SpatialEntity, SpatialGrid};
use crate::config::{CoreConfig, WeaponConfig, WeaponKind, PLAYER_STATE_LEN};
use crate::events::CoreEvent;
use crate::physics::{round1, round2, BodyTag};
use crate::rng::Rng;
use crate::sim::{GameDef, GameSim, SimCtx};
use crate::snapshot::{Block, TankRow, TracerRow};
use crate::tank::{PlayerKeyBits, ShotCommand, Tank};

/// Маркер игры для `EngineSim<TanksGame>` (единственная игра в дереве).
pub struct TanksGame;

impl GameDef for TanksGame {
    type Sim = TanksSim;
}

/// Вид движковых+игровых ресурсов, которым пользуется ИИ бота
/// (core/src/bots/controller.rs) — имена полей/методов совпадают с
/// прежним монолитным `GameState`, чтобы тело `BotBrain` осталось
/// нетронутым.
pub(crate) struct BotView<'a> {
    pub world: &'a mut PhysicsWorld,
    pub nav: &'a Option<NavigationSystem>,
    pub spatial: &'a SpatialGrid,
    pub rng: &'a mut Rng,
    pub tanks: &'a mut IndexMap<u32, Tank>,
    pub key_bits: &'a PlayerKeyBits,
    pub weapons: &'a IndexMap<String, WeaponConfig>,
}

impl BotView<'_> {
    pub fn tank_alive(&self, game_id: u32) -> bool {
        self.tanks.get(&game_id).is_some_and(|tank| tank.is_alive())
    }

    pub fn tank_position_rounded(&self, game_id: u32) -> Option<[f32; 2]> {
        let tank = self.tanks.get(&game_id)?;
        let body = self.world.bodies.get(tank.body)?;
        let pos = body.translation();

        Some([round2(pos.x), round2(pos.y)])
    }

    pub fn update_tank_keys(&mut self, game_id: u32, action: &str, bit: u32) {
        if let Some(tank) = self.tanks.get_mut(&game_id) {
            tank.update_keys(action, bit, self.key_bits);
        }
    }

    pub fn weapon_index(&self, name: &str) -> Option<usize> {
        self.weapons.get_index_of(name)
    }
}

pub struct TanksSim {
    key_bits: PlayerKeyBits,
    pub(crate) tanks: IndexMap<u32, Tank>,
    bots: IndexMap<u32, BotBrain>,

    shots: IndexMap<u32, Bomb>,
    shots_at_time: Vec<Vec<u32>>,
    current_shot_id: u32,
    current_step_tick: usize,
    max_shot_time_in_steps: usize,

    new_tracers: IndexMap<usize, Vec<TracerRow>>,
    new_bombs: IndexMap<usize, IndexMap<u32, Option<BombRow>>>,
    weapon_effects: IndexMap<String, Vec<[f32; 3]>>,
    pending_null_tanks: Vec<(String, u32)>,

    cached_players: IndexMap<u32, (String, TankRow)>,
}

impl GameSim<TanksGame> for TanksSim {
    fn new(cfg: &CoreConfig) -> Self {
        let max_lifetime_ms = cfg
            .weapons
            .values()
            .filter(|w| w.kind != WeaponKind::Hitscan)
            .map(|w| w.time)
            .fold(0.0f32, f32::max);

        let max_lifetime_with_buffer = (max_lifetime_ms / 1000.0) * 1.5;
        let max_shot_time_in_steps =
            ((max_lifetime_with_buffer / cfg.time_step).ceil() as usize).max(1);

        Self {
            key_bits: PlayerKeyBits::from_config(&cfg.player_keys),
            tanks: IndexMap::new(),
            bots: IndexMap::new(),
            shots: IndexMap::new(),
            shots_at_time: vec![Vec::new(); max_shot_time_in_steps],
            current_shot_id: 0,
            current_step_tick: 0,
            max_shot_time_in_steps,
            new_tracers: IndexMap::new(),
            new_bombs: IndexMap::new(),
            weapon_effects: IndexMap::new(),
            pending_null_tanks: Vec::new(),
            cached_players: IndexMap::new(),
        }
    }

    fn spawn_actor(
        &mut self,
        world: &mut PhysicsWorld,
        cfg: &CoreConfig,
        events: &mut Vec<CoreEvent>,
        game_id: u32,
        model_name: &str,
        team_id: u8,
        x: f32,
        y: f32,
        angle_deg: f32,
    ) -> Result<(), String> {
        let model = cfg
            .models
            .get(model_name)
            .ok_or_else(|| format!("unknown model '{model_name}'"))?
            .clone();

        let tank = Tank::new(world, cfg, model_name, &model, game_id, team_id, x, y, angle_deg);

        events.push(CoreEvent::PanelActive {
            id: game_id,
            field: cfg
                .weapons
                .get_index(tank.current_weapon)
                .map(|(name, _)| name.clone())
                .unwrap_or_default(),
        });
        events.push(CoreEvent::PanelSet {
            id: game_id,
            field: "health".to_string(),
            value: tank.health,
        });

        self.tanks.insert(game_id, tank);

        Ok(())
    }

    fn remove_actor(&mut self, world: &mut PhysicsWorld, game_id: u32) {
        if let Some(tank) = self.tanks.shift_remove(&game_id) {
            world.remove_body(tank.body);
            self.cached_players.shift_remove(&game_id);
            self.pending_null_tanks.push((tank.model, game_id));
        }
    }

    fn reset_actor(&mut self, world: &mut PhysicsWorld, game_id: u32, team_id: u8, x: f32, y: f32, angle_deg: f32) {
        if let Some(tank) = self.tanks.get_mut(&game_id) {
            if let Some(body) = world.bodies.get_mut(tank.body) {
                tank.change_player_data(team_id, x, y, angle_deg, body);
            }
        }
    }

    fn reset_all_vitals(&mut self, cfg: &CoreConfig, events: &mut Vec<CoreEvent>) {
        for tank in self.tanks.values_mut() {
            tank.reset_vitals(cfg, events);
        }
    }

    fn spawn_scripted_actor(
        &mut self,
        world: &mut PhysicsWorld,
        rng: &mut Rng,
        cfg: &CoreConfig,
        events: &mut Vec<CoreEvent>,
        game_id: u32,
        model_name: &str,
        team_id: u8,
        x: f32,
        y: f32,
        angle_deg: f32,
    ) -> Result<(), String> {
        self.spawn_actor(world, cfg, events, game_id, model_name, team_id, x, y, angle_deg)?;

        if !self.bots.contains_key(&game_id) {
            let brain = BotBrain::new(game_id, rng);

            self.bots.insert(game_id, brain);
        }

        Ok(())
    }

    fn remove_scripted_actor(&mut self, world: &mut PhysicsWorld, game_id: u32) {
        self.bots.shift_remove(&game_id);
        self.remove_actor(world, game_id);
    }

    fn apply_input(&mut self, cfg: &CoreConfig, game_id: u32, seq: u32, action: &str, key_name: &str) {
        let bit = cfg.player_keys.get(key_name).map(|k| k.key).unwrap_or(0);

        if let Some(tank) = self.tanks.get_mut(&game_id) {
            tank.last_input_seq = seq;
            tank.update_keys(action, bit, &self.key_bits);
        }
    }

    fn last_input_seq(&self, game_id: u32) -> u32 {
        self.tanks.get(&game_id).map(|tank| tank.last_input_seq).unwrap_or(0)
    }

    fn tank_alive(&self, game_id: u32) -> bool {
        self.tanks.get(&game_id).is_some_and(|tank| tank.is_alive())
    }

    fn tank_position_rounded(&self, world: &PhysicsWorld, game_id: u32) -> Option<[f32; 2]> {
        let tank = self.tanks.get(&game_id)?;
        let body = world.bodies.get(tank.body)?;
        let pos = body.translation();

        Some([round2(pos.x), round2(pos.y)])
    }

    fn prediction_state(&self, world: &PhysicsWorld, game_id: u32) -> Option<([f32; PLAYER_STATE_LEN], bool)> {
        let tank = self.tanks.get(&game_id)?;
        let body = world.bodies.get(tank.body)?;

        Some(tank.prediction_state(body))
    }

    fn alive_players_flat(&self, world: &PhysicsWorld) -> Vec<f32> {
        let mut out = Vec::new();

        for (id, tank) in &self.tanks {
            if !tank.is_alive() {
                continue;
            }

            let Some(body) = world.bodies.get(tank.body) else {
                continue;
            };
            let pos = body.translation();

            out.push(*id as f32);
            out.push(tank.team_id as f32);
            out.push(round2(pos.x));
            out.push(round2(pos.y));
        }

        out
    }

    fn players_json(&self) -> String {
        use serde_json::{Map, Value};

        let mut by_model: Map<String, Value> = Map::new();

        for (game_id, (model, row)) in &self.cached_players {
            let mut arr: Vec<Value> = Vec::with_capacity(10);

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

    fn on_fixed_step(&mut self, ctx: &mut SimCtx, dt: f32) {
        let ids: Vec<u32> = self.tanks.keys().copied().collect();

        for id in ids {
            let shot;

            {
                let Some(tank) = self.tanks.get_mut(&id) else {
                    continue;
                };
                let Some(body) = ctx.world.bodies.get_mut(tank.body) else {
                    continue;
                };
                let Some(model) = ctx.cfg.models.get(&tank.model) else {
                    continue;
                };

                shot = tank.update(dt, body, model, &ctx.cfg.weapons, &self.key_bits, ctx.rng, ctx.events);
            }

            if let Some(shot) = shot {
                let weapon_index = self.tanks[&id].current_weapon;
                let kind = ctx.cfg.weapons[weapon_index].kind;

                match kind {
                    WeaponKind::Hitscan => {
                        let tracer = self.process_hitscan(ctx, id, weapon_index, &shot);

                        self.new_tracers.entry(weapon_index).or_default().push(tracer);
                    }
                    WeaponKind::Explosive => {
                        let (shot_id, row) = self.create_weapon_action(ctx, id, weapon_index, &shot);

                        self.new_bombs
                            .entry(weapon_index)
                            .or_default()
                            .insert(shot_id, Some(row));
                    }
                }
            }
        }

        self.process_shots_expired_by_time(ctx);
    }

    fn on_contacts(&mut self, ctx: &mut SimCtx, pairs: &[(ColliderHandle, ColliderHandle)]) {
        for &(h1, h2) in pairs {
            let tag_of = |handle: ColliderHandle| {
                ctx.world
                    .colliders
                    .get(handle)
                    .and_then(|collider| collider.parent())
                    .and_then(|parent| {
                        ctx.world
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

            let (player_tag, shot_tag, shot_body) = match (tag_a, tag_b) {
                (
                    Some(BodyTag::Player { game_id, .. }),
                    Some(BodyTag::Shot { shot_id, owner_id, weapon, .. }),
                ) => (game_id, (shot_id, owner_id, weapon), body_b),
                (
                    Some(BodyTag::Shot { shot_id, owner_id, weapon, .. }),
                    Some(BodyTag::Player { game_id, .. }),
                ) => (game_id, (shot_id, owner_id, weapon), body_a),
                _ => continue,
            };

            let (_, owner_id, weapon_index) = shot_tag;
            let weapon_index = weapon_index as usize;

            if ctx
                .cfg
                .weapons
                .get_index(weapon_index)
                .is_some_and(|(_, w)| w.kind == WeaponKind::Explosive)
            {
                continue;
            }

            if ctx.bodies_to_destroy.contains(&shot_body) {
                continue;
            }

            self.apply_damage(ctx, player_tag, owner_id, weapon_index, None);
            ctx.bodies_to_destroy.push(shot_body);
        }
    }

    fn on_before_destroy(&mut self, world: &PhysicsWorld, handle: RigidBodyHandle) {
        let tag = world.bodies.get(handle).and_then(|body| BodyTag::decode(body.user_data));

        if let Some(BodyTag::Shot { shot_id, weapon, .. }) = tag {
            self.shots.shift_remove(&shot_id);
            self.new_bombs
                .entry(weapon as usize)
                .or_default()
                .insert(shot_id, None);
        }
    }

    fn on_ai_tick(&mut self, ctx: &mut SimCtx, dt: f32) {
        if self.bots.is_empty() {
            return;
        }

        let ids: Vec<u32> = self.bots.keys().copied().collect();

        for id in ids {
            if let Some(mut brain) = self.bots.shift_remove(&id) {
                let mut view = crate::tanks::BotView {
                    world: &mut *ctx.world,
                    nav: ctx.nav,
                    spatial: &*ctx.spatial,
                    rng: &mut *ctx.rng,
                    tanks: &mut self.tanks,
                    key_bits: &self.key_bits,
                    weapons: &ctx.cfg.weapons,
                };

                brain.update(&mut view, dt);
                self.bots.insert(id, brain);
            }
        }

        self.rebuild_spatial_grid(ctx.world, ctx.spatial);
    }

    fn refresh_cached(&mut self, world: &PhysicsWorld, cfg: &CoreConfig) {
        for (game_id, tank) in &self.tanks {
            let Some(body) = world.bodies.get(tank.body) else {
                continue;
            };
            let Some(model) = cfg.models.get(&tank.model) else {
                continue;
            };

            let (floats, condition, size, team) = tank.snapshot_row(body, model.size);

            self.cached_players.insert(
                *game_id,
                (
                    tank.model.clone(),
                    TankRow { floats, condition, size, team },
                ),
            );
        }
    }

    fn build_snapshot_blocks(&mut self, cfg: &CoreConfig) -> (Vec<(String, Block)>, bool) {
        let mut blocks: Vec<(String, Block)> = Vec::new();
        let mut has_events = !self.pending_null_tanks.is_empty();

        let mut tanks_by_model: IndexMap<String, Vec<(u8, Option<TankRow>)>> = IndexMap::new();

        for (game_id, (model, row)) in &self.cached_players {
            tanks_by_model
                .entry(model.clone())
                .or_default()
                .push((*game_id as u8, Some(*row)));
        }

        for (model, game_id) in self.pending_null_tanks.drain(..) {
            tanks_by_model.entry(model).or_default().push((game_id as u8, None));
        }

        for (model, rows) in tanks_by_model {
            blocks.push((model, Block::Tanks(rows)));
        }

        for (weapon_index, tracers) in self.new_tracers.drain(..) {
            if tracers.is_empty() {
                continue;
            }

            has_events = true;

            let name = cfg.weapons.get_index(weapon_index).unwrap().0.clone();

            blocks.push((name, Block::Tracers(tracers)));
        }

        for (weapon_index, bombs) in self.new_bombs.drain(..) {
            if bombs.is_empty() {
                continue;
            }

            has_events = true;

            let name = cfg.weapons.get_index(weapon_index).unwrap().0.clone();

            blocks.push((name, Block::Bombs(bombs.into_iter().collect())));
        }

        for (outcome_id, explosions) in self.weapon_effects.drain(..) {
            if explosions.is_empty() {
                continue;
            }

            has_events = true;

            blocks.push((outcome_id, Block::Explosions(explosions)));
        }

        (blocks, has_events)
    }

    fn remove_players_and_shots(&mut self, world: &mut PhysicsWorld, cfg: &CoreConfig) -> Vec<String> {
        let mut names: Vec<String> = Vec::new();

        for name in self.remove_shots(world, cfg) {
            if !names.contains(&name) {
                names.push(name);
            }
        }

        let tanks: Vec<Tank> = self.tanks.drain(..).map(|(_, tank)| tank).collect();

        for tank in tanks {
            if !names.contains(&tank.model) {
                names.push(tank.model.clone());
            }

            world.remove_body(tank.body);
        }

        self.cached_players.clear();

        for name in cfg.weapons.keys() {
            if !names.contains(name) {
                names.push(name.clone());
            }
        }

        for weapon in cfg.weapons.values() {
            if let Some(outcome_id) = &weapon.shot_outcome_id {
                if !names.contains(outcome_id) {
                    names.push(outcome_id.clone());
                }
            }
        }

        names
    }

    fn clear(&mut self) {
        self.tanks.clear();
        self.bots.clear();

        self.new_tracers.clear();
        self.new_bombs.clear();
        self.weapon_effects.clear();
        self.pending_null_tanks.clear();
        self.cached_players.clear();

        self.current_shot_id = 0;
        self.shots.clear();

        for slot in &mut self.shots_at_time {
            slot.clear();
        }

        self.current_step_tick = 0;
    }

    fn serialize(&self) -> serde_json::Value {
        let dump = TanksDump {
            tanks: &self.tanks,
            bots: &self.bots,
            shots: &self.shots,
            shots_at_time: &self.shots_at_time,
            current_shot_id: self.current_shot_id,
            current_step_tick: self.current_step_tick,
        };

        serde_json::to_value(dump).unwrap_or(serde_json::Value::Null)
    }

    fn deserialize(&mut self, value: serde_json::Value) -> Result<(), String> {
        let dump: TanksDumpOwned = serde_json::from_value(value).map_err(|e| e.to_string())?;

        self.tanks = dump.tanks;
        self.bots = dump.bots;
        self.shots = dump.shots;
        self.shots_at_time = dump.shots_at_time;
        self.current_shot_id = dump.current_shot_id;
        self.current_step_tick = dump.current_step_tick;

        self.new_tracers.clear();
        self.new_bombs.clear();
        self.weapon_effects.clear();
        self.pending_null_tanks.clear();
        self.cached_players.clear();

        Ok(())
    }

    fn rebuild_spatial_grid(&self, world: &PhysicsWorld, spatial: &mut SpatialGrid) {
        spatial.clear();

        for (game_id, tank) in &self.tanks {
            if !tank.is_alive() {
                continue;
            }

            if let Some(body) = world.bodies.get(tank.body) {
                let pos = body.translation();

                spatial.insert(SpatialEntity {
                    game_id: *game_id,
                    team_id: tank.team_id,
                    x: round2(pos.x),
                    y: round2(pos.y),
                });
            }
        }
    }
}

impl TanksSim {
    /// Мгновенный выстрел лучом (порт HitscanService.processShot).
    fn process_hitscan(&mut self, ctx: &mut SimCtx, shooter_id: u32, weapon_index: usize, shot: &ShotCommand) -> TracerRow {
        let weapon = &ctx.cfg.weapons[weapon_index];
        let range = weapon.range.unwrap_or(1000.0);
        let impulse_magnitude = weapon.impulse_magnitude;

        let ray_vector = shot.direction * range;
        let end_point_ray = shot.start_point + ray_vector;
        let ray = Ray::new(shot.start_point, ray_vector);

        let shooter_body = self.tanks[&shooter_id].body;

        let hit = ctx.world.cast_ray(
            &ray,
            1.0,
            true,
            QueryFilter::new().exclude_sensors().exclude_rigid_body(shooter_body),
        );

        let was_hit = hit.is_some();
        let mut end_x = round1(end_point_ray.x);
        let mut end_y = round1(end_point_ray.y);

        if let Some((collider_handle, toi)) = hit {
            let impact = ray.point_at(toi);

            end_x = round1(impact.x);
            end_y = round1(impact.y);

            let hit_body_handle = ctx
                .world
                .colliders
                .get(collider_handle)
                .and_then(|collider| collider.parent());

            if let Some(handle) = hit_body_handle {
                let mut hit_player: Option<u32> = None;

                if let Some(body) = ctx.world.bodies.get_mut(handle) {
                    if impulse_magnitude > 0.0 && body.is_dynamic() {
                        body.apply_impulse_at_point(ray_vector * impulse_magnitude, impact, true);
                    }

                    if let Some(BodyTag::Player { game_id, .. }) = BodyTag::decode(body.user_data) {
                        hit_player = Some(game_id);
                    }
                }

                if let Some(target) = hit_player {
                    self.apply_damage(ctx, target, shooter_id, weapon_index, None);
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
    fn create_weapon_action(&mut self, ctx: &mut SimCtx, owner_id: u32, weapon_index: usize, shot: &ShotCommand) -> (u32, BombRow) {
        let weapon = ctx.cfg.weapons[weapon_index].clone();
        let lifetime_seconds = weapon.time / 1000.0;
        let mut lifetime_in_steps = (lifetime_seconds / ctx.cfg.time_step).ceil() as usize;

        if lifetime_in_steps < 1 {
            lifetime_in_steps = 1;
        }

        if lifetime_in_steps >= self.max_shot_time_in_steps {
            lifetime_in_steps = self.max_shot_time_in_steps - 1;
        }

        self.current_shot_id += 1;

        let shot_id = self.current_shot_id;
        let removal_tick = (self.current_step_tick + lifetime_in_steps) % self.max_shot_time_in_steps;
        let team_id = self.tanks[&owner_id].team_id;

        let bomb = Bomb::new(ctx.world, weapon_index, &weapon, shot_id, owner_id, team_id, shot.body_position);
        let row = bomb.snapshot_row(ctx.world, &weapon);

        self.shots.insert(shot_id, bomb);
        self.shots_at_time[removal_tick].push(shot_id);

        (shot_id, row)
    }

    /// Обрабатывает снаряды с истёкшим временем жизни (детонация).
    fn process_shots_expired_by_time(&mut self, ctx: &mut SimCtx) {
        let shot_ids = std::mem::take(&mut self.shots_at_time[self.current_step_tick]);

        for shot_id in shot_ids {
            let Some(bomb) = self.shots.shift_remove(&shot_id) else {
                continue;
            };

            let weapon_index = bomb.weapon;
            let weapon = ctx.cfg.weapons[weapon_index].clone();

            if let Some(outcome_id) = weapon.shot_outcome_id.clone() {
                let explosion = self.detonate(ctx, &bomb, weapon_index);

                self.weapon_effects.entry(outcome_id).or_default().push(explosion);
            }

            ctx.world.remove_body(bomb.body);

            self.new_bombs.entry(weapon_index).or_default().insert(shot_id, None);
        }

        self.current_step_tick = (self.current_step_tick + 1) % self.max_shot_time_in_steps;
    }

    /// Детонация бомбы (порт Bomb.detonate): урон/импульс по целям в
    /// радиусе, данные взрыва для клиента.
    fn detonate(&mut self, ctx: &mut SimCtx, bomb: &Bomb, weapon_index: usize) -> [f32; 3] {
        let weapon = &ctx.cfg.weapons[weapon_index];
        let radius = weapon.radius;
        let damage = weapon.damage;
        let impulse_magnitude = weapon.impulse_magnitude;
        let friendly_fire = ctx.cfg.friendly_fire;

        let bomb_position = ctx.world.bodies[bomb.body].translation();

        struct Target {
            handle: RigidBodyHandle,
            tag: BodyTag,
            distance: f32,
        }

        let mut targets: Vec<Target> = Vec::new();

        {
            let aabb = Aabb::from_half_extents(bomb_position, Vector::new(radius, radius));

            for (_collider_handle, collider) in ctx.world.intersect_aabb_conservative(aabb, QueryFilter::new()) {
                let Some(parent) = collider.parent() else {
                    continue;
                };

                if parent == bomb.body {
                    continue;
                }

                let Some(body) = ctx.world.bodies.get(parent) else {
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
                    targets.push(Target { handle: parent, tag, distance });
                }
            }
        }

        for target in targets {
            let falloff = 1.0 - target.distance / radius;
            let actual_damage = (damage * falloff as f64).round();
            let actual_impulse = impulse_magnitude * falloff;

            if let BodyTag::Player { game_id, team_id } = target.tag {
                if friendly_fire || bomb.team_id != team_id {
                    self.apply_damage(ctx, game_id, bomb.owner_id, weapon_index, Some(actual_damage));
                }
            }

            if actual_impulse > 0.0 && target.distance > 0.0 {
                if let Some(body) = ctx.world.bodies.get_mut(target.handle) {
                    let direction = (body.translation() - bomb_position).normalize_or_zero();
                    let impulse_vector = direction * actual_impulse;
                    let point = body.translation();

                    body.apply_impulse_at_point(impulse_vector, point, true);
                }
            }
        }

        [round1(bomb_position.x), round1(bomb_position.y), radius]
    }

    /// Урон игроку (Game.applyDamage): дружественный огонь, тряска
    /// камеры, kill-событие.
    fn apply_damage(&mut self, ctx: &mut SimCtx, target_id: u32, shooter_id: u32, weapon_index: usize, damage_override: Option<f64>) {
        if !self.tank_alive(target_id) {
            return;
        }

        let target_team = self.tanks[&target_id].team_id;
        let shooter_team = self.tanks.get(&shooter_id).map(|tank| tank.team_id);

        if !ctx.cfg.friendly_fire && shooter_team == Some(target_team) {
            return;
        }

        let weapon = &ctx.cfg.weapons[weapon_index];

        if let Some(shake) = &weapon.camera_shake {
            ctx.events.push(CoreEvent::Shake {
                id: target_id,
                intensity: shake.intensity,
                duration: shake.duration,
            });
        }

        let damage = damage_override.unwrap_or(weapon.damage);

        let destroyed = {
            let tank = self.tanks.get_mut(&target_id).unwrap();
            let Some(body) = ctx.world.bodies.get_mut(tank.body) else {
                return;
            };

            tank.take_damage(damage, body, ctx.events)
        };

        if destroyed {
            ctx.events.push(CoreEvent::Death { victim: target_id, killer: shooter_id });
        }
    }

    /// Удаляет все снаряды, сбрасывает кольцевой буфер (Game._removeShots).
    fn remove_shots(&mut self, world: &mut PhysicsWorld, cfg: &CoreConfig) -> Vec<String> {
        let mut names: Vec<String> = Vec::new();

        self.current_shot_id = 0;

        let shots: Vec<Bomb> = self.shots.drain(..).map(|(_, bomb)| bomb).collect();

        for bomb in shots {
            let name = cfg.weapons.get_index(bomb.weapon).unwrap().0.clone();

            if !names.contains(&name) {
                names.push(name);
            }

            world.remove_body(bomb.body);
        }

        for slot in &mut self.shots_at_time {
            slot.clear();
        }

        self.current_step_tick = 0;

        names
    }
}

#[derive(Serialize)]
struct TanksDump<'a> {
    tanks: &'a IndexMap<u32, Tank>,
    bots: &'a IndexMap<u32, BotBrain>,
    shots: &'a IndexMap<u32, Bomb>,
    shots_at_time: &'a Vec<Vec<u32>>,
    current_shot_id: u32,
    current_step_tick: usize,
}

#[derive(Deserialize)]
struct TanksDumpOwned {
    tanks: IndexMap<u32, Tank>,
    bots: IndexMap<u32, BotBrain>,
    shots: IndexMap<u32, Bomb>,
    shots_at_time: Vec<Vec<u32>>,
    current_shot_id: u32,
    current_step_tick: usize,
}
