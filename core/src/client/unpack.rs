//! Декодер бинарного кадра v3 — порт unpackFrame из src/lib/snapshotCodec.js
//! (срез 2.6). Раскладка зеркальна упаковке core/src/snapshot.rs (big-endian);
//! float снапшота восстанавливаются повторным округлением до 2 знаков
//! (round2), player-блок читается без округления (точность нужна предикту).

use indexmap::IndexMap;
use serde_json::{Map, Value, json};

use crate::bomb::BombRow;
use crate::config::{BlockKind, BlockSchema, FieldType, FieldValue, PLAYER_STATE_LEN, SnapshotConfig};
use crate::physics::round2;
use crate::snapshot::{TankRow, TracerRow};

const CAMERA_FLAG_HAS_CAMERA: u8 = 1;
const CAMERA_FLAG_FORCE_RESET: u8 = 2;
const CAMERA_FLAG_HAS_SHAKE: u8 = 4;
const CAMERA_FLAG_HAS_PLAYER: u8 = 8;

/// Камера кадра: [x, y, forceReset?, shake?] из JS-формы.
#[derive(Clone)]
pub struct DecodedCamera {
    pub x: f32,
    pub y: f32,
    pub force_reset: bool,
    pub shake: Option<String>,
}

/// Player-блок предикшена играющего (без округления).
#[derive(Clone)]
pub struct DecodedPlayer {
    pub game_id: u8,
    pub input_seq: u32,
    pub state: [f32; PLAYER_STATE_LEN],
    pub centering: bool,
}

/// Данные блока по kind (зеркало BLOCK_READERS snapshotCodec.js).
#[derive(Clone)]
pub enum BlockData {
    /// gameId → данные | None (null-маркер удаления)
    Tanks(IndexMap<u8, Option<TankRow>>),
    Tracers(Vec<TracerRow>),
    /// shotId → данные | None (null-маркер удаления)
    Bombs(IndexMap<u32, Option<BombRow>>),
    Explosions(Vec<[f32; 3]>),
    /// индекс динамического элемента → [x, y, angle]
    Dynamics(IndexMap<u8, [f32; 3]>),
}

/// Блок снапшота с ключом реестра opcodes.js.
#[derive(Clone)]
pub struct DecodedBlock {
    pub key: String,
    pub key_id: u8,
    pub data: BlockData,
}

/// Тело снапшота: блоки в порядке следования в кадре.
#[derive(Clone, Default)]
pub struct DecodedSnapshot {
    pub blocks: Vec<DecodedBlock>,
}

impl DecodedSnapshot {
    pub fn block_by_key(&self, key: &str) -> Option<&BlockData> {
        self.blocks
            .iter()
            .find(|block| block.key == key)
            .map(|block| &block.data)
    }
}

/// Распакованный кадр v3.
pub struct DecodedFrame {
    pub port: u8,
    pub seq: u32,
    pub server_time: f64,
    pub camera: Option<DecodedCamera>,
    pub player: Option<DecodedPlayer>,
    pub snapshot: DecodedSnapshot,
}

pub enum UnpackError {
    /// Версия формата кадра не совпадает — кадр отбрасывается.
    WrongVersion,
    /// Кадр обрывается посреди блока — повреждённые данные.
    Truncated,
}

/// Курсор чтения big-endian с проверкой границ.
struct Reader<'a> {
    data: &'a [u8],
    offset: usize,
}

impl<'a> Reader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, offset: 0 }
    }

    fn remaining(&self) -> usize {
        self.data.len() - self.offset
    }

    fn take(&mut self, len: usize) -> Result<&'a [u8], UnpackError> {
        if self.remaining() < len {
            return Err(UnpackError::Truncated);
        }

        let slice = &self.data[self.offset..self.offset + len];

        self.offset += len;
        Ok(slice)
    }

    fn u8(&mut self) -> Result<u8, UnpackError> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16, UnpackError> {
        Ok(u16::from_be_bytes(self.take(2)?.try_into().unwrap()))
    }

    fn u32(&mut self) -> Result<u32, UnpackError> {
        Ok(u32::from_be_bytes(self.take(4)?.try_into().unwrap()))
    }

    fn f32_raw(&mut self) -> Result<f32, UnpackError> {
        Ok(f32::from_be_bytes(self.take(4)?.try_into().unwrap()))
    }

    /// Float снапшота: восстановление round2-значения (readFloat из JS).
    fn f32_round2(&mut self) -> Result<f32, UnpackError> {
        Ok(round2(self.f32_raw()?))
    }

    fn f64(&mut self) -> Result<f64, UnpackError> {
        Ok(f64::from_be_bytes(self.take(8)?.try_into().unwrap()))
    }
}

