# Battleship — Decisions

Originally the calls made *before* building. Now also the record of how they
landed, what got reversed once the game was playable, and the decisions that only
surfaced once code met reality.

**Status:** live at <https://battleship.sr5.workers.dev> (version `8c975e40`).
32 unit tests, 16 end-to-end socket checks, 29 browser checks. Free plan.

---

## Locked

| # | Decision | Choice | Held up? |
|---|---|---|---|
| 1 | **Transport** | WebSocket | Yes. |
| 2 | **Server model** | Cloudflare Workers + Durable Objects | Yes. One room = one DO; rejoin came nearly free, as predicted. |
| 3 | **Authority** | Server-authoritative | Yes, and it stayed non-negotiable — see the rule at the bottom. |
| 4 | **Storage** | SQLite-backed DO, one JSON blob per room | Yes. Re-read from `ctx.storage` on *every* message, never cached in a field. |
| 5 | **Placement** | Random + reroll now, drag-and-drop as v2 | **Superseded** — v2 shipped. Drag to move, click to rotate, Randomize still there. |
| 6 | **Ruleset** | Classic: one shot per turn | **Reversed** — a hit now earns another shot. See A. |
| 7 | **Reconnection** | Allow rejoin | Yes, and then extended twice (see *Identity* below). |
| 8 | **Hosting cost** | Free | Yes. Never came close to a limit. |
| 9 | **Deploy shape** | Single Worker serves page + `/api/*` | Yes. One `wrangler deploy`, no CORS. |

---

## The seven open calls — how they landed

### A. Turn after a hit → **reversed**
Shipped as classic one-shot-per-turn, exactly as recommended, behind a single
constant. Then changed on request: **a hit earns another shot, a miss ends the
turn.** `EXTRA_SHOT_ON_HIT` in `src/game.js` still flips it back; the turn logic
in `onFire` is its only reader.

The recommendation to "flag it as a one-line change" paid off — the server change
*was* one line. The cost was elsewhere: two tests had quietly assumed strict
alternation ("fire anywhere, assume the turn passed"), and the UI had to explain
why the turn hadn't changed hands, or it just looks broken.

