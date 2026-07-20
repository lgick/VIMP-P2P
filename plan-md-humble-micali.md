# Аудит реализации PLAN.md (23 коммита) → План доработок

## Контекст

Проведён аудит ветки `engine`: 23 коммита (6bdc24c…26c182a), реализующие
PLAN.md — отделение движка (`@vimp/engine`) от игры-плагина (`@vimp/tanks`).
Проверено: соответствие коду всех 8 этапов, контракты §3.1–3.7, Rust-крейты,
мастер/хост/клиент/сборка/CI/Docker/документация.

**Вердикт: план реализован добротно и почти полностью.** Подтверждено
фактическими прогонами: `npx eslint .` чисто, `npm test` 72/702 зелёные,
`cargo test --workspace` 59+38+12=109 — все счётчики совпадают с заявленными
в PLAN.md. ESLint-граница движок↔игра безусловна и чиста (ни одного
статического импорта игры в движке), макросы ABI полны (25/25 и 12/12
методов §3.4), конфиги Rust разделены точно по плану, BodyTag разделён с
round-trip-тестом, HANDOFF_VERSION=2 с gameId/gameVersion, составной
codeVersion, CI-матрица из 4 job, Dockerfile соответствует структуре,
фикстура miniGame доказывает работу движка без Rust-артефактов игры,
`host/meta` Worker-safe.

**Но найдены: 1 архитектурная недоделка (снапшот-схема осталась в движке),
2 контрактных UI-хардкода, bot-именование в движке вопреки §1/3.9, ряд
робастность-дефектов и систематически устаревшая документация.**

Этот план создаёт **только документы плана доработок** (код не трогается):

```
plan/
├─ README.md      # индекс: таблица этапов Д1–Д7, статусы, приоритеты
├─ stage_d1.md    # Д1. Снапшот-схема — из движка в игру (критично, M)
├─ stage_d2.md    # Д2. PanelView по типам схемы + auth-тексты игры (критично, S-M)
├─ stage_d3.md    # Д3. bot → scripted в движке (важно, M)
├─ stage_d4.md    # Д4. Робастность хоста и мастера (важно, S)
├─ stage_d5.md    # Д5. Аудио-пайплайн и скрипты сборки (важно, S)
├─ stage_d6.md    # Д6. Актуализация документации en+ru (важно, M)
└─ stage_d7.md    # Д7. Отложенные улучшения (низкий приоритет)
```

Размещение в `plan/` — по глобальному правилу CLAUDE.md (модульные планы в
`plan/`, индекс в `plan/README.md`); PLAN.md остаётся историческим
документом. Каждый stage-файл: замечание → доказательства (файлы:строки) →
детальное решение → список правок → критерий готовности.

---

## Содержание этапов (что войдёт в файлы)

### Д1. Снапшот-схема — из движка в игру (критично, ~M)

**Замечание.** Игровая схема `SNAPSHOT_KEYS` (ключи m1/w1/w2/w2e/c1/c2 с
полями gunRotation/condition/ownerId…) живёт в движковом
`packages/engine/src/config/opcodes.js:31-107` и потребляется движком в
`lib/coreConfig.js`, `lib/clientCoreConfig.js` и `client/main.js`
(`reconstructHot` с жёсткой раскладкой 12/5 float, `SNAPSHOT_KEYS_BY_ID`).
Целевая структура §2 PLAN.md прямо кладёт «snapshot-схему (ключи
m1/w1/w2/w2e/c1/c2)» в `games/tanks/src/config/` — файла там нет. Отклонение
частично задокументировано (§3.4 «Отклонено»), но в текущем виде **вторая
игра с другой раскладкой невозможна без правки движка** — главная цель плана
не достигнута до конца. Rust-сторона уже полностью schema-driven (этапы
4a.2/4c) — доработка чисто JS-ная, байты не меняются.

