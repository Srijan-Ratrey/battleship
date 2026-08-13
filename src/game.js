// Pure Battleship rules. No network, no Cloudflare imports — so this file runs
// under plain Node and is unit-tested in test/game.test.mjs.

export const SIZE = 10;

export const SHIPS = [
  { name: 'Carrier', size: 5 },
  { name: 'Battleship', size: 4 },
  { name: 'Cruiser', size: 3 },
  { name: 'Submarine', size: 3 },
  { name: 'Destroyer', size: 2 },
];

export const TOTAL_SHIP_CELLS = SHIPS.reduce((n, s) => n + s.size, 0);

// Decision A: a hit earns another shot; a miss ends the turn. Set this to false
// for strict Milton Bradley rules (one shot per turn regardless). The turn logic
// in src/index.js is the only reader.
export const EXTRA_SHOT_ON_HIT = true;

// No I/O/0/1 — room codes get read aloud and typed by hand.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function filledGrid(value) {
  return Array.from({ length: SIZE }, () => Array.from({ length: SIZE }, () => value));
}

export function emptyShotGrid() {
  return filledGrid(false);
}

export function randomCode(length = 4) {
  let code = '';
  for (let i = 0; i < length; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

export function opponentOf(slot) {
  return slot === 'A' ? 'B' : 'A';
}

// Rejection sampling: pick an orientation and origin, retry on overlap. With 17
// cells in 100 the expected retry count is tiny, so this stays well clear of
// pathological loops.
export function randomFleet() {
  const grid = filledGrid(-1);
  const ships = [];

  SHIPS.forEach((spec, index) => {
    for (;;) {
      const horizontal = Math.random() < 0.5;
      const span = spec.size - 1;
      const r = Math.floor(Math.random() * (horizontal ? SIZE : SIZE - span));
      const c = Math.floor(Math.random() * (horizontal ? SIZE - span : SIZE));

      const cells = [];
      for (let i = 0; i < spec.size; i++) {
        cells.push(horizontal ? [r, c + i] : [r + i, c]);
      }
      if (cells.some(([cr, cc]) => grid[cr][cc] !== -1)) continue;

      for (const [cr, cc] of cells) grid[cr][cc] = index;
      ships.push({ name: spec.name, size: spec.size, cells, hits: 0, sunk: false });
      return;
    }
  });

  return { grid, ships };
}

// Rebuilds a fleet from a client-supplied arrangement. The client may propose a
// layout, but it never supplies the grid — this recomputes it and rejects
// anything that isn't a legal fleet, so a tampered client cannot stack its ships
// on one cell or hang them off the board.
export function fleetFromPlacements(placements) {
  if (!Array.isArray(placements) || placements.length !== SHIPS.length) {
    return { ok: false, error: `A fleet is exactly ${SHIPS.length} ships.` };
  }

  const grid = filledGrid(-1);
  const ships = [];

  for (let index = 0; index < SHIPS.length; index++) {
    const spec = SHIPS[index];
    const placement = placements.find((p) => p && p.name === spec.name);
    if (!placement) return { ok: false, error: `Your fleet is missing its ${spec.name}.` };

    const { r, c } = placement;
    const horizontal = Boolean(placement.horizontal);
    if (!inBounds(r, c)) return { ok: false, error: `The ${spec.name} starts off the board.` };

    const cells = [];
    for (let i = 0; i < spec.size; i++) {
      const cr = horizontal ? r : r + i;
      const cc = horizontal ? c + i : c;
      if (!inBounds(cr, cc)) return { ok: false, error: `The ${spec.name} hangs off the board.` };
      if (grid[cr][cc] !== -1) return { ok: false, error: `The ${spec.name} overlaps another ship.` };
      cells.push([cr, cc]);
    }

    for (const [cr, cc] of cells) grid[cr][cc] = index;
    ships.push({ name: spec.name, size: spec.size, cells, hits: 0, sunk: false });
  }

  return { ok: true, grid, ships };
}

export function newPlayer(playerId) {
  const { grid, ships } = randomFleet();
  return {
    playerId,
    present: true,
    ready: false,
    rematch: false,
    grid,
    ships,
    shot: emptyShotGrid(),
  };
}

export const BOT_LEVELS = ['easy', 'hard'];

// A bot is an ordinary player that happens to have no socket: always present,
// already ready, and carrying the little memory its brain needs. It still gets a
// real random playerId — a guessable one would let anyone `hello` their way into
// the bot's seat and read the fleet they are playing against.
export function newBot(level, playerId) {
  return {
    ...newPlayer(playerId),
    present: true,
    ready: true,
    bot: { level, pending: [] },
  };
}

// Rematch in the same room: fresh fleets and a cleared history, but the same
// two players in the same slots. Mutates and returns `game`.
export function resetForRematch(game) {
  for (const slot of ['A', 'B']) {
    const player = game.players[slot];
    if (!player) continue;

    const { grid, ships } = randomFleet();
    player.grid = grid;
    player.ships = ships;
    player.shot = emptyShotGrid();
    // A bot never presses Ready, so leaving it unready would hang the rematch.
    player.ready = Boolean(player.bot);
    player.rematch = false;
    if (player.bot) player.bot.pending = [];
  }

  game.phase = 'placing';
  game.turn = 'A';
  game.winner = null;
  game.shotLog = { A: [], B: [] };
  return game;
}

export function newGame(code) {
  return {
    code,
    phase: 'lobby',
    turn: 'A',
    winner: null,
    players: { A: null, B: null },
    shotLog: { A: [], B: [] },
  };
}

export function inBounds(r, c) {
  return Number.isInteger(r) && Number.isInteger(c) && r >= 0 && r < SIZE && c >= 0 && c < SIZE;
}

// Applies a shot to `player`'s own board — i.e. `player` is the one being shot
// AT. Mutates player.shot and the hit ship. Returns ok:false and changes nothing
// when the shot is illegal.
export function applyShot(player, r, c) {
  if (!inBounds(r, c)) return { ok: false, error: 'That cell is off the board.' };
  if (player.shot[r][c]) return { ok: false, error: 'You already fired there.' };

  player.shot[r][c] = true;

  const shipIndex = player.grid[r][c];
  if (shipIndex === -1) {
    return { ok: true, hit: false, sunk: false, shipName: null, win: false };
  }

  const ship = player.ships[shipIndex];
  ship.hits += 1;
  ship.sunk = ship.hits >= ship.size;

  return {
    ok: true,
    hit: true,
    sunk: ship.sunk,
    // Naming the ship on a plain hit would leak its size. Only on a sink.
    shipName: ship.sunk ? ship.name : null,
    win: player.ships.every((s) => s.sunk),
  };
}

// Rebuilds a player's tracking grid from their OWN shot log, for rejoin. Every
// cell here is something they already earned by firing at it.
export function trackingFrom(log) {
  const grid = filledGrid(null);
  for (const { r, c, hit } of log) grid[r][c] = hit ? 'hit' : 'miss';
  return grid;
}

// ---------------------------------------------------------------------------
// The computer opponent.
//
// Everything below decides from `tracking` — the bot's OWN hit/miss history,
// exactly what a player sitting there would see — and is never handed a fleet.
// That is the anti-cheat guarantee, made structural: there is no parameter here
// through which the opponent's layout could arrive.
// ---------------------------------------------------------------------------

const CARDINALS = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const AXES = [[0, 1], [1, 0]];

const key = (r, c) => `${r},${c}`;
const pickOne = (cells) => cells[Math.floor(Math.random() * cells.length)];

function unfired(tracking) {
  const open = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (tracking[r][c] === null) open.push([r, c]);
    }
  }
  return open;
}

