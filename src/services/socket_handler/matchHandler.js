/**
 * Match handler using rooms
 * Sends to rooms:
 * user:<id>
 * <id>
 */

function emitToUser(io, userId, event, payload) {
  if (!io || !userId) return;
  const uid = String(userId);
  io.to(`user:${uid}`).emit(event, payload);
  io.to(uid).emit(event, payload);
}

export default function matchHandler(io, socket, presence) {
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
}
