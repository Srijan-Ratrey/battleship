// End-to-end test against a running dev server. Plays a full match over real
// WebSockets, then checks rejoin, turn enforcement, and the one rule that
// matters: the enemy fleet never crosses the wire before game over.
//
//   Terminal 1:  npm run dev
//   Terminal 2:  npm run test:e2e
//
// `npm test` must pass with no server running, so it globs test/*.test.mjs
// rather than using bare `node --test` — Node's default discovery would sweep
// up every file under test/, this one included.

import assert from 'node:assert/strict';

import { SIZE, TOTAL_SHIP_CELLS } from '../src/game.js';

const BASE = process.env.BATTLESHIP_URL ?? 'ws://localhost:8787';

// Rooms are Durable Objects and persist, so a short code eventually collides
// with a finished room from an earlier run and the server — correctly — answers
// `full`. Nine random characters keeps every run in a room of its own.
const ROOM = `E2E${Array.from({ length: 9 }, () => Math.floor(Math.random() * 36).toString(36).toUpperCase()).join('')}`;

class Client {
  constructor(label) {
    this.label = label;
    this.received = [];
    this.frames = [];
    // A socket that died and one that is merely slow look identical from
    // waitFor's side. Recording the close lets a timeout say which it was.
    this.closed = null;
    this.closedByTest = false;
    this.errored = false;
  }

  async connect() {
    this.ws = new WebSocket(`${BASE}/api/room/${ROOM}`);
    this.ws.addEventListener('message', (event) => {
      this.frames.push(event.data);
      this.received.push(JSON.parse(event.data));
    });
    this.ws.addEventListener('error', () => { this.errored = true; });
    this.ws.addEventListener('close', (event) => {
      this.closed = {
        code: event.code,
        reason: event.reason || '',
        clean: event.wasClean,
        afterFrames: this.frames.length,
      };
    });
    await new Promise((resolve, reject) => {
      // Something that accepts the TCP connection but never completes the
      // upgrade — a stale process on the port, say — would otherwise hang the
      // whole suite with no output at all.
      const timer = setTimeout(
        () => reject(new Error(`${this.label}: no WebSocket handshake from ${BASE} within 10s`)),
        10000,
      );
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(`${this.label}: connect failed (${BASE})`));
      }, { once: true });
    });
    return this;
  }

  send(message) {
    this.ws.send(JSON.stringify(message));
  }

  // Why a wait might have gone nowhere — the bit a bare timeout never told us.
  diagnosis() {
    if (!this.closed) return this.errored ? 'socket open but an error fired' : 'socket still open';
    const { code, reason, clean, afterFrames } = this.closed;
    return `socket closed (${code}${reason ? ` "${reason}"` : ''}, ${clean ? 'clean' : 'unclean'}) `
      + `after ${afterFrames} frame${afterFrames === 1 ? '' : 's'} — `
      + `${this.closedByTest ? 'closed by the test' : 'NOT closed by the test'}`;
  }

  // `predicate` matters more than it looks: several `opponent` updates queue up
  // over a match, so "the next one" is rarely the one a check means.
  async waitFor(type, predicate = null, timeoutMs = 5000) {
    return this.waitForAny([type], predicate, timeoutMs);
  }

  async waitForAny(types, predicate = null, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.received.findIndex(
        (m) => types.includes(m.type) && (!predicate || predicate(m)),
      );
      if (index !== -1) return this.received.splice(index, 1)[0];
      if (Date.now() > deadline) {
        throw new Error(
          `${this.label}: timed out waiting for "${types}"; ${this.diagnosis()}; `
          + `saw [${this.received.map((m) => m.type)}]`,
        );
      }
      await sleep(20);
    }
  }

  close() {
    this.closedByTest = true;
    this.ws.close();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const checks = [];
function check(name, fn) {
  checks.push({ name, fn });
}

// ---------------------------------------------------------------------------

// The harness knows both layouts — each `board` message is that player's own —
// which lets it aim at a known ship or known water and make turn order
// deterministic. Now that a hit earns another shot, "fire anywhere and assume
// the turn passed" is no longer a safe thing for a test to do.
function pick(grid, wantShip, used) {
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if ((grid[r][c] !== -1) === wantShip && !used.has(`${r},${c}`)) {
        used.add(`${r},${c}`);
        return [r, c];
      }
    }
  }
  throw new Error(`no unused ${wantShip ? 'ship' : 'water'} cell left`);
}

