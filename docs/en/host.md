# Browser Host

The browser host runs **the authoritative part of the match right in the room
creator's tab**: the WASM simulation core (`core/`) and the JS meta layer run
in a Web Worker, while the `RTCPeerConnection` router runs in the main
thread. This is the canonical "server side" of the game: the legacy
authoritative WS server (`src/server/`) has been fully removed.

Host code lives in `packages/engine/src/host/` (Worker + core + meta modules under
`packages/engine/src/host/meta/`) and `packages/engine/src/client/network/` (the main-thread router +
transports).

## Host tab topology

```
Host tab
├─ Main thread (client + router)
│   ├─ client (packages/engine/src/client/main.js): render, prediction, sound — a regular client
│   ├─ HostController: spawns the Worker, routes packets Worker ↔ clients
│   ├─ LoopbackTransport: host-player transport (a WebRtcManager-shaped
│   │  interface over postMessage)
│   └─ HostConnectionManager: WebRTC answerer for remote clients
│      (register_host, meta/state, backpressure)
└─ Web Worker (packages/engine/src/host/host.worker.js): authoritative simulation
    ├─ GameCore (WASM, core/pkg-web)
    ├─ GameCoreAdapter: physics/bots/packing surface over the core
    └─ HostGame facade + meta packages/engine/src/host/meta/ (RoundManager, Participant-
       Manager, Chat, Vote, Stat, Panel, TimerManager, RTTManager,
       CommandProcessor, VoteCoordinator, SocketManager) + ~120 Hz loop
```

Key rule: `RTCPeerConnection` **lives in the main thread** (it can't be
created inside a Worker), while the game loop lives **in the Worker** (its
timers aren't throttled by the browser in a background tab, unlike the main
thread). The main thread is a dumb pipe: it forwards wire frames between the
DataChannel/loopback and the Worker.

## Web Worker (`packages/engine/src/host/host.worker.js`)

Loads the WASM core (`init()` + `GameCore` from `core/pkg-web`), builds
`HostGame` with the room's settings, and holds a per-client port state
machine — an automaton over client ports 0–8 (see [network.md](network.md)).
Main-thread messages:

