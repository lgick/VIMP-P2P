/// Игровая метка тела в user_data Rapier (аналог body.userData JS-версии).
/// Кодируется в u128: тип в младшем байте, дальше — поля по 32/8 бит.
/// Диапазон `1` зарезервирован движком (`vimp_engine_core::physics::MAP_OBJECT_TAG`)
/// — игровые теги начинаются с `2`.
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
}

const TAG_PLAYER: u128 = 2;
const TAG_SHOT: u128 = 3;

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
            _ => None,
        }
    }
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
        ];

        for tag in tags {
            assert_eq!(BodyTag::decode(tag.encode()), Some(tag));
        }
    }

    #[test]
    fn decode_unknown_returns_none() {
        assert_eq!(BodyTag::decode(0), None);
        assert_eq!(
            BodyTag::decode(vimp_engine_core::physics::encode_map_object()),
            None
        );
    }
}