const state = { firedByA: new Set(), firedByB: new Set(), bShots: [] };

check('two players join and the room moves to placing', async () => {
  state.a = await new Client('A').connect();
  state.a.send({ type: 'hello' });

  const welcomeA = await state.a.waitFor('welcome');
  assert.equal(welcomeA.slot, 'A');
  assert.ok(welcomeA.playerId, 'expected a playerId');
  assert.equal(welcomeA.phase, 'lobby');
  state.idA = welcomeA.playerId;

  const boardA = await state.a.waitFor('board');
  assert.equal(boardA.grid.length, SIZE);
  assert.equal(boardA.ships.length, 5);
  state.gridA = boardA.grid;

  state.b = await new Client('B').connect();
  state.b.send({ type: 'hello' });

  const welcomeB = await state.b.waitFor('welcome');
  assert.equal(welcomeB.slot, 'B');
  assert.equal(welcomeB.phase, 'placing');
  state.idB = welcomeB.playerId;

  const boardB = await state.b.waitFor('board');
  state.gridB = boardB.grid;
  state.shipsB = boardB.ships;

  // A learns B arrived, and that the room advanced.
  const update = await state.a.waitFor('opponent', (m) => m.present === true);
  assert.equal(update.phase, 'placing');
});

check('a third player is rejected as full', async () => {
  const c = await new Client('C').connect();
  c.send({ type: 'hello' });
  await c.waitFor('full');
  c.close();
});

check('firing before the game starts is refused', async () => {
  state.a.send({ type: 'fire', r: 0, c: 0 });
  const error = await state.a.waitFor('error');
  assert.match(error.msg, /not in progress/i);
});

check('randomize reshuffles only the requester', async () => {
  const before = JSON.stringify(state.gridA);
  let changed = false;
  for (let attempt = 0; attempt < 5 && !changed; attempt++) {
    state.a.send({ type: 'randomize' });
    const board = await state.a.waitFor('board');
    state.gridA = board.grid;
    changed = JSON.stringify(board.grid) !== before;
  }
  assert.ok(changed, 'randomize never produced a different layout in 5 tries');

  // B got nothing from A's reshuffle.
  assert.equal(state.b.received.some((m) => m.type === 'board'), false);
});

check('manual placement is accepted, and illegal layouts are refused', async () => {
  const legal = [
    { name: 'Carrier', r: 0, c: 0, horizontal: true },
    { name: 'Battleship', r: 2, c: 0, horizontal: true },
    { name: 'Cruiser', r: 4, c: 0, horizontal: true },
    { name: 'Submarine', r: 6, c: 0, horizontal: true },
    { name: 'Destroyer', r: 8, c: 0, horizontal: false },
  ];

  state.a.send({ type: 'place', ships: legal });
  const board = await state.a.waitFor('board');
  assert.equal(board.grid[0][0], 0);
  assert.equal(board.grid[9][0], 4, 'the vertical Destroyer should reach 9,0');
  assert.equal(board.grid.flat().filter((v) => v !== -1).length, TOTAL_SHIP_CELLS);
  state.gridA = board.grid;

  const reject = async (ships, pattern) => {
    state.a.send({ type: 'place', ships });
    assert.match((await state.a.waitFor('error')).msg, pattern);
  };

  await reject([...legal.slice(0, 4), { name: 'Destroyer', r: 0, c: 0, horizontal: true }], /overlaps/i);
  await reject([{ name: 'Carrier', r: 0, c: 7, horizontal: true }, ...legal.slice(1)], /hangs off/i);
  await reject(legal.slice(0, 3), /exactly/i);
  await reject('not a fleet', /exactly/i);

  // B never hears about any of it.
  assert.equal(state.b.received.some((m) => m.type === 'board'), false);
  // The rejoin check later asserts this grid survived, which proves none of the
  // rejected layouts mutated the board.
});

