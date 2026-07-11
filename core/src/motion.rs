//! Общие формулы движения танка — единый источник для авторитетного пути
//! (Tank::update: импульсы Rapier) и клиентской реплики предикта
//! (client::predictor: интеграция без коллизий, срез 2.6).
//!
//! Все функции mass-free: возвращают Δv/Δω/ускорение на единицу массы —
//! авторитетный путь домножает результат на массу/инерцию тела.

use crate::config::ModelConfig;
use crate::physics::{clamp, lerp};

/// Клавиши башни на тике.
#[derive(Clone, Copy)]
pub struct TurretInput {
    pub center: bool,
    pub left: bool,
    pub right: bool,
}

/// Шаг башни: центрирование либо ручной поворот.
/// Возвращает (gun_rotation, centering).
pub fn step_turret(
    gun_rotation: f32,
    centering: bool,
    input: TurretInput,
    model: &ModelConfig,
    dt: f32,
) -> (f32, bool) {
    let mut gun = gun_rotation;
    let mut centering = centering || input.center;

    if centering {
        gun = lerp(gun, 0.0, (model.gun_center_speed * dt).min(1.0));

        if gun.abs() < 0.01 {
            gun = 0.0;
            centering = false;
        }

        // ручной поворот во время центрирования отменяет центрирование
        if input.left || input.right {
            centering = false;
        }
    } else {
        let rotation_amount = model.gun_rotation_speed * dt;

        if input.left {
            gun = (gun - rotation_amount).max(-model.max_gun_angle);
        } else if input.right {
            gun = (gun + rotation_amount).min(model.max_gun_angle);
        }
    }

    (gun, centering)
}

/// Дроссель: плавный набор при газе, спад без газа.
pub fn step_throttle(throttle: f32, gas: bool, model: &ModelConfig, dt: f32) -> f32 {
    if gas {
        (throttle + model.throttle_increase_rate * dt).min(1.0)
    } else {
        (throttle - model.throttle_decrease_rate * dt).max(0.0)
    }
}

/// Δv против бокового скольжения (боковое сцепление).
pub fn lateral_dv(lateral_vel: f32, model: &ModelConfig, dt: f32) -> f32 {
    -lateral_vel * model.lateral_grip * dt
}

/// Ускорение вдоль корпуса: тяга от дросселя либо активное торможение
/// при отпущенном газе.
pub fn drive_accel(
    throttle: f32,
    forward: bool,
    back: bool,
    forward_speed: f32,
    model: &ModelConfig,
) -> f32 {
    let mut accel = 0.0;

    if throttle > 0.0 {
        if forward && forward_speed < model.max_forward_speed {
            accel = throttle * model.acceleration_factor;
        } else if back && forward_speed > model.max_reverse_speed {
            accel = -throttle * model.acceleration_factor;
        }
    }

    if accel == 0.0 && !forward && !back {
        accel = -forward_speed * model.braking_factor;
    }

    accel
}

/// Нагрузка двигателя (для звука): намерение + «напряжение».
pub fn engine_load(throttle: f32, forward_speed: f32, model: &ModelConfig) -> f32 {
    let strain = (throttle - speed_ratio(forward_speed, model)).max(0.0);

    clamp(throttle + strain * model.strain_factor, 0.0, 2.0)
}

/// Δω поворота корпуса с учётом порога скорости и заднего хода.
pub fn turn_delta(
    left: bool,
    right: bool,
    forward_speed: f32,
    model: &ModelConfig,
    dt: f32,
) -> f32 {
    let mut factor = 1.0;

    if forward_speed.abs() < model.turn_speed_threshold {
        factor = model.base_turn_factor_ratio;
    }

    if forward_speed < 0.0 {
        factor *= model.reverse_turn_multiplier;
    }

    let mut delta = 0.0;

    if left {
        delta = -model.base_turn_torque_factor * factor;
    }

    if right {
        delta = model.base_turn_torque_factor * factor;
    }

    delta * dt
}

/// Доля текущей скорости от максимальной (Tank._getSpeedRatio),
/// округление до 4 знаков (JS +speedRatio.toFixed(4)).
fn speed_ratio(forward_speed: f32, model: &ModelConfig) -> f32 {
    let ratio = if forward_speed > 0.0 {
        clamp(forward_speed / model.max_forward_speed, 0.0, 1.0)
    } else if forward_speed < 0.0 {
        clamp((forward_speed / model.max_reverse_speed).abs(), 0.0, 1.0)
    } else {
        0.0
    };

    ((ratio as f64 * 10000.0).round() / 10000.0) as f32
}
