use std::cell::Cell;
use std::f32::consts::PI;

use rapier2d::prelude::*;
use serde::{Deserialize, Serialize};

use crate::tanks::BotView;

// константы поведения бота (из src/server/modules/bots/BotController.js)
const AI_UPDATE_INTERVAL: f32 = 0.1;
const TARGET_PREDICTION_FACTOR: f32 = 0.2;
const OBSTACLE_AVOIDANCE_RAY_LENGTH: f32 = 50.0;
const MIN_TARGET_DISTANCE: f32 = 30.0;
const MAX_FIRING_DISTANCE: f32 = 500.0;

// снижение меткости
const AIM_INACCURACY: f32 = 0.5;
const MIN_FIRING_DELAY: f32 = 0.5;
const RANDOM_FIRING_DELAY: f32 = 0.5;

// использование бомб
const BOMB_USAGE_DISTANCE: f32 = 100.0;
const BOMB_COOLDOWN: f32 = 0.0;

const REPATH_INTERVAL: f32 = 1.0;
const TARGET_SCAN_INTERVAL: f32 = 1.5;

const FORWARD: Vector = Vector::new(1.0, 0.0);
const RIGHT: Vector = Vector::new(0.0, 1.0);

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BotState {
    Patrolling,
    Navigating,
    Attacking,
    Searching,
    ClearingObstacle,
    Dead,
    Idle,
}

/// Удерживаемые клавиши бота (JS _keyStates).
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
enum HeldKey {
    Forward,
    Back,
    Left,
    Right,
    GunLeft,
    GunRight,
}

const HELD_KEYS: [HeldKey; 6] = [
    HeldKey::Forward,
    HeldKey::Back,
    HeldKey::Left,
    HeldKey::Right,
    HeldKey::GunLeft,
    HeldKey::GunRight,
];

enum MoveTarget {
    Player(u32),
    Point([f32; 2]),
}

/// ИИ одного бота (порт BotController): навигация, прицеливание,
/// стрельба. Ввод генерируется внутри ядра — бот дёргает те же клавиши,
/// что и игрок.
#[derive(Serialize, Deserialize)]
pub struct BotBrain {
    pub game_id: u32,
    pub state: BotState,

    target: Option<u32>,
    path: Option<Vec<[f32; 2]>>,
    path_index: usize,

    repath_timer: f32,
    target_scan_timer: f32,
    ai_update_timer: f32,
    firing_timer: f32,
    bomb_cooldown_timer: f32,

    last_known_position: Option<[f32; 2]>,

    stuck_timer: f32,
    last_position: Option<[f32; 2]>,

    reposition_timer: f32,
    reposition_target: Option<[f32; 2]>,

    patrol_target: Option<[f32; 2]>,

    key_states: [bool; 6],

    // кэш кадра (JS _updateCachedData)
    #[serde(skip)]
    my_position: Option<[f32; 2]>,
}

fn dist_sq(a: [f32; 2], b: [f32; 2]) -> f32 {
    let dx = a[0] - b[0];
    let dy = a[1] - b[1];

    dx * dx + dy * dy
}

fn rotate(v: Vector, angle: f32) -> Vector {
    Rotation::from_angle(angle).transform_vector(v)
}

fn normalize_angle(angle: f32) -> f32 {
    angle.sin().atan2(angle.cos())
}

impl BotBrain {
    pub fn new(game_id: u32, rng: &mut crate::rng::Rng) -> Self {
        Self {
            game_id,
            state: BotState::Patrolling,
            target: None,
            path: None,
            path_index: 0,
            repath_timer: rng.next_f32() * REPATH_INTERVAL,
            target_scan_timer: rng.next_f32() * TARGET_SCAN_INTERVAL,
            ai_update_timer: 0.0,
            firing_timer: 0.0,
            bomb_cooldown_timer: 0.0,
            last_known_position: None,
            stuck_timer: 0.0,
            last_position: None,
            reposition_timer: 0.0,
            reposition_target: None,
            patrol_target: None,
            key_states: [false; 6],
            my_position: None,
        }
    }

    fn key_bit(&self, game: &BotView<'_>, key: HeldKey) -> u32 {
        let bits = &game.key_bits;

        match key {
            HeldKey::Forward => bits.forward,
            HeldKey::Back => bits.back,
            HeldKey::Left => bits.left,
            HeldKey::Right => bits.right,
            HeldKey::GunLeft => bits.gun_left,
            HeldKey::GunRight => bits.gun_right,
        }
    }