- `init(room, handoff?)` — assembles the game config (a merge of the engine
  defaults `packages/engine/src/config/hostDefaults.js` and `HostPlugin.gameConfig`) and
  applies room settings to it
  (`applyRoomOverrides`: name/map/limit ≤ `roomDefaults.maxPlayers`/timers/
  friendly fire; maps come
  from `room.maps` if the main thread fetched the master's catalog),
  initializes the core, creates `HostGame`, replies `ready`; `handoff` is the
  Worker handoff state: the room is restored instead of a cold start. A
  failure (WASM/config/handoff meta) sends `error { message }`: on a cold
  start the main thread tears down the room and returns to the lobby, on a
  handoff it resumes the old Worker;
- `connect(socketId)` — a new client: registers a wire socket in
  `SocketManager`, sends `CONFIG_DATA` (port 0), starts the
  config→auth→map→firstShot handshake. **A full room** (`HostGame.isFull`,
  **humans** against `maxPlayers`; bots don't take a slot — connecting a
  human past the combined limit kicks a bot, `_freeSlotForHuman`) is refused:
  the connection closes with code `4006` and reason `roomFull` (no waiting
  queue in a P2P room). A client from handoff meta is restored past the
  handshake — its port state machine comes up already in the game state;
- `message(socketId, data)` — an incoming client message
  (`JSON [port, payload]`), dispatched by allowed ports;
- `disconnect(socketId)` — removes the participant from the game and the
  registry;
- `update_maps(maps)` — an updated map catalog from the master →
  `HostGame.updateMaps`;
- `prepare_handoff` / `resume` / `handoff_complete` — the Worker handoff
  protocol (see the section of the same name below).

The Worker sends back to the main thread `to_client` (a wire frame: a JSON
string or a binary `ArrayBuffer` via a Transferable), `close_client`,
`ready`, `error` (init failure), `map_changed { mapName }` (a map change from
a vote/timer — the main thread updates the room record at the master), and
`handoff_state { state }` (a handoff: room state at a round boundary). The
per-user **wire socket** (`makeWorkerSocket`) implements the `SocketManager`
contract (`send`/`sendBinary`/`close`) over `postMessage`. Transport quirks:

- `close(code, data)`: closing a data channel carries no code/reason — the
  reason (idle/RTT kick, full room) is delivered as a separate
  `TECH_INFORM_DATA` over meta **before** `close_client` (reliable-ordered
  guarantees the order), and the client shows it instead of a generic "Host
  left";
- `send(port, data, reliable)`: `reliable: false` routes a JSON message onto
  the unreliable state channel — only `PING` travels this way (see
  `network.md`).

The ~120 Hz game loop starts on its own (`HostGame` constructor →
`RoundManager.createMap` → `TimerManager.startGameTimers`); frames only go
out to participants ready to play.

## HostGame (`packages/engine/src/host/HostGame.js`)

The host facade — module wiring + the participant lifecycle:

- simulation/bots/snapshot packing live in the Rust core, reached through
  `GameCoreAdapter`;
- meta (`RoundManager`, `ParticipantManager`, `Chat`, `Vote`, `Stat`, `Panel`,
  `TimerManager`, `RTTManager`, `CommandProcessor`, `VoteCoordinator`,
  `SocketManager`) lives in `packages/engine/src/host/meta/` modules (see "Meta modules"
  below), with dependencies passed through constructors (DI);
- the hot `_onShotTick` is core-driven: `adapter.updateData(dt)` (a core step
  + event drain), send throttling (`SnapshotThrottle` — a frame every
  `networkSendRate`-th tick), `adapter.packBody()` once per tick, then a
  per-user `adapter.packFrame(...)` (the core itself assembles the
  prediction player block for `playerId`);
- **connection lifecycle**: `createUser` (registering a spectator in every
  module), `removeUser`, `mapReady`, `firstShotReady`, `sendMap` (a proxy to
  RoundManager); **input** via `updateKeys(gameId, 'seq:action:name')`;
  **chat and votes** via `pushMessage` (sanitizing, `/commands` →
  CommandProcessor) and `parseVote`; bridges for `TimerManager`/`RTTManager`
  callbacks (kicks), `reportKill`, `triggerCameraShake`, `updateRTT`;
- **the host player is excluded from kick policies** (idle- and RTT-kicks):
  its loopback *is* the room, so kicking it would kill the room for
  everyone. `hostSocketId` arrives in the options (from
  `lobbyConfig.create.hostSocketId`, value `'local'`, agreed with
  `LoopbackTransport`); guests are kicked normally;
- `isFull`/`maxPlayers` — the room-fullness gate for the Worker's port state
  machine: only humans count; bots yield their slot (a bot is kicked by
  `RoundManager.changeTeam` when a player joins a full team, and by
  `_freeSlotForHuman` when a human connects past the combined limit);
- `updateMaps(maps)` — updates the map catalog: `_maps`/`_mapList` are
  mutated in place (the same references are held by `RoundManager` and
  votes) — new data applies from the next map change on, with no
  `RoundManager` changes needed;
- map changes are tracked in the tick (`onMapChange` → `map_changed` to the
  main thread) — the master's lobby sees the room's current map;
- **Worker handoff**: `requestHandoff(cb)` (stops the game and collects
  handoff meta at the nearest round boundary), `completeHandoff(socketIds)`
  (in the new Worker: kicks anyone who didn't reconnect, resumes timers,
  starts the first round), `resumeAfterHandoff()` (rollback if the new
  Worker fails), and the constructor's `handoff` option (restoring instead
  of a cold start) — see "Worker handoff" below.

