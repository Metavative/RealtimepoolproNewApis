import Match from "./../models/match.model.js";
import User from "./../models/user.model.js";
import Transaction from "./../models/transaction.model.js";
import mongoose from "mongoose";

// Commission Rate: App ka apna commission (e.g., 10%)
const APP_COMMISSION_RATE = 0.10; // 10% commission

// Helper: emit to a user if online
function emitToUser(io, presence, userId, event, payload) {
  if (!io || !presence || !userId) return;
  const socketId = presence.get(String(userId));
  if (socketId) io.to(socketId).emit(event, payload);
}

// ========================
// 1. CREATE CHALLENGE
// ========================
// UPDATED SIGNATURE: (req, res, io, presence)
export async function createChallenge(req, res, io, presence) {
  try {
    const { opponentId, entryFee, clubId, slot } = req.body;
    const challenger = req.userId;

    if (!opponentId) {
      return res.status(400).json({ message: "opponentId is required" });
    }

    // ✅ MatchSchema mein 'players' array mein object IDs chahiye
    const match = await Match.create({
      players: [challenger, opponentId],
      status: "pending",
      entryFee: entryFee || 0,
      meta: { clubId, slot },
    });

    // ✅ Fetch challenger info for UI popup
    const challengerUser = await User.findById(challenger)
      .select("profile.nickname profile.avatar stats.userIdTag")
      .lean();

    const payload = {
      matchId: match._id,
      entryFee: match.entryFee || 0,
      challengerId: challenger,
      opponentId,
      challengerInfo: {
        nickname: challengerUser?.profile?.nickname || "Player",
        avatar: challengerUser?.profile?.avatar || "",
        userIdTag: challengerUser?.stats?.userIdTag || "",
      },
      match: match, // optional: if you want full match doc
    };

    // ✅ Realtime notify opponent if online
    emitToUser(io, presence, opponentId, "challenge:received", payload);

    return res.json({ match });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

// ========================
// 2. ACCEPT CHALLENGE
// ========================
// UPDATED SIGNATURE: (req, res, io, presence)
export async function acceptChallenge(req, res, io, presence) {
  try {
    const { matchId } = req.body;
    const accepterId = req.userId;

    const match = await Match.findById(matchId);
    if (!match) return res.status(404).json({ message: "Match not found" });

    // Only players can accept
    const isPlayer = match.players?.some((p) => String(p) === String(accepterId));
    if (!isPlayer) {
      return res.status(403).json({ message: "Not authorized to accept this match" });
    }

    match.status = "ongoing";
    match.startAt = new Date();
    await match.save();

    // ✅ Notify BOTH players match started
    const payload = {
      matchId: match._id,
      status: match.status,
      startAt: match.startAt,
      players: match.players,
      entryFee: match.entryFee || 0,
    };

    for (const playerId of match.players) {
      emitToUser(io, presence, playerId, "match:started", payload);
    }

    return res.json({ match });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

// ========================
// 3. FINISH MATCH (CRITICAL LOGIC ADDED)
// ========================
// UPDATED SIGNATURE: (req, res, io, presence)
export async function finishMatch(req, res, io, presence) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { matchId, winnerId, scores } = req.body;

    const match = await Match.findById(matchId).session(session);
    if (!match) {
      await session.abortTransaction();
      return res.status(404).json({ message: "Match not found" });
    }

    if (match.status !== "ongoing") {
      await session.abortTransaction();
      return res.status(400).json({ message: "Match is not ongoing." });
    }

    const loserId = match.players.find((p) => p.toString() !== winnerId);
    if (!loserId) {
      await session.abortTransaction();
      return res.status(400).json({ message: "Invalid winner or players." });
    }

    const entryFee = match.entryFee;
    const totalWager = entryFee * 2;
    const appCommission = totalWager * APP_COMMISSION_RATE;
    const payoutAmount = totalWager - appCommission;

    // 1. Match update
    match.status = "finished";
    match.endAt = new Date();
    match.winner = winnerId;
    match.score = scores;
    await match.save({ session });

    // 2. User stats update
    const winnerUpdate = {
      $inc: {
        "earnings.availableBalance": payoutAmount,
        "earnings.career": payoutAmount,
        "stats.totalWinnings": payoutAmount,
        "stats.totalWins": 1,
      },
    };

    const loserUpdate = {
      $inc: {
        "stats.totalLosses": 1,
      },
    };

    await User.findByIdAndUpdate(winnerId, winnerUpdate, { session });
    await User.findByIdAndUpdate(loserId, loserUpdate, { session });

    // 3. Transactions
    await Transaction.create(
      [
        {
          user: winnerId,
          amount: payoutAmount,
          type: "payout",
          status: "completed",
          meta: { matchId: match._id, commission: appCommission },
        },
      ],
      { session }
    );

    await Transaction.create(
      [
        {
          user: winnerId,
          amount: appCommission,
          type: "debit",
          status: "completed",
          meta: { matchId: match._id, description: "App Commission" },
        },
      ],
      { session }
    );

    await session.commitTransaction();
    session.endSession();

    // ✅ Notify BOTH players match finished/result
    const payload = {
      matchId: match._id,
      status: match.status,
      winnerId,
      loserId: String(loserId),
      payout: payoutAmount,
      commission: appCommission,
      scores: scores || null,
    };

    for (const playerId of match.players) {
      emitToUser(io, presence, playerId, "match:finished", payload);
      emitToUser(io, presence, playerId, "match:result", payload); // optional alias if frontend uses it
    }

    return res.json({
      message: "Match finished and funds settled successfully",
      match,
      payout: payoutAmount,
    });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error("Match Settlement Failed:", error);
    return res.status(500).json({
      message: "Match settlement failed. Funds safe. Error: " + error.message,
    });
  }
}

// ========================
// 4. CANCEL MATCH
// ========================
// NOTE: Cancel currently does not emit. You can add "match:cancelled" same way if needed.
export async function cancelMatch(req, res) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { matchId } = req.body;
    const match = await Match.findById(matchId).session(session);

    if (!match) {
      await session.abortTransaction();
      return res.status(404).json({ message: "Match not found" });
    }

    match.status = "cancelled";
    await match.save({ session });

    const entryFee = match.entryFee;
    if (entryFee > 0) {
      for (const playerId of match.players) {
        await User.findByIdAndUpdate(
          playerId,
          { $inc: { "earnings.availableBalance": entryFee } },
          { session }
        );

        await Transaction.create(
          [
            {
              user: playerId,
              amount: entryFee,
              type: "refund",
              status: "completed",
              meta: { matchId: match._id, description: "Match Cancelled Refund" },
            },
          ],
          { session }
        );
      }
    }

    await session.commitTransaction();
    session.endSession();

    return res.json({ message: "Match cancelled and funds refunded", match });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    return res.status(500).json({
      message: "Match cancellation failed. Error: " + error.message,
    });
  }
}
