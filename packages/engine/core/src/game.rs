use std::sync::mpsc::channel;

use rapier2d::prelude::*;
use serde::{Deserialize, Serialize};

use crate::nav::navigation::NavigationSystem;
use crate::nav::spatial::SpatialGrid;
use crate::config::{EngineConfig, PLAYER_STATE_LEN};
use crate::events::CoreEvent;
use crate::map::{GameMap, MapConfig};
use crate::rng::Rng;
use crate::sim::{GameDef, GameSim, SimCtx};
use crate::snapshot::Block;

/// защита от «спирали смерти» (Game._maxAccumulatedTime)
const MAX_ACCUMULATED_TIME: f32 = 0.1;

/// Движковый каркас симуляции: физический мир, карта, нав-граф/сетка
/// ботов, PRNG, аккумулятор фиксированного шага, очередь удаления тел,
/// события. Игровая логика (участники/оружие/снапшот-блоки) вынесена в
/// `G::Sim` (см. core/src/sim.rs) — движок зовёт её только через
/// `on_fixed_step`/`on_contacts`/`on_before_destroy`/`on_ai_tick`, не зная
/// деталей конкретной игры. Конкретная игра (тип `G`, дефолт для
/// `GameState`-алиасов — забота game-crate) не импортируется движком.
pub struct EngineSim<G: GameDef> {
    pub cfg: EngineConfig,
    pub world: PhysicsWorld,
    pub map: Option<GameMap>,
    pub nav: Option<NavigationSystem>,
    pub spatial: SpatialGrid,
    pub rng: Rng,

    time_step: f32,
    accumulator: f32,

    // события для меты, дренируются в take_events
    pub events: Vec<CoreEvent>,

    // очередь тел на удаление после обработки контактов
    bodies_to_destroy: Vec<RigidBodyHandle>,

    // содержал ли последний собранный body событийные блоки — для
    // классификации канала WebRTC (meta reliable / state unreliable)
    last_body_has_events: bool,

    pub sim: G::Sim,
}

impl<G: GameDef> EngineSim<G> {
    pub fn new(cfg: EngineConfig, game_cfg: &G::Config) -> Self {
        let time_step = cfg.time_step;

        let mut world = PhysicsWorld::new();

        world.gravity = Vector::ZERO;
        world.integration_parameters.dt = time_step;

        let seed = cfg.seed;
        let sim = G::Sim::new(game_cfg, &cfg);

        Self {
            world,
            map: None,
            nav: None,
            spatial: SpatialGrid::new(600.0),
            rng: Rng::new(seed),
            time_step,
            accumulator: 0.0,
            events: Vec::new(),
            bodies_to_destroy: Vec::new(),
            last_body_has_events: false,
            sim,
            cfg,
        }
    }

    // ***** карта ***** //

    /// Создаёт карту из JSON (масштабирование внутри) и нав-граф ботов.
    pub fn load_map(&mut self, json: &str) -> Result<(), String> {
        let map_cfg: MapConfig = serde_json::from_str(json).map_err(|e| format!("bad map json: {e}"))?;

        if let Some(mut old) = self.map.take() {
            old.destroy(&mut self.world);
        }

        let map = GameMap::create(&mut self.world, &map_cfg, self.cfg.map_scale, &self.cfg.map_set_id);

        self.nav = Some(NavigationSystem::generate(&map.grid, &map.physics_static, map.step));
        self.map = Some(map);

        Ok(())
    }