    /// Обновляет клавишу только при изменении состояния (JS _setKeyState).
    fn set_key_state(&mut self, game: &mut BotView<'_>, key: HeldKey, is_down: bool) {
        let index = HELD_KEYS.iter().position(|&k| k == key).unwrap();

        if self.key_states[index] != is_down {
            self.key_states[index] = is_down;

            let bit = self.key_bit(game, key);
            let action = if is_down { "down" } else { "up" };

            game.update_tank_keys(self.game_id, action, bit);
        }
    }

    fn press_one_shot(&self, game: &mut BotView<'_>, bit: u32) {
        game.update_tank_keys(self.game_id, "down", bit);
    }

    fn release_all_keys(&mut self, game: &mut BotView<'_>) {
        for key in HELD_KEYS {
            self.set_key_state(game, key, false);
        }
    }

    /// Главный метод обновления (вызывается на каждом тике ядра).
    pub(crate) fn update(&mut self, game: &mut BotView<'_>, dt: f32) {
        self.my_position = game.tank_position_rounded(self.game_id);

        let has_body = game
            .tanks
            .get(&self.game_id)
            .map(|tank| tank.body)
            .is_some_and(|handle| game.world.bodies.get(handle).is_some());

        if !has_body || !game.tank_alive(self.game_id) {
            if self.state != BotState::Dead {
                self.state = BotState::Dead;
                self.release_all_keys(game);
            }

            return;
        }

        self.ai_update_timer -= dt;
        self.firing_timer = (self.firing_timer - dt).max(0.0);
        self.bomb_cooldown_timer = (self.bomb_cooldown_timer - dt).max(0.0);
        self.repath_timer -= dt;
        self.target_scan_timer -= dt;
        self.reposition_timer = (self.reposition_timer - dt).max(0.0);

        // обнаружение застревания
        self.stuck_timer += dt;

        if self.stuck_timer >= 1.5 {
            self.stuck_timer = 0.0;

            if let Some(current) = self.my_position {
                if let Some(last) = self.last_position {
                    let moving_state = matches!(
                        self.state,
                        BotState::Navigating | BotState::Searching | BotState::Patrolling
                    );

                    if moving_state && dist_sq(current, last) < 10.0 {
                        self.state = BotState::ClearingObstacle;
                    }
                }

                self.last_position = Some(current);
            }
        }

        if self.ai_update_timer <= 0.0 {
            self.ai_update_timer = AI_UPDATE_INTERVAL;
            self.make_decision(game);
        }

        if self.state == BotState::ClearingObstacle {
            self.handle_clearing_obstacle(game);
        } else {
            self.execute_movement(game);
            self.execute_aim_and_shoot(game);
        }
    }

    /// Принятие решений: атаковать видимого врага, идти к последней
    /// известной позиции или патрулировать.
    fn make_decision(&mut self, game: &mut BotView<'_>) {
        if self.target_scan_timer > 0.0 && self.state != BotState::Patrolling {
            return;
        }

        self.target_scan_timer = TARGET_SCAN_INTERVAL;

        self.target = self.find_closest_enemy(game);

        if let Some(target) = self.target {
            self.patrol_target = None;
            self.path = None;

            if let Some(target_pos) = game.tank_position_rounded(target) {
                self.last_known_position = Some(target_pos);

                let visible = match (&game.nav, self.my_position) {
                    (Some(nav), Some(my)) => !nav.has_obstacle_between(my, target_pos),
                    _ => false,
                };

                self.state = if visible {
                    BotState::Attacking
                } else {
                    BotState::Navigating
                };
            }

            return;
        }

        if self.last_known_position.is_some() {
            self.state = BotState::Searching;
            return;
        }

        self.state = BotState::Patrolling;

        if self.patrol_target.is_none() {
            self.set_new_patrol_target(game);
        }
    }

    /// Новая случайная цель патрулирования + путь к ней.
    fn set_new_patrol_target(&mut self, game: &mut BotView<'_>) {
        let Some(nav) = &game.nav else {
            return;
        };

        let random_node = nav.random_node(&mut game.rng);

        if let (Some(node), Some(my)) = (random_node, self.my_position) {
            self.patrol_target = Some(node);
            self.path = nav.find_path(my, node);
            self.path_index = 0;
        }
    }