check('both ready starts the game with A to move', async () => {
  state.a.send({ type: 'ready' });
  await state.a.waitFor('youReady');
  await state.b.waitFor('opponent', (m) => m.ready === true);

  state.b.send({ type: 'ready' });
  await state.b.waitFor('youReady');

  const startA = await state.a.waitFor('start');
  const startB = await state.b.waitFor('start');
  assert.equal(startA.yourTurn, true);
  assert.equal(startB.yourTurn, false);
});

check('a hit earns another shot, a miss ends the turn', async () => {
  // A's move. Aim at a cell we know carries one of B's ships.
  const [hr, hc] = pick(state.gridB, true, state.firedByA);
  state.a.send({ type: 'fire', r: hr, c: hc });
  const hit = await state.a.waitFor('fireResult');
  assert.equal(hit.hit, true, 'a known ship cell should register a hit');
  assert.equal(hit.yourTurn, true, 'a hit must keep the move');

  const defended = await state.b.waitFor('incoming');
  assert.equal(defended.hit, true);
  assert.equal(defended.yourTurn, false, 'the defender must not get the move after a hit');

  // Same player fires again, this time into open water.
  const [mr, mc] = pick(state.gridB, false, state.firedByA);
  state.a.send({ type: 'fire', r: mr, c: mc });
  const miss = await state.a.waitFor('fireResult');
  assert.equal(miss.hit, false);
  assert.equal(miss.yourTurn, false, 'a miss must end the turn');

  const handover = await state.b.waitFor('incoming');
  assert.equal(handover.yourTurn, true, 'the move passes on a miss');
  state.shotsA = 2;
});

check('firing out of turn is refused and costs nothing', async () => {
  // B's move now.
  state.a.send({ type: 'fire', r: 5, c: 5 });
  assert.match((await state.a.waitFor('error')).msg, /not your turn/i);

  // B misses on purpose, so the move comes straight back to A.
  const [r, c] = pick(state.gridA, false, state.firedByB);
  state.b.send({ type: 'fire', r, c });
  assert.equal((await state.b.waitFor('fireResult')).hit, false);

  const incoming = await state.a.waitFor('incoming');
  assert.equal(incoming.r, r);
  assert.equal(incoming.c, c);
  assert.equal(incoming.yourTurn, true);
  state.bShots.push([r, c]);
});

check('off-board and repeat shots are refused', async () => {
  // A's move.
  state.a.send({ type: 'fire', r: 99, c: 0 });
  assert.match((await state.a.waitFor('error')).msg, /off the board/i);

  const [spent] = [...state.firedByA];
  const [sr, sc] = spent.split(',').map(Number);
  state.a.send({ type: 'fire', r: sr, c: sc });
  assert.match((await state.a.waitFor('error')).msg, /already fired/i);

  // A misses to hand the move over; B misses to hand it back.
  const [ar, ac] = pick(state.gridB, false, state.firedByA);
  state.a.send({ type: 'fire', r: ar, c: ac });
  assert.equal((await state.a.waitFor('fireResult')).hit, false);
  await state.b.waitFor('incoming');
  state.shotsA = 3;

  const [br, bc] = pick(state.gridA, false, state.firedByB);
  state.b.send({ type: 'fire', r: br, c: bc });
  await state.b.waitFor('fireResult');
  await state.a.waitFor('incoming');
  state.bShots.push([br, bc]);
});

check('sinking a ship names it and still keeps the move', async () => {
  // A's move. The Destroyer is the cheapest ship to finish, and every hit
  // keeps the turn, so this needs no handover.
  const destroyer = state.shipsB.find((s) => s.name === 'Destroyer');
  let sinking = null;

  for (const [r, c] of destroyer.cells) {
    if (state.firedByA.has(`${r},${c}`)) continue; // an earlier check may have taken one
    state.firedByA.add(`${r},${c}`);
    state.a.send({ type: 'fire', r, c });

    const result = await state.a.waitFor('fireResult');
    assert.equal(result.hit, true, 'a known Destroyer cell should hit');
    state.shotsA += 1;
    if (result.sunk) sinking = result;
    await state.b.waitFor('incoming');
  }

  assert.ok(sinking, 'the Destroyer should have gone down');
  assert.equal(sinking.shipName, 'Destroyer', 'a sinking is named');
  assert.equal(sinking.yourTurn, true, 'a sinking hit still earns another shot');
  state.sunkByA = ['Destroyer'];
});