The client-facing `CONFIG_DATA` (port 0: base config + vote time + prediction
data) is assembled by `packages/engine/src/lib/buildClientConfig.js`.

## GameCoreAdapter (`packages/engine/src/host/GameCoreAdapter.js`)

Implements the physics/bots/packing surface consumed by
`RoundManager`/`SocketManager`/`HostGame`, backed by `GameCore`:

- **lifecycle/physics** → the core's ABI: `createMap` → `load_map` (the map
  is already scaled in JS by `RoundManager.scaleMapData`, so it's loaded
  with `scale: 1` — the core doesn't scale it again); `createPlayer`/
  `removePlayer` tell scripted participants and humans apart via
  `participant.isScripted` (`spawn_scripted_actor`/`remove_scripted_actor` —
  a tank + AI in the core — versus `spawn_actor`/`remove_actor`);
  `changePlayerData` → `reset_actor`;
- **input** → `apply_input` (seq is confirmed by the core in the frame's
  player block);
- **event projection**: after `step`, drains `take_events()` and hands each
  event to the injected game `eventRouter`
  (`games/tanks/src/host/coreEventRouter.js`) together with the meta services
  (`{ panel, vimp }`) — the event-type dictionary belongs to the game, the
  adapter doesn't know it. The tanks router maps `health`/`ammo` →
  `panel.updateUser(..., 'set')`, `activeWeapon` → `panel.setActiveWeapon`,
  `shake` → `HostGame.triggerCameraShake`, `kill` → `HostGame.reportKill`
  (health/ammo live in the core, the panel is their projection). The core
  operates on numeric ids (u32), meta keys by string — the router converts
  event ids to strings at this boundary;
- **packing**: `packBody` → `pack_body`, `packFrame` → `pack_frame` +
  `frame_bytes` (a copy from WASM memory, works on both the web and nodejs
  targets);
- **the first frame**: `getPlayersData` → the core's `players_data()` (a
  full player snapshot without draining accumulators — for
  `FIRST_SHOT_DATA`).

`TanksBotManager` (`games/tanks/src/host/TanksBotManager.js`) is the game's
scripted module: a thin bot manager registering participants and linking
them to `Stat`/`Panel` (AI, navigation, and the spatial grid live in the
core). It's built by the `createModules(ctx)` factory
(`games/tanks/src/host/createModules.js` — the future
`HostPlugin.createModules`); the engine calls the scripted-module contract:
`createMap`, `createBots(count, team?)`, `removeBots(team?)`,
`removeOneBotForPlayer(team)`, `getBots`, `getBotCount`,
`getBotCountsPerTeam`. Parameters come from the game config's `scripted`
(`namePrefix`, `defaultModel`).

**The tanks HostPlugin** (`games/tanks/src/host/index.js`; imported by the
engine only through `gameRegistry.static.js` — temporary static composition
until stage 6) — the whole game half of the host as a single
object: `gameConfig`, `authSchema`, `coreEventRouter`, `chatCommands`
(`/bot`), `systemMessages` (the `b:*` group), `createModules` (the bots
scripted module), `buildClientGameConfig()` (the game half of CONFIG_DATA).
It's consumed by `host.worker.js` (configs/auth) and `HostGame` (the event
router, commands, codes, modules).

## Meta modules (`packages/engine/src/host/meta/`)

The Worker's JS meta layer: game logic on top of the core's events. Modules
are dependency-injected and Worker-safe (isomorphic APIs only —
`Date`/`Math`/`performance`/`setTimeout`/`queueMicrotask`, no Node globals).

### ParticipantManager — the participant registry (`meta/player/`)

**The single source of truth for participants** (humans + scripted
participants/bots):

- `Participant` classes (base: `gameId`, `name`, `model`, `team`, `teamId`,
  `status`) → `HumanParticipant` (`socketId`, `isReady`, `currentMap`,
  `isWatching`, `watchedGameId`, `forceCameraReset`, `pendingShake`,
  `lastActionTime`, `lastInputSeq`) and `BotParticipant`;
