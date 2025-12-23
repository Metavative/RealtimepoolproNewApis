import mongoose from "mongoose";
const { Schema } = mongoose;

const FriendRequestSchema = new Schema(
  {
    from: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    to: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    status: {
      type: String,
      enum: ["pending", "accepted", "rejected"],
      default: "pending",
    },
  },
  {
    timestamps: true,
  }
);

/**
 * ✅ CRITICAL FIX
 * Allow only ONE pending request between the same users
 * but allow re-requests after accept/reject.
 */
FriendRequestSchema.index(
  { from: 1, to: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "pending" },
  }
);

export default mongoose.model("FriendRequest", FriendRequestSchema);
