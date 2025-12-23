import FriendRequest from "../models/friend.model.js";
import User from "../models/user.model.js";
import crypto from "crypto";

/**
 * Helper: emit to all sockets of a user (room-based)
 * - user:<id>  (new)
 * - <id>       (legacy compatibility)
 */
function emitToUser(io, userId, event, payload) {
  const uid = String(userId);
  io.to(`user:${uid}`).emit(event, payload);
  io.to(uid).emit(event, payload); // legacy support (your codebase already uses this in places)
}

/**
 * SEND FRIEND REQUEST
 */
export async function sendRequest(req, res, io, presence) {
  try {
    const from = req.userId;
    const { to } = req.body;

    if (!to) {
      return res.status(400).json({ message: "Recipient (to) is required" });
    }

    if (String(from) === String(to)) {
      return res
        .status(400)
        .json({ message: "You cannot send a request to yourself" });
    }

    const sender = await User.findById(from).select(
      "friends profile.nickname profile.avatar stats.userIdTag"
    );
    if (!sender) {
      return res.status(404).json({ message: "Sender not found" });
    }

    if (sender.friends?.some((id) => String(id) === String(to))) {
      return res.status(400).json({ message: "Already friends" });
    }

    const existing = await FriendRequest.findOne({
      from,
      to,
      status: "pending",
    }).select("_id");

    if (existing) {
      return res.status(400).json({ message: "Friend request already pending" });
    }

    const fr = await FriendRequest.create({
      from,
      to,
      status: "pending",
    });

    // ✅ UI-ready payload (Flutter can render instantly)
    const requestPayload = {
      id: String(fr._id),
      fromUserId: String(from),
      toUserId: String(to),
      senderName: sender.profile?.nickname || "Unknown",
      senderAvatar: sender.profile?.avatar || "",
      senderTag: sender.stats?.userIdTag || "",
      status: fr.status,
      createdAt: fr.createdAt || new Date().toISOString(),
    };

    // ✅ Real-time: notify receiver
    emitToUser(io, to, "friend:request_received", { request: requestPayload });

    // Optional: notify sender devices (sync UI on multiple devices)
    emitToUser(io, from, "friend:request_sent", { request: requestPayload });

    // ✅ Compatibility: older event name some clients may still listen to
    emitToUser(io, to, "friend:request:new", {
      requestId: String(fr._id),
      from: String(from),
    });

    return res.json({ success: true, fr });
  } catch (error) {
    console.error("sendRequest error:", error);
    return res.status(500).json({
      message: error?.message || "Internal server error",
    });
  }
}

/**
 * RESPOND TO FRIEND REQUEST
 */
export async function respond(req, res, io, presence) {
  try {
    const userId = req.userId;
    const { requestId, accept } = req.body;

    if (!requestId) {
      return res.status(400).json({ message: "requestId required" });
    }

    const fr = await FriendRequest.findById(requestId);
    if (!fr) {
      return res.status(404).json({ message: "Request not found" });
    }

    // Only receiver can respond
    if (String(fr.to) !== String(userId)) {
      return res.status(403).json({ message: "Not authorized" });
    }

    fr.status = accept ? "accepted" : "rejected";
    await fr.save();

    if (accept) {
      await User.findByIdAndUpdate(fr.from, {
        $addToSet: { friends: fr.to },
      });

      await User.findByIdAndUpdate(fr.to, {
        $addToSet: { friends: fr.from },
      });

      // ✅ Specific event for Flutter
      emitToUser(io, fr.from, "friend:request_accepted", {
        requestId: String(fr._id),
        byUserId: String(fr.to),
      });
      emitToUser(io, fr.to, "friend:request_accepted", {
        requestId: String(fr._id),
        byUserId: String(fr.to),
      });
    } else {
      // ✅ Specific event for Flutter
      emitToUser(io, fr.from, "friend:request_declined", {
        requestId: String(fr._id),
        byUserId: String(fr.to),
      });
      emitToUser(io, fr.to, "friend:request_declined", {
        requestId: String(fr._id),
        byUserId: String(fr.to),
      });
    }

    // ✅ Compatibility: keep generic updates for existing clients
    emitToUser(io, fr.from, "friend:request_updated", { fr });
    emitToUser(io, fr.to, "friend:request_updated", { fr });

    // ✅ Compatibility: your OLD naming style used colon segments
    emitToUser(io, fr.from, "friend:request:updated", fr);
    emitToUser(io, fr.to, "friend:request:updated", fr);

    return res.json({ success: true, fr });
  } catch (error) {
    console.error("respond error:", error);
    return res.status(500).json({
      message: error?.message || "Internal server error",
    });
  }
}

