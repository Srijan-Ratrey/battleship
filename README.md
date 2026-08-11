# Battleship over WebSocket

Two-player Battleship on Cloudflare Workers + Durable Objects. One room = one
Durable Object that holds both fleets, runs every rule, and persists state — so
a dropped connection resumes exactly where it paused.

The server is authoritative. A shot returns hit / miss / sunk for **that one
cell** and nothing else; neither player ever receives the other's layout until
the game is over.

## Run it

```bash
npm install
npm test        # pure rules, no server needed
npm run dev     # http://localhost:8787
```

Open the page, click **Create a room**, and share the invite link (or the 4-character
code) with the other player. Two tabs on one machine work fine — identity is
per-tab.

## Deploy it

```bash
npx wrangler login
npm run deploy
```

Lands on a `*.workers.dev` URL. Everything used here — Durable Objects with
SQLite storage, WebSocket Hibernation, static assets — is available on the
Workers **Free** plan.

## Layout

```
src/game.js          pure rules: randomFleet, applyShot, trackingFrom — unit-tested
src/index.js         Worker router + the Room Durable Object
public/index.html    single-file frontend (no framework, no build step)
test/game.test.mjs   rules tests, plain Node
test/integration.mjs end-to-end test over real WebSockets (needs `npm run dev`)
wrangler.jsonc       Worker name, ROOM binding, SQLite DO, assets
```

`src/game.js` imports nothing from Cloudflare, which is what lets `npm test` run
the whole ruleset under plain Node.

## Tests

```bash
npm test                       # 13 rules tests — placement fuzz, hit/sunk/win, bounds
npm run dev                    # in one terminal
npm run test:e2e               # in another: 10 checks over real sockets
```

The end-to-end suite plays a full match and asserts the thing that matters: it
scans **every frame** player A received before `gameOver` and fails if any of
them contains B's grid or ship coordinates.

## Protocol

Client → server: `hello {playerId?}`, `randomize`, `ready`, `fire {r,c}`.
The literal string `ping` is auto-answered with `pong` by the runtime without
waking the room.

Server → client:

| Type | Payload |
|---|---|
| `welcome` | `{slot, playerId, phase}` |
| `full` | — |
| `board` | `{grid, ships}` — yours only |
| `opponent` | `{joined, present, ready, phase}` |
| `youReady` | `{ready}` |
| `start` | `{yourTurn}` |
| `fireResult` | `{r, c, hit, sunk, shipName, win, yourTurn}` |
| `incoming` | `{r, c, hit, sunk, shipName, lose, yourTurn}` |
| `resync` | `{phase, slot, ready, yourTurn, board, tracking, opponent, over, winner, boards}` |
| `gameOver` | `{winner, boards}` — the only message carrying both fleets |
| `error` | `{msg}` |

Two additions to the original plan: `opponent` also carries the room `phase`
(so the waiting player learns the room advanced), and `youReady` acknowledges
your own lock-in rather than letting the client assume it.

`shipName` is sent only when a ship **sinks** — naming it on a plain hit would
leak the ship's size.

## Rules and behaviour

- One shot per turn, hit or miss (classic). `EXTRA_SHOT_ON_HIT` in `src/game.js`
  flips this.
- Random placement with unlimited rerolls until you click Ready; Ready locks the
  fleet.
- Rejoin: your `playerId` lives in `sessionStorage`, so a reload or a dropped
  socket puts you back in your slot with your board, your tracking grid, and the
  correct turn. It is **per tab** on purpose — `localStorage` is shared across
  tabs, so a second tab would present the first player's token and the server
  would hand it the same slot.
- Leaving a room abandons that slot. Rooms have no timeout; they hibernate and
  evict naturally. Start a new room to play again.

## Where the security boundary is

`onFire` in [src/index.js](src/index.js) re-checks phase, turn, bounds, and
whether the cell was already fired on **every** shot. The client's opinion about
whose turn it is carries no weight. `randomize` replies only to the requesting
socket, and `revealBoth` is called from exactly one place: game over.