check('a dropped player rejoins and gets its own state back', async () => {
  // Keep the pre-drop transcript; the leak check below inspects both halves.
  state.framesBeforeDrop = state.a.frames.slice();
  state.a.close();

  // A dropped socket has to be noticed by the runtime and relayed to the other
  // player. That is instant against `wrangler dev` but can lag over the open
  // internet, so this one wait gets a longer leash than the default.
  await state.b.waitFor('opponent', (m) => m.present === false, 20000);

  const rejoined = await new Client('A2').connect();
  rejoined.send({ type: 'hello', playerId: state.idA });

  const welcome = await rejoined.waitFor('welcome');
  assert.equal(welcome.slot, 'A', 'rejoin must land in the same slot');

  const resync = await rejoined.waitFor('resync');
  assert.equal(resync.phase, 'playing');
  assert.equal(resync.ready, true);
  assert.equal(resync.over, false);
  assert.deepEqual(resync.board.grid, state.gridA, 'own fleet must survive the drop');

  // Tracking holds exactly the shots A had fired, and nothing more.
  const marked = resync.tracking.flat().filter((v) => v !== null);
  assert.equal(marked.length, state.shotsA, "tracking must replay A's own shots");
  for (const key of state.firedByA) {
    const [r, c] = key.split(',').map(Number);
    assert.notEqual(resync.tracking[r][c], null, `A's shot at ${key} was lost`);
  }

  // B's shots landed on A's board, visible as A's own damage.
  for (const [r, c] of state.bShots) {
    assert.equal(resync.board.shot[r][c], true, `B's shot at ${r},${c} was lost`);
  }

  // Kills A already earned must survive the drop, or the fleet legend comes
  // back blank even though the tracking grid still shows the hits.
  assert.deepEqual(resync.enemySunk, state.sunkByA, "A's kill list was lost");

  await state.b.waitFor('opponent', (m) => m.present === true);

  state.a = rejoined;
});

check('a full match plays out and declares a winner', async () => {
  // Neither side knows the other's layout, so both just sweep the board in
  // row-major order. A moves first and needs at most 100 shots.
  const nextCell = { A: 0, B: 0 };
  let turn = 'A';
  let gameOver = null;

  for (let move = 0; move < 400 && !gameOver; move++) {
    const client = turn === 'A' ? state.a : state.b;
    const other = turn === 'A' ? state.b : state.a;

    // Skip cells already fired at (the pre-match probes above).
    let result = null;
    while (!result) {
      const index = nextCell[turn]++;
      assert.ok(index < SIZE * SIZE, `${turn} ran out of cells`);
      client.send({ type: 'fire', r: Math.floor(index / SIZE), c: index % SIZE });

      // One waiter over both types — racing two would leave the loser polling
      // and let it steal a later message out of the queue.
      const reply = await client.waitForAny(['fireResult', 'error']);
      if (reply.type === 'fireResult') result = reply;
      else assert.match(reply.msg, /already fired/i);
    }

    await other.waitFor('incoming');

    if (result.win) {
      gameOver = await client.waitFor('gameOver');
      await other.waitFor('gameOver');
    } else {
      turn = result.yourTurn ? turn : turn === 'A' ? 'B' : 'A';
    }
  }

  assert.ok(gameOver, 'the match never ended');
  // Both sides sweep in the same order, so who gets there first comes down to
  // whose fleet sits earlier in row-major order — a genuine coin flip.
  assert.ok(['A', 'B'].includes(gameOver.winner), `odd winner: ${gameOver.winner}`);
  assert.ok(gameOver.boards.A && gameOver.boards.B, 'both fleets revealed at the end');

  const loser = gameOver.winner === 'A' ? 'B' : 'A';
  assert.equal(
    gameOver.boards[loser].ships.every((s) => s.sunk),
    true,
    'the loser should have no ships left',
  );
  assert.equal(
    gameOver.boards[gameOver.winner].ships.every((s) => s.sunk),
    false,
    'the winner should still have something afloat',
  );
  state.winner = gameOver.winner;
});

