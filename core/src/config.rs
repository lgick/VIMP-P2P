use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

/// Конфигурация ядра, передаваемая из JS одним JSON при init
/// (см. docs/core.md): куски src/config/game.js + src/data/models.js +
/// src/data/weapons.js + реестр снапшот-ключей из src/config/opcodes.js.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreConfig {
    /// Интервал фиксированного шага физики (секунды, напр. 1/120).
    pub time_step: f32,
    #[serde(default)]
    pub friendly_fire: bool,
    /// Масштаб карты по умолчанию (перекрывается scale самой карты).
    #[serde(default = "default_map_scale")]
    pub map_scale: f32,
    /// Дефолтный setId конструктора карт (game.js mapSetId).
    #[serde(default = "default_map_set_id")]
    pub map_set_id: String,
    pub models: IndexMap<String, ModelConfig>,
    pub weapons: IndexMap<String, WeaponConfig>,
    pub player_keys: IndexMap<String, KeyConfig>,
    /// Стартовые значения панели: health + боезапас по оружию (game.js panel).
    pub panel: IndexMap<String, PanelValue>,
    pub snapshot: SnapshotConfig,
    /// Сид PRNG ботов/разброса (детерминизм воспроизводим при равном сиде).
    #[serde(default = "default_seed")]
    pub seed: u64,
}

fn default_map_scale() -> f32 {
    1.0
}

fn default_map_set_id() -> String {
    "c1".to_string()
}

fn default_seed() -> u64 {
    0x5644_4d49_5056_494d // произвольная константа
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyConfig {
    pub key: u32,
    /// 0 — удерживаемая, 1 — одноразовая (one-shot) клавиша.
    #[serde(default, rename = "type")]
    pub kind: u8,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelValue {
    pub value: f64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Damping {
    pub linear: f32,
    pub angular: f32,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fixture {
    pub density: f32,
    pub friction: f32,
    pub restitution: f32,
}

/// Параметры модели танка (src/data/models.js, поле constructor игнорируется).
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelConfig {
    pub current_weapon: String,
    pub size: f32,
    pub acceleration_factor: f32,
    pub braking_factor: f32,
    pub max_forward_speed: f32,
    pub max_reverse_speed: f32,
    pub base_turn_torque_factor: f32,
    pub damping: Damping,
    pub fixture: Fixture,
    pub lateral_grip: f32,
    pub turn_speed_threshold: f32,
    pub base_turn_factor_ratio: f32,
    pub reverse_turn_multiplier: f32,
    pub throttle_increase_rate: f32,
    pub throttle_decrease_rate: f32,
    pub strain_factor: f32,
    pub max_gun_angle: f32,
    pub gun_rotation_speed: f32,
    pub gun_center_speed: f32,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraShake {
    pub intensity: f64,
    pub duration: f64,
}

/// Тип оружия — определяет серверную механику выстрела.
#[derive(Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WeaponKind {
    Hitscan,
    Explosive,
}

/// Параметры оружия (src/data/weapons.js, поле constructor игнорируется).
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WeaponConfig {
    #[serde(rename = "type")]
    pub kind: WeaponKind,
    #[serde(default)]
    pub impulse_magnitude: f32,
    #[serde(default)]
    pub damage: f64,
    /// Дальность hitscan-луча (юниты).
    #[serde(default)]
    pub range: Option<f32>,
    /// Кулдаун между выстрелами (секунды).
    #[serde(default)]
    pub fire_rate: f32,
    /// Разброс в радианах.
    #[serde(default)]
    pub spread: f32,
    /// Расход патронов за выстрел (по умолчанию 1).
    #[serde(default)]
    pub consumption: Option<f64>,
    #[serde(default)]
    pub camera_shake: Option<CameraShake>,
    /// Время жизни снаряда (ms, explosive).
    #[serde(default)]
    pub time: f32,
    /// Id эффекта детонации (например 'w2e').
    #[serde(default)]
    pub shot_outcome_id: Option<String>,
    /// Размер снаряда (сторона квадрата).
    #[serde(default)]
    pub size: f32,
    /// Радиус взрыва.
    #[serde(default)]
    pub radius: f32,
}

/// Раскладка блока в бинарном снапшоте (kind из src/config/opcodes.js).
#[derive(Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BlockKind {
    Tanks,
    Tracers,
    Bombs,
    Explosions,
    Dynamics,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotKeyInfo {
    pub id: u8,
    pub kind: BlockKind,
}

/// Реестр снапшот-ключей и версия формата (src/config/opcodes.js).
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotConfig {
    pub version: u8,
    /// Номер порта SHOT_DATA (первый байт кадра).
    pub port: u8,
    pub keys: IndexMap<String, SnapshotKeyInfo>,
}
