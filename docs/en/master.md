# Master Server (P2P lobby and signaling)

The master server (`src/master/`) is the central hub of the P2P architecture:
it holds the registry of active rooms (browser hosts), serves their list over
REST, and routes WebRTC coordination (SDP offers/answers, ICE candidates)
between clients and hosts. **It carries no game logic** — only connection
coordination.

`src/master/main.js` is the **project's entry point** (the legacy
authoritative game server has been fully removed).

## Running

```bash
npm run dev       # dev: https://localhost:3002 (nodemon + ViteExpress)
npm start         # production: plain HTTP behind Nginx, reads .env
```

- dev: HTTPS with local certificates from `.certs/`, client static assets served by ViteExpress. Port `3002` (`3001` — Vite HMR).
- production: plain HTTP behind Nginx; `VIMP_DOMAIN` is required, the port comes from `VIMP_MASTER_PORT`.

Configuration — [src/config/master.js](../../src/config/master.js), described in [configuration.md](configuration.md#srcconfigmasterjs).

## Modules

| Module | Responsibility |
| --- | --- |
| `src/master/main.js` | entry point: Express + REST, HTTPS/HTTP server, signaling `WebSocketServer`, periodic cleanup of stale rooms |
| `src/master/HostRegistry.js` | room registry `Map<hostId, HostSession>`: registration (max 1 room per IP), heartbeat/`lastSeen`, reports, selection for `GET /servers` |
| `src/master/SignalingServer.js` | signaling WebSocket: connection lifecycle, WebRTC message routing, ping rate limiting |
| `src/master/MapCatalog.js` | map catalog: an in-memory JSON representation of `src/data/maps` plus a content version hash; served to hosts without a rebuild |
| `src/master/WorkerCatalog.js` | worker bundle catalog: a content version hash of `dist/assets/host.worker-*.js` plus its URL; hosts use it to detect a new code version and swap the Worker via a handoff |
| `src/lib/rateLimiter.js` | a shared fixed-window rate limiter (event limit per key per interval) |

`HostSession`: `hostId` (uuid), `name`, `maxPlayers` (clamped to `host.maxPlayersLimit`, the target room size — 8), `currentPlayers`, `mapName`, `region`, `ip`, `status` (`online`/`banned`), `reportCount` + `reporters` (a `Map` reporter → timestamp: report uniqueness and window), `reportReasons` (report reasons, an audit trail — never exposed, capped), `lastSeen`.

The region is determined from an Nginx/CDN header (`regionHeader`, `x-region` by default; e.g. `CF-IPCountry`) — chosen over `geoip-lite` for its low memory footprint. Without the header the region is `unknown`.

## REST API

### GET /servers

Query params: `offset`, `limit`, `region`, `search`. Logic (in priority order):

1. `search` — substring search in the room name, case-insensitive; all other params are ignored.
2. If the total room count is ≤ `servers.regionThreshold` (15), the entire list is returned with no filters or pagination.
3. Otherwise — filter by `region` (if given) and slice `offset`/`limit` (`limit` defaults to 10, max 50).

Banned rooms (`status !== 'online'`) are excluded from the results. Response:

```json
{
  "total": 1,
  "servers": [
    {
      "hostId": "3b86e7a7-…",
      "name": "My Room",
      "mapName": "arena",
      "currentPlayers": 3,
      "maxPlayers": 8,
      "region": "DE"
    }
  ]
}
```

The host's IP and internal fields are never exposed.

### GET /maps/manifest.json and GET /maps/:name

A map catalog for browser hosts — a room starts on the master's current maps
rather than the ones baked into the client bundle (maps can update without a
rebuild):

- `GET /maps/manifest.json` → `{ "version": "<content hash>", "maps": ["canopy", …] }` —
  `version` only changes along with the maps themselves;
- `GET /maps/:name` → the map's JSON (`src/data/maps/*.js` format); an unknown name → `404 { "error": "unknownMap" }`.

Maps are kept in memory (`MapCatalog` imports `src/data/maps/index.js` at
startup) — no file artifacts or a separate export step are needed. How a
host consumes the catalog — see [host.md](host.md#dynamic-maps).

### GET /worker/manifest.json

The manifest of the host worker bundle used for the Worker handoff:

- `GET /worker/manifest.json` → `{ "version": "<content hash>", "url": "/assets/host.worker-<hash>.js" }`.

`WorkerCatalog` locates the bundle in `dist/assets/` at master startup and
hashes its content (SHA-256, 16 chars — following `MapCatalog`'s pattern).
Vite hashes asset filenames, so an old build's page can't know the new
bundle's name — the host tab creates its Worker from the `url` in the
manifest and compares `version` against the `codeVersion` in
`host_registered`. In dev the catalog is empty
(`{ "version": null, "url": null }`) — the Worker is served by Vite from
source, and code updates are disabled. How a host consumes the manifest —
see [host.md](host.md#worker-handoff).

## Signaling protocol (WebSocket)

Messages are JSON objects with a `type` field. On connect, the connection is
checked against an `Origin` allowlist (`security.createOriginValidator`; a
missing `Origin` terminates immediately, a foreign one closes with code
`4001`), then receives:

```json
{ "type": "welcome", "id": "<connection uuid>", "iceServers": [{ "urls": "stun:…" }] }
```

`iceServers` is the ICE configuration for `RTCPeerConnection` (STUN is required; TURN is an optional relay).

The client-side signaling counterpart — [src/client/network/SignalingClient.js](../../src/client/network/SignalingClient.js): connects to this WS, consumes `welcome`/`iceServers`, sends `webrtc_offer`/`ice_candidate`/`ping_host`/`report_host`, and relays incoming messages by `type`. Game traffic, once P2P is established, flows over WebRTC (`WebRtcManager`), bypassing the master — see [client.md](client.md#network-layer-srcclientnetwork) and [network.md](network.md#transport-webrtc).

### Host messages

| → to master | Response / effect |
| --- | --- |
| `register_host { name, maxPlayers, mapName }` | `host_registered { hostId, mapsVersion, codeVersion }`; region — from the header, IP — from the connection; `mapsVersion`/`codeVersion` — current versions of the map catalog and worker bundle (on re-register after a disconnect — a deploy restarts the master — the host compares them to its own: a map mismatch triggers a catalog re-read, a code mismatch triggers a Worker handoff). Errors: `alreadyRegistered`, `hostLimit` (a room from this IP already exists) |
| `update_host { currentPlayers, mapName }` | refreshes room data (also serves as a heartbeat) |
| `heartbeat {}` | updates `lastSeen` |
| `webrtc_answer { clientId, sdp }` | forwarded to the client as `webrtc_answer { hostId, sdp }` |
| `pong_host { clientId, pingId }` | forwarded to the client as `pong_host { hostId, pingId }` |

The host keeps its signaling WS open permanently. A room with no heartbeat for longer than `host.heartbeatTimeout` (30 s) is removed from the registry and its connection closes with code `4000` (checked every `host.sweepInterval`). The host's WS dropping also removes the room.

### Client messages

| → to master | Response / effect |
| --- | --- |
| `webrtc_offer { hostId, sdp }` | forwarded to the host as `webrtc_offer { clientId, sdp }`; error `unknownHost` |
| `ping_host { hostId, pingId }` | forwarded to the host; rate-limited per IP (`pingRateLimit`, error `rateLimited`). The measurement is **approximate** (client→master→host, not P2P RTT) |
| `report_host { hostId, reason }` | a `/ban` report: accepted **only from a session that sent this room a `webrtc_offer`** (otherwise error `reportRejected` — outside IPs can't ban a host without ever joining it); a reason is required (a report without one isn't counted). Reporter uniqueness is by IP within the `host.reportWindowMs` window; at `host.banThreshold` unique reports the room is banned (see below). `reason` is sanitized and stored in `reportReasons` (an audit trail, never shown publicly) |

### Shared messages

| → to master | Effect |
| --- | --- |
| `ice_candidate { targetId, candidate }` | forwarded to the target (`targetId` — a `hostId` or `clientId`) as `ice_candidate { fromId, candidate }` |

Errors arrive as `{ "type": "error", "code": "<code>" }`. Invalid JSON and unknown `type` values are silently ignored.

## `/ban` social moderation

The project's only anti-cheat measure. The browser host physically runs the
simulation in its own process — WASM memory is reachable from its JS, and a
modified client can cheat by bypassing the core's logic. Technical defense
against this is impossible without moving authority back to a trusted server
(which would defeat the point of P2P), so the only measure is social.

The report is intercepted **on the client** (`src/client/main.js`, the `/ban <reason>` command) and goes **straight to the master** over the signaling WS, bypassing the host: its `CommandProcessor` could otherwise filter out a complaint about itself. A reason is required (gated client-side) and is never shown publicly.

Ban logic (`HostRegistry`):

- a report is only accepted from a session that actually connected to the room (sent it a `webrtc_offer`) — membership is checked in `SignalingServer._onReportHost` (`session.offeredHosts`); a reason is required — a report with an empty `reason` isn't counted (`report` returns `counted: false`).
- `report(hostId, reporterKey, reason)` prunes `reporters` older than `host.reportWindowMs`, adds the new reporter (by IP), and updates `reportCount = reporters.size`; it returns `{ counted, banned }`.
- Once `reporters.size >= host.banThreshold`, the room's status flips to `'banned'` (immediately dropped from `GET /servers`), and its IP is recorded as banned until the window expires.
- `SignalingServer` closes the host's signaling WS with code `4002` once banned — new WebRTC offers no longer route to it (already established P2P peers aren't affected, there's no host migration: the cheater is left alone in the room).
- `isBanned(ip)` prevents a banned IP from re-registering a room until the window expires (`register_host` → error `banned`). Stale ban entries are cleaned lazily and in `sweepStale`.

Report uniqueness is by reporter IP, so several guests behind the same NAT
count as one. A deliberate limitation of the project's "minimal anti-cheat"
model: basic environment hygiene (see "Protection" below) filters out
"street" attackers, but not a host running the original WASM and editing its
memory from JS — heavier schemes (cross-validating host state through shadow
validators, server-side replay checks, cryptographic snapshot signatures)
were considered and rejected: they all ultimately trust a stream of
input/state controlled by the very host being checked.

**Observability**: every counted report and ban is logged to the master's
console (`[report] room ... N report(s) in window`) — this is the only place
reports can be seen (there's no admin UI; reasons are never exposed, and the
capped history lives in `HostSession.reportReasons` in memory until a
restart/room cleanup).

## Protection

- **Origin allowlist** — the `src/lib/security.js` pattern (`createOriginValidator` with the master's parameters).
- **1 room per IP** — checked in `HostRegistry.add`; a banned IP is rejected (`isBanned`).
- **Ping rate limiting** — `RateLimiter` (fixed window, 10 requests/sec per IP by default).
- **Security headers** (environment hygiene) — the master sets `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `X-Frame-Options: DENY` on every response; `Content-Security-Policy` only in production (it would break Vite HMR in dev). Production static assets and `.wasm` are served with CSP by Nginx — see [deployment.md](deployment.md); the policy string's single source of truth is `src/config/master.js` (`security.csp`).
- Input string sanitization (`sanitizeMessage`), clamping numeric fields.

## Tests

`tests/master/` (a node Vitest project): `HostRegistry.test.js` (registration, per-IP limit, heartbeat/cleanup, reports — including the required reason, all `GET /servers` selection logic), `SignalingServer.test.js` (connection lifecycle, routing of every signaling message on fake ws sockets, rate limiting, report membership checks, stale-host cleanup, `mapsVersion`/`codeVersion` in `host_registered`), `MapCatalog.test.js` (manifest, map serving, version stability), `WorkerCatalog.test.js` (bundle version hash and URL, empty catalog in dev, picking the newest of several). Rate limiter — `tests/lib/rateLimiter.test.js`.

---

[← Previous: Gameplay](gameplay.md) · [Next: Browser Host →](host.md)