check('the enemy fleet never crossed the wire before game over', async () => {
  const enemyGrid = JSON.stringify(state.gridB);

  // Every frame A received across both of its connections, up to gameOver.
  const allFrames = [...state.framesBeforeDrop, ...state.a.frames];
  const framesBeforeEnd = [];
  for (const frame of allFrames) {
    if (JSON.parse(frame).type === 'gameOver') break;
    framesBeforeEnd.push(frame);
  }
  assert.ok(framesBeforeEnd.length > 10, 'expected a real conversation to inspect');

  for (const frame of framesBeforeEnd) {
    const message = JSON.parse(frame);

    // The full 10x10 layout is the leak vector that matters, and it cannot
    // collide by chance. (Comparing individual ships by their cells would trip
    // whenever both players happen to place a ship on the same squares — that
    // is A seeing A's own Destroyer, not a leak.)
    assert.equal(frame.includes(enemyGrid), false, `B's grid leaked on "${message.type}"`);
    assert.equal(message.boards ?? null, null, 'boards may only appear in gameOver');

    const grid = message.grid ?? message.board?.grid;
    const ships = message.ships ?? message.board?.ships;
    if (!grid && !ships) continue;

    // A fleet may only ride on the two messages that carry A's own board.
    assert.ok(['board', 'resync'].includes(message.type), `a fleet rode on "${message.type}"`);
    assert.notDeepEqual(grid, state.gridB, "A was handed B's layout");

    // And the fleet must be internally coherent: every ship's cells must agree
    // with the grid shipped alongside it. Handing A someone else's ships list
    // would break this even if the grid looked innocent.
    ships.forEach((ship, index) => {
      for (const [r, c] of ship.cells) {
        assert.equal(grid[r][c], index, `${ship.name} at ${r},${c} disagrees with its own grid`);
      }
    });
  }

  // And the winner learned exactly what they earned: 17 hits, no more.
  const winnerFrames = state.winner === 'A' ? allFrames : state.b.frames;
  const hits = winnerFrames
    .map((f) => JSON.parse(f))
    .filter((m) => m.type === 'fireResult' && m.hit).length;
  assert.equal(hits, TOTAL_SHIP_CELLS, `winner should have landed exactly ${TOTAL_SHIP_CELLS} hits`);
});

check('a rematch needs both players and resets the room', async () => {
  state.a.send({ type: 'rematch' });
  await state.a.waitFor('rematchPending');
  await state.b.waitFor('rematchOffer');

  // One player alone must not reset a finished board out from under the other.
  assert.equal(state.b.received.some((m) => m.type === 'resync'), false);

  state.b.send({ type: 'rematch' });
  const resyncA = await state.a.waitFor('resync');
  const resyncB = await state.b.waitFor('resync');

  for (const r of [resyncA, resyncB]) {
    assert.equal(r.phase, 'placing');
    assert.equal(r.over, false);
    assert.equal(r.winner, null);
    assert.equal(r.ready, false, 'both must re-confirm their fleet');
    assert.equal(r.boards, null, 'the old reveal must not ride along');
    assert.equal(r.tracking.flat().every((v) => v === null), true, 'tracking must be cleared');
    assert.equal(r.board.shot.flat().some(Boolean), false, 'damage must be cleared');
    assert.equal(r.board.ships.every((s) => s.hits === 0 && !s.sunk), true, 'fresh fleet expected');
  }

  // Same players, same slots.
  assert.equal(resyncA.slot, 'A');
  assert.equal(resyncB.slot, 'B');
});

// ---------------------------------------------------------------------------

let failures = 0;
for (const { name, fn } of checks) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures++;
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
}

state.a?.close();
state.b?.close();

console.log(`\n${checks.length - failures}/${checks.length} passed (room ${ROOM})`);
process.exit(failures ? 1 : 0);
