// services/socket_handler/matchHandler.js

/**
 * Match handler using rooms
 * Rooms:
 *  - user:<id>
 *  - <id>
 *  - match:<matchId>
 */

import { getMatchState, upsertMatchState, touchMatch } from "./matchState.js";

function normId(v) {
  if (v === null || v === undefined) return "";
  const s = String(v).trim();
  return s.length ? s : "";
}

function matchRoom(matchId) {
  return `match:${normId(matchId)}`;
}

function emitToUser(io, userId, event, payload) {
  const uid = normId(userId);
  if (!io || !uid) return;
  io.to(`user:${uid}`).emit(event, payload);
  io.to(uid).emit(event, payload);
}

function safeEmit(socket, event, payload) {
  try {
    socket.emit(event, payload);
  } catch (_) {}
}

export default function matchHandler(io, socket, presence) {
  // ----------------------------
  // Challenge flow (existing)
  // ----------------------------
  socket.on("match:challenge_sent", (payload) => {
    try {
      const { opponentId, matchId, entryFee, challengerInfo } = payload || {};
      const opp = normId(opponentId);
      const mid = normId(matchId);

      if (!opp || !mid) {
        console.log("match:challenge_sent invalid payload", payload);
        return;
      }

      emitToUser(io, opp, "challenge:received", {
        matchId: mid,
        entryFee: Number(entryFee || 0),
        opponentId: opp,
        challengerInfo: challengerInfo || {},
        timestamp: Date.now(),
      });

      console.log("challenge forwarded", opp, mid);
    } catch (e) {
      console.log("match:challenge_sent error", e?.message || e);
    }
  });

  socket.on("match:challenge_accepted", (payload) => {
    try {
      const { challengerId, matchId } = payload || {};
      const cid = normId(challengerId);
      const mid = normId(matchId);

      if (!cid || !mid) {
        console.log("match:challenge_accepted invalid payload", payload);
        return;
      }

      emitToUser(io, cid, "match:started", {
        matchId: mid,
        message: "Challenge accepted",
        timestamp: Date.now(),
      });

      console.log("challenge accepted notify", cid, mid);
    } catch (e) {
      console.log("match:challenge_accepted error", e?.message || e);
    }
  });

  socket.on("match:challenge_declined", (payload) => {
    try {
      const { challengerId, matchId } = payload || {};
      const cid = normId(challengerId);
      const mid = normId(matchId);

      if (!cid || !mid) {
        console.log("match:challenge_declined invalid payload", payload);
        return;
      }

      emitToUser(io, cid, "match:declined", {
        matchId: mid,
        message: "Challenge declined",
        timestamp: Date.now(),
      });

      console.log("challenge declined notify", cid, mid);
    } catch (e) {
      console.log("match:challenge_declined error", e?.message || e);
    }
  });

  // ----------------------------
  // ✅ Match room join/leave
  // ----------------------------

  socket.on("match:join", (payload, ack) => {
    try {
      const { matchId, userId } = payload || {};
      const mid = normId(matchId);
      const uid = normId(userId);

      if (!mid) {
        console.log("match:join invalid payload", payload);
        if (typeof ack === "function") ack({ ok: false, error: "missing_matchId" });
        return;
      }

      const room = matchRoom(mid);
      socket.join(room);

      // Also join user rooms (presenceHandler may already do this, but safe)
      if (uid) {
        socket.join(`user:${uid}`);
        socket.join(uid);
      }

      // Mark activity for TTL
      touchMatch(mid);

      // Immediately send current score state to this socket (late join fix)
      const st = getMatchState(mid);
      if (st) {
        safeEmit(socket, "match:score_state", {
          matchId: st.matchId,
          confirmedBy: st.confirmedBy || "",
          scores: st.scores || [],
          timestamp: st.updatedAt || Date.now(),
          source: "join",
        });
      }

      safeEmit(socket, "match:joined", {
        matchId: mid,
        room,
        timestamp: Date.now(),
      });

      if (typeof ack === "function") ack({ ok: true, matchId: mid, room });

      console.log("match joined", socket.id, room);
    } catch (e) {
      console.log("match:join error", e?.message || e);
      if (typeof ack === "function") ack({ ok: false, error: "server_error" });
    }
  });

  socket.on("match:leave", (payload, ack) => {
    try {
      const { matchId } = payload || {};
      const mid = normId(matchId);
      if (!mid) {
        if (typeof ack === "function") ack({ ok: false, error: "missing_matchId" });
        return;
      }
      const room = matchRoom(mid);
      socket.leave(room);
      if (typeof ack === "function") ack({ ok: true, matchId: mid, room });
    } catch (e) {
      if (typeof ack === "function") ack({ ok: false, error: "server_error" });
    }
  });

  // ----------------------------
  // ✅ Client can request current state anytime (reconnect fix)
  // ----------------------------
  socket.on("match:score_get", (payload, ack) => {
    try {
      const { matchId } = payload || {};
      const mid = normId(matchId);
      if (!mid) {
        if (typeof ack === "function") ack({ ok: false, error: "missing_matchId" });
        return;
      }

      const st = getMatchState(mid);
      const out = st
        ? {
            matchId: st.matchId,
            confirmedBy: st.confirmedBy || "",
            scores: st.scores || [],
            timestamp: st.updatedAt || Date.now(),
            source: "get",
          }
        : {
            matchId: mid,
            confirmedBy: "",
            scores: [],
            timestamp: Date.now(),
            source: "get_empty",
          };

      safeEmit(socket, "match:score_state", out);
      if (typeof ack === "function") ack({ ok: true, ...out });
    } catch (e) {
      if (typeof ack === "function") ack({ ok: false, error: "server_error" });
    }
  });

  // ----------------------------
  // ✅ Canonical: score confirm -> store state -> broadcast
  // ----------------------------
  socket.on("match:score_confirm", (payload, ack) => {
    try {
      const { matchId, confirmedBy, scores } = payload || {};
      const mid = normId(matchId);
      const by = normId(confirmedBy);

      if (!mid || !by) {
        console.log("match:score_confirm invalid payload", payload);
        if (typeof ack === "function") ack({ ok: false, error: "missing_fields" });
        return;
      }

      const st = upsertMatchState({ matchId: mid, confirmedBy: by, scores });
      if (!st) {
        console.log("match:score_confirm invalid scores", payload);
        if (typeof ack === "function") ack({ ok: false, error: "invalid_scores" });
        return;
      }

      const out = {
        matchId: st.matchId,
        confirmedBy: st.confirmedBy || "",
        scores: st.scores || [],
        timestamp: st.updatedAt || Date.now(),
        source: "confirm",
      };

      // ✅ broadcast to match room (primary)
      io.to(matchRoom(st.matchId)).emit("match:score_updated", out);

      // ✅ broadcast to each user room (guaranteed delivery fallback)
      for (const s of st.scores) {
        emitToUser(io, s.userId, "match:score_updated", out);
      }

      if (typeof ack === "function") ack({ ok: true, ...out });

      console.log("match:score_updated", matchRoom(st.matchId), out);
    } catch (e) {
      console.log("match:score_confirm error", e?.message || e);
      if (typeof ack === "function") ack({ ok: false, error: "server_error" });
    }
  });
}