    /// Информация о загруженной карте: setId, масштабированные респауны,
    /// размеры мира (JSON) — 'null', если карта не загружена.
    pub fn map_info_json(&self) -> String {
        let Some(map) = &self.map else {
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

    pub fn spawn_actor(&mut self, game_id: u32, model_name: &str, team_id: u8, x: f32, y: f32, angle_deg: f32) -> Result<(), String> {
        self.sim
            .spawn_actor(&mut self.world, &mut self.events, game_id, model_name, team_id, x, y, angle_deg)
    }

    pub fn remove_actor(&mut self, game_id: u32) {
        self.sim.remove_actor(&mut self.world, game_id);
    }

    pub fn reset_actor(&mut self, game_id: u32, team_id: u8, x: f32, y: f32, angle_deg: f32) {
        self.sim.reset_actor(&mut self.world, game_id, team_id, x, y, angle_deg);
    }

    pub fn reset_all_vitals(&mut self) {
        self.sim.reset_all_vitals(&mut self.events);
    }

    pub fn spawn_scripted_actor(&mut self, game_id: u32, model_name: &str, team_id: u8, x: f32, y: f32, angle_deg: f32) -> Result<(), String> {
        self.sim.spawn_scripted_actor(
            &mut self.world,
            &mut self.rng,
            &mut self.events,
            game_id,
            model_name,
            team_id,
            x,
            y,
            angle_deg,
        )
    }

    pub fn remove_scripted_actor(&mut self, game_id: u32) {
        self.sim.remove_scripted_actor(&mut self.world, game_id);
    }

    // ***** ввод ***** //

    pub fn apply_input(&mut self, game_id: u32, seq: u32, action: &str, key_name: &str) {
        self.sim.apply_input(game_id, seq, action, key_name);
    }

    pub fn last_input_seq(&self, game_id: u32) -> u32 {
        self.sim.last_input_seq(game_id)
    }

    /// События за тик (kill/health/ammo/weapon/shake) одной JSON-строкой;
    /// буфер очищается.
    pub fn take_events_json(&mut self) -> String {
        let events: Vec<CoreEvent> = self.events.drain(..).collect();

        serde_json::to_string(&events).unwrap_or_else(|_| "[]".to_string())
    }

    // ***** запросы состояния ***** //

    pub fn is_alive(&self, game_id: u32) -> bool {
        self.sim.is_alive(game_id)
    }

    pub fn actor_position(&self, game_id: u32) -> Option<[f32; 2]> {
        self.sim.actor_position(&self.world, game_id)
    }

    pub fn prediction_state(&self, game_id: u32) -> Option<([f32; PLAYER_STATE_LEN], bool)> {
        self.sim.prediction_state(&self.world, game_id)
    }

    pub fn alive_players_flat(&self) -> Vec<f32> {
        self.sim.alive_players_flat(&self.world)
    }

    /// Полный снапшот игроков (Game.getPlayersData), не дренируя
    /// накопители событий — для первого кадра (FIRST_SHOT_DATA).
    pub fn players_json(&self) -> String {
        self.sim.players_json()
    }

    // ***** игровой тик ***** //

    /// Обновляет физику фиксированными шагами (Game.updateData),
    /// затем ИИ скриптовых участников (VIMP._onShotTick).
    pub fn step(&mut self, dt: f32) {
        self.accumulator = (self.accumulator + dt).min(MAX_ACCUMULATED_TIME);

        while self.accumulator >= self.time_step {
            self.step_fixed();
            self.accumulator -= self.time_step;
        }

        self.sim.refresh_cached(&self.world);

        let mut ctx = SimCtx {
            world: &mut self.world,
            cfg: &self.cfg,
            map: &self.map,
            nav: &self.nav,
            spatial: &mut self.spatial,
            rng: &mut self.rng,
            events: &mut self.events,
            bodies_to_destroy: &mut self.bodies_to_destroy,
        };

        self.sim.on_ai_tick(&mut ctx, dt);
    }

    /// Один фиксированный шаг физики.
    fn step_fixed(&mut self) {
        let mut ctx = SimCtx {
            world: &mut self.world,
            cfg: &self.cfg,
            map: &self.map,
            nav: &self.nav,
            spatial: &mut self.spatial,
            rng: &mut self.rng,
            events: &mut self.events,
            bodies_to_destroy: &mut self.bodies_to_destroy,
        };

        self.sim.on_fixed_step(&mut ctx, self.time_step);

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

        let mut ctx = SimCtx {
            world: &mut self.world,
            cfg: &self.cfg,
            map: &self.map,
            nav: &self.nav,
            spatial: &mut self.spatial,
            rng: &mut self.rng,
            events: &mut self.events,
            bodies_to_destroy: &mut self.bodies_to_destroy,
        };

        self.sim.on_contacts(&mut ctx, &contacts);
        self.destroy_queued_bodies();
    }

    /// Уничтожает тела из очереди (Game._destroyQueuedBodies).
    fn destroy_queued_bodies(&mut self) {
        if self.bodies_to_destroy.is_empty() {
            return;
        }

        let handles: Vec<RigidBodyHandle> = self.bodies_to_destroy.drain(..).collect();

        for handle in handles {
            self.sim.on_before_destroy(&self.world, handle);
            self.world.remove_body(handle);
        }
    }

    // ***** снапшот ***** //

    /// Собирает блоки тела снапшота, дренируя накопители событий.
    /// Вызывается на каждый отправляемый кадр (throttle — забота JS).
    pub fn build_snapshot_blocks(&mut self) -> Vec<(String, Block)> {
        let (mut blocks, has_events) = self.sim.build_snapshot_blocks();

        // динамические элементы карты — каждый отправляемый кадр
        if let Some(map) = &self.map {
            blocks.push((
                map.set_id.clone(),
                Block::IndexedNoNull8(map.dynamic_map_data(&self.world)),
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

    // ***** очистка ***** //

    /// Удаляет всех игроков и снаряды, возвращает имена для очистки
    /// полотна клиентов (Game.removePlayersAndShots).
    pub fn remove_players_and_shots(&mut self) -> Vec<String> {
        self.sim.remove_players_and_shots(&mut self.world)
    }

    /// Полная очистка игрового мира (Game.clear + сброс ботов).
    pub fn clear(&mut self) {
        // карта удаляет свои тела первой: повторное удаление уже
        // удалённого тела в Rapier недопустимо
        if let Some(mut map) = self.map.take() {
            map.destroy(&mut self.world);
        }

        let handles: Vec<RigidBodyHandle> = self.world.rigid_bodies().map(|(handle, _)| handle).collect();

        for handle in handles {
            self.world.remove_body(handle);
        }

        self.sim.clear();
        self.nav = None;
        self.spatial.clear();
        self.bodies_to_destroy.clear();

        self.accumulator = 0.0;
    }

    // ***** handoff (Spike B / Этап 5.2) ***** //

    /// Сериализует состояние симуляции для эстафетной передачи между
    /// инстансами WASM. Накопители снапшота должны быть дренированы
    /// (pack_body) перед вызовом.
    pub fn serialize_state(&self) -> Result<Vec<u8>, String> {
        let dump = EngineDump {
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
            rng: &self.rng,
            accumulator: self.accumulator,
            sim: self.sim.serialize(),
        };

        serde_json::to_vec(&dump).map_err(|e| e.to_string())
    }

    /// Восстанавливает состояние из дампа. Конфиг ядра должен совпадать
    /// с конфигом инстанса, создавшего дамп.
    pub fn deserialize_state(&mut self, data: &[u8]) -> Result<(), String> {
        let dump: EngineDumpOwned = serde_json::from_slice(data).map_err(|e| e.to_string())?;

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
        self.rng = dump.rng;
        self.accumulator = dump.accumulator;
        self.sim.deserialize(dump.sim)?;

        self.bodies_to_destroy.clear();
        self.events.clear();

        // производные структуры не входят в дамп: нав-граф регенерируется
        // из карты, пространственная сетка — из живых участников
        self.nav = self
            .map
            .as_ref()
            .map(|map| NavigationSystem::generate(&map.grid, &map.physics_static, map.step));

        self.sim.rebuild_spatial_grid(&self.world, &mut self.spatial);
        self.sim.refresh_cached(&self.world);

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
struct EngineDump<'a> {
    world: WorldDump,
    map: &'a Option<GameMap>,
    rng: &'a Rng,
    accumulator: f32,
    sim: serde_json::Value,
}

#[derive(Deserialize)]
struct EngineDumpOwned {
    world: WorldDumpOwned,
    map: Option<GameMap>,
    rng: Rng,
    accumulator: f32,
    sim: serde_json::Value,
}
