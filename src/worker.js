
const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type"
};

function respond(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: HEADERS
  });
}

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function makeCode() {
  return Array.from(
    crypto.getRandomValues(new Uint8Array(6)),
    n => ALPHABET[n % ALPHABET.length]
  ).join("");
}

const LEVELS = [
  {
    letters: "کتاب",
    words: ["کتاب", "تاب", "باک", "تاک", "بات"]
  },
  {
    letters: "مادر",
    words: ["مادر", "دام", "رام", "مار", "دار", "راد"]
  },
  {
    letters: "دریا",
    words: ["دریا", "یار", "دار", "یاد", "رای", "دیر"]
  },
  {
    letters: "بهار",
    words: ["بهار", "راه", "بار", "هار", "ربا"]
  },
  {
    letters: "سفره",
    words: ["سفره", "سفر", "سره", "رفه"]
  }
];

function norm(value) {
  return String(value || "")
    .normalize("NFC")
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[\u064B-\u065F\u0670\u200c\s]/g, "")
    .trim();
}

function buildable(word, letters) {
  const chars = [...letters];

  for (const c of [...word]) {
    const index = chars.indexOf(c);

    if (index < 0) return false;

    chars.splice(index, 1);
  }

  return true;
}

function chooseLetters() {
  const level = LEVELS[
    Math.floor(Math.random() * LEVELS.length)
  ];

  return level.letters;
}