    /// Движение согласно текущему состоянию.
    fn execute_movement(&mut self, game: &mut BotView<'_>) {
        if let Some(target) = self.target {
            if !game.tank_alive(target) {
                self.target = None;
                self.last_known_position = None;
                self.make_decision(game);
                return;
            }
        }

        if self.state == BotState::Attacking || self.state == BotState::Navigating {
            let Some(target) = self.target else {
                return;
            };

            if self.reposition_timer > 0.0 && self.reposition_target.is_some() {
                let reposition = self.reposition_target.unwrap();

                self.move_to(game, MoveTarget::Point(reposition));

                if let Some(my) = self.my_position {
                    if dist_sq(my, reposition) < 50.0 * 50.0 {
                        self.reposition_timer = 0.0;
                    }
                }
            } else {
                self.move_to(game, MoveTarget::Player(target));
            }

            return;
        }

        if self.state == BotState::Searching {
            if let Some(last_known) = self.last_known_position {
                self.move_to(game, MoveTarget::Point(last_known));

                if let Some(my) = self.my_position {
                    if dist_sq(my, last_known) < MIN_TARGET_DISTANCE * MIN_TARGET_DISTANCE {
                        self.last_known_position = None;
                    }
                }

                return;
            }
        }

        if self.state == BotState::Patrolling {
            if self.path.is_some() && self.patrol_target.is_some() {
                let patrol = self.patrol_target.unwrap();

                self.follow_path(game);

                if let Some(my) = self.my_position {
                    if dist_sq(my, patrol) < MIN_TARGET_DISTANCE * MIN_TARGET_DISTANCE {
                        self.patrol_target = None;
                        self.path = None;
                    }
                }
            } else if self.path.is_none() {
                self.set_new_patrol_target(game);
            }

            return;
        }

        self.release_all_keys(game);
    }

    /// Движение по текущему пути.
    fn follow_path(&mut self, game: &mut BotView<'_>) {
        let Some(path) = &self.path else {
            return;
        };

        if self.path_index >= path.len() {
            return;
        }

        let next_waypoint = path[self.path_index];

        self.move_to(game, MoveTarget::Point(next_waypoint));

        if let Some(my) = self.my_position {
            if dist_sq(my, next_waypoint) < MIN_TARGET_DISTANCE * MIN_TARGET_DISTANCE {
                self.path_index += 1;
            }
        }
    }

    /// Ближайший живой враг (через пространственную сетку).
    fn find_closest_enemy(&self, game: &BotView<'_>) -> Option<u32> {
        let my = self.my_position?;
        let my_team = game.tanks.get(&self.game_id)?.team_id;

        let candidates = game.spatial.query_nearby(my[0], my[1]);
        let mut closest: Option<u32> = None;
        let mut min_distance_sq = f32::INFINITY;

        for candidate in candidates {
            if candidate.game_id == self.game_id || candidate.team_id == my_team {
                continue;
            }

            let distance_sq = dist_sq(my, [candidate.x, candidate.y]);

            if distance_sq < min_distance_sq
                && distance_sq < MAX_FIRING_DISTANCE * MAX_FIRING_DISTANCE * 1.5
            {
                min_distance_sq = distance_sq;
                closest = Some(candidate.game_id);
            }
        }

        closest
    }

    /// Движение к цели (gameId или точка) с обходом препятствий.
    fn move_to(&mut self, game: &mut BotView<'_>, target: MoveTarget) {
        let Some(tank) = game.tanks.get(&self.game_id) else {
            return;
        };
        let Some(body) = game.world.bodies.get(tank.body) else {
            return;
        };

        let my_position = body.translation();
        let my_rotation = *body.rotation();
        let my_body_handle = tank.body;

        let target_position = match target {
            MoveTarget::Point(point) => Vector::new(point[0], point[1]),
            MoveTarget::Player(id) => {
                let Some(pos) = game.tank_position_rounded(id) else {
                    return;
                };
                let mut position = Vector::new(pos[0], pos[1]);

                if let Some(target_body) = game
                    .tanks
                    .get(&id)
                    .and_then(|t| game.world.bodies.get(t.body))
                {
                    // упреждение по скорости цели
                    position += target_body.linvel() * TARGET_PREDICTION_FACTOR;
                }

                position
            }
        };

        let direction_to_target = target_position - my_position;

        if direction_to_target.length_squared() < MIN_TARGET_DISTANCE * MIN_TARGET_DISTANCE {
            self.set_key_state(game, HeldKey::Forward, false);
            self.set_key_state(game, HeldKey::Left, false);
            self.set_key_state(game, HeldKey::Right, false);
            return;
        }

        let dir_norm = direction_to_target.normalize_or_zero();
        let final_direction = avoid_obstacles(game, my_body_handle, my_position, dir_norm);

        let forward_vec = my_rotation.transform_vector(FORWARD);
        let angle_to_target = forward_vec
            .perp_dot(final_direction)
            .atan2(forward_vec.dot(final_direction));
        let turn_threshold = 0.2;

        if angle_to_target > turn_threshold {
            self.set_key_state(game, HeldKey::Right, true);
            self.set_key_state(game, HeldKey::Left, false);
        } else if angle_to_target < -turn_threshold {
            self.set_key_state(game, HeldKey::Left, true);
            self.set_key_state(game, HeldKey::Right, false);
        } else {
            self.set_key_state(game, HeldKey::Left, false);
            self.set_key_state(game, HeldKey::Right, false);
        }

        if angle_to_target.abs() < PI / 1.5 {
            self.set_key_state(game, HeldKey::Forward, true);
        } else {
            self.set_key_state(game, HeldKey::Forward, false);
        }
    }

