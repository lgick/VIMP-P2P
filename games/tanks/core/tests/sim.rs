// Интеграционные тесты симуляции: сценарии портированы с поведения
// текущего JS-сервера (tests/server/integration/) как эталона Этапа 2.

use vimp_engine_core::events::CoreEvent;
use vimp_tanks_core::GameCore;

const DT: f32 = 1.0 / 120.0;

/// Конфиг ядра — зеркало src/config/game.js + src/data/*.js (собирается на
/// JS через src/lib/coreConfig.js). Плоский JSON заворачивается в
/// `{engine: {...}, game: {...}}` (PLAN.md §3.4) с одним и тем же объектом
/// по обе стороны — каждая половина деэерилизует лишние для себя поля молча.
fn config_json() -> String {
    let flat = flat_config_json();

    serde_json::json!({ "engine": flat.clone(), "game": flat }).to_string()
}

fn flat_config_json() -> serde_json::Value {
    serde_json::json!({
        "timeStep": DT,
        "friendlyFire": false,
        "mapScale": 0.3,
        "mapSetId": "c1",
        "models": {
            "m1": {
                "currentWeapon": "w1",
                "size": 2,
                "accelerationFactor": 1000,
                "brakingFactor": 10,
                "maxForwardSpeed": 260,
                "maxReverseSpeed": -130,
                "baseTurnTorqueFactor": 215,
                "damping": { "linear": 3, "angular": 100.0 },
                "fixture": { "density": 200, "friction": 0.5, "restitution": 0.1 },
                "lateralGrip": 20,
                "turnSpeedThreshold": 10,
                "baseTurnFactorRatio": 0.8,
                "reverseTurnMultiplier": 0.7,
                "throttleIncreaseRate": 2.0,
                "throttleDecreaseRate": 2.5,
                "strainFactor": 1.5,
                "maxGunAngle": 1.4,
                "gunRotationSpeed": 3.0,
                "gunCenterSpeed": 10.0
            }
        },
        "weapons": {
            "w1": {
                "type": "hitscan",
                "impulseMagnitude": 5000,
                "damage": 40,
                "range": 1500,
                "fireRate": 0.01,
                "spread": 0,
                "consumption": 1,
                "cameraShake": { "intensity": 20, "duration": 200 }
            },
            "w2": {
                "type": "explosive",
                "time": 300,
                "shotOutcomeId": "w2e",
                "size": 8,
                "fireRate": 0.1,
                "damage": 70,
                "radius": 50,
                "impulseMagnitude": 2000000,
                "cameraShake": { "intensity": 30, "duration": 400 }
            }
        },
        "playerKeys": {
            "forward": { "key": 1 },
            "back": { "key": 2 },
            "left": { "key": 4 },
            "right": { "key": 8 },
            "gunCenter": { "key": 16, "type": 1 },
            "gunLeft": { "key": 32 },
            "gunRight": { "key": 64 },
            "fire": { "key": 128, "type": 1 },
            "nextWeapon": { "key": 256, "type": 1 },
            "prevWeapon": { "key": 512, "type": 1 }
        },
        "panel": {
            "health": { "key": "h", "value": 100 },
            "w1": { "key": "w1", "value": 200 },
            "w2": { "key": "w2", "value": 100 }
        },
        "snapshot": {
            "version": 3,
            "port": 5,
            "keys": {
                "m1": { "id": 1, "kind": "indexed8", "class": "hot", "fields": [
                    { "name": "x", "ty": "f32", "interp": "lerp" },
                    { "name": "y", "ty": "f32", "interp": "lerp" },
                    { "name": "angle", "ty": "f32", "interp": "lerpAngle" },
                    { "name": "gunRotation", "ty": "f32", "interp": "lerpAngle" },
                    { "name": "vx", "ty": "f32", "interp": "lerp" },
                    { "name": "vy", "ty": "f32", "interp": "lerp" },
                    { "name": "engineLoad", "ty": "f32", "interp": "lerp" },
                    { "name": "condition", "ty": "u8" },
                    { "name": "size", "ty": "u8" },
                    { "name": "team", "ty": "u8" }
                ] },
                "w1": { "id": 2, "kind": "list16", "class": "event", "fields": [
                    { "name": "startX", "ty": "f32" },
                    { "name": "startY", "ty": "f32" },
                    { "name": "endX", "ty": "f32" },
                    { "name": "endY", "ty": "f32" },
                    { "name": "bodyX", "ty": "f32" },
                    { "name": "bodyY", "ty": "f32" },
                    { "name": "wasHit", "ty": "u8" },
                    { "name": "shooterId", "ty": "u8" }
                ] },
                "w2": { "id": 3, "kind": "indexed32", "class": "event", "fields": [
                    { "name": "x", "ty": "f32" },
                    { "name": "y", "ty": "f32" },
                    { "name": "angle", "ty": "f32" },
                    { "name": "size", "ty": "u8" },
                    { "name": "time", "ty": "u16" },
                    { "name": "ownerId", "ty": "u8" }
                ] },
                "w2e": { "id": 4, "kind": "list16", "class": "event", "fields": [
                    { "name": "x", "ty": "f32" },
                    { "name": "y", "ty": "f32" },
                    { "name": "radius", "ty": "f32" }
                ] },
                "c1": { "id": 5, "kind": "indexedNoNull8", "class": "hot", "fields": [
                    { "name": "x", "ty": "f32", "interp": "lerp" },
                    { "name": "y", "ty": "f32", "interp": "lerp" },
                    { "name": "angle", "ty": "f32", "interp": "lerpAngle" }
                ] },
                "c2": { "id": 6, "kind": "indexedNoNull8", "class": "hot", "fields": [
                    { "name": "x", "ty": "f32", "interp": "lerp" },
                    { "name": "y", "ty": "f32", "interp": "lerp" },
                    { "name": "angle", "ty": "f32", "interp": "lerpAngle" }
                ] }
            }
        },
        "seed": 42
    })
}

