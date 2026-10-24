
const json = (value, status = 200) => new Response(
  JSON.stringify(value),
  {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*"
    }
  }
);

const randomCode = () =>
  Array.from(
    crypto.getRandomValues(new Uint8Array(6)),
    x => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[x % 32]
  ).join("");

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type"
        }
      });
    }

    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true, service: "word-duel" });
    }

    if (request.method !== "POST") {
      return json({
        message: "Word Duel API",
        endpoints: [
          "POST /create",
          "POST /join",
          "POST /quick",
          "POST /status",
          "POST /leave"
        ]
      });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }

    const playerId = String(body.playerId || "").trim();

    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(playerId)) {
      return json({ error: "invalid_player_id" }, 400);
    }

    let code = String(body.code || "").trim().toUpperCase();

    if (url.pathname === "/create") code = randomCode();
    if (url.pathname === "/quick") code = "MATCHMAKER";

    if (!/^[A-Z2-9]{6}$/.test(code) && code !== "MATCHMAKER") {
      return json({ error: "invalid_room_code" }, 400);
    }

    const stub = env.GAME_ROOMS.get(
      env.GAME_ROOMS.idFromName(code)
    );

    return stub.fetch(
      new Request("https://room.internal" + url.pathname, {
        method: "POST",
        body: JSON.stringify({ ...body, playerId, code })
      })
    );
  }
};

export class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const { playerId, code, roomId } = await request.json();
    const action = new URL(request.url).pathname;
    const now = Date.now();

    let rooms = await this.ctx.storage.get("rooms") || {};

    for (const [key, room] of Object.entries(rooms)) {
      if (now - room.updated > 3600000) {
        delete rooms[key];
      }
    }

    const result = (payload, status = 200) =>
      json(payload, status);

    if (code === "MATCHMAKER") {
      if (!["/quick", "/leave", "/status"].includes(action)) {
        return result({ error: "unsupported" }, 400);
      }

      if (action === "/quick") {
        let room = Object.values(rooms).find(
          r => r.players.includes(playerId)
        );

        if (!room) {
          room = Object.values(rooms).find(
            r => r.players.length === 1 &&
                 r.players[0] !== playerId
          );

          if (room) {
            room.players.push(playerId);
            room.updated = now;
          } else {
            const id = crypto.randomUUID();
            room = {
              code: id,
              players: [playerId],
              updated: now
            };
            rooms[id] = room;
          }
        }

        await this.ctx.storage.put("rooms", rooms);

        return result({
          roomId: room.code,
          status: room.players.length === 2 ? "ready" : "waiting",
          players: room.players
        });
      }

      const room = Object.values(rooms).find(
        r => r.code === String(roomId || "") &&
             r.players.includes(playerId)
      );

      if (!room) {
        return result({ error: "room_not_found" }, 404);
      }

      if (action === "/leave") {
        delete rooms[room.code];
        await this.ctx.storage.put("rooms", rooms);
        return result({ ok: true });
      }

      return result({
        roomId: room.code,
        status: room.players.length === 2 ? "ready" : "waiting",
        players: room.players
      });
    }

    let room = rooms[code];

    if (action === "/create") {
      if (room) {
        return result({ error: "code_collision_retry" }, 409);
      }

      room = {
        code,
        players: [playerId],
        updated: now
      };
      rooms[code] = room;

    } else if (action === "/join") {
      if (!room) {
        return result({ error: "room_not_found" }, 404);
      }

      if (!room.players.includes(playerId)) {
        if (room.players.length >= 2) {
          return result({ error: "room_full" }, 409);
        }
        room.players.push(playerId);
      }

      room.updated = now;

    } else if (action === "/status") {
      if (!room || !room.players.includes(playerId)) {
        return result({ error: "room_not_found" }, 404);
      }

    } else if (action === "/leave") {
      if (!room || !room.players.includes(playerId)) {
        return result({ error: "room_not_found" }, 404);
      }

      delete rooms[code];
      await this.ctx.storage.put("rooms", rooms);
      return result({ ok: true });

    } else {
      return result({ error: "not_found" }, 404);
    }

    await this.ctx.storage.put("rooms", rooms);

    return result({
      code,
      status: room.players.length === 2 ? "ready" : "waiting",
      players: room.players
    });
  }
}