    /// Прицеливание и стрельба.
    fn execute_aim_and_shoot(&mut self, game: &mut BotView<'_>) {
        let target_alive = self.target.is_some_and(|t| game.tank_alive(t));

        if self.reposition_timer > 0.0 || self.state != BotState::Attacking || !target_alive {
            self.set_key_state(game, HeldKey::GunLeft, false);
            self.set_key_state(game, HeldKey::GunRight, false);
            return;
        }

        let target = self.target.unwrap();

        let Some(tank) = game.tanks.get(&self.game_id) else {
            return;
        };
        let Some(body) = game.world.bodies.get(tank.body) else {
            return;
        };

        let Some(target_pos) = game.tank_position_rounded(target) else {
            return;
        };

        let my_position = body.translation();
        let body_angle = body.rotation().angle();
        let gun_rotation = tank.gun_rotation;
        let current_weapon = tank.current_weapon;

        let visible = game
            .nav
            .as_ref()
            .is_some_and(|nav| !nav.has_obstacle_between([my_position.x, my_position.y], target_pos));

        if !visible {
            return;
        }

        let direction = Vector::new(target_pos[0], target_pos[1]) - my_position;
        let distance_sq = direction.length_squared();
        let should_use_bomb = distance_sq < BOMB_USAGE_DISTANCE * BOMB_USAGE_DISTANCE
            && self.bomb_cooldown_timer <= 0.0;

        // боты рассчитаны на пару w1 (hitscan) / w2 (бомба), как в JS-версии
        let w1 = game.weapon_index("w1");
        let w2 = game.weapon_index("w2");

        if should_use_bomb {
            if w2.is_some() && Some(current_weapon) != w2 {
                let bit = game.key_bits.next_weapon;

                self.press_one_shot(game, bit);
                return;
            }
        } else if w2.is_some() && Some(current_weapon) == w2 {
            let bit = game.key_bits.next_weapon;

            self.press_one_shot(game, bit);
            return;
        }

        let target_angle = direction.y.atan2(direction.x)
            + game.rng.range(-AIM_INACCURACY / 2.0, AIM_INACCURACY / 2.0);

        let current_gun_angle = body_angle + gun_rotation;
        let angle_difference = normalize_angle(target_angle - current_gun_angle);
        let aim_threshold = 0.05;

        if angle_difference > aim_threshold {
            self.set_key_state(game, HeldKey::GunRight, true);
            self.set_key_state(game, HeldKey::GunLeft, false);
        } else if angle_difference < -aim_threshold {
            self.set_key_state(game, HeldKey::GunLeft, true);
            self.set_key_state(game, HeldKey::GunRight, false);
        } else {
            self.set_key_state(game, HeldKey::GunLeft, false);
            self.set_key_state(game, HeldKey::GunRight, false);

            if self.firing_timer <= 0.0 {
                let has_ammo = |index: Option<usize>| {
                    index.is_some_and(|i| {
                        game.tanks
                            .get(&self.game_id)
                            .is_some_and(|t| t.ammo.get(i).copied().unwrap_or(0.0) >= 1.0)
                    })
                };

                if should_use_bomb && Some(current_weapon) == w2 && has_ammo(w2) {
                    let bit = game.key_bits.fire;

                    self.press_one_shot(game, bit);
                    self.bomb_cooldown_timer = BOMB_COOLDOWN;
                    self.reposition_timer = 2.0;
                    self.calculate_new_combat_position(game);
                } else if !should_use_bomb
                    && Some(current_weapon) == w1
                    && distance_sq < MAX_FIRING_DISTANCE * MAX_FIRING_DISTANCE
                {
                    self.firing_timer =
                        MIN_FIRING_DELAY + game.rng.next_f32() * RANDOM_FIRING_DELAY;

                    if has_ammo(w1) {
                        let bit = game.key_bits.fire;

                        self.press_one_shot(game, bit);
                        self.reposition_timer = 2.0;
                        self.calculate_new_combat_position(game);
                    }
                }
            }
        }
    }

