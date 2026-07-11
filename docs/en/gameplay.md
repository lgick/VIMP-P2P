# Gameplay

A team-based tank deathmatch: two teams (`team1`, `team2`) fight round by
round, with a third "team" — spectators (`spectators`). All rules are
authoritative on the room host ([host.md](host.md)).

## Player journey

1. **Connecting and auth** — the player enters a name (and tank model); the name is checked by a validator and deduplicated by the host. The room limit (`maxPlayers`) is counted **by humans** (bots yield their slot); a full room replies with `roomFull`, there's no waiting queue (see [host.md](host.md)).
2. **Spectator** — once the map loads, the player enters the game as a spectator: sees the world, the camera follows the watched player, `n`/`p` switch the watch target. A team-selection window arrives right away.
3. **Team selection** — via the vote menu (`m` → Switch team). If the team has no free respawns, the host tries to evict a bot; otherwise the request is denied ("Team ... is full").
4. **Playing** — at round start the player gets a tank at a respawn. During the first `teamChangeGracePeriod` (10 s) of the round, a team change applies immediately; later, the player finishes the round (or leaves for the spectators), and the change takes effect next round.
5. **Death** — the player becomes a spectator until the round ends, and the camera switches to the killer.

## Rounds and victory

- A **round** lasts `roundTime` (2 minutes by default). Victory is a **team wipe**: eliminating every member of the enemy team (bots count). The winning team gets a team frag (`score +1` in the header), the losing team a loss (`deaths +1`); everyone hears the victory/defeat sound and sees "{team} WINS!".
- If the round time runs out with no winner, a new round starts without scoring.
- There's a `roundRestartDelay` (5 s) pause between rounds. At round start the world is recreated: everyone is alive, the panel resets to defaults, and respawns are handed out per team.
- A **map** lasts `mapTime` (10 minutes). When it runs out, the host automatically starts a vote for the next map (`mapsInVote` options); if nobody votes, the current map's time is extended.

## Stats (Tab)

Scoring rules ([RoundManager.reportKill](../../src/host/meta/core/RoundManager.js)):

1. The eliminated player gets a loss (`deaths +1`) and a `dead` status until the round ends.
2. The player who eliminated an opponent gets a frag (`score +1`).
3. Eliminating a player on **your own** team loses you a frag (`score −1`).
4. A suicide is only a loss (`deaths +1`); frags don't change.
5. On a team wipe the winning team gets `score +1`, the losing team `deaths +1` (shown in the table header totals).
6. The `latency` column shows the player's current RTT (empty for bots).

Stat changes are broadcast the moment they happen; table sorting happens on the client (`score` descending, then `deaths` ascending).

## Votes (`m` key)

The collective decision-making system ([Vote](../../src/host/meta/modules/Vote.js) + [VoteCoordinator](../../src/host/meta/core/VoteCoordinator.js)):

- **Menu** — a window with "Switch team" and "Suggest map" entries.
- **Triggered by a player or by the system** — a player suggesting a map (if that player is the only one in the game, the map changes immediately, no vote), a vote for bots, an automatic map pick on timer.
- **Queue** — a vote created while another is active is queued and runs afterward.
- **Cooldown** — after a vote on a topic, a `timeBlockedVote` (30 s) lock prevents spam.
- **Lifetime** — `voteTime` (10 s); windows with `timeOff: true` (the menu) don't close on a timer.
- **Pagination** — lists longer than 7 are split into pages (Back/More).
- **Ties** — the winner is picked randomly among those tied for the max.

Exchange format — [network.md](network.md#vote-port-16).

## Chat (`c` key) and commands

Plain text is a message to the team/everyone (length capped by the host, 60 characters). Messages starting with `/` are commands ([CommandProcessor](../../src/host/meta/core/CommandProcessor.js)):

| Command | Action |
| --- | --- |
| `/name <nick>` | Change name (with validation and a system message) |
| `/timeleft` | Time remaining on the map |
| `/mapname` | Current map's name |
| `/bot <N> [team]` | Spawn N bots (into a team, or spread evenly); `/bot 0 [team]` — remove bots |
| `/nr` | New round — **dev mode only** |
| `/ban <reason>` | Report the room host (P2P social moderation) — **does not reach the host**, see below |

`/bot` is only available to active players. If more than one human is
active, a vote runs instead of immediate execution; executing the command
restarts the round.

**`/ban <reason>`** is the sole anti-cheat measure: the browser host runs the
simulation on its own machine and can physically cheat (a modified client
edits WASM memory bypassing the core's logic), so moderation is social, not
technical. The command is intercepted **on the client** and goes straight to
the master server over the signaling WS (bypassing the host — its
`CommandProcessor` could filter out a complaint about itself), not through
the game protocol. A reason is required (otherwise a local chat hint appears)
and is never shown publicly. Available only to guests of a room (the host
player has no such option); a disconnected master connection shows an error
message in chat. The master only counts reports from players who actually
connected to that room. Once the threshold of unique-by-IP reports is
reached, the master bans the room: it disappears from the server list, and
the host's signaling WS closes (new players can't reach it; already
connected P2P peers stay — there's no host migration). Details — [master.md](master.md#ban-social-moderation).

## Controls

The host switches the active key set by status (spectator/player):

- **Spectator**: `n` — next player, `p` — previous.
- **Player**: `w/s` — throttle/reverse, `a/d` — turn, `k/l` — turret rotation, `u` — center turret, `j` — fire, `n/p` — next/previous weapon.
- **Modes** (in any status): `c` — chat, `m` — vote, `Tab` — stats; `Esc`/`Enter` — control within modes.

Key layout is configured in `client.js` (`modules.controls`), commands and their types in `game.js` (`playerKeys`), see [configuration.md](configuration.md#keys-spectatorkeys-playerkeys).

## Weapons and the tank

The tank carries two weapons (switch with `n`/`p`, the active one is highlighted on the panel):

- **`w1` — bullet (hitscan)**: an instant ray, 40 damage, 1500 range, 200 ammo. The hit is computed by the host as a ray; the client draws the tracer instantly.
- **`w2` — bomb (explosive)**: a physical projectile, planted and detonating on a timer; 70 damage at the epicenter falling off over a 50 radius, 100 ammo.

Health is 100. The tank's `condition` visually degrades with damage (smoke), and it's destroyed at 0. Stats — [configuration.md](configuration.md#srcdata--game-data).

## HUD panel

Left to right: round time, health, `w1`/`w2` ammo (the active weapon is highlighted). Spectators see hidden values (an empty panel). Values reset to defaults every round.

## Bots

AI lives in the Rust core ([core.md](core.md)): bots are full participants —
they show up in stats, drive tanks, and shoot through the same input as
players. Navigation is grid-based pathfinding plus a spatial grid for target
search. Added via `/bot` or a vote; a bot is evicted when a human joins a
full team (also when a human connects past the combined `maxPlayers` limit).

## Kicks

- **Idle**: a player with no input/chat for longer than `idleKickTimeout.player` (2 min) gets kicked (spectators don't, `null` by default).
- **Network**: a smoothed (EMA) latency above `maxLatency` (1000 ms — a threshold sized for P2P hosting over home connections) or `maxMissedPings` (5) consecutive missed pings closes the connection with a technical message.

## Maps

`pool mini`, `canopy`, `garden` — tile-based maps with per-team respawns,
static geometry, and dynamic objects (sent in the snapshot). Changed by vote
or map timer. Adding a new one — [extending.md](extending.md#new-map).

---

[← Previous: Architecture](architecture.md) · [Next: Master Server →](master.md)