- scripted vs. human is told apart with `isScripted`/`isNetworked` getters,
  **not** by id shape: humans and scripted participants share a single numeric id
  space (the generator picks the lowest free id);
- API: `createHuman`/`createScripted`/`remove`/`get`/`getAll`/`getHumans`/
  `getScripted`/`getNetworkedReady` (ready to be broadcast to), `checkName`
  (name deduplication; a scripted name is the game config's
  `scripted.namePrefix` + id), team sizes (`getTeamSize`/`addToTeam`/
  `resetTeamSizes`), the active-watch list (`addActive`/`removeActive`/
  `getActiveList`/`replaceWatched`), the `maxPlayers` limit (`totalCount`).

### `meta/core/` managers

**RoundManager** — rounds, teams, maps. Owns state: `currentMap`,
`currentMapData`, `scaledMapData`, `isRoundEnding`, `removedPlayersList`.

- `createMap()` — stops timers, resets Panel/Stat/Vote and teams, recreates
  the world (in the core, through `GameCoreAdapter`), sends `CLEAR` to
  everyone, moves everyone to spectators, broadcasts the map, restarts
  timers, recreates bots;
- `initiateNewRound()`/`_startRound()` — clears the active list, recreates
  the map, applies deferred team changes, resets the panel, sends a full
  stat table, the key set matching status, respawns and creates tanks;
- `changeTeam(gameId, team)` — checks for a free respawn (may evict a bot),
  honors the grace period at round start, otherwise defers the change to the
  next round;
- `changeName`, `changeMap` (a player-suggested map vote), `forceChangeMap`,
  `onMapTimeEnd` (a vote for the next map on timer; if nobody votes, the
  current map is extended);
- `reportKill(victimId, killerId)` — stats (frags/deaths/friendly fire),
  moving spectators to the killer, `_checkTeamWipe` → ends the round
  (awards the win, plays victory/defeat sounds, restarts after
  `roundRestartDelay`);
- `setActive`/`setSpectator` — player↔spectator transitions, sending the key
  set and the panel.

**CommandProcessor** — parses chat commands (messages starting with `/`).
The engine core: `/name <nick>`, `/timeleft`, `/mapname`, `/nr` (new round,
**dev mode only**); game commands are registered via
`registerCommand(name, handler)` and receive the meta context —
`handler(ctx, gameId, args)`. Tanks registers `/bot`
(`games/tanks/src/host/botCommand.js`):

```
/bot 5 team1   # spawn 5 bots into team1
/bot 10        # spawn 10 bots, spread evenly
/bot 0 team2   # remove team2's bots
/bot 0         # remove all bots
```

`/bot` is only available to active players; if more than one human is
active, a vote runs instead of immediate execution (category
`botManagement`). An unknown command produces a "Command not found" system
message. (`/ban` never reaches the host — the client intercepts it and sends
the report straight to the master, see [master.md](master.md).)

**VoteCoordinator** — creates votes on top of the `Vote` module:
`canCreateVote` (topic cooldown check), `createVote` (payload + result
callback + participant list), `reset`. Topic cooldown — `timeBlockedVote`
(30 s).

### `meta/modules/` modules

