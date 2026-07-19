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
/// Определяет "форму" блока (ширина count/id, наличие null-маркера) —
/// раскладка ПОЛЕЙ внутри строки описывается отдельно схемой `fields`
/// (см. `BlockSchema`), а не зашита в Rust по каждому kind.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BlockKind {
    Tanks,
    Tracers,
    Bombs,
    Explosions,
    Dynamics,
}

impl BlockKind {
    /// Ожидаемая раскладка полей строки для этого kind — фиксированный
    /// контракт против Row-структур (`core/src/snapshot.rs`). Схема,
    /// приходящая из JSON-конфига (opcodes.js/игровой плагин), обязана
    /// совпадать по количеству и порядку типов полей — иначе `pack`/`unpack`
    /// либо тихо портят кадр (debug_assert выключен в release-WASM), либо
    /// паникуют (Explosions/Dynamics при лишних полях). См. `SnapshotConfig::validate`.
    fn expected_fields(self) -> &'static [FieldType] {
        use FieldType::{F32, U8, U16};

        match self {
            BlockKind::Tanks => &[F32, F32, F32, F32, F32, F32, F32, U8, U8, U8],
            BlockKind::Tracers => &[F32, F32, F32, F32, F32, F32, U8, U8],
            BlockKind::Bombs => &[F32, F32, F32, U8, U16, U8],
            BlockKind::Explosions => &[F32, F32, F32],
            BlockKind::Dynamics => &[F32, F32, F32],
        }
    }
}

/// Бинарный тип поля строки блока.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FieldType {
    F32,
    U8,
    U16,
    U32,
}

/// Способ интерполяции поля на клиенте между кадрами A/B
/// (применяется только к блокам класса `Hot` — см. `BlockClass`).
#[derive(Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Interp {
    Lerp,
    LerpAngle,
    Discrete,
}

/// Описание одного поля строки блока — порядок в векторе равен порядку
/// байтов в раскладке (и порядку полей в конкретной Row-структуре
/// core/src/snapshot.rs — молчаливый контракт, проверяемый тестами).
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldSchema {
    pub name: String,
    pub ty: FieldType,
    #[serde(default = "default_interp")]
    pub interp: Interp,
}

fn default_interp() -> Interp {
    Interp::Discrete
}

/// Значение поля строки во время упаковки/распаковки (рантайм-парность
/// `FieldType`).
#[derive(Clone, Copy)]
pub enum FieldValue {
    F32(f32),
    U8(u8),
    U16(u16),
    U32(u32),
}

/// Класс блока: «горячий» — интерполируется клиентом между кадрами
/// (танки, динамика карты), «событийный» — одноразовый, кадром как есть
/// (трассеры/бомбы/взрывы).
#[derive(Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BlockClass {
    Hot,
    Event,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockSchema {
    pub id: u8,
    pub kind: BlockKind,
    pub class: BlockClass,
    #[serde(default)]
    pub fields: Vec<FieldSchema>,
}

/// Длина player-блока предикшена (predicted player state), см.
/// `Tank::prediction_state`. Единая константа вместо 4 независимых
/// литералов `8` (snapshot.rs/unpack.rs/tank.rs/predictor.rs).
pub const PLAYER_STATE_LEN: usize = 8;

/// Реестр снапшот-ключей и версия формата (src/config/opcodes.js).
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotConfig {
    pub version: u8,
    /// Номер порта SHOT_DATA (первый байт кадра).
    pub port: u8,
    pub keys: IndexMap<String, BlockSchema>,
}

impl SnapshotConfig {
    /// Валидирует `fields` каждого ключа против фиксированного контракта
    /// `BlockKind::expected_fields` (количество и порядок типов). Должна
    /// вызываться на границе конструирования (`GameCore::new`/`ClientCore::new`) —
    /// единственная защита от расхождения JSON-схемы и Row-структур ядра.
    pub fn validate(&self) -> Result<(), String> {
        for (key, schema) in &self.keys {
            let expected = schema.kind.expected_fields();

            if schema.fields.len() != expected.len() {
                return Err(format!(
                    "[core snapshot] Ключ '{key}' (kind={:?}): схема задаёт {} полей, ожидается {}",
                    schema.kind,
                    schema.fields.len(),
                    expected.len()
                ));
            }

            for (i, (field, exp_ty)) in schema.fields.iter().zip(expected).enumerate() {
                if field.ty != *exp_ty {
                    return Err(format!(
                        "[core snapshot] Ключ '{key}' (kind={:?}): поле {i} '{}' имеет тип {:?}, ожидается {:?}",
                        schema.kind, field.name, field.ty, exp_ty
                    ));
                }
            }
        }

        Ok(())
    }
}

/// Настройки snapshot-интерполяции (src/config/client.js interpolation).
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InterpolationConfig {
    /// Задержка рендера в прошлом (мс).
    pub delay: f64,
    /// Максимальный возраст кадра в буфере (мс).
    pub max_frame_age: f64,
}

