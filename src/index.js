import { DurableObject } from 'cloudflare:workers';

import {
  BOT_LEVELS,
  EXTRA_SHOT_ON_HIT,
  SHIPS,
  applyShot,
  botShot,
  fleetFromPlacements,
  inBounds,
  newBot,
  newGame,
  newPlayer,
  opponentOf,
  randomFleet,
  resetForRematch,
  resolveSunk,
  trackingFrom,
} from './game.js';

// How long the computer "thinks" between shots.
const BOT_THINKING_MS = 700;

const ROOM_ROUTE = /^\/api\/room\/([A-Za-z0-9]{1,12})$/;

// ---------------------------------------------------------------------------
// Worker: a thin router. Everything that isn't /api/* is served from ./public
// by the assets layer before this handler ever runs.
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = ROOM_ROUTE.exec(url.pathname);

    if (!match) return new Response('Not found', { status: 404 });
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }

    // The room code IS the Durable Object name, so one code == one room
    // globally. Uppercased so "k7qf" and "K7QF" land in the same place.
    return env.ROOM.getByName(match[1].toUpperCase()).fetch(request);
  },
};

// ---------------------------------------------------------------------------
// Room: one Durable Object per room code. Owns both boards and every rule.
// ---------------------------------------------------------------------------

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Answered by the runtime without waking the room, so a hibernating game
    // still survives proxies that cull idle connections.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request) {
    const url = new URL(request.url);
    const code = (ROOM_ROUTE.exec(url.pathname)?.[1] ?? '').toUpperCase();

    if (!(await this.ctx.storage.get('game'))) {
      await this.ctx.storage.put('game', newGame(code));
    }

    const [client, server] = Object.values(new WebSocketPair());
    // Hibernation API: the room can be evicted between shots and the socket
    // survives, so nothing may live in instance fields.
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  // -- socket plumbing ------------------------------------------------------

  socketsFor(slot) {
    return this.ctx.getWebSockets().filter((ws) => ws.deserializeAttachment()?.slot === slot);
  }

  sendTo(slot, message) {
    for (const ws of this.socketsFor(slot)) send(ws, message);
  }

  sendBoth(message) {
    for (const ws of this.ctx.getWebSockets()) send(ws, message);
  }

  // -- message loop ---------------------------------------------------------

  async webSocketMessage(ws, raw) {
    let message;
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    } catch {
      return send(ws, { type: 'error', msg: 'Malformed message.' });
    }

    // Storage is re-read on every message on purpose: after hibernation any
    // in-memory copy would be gone.
    const game = await this.ctx.storage.get('game');
    if (!game) return send(ws, { type: 'error', msg: 'This room is not initialised.' });

    switch (message.type) {
      case 'hello':
        return this.onHello(ws, game, message);
      case 'randomize':
        return this.onRandomize(ws, game);
      case 'place':
        return this.onPlace(ws, game, message);
      case 'addBot':
        return this.onAddBot(ws, game, message);
      case 'ready':
        return this.onReady(ws, game);
      case 'fire':
        return this.onFire(ws, game, message);
      case 'rematch':
        return this.onRematch(ws, game);
      default:
        return send(ws, { type: 'error', msg: `Unknown message type: ${message.type}` });
    }
  }

  async webSocketClose(ws) {
    await this.markAbsent(ws);
  }

  async webSocketError(ws) {
    await this.markAbsent(ws);
  }

  async markAbsent(ws) {
    const slot = ws.deserializeAttachment()?.slot;
    if (!slot) return;

    // A stale socket closing right after a rejoin must not clobber the fresh
    // one's presence, so only the last socket standing marks the slot absent.
    if (this.socketsFor(slot).some((other) => other !== ws)) return;

    const game = await this.ctx.storage.get('game');
    if (!game?.players[slot] || !game.players[slot].present) return;

    game.players[slot].present = false;
    await this.ctx.storage.put('game', game);
    this.sendTo(opponentOf(slot), opponentUpdate(game, opponentOf(slot)));
  }

  // -- handlers -------------------------------------------------------------

  async onHello(ws, game, message) {
    const { players } = game;

    const rejoinSlot = ['A', 'B'].find(
      (slot) => message.playerId && players[slot]?.playerId === message.playerId,
    );

    if (rejoinSlot) {
      ws.serializeAttachment({ slot: rejoinSlot, playerId: message.playerId });

      // Attach first, then evict the half-open socket, so the close handler
      // above sees the replacement and leaves presence alone.
      for (const stale of this.socketsFor(rejoinSlot)) {
        if (stale !== ws) closeQuietly(stale, 4000, 'replaced by a newer connection');
      }

      players[rejoinSlot].present = true;
      await this.ctx.storage.put('game', game);

      send(ws, {
        type: 'welcome',
        slot: rejoinSlot,
        playerId: message.playerId,
        phase: game.phase,
      });
      send(ws, this.resyncFor(game, rejoinSlot));
      this.sendTo(opponentOf(rejoinSlot), opponentUpdate(game, opponentOf(rejoinSlot)));
      await this.ensureBotMoving(game);
      return;
    }

    if (ws.deserializeAttachment()) {
      return send(ws, { type: 'error', msg: 'You have already joined this room.' });
    }

    const slot = !players.A ? 'A' : !players.B ? 'B' : null;
    if (!slot) {
      // Name the seats nobody is currently sitting in, so someone whose tab was
      // closed can offer to take theirs back. This only says which seats are
      // empty — actually resuming one still requires that seat's token, which
      // is checked above and never leaves the machine that was issued it.
      send(ws, { type: 'full', resumable: ['A', 'B'].filter((s) => !players[s].present) });
      return closeQuietly(ws, 4001, 'room full');
    }

    const playerId = crypto.randomUUID();
    players[slot] = newPlayer(playerId);
    if (players.A && players.B && game.phase === 'lobby') game.phase = 'placing';

    ws.serializeAttachment({ slot, playerId });
    await this.ctx.storage.put('game', game);

    send(ws, { type: 'welcome', slot, playerId, phase: game.phase });
    send(ws, { type: 'board', grid: players[slot].grid, ships: players[slot].ships });
    send(ws, opponentUpdate(game, slot));
    this.sendTo(opponentOf(slot), opponentUpdate(game, opponentOf(slot)));
  }

  async onRandomize(ws, game) {
    const slot = ws.deserializeAttachment()?.slot;
    const me = slot && game.players[slot];
    if (!me) return send(ws, { type: 'error', msg: 'Join the room first.' });
    if (game.phase !== 'placing') {
      return send(ws, { type: 'error', msg: 'You can only rearrange during placement.' });
    }
    if (me.ready) return send(ws, { type: 'error', msg: 'Your fleet is already locked in.' });

    const { grid, ships } = randomFleet();
    me.grid = grid;
    me.ships = ships;
    await this.ctx.storage.put('game', game);

    // To this socket only — a fleet is never broadcast.
    send(ws, { type: 'board', grid, ships });
  }

  async onPlace(ws, game, message) {
    const slot = ws.deserializeAttachment()?.slot;
    const me = slot && game.players[slot];
    if (!me) return send(ws, { type: 'error', msg: 'Join the room first.' });
    if (game.phase !== 'placing') {
      return send(ws, { type: 'error', msg: 'You can only rearrange during placement.' });
    }
    if (me.ready) return send(ws, { type: 'error', msg: 'Your fleet is already locked in.' });

    // The client proposes positions; the grid is rebuilt and checked here.
    const fleet = fleetFromPlacements(message.ships);
    if (!fleet.ok) return send(ws, { type: 'error', msg: fleet.error });

    me.grid = fleet.grid;
    me.ships = fleet.ships;
    await this.ctx.storage.put('game', game);

    send(ws, { type: 'board', grid: fleet.grid, ships: fleet.ships });
  }

  async onReady(ws, game) {
    const slot = ws.deserializeAttachment()?.slot;
    const me = slot && game.players[slot];
    if (!me) return send(ws, { type: 'error', msg: 'Join the room first.' });
    if (game.phase !== 'placing') {
      return send(ws, { type: 'error', msg: 'Not in the placement phase.' });
    }

    me.ready = true;
    const bothReady = Boolean(game.players.A?.ready && game.players.B?.ready);
    if (bothReady) {
      game.phase = 'playing';
      game.turn = 'A';
    }
    await this.ctx.storage.put('game', game);

    send(ws, { type: 'youReady', ready: true });
    if (bothReady) {
      this.sendTo('A', { type: 'start', yourTurn: true });
      this.sendTo('B', { type: 'start', yourTurn: false });
      if (isBot(game, game.turn)) await this.scheduleBotTurn();
    } else {
      this.sendTo(opponentOf(slot), opponentUpdate(game, opponentOf(slot)));
    }
  }

  // The security boundary. Every condition is re-checked here; the client's
  // opinion about whose turn it is carries no weight.
  async onFire(ws, game, message) {
    const slot = ws.deserializeAttachment()?.slot;
    if (!slot || !game.players[slot]) {
      return send(ws, { type: 'error', msg: 'Join the room first.' });
    }
    if (game.phase !== 'playing') {
      return send(ws, { type: 'error', msg: 'The game is not in progress.' });
    }
    if (game.turn !== slot) return send(ws, { type: 'error', msg: "It's not your turn." });

    const { r, c } = message;
    if (!inBounds(r, c)) return send(ws, { type: 'error', msg: 'That cell is off the board.' });

    const foe = opponentOf(slot);
    const target = game.players[foe];
    if (!target) return send(ws, { type: 'error', msg: 'There is no opponent yet.' });

    const result = applyTurnShot(game, slot, r, c);
    if (!result.ok) return send(ws, { type: 'error', msg: result.error });
    await this.ctx.storage.put('game', game);

    const live = game.phase === 'playing';
    this.sendTo(slot, {
      type: 'fireResult',
      r,
      c,
      hit: result.hit,
      sunk: result.sunk,
      shipName: result.shipName,
      win: result.win,
      yourTurn: live && game.turn === slot,
    });
    this.sendTo(foe, {
      type: 'incoming',
      r,
      c,
      hit: result.hit,
      sunk: result.sunk,
      shipName: result.shipName,
      lose: result.win,
      yourTurn: live && game.turn === foe,
    });

    if (result.win) this.sendBoth({ type: 'gameOver', winner: slot, boards: revealBoth(game) });
    else if (isBot(game, game.turn)) await this.scheduleBotTurn();
  }

  // -- the computer opponent ------------------------------------------------

  async onAddBot(ws, game, message) {
    const slot = ws.deserializeAttachment()?.slot;
    if (!slot || !game.players[slot]) {
      return send(ws, { type: 'error', msg: 'Join the room first.' });
    }
    if (!BOT_LEVELS.includes(message.level)) {
      return send(ws, { type: 'error', msg: 'Pick an easy or hard opponent.' });
    }

    const seat = opponentOf(slot);
    if (game.players[seat]) {
      return send(ws, { type: 'error', msg: 'That seat is already taken.' });
    }

    game.players[seat] = newBot(message.level, crypto.randomUUID());
    if (game.phase === 'lobby') game.phase = 'placing';
    await this.ctx.storage.put('game', game);

    send(ws, opponentUpdate(game, slot));
  }

  // If the computer had the move when everything went quiet — this object was
  // evicted mid-turn, say — get it going again rather than stall the game.
  async ensureBotMoving(game) {
    if (game.phase !== 'playing' || !isBot(game, game.turn)) return;
    if (await this.ctx.storage.getAlarm()) return;
    await this.scheduleBotTurn(200);
  }

  // One shot per alarm, re-arming while the bot still holds the move. Paced so
  // it reads as an opponent thinking rather than a burst of results, and durable
  // — a blocking sleep would lose the rest of the turn if this object were
  // evicted mid-sequence, stranding the game with nobody able to move.
  async scheduleBotTurn(delayMs = BOT_THINKING_MS) {
    await this.ctx.storage.setAlarm(Date.now() + delayMs);
  }

  async alarm() {
    if (await this.takeBotShot()) await this.scheduleBotTurn();
  }

  // Fires exactly one shot. Returns whether the bot still has the move.
  async takeBotShot() {
    const game = await this.ctx.storage.get('game');
    const slot = game && botSlot(game);
    if (!slot || game.phase !== 'playing' || game.turn !== slot) return false;

    const foe = opponentOf(slot);
    if (!game.players[foe]) return false;

    const { bot } = game.players[slot];
    // Its own hit/miss history and nothing else — the same view the player on
    // the other side of the table has.
    const shot = botShot(trackingFrom(game.shotLog[slot]), bot.pending, bot.level);
    if (!shot) return false;

    const [r, c] = shot;
    const result = applyTurnShot(game, slot, r, c);
    if (!result.ok) return false;

    if (result.hit) {
      bot.pending.push([r, c]);
      if (result.sunk) {
        const { size } = SHIPS.find((s) => s.name === result.shipName);
        bot.pending = resolveSunk(bot.pending, r, c, size);
      }
    }
    await this.ctx.storage.put('game', game);

    const live = game.phase === 'playing';
    this.sendTo(foe, {
      type: 'incoming',
      r,
      c,
      hit: result.hit,
      sunk: result.sunk,
      shipName: result.shipName,
      lose: result.win,
      yourTurn: live && game.turn === foe,
    });

    if (result.win) this.sendBoth({ type: 'gameOver', winner: slot, boards: revealBoth(game) });
    return live && game.turn === slot;
  }

  // Both players must ask before the room resets, so one side cannot wipe a
  // finished board out from under the other.
  async onRematch(ws, game) {
    const slot = ws.deserializeAttachment()?.slot;
    const me = slot && game.players[slot];
    if (!me) return send(ws, { type: 'error', msg: 'Join the room first.' });
    if (game.phase !== 'over') return send(ws, { type: 'error', msg: 'The game is not over yet.' });

    me.rematch = true;
    const foe = opponentOf(slot);
    // Nobody has to wait on the computer to agree to another game.
    if (isBot(game, foe)) game.players[foe].rematch = true;

    if (!(game.players.A?.rematch && game.players.B?.rematch)) {
      await this.ctx.storage.put('game', game);
      send(ws, { type: 'rematchPending' });
      this.sendTo(foe, { type: 'rematchOffer' });
      return;
    }

    resetForRematch(game);
    await this.ctx.storage.put('game', game);
    // A full resync each — same machinery a rejoin uses, so the client has one
    // code path for "here is the whole world again".
    for (const s of ['A', 'B']) this.sendTo(s, this.resyncFor(game, s));
  }

  // -- state replay ---------------------------------------------------------

  resyncFor(game, slot) {
    const me = game.players[slot];
    const foe = game.players[opponentOf(slot)];
    const over = game.phase === 'over';

    return {
      type: 'resync',
      phase: game.phase,
      slot,
      ready: me.ready,
      yourTurn: game.phase === 'playing' && game.turn === slot,
      // Your own fleet and the cells your opponent has fired at it.
      board: { grid: me.grid, ships: me.ships, shot: me.shot },
      // Rebuilt from your own shots — nothing here you didn't earn by firing.
      tracking: trackingFrom(game.shotLog[slot]),
      // Names only, of ships you have already sunk. You were told each one at
      // the time it went down, so replaying the list reveals nothing new — and
      // without it a rejoin silently loses your kill list.
      enemySunk: foe ? foe.ships.filter((s) => s.sunk).map((s) => s.name) : [],
      opponent: presenceOf(game, opponentOf(slot)),
      over,
      winner: game.winner,
      boards: over ? revealBoth(game) : null,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function send(ws, message) {
  try {
    ws.send(JSON.stringify(message));
  } catch {
    // The socket closed between our slot lookup and this write. Nothing to do
    // and nothing to report: webSocketClose handles the state change.
  }
}

function closeQuietly(ws, code, reason) {
  try {
    ws.close(code, reason);
  } catch {
    // Already closed.
  }
}

function presenceOf(game, slot) {
  const player = game.players[slot];
  return {
    joined: Boolean(player),
    present: Boolean(player?.present),
    ready: Boolean(player?.ready),
    bot: player?.bot?.level ?? null,
  };
}

const botSlot = (game) => ['A', 'B'].find((s) => game.players[s]?.bot) ?? null;
const isBot = (game, slot) => Boolean(slot && game.players[slot]?.bot);

// Shared by a player's `fire` and the computer's turn, so the two can never
// drift apart on the turn rule. Mutates `game`.
function applyTurnShot(game, slot, r, c) {
  const foe = opponentOf(slot);
  const result = applyShot(game.players[foe], r, c);
  if (!result.ok) return result;

  game.shotLog[slot].push({ r, c, hit: result.hit });
  if (result.win) {
    game.phase = 'over';
    game.winner = slot;
  } else if (!(result.hit && EXTRA_SHOT_ON_HIT)) {
    game.turn = foe;
  }
  return result;
}

// Addressed TO `slot`, describing the OTHER player plus the room phase.
function opponentUpdate(game, slot) {
  return { type: 'opponent', phase: game.phase, ...presenceOf(game, opponentOf(slot)) };
}

// The only place a fleet crosses to the player who doesn't own it — and only
// once the game is over and there is nothing left to cheat at.
function revealBoth(game) {
  const reveal = (p) => (p ? { grid: p.grid, ships: p.ships, shot: p.shot } : null);
  return { A: reveal(game.players.A), B: reveal(game.players.B) };
}
