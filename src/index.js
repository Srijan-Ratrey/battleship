import { DurableObject } from 'cloudflare:workers';

import {
  EXTRA_SHOT_ON_HIT,
  applyShot,
  inBounds,
  newGame,
  newPlayer,
  opponentOf,
  randomFleet,
  trackingFrom,
} from './game.js';

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
      case 'ready':
        return this.onReady(ws, game);
      case 'fire':
        return this.onFire(ws, game, message);
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
      return;
    }

    if (ws.deserializeAttachment()) {
      return send(ws, { type: 'error', msg: 'You have already joined this room.' });
    }

    const slot = !players.A ? 'A' : !players.B ? 'B' : null;
    if (!slot) {
      send(ws, { type: 'full' });
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

    const result = applyShot(target, r, c);
    if (!result.ok) return send(ws, { type: 'error', msg: result.error });

    game.shotLog[slot].push({ r, c, hit: result.hit });

    if (result.win) {
      game.phase = 'over';
      game.winner = slot;
    } else if (!(result.hit && EXTRA_SHOT_ON_HIT)) {
      game.turn = foe;
    }
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
  }

  // -- state replay ---------------------------------------------------------

  resyncFor(game, slot) {
    const me = game.players[slot];
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
  return { joined: Boolean(player), present: Boolean(player?.present), ready: Boolean(player?.ready) };
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