**Решение.**
- Новый `games/tanks/src/config/snapshot.js` — текущий `SNAPSHOT_KEYS`;
  подключить в `HostPlugin.gameConfig.snapshot` (`games/tanks/src/config/game.js`);
  добавить путь в `REQUIRED_GAME_CONFIG_PATHS` (`lib/gamePlugin.js`).
- `lib/coreConfig.js`: `keys` — из `gameConfig.snapshot` (version/port
  остаются движковыми).
- `lib/buildClientConfig.js`: схема едет клиенту в CONFIG_DATA (рядом с
  `prediction`) — устраняется «скрытая связь бандл клиента = хост» из §3.4.
- `lib/clientCoreConfig.js`: `keys` — из CONFIG_DATA, не из импорта.
- `client/main.js`: generic `reconstructHot` — ширина hot-записи и ключи из
  схемы CONFIG_DATA (2 служебных поля + число hot-полей класса), включая
  PREDICTED-хвост; `SNAPSHOT_KEYS`/`SNAPSHOT_KEYS_BY_ID` из `opcodes.js`
  удалить (остаются `ENGINE_API_VERSION`, `SNAPSHOT_FORMAT_VERSION`, `HOT_FLAGS`).
- Фикстура miniGame получает собственную мини-схему — усиливается
  доказательство «второй игры».
- `SNAPSHOT_FORMAT_VERSION` остаётся 3 (байтовая раскладка не меняется).
- Тесты: coreConfig/clientCoreConfig/gamePlugin/fixture; docs: plugin-api,
  configuration, network (en+ru).

### Д2. PanelView по типам схемы + auth-тексты игры (критично, ~S-M)

**Замечание 1.** `client/components/view/Panel.js` генерирует DOM по схеме
лишь частично: семантика захардкожена по именам полей — `if (name ===
'health')` (бар из 30 блоков, деление на 100, CSS-классы `panel-health-*`),
отдельная логика оружия (`_weaponList`, `setCurrentWeapon`). §3.3 требует
«типы отображения: bar/число/время/иконка-оружия» в схеме. Игра с полем
`energy` вместо `health` не получит бар.

**Решение 1.** В схему панели добавить `type: 'bar' | 'value' | 'time' |
'weapon'` (+ параметры бара: `max`, число блоков); PanelView рендерит по
`type`, CSS-классы нейтральные (`panel-bar-*`); танковая схема
(`games/tanks/src/config/game.js` panel.fields) объявляет типы; игровой CSS
адаптируется. Хостовая `meta/modules/Panel.js` не меняется (activeKey уже
из схемы).

**Замечание 2.** Движковый шаблон `client/views/includes/auth.pug:5,19-31`
содержит игровые тексты: «VIMP P2P Tank Battle», «move the tank», «turn the
gun», «switch weapon/player». §2: «index.html — нейтральный shell».

**Решение 2.** Заголовок и help-строки — в `authSchema` игры
(`games/tanks/src/config/auth.js`): хост уже шлёт `authSchema.elems/params`
клиенту (`host.worker.js:185-189`) — расширить полем текстов; auth-view
подставляет их в DOM; auth.pug — нейтральный каркас. Зеркально — фикстура.

### Д3. bot → scripted в движке (важно, ~M)

**Замечание.** §1: «Ботов в движке быть не должно — только нейтральная
абстракция "скриптовый участник"». Фактически в движке остались:
`host/meta/player/BotParticipant.js` (класс и файл), контракт
scripted-модуля с bot-именами, который движок вызывает:
`createModules(ctx).bots`, `getBotCountsPerTeam()`,
`removeOneBotForPlayer()`, `createBots/removeBots/getBots` (HostGame.js:132,
653-657; RoundManager.js:109-118,159-161,303-305), поле `bots` в
handoff-мете (`_collectHandoff`). Это следование §3.2 (контракт там сам
bot-именованный — внутреннее противоречие плана), но противоречит цели §1.