### B. Room code → **as recommended**
Client generates 4 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` — I, O, 0
and 1 removed, because codes get read aloud and typed by hand. The code *is* the
Durable Object name, uppercased on the way in so `k7qf` and `K7QF` are one room.

### C. "Ready" → **as recommended**
Ready locks the fleet. Rearranging and randomizing are refused once ready, on the
server. Both ready flips the room to `playing`, A moves first.

### D. Disconnect visibility → **as recommended**
"Opponent reconnecting…" banner, driven by `opponent {present}`.

### E. Abandonment → **as recommended, no timer**
Rooms hibernate and evict naturally. There *is* a Leave button, and it clears
this browser's records for that room — but the seat itself stays held. See the
known limits.

### F. Board reveal → **as recommended**
Both fleets revealed, only in `gameOver`. `revealBoth` is called from exactly two
places: game over, and a resync of an already-finished game.

### G. Frontend → **as recommended**
Plain HTML/JS, one file, no build step. Still true after a drag-and-drop
placement editor, explosion effects and a modal.

---

## Decisions taken during the build

### Platform

- **`exports`, not `migrations`.** Durable Object class lifecycle is declared with
  the top-level `exports` map; the imperative `migrations` array is legacy. The
  two are mutually exclusive.
- **SQLite storage backend, and it matters.** `"storage": "sqlite"` is what makes
  Durable Objects free-plan eligible. The legacy KV-backed flavour is paid-only
  and can no longer be created at all on new accounts — a `new_classes` migration
  is the most likely cause of a spurious "requires a paid plan" on a first deploy.
- **WebSocket Hibernation, for cost not elegance.** The real free-plan ceiling for
  a socket app is **duration** (13,000 GB-s/day), not the 100k request count. A DO
  holding sockets open with plain `accept()` bills continuously; hibernation lets
  an idle room sleep. Incoming DO socket messages bill at 20:1.
- **`run_worker_first: ["/api/*"]`.** Static assets are matched before the Worker
  by default, so the API route is pinned explicitly rather than left to luck.
- **Quota is shared with Pages.** The 100k/day is per account, not per product.

### Rules and flow

- **`shipName` only on a sink.** Naming the ship on a plain hit would leak its
  size. This is a rule, not a detail.
- **Rematch needs both players.** One side asking only notifies the other; the
  room resets when both agree. Otherwise one player could wipe a finished board
  out from under the other before they'd looked at it.
- **A rematch is delivered as a plain `resync`** — the same message a rejoin uses
  — so the client has one code path for "here is the whole world again".

### Identity and rejoin — the part that changed most

- **`sessionStorage`, not `localStorage`.** `localStorage` is shared across tabs
  on one origin, so a second tab would present the first player's token and the
  server would *correctly* treat it as a rejoin and hand it the same seat. Two
  tabs could never be two players. This was found by testing, not by reasoning.
- **Then: "Resume your seat".** The above has a cost — a *fresh* tab has no token,
  so closing the tab and pasting the link gets you `full`, and only Cmd+Shift+T
  (which restores sessionStorage) got you back. So the browser also keeps a
  longer-lived record of seats it has held, `full` names the seats nobody is
  sitting in, and a button offers yours back. sessionStorage stays authoritative
  for the tab you're in, so two tabs are still two players.
- **Knowing a seat is free buys nothing.** `full.resumable` only says which seats
  are empty; taking one still requires that seat's token, checked exactly as
  before. Tested with a client that knows the seat is open and sends a bad token.
- **Leave clears both records**, so leaving a game doesn't leave the app offering
  to resume it.
- Storage access is wrapped in a try/catch — some privacy modes throw rather than
  no-op, and losing rejoin beats losing the page.

### The computer opponent

- **It runs on the server, not in the browser.** A client-side bot would have to
  hold its own fleet, and the player could simply read it — the same reason
  decision 3 exists. So a bot is an ordinary player in the second seat that
  happens to have no socket: `sendTo` finds nothing and no-ops, `markAbsent`
  never fires for it, presence reports it there.
- **It sees exactly what a player sees.** `botShot` is a pure function over the
  bot's own tracking grid, rebuilt from its shot log with the same
  `trackingFrom` a rejoin uses. It is never handed a fleet, so it *cannot* peek
  — and the suite proves it: 17 hits sink everything, so anything under 20 shots
  would mean it knew, and 80 simulated games are checked against that.
- **Two levels, measured not guessed.** Easy fires at random (~95 shots). Hard
  hunts on parity — no ship is shorter than two, so every ship must touch a
  square where `(r + c)` is even — and works along a ship once it hits (~52).
  Numbers from 300 simulated games each.
- **Shots are paced by a Durable Object alarm, one per shot**, rather than a
  blocking sleep inside the message handler. A sleep would have lost the rest of
  the bot's turn if the object were evicted mid-sequence, stranding the game with
  nobody able to move; an alarm is durable, and one shot per alarm is also what
  makes it read as an opponent thinking.
- **It never has to press Ready or agree to a rematch**, so a solo game starts
  and restarts on one click. That is why `resetForRematch` puts bots back to
  ready rather than clearing it for everyone.
- Its `playerId` is a real random token like anyone's. A guessable one would let
  someone `hello` into the bot's seat and read the fleet they are playing against.

### Anti-cheat

- **Manual placement never accepts a grid.** The client sends only
  `[{name, r, c, horizontal}]`; `fleetFromPlacements` rebuilds the grid on the
  server and rejects overlaps, ships hanging off the board, wrong-sized fleets and
  junk. A tampered client cannot stack five ships on one cell.
- **Every `fire` is re-validated** — phase, turn, bounds, already-fired. The
  client's opinion about whose turn it is carries no weight.
- **`randomize` and `place` reply only to the requesting socket.** A fleet is
  never broadcast.

### Testing

- **Rules live in `src/game.js` with zero Cloudflare imports**, which is what lets
  the whole ruleset run under plain `node --test` with no server.
- **The e2e suite drives real WebSockets** against `wrangler dev` or production
  (`BATTLESHIP_URL=`), and asserts the anti-cheat rule by scanning *every frame*
  one player received.
- **Browser checks drive real Chrome over CDP**, not Playwright — no heavy
  dependency added to the project to test a single-file frontend.
- **Room codes in tests carry nine random characters.** Rooms are Durable Objects
  and persist, so short codes eventually collide with a finished room from an
  earlier run and the server correctly answers `full` — which read as a mystery
  failure until it was traced.

---

## Build log

| Commit | What |
|---|---|
| `d4c4f71` | Rules, Worker + Room DO, frontend, tests. Playable end to end. |
| `8c2ed24` | Made the leak check precise and winner-agnostic (both were flaky by luck). |
| `9b983a4` | A hit earns another shot; board redrawn as the physical game — continuous hulls, peg holes, pegs. |
| `14fb99c` | Manual placement, impact effects, end-game modal and rematch. |
| `47295a1` | Live link and screenshots in the README. |
| `7ebec6c` | Stencilled hull wordmark; fixed colliding e2e room codes. |
| `d8c8e1c` | Warship tab icon, drawn for 16px and checked at that size. |
| `28aeed1` | Kill list survives a rejoin; e2e failures now name the socket close. |
| `1ad76e4` | A closed tab can take its seat back. |
| `60d79cf` | This document brought back in line with what was built. |
| `48c9be1` | Computer opponent, Easy and Hard. |

---

## The one rule that must never bend

> A `fire` message returns **only** hit / miss / sunk for that one cell.
> The server never sends a player any cell of the opponent's board they haven't
> earned by firing — until `gameOver`.

If you ever find yourself sending the enemy fleet to the client "to make
rendering easier," stop. That's the whole game's integrity.

**It is now enforced by a test, not just by care.** The e2e suite scans every
frame player A received before `gameOver` and fails if B's grid appears, if a
fleet rides on any message other than `board`/`resync`, or if a fleet disagrees
with the grid sent alongside it — which would catch someone else's ships list
even behind an innocent-looking grid.

It deliberately does *not* compare individual ships by coordinates: both players
sometimes place a ship on the same squares by chance, and that is A seeing A's
own Destroyer, not a leak. That false positive cost an hour before it was
understood.

---

## Known limits, still open

- **Resume is per-browser.** The seat token never leaves the machine it was issued
  to, so you cannot resume from another device. Putting it in the URL would allow
  that, but anyone holding the link would *be* you.
- **A seat is never released.** No timeout, per decision E. If a player leaves for
  good the room stays full — start a new one. A `forfeit` message would fix it.
- **An unexplained e2e flake.** Two production runs out of roughly twenty-five
  failed mid-suite, never reproduced, and one hypothesis (deploy rollout
  restarting the DO) was tested and **disproved**. The harness now reports the
  socket close code and whether the test closed it, so the next occurrence should
  be readable. Suspicion: the test client never reconnects, while the real one
  does — so a transient drop fails the suite but a player would just resume.
- **`enemySunk` on rejoin was a real bug**, found in a final review and fixed:
  `resync` carried no record of which enemy ships you'd sunk, so the fleet legend
  came back blank after a reconnect. Names only, of ships already announced.
- **The e2e flake is explained.** The diagnostics added earlier caught it:
  `socket closed (1006, unclean) … NOT closed by the test` — a transport-level
  drop between this machine and Cloudflare, measured at roughly one handshake in
  twelve. The real client already reconnects with backoff; the harness did not,
  so one refused connection failed every later check. It now retries the connect
  the same way, and reports an unexplained drop as a transport problem rather
  than a game failure. A browser on the same connection plays a full game
  against production without trouble.
- Not built: sound, spectators, mobile drag polish.