// Where to shoot next given hits on ships that haven't sunk yet.
function targetCandidates(tracking, pending) {
  const live = new Set(pending.map(([r, c]) => key(r, c)));

  // Two adjacent hits reveal the ship's axis, so the rest of it lies off one end
  // or the other. That beats poking at all four neighbours.
  const alongTheLine = [];
  for (const [r, c] of pending) {
    for (const [dr, dc] of AXES) {
      if (!live.has(key(r + dr, c + dc))) continue;

      for (const sign of [1, -1]) {
        let rr = r;
        let cc = c;
        while (live.has(key(rr + dr * sign, cc + dc * sign))) {
          rr += dr * sign;
          cc += dc * sign;
        }
        const nr = rr + dr * sign;
        const nc = cc + dc * sign;
        if (inBounds(nr, nc) && tracking[nr][nc] === null) alongTheLine.push([nr, nc]);
      }
    }
  }
  if (alongTheLine.length) return alongTheLine;

  // A lone hit — the ship runs in one of four directions, so try around it.
  const around = [];
  for (const [r, c] of pending) {
    for (const [dr, dc] of CARDINALS) {
      const nr = r + dr;
      const nc = c + dc;
      if (inBounds(nr, nc) && tracking[nr][nc] === null) around.push([nr, nc]);
    }
  }
  return around;
}

export function botShot(tracking, pending = [], level = 'hard') {
  const open = unfired(tracking);
  if (!open.length) return null;

  if (level !== 'hard') return pickOne(open); // easy: fire anywhere untouched

  const targets = targetCandidates(tracking, pending);
  if (targets.length) return pickOne(targets);

  // Hunting. No ship is shorter than two cells, so every ship must cover at
  // least one square where (r + c) is even — searching only those halves the
  // work without any chance of stepping over a ship.
  const parity = open.filter(([r, c]) => (r + c) % 2 === 0);
  return pickOne(parity.length ? parity : open);
}

// A ship went down at [r, c] (already pushed onto `pending`). Drop the cells it
// occupied so the bot stops working a wreck. Biased towards leaving a cell
// behind rather than removing one too many: a stale hit costs a few shots, but
// dropping a live one abandons a ship that is still afloat.
export function resolveSunk(pending, r, c, size) {
  const live = new Set(pending.map(([pr, pc]) => key(pr, pc)));
  let run = [[r, c]];

  for (const [dr, dc] of AXES) {
    const line = [[r, c]];
    for (const sign of [1, -1]) {
      let rr = r;
      let cc = c;
      while (line.length < size && live.has(key(rr + dr * sign, cc + dc * sign))) {
        rr += dr * sign;
        cc += dc * sign;
        line.push([rr, cc]);
      }
    }
    if (line.length > run.length) run = line;
  }

  const gone = new Set(run.map(([rr, cc]) => key(rr, cc)));
  return pending.filter(([pr, pc]) => !gone.has(key(pr, pc)));
}
