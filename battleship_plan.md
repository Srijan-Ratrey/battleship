# Battleship over WebSocket — Build Plan

**Stack:** Cloudflare Workers + Durable Objects (SQLite), single-Worker deploy serving a plain HTML/JS frontend + a `/api/*` backend. Server-authoritative, rejoin-capable, classic rules.

---

## 1. How the pieces fit

```
  Browser A ─┐                      ┌─ Worker (fetch handler) ─┐
             │   wss:// /api/room/  │   routes by room code     │
  Browser B ─┘─────────────────────┤                          │
                                    │   one Durable Object      │
                                    │   PER ROOM  ("Room")      │
                                    │   • holds BOTH boards     │
                                    │   • runs the rules        │
                                    │   • persists state        │
                                    └───────────────────────────┘
      static index.html  ◀── same Worker serves it (Workers Assets)
```

- **Worker** = thin router. Serves the page for non-API paths; for `/api/room/<code>` it looks up the Durable Object named `<code>` and forwards the WebSocket upgrade to it.
- **Durable Object ("Room")** = the actual game. One instance per room code, single-threaded, owns the authoritative state of that one match.
- **No separate database.** The room's state lives in the Durable Object's own storage.

---

## 2. Room lifecycle (state machine)

```
   lobby ──(2nd player joins)──▶ placing ──(both Ready)──▶ playing ──(all ships sunk)──▶ over
     ▲                                                        │
     └──────────────── (rejoin re-enters whatever phase it was in) ─────────────────────┘
```

| Phase | What's happening | Allowed client actions |
|---|---|---|
| `lobby` | Room created, waiting for player 2 | (wait) |
| `placing` | Both present, arranging fleets | `randomize`, `ready` |
| `playing` | Alternating shots | `fire` (only on your turn) |
| `over` | Someone won | (view revealed boards) |

---

## 3. Server-held state (one JSON blob per room)

```
game = {
  code,                       // room code == Durable Object name
  phase,                      // lobby | placing | playing | over
  turn,                       // 'A' | 'B' — whose shot it is
  winner,                     // null | 'A' | 'B'
  players: {
    A: {
      playerId,               // secret token the client stores, proves identity on rejoin
      present,                // socket currently connected?
      ready,                  // locked placement?
      grid,                   // 10×10, ship id or -1   ← SECRET
      ships: [ {name,size,cells,hits,sunk} ],           ← SECRET
      shot,                   // 10×10 bool: cells the OPPONENT has fired at this board
    },
    B: { ...same... } | null
  },
  shotLog: { A:[{r,c,hit}], B:[{r,c,hit}] }  // each player's OWN shots, for rebuilding the tracking grid on rejoin
}
```

**Secret fields (`grid`, `ships`) never leave the server except in the final `over` reveal.**

---

## 4. Message protocol (the client↔server contract)

### Client → Server
| Type | Payload | When |
|---|---|---|
| `hello` | `{ playerId? }` | On every socket open. No `playerId` = new player; with it = rejoin attempt. |
| `randomize` | — | `placing` only. Ask server to roll a fresh valid fleet. |
| `ready` | — | `placing` only. Lock placement. |
| `fire` | `{ r, c }` | `playing` only, on your turn. |

### Server → Client
| Type | Payload | Meaning |
|---|---|---|
| `welcome` | `{ slot, playerId, phase }` | Assigned A or B (or resumed). Client saves `playerId`. |
| `full` | — | Room already has 2 players; reject. |
| `board` | `{ grid, ships }` | Your own fleet, to draw on your board. (Yours only — safe.) |
| `opponent` | `{ present }` | Opponent joined / dropped / rejoined — drives the status banner. |
| `start` | `{ yourTurn }` | Both ready; game begins. |
| `fireResult` | `{ r, c, hit, sunk?, shipName?, win }` | Result of *your* shot → your tracking grid. |
| `incoming` | `{ r, c, hit, sunk?, lose }` | Opponent fired at *you* → mark your own board. |
| `resync` | `{ phase, slot, yourTurn, board, tracking, over, winner }` | Full state replay after a rejoin. |
| `gameOver` | `{ winner, boards }` | Reveal both fleets. |
| `error` | `{ msg }` | e.g. fired out of turn / already-hit cell. |