/// Конфигурация клиентского ядра (ClientCore, срез 2.6): собирается на
/// клиенте из prediction/interpolation-данных CONFIG_DATA + бандловых
/// opcodes/wsports (src/lib/clientCoreConfig.js).
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientConfig {
    /// Шаг симуляции предикта (миллисекунды, как в клиентском конфиге;
    /// имя поля фиксирует единицы — CoreConfig.timeStep задаётся в секундах).
    pub time_step_ms: f64,
    pub models: IndexMap<String, ModelConfig>,
    pub weapons: IndexMap<String, WeaponConfig>,
    pub player_keys: IndexMap<String, KeyConfig>,
    pub snapshot: SnapshotConfig,
    pub interpolation: InterpolationConfig,
    /// Сид PRNG разброса локальных трассеров (не синхронизирован с хостом —
    /// авторитетный трассер приходит кадром).
    #[serde(default = "default_seed")]
    pub seed: u64,
}

/// Канонические схемы 5 сегодняшних kind — общий тестовый фикстур для
/// snapshot.rs/unpack.rs/interpolator.rs/client/mod.rs (единый source of
/// truth вместо копипаста SnapshotConfig в каждом test-модуле).
#[cfg(test)]
pub mod test_support {
    use super::*;

    fn field(name: &str, ty: FieldType) -> FieldSchema {
        FieldSchema {
            name: name.to_string(),
            ty,
            interp: Interp::Discrete,
        }
    }

    fn field_interp(name: &str, ty: FieldType, interp: Interp) -> FieldSchema {
        FieldSchema {
            name: name.to_string(),
            ty,
            interp,
        }
    }

    pub fn tanks_schema(id: u8) -> BlockSchema {
        BlockSchema {
            id,
            kind: BlockKind::Tanks,
            class: BlockClass::Hot,
            fields: vec![
                field_interp("x", FieldType::F32, Interp::Lerp),
                field_interp("y", FieldType::F32, Interp::Lerp),
                field_interp("angle", FieldType::F32, Interp::LerpAngle),
                field_interp("gunRotation", FieldType::F32, Interp::LerpAngle),
                field_interp("vx", FieldType::F32, Interp::Lerp),
                field_interp("vy", FieldType::F32, Interp::Lerp),
                field_interp("engineLoad", FieldType::F32, Interp::Lerp),
                field("condition", FieldType::U8),
                field("size", FieldType::U8),
                field("team", FieldType::U8),
            ],
        }
    }

    pub fn tracers_schema(id: u8) -> BlockSchema {
        BlockSchema {
            id,
            kind: BlockKind::Tracers,
            class: BlockClass::Event,
            fields: vec![
                field("startX", FieldType::F32),
                field("startY", FieldType::F32),
                field("endX", FieldType::F32),
                field("endY", FieldType::F32),
                field("bodyX", FieldType::F32),
                field("bodyY", FieldType::F32),
                field("wasHit", FieldType::U8),
                field("shooterId", FieldType::U8),
            ],
        }
    }

    pub fn bombs_schema(id: u8) -> BlockSchema {
        BlockSchema {
            id,
            kind: BlockKind::Bombs,
            class: BlockClass::Event,
            fields: vec![
                field("x", FieldType::F32),
                field("y", FieldType::F32),
                field("angle", FieldType::F32),
                field("size", FieldType::U8),
                field("time", FieldType::U16),
                field("ownerId", FieldType::U8),
            ],
        }
    }

    pub fn explosions_schema(id: u8) -> BlockSchema {
        BlockSchema {
            id,
            kind: BlockKind::Explosions,
            class: BlockClass::Event,
            fields: vec![
                field("x", FieldType::F32),
                field("y", FieldType::F32),
                field("radius", FieldType::F32),
            ],
        }
    }

    pub fn dynamics_schema(id: u8) -> BlockSchema {
        BlockSchema {
            id,
            kind: BlockKind::Dynamics,
            class: BlockClass::Hot,
            fields: vec![
                field_interp("x", FieldType::F32, Interp::Lerp),
                field_interp("y", FieldType::F32, Interp::Lerp),
                field_interp("angle", FieldType::F32, Interp::LerpAngle),
            ],
        }
    }

    /// Реестр из 5 ключей — 5 из 6 канонических ключей opcodes.js
    /// (без `c2`, второго динамического слоя с идентичной `c1` схемой).
    pub fn full_snapshot_config(version: u8, port: u8) -> SnapshotConfig {
        let mut keys = IndexMap::new();

        keys.insert("m1".to_string(), tanks_schema(1));
        keys.insert("w1".to_string(), tracers_schema(2));
        keys.insert("w2".to_string(), bombs_schema(3));
        keys.insert("w2e".to_string(), explosions_schema(4));
        keys.insert("c1".to_string(), dynamics_schema(5));

        SnapshotConfig {
            version,
            port,
            keys,
        }
    }
}

#[cfg(test)]
mod validate_tests {
    use super::test_support::full_snapshot_config;
    use super::*;

    #[test]
    fn valid_schema_passes() {
        assert!(full_snapshot_config(3, 5).validate().is_ok());
    }

    #[test]
    fn wrong_field_count_fails() {
        let mut cfg = full_snapshot_config(3, 5);

        cfg.keys.get_mut("m1").unwrap().fields.pop();

        let err = cfg.validate().unwrap_err();
        assert!(err.contains("m1"));
    }

    #[test]
    fn wrong_field_type_fails() {
        let mut cfg = full_snapshot_config(3, 5);

        cfg.keys.get_mut("w2").unwrap().fields[4].ty = FieldType::U8; // ожидается U16 (time)

        let err = cfg.validate().unwrap_err();
        assert!(err.contains("w2"));
    }
}