/// Небольшая карта: периметр из стен, шаг 32, масштаб 1.
fn map_json() -> String {
    let mut grid: Vec<Vec<i32>> = vec![vec![0; 20]; 20];

    for x in 0..20 {
        grid[0][x] = 1;
        grid[19][x] = 1;
    }

    for row in grid.iter_mut() {
        row[0] = 1;
        row[19] = 1;
    }

    serde_json::json!({
        "setId": "c1",
        "scale": 1,
        "step": 32,
        "map": grid,
        "physicsStatic": [1],
        "physicsDynamic": [],
        "respawns": {
            "team1": [[100, 100, 0], [100, 200, 0]],
            "team2": [[500, 100, 180], [500, 200, 180]]
        }
    })
    .to_string()
}

fn make_core() -> GameCore {
    GameCore::new(&config_json()).unwrap()
}

fn steps(core: &mut GameCore, count: usize) {
    for _ in 0..count {
        core.step(DT);
    }
}

fn events(core: &mut GameCore) -> Vec<CoreEvent> {
    serde_json::from_str(&core.take_events()).unwrap()
}

#[test]
fn tank_drives_forward() {
    let mut core = make_core();

    core.spawn_actor(1, "m1", 1, 0.0, 0.0, 0.0).unwrap();
    core.apply_input(1, 1, "down", "forward");

    steps(&mut core, 120);

    let pos = core.position_of(1);

    assert!(pos[0] > 100.0, "танк должен уехать вперёд, x = {}", pos[0]);
    assert!(pos[1].abs() < 1.0, "без увода в сторону, y = {}", pos[1]);
    assert_eq!(core.last_input_seq(1), 1);
}

#[test]
fn tank_collides_with_map_walls() {
    let mut core = make_core();

    core.load_map(&map_json()).unwrap();
    // танк смотрит на левую стену (x=32 — внутренняя грань)
    core.spawn_actor(1, "m1", 1, 100.0, 100.0, 180.0).unwrap();
    core.apply_input(1, 1, "down", "forward");

    steps(&mut core, 400);

    let pos = core.position_of(1);

    assert!(
        pos[0] > 32.0,
        "стена должна остановить танк, x = {}",
        pos[0]
    );
}

