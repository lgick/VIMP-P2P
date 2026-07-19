use rapier2d::prelude::*;
use serde::{Deserialize, Serialize};

use crate::config::{CoreConfig, KeyConfig, ModelConfig, PLAYER_STATE_LEN, WeaponConfig};
use crate::events::CoreEvent;
use crate::motion::{self, TurretInput};
use crate::physics::{BodyTag, deg_to_rad, round2};
use crate::rng::Rng;

/// Битовые маски клавиш игрока, разрешённые из config.playerKeys.
#[derive(Clone, Copy, Default, Serialize, Deserialize)]
pub struct PlayerKeyBits {
    pub forward: u32,
    pub back: u32,
    pub left: u32,
    pub right: u32,
    pub gun_center: u32,
    pub gun_left: u32,
    pub gun_right: u32,
    pub fire: u32,
    pub next_weapon: u32,
    pub prev_weapon: u32,
    pub one_shot_mask: u32,
}

impl PlayerKeyBits {
    pub fn from_config(keys: &indexmap::IndexMap<String, KeyConfig>) -> Self {
        let bit = |name: &str| keys.get(name).map(|k| k.key).unwrap_or(0);
        let one_shot_mask = keys
            .values()
            .filter(|k| k.kind == 1)
            .fold(0, |mask, k| mask | k.key);

        Self {
            forward: bit("forward"),
            back: bit("back"),
            left: bit("left"),
            right: bit("right"),
            gun_center: bit("gunCenter"),
            gun_left: bit("gunLeft"),
            gun_right: bit("gunRight"),
            fire: bit("fire"),
            next_weapon: bit("nextWeapon"),
            prev_weapon: bit("prevWeapon"),
            one_shot_mask,
        }
    }
}

/// Данные выстрела, снятые с танка на тике (Tank._shotData).
pub struct ShotCommand {
    pub body_position: Vector,
    pub start_point: Vector,
    pub direction: Vector,
}

/// Танк: порт src/server/parts/Tank.js + BaseModel.js.
/// Здоровье и боезапас живут в ядре (в JS-версии ими владела панель);
/// мета узнаёт об изменениях из событий Health/Ammo/ActiveWeapon.
#[derive(Serialize, Deserialize)]
pub struct Tank {
    pub game_id: u32,
    pub team_id: u8,
    pub model: String,
    pub body: RigidBodyHandle,

    // производные от модели
    width: f32,
    height: f32,
    mass: f32,
    inertia: f32,

    // ввод
    current_keys: u32,
    one_shot_events: u32,

    // башня
    pub gun_rotation: f32,
    pub centering_gun: bool,

    // движение
    engine_throttle: f32,
    pub engine_load: f32,

    // состояние: 3 норма, 2/1 повреждения, 0 уничтожен
    pub condition: u8,
    pub health: f64,

    // боезапас и кулдауны по индексам оружия
    pub ammo: Vec<f64>,
    cooldowns: Vec<f32>,
    pub current_weapon: usize,

    pub last_input_seq: u32,
}

const FORWARD: Vector = Vector::new(1.0, 0.0);
const RIGHT: Vector = Vector::new(0.0, 1.0);

