/**
 * Match handler using rooms
 * Sends to rooms:
 * user:<id>
 * <id>
 * match:<matchId>
 */

import {
  persistMatchScores,
  finishMatchWithSettlement,
  loadMatchScoreState,
} from "./matchStore.js";

function emitToUser(io, userId, event, payload) {
  if (!io || !userId) return;
  const uid = String(userId);
  io.to(`user:${uid}`).emit(event, payload);
  io.to(uid).emit(event, payload);
}

function matchRoom(matchId) {
  return `match:${String(matchId)}`;
}

function normId(v) {
  if (v === null || v === undefined) return "";
  const s = String(v).trim();
  return s.length ? s : "";
}

function asInt(v, fallback = 0) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.round(n);
}

function pickWinnerFromScores(scores, winningScore = 8) {
  // scores: [{ userId, score }]
  const ws = asInt(winningScore, 8);

  let winnerId = "";
  let winnerScore = -1;

  for (const s of scores || []) {
    const uid = normId(s?.userId);
    const sc = asInt(s?.score, 0);
    if (!uid) continue;

    if (sc >= ws && sc > winnerScore) {
      winnerId = uid;
      winnerScore = sc;
    }
  }

  return winnerId;
}

export default function matchHandler(io, socket, presence) {
  // ----------------------------
  // Challenge flow (existing)
  // ----------------------------
  socket.on("match:challenge_sent", (payload) => {
    try {
      const { opponentId, matchId, entryFee, challengerInfo } = payload || {};
      if (!opponentId || !matchId) {
        console.log("match:challenge_sent invalid payload", payload);
        return;
      }

      emitToUser(io, opponentId, "challenge:received", {
        matchId,
        entryFee: entryFee || 0,
        opponentId: String(opponentId),
        challengerInfo: challengerInfo || {},
        timestamp: Date.now(),
      });

      console.log("challenge forwarded", opponentId, String(matchId));
    } catch (e) {
      console.log("match:challenge_sent error", e?.message || e);
    }
  });

  socket.on("match:challenge_accepted", (payload) => {
    try {
      const { challengerId, matchId } = payload || {};
      if (!challengerId || !matchId) {
        console.log("match:challenge_accepted invalid payload", payload);
        return;
      }

      emitToUser(io, challengerId, "match:started", {
        matchId,
        message: "Challenge accepted",
        timestamp: Date.now(),
      });

      console.log("challenge accepted notify", challengerId, String(matchId));
    } catch (e) {
      console.log("match:challenge_accepted error", e?.message || e);
    }
  });

  socket.on("match:challenge_declined", (payload) => {
    try {
      const { challengerId, matchId } = payload || {};
      if (!challengerId || !matchId) {
        console.log("match:challenge_declined invalid payload", payload);
        return;
      }

      emitToUser(io, challengerId, "match:declined", {
        matchId,
        message: "Challenge declined",
       timestamp: Date.now(),
      });

      console.log("challenge declined notify", challengerId, String(matchId));
    } catch (e) {
      console.log("match:challenge_declined error", e?.message || e);
    }
  });

  // ----------------------------
  // Match room join (recommended)
  // ----------------------------
  socket.on("match:join", async (payload) => {
    try {
      const { matchId, userId } = payload || {};
      if (!matchId) {
        console.log("match:join invalid payload", payload);
        return;
      }

      socket.join(matchRoom(matchId));

      // optional: also join user rooms
      if (userId) {
        const uid = String(userId);
        socket.join(`user:${uid}`);
        socket.join(uid);
      }

      socket.emit("match:joined", {
        matchId: String(matchId),
        room: matchRoom(matchId),
        timestamp: Date.now(),
      });

      // ✅ hydrate joiner with latest score state
      const state = await loadMatchScoreState(matchId);
      if (state) {
        socket.emit("match:score_updated", state);
      }

      console.log("match joined", socket.id, matchRoom(matchId));
    } catch (e) {
      console.log("match:join error", e?.message || e);
    }
  });

  // ----------------------------
  // ✅ Score confirm -> persist -> broadcast -> auto-finish at 8
  // ----------------------------
  socket.on("match:score_confirm", async (payload) => {
    try {
      const { matchId, confirmedBy, scores, winningScore } = payload || {};
      const mid = normId(matchId);
      const by = normId(confirmedBy);

      if (!mid || !by) {
        console.log("match:score_confirm invalid payload", payload);
        return;
      }

      // 1) Persist + normalize
      const updated = await persistMatchScores({
        matchId: mid,
        confirmedBy: by,
        scores,
      });

      if (!updated) {
        console.log("match:score_confirm persist failed", {
          matchId: mid,
          confirmedBy: by,
        });
        return;
      }

      // 2) Broadcast score update to match room
      io.to(matchRoom(mid)).emit("match:score_updated", updated);

      // 3) Win check: first to 8 (or provided winningScore)
      const ws = asInt(winningScore, 8);
      const winnerId = pickWinnerFromScores(updated.scores, ws);

      if (!winnerId) {
        console.log("match:score_updated", matchRoom(mid), {
          matchId: mid,
          confirmedBy: by,
          scores: updated.scores,
          ws,
        });
        return;
      }

      // 4) Auto-finish match (DB + settlement)
      const finish = await finishMatchWithSettlement({
        matchId: mid,
        winnerId,
        scores: updated.scores,
      });

      if (!finish?.ok) {
        console.log("auto-finish failed", finish);
        return;
      }

      const resultPayload = finish.payload;

      // ✅ Broadcast to match room
      io.to(matchRoom(mid)).emit("match:finished", resultPayload);
      io.to(matchRoom(mid)).emit("match:result", resultPayload);

      // ✅ Also emit to both users (covers UIs not in match room)
      for (const s of updated.scores) {
        const uid = normId(s?.userId);
        if (!uid) continue;
        emitToUser(io, uid, "match:finished", resultPayload);
        emitToUser(io, uid, "match:result", resultPayload);
      }

      console.log("match finished auto @ score", { matchId: mid, winnerId, ws });
    } catch (e) {
      console.log("match:score_confirm error", e?.message || e);
    }
  });
}