**Решение.** Переименовать, пока `engineApi` не заморожен внешним репо игры
(дёшево сейчас, дорого потом): `BotParticipant` → `ScriptedParticipant`;
контракт модуля: `createModules(ctx).scripted` с методами
`createScripted(count, team?)`, `removeScripted(team?)`,
`removeOneForHuman(team)`, `getCount()`, `getCountsPerTeam()`; handoff-поле
`bots` → `scripted` c бампом `HANDOFF_VERSION` → 3 (несовместимый своп валит
init → штатный `resume`, как задумано §3.7). `TanksBotManager` и фикстурный
`ScriptedManager` реализуют новые имена (внутри игры слово «бот» законно).
Обновить plugin-api.md. `ENGINE_API_VERSION` можно не поднимать, пока игра
в монорепо и обновляется атомарно (зафиксировать это решение в plugin-api).

### Д4. Робастность хоста и мастера (важно, ~S)

1. **Null-guard'ы HostGame** — `updateKeys` (`HostGame.js:707`),
   `pushMessage` (:730), `parseVote` (:755), `mapReady` (:438),
   `firstShotReady` (:452) читают `participants.get(gameId)` без проверки.
   Гонка «кик (RTT/idle) → в полёте ещё сообщения клиента до `disconnect`»
   даёт TypeError в Worker'е (порт-машина ещё включена — `host.worker.js`
   чистит `clients` только на `disconnect`). Решение: ранний `return` при
   `!user` (по образцу `updateRTT:795`).
2. **`applyRoomOverrides` не клампит времена** (`host.worker.js:73-79`):
   `roundTime`/`mapTime` принимаются любыми конечными числами; форма лобби
   пропускает отрицательные (`Number(x) || default` в `main.js:1418-1420`,
   `min='1'` в pug — не серверная граница). Решение: клампы (например,
   10 000…3 600 000 мс, константы в `hostDefaults`) + `Math.floor`;
   зеркально `min`/`max` в `lobby.pug`.
3. **GameCatalog**: ключ каталога — `manifest.id`, а статик-маунт
   `main.js:170-172` строит путь `games/<manifest.id>/dist` по нему же,
   хотя сканируется имя директории — при расхождении dir≠id маунт бьёт мимо.
   Плюс битый JSON карты валит мастер на старте (`_readMaps` без try на
   `JSON.parse`). Решение: пропускать игру с предупреждением при
   `manifest.id !== dirname`; try/catch вокруг карты с warn+skip.

### Д5. Аудио-пайплайн и скрипты сборки (важно, ~S)

**Замечание.** `scripts/process-audio.js` пишет в
`packages/engine/public/sounds` (легаси-путь до этапа 6 — комментарий в
`copy-game-sounds.js:4` сам это признаёт), затем копия уезжает в
`games/tanks/dist/sounds`. Клиент слушает только
`assetsBase` (`main.js:205-208` переопределяет путь всегда) → копия в
движковом `public/` — мёртвый груз, попадающий в dist движка; звуки — не
ассет движка. Вдобавок `npm run build` гоняет `audio:process` дважды
(`game:build` и `build:app` оба его вызывают).

**Решение.** Вывод `process-audio.js` → `games/tanks/build/sounds/`
(промежуточный, в .gitignore); `copy-game-sounds.js` читает оттуда;
`packages/engine/public/sounds` удалить; `build:app` без `audio:process`
(движку звуки не нужны); в `package.json` `audio:process` остаётся только
внутри `game:build`. Заодно в `scripts/build-game-manifest.js:14` заменить
`URL.pathname` на `fileURLToPath` (ломается на пробелах/Windows).
Обновить `docs/{en,ru}` (getting-started/deployment) и `.dockerignore`
при необходимости.

### Д6. Актуализация документации en+ru (важно, ~M)

