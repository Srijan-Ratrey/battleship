import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  SIZE,
  SHIPS,
  TOTAL_SHIP_CELLS,
  applyShot,
  emptyShotGrid,
  inBounds,
  newGame,
  newPlayer,
  opponentOf,
  randomCode,
  randomFleet,
  trackingFrom,
} from '../src/game.js';

const key = ([r, c]) => `${r},${c}`;

function firstEmptyCell(player) {
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (player.grid[r][c] === -1) return [r, c];
    }
  }
  throw new Error('board has no empty cell');
}

describe('randomFleet', () => {
  it('produces a legal fleet every time, over many rolls', () => {
    for (let iteration = 0; iteration < 500; iteration++) {
      const { grid, ships } = randomFleet();

      assert.equal(ships.length, SHIPS.length);

      const occupied = new Set();
      ships.forEach((ship, index) => {
        const spec = SHIPS[index];
        assert.equal(ship.name, spec.name);
        assert.equal(ship.size, spec.size);
        assert.equal(ship.cells.length, spec.size);
        assert.equal(ship.hits, 0);
        assert.equal(ship.sunk, false);

        for (const [r, c] of ship.cells) {
          assert.ok(inBounds(r, c), `cell ${r},${c} out of bounds`);
          assert.equal(occupied.has(key([r, c])), false, `overlap at ${r},${c}`);
          occupied.add(key([r, c]));
          assert.equal(grid[r][c], index, `grid at ${r},${c} disagrees with ships[]`);
        }

        // Contiguous and axis-aligned: exactly one coordinate varies, by 1 each step.
        const rows = new Set(ship.cells.map(([r]) => r));
        const cols = new Set(ship.cells.map(([, c]) => c));
        const horizontal = rows.size === 1;
        assert.ok(horizontal || cols.size === 1, 'ship is neither a row nor a column');
        const varying = ship.cells.map(([r, c]) => (horizontal ? c : r));
        for (let i = 1; i < varying.length; i++) {
          assert.equal(varying[i], varying[i - 1] + 1, 'ship cells are not contiguous');
        }
      });

      assert.equal(occupied.size, TOTAL_SHIP_CELLS);

      const gridOccupied = grid.flat().filter((v) => v !== -1).length;
      assert.equal(gridOccupied, TOTAL_SHIP_CELLS);
    }
  });
});

describe('applyShot', () => {
  it('reports a miss on open water and marks the cell', () => {
    const player = newPlayer('p1');
    const [r, c] = firstEmptyCell(player);

    const result = applyShot(player, r, c);

    assert.deepEqual(result, { ok: true, hit: false, sunk: false, shipName: null, win: false });
    assert.equal(player.shot[r][c], true);
  });

  it('reports a hit without naming the ship', () => {
    const player = newPlayer('p1');
    const carrier = player.ships[0];
    const [r, c] = carrier.cells[0];

    const result = applyShot(player, r, c);

    assert.equal(result.ok, true);
    assert.equal(result.hit, true);
    assert.equal(result.sunk, false);
    // Naming a ship on a plain hit would leak its size.
    assert.equal(result.shipName, null);
    assert.equal(carrier.hits, 1);
  });

  it('rejects a repeat shot and changes nothing', () => {
    const player = newPlayer('p1');
    const [r, c] = player.ships[0].cells[0];

    applyShot(player, r, c);
    const hitsAfterFirst = player.ships[0].hits;
    const result = applyShot(player, r, c);

    assert.equal(result.ok, false);
    assert.match(result.error, /already fired/i);
    assert.equal(player.ships[0].hits, hitsAfterFirst);
  });

  it('rejects out-of-bounds and non-integer coordinates', () => {
    const player = newPlayer('p1');
    for (const [r, c] of [[-1, 0], [0, -1], [SIZE, 0], [0, SIZE], [1.5, 2], ['0', 0]]) {
      const result = applyShot(player, r, c);
      assert.equal(result.ok, false, `expected ${r},${c} to be rejected`);
      assert.match(result.error, /off the board/i);
    }
  });

  it('sinks a ship on its last cell and names it', () => {
    const player = newPlayer('p1');
    const destroyer = player.ships.find((s) => s.name === 'Destroyer');

    const first = applyShot(player, ...destroyer.cells[0]);
    assert.equal(first.sunk, false);

    const last = applyShot(player, ...destroyer.cells[1]);
    assert.equal(last.hit, true);
    assert.equal(last.sunk, true);
    assert.equal(last.shipName, 'Destroyer');
    // Four ships still afloat.
    assert.equal(last.win, false);
    assert.equal(destroyer.sunk, true);
  });

  it('declares a win only on the final ship cell', () => {
    const player = newPlayer('p1');
    const allCells = player.ships.flatMap((s) => s.cells);
    assert.equal(allCells.length, TOTAL_SHIP_CELLS);

    const results = allCells.map(([r, c]) => applyShot(player, r, c));

    assert.equal(results.every((x) => x.ok && x.hit), true);
    assert.equal(results.slice(0, -1).some((x) => x.win), false);
    assert.equal(results.at(-1).win, true);
    assert.equal(player.ships.every((s) => s.sunk), true);
  });

  it('does not let misses count toward a win', () => {
    const player = newPlayer('p1');
    const [r, c] = firstEmptyCell(player);
    const result = applyShot(player, r, c);
    assert.equal(result.win, false);
  });
});

describe('trackingFrom', () => {
  it('replays a shot log into a hit/miss grid, leaving the rest unknown', () => {
    const grid = trackingFrom([
      { r: 0, c: 0, hit: true },
      { r: 4, c: 7, hit: false },
    ]);

    assert.equal(grid[0][0], 'hit');
    assert.equal(grid[4][7], 'miss');
    assert.equal(grid[9][9], null);
    assert.equal(grid.flat().filter((v) => v !== null).length, 2);
  });
});

describe('helpers', () => {
  it('emptyShotGrid is 10x10 and all false', () => {
    const grid = emptyShotGrid();
    assert.equal(grid.length, SIZE);
    assert.equal(grid.every((row) => row.length === SIZE), true);
    assert.equal(grid.flat().some(Boolean), false);
  });

  it('randomCode is 4 unambiguous uppercase characters', () => {
    for (let i = 0; i < 200; i++) {
      assert.match(randomCode(), /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);
    }
  });

  it('opponentOf flips the slot', () => {
    assert.equal(opponentOf('A'), 'B');
    assert.equal(opponentOf('B'), 'A');
  });

  it('newGame starts empty in the lobby', () => {
    const game = newGame('TEST');
    assert.equal(game.code, 'TEST');
    assert.equal(game.phase, 'lobby');
    assert.equal(game.winner, null);
    assert.equal(game.players.A, null);
    assert.equal(game.players.B, null);
    assert.deepEqual(game.shotLog, { A: [], B: [] });
  });
});