impl Tank {
    /// Создаёт тело танка в мире и возвращает экземпляр.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        world: &mut PhysicsWorld,
        cfg: &CoreConfig,
        model_name: &str,
        model: &ModelConfig,
        game_id: u32,
        team_id: u8,
        x: f32,
        y: f32,
        angle_deg: f32,
    ) -> Self {
        let width = model.size * 4.0;
        let height = model.size * 3.0;

        let tag = BodyTag::Player { game_id, team_id };

        let body_handle = world.insert_body(
            RigidBodyBuilder::dynamic()
                .translation(Vector::new(x, y))
                .rotation(deg_to_rad(angle_deg))
                .angular_damping(model.damping.angular)
                .linear_damping(model.damping.linear)
                .user_data(tag.encode()),
        );

        world.insert_collider(
            ColliderBuilder::cuboid(width / 2.0, height / 2.0)
                .density(model.fixture.density)
                .friction(model.fixture.friction)
                .restitution(model.fixture.restitution)
                // события контактов (попадания снарядов) собирает game
                .active_events(ActiveEvents::COLLISION_EVENTS),
            Some(body_handle),
        );

        let body = &world.bodies[body_handle];
        let mass = body.mass();
        let inertia = body.mass_properties().local_mprops.principal_inertia();

        let current_weapon = cfg
            .weapons
            .get_index_of(&model.current_weapon)
            .unwrap_or(0);

        let health = cfg.panel.get("health").map(|p| p.value).unwrap_or(100.0);
        let ammo = cfg
            .weapons
            .keys()
            .map(|name| cfg.panel.get(name).map(|p| p.value).unwrap_or(0.0))
            .collect();

        Self {
            game_id,
            team_id,
            model: model_name.to_string(),
            body: body_handle,
            width,
            height,
            mass,
            inertia,
            current_keys: 0,
            one_shot_events: 0,
            gun_rotation: 0.0,
            centering_gun: false,
            engine_throttle: 0.0,
            engine_load: 0.0,
            condition: 3,
            health,
            ammo,
            cooldowns: vec![0.0; cfg.weapons.len()],
            current_weapon,
            last_input_seq: 0,
        }
    }

    pub fn is_alive(&self) -> bool {
        self.condition > 0
    }

    /// Обновляет состояние клавиш (BaseModel.updateKeys).
    pub fn update_keys(&mut self, action: &str, key_bit: u32, bits: &PlayerKeyBits) {
        if key_bit == 0 {
            return;
        }

        if action == "down" {
            if bits.one_shot_mask & key_bit != 0 {
                self.one_shot_events |= key_bit;
            } else {
                self.current_keys |= key_bit;
            }
        } else if action == "up" {
            self.current_keys &= !key_bit;
        }
    }

    fn keys_for_processing(&mut self) -> u32 {
        let keys = self.current_keys | self.one_shot_events;

        self.one_shot_events = 0;
        keys
    }

    pub fn reset_keys(&mut self) {
        self.current_keys = 0;
        self.one_shot_events = 0;
    }

    /// Применяет урон (Tank.takeDamage): true — танк уничтожен этим уроном.
    pub fn take_damage(
        &mut self,
        amount: f64,
        body: &mut RigidBody,
        events: &mut Vec<CoreEvent>,
    ) -> bool {
        if self.condition == 0 {
            return false;
        }

        let new_health = (self.health - amount).max(0.0);

        self.health = new_health;
        events.push(CoreEvent::Health {
            id: self.game_id,
            value: new_health,
        });

        if new_health <= 0.0 {
            self.condition = 0;

            // остановка танка при уничтожении, сброс нажатых клавиш
            body.set_linvel(Vector::ZERO, true);
            body.set_angvel(0.0, true);
            self.reset_keys();

            return true;
        }

        self.condition = if new_health < 35.0 {
            1
        } else if new_health < 70.0 {
            2
        } else {
            3
        };

        false
    }

    fn lateral_velocity(body: &RigidBody) -> f32 {
        let current_right_normal = body.rotation().transform_vector(RIGHT);

        current_right_normal.dot(body.linvel())
    }

    /// Проверяет кулдаун/патроны и списывает выстрел
    /// (BaseModel.tryConsumeAmmoAndShoot).
    fn try_consume_ammo_and_shoot(
        &mut self,
        weapons: &indexmap::IndexMap<String, WeaponConfig>,
        events: &mut Vec<CoreEvent>,
    ) -> bool {
        let (name, weapon) = weapons.get_index(self.current_weapon).unwrap();
        let consumption = weapon.consumption.unwrap_or(1.0);

        if self.cooldowns[self.current_weapon] <= 0.0
            && self.ammo[self.current_weapon] >= consumption
        {
            self.ammo[self.current_weapon] =
                (self.ammo[self.current_weapon] - consumption).max(0.0);
            self.cooldowns[self.current_weapon] = weapon.fire_rate;

            events.push(CoreEvent::Ammo {
                id: self.game_id,
                weapon: name.clone(),
                value: self.ammo[self.current_weapon],
            });

            return true;
        }

        false
    }

    fn update_cooldowns(&mut self, dt: f32) {
        for cooldown in &mut self.cooldowns {
            if *cooldown > 0.0 {
                *cooldown -= dt;
            }

            *cooldown = cooldown.max(0.0);
        }
    }

    /// Меняет активное оружие (BaseModel.turnUserWeapon).
    pub fn turn_weapon(
        &mut self,
        back: bool,
        weapons: &indexmap::IndexMap<String, WeaponConfig>,
        events: &mut Vec<CoreEvent>,
    ) {
        let len = weapons.len() as isize;
        let mut key = self.current_weapon as isize + if back { -1 } else { 1 };

        if key < 0 {
            key = len - 1;
        } else if key >= len {
            key = 0;
        }

        self.current_weapon = key as usize;

        events.push(CoreEvent::ActiveWeapon {
            id: self.game_id,
            weapon: weapons.get_index(self.current_weapon).unwrap().0.clone(),
        });
    }

    /// Формулы дула/направления реплицируются клиентом
    /// (ShotPredictor._buildTracer) — менять синхронно.
    pub fn muzzle_position(&self, body: &RigidBody) -> Vector {
        let total_angle = body.rotation().angle() + self.gun_rotation;
        let rel_pos =
            Rotation::from_angle(total_angle).transform_vector(Vector::new(self.width * 0.55, 0.0));

        body.translation() + rel_pos
    }

    pub fn fire_direction(
        &self,
        body: &RigidBody,
        weapon: &WeaponConfig,
        rng: &mut Rng,
    ) -> Vector {
        let total_angle = body.rotation().angle() + self.gun_rotation;
        let mut direction = Rotation::from_angle(total_angle).transform_vector(FORWARD);

        if weapon.spread > 0.0 {
            let spread = rng.range(-weapon.spread, weapon.spread);

            direction = Rotation::from_angle(spread).transform_vector(direction);
        }

        direction.normalize_or_zero()
    }

    /// Обновление логики танка на фиксированном шаге (Tank.updateData).
    /// Порядок операций закреплён паритет-тестом клиентской реплики.
    pub fn update(
        &mut self,
        dt: f32,
        body: &mut RigidBody,
        model: &ModelConfig,
        weapons: &indexmap::IndexMap<String, WeaponConfig>,
        bits: &PlayerKeyBits,
        rng: &mut Rng,
        events: &mut Vec<CoreEvent>,
    ) -> Option<ShotCommand> {
        let keys = self.keys_for_processing();

        let forward = keys & bits.forward != 0;
        let back = keys & bits.back != 0;
        let left = keys & bits.left != 0;
        let right = keys & bits.right != 0;
        let g_center = keys & bits.gun_center != 0;
        let g_left = keys & bits.gun_left != 0;
        let g_right = keys & bits.gun_right != 0;
        let fire = keys & bits.fire != 0;
        let next_weapon = keys & bits.next_weapon != 0;
        let prev_weapon = keys & bits.prev_weapon != 0;

        let mut shot_data = None;

        self.update_cooldowns(dt);

        // сначала поворот башни: gunRotation актуален перед расчётом выстрела
        let turret = TurretInput {
            center: g_center,
            left: g_left,
            right: g_right,
        };

        (self.gun_rotation, self.centering_gun) =
            motion::step_turret(self.gun_rotation, self.centering_gun, turret, model, dt);

        if fire && self.try_consume_ammo_and_shoot(weapons, events) {
            let weapon = &weapons[self.current_weapon];

            shot_data = Some(ShotCommand {
                body_position: body.translation(),
                start_point: self.muzzle_position(body),
                direction: self.fire_direction(body, weapon, rng),
            });
        }

        self.engine_throttle =
            motion::step_throttle(self.engine_throttle, forward || back, model, dt);

        let current_velocity = body.linvel();
        let forward_vec = body.rotation().transform_vector(FORWARD);
        let current_forward_speed = current_velocity.dot(forward_vec);

        // импульс против бокового скольжения: Δv · масса
        let lateral_vel = Self::lateral_velocity(body);
        let lateral_dv = motion::lateral_dv(lateral_vel, model, dt);
        let sideways_vec = body
            .rotation()
            .transform_vector(Vector::new(0.0, lateral_dv * self.mass));

        body.apply_impulse(sideways_vec, true);

        // импульс тяги/торможения: ускорение · масса · dt
        let accel = motion::drive_accel(
            self.engine_throttle,
            forward,
            back,
            current_forward_speed,
            model,
        );

        if accel != 0.0 {
            body.apply_impulse(forward_vec * (accel * self.mass * dt), true);
        }

        self.engine_load = motion::engine_load(self.engine_throttle, current_forward_speed, model);

        // импульс поворота корпуса: Δω · инерция
        let delta_omega = motion::turn_delta(left, right, current_forward_speed, model, dt);

        if delta_omega != 0.0 {
            body.apply_torque_impulse(delta_omega * self.inertia, true);
        }

        if next_weapon {
            self.turn_weapon(false, weapons, events);
        }

        if prev_weapon {
            self.turn_weapon(true, weapons, events);
        }

        shot_data
    }

    /// Смена данных при переходе между командами / респауне
    /// (Tank.changePlayerData). Здоровье/патроны не трогает —
    /// их сбрасывает reset_vitals (аналог Panel.reset).
    pub fn change_player_data(
        &mut self,
        team_id: u8,
        x: f32,
        y: f32,
        angle_deg: f32,
        body: &mut RigidBody,
    ) {
        self.team_id = team_id;
        body.user_data = BodyTag::Player {
            game_id: self.game_id,
            team_id,
        }
        .encode();

        body.set_linvel(Vector::ZERO, true);
        body.set_angvel(0.0, true);
        body.set_translation(Vector::new(x, y), true);
        body.set_rotation(Rotation::from_angle(deg_to_rad(angle_deg)), true);
        self.gun_rotation = 0.0;

        self.engine_throttle = 0.0;
        self.engine_load = 0.0;
        self.centering_gun = false;

        self.reset_keys();
    }

    /// Сброс здоровья/боезапаса к дефолтам (аналог Panel.reset для игрока).
    pub fn reset_vitals(&mut self, cfg: &CoreConfig, events: &mut Vec<CoreEvent>) {
        self.health = cfg.panel.get("health").map(|p| p.value).unwrap_or(100.0);
        self.condition = 3;

        events.push(CoreEvent::Health {
            id: self.game_id,
            value: self.health,
        });

        for (index, name) in cfg.weapons.keys().enumerate() {
            self.ammo[index] = cfg.panel.get(name).map(|p| p.value).unwrap_or(0.0);
            self.cooldowns[index] = 0.0;

            events.push(CoreEvent::Ammo {
                id: self.game_id,
                weapon: name.clone(),
                value: self.ammo[index],
            });
        }
    }

    /// Строка снапшота (Tank.getData): значения скруглены до 2 знаков.
    pub fn snapshot_row(&self, body: &RigidBody, size: f32) -> ([f32; 7], u8, u8, u8) {
        let pos = body.translation();
        let vel = body.linvel();

        (
            [
                round2(pos.x),
                round2(pos.y),
                round2(body.rotation().angle()),
                round2(self.gun_rotation),
                round2(vel.x),
                round2(vel.y),
                round2(self.engine_load),
            ],
            self.condition,
            size as u8,
            self.team_id,
        )
    }

    /// Состояние для client-side prediction (без округлений).
    pub fn prediction_state(&self, body: &RigidBody) -> ([f32; PLAYER_STATE_LEN], bool) {
        let pos = body.translation();
        let vel = body.linvel();

        (
            [
                pos.x,
                pos.y,
                body.rotation().angle(),
                vel.x,
                vel.y,
                body.angvel(),
                self.gun_rotation,
                self.engine_throttle,
            ],
            self.centering_gun,
        )
    }
}