    /// Бот застрял: выравнивает башню по корпусу и стреляет в препятствие.
    fn handle_clearing_obstacle(&mut self, game: &mut BotView<'_>) {
        self.release_all_keys(game);

        let Some((body_angle, gun_rotation)) = game.tanks.get(&self.game_id).and_then(|tank| {
            game.world
                .bodies
                .get(tank.body)
                .map(|body| (body.rotation().angle(), tank.gun_rotation))
        }) else {
            self.state = BotState::Idle;
            return;
        };

        let current_gun_angle = body_angle + gun_rotation;
        let angle_difference = normalize_angle(body_angle - current_gun_angle);
        let aim_threshold = 0.1;

        if angle_difference > aim_threshold {
            self.set_key_state(game, HeldKey::GunRight, true);
        } else if angle_difference < -aim_threshold {
            self.set_key_state(game, HeldKey::GunLeft, true);
        } else {
            self.set_key_state(game, HeldKey::GunLeft, false);
            self.set_key_state(game, HeldKey::GunRight, false);

            let bit = game.key_bits.fire;

            self.press_one_shot(game, bit);
            self.ai_update_timer = 0.5;
            self.state = BotState::Patrolling;
        }
    }

    /// Новая боевая позиция для стрейфа после выстрела.
    fn calculate_new_combat_position(&mut self, game: &mut BotView<'_>) {
        let Some(my) = self.my_position else {
            return;
        };

        let Some(rotation) = game
            .tanks
            .get(&self.game_id)
            .and_then(|tank| game.world.bodies.get(tank.body))
            .map(|body| *body.rotation())
        else {
            return;
        };

        let right_vec = rotation.transform_vector(RIGHT);
        let strafe_direction = if game.rng.next_f32() > 0.5 { 1.0 } else { -1.0 };
        let strafe_distance = game.rng.range(100.0, 200.0);

        let target = Vector::new(my[0], my[1]) + right_vec * (strafe_distance * strafe_direction);

        self.reposition_target = Some([target.x, target.y]);
    }
}

/// Локальное избегание препятствий тремя лучами; динамические объекты
/// карты игнорируются (бот их таранит).
fn avoid_obstacles(
    game: &BotView<'_>,
    my_body: RigidBodyHandle,
    my_position: Vector,
    desired_direction: Vector,
) -> Vector {
    let rays = [
        desired_direction,
        rotate(desired_direction, PI / 6.0),
        rotate(desired_direction, -PI / 6.0),
    ];

    let mut steer_correction = Vector::ZERO;
    let mut obstacles_detected = false;
    let dynamic_obstacle_in_path = Cell::new(false);

    let bodies = &game.world.bodies;
    let predicate = |_handle: ColliderHandle, collider: &Collider| {
        let tag = collider
            .parent()
            .and_then(|parent| bodies.get(parent))
            .and_then(|body| crate::physics::BodyTag::decode(body.user_data));

        if tag == Some(crate::physics::BodyTag::MapObject) {
            dynamic_obstacle_in_path.set(true);
            return false; // игнорирование, луч продолжается
        }

        true
    };

    for dir in rays {
        let ray_vector = dir * OBSTACLE_AVOIDANCE_RAY_LENGTH;
        let ray = Ray::new(my_position, ray_vector);

        let filter = QueryFilter::new()
            .exclude_sensors()
            .exclude_rigid_body(my_body)
            .predicate(&predicate);

        if game.world.cast_ray(&ray, 1.0, true, filter).is_some() {
            obstacles_detected = true;
            steer_correction -= ray_vector;
        }
    }

    // впереди только динамические объекты — курс не корректируется (таран)
    if dynamic_obstacle_in_path.get() && !obstacles_detected {
        return desired_direction;
    }

    if obstacles_detected {
        return (steer_correction + desired_direction).normalize_or_zero();
    }

    desired_direction
}
