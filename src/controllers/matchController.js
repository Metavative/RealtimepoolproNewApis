// controllers/matchController.js
import Match from "./../models/match.model.js";
import User from "./../models/user.model.js";
import Transaction from "./../models/transaction.model.js";
import mongoose from "mongoose";

const APP_COMMISSION_RATE = 0.10;

function emitToUser(io, userId, event, payload) {
  if (!io || !userId) return;
  const uid = String(userId);
  io.to(`user:${uid}`).emit(event, payload);
  io.to(uid).emit(event, payload);
}

function s(v) {
  return v === null || v === undefined ? "" : String(v).trim();
}

function asNum(v, fallback = 0) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

function normalizeScoreArray(scores) {
  // Accept:
  // - [{ userId, score }]
  // - [{ user, points }]
  // - [{ userId, points }]
  const arr = Array.isArray(scores) ? scores : [];
  const out = [];

  for (const item of arr) {
    if (!item) continue;

    const user =
      item.user ||
      item.userId ||
      item._id ||
      item.id;

    const points =
      item.points ??
      item.score ??
      item.value;

    const uid = s(user);
    if (!uid) continue;

    // Match schema expects:
    // { user: ObjectId, points: Number }
    out.push({
      user: uid,
      points: Math.max(0, Math.min(999, Math.round(asNum(points, 0)))),
    });
  }

  // de-dupe by user (last wins)
  const map = new Map();
  for (const row of out) map.set(String(row.user), row.points);

  const deduped = [];
  for (const [userId, points] of map.entries()) {
    deduped.push({ user: userId, points });
  }

  return deduped;
}

async function loadUserCard(userId) {
  const u = await User.findById(userId)
    .select("profile.nickname profile.avatar profile.avatarUpdatedAt stats.userIdTag stats.rank stats.level stats.totalWinnings")
    .lean();

  const nickname = s(u?.profile?.nickname);
  const userIdTag = s(u?.stats?.userIdTag);

  return {
    userId: s(userId),
    nickname: nickname || userIdTag || "", // ✅ never "Player"
    avatar: s(u?.profile?.avatar),
    avatarUpdatedAt: u?.profile?.avatarUpdatedAt || u?.profile?.updatedAt || u?.updatedAt || null,
    userIdTag,
    rank: s(u?.stats?.rank || u?.stats?.level || ""),
    totalWinnings: asNum(u?.stats?.totalWinnings, 0),
  };
}

// ========================
// 1. CREATE CHALLENGE
// ========================
export async function createChallenge(req, res, io, presence) {
  try {
    const { opponentId, entryFee, clubId, slot } = req.body;
    const challenger = req.userId;

    if (!opponentId) {
      return res.status(400).json({ message: "opponentId is required" });
    }

    const match = await Match.create({
      players: [challenger, opponentId],
      status: "pending",
      entryFee: entryFee || 0,
      meta: { clubId, slot },
    });

    const challengerInfo = await loadUserCard(challenger);

    const payload = {
      matchId: match._id,
      entryFee: match.entryFee || 0,
      challengerId: s(challenger),
      opponentId: s(opponentId),
      challengerInfo,
      timestamp: Date.now(),
    };

    emitToUser(io, opponentId, "challenge:received", payload);

    return res.json({ match });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

// ========================
// 2. ACCEPT CHALLENGE
// ========================
export async function acceptChallenge(req, res, io, presence) {
  try {
    const { matchId } = req.body;
    const accepterId = req.userId;

    const match = await Match.findById(matchId);
    if (!match) return res.status(404).json({ message: "Match not found" });

    const isPlayer = match.players?.some((p) => String(p) === String(accepterId));
    if (!isPlayer) {
      return res.status(403).json({ message: "Not authorized to accept this match" });
    }

    match.status = "ongoing";
    match.isLive = true;
    match.startAt = new Date();
    await match.save();

    // ✅ send full info so client never has to guess opponent avatar/name
    const p0 = String(match.players[0]);
    const p1 = String(match.players[1]);

    const p0Info = await loadUserCard(p0);
    const p1Info = await loadUserCard(p1);

    const payload = {
      matchId: match._id,
      status: match.status,
      startAt: match.startAt,
      players: match.players,
      entryFee: match.entryFee || 0,
      challengerInfo: p0Info,
      opponentInfo: p1Info,
      timestamp: Date.now(),
    };

    for (const playerId of match.players) {
      emitToUser(io, playerId, "match:started", payload);
    }

    return res.json({ match, payload });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

// ========================
// 3. FINISH MATCH
// ========================
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

    // ✅ idempotent: already finished
    if (match.status === "finished") {
      await session.abortTransaction();
      session.endSession();
      return res.json({ ok: true, alreadyFinished: true, match });
    }

    if (match.status !== "ongoing") {
      await session.abortTransaction();
      return res.status(400).json({ message: "Match is not ongoing." });
    }

    const winner = s(winnerId);
    if (!winner) {
      await session.abortTransaction();
      return res.status(400).json({ message: "winnerId is required." });
    }

    const loserId = match.players.find((p) => p.toString() !== String(winner));
    if (!loserId) {
      await session.abortTransaction();
      return res.status(400).json({ message: "Invalid winner or players." });
    }

    const normalizedScores = normalizeScoreArray(scores).map((row) => ({
      user: new mongoose.Types.ObjectId(String(row.user)),
      points: row.points,
    }));

    const entryFee = Number(match.entryFee || 0);
    const totalWager = entryFee * 2;
    const appCommission = totalWager * APP_COMMISSION_RATE;
    const payoutAmount = totalWager - appCommission;

    match.status = "finished";
    match.isLive = false;
    match.endAt = new Date();
    match.winner = winner;
    match.score = normalizedScores;

    match.meta = {
      ...(match.meta || {}),
      finishedAt: Date.now(),
      finishSource: "http",
      lastScoreUpdateAt: Date.now(),
      lastConfirmedBy: s(req.userId),
    };

    await match.save({ session });

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

    await User.findByIdAndUpdate(winner, winnerUpdate, { session });
    await User.findByIdAndUpdate(loserId, loserUpdate, { session });

    await Transaction.create(
      [
        {
          user: winner,
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
          user: winner,
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

    const payload = {
      matchId: match._id,
      status: match.status,
      winnerId: winner,
      loserId: String(loserId),
      payout: payoutAmount,
      commission: appCommission,
      scores: normalizedScores.map((x) => ({
        userId: String(x.user),
        score: x.points,
      })),
      timestamp: Date.now(),
    };

    for (const playerId of match.players) {
      emitToUser(io, playerId, "match:finished", payload);
      emitToUser(io, playerId, "match:result", payload);
    }

    return res.json({
      ok: true,
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
// 4. CANCEL MATCH (unchanged)
// ========================
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
    match.isLive = false;
    await match.save({ session });

    const entryFee = Number(match.entryFee || 0);
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

    return res.json({ ok: true, message: "Match cancelled and funds refunded", match });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    return res.status(500).json({
      message: "Match cancellation failed. Error: " + error.message,
    });
  }
}
