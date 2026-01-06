import mongoose from "mongoose";

const ScoreSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    points: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const MatchSchema = new mongoose.Schema(
  {
    players: [{ type: mongoose.Schema.Types.ObjectId, ref: "User", index: true }],

    status: {
      type: String,
      enum: ["pending", "ongoing", "finished", "cancelled"],
      default: "pending",
      index: true,
    },

    score: { type: [ScoreSchema], default: [] },

    winner: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },

    entryFee: { type: Number, default: 0 },

    createdAt: { type: Date, default: Date.now, index: true },
    startAt: { type: Date, default: null, index: true },
    endAt: { type: Date, default: null, index: true },

    isLive: { type: Boolean, default: false, index: true },

    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  {
    timestamps: true, // adds createdAt/updatedAt (safe + useful)
  }
);

// Helpful compound index for “active match” lookups (optional but good)
MatchSchema.index({ status: 1, isLive: 1, updatedAt: -1 });

export default mongoose.model("Match", MatchSchema);
