// services/socket_handler/matchStore.js
import mongoose from "mongoose";
import Match from "../../models/match.model.js";
import User from "../../models/user.model.js";
import Transaction from "../../models/transaction.model.js";

const APP_COMMISSION_RATE = 0.10;

function normId(v) {
  if (v === null || v === undefined) return "";
  const s = String(v).trim();
  return s.length ? s : "";
}

function toObjectId(v) {
  const s = normId(v);
  if (!s) return null;
  if (!mongoose.Types.ObjectId.isValid(s)) return null;
  return new mongoose.Types.ObjectId(s);
}

function asInt(v, fallback = 0) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.round(n);
}

function clampScore(v) {
  return Math.max(0, Math.min(999, asInt(v, 0)));
}

function normalizeScores(scores) {
  // supports:
  // [{ userId, score }]
  // [{ user, points }]
  // [{ userId, points }]
  // [{ user, score }]
  const arr = Array.isArray(scores) ? scores : [];
  const map = new Map(); // userId -> score (last wins)

  for (const item of arr) {
    if (!item) continue;

    const uid = normId(item.userId ?? item.user ?? item._id ?? item.id);
    if (!uid) continue;

    const sc = clampScore(
      item.score ?? item.points ?? item.value ?? item?.meta?.score
    );

    map.set(uid, sc);
  }

  const out = [];
  for (const [userId, score] of map.entries()) {
    out.push({ userId, score });
  }
  return out;
}

export async function loadMatchScoreState(matchId) {
  const mid = normId(matchId);
  if (!mid) return null;

  const doc = await Match.findById(mid)
    .select("score winner status players meta isLive startAt endAt entryFee")
    .lean();

  if (!doc) return null;

  const scores = Array.isArray(doc.score)
    ? doc.score
        .map((s) => ({
          userId: normId(s?.user),
          score: clampScore(s?.points),
        }))
        .filter((x) => x.userId)
    : [];

  return {
    matchId: mid,
    confirmedBy: normId(doc?.meta?.lastConfirmedBy),
    scores,
    timestamp: Number(doc?.meta?.lastScoreUpdateAt) || Date.now(),
    status: normId(doc.status),
    winner: normId(doc.winner),
    isLive: !!doc.isLive,
    entryFee: Number(doc.entryFee || 0),
    startAt: doc.startAt || null,
    endAt: doc.endAt || null,
  };
}

/**
 * ✅ Persist scores without corrupting match lifecycle
 * - Does NOT reset startAt every time
 * - Does NOT revive finished/cancelled matches
 * - Ensures scores belong to the match players (unless players list is empty)
 */
export async function persistMatchScores({ matchId, confirmedBy, scores }) {
  const mid = normId(matchId);
  const by = normId(confirmedBy);
  if (!mid || !by) return null;

  const match = await Match.findById(mid).select(
    "status players startAt entryFee meta winner isLive score endAt"
  );
  if (!match) return null;

  // never accept score updates for cancelled/finished matches
  if (match.status === "cancelled" || match.status === "finished") {
    const existing = await loadMatchScoreState(mid);
    return (
      existing || {
        matchId: mid,
        confirmedBy: by,
        scores: [],
        timestamp: Date.now(),
        status: normId(match.status),
        winner: normId(match.winner),
        isLive: !!match.isLive,
        entryFee: Number(match.entryFee || 0),
        startAt: match.startAt || null,
        endAt: match.endAt || null,
      }
    );
  }

  const normalized = normalizeScores(scores);
  if (normalized.length < 2) return null;

  const allowed = new Set((match.players || []).map((p) => String(p)));

  const scoreDoc = [];
  const playersOids = [];

  for (const s of normalized) {
    const oid = toObjectId(s.userId);
    if (!oid) continue;

    // if match.players exists, require membership
    if (allowed.size > 0 && !allowed.has(String(oid))) continue;

    scoreDoc.push({ user: oid, points: clampScore(s.score) });
    playersOids.push(oid);
  }

  if (scoreDoc.length < 2) return null;

  // Only set startAt the first time
  const startAt = match.startAt ? match.startAt : new Date();

  const update = {
    $set: {
      score: scoreDoc,
      isLive: true,
      status: "ongoing",
      startAt,
      "meta.lastConfirmedBy": by,
      "meta.lastScoreUpdateAt": Date.now(),
      "meta.scoreSource": "socket",
    },
  };

  // if players list is empty, allow populating it from incoming scores
  if (allowed.size === 0) {
    update.$addToSet = { players: { $each: playersOids } };
  }

  const doc = await Match.findByIdAndUpdate(mid, update, {
    new: true,
    runValidators: true,
  }).select("score meta status winner isLive entryFee startAt endAt");

  if (!doc) return null;

  return {
    matchId: mid,
    confirmedBy: by,
    scores: normalized,
    timestamp: Number(doc?.meta?.lastScoreUpdateAt) || Date.now(),
    status: normId(doc.status),
    winner: normId(doc.winner),
    isLive: !!doc.isLive,
    entryFee: Number(doc.entryFee || 0),
    startAt: doc.startAt || null,
    endAt: doc.endAt || null,
  };
}