---

## 5. The one flow that matters — firing

1. Client (on its turn) sends `fire {r,c}`.
2. Durable Object checks: phase == `playing`? sender == `turn`? cell not already fired?
   - fail → `error`, nothing else changes.
3. DO applies the shot **to the opponent's board it holds** → hit / miss / sunk / win.
4. DO records it, flips `turn`, persists state.
5. DO sends `fireResult` to the firer and `incoming` to the opponent.
6. If `win`: phase → `over`, send `gameOver` (with both boards revealed) to both.

The client draws its tracking grid purely from `fireResult` messages it receives. It is never handed the enemy layout to "look up" against.

---

## 6. Rejoin flow (why Durable Objects earns its keep)

1. Socket drops → DO marks that player `present:false`, tells the other player via `opponent`.
2. Player reopens the page, reconnects, sends `hello {playerId}` (saved from the first `welcome`).
3. DO matches the `playerId` to slot A/B, closes any stale socket in that slot, marks `present:true`.
4. DO sends `resync`: your own board, your prior shots (hits+misses on the tracking grid), whose turn it is, and whether it's already over.
5. Play continues exactly where it paused.

Because the state was in the Durable Object the whole time, there's nothing to reconstruct — you just replay it to the returning client.

---

## 7. File layout

```
battleship/
├─ wrangler.toml          # Worker name, DO binding "ROOM", SQLite migration, assets dir
├─ src/
│  ├─ index.js            # Worker fetch router + the Room Durable Object class
│  └─ game.js             # PURE rules: randomFleet(), applyShot(), constants — unit-tested
├─ public/
│  └─ index.html          # single-file frontend: 2 grids, room UI, WebSocket client
├─ test/
│  └─ game.test.mjs       # tests game.js in plain Node, no Cloudflare needed
└─ README.md              # deploy steps
```

**Key config facts (current API):**
- WebSocket uses the **Hibernation API**: `this.ctx.acceptWebSocket(server)` + `webSocketMessage` / `webSocketClose` handlers, so the room can sleep between shots without dropping the connection.
- Per-socket identity stored with `ws.serializeAttachment({ slot, playerId })`.
- Room state stored via `this.ctx.storage` (KV API, SQLite-backed — allowed on free plan).
- Routing: `env.ROOM.idFromName(code)` → `env.ROOM.get(id)` → forward the request.

---

## 8. Build order (each step independently testable)

1. **Rules in isolation** — `game.js` + `test/game.test.mjs`. Prove fleet placement never overlaps and `applyShot` reports hit/sunk/win correctly. No network yet.
2. **Echo Worker + DO** — get one Durable Object accepting a WebSocket and echoing. Proves the CF plumbing and `wrangler dev`.
3. **Lobby** — create/join, slot assignment, `welcome`, two players in a room.
4. **Placing** — `randomize` → `board`, `ready` → `start`.
5. **Playing** — the fire loop end to end, win detection, `gameOver` reveal.
6. **Rejoin** — drop a socket, reconnect with `playerId`, `resync`.
7. **Deploy** — `wrangler deploy`, play with a friend over the internet.
8. **v2 polish** — drag-and-drop placement, extra-shot-on-hit toggle, sounds.

---

## 9. Deploy (once built)

```
npm create cloudflare@latest      # or: npm i -g wrangler
wrangler login
wrangler deploy                    # publishes Worker + DO + static page
```

Lands on a `*.workers.dev` URL. Open it, click Create, share the room code + URL with a friend. Free.

---

## 10. Risks / gotchas to watch

- **Hibernation reloads state.** After the room sleeps, in-memory variables are gone — always read/write `this.ctx.storage`, never trust a module-level variable to survive between messages.
- **Two sockets, one slot.** A rejoin while the old socket is half-open → explicitly close the stale one, keyed by `playerId`.
- **Turn validation is the security boundary.** Every `fire` must re-check phase + turn + cell on the server. Never trust the client to fire only when allowed.
- **Don't leak the board.** Restated because it's the whole game: `board`/`resync` send only the recipient's own fleet; enemy layout ships only in `gameOver`.