- **`Panel`** — per-user HUD: the schema from `game:panel` (`fields` —
  health/w1/w2, `activeKey` — the active weapon's key),
  `updateUser(gameId, param, value, op)` accumulating `pendingChanges`,
  `processUpdates()` emits only changes once per snapshot tick (strings
  `'key:value'`, round time `t` — on every second change),
  `getFullPanel`/`getEmptyPanel`, `setActiveWeapon` (writes the schema's
  `activeKey`, `wa` for tanks), `hasResources`/`getCurrentValue`. Authoritative health/ammo live in the
  core — the panel is filled by a projection of its events
  (`GameCoreAdapter`).
- **`Stat`** — the scoreboard: row (body) and team totals (head) per the
  `game:stat` config; `addUser`/`removeUser`/`moveUser`/`updateUser`/
  `updateHead`; `getLast()` — the delta for this tick, `getFull()` — full
  state (on join).
- **`Chat`** (`meta/modules/chat/`) — user messages and system templates
  (`systemMessages.js`): `push` (broadcast), `pushSystem`/
  `pushSystemByUser` (templated `'group:number:params'`), queues
  `shift`/`shiftByUser`. The code registry holds the engine groups
  `s`/`v`/`m`/`c`/`n`; game codes are registered via `registerCodes` (tanks
  brings the `b:*` group, `games/tanks/src/host/systemMessages.js`); the
  template texts live on the client.
- **`Vote`** — vote mechanics: a queue (a new vote during an active one
  isn't rejected, it waits), lifetime `voteTime`, list pagination (more
  than 7 options gets Back/More pages), tie resolution by random pick,
  per-user delivery (`pushByUser`/`shiftByUser`), `addInVote`, `getResult`.
- **`TimerManager`** — every game timer: the game loop (`onShotTick`,
  ~120 Hz), round (`onRoundTimeEnd`), map (`onMapTimeEnd`), RTT pings, idle
  checks, deferred calls (round restart, map change);
  `getRoundTimeLeft`/`getMapTimeLeft`.
- **`RTTManager`** — ping tracking: `scheduleNextPing()` (who to ping and
  with what id), `handlePong` (latency, EMA), kick callbacks at
  `maxLatency`/`maxMissedPings`. Ping/pong travel over the unreliable state
  channel — the measurement isn't skewed by the reliable meta stream's
  retransmissions.

### SocketManager (`meta/SocketManager.js`)

The single send point: JSON `_send(socketId, port, data, reliable)` and
binary `sendShot(socketId, frameBuffer, reliable)`; typed methods
(`sendConfig`, `sendMap`, `sendPanel`, `sendStat`, `sendChat`, `sendVote`,
`sendKeySet`, `sendGameInform`, `sendTechInform`, …) and `close` with a
technical code. Game parametrization comes from the game config:
`sendSoundCue(socketId, cue)` maps engine events
(`roundStart`/`victory`/`defeat`/`frag`/`death`) to the game's sound names
via `soundCues`, and `sendFirstVote` sends the `initialVote` vote (team
selection in tanks). Composite sends: `sendFirstShot` (first frame + full stat +
empty panel + key set 0), `sendPlayerDefaultShot`/
`sendSpectatorDefaultShot`. Transport is abstracted: in the Worker, wire
sockets sit underneath (`makeWorkerSocket`), and the `reliable` flag
classifies the meta/state channels.

## Main thread: router and transports (`packages/engine/src/client/network/`)

- **`HostController`** — spawns the Worker (from `workerUrl` in the master's
  manifest; without it, a bundled `new Worker(new URL('host.worker.js'),
  { type: 'module' })`; the factory is injected for tests), sends
  `init(room)`, routes `to_client`/`close_client` to registered clients, and
  forwards incoming messages to the Worker. Shared by loopback and remote
  clients; `onReady` (Worker is up) is the moment the room registers with
  the master (not called again during a handoff); `swapWorker(url)` — the
  Worker handoff (see the section of the same name).
- **`LoopbackTransport`** — the host-player transport: implements the
  `WebRtcManager` interface (`publisher` with `message`/`close`,
  `send`/`close`), but data travels through `HostController` → the Worker as
  postMessages. Transparent to client code; the `reliable` flag is ignored
  (loopback is reliable and ordered by nature).
- **`HostConnectionManager`** — the WebRTC answerer for remote clients (a
  mirror of `WebRtcManager`, which is the offerer on the client). Through
  `SignalingClient` it catches `webrtc_offer`, creates a `RTCPeerConnection`
  per client, accepts the `meta`/`state` channels in `ondatachannel`, sends
  `webrtc_answer` and exchanges ICE. Once both channels are open, it brings
  the client's connection up in the Worker (`HostController.open` →
  `connect`). Answers the client's signaling `ping_host` (`pong_host` — a
  latency measurement in the lobby).

