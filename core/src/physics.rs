/// Метка тела в user_data Rapier (аналог body.userData JS-версии).
/// Кодируется в u128: тип в младшем байте, дальше — поля по 32/8 бит.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BodyTag {
    Player {
        game_id: u32,
        team_id: u8,
    },
    Shot {
        shot_id: u32,
        team_id: u8,
        owner_id: u32,
        weapon: u8,
    },
    MapObject,
}

const TAG_PLAYER: u128 = 1;
const TAG_SHOT: u128 = 2;
const TAG_MAP_OBJECT: u128 = 3;

impl BodyTag {
    pub fn encode(self) -> u128 {
        match self {
            BodyTag::Player { game_id, team_id } => {
                TAG_PLAYER | ((game_id as u128) << 8) | ((team_id as u128) << 40)
            }
            BodyTag::Shot {
                shot_id,
                team_id,
                owner_id,
                weapon,
            } => {
                TAG_SHOT
                    | ((shot_id as u128) << 8)
                    | ((team_id as u128) << 40)
                    | ((owner_id as u128) << 48)
                    | ((weapon as u128) << 80)
            }
            BodyTag::MapObject => TAG_MAP_OBJECT,
        }
    }

    pub fn decode(data: u128) -> Option<BodyTag> {
        match data & 0xff {
            TAG_PLAYER => Some(BodyTag::Player {
                game_id: (data >> 8) as u32,
                team_id: (data >> 40) as u8,
            }),
            TAG_SHOT => Some(BodyTag::Shot {
                shot_id: (data >> 8) as u32,
                team_id: (data >> 40) as u8,
                owner_id: (data >> 48) as u32,
                weapon: (data >> 80) as u8,
            }),
            TAG_MAP_OBJECT => Some(BodyTag::MapObject),
            _ => None,
        }
    }
}

/// Округление до 2 знаков (lib/formatters.js roundTo2Decimals).
pub fn round2(v: f32) -> f32 {
    ((v as f64 * 100.0).round() / 100.0) as f32
}

/// Округление до 1 знака (+value.toFixed(1) в JS-частях).
pub fn round1(v: f32) -> f32 {
    ((v as f64 * 10.0).round() / 10.0) as f32
}

/// Перевод градусов в радианы (lib/math.js degToRad).
pub fn deg_to_rad(degrees: f32) -> f32 {
    degrees * (core::f32::consts::PI / 180.0)
}

/// Линейная интерполяция (lib/math.js lerp).
pub fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

/// Ограничение в диапазоне (lib/math.js clamp).
pub fn clamp(value: f32, min: f32, max: f32) -> f32 {
    value.min(max).max(min)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_tag_roundtrip() {
        let tags = [
            BodyTag::Player {
                game_id: 250,
                team_id: 2,
            },
            BodyTag::Shot {
                shot_id: 123_456,
                team_id: 1,
                owner_id: 7,
                weapon: 1,
            },
            BodyTag::MapObject,
        ];

        for tag in tags {
            assert_eq!(BodyTag::decode(tag.encode()), Some(tag));
        }
    }

    #[test]
    fn decode_unknown_returns_none() {
        assert_eq!(BodyTag::decode(0), None);
        assert_eq!(BodyTag::decode(0xff), None);
    }

    #[test]
    fn rounding_matches_js() {
        assert_eq!(round2(10.567), 10.57);
        assert_eq!(round2(-3.14159), -3.14);
        assert_eq!(round1(10.567), 10.6);
    }
}