/// Читает одно поле строки по типу схемы (интерпретатор `FieldSchema`,
/// зеркало `snapshot::write_field`). Float снапшота — с округлением
/// round2 (readFloat из JS-версии).
fn read_field(r: &mut Reader, ty: FieldType) -> Result<FieldValue, UnpackError> {
    Ok(match ty {
        FieldType::F32 => FieldValue::F32(r.f32_round2()?),
        FieldType::U8 => FieldValue::U8(r.u8()?),
        FieldType::U16 => FieldValue::U16(r.u16()?),
        FieldType::U32 => FieldValue::U32(r.u32()?),
    })
}

/// Распаковывает бинарный кадр (порт unpackFrame).
pub fn unpack_frame(data: &[u8], cfg: &SnapshotConfig) -> Result<DecodedFrame, UnpackError> {
    let mut r = Reader::new(data);

    let port = r.u8()?;
    let version = r.u8()?;

    if version != cfg.version {
        return Err(UnpackError::WrongVersion);
    }

    let seq = r.u32()?;
    let server_time = r.f64()?;
    let flags = r.u8()?;

    let mut camera = None;

    if flags & CAMERA_FLAG_HAS_CAMERA != 0 {
        let x = r.f32_round2()?;
        let y = r.f32_round2()?;
        let force_reset = flags & CAMERA_FLAG_FORCE_RESET != 0;

        let shake = if flags & CAMERA_FLAG_HAS_SHAKE != 0 {
            let len = r.u8()? as usize;
            let bytes = r.take(len)?;

            Some(String::from_utf8_lossy(bytes).into_owned())
        } else {
            None
        };

        camera = Some(DecodedCamera {
            x,
            y,
            force_reset,
            shake,
        });
    }

    let mut player = None;

    if flags & CAMERA_FLAG_HAS_PLAYER != 0 {
        let game_id = r.u8()?;
        let input_seq = r.u32()?;
        let mut state = [0.0f32; PLAYER_STATE_LEN];

        for value in &mut state {
            *value = r.f32_raw()?; // без округления (предикшен)
        }

        let centering = r.u8()? == 1;

        player = Some(DecodedPlayer {
            game_id,
            input_seq,
            state,
            centering,
        });
    }

    let mut snapshot = DecodedSnapshot::default();

    while r.remaining() > 0 {
        let key_id = r.u8()?;

        // неизвестный id блока — остаток кадра отбрасывается (как в JS)
        let Some((key, info)) = cfg.keys.iter().find(|(_, info)| info.id == key_id) else {
            break;
        };

        let data = match info.kind {
            BlockKind::Tanks => read_tanks(&mut r, info)?,
            BlockKind::Tracers => read_tracers(&mut r, info)?,
            BlockKind::Bombs => read_bombs(&mut r, info)?,
            BlockKind::Explosions => read_explosions(&mut r, info)?,
            BlockKind::Dynamics => read_dynamics(&mut r, info)?,
        };

        snapshot.blocks.push(DecodedBlock {
            key: key.clone(),
            key_id,
            data,
        });
    }

    Ok(DecodedFrame {
        port,
        seq,
        server_time,
        camera,
        player,
        snapshot,
    })
}

fn read_tanks(r: &mut Reader, schema: &BlockSchema) -> Result<BlockData, UnpackError> {
    let count = r.u8()?;
    let mut result = IndexMap::new();

    for _ in 0..count {
        let id = r.u8()?;

        if r.u8()? == 0 {
            result.insert(id, None);
            continue;
        }

        let mut floats = [0.0f32; 7];
        let mut condition = 0u8;
        let mut size = 0u8;
        let mut team = 0u8;

        for (i, field) in schema.fields.iter().enumerate() {
            match (i, read_field(r, field.ty)?) {
                (0..=6, FieldValue::F32(v)) => floats[i] = v,
                (7, FieldValue::U8(v)) => condition = v,
                (8, FieldValue::U8(v)) => size = v,
                (9, FieldValue::U8(v)) => team = v,
                _ => {}
            }
        }

        result.insert(
            id,
            Some(TankRow {
                floats,
                condition,
                size,
                team,
            }),
        );
    }

    Ok(BlockData::Tanks(result))
}