### Channel classification and backpressure

An outgoing Worker frame is routed by channel: **events → `meta`**
(reliable-ordered), **pure positions → `state`** (unreliable). The decision
is driven by a `reliable` flag that `HostGame` computes per user:
`core.body_has_events()` (tracers/bombs/explosions/removals in the body — a
stateless getter on the core, doesn't change `pack_body`'s signature) ∨
`forceReset` on the camera ∨ `shake`. The JSON protocol (ports
`[portId, payload]`) is always over `meta`. The flag flows through
`SocketManager.sendShot(socketId, buffer, reliable)` → the worker socket →
`to_client` → the answerer. **Backpressure**: before sending a positional
frame, the state channel's `bufferedAmount` is checked; above the threshold
the frame is dropped (the next one compensates), `meta` is never dropped.

### Registering with the master

On `onReady` the host sends `register_host` (name/limit/map — the actual map
comes from the Worker's `ready`) and starts a heartbeat (`update_host` every
`lobbyConfig.create.heartbeatInterval` ms, less than the master's
`heartbeatTimeout`). `currentPlayers` = 1 (the host player) + the number of
WebRTC peers, refreshed as clients join/leave (`onPeersChange`); `mapName` —
on a map change (`map_changed` from the Worker). The host player leaving
kills the room: `handleDisconnect` stops the heartbeat, closes peers
(`HostConnectionManager.destroy`) and the Worker (`HostController.destroy`).

**Signaling reconnect**: the host's signaling WS needs to stay up
permanently (offers, heartbeat, listing) — on a drop, `main.js` reconnects
with exponential backoff (`lobbyConfig.reconnect`), and a fresh `welcome`
re-registers the room (a new `hostId` is acceptable). Established P2P
connections aren't affected by a signaling drop. In its `host_registered`
reply the master sends `mapsVersion` and `codeVersion` — a mismatch against
the versions the room was raised on triggers a map catalog re-read (see
below) / a Worker handoff.

### Dynamic maps

A room starts on the master's current maps rather than the ones baked into
the bundle: `connectAsHost` fetches `GET /maps/manifest.json` plus every map
and passes them to the Worker's `init` (`room.maps`; catalog unavailability
is non-critical — falls back to the bundled maps). Updating on the fly:
`host_registered.mapsVersion` (after a reconnect) or the master's
`update_available` signal → `refreshHostMaps` → fetch the catalog →
`HostController.updateMaps` → the Worker's `update_maps` →
`HostGame.updateMaps`. New data applies **from the next map change on**
(the regular `RoundManager.createMap` path: scaling in JS → the core's
`load_map` with `scale: 1`); the vote map list updates immediately. Guests
need no changes — the host sends them the map over port 3.

### Worker handoff

Updating the code of a live room: on a new deploy, the host's Worker is
swapped for a new bundle **without dropping WebRTC connections** —
`RTCPeerConnection` lives in the main thread and doesn't notice the Worker
swap. A **soft handoff at a round boundary** is implemented: the core isn't
dumped (the world is recreated from scratch at the start of every round
anyway — `RoundManager._startRound`), and only JS meta is carried over;
clients see a regular round start. `serialize_state`/`deserialize_state`
remain in the core's ABI for future use (mid-round handoff) but don't
participate here.

