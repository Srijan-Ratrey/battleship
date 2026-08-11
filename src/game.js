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
    player.ready = false;
    player.rematch = false;
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
