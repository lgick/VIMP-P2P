use rapier2d::prelude::*;
use serde::{Deserialize, Serialize};

use crate::config::{FieldValue, WeaponConfig};
use crate::physics::{BodyTag, round2};

/// Взрывной снаряд (порт src/server/parts/Bomb.js).
/// Логика детонации — в game.rs (ей нужен доступ к урону и событиям).
#[derive(Serialize, Deserialize)]
pub struct Bomb {
    pub shot_id: u32,
    pub weapon: usize,
    pub owner_id: u32,
    pub team_id: u8,
    pub body: RigidBodyHandle,
}

impl Bomb {
    pub fn new(
        world: &mut PhysicsWorld,
        weapon_index: usize,
        weapon: &WeaponConfig,
        shot_id: u32,
        owner_id: u32,
        team_id: u8,
        position: Vector,
    ) -> Self {
        let tag = BodyTag::Shot {
            shot_id,
            team_id,
            owner_id,
            weapon: weapon_index as u8,
        };

        let body = world.insert_body(
            RigidBodyBuilder::fixed()
                .translation(position)
                .user_data(tag.encode()),
        );

        // сенсор: детектирует контакты, но не участвует в столкновениях;
        // события контактов собирает game (для не-explosive снарядов в будущем)
        world.insert_collider(
            ColliderBuilder::cuboid(weapon.size / 2.0, weapon.size / 2.0)
                .sensor(true)
                .active_events(ActiveEvents::COLLISION_EVENTS),
            Some(body),
        );

        Self {
            shot_id,
            weapon: weapon_index,
            owner_id,
            team_id,
            body,
        }
    }

    /// Строка снапшота (Bomb.getData): [x, y, angle, size, time, ownerId].
    pub fn snapshot_row(&self, world: &PhysicsWorld, weapon: &WeaponConfig) -> BombRow {
        let body = &world.bodies[self.body];
        let pos = body.translation();

        BombRow {
            x: round2(pos.x),
            y: round2(pos.y),
            angle: round2(body.rotation().angle()),
            size: weapon.size as u8,
            time: weapon.time as u16,
            owner: self.owner_id as u8,
        }
    }
}

/// Данные бомбы для бинарного блока `bombs`.
#[derive(Clone, Copy)]
pub struct BombRow {
    pub x: f32,
    pub y: f32,
    pub angle: f32,
    pub size: u8,
    pub time: u16,
    pub owner: u8,
}

impl BombRow {
    /// Значение поля по индексу схемы ключа `w2` (opcodes.js):
    /// 0 x, 1 y, 2 angle, 3 size, 4 time, 5 ownerId.
    pub(crate) fn field(&self, i: usize) -> FieldValue {
        match i {
            0 => FieldValue::F32(self.x),
            1 => FieldValue::F32(self.y),
            2 => FieldValue::F32(self.angle),
            3 => FieldValue::U8(self.size),
            4 => FieldValue::U16(self.time),
            _ => FieldValue::U8(self.owner),
        }
    }
}
