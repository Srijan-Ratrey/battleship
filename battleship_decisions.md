# Battleship — Decisions

Everything you've locked in, plus the open calls still to make before/while building.

---

## Locked

| # | Decision | Choice | Consequence |
|---|---|---|---|
| 1 | **Transport** | WebSocket | Persistent connection, server pushes turns to both players. |
| 2 | **Server model** | Cloudflare Workers + Durable Objects | One room = one Durable Object. State persists between connections → rejoin is nearly free. |
| 3 | **Authority** | Server-authoritative | The Durable Object is the *only* thing that knows ship positions. Clients never receive the enemy board until game over. This is the anti-cheat foundation and is non-negotiable for a hidden-state game. |
| 4 | **Storage** | SQLite-backed DO (`this.ctx.storage` KV API) | Required on the free plan anyway. Game state stored as one JSON blob per room. |
| 5 | **Placement** | Random + reroll now; drag-and-drop as v2 | Ship the game end-to-end fast, add nicer placement once networking is proven. |
| 6 | **Ruleset** | Classic | One shot per turn, told hit/miss/sunk, you track the enemy grid yourself. |
| 7 | **Reconnection** | Allow rejoin | Server keeps room state on disconnect; player reconnects with saved `playerId` and re-syncs. |
| 8 | **Hosting cost** | Free | Workers Free plan: 100k requests/day, 13k GB-s/day, 5 GB storage. A full match is a few hundred messages. Effectively unlimited for this. |
| 9 | **Deploy shape** | Single Worker serves both | Frontend via Workers static assets + API on `/api/*`, same origin. One `wrangler deploy`, no CORS, no separate Pages step. |

---

## Still open — decide before or during build

### A. Turn after a hit
Classic Milton Bradley = **one shot per turn regardless of hit or miss.** Many digital versions give you **another shot when you hit.** The second is more fun and more common online.
→ *Recommendation:* one shot per turn for v1 (simplest, matches "classic"), flag it as a one-line change. Revisit after playing.

### B. Room code — who generates it?
Options: server generates a random 4–5 char code on "create," or players share any string they agree on.
→ *Recommendation:* server generates a short random code (e.g. `K7QF`). The code *is* the Durable Object name, so it must be unique-ish; 4 uppercase letters = 450k combos, collisions negligible at your scale.

### C. What counts as "ready"?
Both players must confirm placement before firing begins. Decision: can a player re-randomize after clicking ready? 
→ *Recommendation:* clicking "Ready" locks the board; both-ready flips the room to `playing`. Re-randomize allowed only before ready.

### D. Disconnect visibility
When one player's socket drops, does the other see "opponent disconnected — waiting for rejoin," or nothing?
→ *Recommendation:* show a lightweight "opponent reconnecting…" banner. Cheap, and it makes the rejoin feature visible instead of feeling like a freeze.

### E. Abandonment / timeout
If a disconnected player never comes back, does the room live forever?
→ *Recommendation:* let the Durable Object evict naturally (it hibernates; storage has a 5 GB ceiling you'll never hit). Optionally add a "forfeit / leave" button. No timer needed for v1.

### F. Board reveal at game over
When the game ends, do you reveal the loser's full board (where the remaining ships were)?
→ *Recommendation:* yes — send both full boards only in the `gameOver` message. It's satisfying and safe (game is over, nothing to cheat).

### G. Frontend framework
Plain HTML/JS vs React/etc.
→ *Recommendation:* plain single-file HTML/JS. Two 10×10 grids and a few buttons don't need a framework, and it keeps the static-asset deploy trivial.

---

## The one rule that must never bend

> A `fire` message returns **only** hit / miss / sunk for that one cell.
> The server never sends a player any cell of the opponent's board they haven't earned by firing — until `gameOver`.

If you ever find yourself sending the enemy fleet to the client "to make rendering easier," stop. That's the whole game's integrity.