#[test]
fn hitscan_shot_kills_after_three_hits() {
    let mut core = make_core();

    // стрелок смотрит на цель в упор
    core.spawn_actor(1, "m1", 1, 0.0, 0.0, 0.0).unwrap();
    core.spawn_actor(2, "m1", 2, 60.0, 0.0, 0.0).unwrap();

    // прогрев: broad-phase узнаёт о новых телах на шаге мира
    core.step(DT);
    core.take_events();

    // три выстрела с паузой больше кулдауна (0.01 c)
    for _ in 0..3 {
        core.apply_input(1, 1, "down", "fire");
        steps(&mut core, 4);
    }

    let all = events(&mut core);

    let kills: Vec<_> = all
        .iter()
        .filter(|e| matches!(e, CoreEvent::Death { .. }))
        .collect();

    assert_eq!(kills.len(), 1, "события: {all:?}");

    if let CoreEvent::Death { victim, killer } = kills[0] {
        assert_eq!(*victim, 2);
        assert_eq!(*killer, 1);
    }

    assert!(!core.is_alive(2));
    assert!(core.is_alive(1));

    // здоровье цели снижалось по 40 (100 → 60 → 20 → 0)
    let healths: Vec<f64> = all
        .iter()
        .filter_map(|e| match e {
            CoreEvent::PanelSet { id: 2, field, value } if field == "health" => Some(*value),
            _ => None,
        })
        .collect();

    assert_eq!(healths, vec![60.0, 20.0, 0.0]);

    // патроны стрелка списаны трижды
    let ammo: Vec<f64> = all
        .iter()
        .filter_map(|e| match e {
            CoreEvent::PanelSet { id: 1, field, value } if field == "w1" => Some(*value),
            _ => None,
        })
        .collect();

    assert_eq!(ammo, vec![199.0, 198.0, 197.0]);
}

#[test]
fn friendly_fire_disabled_blocks_damage() {
    let mut core = make_core();

    core.spawn_actor(1, "m1", 1, 0.0, 0.0, 0.0).unwrap();
    core.spawn_actor(2, "m1", 1, 60.0, 0.0, 0.0).unwrap();

    core.step(DT);
    core.take_events();

    core.apply_input(1, 1, "down", "fire");
    steps(&mut core, 4);

    let all = events(&mut core);

    assert!(
        !all.iter()
            .any(|e| matches!(e, CoreEvent::PanelSet { id: 2, field, .. } if field == "health")),
        "урон по своей команде запрещён: {all:?}"
    );
    assert!(core.is_alive(2));
}

#[test]
fn bomb_detonates_and_damages_nearby_enemy() {
    let mut core = make_core();

    core.spawn_actor(1, "m1", 1, 0.0, 0.0, 0.0).unwrap();
    core.spawn_actor(2, "m1", 2, 20.0, 0.0, 0.0).unwrap();

    core.take_events();

    // переключение на бомбу (w2) и выстрел
    core.apply_input(1, 1, "down", "nextWeapon");
    core.step(DT);
    core.apply_input(1, 2, "down", "fire");

    // 300 мс жизни бомбы + запас
    steps(&mut core, 50);

    let all = events(&mut core);

    // жертва получила урон с falloff (< 70, эпицентр на стрелке)
    let victim_health: Vec<f64> = all
        .iter()
        .filter_map(|e| match e {
            CoreEvent::PanelSet { id: 2, field, value } if field == "health" => Some(*value),
            _ => None,
        })
        .collect();

    assert_eq!(victim_health.len(), 1, "события: {all:?}");
    assert!(victim_health[0] < 100.0 && victim_health[0] > 0.0);

    // стрелок своей команды не пострадал (friendly fire off:
    // владелец бомбы — та же команда)
    assert!(
        !all.iter()
            .any(|e| matches!(e, CoreEvent::PanelSet { id: 1, field, .. } if field == "health")),
        "владелец не должен получить урон: {all:?}"
    );
}

#[test]
fn weapon_switch_cycles_and_reports() {
    let mut core = make_core();

    core.spawn_actor(1, "m1", 1, 0.0, 0.0, 0.0).unwrap();
    core.take_events();

    core.apply_input(1, 1, "down", "nextWeapon");
    core.step(DT);

    let all = events(&mut core);

    assert!(
        all.iter().any(
            |e| matches!(e, CoreEvent::PanelActive { id: 1, field } if field == "w2")
        ),
        "события: {all:?}"
    );

    core.apply_input(1, 2, "down", "nextWeapon");
    core.step(DT);

    let all = events(&mut core);

    assert!(
        all.iter().any(
            |e| matches!(e, CoreEvent::PanelActive { id: 1, field } if field == "w1")
        ),
        "цикл должен вернуться к w1: {all:?}"
    );
}

#[test]
fn bot_moves_on_map() {
    let mut core = make_core();

    core.load_map(&map_json()).unwrap();
    core.spawn_scripted_actor(1, "m1", 1, 100.0, 100.0, 0.0).unwrap();

    let start = core.position_of(1);

    // 3 секунды патрулирования
    steps(&mut core, 360);

    let end = core.position_of(1);
    let dist_sq = (end[0] - start[0]).powi(2) + (end[1] - start[1]).powi(2);

    assert!(dist_sq > 100.0, "бот должен патрулировать, прошёл {dist_sq}");
}

