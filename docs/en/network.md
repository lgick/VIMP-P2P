# Client ↔ Host Synchronization

The game protocol between the client and the host uses two message formats:

- **JSON**: `[portId, payload]` — every channel except the snapshot.
  `portId` is a numeric id from [packages/engine/src/config/wsports.js](../../packages/engine/src/config/wsports.js) (the source of truth).
- **Binary**: the game snapshot frame (port `5`, SHOT_DATA) — an
  `ArrayBuffer` packed by the core (`core/src/snapshot.rs`).

The client tells the formats apart by incoming data type: a string → the
JSON dispatcher `socketMethods[portId]`
([packages/engine/src/client/main.js](../../packages/engine/src/client/main.js) `handleMessage`); an
`ArrayBuffer` → `ClientCore.push_frame` (decoding and the interpolation
buffer live in the client core, see
[core.md](core.md#clientcore--the-cores-client-mode)).

## Transport (WebRTC)

The game transport is a direct P2P connection between the client and the
browser host (two `RTCDataChannel`s), not a WebSocket. The port protocol and
formats themselves are unchanged — only the transport is different. The
client's network layer — [packages/engine/src/client/network/](../../packages/engine/src/client/network/):

- **`SignalingClient`** — the master server's signaling WebSocket
  ([master.md](master.md)): coordinates setting up P2P (welcome with
  `iceServers`, SDP offer/answer and ICE candidate exchange, signaling
  ping/pong, reports). No game traffic flows over it.
- **`WebRtcManager`** — the P2P transport: two data channels to the host.
  - **`meta`** (reliable-ordered): the entire JSON protocol
    `[portId, payload]` (ports 0–4, 6–17) **plus** binary frames carrying
    one-shot events (`w1`/`w2`/`w2e`, entity creation/removal, camera
    clear/shake). Delivery must be guaranteed — losing such a frame
    permanently loses an explosion or an uncreated tank.
  - **`state`** (unreliable-unordered, `ordered: false, maxRetransmits:
    0`): purely positional binary frames (`m1`/`c1`/`c2` + camera + player
    block). Losing one is compensated by the next frame.
  - meta/state classification happens on the host side while packing (a
    frame with event blocks → meta, otherwise → state). The client
    receives data from both channels as a single stream (`handleMessage`)
    and doesn't distinguish their source.

The client is the initiator (offerer): it creates the channels and the SDP
offer, exchanges SDP/ICE with the host through `SignalingClient`. Outgoing
client messages (ports 0–8 client→server) are control messages and travel
over the reliable `meta` channel.

**The host is the answerer** ([host.md](host.md)): `HostConnectionManager`
in the host tab's main thread catches `webrtc_offer` through
`SignalingClient`, creates a `RTCPeerConnection` per client, sends
`webrtc_answer` + ICE. meta/state classification works like this: `HostGame`
computes a per-user `reliable` flag = `core.body_has_events()` (event blocks
in the body — a stateless getter on the core, doesn't change `pack_body`) ∨
`forceReset` ∨ `shake`; the flag flows through
`SocketManager.sendShot(socketId, buffer, reliable)` to the main thread,
which picks the channel. Backpressure: a positional frame is dropped when
the state channel's `bufferedAmount` overflows, `meta` never is. The host
registers the room with the master (`register_host` + heartbeat
`update_host`).

**The interpolator's buffer** was switched from "push at the end" (only
correct with TCP ordering) to **insertion by `seq`** with deduplication:
frames from the unreliable `state` channel can arrive out of order and be
duplicated. Events from a late reliable frame, whose `serverTime` is
already behind `renderTime`, are emitted immediately on the next
`sample()` — "exactly once" is preserved (see
[client.md](client.md#client-core-clientcore)).

**The `/ban` report** travels **outside the port protocol**: the client
intercepts the command before sending it to the host and sends
`report_host { hostId, reason }` over the master's signaling WS
(`SignalingClient.reportHost`), bypassing the P2P channel to the host. The
reason: the host runs its own `CommandProcessor` and could filter out a
complaint about itself. Ban logic lives on the master
([master.md](master.md#ban-social-moderation)).

## Ports

### Server → client

| Port | Name | Format | Description |
| :--: | --- | :--: | --- |
| 0 | `CONFIG_DATA` | JSON | The client config (a merge of `packages/engine/src/config/clientDefaults.js` + `games/tanks/src/config/client.js` + `prediction`) |
| 1 | `AUTH_DATA` | JSON | Auth form data |
| 2 | `AUTH_RESULT` | JSON | Auth errors (or `null`) |
| 3 | `MAP_DATA` | JSON | Map data |
| 4 | `FIRST_SHOT_DATA` | JSON | The game's first frame (one-shot, bypasses the interpolation buffer): `[gameSnapshot, 0, serverTime, 0]` |
| 5 | `SHOT_DATA` | **binary** | The game's snapshot frame (see below) |
| 6 | `SOUND_DATA` | JSON | A system sound name (`roundStart`, `victory`, `frag`, …) |
| 7 | `GAME_INFORM_DATA` | JSON | On-screen game messages (`[code, params?]`: team victory, round start, game over) |
| 8 | `TECH_INFORM_DATA` | JSON | "Black screen" technical messages (`[code, params?]`: server full, loading, kicks); no data — hide the screen |
| 9 | `MISC` | JSON | Miscellaneous data (`{key, value}`; currently — a name change in localStorage) |
| 10 | `PING` | JSON | A ping id for RTT measurement |
| 11 | `CLEAR` | JSON | A full or partial (by `setId`) canvas clear |
| 12 | `CONSOLE` | JSON | Unused (reserved for console.log output) |
| 13 | `PANEL_DATA` | JSON | The HUD panel (per-user, only on change) |
| 14 | `STAT_DATA` | JSON | Stats (broadcast, only on change) |
| 15 | `CHAT_DATA` | JSON | A chat message (broadcast or personal) |
| 16 | `VOTE_DATA` | JSON | Vote data |
| 17 | `KEYSET_DATA` | JSON | The active key set: `0` — spectator, `1` — player; sent on a status change |

### Client → server

| Port | Name | Description |
| :--: | --- | --- |
| 0 | `CONFIG_READY` | Config received, canvas ready |
| 1 | `AUTH_RESPONSE` | Auth form data (`{name, model}`) |
| 2 | `MODULES_READY` | Client modules initialized |
| 3 | `MAP_READY` | Map loaded and built |
| 4 | `FIRST_SHOT_READY` | First frame applied, ready for the game loop |
| 5 | `KEYS_DATA` | Input: the string `"seq:action:name"` (see below) |
| 6 | `CHAT_DATA` | A chat message / command |
| 7 | `VOTE_DATA` | A vote response `[voteName, value]` or a list request (`'maps'`, `'teams'`) |
| 8 | `PONG` | A reply to PING (the ping id) |

The host enables client ports in stages (the port state machine in
[packages/engine/src/host/host.worker.js](../../packages/engine/src/host/host.worker.js)): only
`CONFIG_READY` is active before auth, `AUTH_RESPONSE` after, and the rest
once the user is created. A message on an inactive port is ignored.

## Connection lifecycle

The browser host runs the port handshake over the `meta` channel (origin
checks are the master signaling WS's job — there's none in the P2P
transport):

```
meta+state channels open → connect in the Worker
  → CONFIG_DATA → CONFIG_READY
  → AUTH_DATA → AUTH_RESPONSE → AUTH_RESULT
  → createUser (spectator) → MODULES_READY → MAP_DATA → MAP_READY
  → FIRST_SHOT_DATA (+ full STAT/PANEL/KEYSET) → FIRST_SHOT_READY
  → the user joins the game loop (SHOT_DATA, 30 frames/sec) → removeUser on close
```

Details:

- **A full room**: no waiting queue — a full room (humans against
  `maxPlayers`; bots yield their slot) replies with `TECH_INFORM_DATA` and
  code `roomFull` and closes the connection (code `4006`); the host player
  is excluded from kick policies (see [host.md](host.md)).
- **Close codes**: `4003` a latency kick, `4004` a missed-pings kick,
  `4005` an idle kick, `4006` a full room. Closing a data channel carries
  no code/reason — the reason is delivered as a separate
  `TECH_INFORM_DATA` over `meta` before closing.
- After `FIRST_SHOT_READY` the user gets a team-selection vote
  (`teamChange`) and starts receiving frames.

## Channel split: the hot snapshot vs. meta

On every snapshot tick (`networkSendRate: 4` → 30 packets/sec) the host
sends a binary frame on port `5` to **every user ready to play**. Meta data
travels **its own JSON channels, only on change** (see
`HostGame._onShotTick` in [packages/engine/src/host/HostGame.js](../../packages/engine/src/host/HostGame.js)):

- **panel (13)** — per-user; an array of `'key:value'` strings (`t` —
  round time, `h` — health, `w1`/`w2` — ammo, `wa` — the active weapon).
  A full panel is sent on joining the game, an empty one (keys only) to a
  spectator.
- **stat (14)** — broadcast, a delta of changes (format below).
- **chat (15)** — a broadcast or personal message (`shiftByUser`).
- **vote (16)** — a broadcast or personal vote.
- **keyset (17)** — sent precisely on a spectator↔player status change.

## Binary snapshot frame (port 5)

The codec lives entirely in the Rust core: packing —
`packages/engine/core/src/snapshot.rs` (host side), decoding —
`packages/engine/core/src/client/unpack.rs` (client side); both sides live
in the same crate — layout mismatches are impossible by construction. The
key registry is game data:
[games/tanks/src/config/snapshot.js](../../games/tanks/src/config/snapshot.js)
(`gameConfig.snapshot`); the format version stays with the engine —
[packages/engine/src/config/opcodes.js](../../packages/engine/src/config/opcodes.js)
(`SNAPSHOT_FORMAT_VERSION = 3`). Big-endian, a manual block layout with no
libraries. On a version mismatch the client drops the frame.

The server packs the **body** (the broadcast part) once per tick
(`packBody`), then assembles a `packFrame` per user = a personal header +
a copy of the body.

### Frame layout (v3)

| Field | Type | Description |
| --- | --- | --- |
| `port` | Uint8 | Always `5` (SHOT_DATA) |
| `version` | Uint8 | `SNAPSHOT_FORMAT_VERSION` |
| `seq` | Uint32 | An incrementing frame number |
| `serverTime` | Float64 | The server's `Date.now()` |
| `cameraFlags` | Uint8 | bit0 hasCamera, bit1 forceReset, bit2 hasShake, bit3 hasPlayer |
| camera | 2×Float32 | `[x, y]` (if hasCamera) |
| shake | Uint8 len + ASCII | The string `'intensity:duration'` (if hasShake) |
| player block | see below | Only for the playing user (if hasPlayer) |
| body blocks | to the end of the buffer | `Uint8 keyId` + content per `kind` |

**Player block** (the foundation of client-side prediction): `gameId`
(Uint8), `lastInputSeq` (Uint32), the tank's exact state as Float32×8 —
`x, y, angle, vx, vy, angvel, gunRotation, throttle` (**not rounded** —
precision is needed by the predictor), a turret-centering flag (Uint8).

### Entity blocks (`kind` from the game's snapshot schema)

| Key | id | kind | Data format |
| :--: | :--: | --- | --- |
| `m1` | 1 | `tanks` | `{gameId: [x, y, angle, gunRotation, vx, vy, engineLoad, condition, size, teamId] \| null}`; `null` — remove from the canvas |
| `w1` | 2 | `tracers` | array `[startX, startY, endX, endY, bodyX, bodyY, wasHit, shooterId]` |
| `w2` | 3 | `bombs` | `{shotId(base36): [x, y, angle, size, time, ownerId] \| null}` |
| `w2e` | 4 | `explosions` | array `[x, y, radius]` |
| `c1`/`c2` | 5/6 | `dynamics` | `{'dN': [x, y, angle]}` — dynamic map elements |

Every float is originally rounded by the host to 2 decimals; the decoder
restores values by rounding the Float32 again (the player block isn't
rounded). Weapon events carry the author's id (`shooterId`/`ownerId`,
added in v3) — the shooter uses it to suppress authoritative duplicates of
locally spawned shots (the client core, `games/tanks/core/src/client/shot.rs`).

Each schema entry is more than `{id, kind}`: `class` (`'hot'` —
interpolated by the client between frames, `'event'` — one-shot, delivered
as-is in the frame) and `fields` — the row's field schema (`name`, `ty`:
`f32`/`u8`/`u16`/`u32`, `interp`: `lerp`/`lerpAngle`/`discrete`, for
`class: 'hot'` only). `fields` must match the key's Row struct in
`packages/engine/core/src/snapshot.rs` exactly in field count and type
order (`GameCore`/`ClientCore` reject the constructor on a mismatch).

When adding a new weapon/entity, its snapshot key **must** be registered in
the game's schema (`games/tanks/src/config/snapshot.js`) — with a full
`fields` list for its `kind` — or `pack_body`/the core constructor will
throw. If the existing `kind` values don't fit the data shape, add a new
block layout to `packages/engine/core/src/snapshot.rs` +
`packages/engine/core/src/client/unpack.rs` and bump the format version.
See [extending.md](extending.md#new-weapon).

## Input format: `"seq:action:name"`

The client sends every key event as a string on port `5` (client → server):

- `seq` — an incrementing input number (Uint32), written to the local
  predictor history;
- `action` — `down` | `up`;
- `name` — a command (`forward`, `fire`, `nextPlayer`, …).

The server keeps the user's `lastInputSeq` and returns it in the frame's
player block — this tells the client which inputs the authoritative state
already accounted for, so it only replays (reconciles) later ones. Details
— [client.md](client.md#client-core-clientcore).

For a spectator, the same strings are handled by the server as switching
the watched player (`nextPlayer`/`prevPlayer`).

## RTT (ping/pong) and kicks

`TimerManager` broadcasts a `PING` (port 10) with an id every
`rttPingInterval` (3 s); the client replies with `PONG` (port 8). Both
sides send these over the **unreliable `state` channel** (the only JSON
traffic outside `meta`): the measurement reflects the real network path,
not the reliable `meta` stream with its retransmissions; a lost ping is
tolerated by `maxMissedPings`.
[RTTManager](../../packages/engine/src/host/meta/modules/RTTManager.js) computes latency,
publishes it to stats (the `latency` column), and kicks:

- at a smoothed (EMA) `latency > maxLatency` (1000 ms; a threshold sized
  for P2P hosting over home connections and spikes at a map change) —
  code `4003`;
- at `maxMissedPings` (5) consecutive missed replies — code `4004`.

**Close reason**: unlike a WebSocket, a data channel carries no
code/reason on close — the host's Worker delivers the reason (kick, full
room) as a separate `TECH_INFORM_DATA` over `meta` right before closing;
the client shows it instead of the generic "Host left".

## Meta data formats

### Panel (port 13)

An array of `'key:value'` strings, e.g. `['t:97', 'h:100', 'w1:200',
'wa:w1']`. Only changed keys are sent; `t` (round time, seconds) — on
every second change. An empty panel (for a spectator) — time plus a list
of keys with no values (containers are hidden).

### Stats (port 14)

`statArray = [tBodies, tHead, fullUpdate?]` (assembled by
[packages/engine/src/host/meta/modules/Stat.js](../../packages/engine/src/host/meta/modules/Stat.js)):

- **`statArray[0]`** — table rows: `[row id, table number, cell array |
  null, tbody number]`. `null` instead of cells — remove the row; an empty
  string in a cell — clear the value; `undefined`/omitted — don't change.
- **`statArray[1]`** — headers: `[table number, cell array, tHead row
  number]`.
- **`statArray[2]`** — a full-update flag (boolean, optional).

A player row's cells: `[name, status, score, deaths, latency]` (order —
the `key` from `game:stat`).

### Chat (port 15)

- A user message: `[text, author name, teamId]`.
- A system message: the string `'group:number:comma,separated,params'` —
  the client builds text from the `messages` templates in its own config
  (groups `s`, `v`, `m`, `c`, `n`, `b`).

### Vote (port 16)

The server sends `payload`:

- `name` — the vote's name/type (the client looks up a template in
  `client.js → modules.vote.params.templates`);
- `params` — optional; strings substituted into the title's `{0}`, `{1}`
  placeholders;
- `values` — optional; an array of ready-made options **or** a command
  string (`'maps'`, `'teams'`) — the client requests the current list from
  the server (port 7 client → server).

The client's reply: `[voteName, selectedValue]`. Requesting a dynamic
list: the string `'maps'` | `'teams'`.

---

[← Previous: Client Modules](client.md) · [Next: Configuration →](configuration.md)
