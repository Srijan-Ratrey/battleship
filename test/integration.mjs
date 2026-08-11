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
const ROOM = `E2E${Math.floor(Math.random() * 900 + 100)}`;

class Client {
  constructor(label) {
    this.label = label;
    this.received = [];
    this.frames = [];
  }

  async connect() {
    this.ws = new WebSocket(`${BASE}/api/room/${ROOM}`);
    this.ws.addEventListener('message', (event) => {
      this.frames.push(event.data);
      this.received.push(JSON.parse(event.data));
    });
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', () => reject(new Error(`${this.label}: connect failed`)), {
        once: true,
      });
    });
    return this;
  }

  send(message) {
    this.ws.send(JSON.stringify(message));
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
          `${this.label}: timed out waiting for "${types}"; saw [${this.received.map((m) => m.type)}]`,
        );
      }
      await sleep(20);
    }
  }

  close() {
    this.ws.close();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const checks = [];
function check(name, fn) {
  checks.push({ name, fn });
}

// ---------------------------------------------------------------------------

const state = {};

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

check('firing out of turn is refused and costs nothing', async () => {
  state.b.send({ type: 'fire', r: 5, c: 5 });
  const error = await state.b.waitFor('error');
  assert.match(error.msg, /not your turn/i);

  // A still has the move.
  state.a.send({ type: 'fire', r: 0, c: 0 });
  const result = await state.a.waitFor('fireResult');
  assert.equal(result.r, 0);
  assert.equal(result.c, 0);
  const incoming = await state.b.waitFor('incoming');
  assert.equal(incoming.r, 0);
  assert.equal(incoming.c, 0);
  assert.equal(incoming.hit, result.hit);
  state.shotsA = 1;
});

check('off-board and repeat shots are refused', async () => {
  // It is B's turn now.
  state.b.send({ type: 'fire', r: 99, c: 0 });
  assert.match((await state.b.waitFor('error')).msg, /off the board/i);

  state.b.send({ type: 'fire', r: 3, c: 3 });
  await state.b.waitFor('fireResult');
  await state.a.waitFor('incoming');

  // Back to B after A moves.
  state.a.send({ type: 'fire', r: 0, c: 1 });
  await state.a.waitFor('fireResult');
  await state.b.waitFor('incoming');
  state.shotsA = 2;

  state.b.send({ type: 'fire', r: 3, c: 3 });
  assert.match((await state.b.waitFor('error')).msg, /already fired/i);

  state.b.send({ type: 'fire', r: 4, c: 4 });
  await state.b.waitFor('fireResult');
  await state.a.waitFor('incoming');
});

check('a dropped player rejoins and gets its own state back', async () => {
  // Keep the pre-drop transcript; the leak check below inspects both halves.
  state.framesBeforeDrop = state.a.frames.slice();
  state.a.close();

  await state.b.waitFor('opponent', (m) => m.present === false);

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
  assert.equal(marked.length, state.shotsA, 'tracking must replay A\'s own shots');
  assert.equal(resync.tracking[0][0] !== null, true);
  assert.equal(resync.tracking[0][1] !== null, true);

  // B's two shots landed on A's board, visible as A's own damage.
  assert.equal(resync.board.shot[3][3], true);
  assert.equal(resync.board.shot[4][4], true);

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
  assert.equal(gameOver.winner, 'A', 'A moves first and sweeps, so A should win');
  assert.ok(gameOver.boards.A && gameOver.boards.B, 'both fleets revealed at the end');
  assert.equal(
    gameOver.boards.B.ships.every((s) => s.sunk),
    true,
    'the loser should have no ships left',
  );
  state.gameOver = gameOver;
});

check('the enemy fleet never crossed the wire before game over', async () => {
  const enemySignatures = [
    JSON.stringify(state.gridB),
    ...state.shipsB.map((ship) => JSON.stringify(ship.cells)),
  ];

  // Every frame A received across both of its connections, up to gameOver.
  const allFrames = [...state.framesBeforeDrop, ...state.a.frames];
  const framesBeforeEnd = [];
  for (const frame of allFrames) {
    if (JSON.parse(frame).type === 'gameOver') break;
    framesBeforeEnd.push(frame);
  }
  assert.ok(framesBeforeEnd.length > 10, 'expected a real conversation to inspect');

  for (const frame of framesBeforeEnd) {
    for (const signature of enemySignatures) {
      assert.equal(frame.includes(signature), false, "B's fleet leaked to A");
    }

    const message = JSON.parse(frame);
    const grid = message.grid ?? message.board?.grid;
    if (grid) {
      // A fleet may only ever ride on the two messages that carry A's own board.
      assert.ok(['board', 'resync'].includes(message.type), `a fleet rode on "${message.type}"`);
      assert.notDeepEqual(grid, state.gridB, "A was handed B's layout");
    }
    assert.equal(message.boards ?? null, null, 'boards may only appear in gameOver');
  }

  // And the count of revealed information is exactly what was earned.
  const hitsA = allFrames
    .map((f) => JSON.parse(f))
    .filter((m) => m.type === 'fireResult' && m.hit).length;
  assert.equal(hitsA, TOTAL_SHIP_CELLS, `A should have landed exactly ${TOTAL_SHIP_CELLS} hits`);
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