#[test]
fn bots_fight_each_other() {
    let mut core = make_core();

    core.load_map(&map_json()).unwrap();
    core.spawn_scripted_actor(1, "m1", 1, 150.0, 200.0, 0.0).unwrap();
    core.spawn_scripted_actor(2, "m1", 2, 300.0, 200.0, 180.0).unwrap();

    // до 60 секунд боя (боты мажут: AIM_INACCURACY)
    let mut killed = false;

    for _ in 0..60 {
        steps(&mut core, 120);

        if events(&mut core)
            .iter()
            .any(|e| matches!(e, CoreEvent::Death { .. }))
        {
            killed = true;
            break;
        }
    }

    assert!(killed, "боты в прямой видимости должны добиться килла");
}

#[test]
fn remove_players_and_shots_reports_names() {
    let mut core = make_core();

    core.spawn_actor(1, "m1", 1, 0.0, 0.0, 0.0).unwrap();

    let names: Vec<String> =
        serde_json::from_str(&core.remove_players_and_shots()).unwrap();

    assert!(names.contains(&"m1".to_string()));
    assert!(names.contains(&"w1".to_string()));
    assert!(names.contains(&"w2".to_string()));
    assert!(names.contains(&"w2e".to_string()));
    assert!(core.position_of(1).is_empty());
}

#[test]
fn reset_actor_moves_and_stops() {
    let mut core = make_core();

    core.spawn_actor(1, "m1", 1, 0.0, 0.0, 0.0).unwrap();
    core.apply_input(1, 1, "down", "forward");
    steps(&mut core, 60);

    core.reset_actor(1, 2, 500.0, 300.0, 90.0);

    let pos = core.position_of(1);

    assert_eq!(pos, vec![500.0, 300.0]);

    // клавиши сброшены — танк не продолжает ехать
    steps(&mut core, 30);

    let pos_after = core.position_of(1);

    assert!((pos_after[0] - 500.0).abs() < 0.5);
    assert!((pos_after[1] - 300.0).abs() < 0.5);
}

#[test]
fn state_dump_restores_identical_simulation() {
    let mut core = make_core();

    core.load_map(&map_json()).unwrap();
    core.spawn_actor(1, "m1", 1, 100.0, 100.0, 0.0).unwrap();
    core.spawn_scripted_actor(2, "m1", 2, 400.0, 400.0, 180.0).unwrap();
    core.apply_input(1, 1, "down", "forward");

    steps(&mut core, 60);
    core.pack_body().unwrap(); // дренаж накопителей перед дампом
    core.take_events();

    let dump = core.serialize_state().unwrap();

    let mut restored = make_core();

    restored.deserialize_state(&dump).unwrap();

    // продолжение симуляции бит-в-бит (Spike B: эстафета без разрыва)
    steps(&mut core, 120);
    steps(&mut restored, 120);

    assert_eq!(core.position_of(1), restored.position_of(1));
    assert_eq!(core.position_of(2), restored.position_of(2));
}

#[test]
fn clear_resets_world() {
    let mut core = make_core();

    core.load_map(&map_json()).unwrap();
    core.spawn_actor(1, "m1", 1, 100.0, 100.0, 0.0).unwrap();
    core.spawn_scripted_actor(2, "m1", 2, 400.0, 400.0, 180.0).unwrap();

    steps(&mut core, 10);
    core.clear();

    assert!(core.position_of(1).is_empty());
    assert!(core.position_of(2).is_empty());
    assert_eq!(core.map_info(), "null");

    // мир пригоден к новой карте и новым игрокам
    core.load_map(&map_json()).unwrap();
    core.spawn_actor(3, "m1", 1, 100.0, 100.0, 0.0).unwrap();
    steps(&mut core, 10);

    assert!(!core.position_of(3).is_empty());
}

// Примечание: конструктор GameCore::new теперь отклоняет невалидную
// snapshot-схему (SnapshotConfig::validate, см. core/src/config.rs), но
// проверить это интеграционным тестом здесь нельзя — JsError::new вызывает
// wasm-bindgen import, недоступный на нативном таргете `cargo test`
// (паника "cannot call wasm-bindgen imported functions on non-wasm
// targets" на любом Err-пути `Result<_, JsError>`, не только в этой
// проверке). Покрытие валидации — юнит-тесты `config.rs::validate_tests`,
// которые тестируют `SnapshotConfig::validate()` напрямую, в обход
// wasm-bindgen обёртки.