**Detecting a new version.** The room's Worker is created from the `url` in
the master's `GET /worker/manifest.json` (`lobbyConfig.worker.manifestUrl`)
— Vite hashes asset names, so after a deploy the old page's bundle URL
disappears from what's served; the manifest version is remembered
(`hostCodeVersion`). A deploy restarts the master → the signaling WS drops →
a regular reconnect → re-register → `host_registered.codeVersion` differs
from ours → `refreshHostWorker()`: re-fetches the manifest →
`HostController.swapWorker(url)`. A version whose swap failed is remembered
and not retried on every re-register. The `update_available { codeVersion }`
push from the master is also handled (for future use). In dev the manifest
is empty (`version: null`) — code updates are disabled, the Worker is
bundled.

**Swap protocol** (`HostController.swapWorker`):

1. the old Worker receives `prepare_handoff` → `HostGame.requestHandoff`
   installs a callback in `RoundManager`; the game continues until the
   nearest round boundary (a single funnel, `initiateNewRound`: the round
   timer, a deferred restart after a team wipe, a restart on a team change);
2. at the boundary, the old Worker stops the game (`stopGameTimers` + idle)
   and sends `handoff_state { state }`; from this point `HostController`
   buffers incoming client messages (a capped queue);
3. the main thread creates a new Worker from the new version's URL and sends
   it `init { room, handoff: state }` (`room.maps` carries the current map
   catalog);
4. the new Worker restores the room (see below) and replies `ready` →
   `HostController` reconnects every live client with internal `connect`
   calls (port state machines come up past the handshake), delivers the
   buffered queue, sends `handoff_complete`, and tears down the old Worker
   (`terminate`);
5. `handoff_complete` in the new Worker: `HostGame.completeHandoff` kicks
   restored participants whose `connect` never arrived (dropped during the
   pause), resumes timers (the map — with its time remaining,
   `TimerManager.startMapTimer(duration)`), and starts the first round —
   clients get the usual `sendClear`/respawn/round start (`sendSoundCue`+`sendGameInform`).

**Handoff meta** (`HostGame._collectHandoff`, a versioned format —
`HANDOFF_VERSION`): human participants with `isReady` (gameId/socketId/
name/model/team) and bots (with their original gameId — the single numeric
id space is preserved), the entire `Stat` score, the current map plus its
remaining time, the frame `seq` (snapshot numbering continues — clients'
interpolators aren't disturbed). **Deliberately not carried over**: chat
history, active votes and cooldowns, RTT stats, panel (health/ammo live in
the core and reset at round start), guests who hadn't finished the
handshake (their scoreboard rows are wiped, and such a guest goes through
the handshake again on the client).

**Fault tolerance**: a new Worker's init failure (`error`: incompatible
`HANDOFF_VERSION`, a map left the catalog, a WASM failure) or a timeout
(15 s) → the new Worker is torn down, and `resume` is sent to the old one
(`resumeAfterHandoff`: restoring timers + resuming the interrupted round) —
**the room keeps living on the old code version**, and players notice
nothing. Concurrent swaps are prevented (a guard in `main.js` and in
`HostController`).

In the lobby (`packages/engine/src/client/main.js`):

- **joining** — a server card → `connectToHost(hostId)` → `WebRtcManager`
  (offerer);
- **creating a server** — the button/name field in the lobby
  (`#lobby-host`/`#lobby-name`, `packages/engine/src/config/lobby.js`) → `connectAsHost(room)`
  → `HostController` + Worker + `LoopbackTransport` (the host player) +
  `HostConnectionManager` (remote clients) + registering with the master.

From there client code is identical (the transport is abstracted). The host
leaving kills the room (no host migration) — same as for a regular client:
`handleDisconnect` stops rendering and returns to the lobby.

## Tests

Host and meta module tests live in `tests/host/`:

- `GameCoreAdapter.test.js` — unit tests against a fake core: mapping
  commands to the ABI, telling bots and humans apart, projecting events into
  the panel/facade, camera flags.
