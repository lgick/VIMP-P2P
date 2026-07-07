use serde::{Deserialize, Serialize};

/// События ядра за тик — «топливо» JS-меты (RoundManager, Stat, Panel, звук).
/// Сериализуются в JSON при take_events().
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CoreEvent {
    /// Уничтожение танка (RoundManager.reportKill / Stat).
    #[serde(rename_all = "camelCase")]
    Kill { victim: u32, killer: u32 },

    /// Новое значение здоровья (Panel).
    #[serde(rename_all = "camelCase")]
    Health { id: u32, value: f64 },

    /// Новое значение боезапаса оружия (Panel).
    #[serde(rename_all = "camelCase")]
    Ammo { id: u32, weapon: String, value: f64 },

    /// Смена активного оружия (Panel, ключ 'wa').
    #[serde(rename_all = "camelCase")]
    ActiveWeapon { id: u32, weapon: String },

    /// Тряска камеры у конкретного игрока (per-user мета кадра).
    #[serde(rename_all = "camelCase")]
    Shake { id: u32, intensity: f64, duration: f64 },
}