fn read_tracers(r: &mut Reader, schema: &BlockSchema) -> Result<BlockData, UnpackError> {
    let count = r.u16()?;
    let mut result = Vec::with_capacity(count as usize);

    for _ in 0..count {
        let mut floats = [0.0f32; 6];
        let mut was_hit = false;
        let mut shooter = 0u8;

        for (i, field) in schema.fields.iter().enumerate() {
            match (i, read_field(r, field.ty)?) {
                (0..=5, FieldValue::F32(v)) => floats[i] = v,
                (6, FieldValue::U8(v)) => was_hit = v == 1,
                (7, FieldValue::U8(v)) => shooter = v,
                _ => {}
            }
        }

        result.push(TracerRow {
            floats,
            was_hit,
            shooter,
        });
    }

    Ok(BlockData::Tracers(result))
}

fn read_bombs(r: &mut Reader, schema: &BlockSchema) -> Result<BlockData, UnpackError> {
    let count = r.u16()?;
    let mut result = IndexMap::new();

    for _ in 0..count {
        let id = r.u32()?;

        if r.u8()? == 0 {
            result.insert(id, None);
            continue;
        }

        let mut x = 0.0f32;
        let mut y = 0.0f32;
        let mut angle = 0.0f32;
        let mut size = 0u8;
        let mut time = 0u16;
        let mut owner = 0u8;

        for (i, field) in schema.fields.iter().enumerate() {
            match (i, read_field(r, field.ty)?) {
                (0, FieldValue::F32(v)) => x = v,
                (1, FieldValue::F32(v)) => y = v,
                (2, FieldValue::F32(v)) => angle = v,
                (3, FieldValue::U8(v)) => size = v,
                (4, FieldValue::U16(v)) => time = v,
                (5, FieldValue::U8(v)) => owner = v,
                _ => {}
            }
        }

        result.insert(
            id,
            Some(BombRow {
                x,
                y,
                angle,
                size,
                time,
                owner,
            }),
        );
    }

    Ok(BlockData::Bombs(result))
}

fn read_explosions(r: &mut Reader, schema: &BlockSchema) -> Result<BlockData, UnpackError> {
    let count = r.u16()?;
    let mut result = Vec::with_capacity(count as usize);

    for _ in 0..count {
        let mut values = [0.0f32; 3];

        for (i, field) in schema.fields.iter().enumerate() {
            match (i, read_field(r, field.ty)?) {
                (0..=2, FieldValue::F32(v)) => values[i] = v,
                _ => {}
            }
        }

        result.push(values);
    }

    Ok(BlockData::Explosions(result))
}

fn read_dynamics(r: &mut Reader, schema: &BlockSchema) -> Result<BlockData, UnpackError> {
    let count = r.u8()?;
    let mut result = IndexMap::new();

    for _ in 0..count {
        let index = r.u8()?;
        let mut values = [0.0f32; 3];

        for (i, field) in schema.fields.iter().enumerate() {
            match (i, read_field(r, field.ty)?) {
                (0..=2, FieldValue::F32(v)) => values[i] = v,
                _ => {}
            }
        }

        result.insert(index, values);
    }

    Ok(BlockData::Dynamics(result))
}

// ***** JSON-сериализация (формы, идентичные unpackFrame) ***** //

/// round2-значение f32 → точный двухзначный f64 для JSON
/// (JS readFloat возвращал round(f32·100)/100 в f64).
pub fn round2_f64(v: f32) -> f64 {
    ((v as f64) * 100.0).round() / 100.0
}

/// u32 → base36 (ключи бомб; JS id.toString(36)).
pub fn to_base36(mut v: u32) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";

    if v == 0 {
        return "0".to_string();
    }

    let mut out = Vec::new();

    while v > 0 {
        out.push(DIGITS[(v % 36) as usize]);
        v /= 36;
    }

    out.reverse();
    String::from_utf8(out).unwrap()
}