- `HostGame.test.js` — integration on top of the **real** core (`pkg-node`,
  `describe.skipIf` without a build): onboarding, an active player with a
  player block, movement, shooting (tracer + ammo), bots, `players_data`,
  `removeUser` (a null marker in the frame), the room limit (`isFull`), the
  host player's kick exclusion, `updateMaps`/`onMapChange`, the Worker
  handoff (collecting meta at a round boundary, restoring
  participants/score/`seq`, `completeHandoff` kicking anyone who didn't
  reconnect, `resumeAfterHandoff`, refusal on an incompatible version/a map
  gone from the catalog); binary frames are decoded by the client core
  (`ClientCore.decode_frame`; the scaffold is `tests/host/harness.js` with
  `FakeSocketManager`).
- `LoopbackTransport.test.js` — unit tests against a fake Worker:
  `HostController` (routing, a connect queue before `ready`, the `reliable`
  flag, `error`/`map_changed`/`updateMaps`; the handoff — `workerUrl`,
  buffering while paused, connect/flush/`handoff_complete` ordering, rollback
  to the old Worker on `error`, the concurrent-swap guard) and
  `LoopbackTransport`.
- `HostConnectionManager.test.js` — unit tests against fake peers/channels:
  offer→answer, meta/state channels, reliable classification, backpressure,
  ICE, the signaling pong, closing, an open/close race, cleanup on SDP
  failure, the non-fatal nature of a transient `'disconnected'`.
- meta module unit tests: `RoundManager`, `CommandProcessor`,
  `VoteCoordinator`, `ParticipantManager` (including the handoff's
  `restoreHuman`/`restoreBot`), `Chat`, `Vote`, `Stat` (including
  `serialize`/`restore`), `Panel`, `TimerManager`, `RTTManager`,
  `SocketManager`.
- related: `tests/client/network/SignalingClient.test.js` (the host's
  outgoing `register_host`/`update_host`/`webrtc_answer`/`pong_host`),
  `tests/core/core.test.js` (`body_has_events()` — meta/state
  classification).

## Build

The Worker loads `core/pkg-web` (the web target of the core). The production
build (`npm run build`) builds it itself (`core:build:web`) — this requires
the Rust toolchain (see [getting-started.md](getting-started.md),
[deployment.md](deployment.md)). For dev, `core/pkg-web` must be built by
hand once (`npm run core:build`).

## Manual run checklist

Vitest doesn't reproduce real WebRTC reordering, so an end-to-end match check
is manual, in the browser:

```bash
npm run core:build     # web target of the core for the Worker (once)
npm run dev            # master: lobby + signaling, https://localhost:3002
```

Open `https://localhost:3002`, "Create server" → the host tab. Remote
clients are other tabs/machines: lobby → the room shows up in the list →
joining.

Checklist:

- [ ] your own tank's movement (prediction/reconciliation without jitter);
- [ ] `w1`/`w2` shooting, damage, death and respawn, team change (`/bot`, menu);
- [ ] bots: spawn, patrol, combat (AI in the core);
- [ ] chat, votes (map/team change), stats, panel — all update;
- [ ] a round: start/timer/team victory/new round;
- [ ] a full 8-player + bots match end-to-end;
- [ ] a drop: the host leaving kills the room → remote clients redirect
      to the lobby (`handleDisconnect`); there's no host migration.

**The Worker handoff** can only be checked on a built `dist` (the code
manifest is empty in dev): `npm run build` → run the master in prod mode →
create a room + connect a guest → edit the host code → `npm run build:app`
→ restart the master → wait for the host's reconnect/re-register:

- [ ] at a round boundary the room migrates to the new Worker (console:
      `[worker] room migrated to code version …`);
- [ ] P2P connections stay alive, the guest sees a normal round start;
- [ ] the scoreboard's score and names are preserved, bots are in place, the
      map's `/timeleft` keeps counting down (not reset);
- [ ] chat/votes keep working after the migration.

---

[← Previous: Master Server](master.md) · [Next: Rust Core →](core.md)