/**
 * ✅ Auto-finish match in DB (settlement logic)
 * - idempotent
 * - race-safe (prevents double payouts)
 * - validates winner is a match player
 */
export async function finishMatchWithSettlement({ matchId, winnerId, scores }) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const mid = normId(matchId);
    const wid = normId(winnerId);

    if (!mid || !wid) {
      await session.abortTransaction();
      session.endSession();
      return { ok: false, error: "missing_fields" };
    }

    // 1) Read match (inside transaction) to validate
    const match = await Match.findById(mid).session(session);
    if (!match) {
      await session.abortTransaction();
      session.endSession();
      return { ok: false, error: "match_not_found" };
    }

    // ✅ idempotent: already finished
    if (match.status === "finished") {
      await session.abortTransaction(); // nothing to commit
      session.endSession();
      return {
        ok: true,
        alreadyFinished: true,
        payload: {
          matchId: match._id,
          status: match.status,
          winnerId: normId(match.winner),
          loserId: "",
          payout: 0,
          commission: 0,
          scores: (match.score || []).map((s) => ({
            userId: normId(s?.user),
            score: clampScore(s?.points),
          })),
          timestamp: Date.now(),
        },
      };
    }

    if (match.status !== "ongoing" && match.status !== "pending") {
      await session.abortTransaction();
      session.endSession();
      return { ok: false, error: "invalid_status" };
    }

    const players = (match.players || []).map((p) => String(p));
    if (!players.includes(String(wid))) {
      await session.abortTransaction();
      session.endSession();
      return { ok: false, error: "winner_not_in_match" };
    }

    const normalized = normalizeScores(scores);
    if (normalized.length < 2) {
      await session.abortTransaction();
      session.endSession();
      return { ok: false, error: "invalid_scores" };
    }

    const loserId = (match.players || []).find((p) => String(p) !== String(wid));
    if (!loserId) {
      await session.abortTransaction();
      session.endSession();
      return { ok: false, error: "invalid_winner" };
    }

    const entryFee = Number(match.entryFee || 0);
    const totalWager = entryFee * 2;
    const appCommission = totalWager * APP_COMMISSION_RATE;
    const payoutAmount = totalWager - appCommission;

    const scoreDoc = normalized
      .map((s) => {
        const oid = toObjectId(s.userId);
        if (!oid) return null;
        return { user: oid, points: clampScore(s.score) };
      })
      .filter(Boolean);

    // 2) Race-safe finalize: only update if still not finished
    const finalized = await Match.findOneAndUpdate(
      { _id: match._id, status: { $in: ["ongoing", "pending"] } },
      {
        $set: {
          status: "finished",
          isLive: false,
          endAt: new Date(),
          winner: wid,
          score: scoreDoc,
          "meta.finishedAt": Date.now(),
          "meta.finishSource": "socket_auto",
        },
      },
      { new: true, session }
    );

    if (!finalized) {
      // someone else finished first
      await session.abortTransaction();
      session.endSession();

      const existing = await loadMatchScoreState(mid);
      return {
        ok: true,
        alreadyFinished: true,
        payload: {
          matchId: mid,
          status: "finished",
          winnerId: wid,
          loserId: String(loserId),
          payout: payoutAmount,
          commission: appCommission,
          scores: existing?.scores || normalized,
          timestamp: Date.now(),
        },
      };
    }

    // 3) Settlement updates
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

    await User.findByIdAndUpdate(wid, winnerUpdate, { session });
    await User.findByIdAndUpdate(loserId, loserUpdate, { session });

    // ✅ Accounting: ONE payout tx + ONE platform fee tx
    await Transaction.create(
      [
        {
          user: wid,
          amount: payoutAmount,
          type: "payout",
          status: "completed",
          meta: { matchId: finalized._id, commission: appCommission },
        },
        {
          user: wid,
          amount: appCommission,
          type: "fee",
          status: "completed",
          meta: { matchId: finalized._id, description: "Platform fee" },
        },
      ],
      { session }
    );

    await session.commitTransaction();
    session.endSession();

    const payload = {
      matchId: finalized._id,
      status: finalized.status,
      winnerId: wid,
      loserId: String(loserId),
      payout: payoutAmount,
      commission: appCommission,
      scores: normalized,
      timestamp: Date.now(),
    };

    return { ok: true, payload };
  } catch (e) {
    try {
      await session.abortTransaction();
    } catch (_) {}
    session.endSession();
    return {
      ok: false,
      error: "server_error",
      details: e?.message || String(e),
    };
  }
}
