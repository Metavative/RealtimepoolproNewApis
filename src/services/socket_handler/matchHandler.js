/**
 * Match handler using rooms
 * Sends to rooms:
 * user:<id>
 * <id>
 * match:<matchId>
 */

function emitToUser(io, userId, event, payload) {
  if (!io || !userId) return;
  const uid = String(userId);
  io.to(`user:${uid}`).emit(event, payload);
  io.to(uid).emit(event, payload);
}

function matchRoom(matchId) {
  return `match:${String(matchId)}`;
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
  // ✅ NEW: Match room join
  // ----------------------------
  socket.on("match:join", (payload) => {
    try {
      const { matchId, userId } = payload || {};
      if (!matchId) {
        console.log("match:join invalid payload", payload);
        return;
      }

      socket.join(matchRoom(matchId));

      // Optional: also join user rooms (presenceHandler may already do this)
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

      console.log("match joined", socket.id, matchRoom(matchId));
    } catch (e) {
      console.log("match:join error", e?.message || e);
    }
  });

  // ----------------------------
  // ✅ NEW: Score confirm -> broadcast to match room
  // ----------------------------
  socket.on("match:score_confirm", (payload) => {
    try {
      const { matchId, confirmedBy, scores } = payload || {};

      if (!matchId || !confirmedBy) {
        console.log("match:score_confirm invalid payload", payload);
        return;
      }
      if (!Array.isArray(scores) || scores.length < 2) {
        console.log("match:score_confirm invalid scores", payload);
        return;
      }

      const normalizedScores = scores
        .map((s) => ({
          userId: s?.userId ? String(s.userId) : "",
          score: Number(s?.score),
        }))
        .filter((s) => s.userId && Number.isFinite(s.score));

      if (normalizedScores.length < 2) {
        console.log("match:score_confirm insufficient normalized scores", payload);
        return;
      }

      const out = {
        matchId: String(matchId),
        confirmedBy: String(confirmedBy),
        scores: normalizedScores,
        timestamp: Date.now(),
      };

      io.to(matchRoom(matchId)).emit("match:score_updated", out);

      console.log("match:score_updated", matchRoom(matchId), out);
    } catch (e) {
      console.log("match:score_confirm error", e?.message || e);
    }
  });
}