/**
 * SEARCH FRIENDS
 */
export async function searchFriends(req, res) {
  try {
    const userId = req.userId;
    const query = (req.query.query || "").trim();

    const currentUser = await User.findById(userId)
      .populate("friends", "_id")
      .lean();

    if (!currentUser) {
      return res.status(404).json({ message: "User not found" });
    }

    const friendIds = (currentUser.friends || []).map((f) => String(f._id));

    const filter = query
      ? {
          $or: [
            { "profile.nickname": { $regex: query, $options: "i" } },
            { "stats.userIdTag": { $regex: query, $options: "i" } },
          ],
        }
      : {};

    const users = await User.find(filter)
      .select("profile.nickname profile.avatar profile.onlineStatus stats.userIdTag")
      .lean();

    const requests = await FriendRequest.find({
      $or: [{ from: userId }, { to: userId }],
      status: "pending",
    }).lean();

    const result = users
      .filter((u) => String(u._id) !== String(userId))
      .map((u) => {
        const uid = String(u._id);

        let status = "none";
        let requestId = null;

        if (friendIds.includes(uid)) {
          status = "friend";
        } else {
          const sentByMe = requests.find(
            (r) => String(r.from) === String(userId) && String(r.to) === uid
          );

          const sentToMe = requests.find(
            (r) => String(r.to) === String(userId) && String(r.from) === uid
          );

          if (sentByMe) {
            status = "pending";
            requestId = String(sentByMe._id);
          } else if (sentToMe) {
            status = "incoming";
            requestId = String(sentToMe._id);
          }
        }

        return {
          id: uid,
          nickname: u.profile?.nickname || "Unknown",
          avatar: u.profile?.avatar || "",
          userIdTag: u.stats?.userIdTag || "",
          onlineStatus: Boolean(u.profile?.onlineStatus),
          status,
          requestId,
        };
      });

    return res.json({ success: true, data: result });
  } catch (error) {
    console.error("searchFriends error:", error);
    return res.status(500).json({
      message: error?.message || "Internal server error",
    });
  }
}

/**
 * DUMMY INCOMING REQUEST (DEV ONLY)
 */
export async function createDummyIncomingRequest(req, res, io, presence) {
  try {
    const userId = req.userId;

    let dummyUser = await User.findOne({ email: "dummy@poolpro.dev" }).select(
      "_id profile.nickname profile.avatar stats.userIdTag"
    );

    if (!dummyUser) {
      const tag = `player_${crypto.randomBytes(3).toString("hex")}`;
      dummyUser = await User.create({
        email: "dummy@poolpro.dev",
        profile: {
          nickname: "DummyPlayer",
          avatar: "",
          onlineStatus: true,
        },
        stats: { userIdTag: tag },
      });
    }

    const exists = await FriendRequest.findOne({
      from: dummyUser._id,
      to: userId,
      status: "pending",
    });

    if (exists) {
      return res.json({
        success: true,
        message: "Dummy request already exists",
      });
    }

    const fr = await FriendRequest.create({
      from: dummyUser._id,
      to: userId,
      status: "pending",
    });

    const requestPayload = {
      id: String(fr._id),
      fromUserId: String(dummyUser._id),
      toUserId: String(userId),
      senderName: dummyUser.profile?.nickname || "DummyPlayer",
      senderAvatar: dummyUser.profile?.avatar || "",
      senderTag: dummyUser.stats?.userIdTag || "",
      status: fr.status,
      createdAt: fr.createdAt || new Date().toISOString(),
    };

    // ✅ Real-time push so LandingScreen updates instantly
    emitToUser(io, userId, "friend:request_received", { request: requestPayload });

    // ✅ Compatibility
    emitToUser(io, userId, "friend:request:new", {
      requestId: String(fr._id),
      from: String(dummyUser._id),
    });

    return res.json({ success: true, fr });
  } catch (error) {
    console.error("createDummyIncomingRequest error:", error);
    return res.status(500).json({
      message: "Failed to create dummy request",
    });
  }
}