Систематическая проблема: все Rust-пути вне `core.md` остались от
до-4b монолита `core/` (каталога больше нет). Полный список файлов:строк —
в stage_d6.md. Ключевое:

- **CLAUDE.md**: строки 26, 65-68, 104-106, 120-121 — `core/` →
  `packages/engine/core` + `games/tanks/core`, `games/tanks/core/pkg-node`,
  Docker-стадия `games/tanks/core/pkg-web` (этап 8 заявил «правок не
  потребовалось» — это неверно).
- **plugin-api.md** (en:223,287 / ru): `SNAPSHOT_FORMAT_VERSION → 4` — в
  коде осознанно 3; `dist/games/<id>/manifest.json` (:38) → фактический
  `games/tanks/dist/manifest.json`; контракт HostPlugin документирует
  несуществующие `buildCoreGameConfig` и `voteDefs` (в коде их нет:
  движок сам собирает конфиг ядра в `lib/coreConfig.js`, голосования
  создаются динамически `voteCoordinator.createVote` из чат-команды) —
  привести к фактическому контракту; задокументировать фактический `ctx`
  `createModules` (participants/coreAdapter/panel/stat/chat/socketManager/
  scripted — без roundManager/voteCoordinator/timerManager из §3.2) и `ctx`
  чат-команд (они разные); таблица «распил core/src» — в прошедшее время.
- **network/architecture/client/configuration/host/getting-started/master
  (en+ru)**: ~30 устаревших `core/src/*`, `core/pkg-web`, `core/pkg-node`
  путей (полный перечень от аудита — в stage-файле); `configuration.md` —
  лобби-конфиг карт描 `/maps/manifest.json` (снят в 6.4) → пер-игровые
  функции-URL из `config/lobby.js`; `architecture.md` — таблица разметки
  ENGINE/GAME/MIXED переписана из будущего времени в состоявшееся;
  `core.md:182` — битый путь.
- **PLAN_4_details.md §5** противоречит выполненному 4c (говорит
  «GameClientDef не реализован», «export_client_core_abi заблокирован») —
  добавить пометку об актуализации 4c.

### Д7. Отложенные улучшения (низкий приоритет, по желанию)

- Форма комнаты, генерируемая по ключам `roomDefaults` (сейчас движковое
  лобби знает игровое поле `friendlyFire` — `config/lobby.js:62`; контрактно
  допустимо по §3.1, актуально при второй игре).
- Stat-колонки `status/score/deaths/latency`, безусловно пишемые движком
  (RoundManager/RTTManager) — сделать объявляемыми схемой (ограничение
  честно вскрыто фикстурой этапа 7).
- Нейтральные имена в Rust-трейте `GameClientDef` (`cycle_weapon`/`try_fire`
  → нейтральные) — внутренняя правка engine-crate, JS не затрагивает.
- `pixi.js`/`howler` → devDependencies `@vimp/engine`: `npm ci --omit=dev`
  в runner-образе перестанет тащить клиентские пакеты (Vite бандлит их на
  стадии builder независимо от типа зависимости).
- cwd-зависимые пути мастера (`path.resolve('..','..','games')`,
  `express.static(path.join(...))`, WorkerCatalog) → якорь от
  `import.meta.url`.

---

## Верификация (после каждого этапа доработок)

- `npx eslint .`, `npm test` (сейчас 702), `npm run core:test` (109) —
  зелёные; для Д1 дополнительно `cargo test` parity-набор не должен
  измениться (байты те же).
- Д1/Д2: ручной smoke двух вкладок — панель/бар здоровья/смена оружия/
  звуки/движение; Д3: сценарий эстафеты (swap с несовместимым handoff →
  resume); Д5: `npm run build` (одинарный прогон аудио, отсутствие
  `public/sounds`), `npm run dev` — звуки с `/games/tanks/sounds/`.
- Правило CLAUDE.md: docs/{en,ru} правятся в том же изменении, что и код
  каждого этапа.