function summary(room, playerId) {
  const index = room.players.indexOf(playerId);

  const active =
    room.players.length === 2 &&
    !!room.deadline;

  const remaining = active
    ? Math.max(
        0,
        Math.ceil((room.deadline - Date.now()) / 1000)
      )
    : 90;

  const status = !active
    ? "waiting"
    : remaining > 0
      ? "playing"
      : "finished";

  let winner = null;

  if (status === "finished") {
    winner = room.scores[0] === room.scores[1]
      ? 0
      : room.scores[0] > room.scores[1]
        ? 1
        : 2;
  }

  return {
    code: room.code,
    roomId: room.code,
    status,
    players: room.players,
    letters: active ? room.letters : null,
    seconds: remaining,
    scores: room.scores || [0, 0],
    words: room.words || [[], []],
    playerIndex: index,
    winner,
    round: room.round || 1,
    rematchVotes: room.rematchVotes || [],
    rematchRequested:
      (room.rematchVotes || []).length > 0
  };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: HEADERS
      });
    }

    const path = new URL(request.url).pathname;

    if (path === "/health") {
      return respond({
        ok: true,
        service: "word-duel",
        gameplay: true,
        version: 5,
        matchmaking: "fixed",
        rematch: true,
        dictionaryMode: "built_in"
      });
    }

    if (request.method !== "POST") {
      return respond({
        message: "Word Duel API v5",
        endpoints: [
          "/create",
          "/join",
          "/quick",
          "/status",
          "/word",
          "/leave",
          "/rematch"
        ]
      });
    }

    let body;

    try {
      body = await request.json();
    } catch {
      return respond({
        error: "invalid_json"
      }, 400);
    }

    const playerId = String(
      body.playerId || ""
    ).trim();

    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(playerId)) {
      return respond({
        error: "invalid_player_id"
      }, 400);
    }

    let roomCode = String(
      body.code || body.roomId || ""
    ).trim().toUpperCase();

    if (path === "/create") {
      roomCode = makeCode();
    }

    if (
      path === "/quick" ||
      body.matchType === "quick"
    ) {
      roomCode = "MATCHMAKER";
    }

    if (
      !/^[A-Z2-9]{6}$/.test(roomCode) &&
      roomCode !== "MATCHMAKER"
    ) {
      return respond({
        error: "invalid_room_code"
      }, 400);
    }

    const id = env.GAME_ROOMS.idFromName(roomCode);
    const stub = env.GAME_ROOMS.get(id);

    return stub.fetch(
      new Request("https://room.internal" + path, {
        method: "POST",
        body: JSON.stringify({
          ...body,
          playerId,
          code: roomCode
        })
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
    const data = await request.json();

    const playerId = data.playerId;
    const roomKey = data.code;
    const action = new URL(request.url).pathname;
    const now = Date.now();

    const rooms =
      await this.ctx.storage.get("rooms") || {};

    for (const [key, room] of Object.entries(rooms)) {
      if (now - (room.updated || 0) > 3600000) {
        delete rooms[key];
      }
    }

    const save = async () => {
      await this.ctx.storage.put("rooms", rooms);
    };

    const createRoom = id => ({
      code: id,
      players: [playerId],
      updated: now,
      scores: [0, 0],
      words: [[], []],
      letters: null,
      deadline: null,
      round: 1,
      rematchVotes: []
    });

    const activate = room => {
      if (
        room.players.length === 2 &&
        !room.deadline
      ) {
        room.letters = chooseLetters();
        room.deadline = Date.now() + 90000;
        room.scores = [0, 0];
        room.words = [[], []];
        room.rematchVotes = [];
        room.updated = Date.now();
      }
    };

    // مسابقه تصادفی
    if (roomKey === "MATCHMAKER") {

      if (action === "/quick") {

        for (const [key, room] of Object.entries(rooms)) {
          if (
            room.players.includes(playerId) &&
            (room.deadline || room.players.length !== 1)
          ) {
            room.players = room.players.filter(
              p => p !== playerId
            );

            if (
              !room.players.length ||
              room.deadline
            ) {
              delete rooms[key];
            }
          }
        }

        let room = Object.values(rooms).find(
          r =>
            r.players.length === 1 &&
            r.players[0] === playerId &&
            !r.deadline
        );

        if (!room) {
          room = Object.values(rooms).find(
            r =>
              r.players.length === 1 &&
              !r.deadline &&
              r.players[0] !== playerId &&
              now - (r.updated || 0) < 120000
          );

          if (room) {
            room.players.push(playerId);
            activate(room);
          } else {
            room = createRoom(crypto.randomUUID());
            rooms[room.code] = room;
          }
        }

        room.updated = Date.now();
        await save();

        return respond(summary(room, playerId));
      }

      const requested = String(data.roomId || "");

      const room = Object.values(rooms).find(
        r =>
          r.code === requested &&
          r.players.includes(playerId)
      );

      if (!room) {
        return respond({
          error: "room_not_found"
        }, 404);
      }

      return this.handle(
        room,
        rooms,
        action,
        data,
        playerId,
        save
      );
    }

    // اتاق خصوصی
    let room = rooms[roomKey];

    if (action === "/create") {
      if (room) {
        return respond({
          error: "code_collision_retry"
        }, 409);
      }

      room = createRoom(roomKey);
      rooms[roomKey] = room;

      await save();

      return respond(summary(room, playerId));
    }

    if (action === "/join") {
      if (!room) {
        return respond({
          error: "room_not_found"
        }, 404);
      }

      if (!room.players.includes(playerId)) {
        if (
          room.players.length >= 2 ||
          room.deadline
        ) {
          return respond({
            error: "room_full"
          }, 409);
        }

        room.players.push(playerId);
        activate(room);
      }

      room.updated = Date.now();
      await save();

      return respond(summary(room, playerId));
    }

    if (
      !room ||
      !room.players.includes(playerId)
    ) {
      return respond({
        error: "room_not_found"
      }, 404);
    }

    return this.handle(
      room,
      rooms,
      action,
      data,
      playerId,
      save
    );
  }

  async handle(
    room,
    rooms,
    action,
    data,
    playerId,
    save
  ) {

    if (action === "/status") {
      return respond(summary(room, playerId));
    }

    // مسابقه انتقامی
    if (action === "/rematch") {
      if (
        room.players.length !== 2 ||
        !room.deadline ||
        Date.now() < room.deadline
      ) {
        return respond({
          error: "rematch_not_ready"
        }, 409);
      }

      room.rematchVotes ||= [];

      if (!room.rematchVotes.includes(playerId)) {
        room.rematchVotes.push(playerId);
      }

      // با تأیید هر دو نفر، دور تازه آغاز می‌شود
      if (room.rematchVotes.length === 2) {
        room.round = (room.round || 1) + 1;

        room.letters = chooseLetters();
        room.deadline = Date.now() + 90000;

        room.scores = [0, 0];
        room.words = [[], []];
        room.rematchVotes = [];
      }

      room.updated = Date.now();
      await save();

      return respond(summary(room, playerId));
    }

    // خروج از اتاق
    if (action === "/leave") {
      room.players = room.players.filter(
        p => p !== playerId
      );

      if (
        room.players.length === 0 ||
        room.deadline
      ) {
        delete rooms[room.code];
      } else {
        room.updated = Date.now();
      }

      await save();

      return respond({
        ok: true
      });
    }

    // ثبت کلمه
    if (action === "/word") {
      if (room.players.length !== 2) {
        return respond({
          error: "waiting_for_opponent"
        }, 409);
      }

      if (Date.now() >= room.deadline) {
        return respond({
          error: "game_finished",
          ...summary(room, playerId)
        }, 409);
      }

      const word = norm(data.word);
      const index = room.players.indexOf(playerId);

      if (
        !word ||
        word.length > 24 ||
        word.length < 2
      ) {
        return respond({
          error: "invalid_word"
        }, 400);
      }

      const level = LEVELS.find(
        l => l.letters === room.letters
      );

      if (
        !level ||
        !level.words.includes(word) ||
        !buildable(word, room.letters)
      ) {
        return respond({
          error: "word_not_in_dictionary",
          ...summary(room, playerId)
        }, 422);
      }

      if (room.words[index].includes(word)) {
        return respond({
          error: "already_found",
          ...summary(room, playerId)
        }, 409);
      }

      room.words[index].push(word);

      const points = word.length * 10;
      room.scores[index] += points;
      room.updated = Date.now();

      await save();

      return respond({
        accepted: true,
        points,
        ...summary(room, playerId)
      });
    }

    return respond({
      error: "not_found"
    }, 404);
  }
}