/// Камера в JS-форму: 0 | [x, y] | [x, y, true] | [x, y, ..., shake].
pub fn camera_to_json(camera: Option<&DecodedCamera>) -> Value {
    let Some(camera) = camera else {
        return json!(0);
    };

    let mut arr = vec![
        Value::from(round2_f64(camera.x)),
        Value::from(round2_f64(camera.y)),
    ];

    if camera.force_reset {
        arr.push(Value::from(true));
    }

    if let Some(shake) = &camera.shake {
        // shake живёт в camera[3]; без forceReset слот [2] — null (как в JS)
        while arr.len() < 3 {
            arr.push(Value::Null);
        }

        arr.push(Value::from(shake.clone()));
    }

    Value::Array(arr)
}

fn tank_row_to_json(row: &TankRow) -> Value {
    let mut arr: Vec<Value> = row.floats.iter().map(|v| Value::from(round2_f64(*v))).collect();

    arr.push(Value::from(row.condition));
    arr.push(Value::from(row.size));
    arr.push(Value::from(row.team));
    Value::Array(arr)
}

fn tracer_row_to_json(row: &TracerRow) -> Value {
    let mut arr: Vec<Value> = row.floats.iter().map(|v| Value::from(round2_f64(*v))).collect();

    arr.push(Value::from(row.was_hit));
    arr.push(Value::from(row.shooter));
    Value::Array(arr)
}

fn bomb_row_to_json(row: &BombRow) -> Value {
    json!([
        round2_f64(row.x),
        round2_f64(row.y),
        round2_f64(row.angle),
        row.size,
        row.time,
        row.owner,
    ])
}

/// Тело снапшота в JS-форму { ключ: данные } для parse-конвейера клиента.
pub fn snapshot_to_json(snapshot: &DecodedSnapshot) -> Map<String, Value> {
    let mut result = Map::new();

    for block in &snapshot.blocks {
        let value = match &block.data {
            BlockData::Tanks(items) => {
                let mut map = Map::new();

                for (id, row) in items {
                    map.insert(
                        id.to_string(),
                        row.as_ref().map_or(Value::Null, tank_row_to_json),
                    );
                }

                Value::Object(map)
            }
            BlockData::Tracers(items) => {
                Value::Array(items.iter().map(tracer_row_to_json).collect())
            }
            BlockData::Bombs(items) => {
                let mut map = Map::new();

                for (id, row) in items {
                    map.insert(
                        to_base36(*id),
                        row.as_ref().map_or(Value::Null, bomb_row_to_json),
                    );
                }

                Value::Object(map)
            }
            BlockData::Explosions(items) => json!(
                items
                    .iter()
                    .map(|[x, y, r]| json!([round2_f64(*x), round2_f64(*y), round2_f64(*r)]))
                    .collect::<Vec<Value>>()
            ),
            BlockData::Dynamics(items) => {
                let mut map = Map::new();

                for (index, [x, y, angle]) in items {
                    map.insert(
                        format!("d{index}"),
                        json!([round2_f64(*x), round2_f64(*y), round2_f64(*angle)]),
                    );
                }

                Value::Object(map)
            }
        };

        result.insert(block.key.clone(), value);
    }

    result
}

/// Полный кадр в JSON-форму unpackFrame — для тестов и харнесса
/// (ClientCore.decode_frame): { port, seq, serverTime, camera, player, snapshot }.
pub fn frame_to_json(frame: &DecodedFrame) -> Value {
    let player = frame.player.as_ref().map_or(Value::Null, |p| {
        json!({
            "gameId": p.game_id,
            "inputSeq": p.input_seq,
            // без округления: f64-расширение Float32 (как getFloat32 в JS)
            "state": p.state.iter().map(|v| *v as f64).collect::<Vec<f64>>(),
            "centering": p.centering,
        })
    });

    json!({
        "port": frame.port,
        "seq": frame.seq,
        "serverTime": frame.server_time,
        "camera": camera_to_json(frame.camera.as_ref()),
        "player": player,
        "snapshot": Value::Object(snapshot_to_json(&frame.snapshot)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::test_support::full_snapshot_config;
    use crate::snapshot::{Block, CameraData, PlayerBlock, SnapshotPacker};

    // round-trip против упаковщика того же crate: раскладка не может
    // разойтись между pack и unpack по построению, тесты фиксируют формы
    fn test_config() -> SnapshotConfig {
        full_snapshot_config(3, 5)
    }

    fn packed_frame(
        blocks: &[(String, Block)],
        camera: Option<&CameraData>,
        player: Option<&PlayerBlock>,
    ) -> Vec<u8> {
        let mut packer = SnapshotPacker::new(test_config());

        packer.pack_body(blocks).unwrap();
        packer.pack_frame(1234.5, 42, camera, player).to_vec()
    }

    #[test]
    fn full_frame_round_trip() {
        let blocks = vec![
            (
                "m1".to_string(),
                Block::Tanks(vec![
                    (
                        2,
                        Some(TankRow {
                            floats: [10.567, -3.141, 1.5, 0.25, 100.0, -50.5, 1.2],
                            condition: 3,
                            size: 2,
                            team: 1,
                        }),
                    ),
                    (3, None),
                ]),
            ),
            (
                "w1".to_string(),
                Block::Tracers(vec![TracerRow {
                    floats: [1.0, 2.0, 3.0, 4.0, 5.0, 6.0],
                    was_hit: true,
                    shooter: 7,
                }]),
            ),
            (
                "w2".to_string(),
                Block::Bombs(vec![
                    (
                        // 'a1f' в base36
                        u32::from_str_radix("a1f", 36).unwrap(),
                        Some(BombRow {
                            x: 5.5,
                            y: 6.5,
                            angle: 0.0,
                            size: 8,
                            time: 300,
                            owner: 2,
                        }),
                    ),
                    (1, None),
                ]),
            ),
            (
                "w2e".to_string(),
                Block::Explosions(vec![[100.0, 200.0, 50.0]]),
            ),
            (
                "c1".to_string(),
                Block::Dynamics(vec![(0, [10.0, 20.0, 0.5])]),
            ),
        ];

        let camera = CameraData {
            x: 10.5,
            y: -3.25,
            force_reset: true,
            shake: Some("20:200".to_string()),
        };
        let player = PlayerBlock {
            game_id: 2,
            input_seq: 77,
            state: [10.56789, 2.0, 0.5, 3.0, 4.0, 0.1, 0.2, 0.7],
            centering: true,
        };

        let data = packed_frame(&blocks, Some(&camera), Some(&player));
        let frame = unpack_frame(&data, &test_config()).ok().unwrap();

        assert_eq!(frame.port, 5);
        assert_eq!(frame.seq, 42);
        assert_eq!(frame.server_time, 1234.5);

        // камера: координаты round2, флаги
        let cam = frame.camera.as_ref().unwrap();

        assert_eq!(cam.x, 10.5);
        assert_eq!(cam.y, -3.25);
        assert!(cam.force_reset);
        assert_eq!(cam.shake.as_deref(), Some("20:200"));

        // player-блок: без округления (точное f32-значение)
        let p = frame.player.as_ref().unwrap();

        assert_eq!(p.game_id, 2);
        assert_eq!(p.input_seq, 77);
        assert_eq!(p.state[0], 10.56789f32);
        assert!(p.centering);

        // танки: float снапшота восстановлены округлением до 2 знаков
        let Some(BlockData::Tanks(tanks)) = frame.snapshot.block_by_key("m1") else {
            panic!("нет блока m1");
        };
        let row = tanks[&2].as_ref().unwrap();

        assert_eq!(row.floats[0], 10.57);
        assert_eq!(row.floats[1], -3.14);
        assert_eq!((row.condition, row.size, row.team), (3, 2, 1));
        assert!(tanks[&3].is_none()); // null-маркер

        let Some(BlockData::Tracers(tracers)) = frame.snapshot.block_by_key("w1") else {
            panic!("нет блока w1");
        };

        assert!(tracers[0].was_hit);
        assert_eq!(tracers[0].shooter, 7);

        let Some(BlockData::Bombs(bombs)) = frame.snapshot.block_by_key("w2") else {
            panic!("нет блока w2");
        };
        let bomb = bombs[&u32::from_str_radix("a1f", 36).unwrap()]
            .as_ref()
            .unwrap();

        assert_eq!((bomb.size, bomb.time, bomb.owner), (8, 300, 2));
        assert!(bombs[&1].is_none());

        let Some(BlockData::Explosions(explosions)) = frame.snapshot.block_by_key("w2e") else {
            panic!("нет блока w2e");
        };

        assert_eq!(explosions[0], [100.0, 200.0, 50.0]);

        let Some(BlockData::Dynamics(dynamics)) = frame.snapshot.block_by_key("c1") else {
            panic!("нет блока c1");
        };

        assert_eq!(dynamics[&0], [10.0, 20.0, 0.5]);
    }

    #[test]
    fn wrong_version_is_rejected() {
        let mut data = packed_frame(&[], None, None);

        data[1] = 99;
        assert!(matches!(
            unpack_frame(&data, &test_config()),
            Err(UnpackError::WrongVersion)
        ));
    }

    #[test]
    fn truncated_frame_is_error() {
        let data = packed_frame(
            &[(
                "m1".to_string(),
                Block::Tanks(vec![(
                    1,
                    Some(TankRow {
                        floats: [0.0; 7],
                        condition: 3,
                        size: 2,
                        team: 1,
                    }),
                )]),
            )],
            None,
            None,
        );

        assert!(matches!(
            unpack_frame(&data[..data.len() - 4], &test_config()),
            Err(UnpackError::Truncated)
        ));
    }

    #[test]
    fn unknown_block_id_drops_rest() {
        let mut data = packed_frame(
            &[(
                "w2e".to_string(),
                Block::Explosions(vec![[1.0, 2.0, 3.0]]),
            )],
            None,
            None,
        );

        // подмена id блока на незарегистрированный
        data[15] = 200;

        let frame = unpack_frame(&data, &test_config()).ok().unwrap();

        assert!(frame.snapshot.blocks.is_empty());
    }

    #[test]
    fn base36_matches_js() {
        assert_eq!(to_base36(0), "0");
        assert_eq!(to_base36(35), "z");
        assert_eq!(to_base36(u32::from_str_radix("a1f", 36).unwrap()), "a1f");
    }

    #[test]
    fn camera_json_forms() {
        assert_eq!(camera_to_json(None), json!(0));

        let plain = DecodedCamera {
            x: 1.5,
            y: 2.5,
            force_reset: false,
            shake: None,
        };

        assert_eq!(camera_to_json(Some(&plain)), json!([1.5, 2.5]));

        let reset = DecodedCamera {
            force_reset: true,
            ..plain.clone()
        };

        assert_eq!(camera_to_json(Some(&reset)), json!([1.5, 2.5, true]));

        // shake без reset: слот [2] — null (как в JS-массиве с «дыркой»)
        let shake = DecodedCamera {
            shake: Some("20:200".to_string()),
            ..plain
        };

        assert_eq!(
            camera_to_json(Some(&shake)),
            json!([1.5, 2.5, null, "20:200"])
        );
    }

    #[test]
    fn snapshot_json_matches_unpack_frame_forms() {
        let blocks = vec![
            (
                "m1".to_string(),
                Block::Tanks(vec![
                    (
                        2,
                        Some(TankRow {
                            floats: [51.28, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0],
                            condition: 3,
                            size: 2,
                            team: 1,
                        }),
                    ),
                    (3, None),
                ]),
            ),
            (
                "w2".to_string(),
                Block::Bombs(vec![(
                    u32::from_str_radix("a1f", 36).unwrap(),
                    Some(BombRow {
                        x: 1.0,
                        y: 2.0,
                        angle: 0.0,
                        size: 8,
                        time: 300,
                        owner: 2,
                    }),
                )]),
            ),
        ];
        let data = packed_frame(&blocks, None, None);
        let frame = unpack_frame(&data, &test_config()).ok().unwrap();
        let game = Value::Object(snapshot_to_json(&frame.snapshot));

        // round2-значения сериализуются точными двухзначными числами
        assert_eq!(
            game,
            json!({
                "m1": { "2": [51.28, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 3, 2, 1], "3": null },
                "w2": { "a1f": [1.0, 2.0, 0.0, 8, 300, 2] },
            })
        );
    }
}
