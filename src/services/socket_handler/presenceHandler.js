import User from "../../models/user.model.js";

/**
 * Multi-socket tracker:
 * userId -> Set(socketId)
 */
const userSockets = new Map();

/**
 * Backward compatible:
 * presence.get(userId) should still return ONE socketId if online.
 */
function presenceGet(presence, userId) {
  const uid = String(userId);
  const val = presence.get(uid);

  if (val instanceof Set) {
    const arr = Array.from(val);
    return arr.length ? arr[0] : null;
  }

  if (typeof val === "string") return val;

  return null;
}

function addSocket(presence, userId, socketId) {
  const uid = String(userId);

  if (!userSockets.has(uid)) userSockets.set(uid, new Set());
  userSockets.get(uid).add(socketId);

  if (!presence.has(uid) || !(presence.get(uid) instanceof Set)) {
    presence.set(uid, new Set());
  }
  presence.get(uid).add(socketId);

  return userSockets.get(uid).size;
}

function removeSocket(presence, userId, socketId) {
  const uid = String(userId);

  const set = userSockets.get(uid);
  if (set) {
    set.delete(socketId);
    if (set.size === 0) userSockets.delete(uid);
  }

  const pset = presence.get(uid);
  if (pset instanceof Set) {
    pset.delete(socketId);
    if (pset.size === 0) presence.delete(uid);
  } else {
    if (presence.get(uid) === socketId) presence.delete(uid);
  }

  return userSockets.get(uid)?.size ?? 0;
}

function isFirstSocket(userId) {
  const uid = String(userId);
  return !userSockets.has(uid) || userSockets.get(uid).size === 0;
}

// Fetch online users based on presence map
async function getOnlineUsersFromPresence(presence) {
  const ids = Array.from(presence.keys());
  if (ids.length === 0) return [];

  try {
    const users = await User.find({ _id: { $in: ids } })
      .select(
        "profile.nickname profile.avatar profile.onlineStatus profile.verified stats.userIdTag stats.rank stats.totalWinnings"
      )
      .lean();

    const map = new Map(users.map((u) => [String(u._id), u]));
    return ids.map((id) => map.get(String(id))).filter(Boolean);
  } catch (error) {
    console.error("Error fetching online users from presence:", error);
    return [];
  }
}

// Fetch nearby players based on geospatial data
async function getNearbyPlayersByCoords(userId, lng, lat, radiusKm = 5) {
  if (lng === null || lng === undefined || lat === null || lat === undefined) {
    return [];
  }

  try {
    return User.find({
      _id: { $ne: userId },
      "profile.onlineStatus": true,
      location: {
        $near: {
          $geometry: { type: "Point", coordinates: [lng, lat] },
          $maxDistance: radiusKm * 1000,
        },
      },
    })
      .select(
        "profile.nickname profile.avatar profile.onlineStatus profile.verified stats.userIdTag stats.rank stats.totalWinnings location"
      )
      .lean();
  } catch (error) {
    console.error("Error fetching nearby players:", error);
    return [];
  }
}

// Helper function to pick longitude and latitude from the location object
function pickLngLat(location) {
  if (!location) return { lng: null, lat: null };

  const lng = location.lng ?? location.longitude ?? null;
  const lat = location.lat ?? location.latitude ?? null;

  if (typeof lng !== "number" || typeof lat !== "number") {
    return { lng: null, lat: null };
  }
  return { lng, lat };
}

function normalizePayload(payload) {
  if (!payload) return { userId: null, location: null };

  // if payload is string => userId only
  if (typeof payload === "string") {
    return { userId: payload, location: null };
  }

  // common formats:
  // { userId, location: {lng,lat} }
  // { userId, lng, lat }
  const userId = payload.userId ?? payload.id ?? payload._id ?? null;

  let location = payload.location ?? null;
  if (!location && (payload.lng != null || payload.lat != null)) {
    location = { lng: payload.lng, lat: payload.lat };
  }

  return { userId, location };
}

// Register presence event handlers
export default function registerPresenceHandlers(io, socket, presence) {
  async function identifyUser(userId, location) {
    if (!userId) {
      console.error("userId is required for identifying user.".red);
      return;
    }

    const uid = String(userId);
    const { lng, lat } = pickLngLat(location);

    // ✅ Join rooms for this user (new + legacy)
    socket.join(`user:${uid}`);
    socket.join(uid);

    socket.userId = uid;

    const first = isFirstSocket(uid);
    addSocket(presence, uid, socket.id);

    const updateData = {
      "profile.onlineStatus": true,
      lastSeen: new Date(),
    };

    if (lng !== null && lat !== null) {
      updateData.location = { type: "Point", coordinates: [lng, lat] };
      updateData["profile.longitude"] = lng;
      updateData["profile.latitude"] = lat;
    }

    try {
      await User.findByIdAndUpdate(uid, updateData);

      // Existing behavior
      const onlineUsers = await getOnlineUsersFromPresence(presence);
      io.emit("presence:update", onlineUsers);

      // Optional standardized events
      if (first) {
        io.emit("presence:user_online", { userId: uid });
      }

      // Useful for Flutter quick init
      socket.emit("presence:online_list", { userIds: Array.from(presence.keys()) });

      if (lng !== null && lat !== null) {
        const nearbyPlayers = await getNearbyPlayersByCoords(uid, lng, lat);
        socket.emit("nearbyPlayers", nearbyPlayers);
      }
    } catch (error) {
      console.error("Error identifying user:", error);
    }
  }

  async function moveUser(userId, location) {
    if (!userId) {
      console.error("userId is required for moving user.".red);
      return;
    }

    const uid = String(userId);
    const { lng, lat } = pickLngLat(location);
    if (lng === null || lat === null) return;

    try {
      await User.findByIdAndUpdate(uid, {
        location: { type: "Point", coordinates: [lng, lat] },
        "profile.longitude": lng,
        "profile.latitude": lat,
        lastSeen: new Date(),
      });

      const nearbyPlayers = await getNearbyPlayersByCoords(uid, lng, lat);
      socket.emit("nearbyPlayers", nearbyPlayers);
    } catch (error) {
      console.error("Error moving user:", error);
    }
  }

  // --- Aliases kept (plus safer normalization) ---
  socket.on("user:identify", async (payload) => {
    try {
      const p = normalizePayload(payload);
      await identifyUser(p.userId, p.location);
    } catch (e) {
      console.error("user:identify error", e);
    }
  });

  socket.on("identify", async (payload) => {
    try {
      const p = normalizePayload(payload);
      await identifyUser(p.userId, p.location);
    } catch (e) {
      console.error("identify error", e);
    }
  });

  socket.on("player:online", async (payload) => {
    try {
      const p = normalizePayload(payload);
      await identifyUser(p.userId, p.location);
    } catch (e) {
      console.error("player:online error", e);
    }
  });

  socket.on("userOnline", async (payload) => {
    try {
      const p = normalizePayload(payload);
      await identifyUser(p.userId, p.location);
    } catch (e) {
      console.error("userOnline error", e);
    }
  });

  socket.on("user:move", async (payload) => {
    try {
      const p = normalizePayload(payload);
      await moveUser(p.userId, p.location);
    } catch (e) {
      console.error("user:move error", e);
    }
  });

  socket.on("updateLocation", async (payload) => {
    try {
      const p = normalizePayload(payload);
      await moveUser(p.userId, p.location);
    } catch (e) {
      console.error("updateLocation error", e);
    }
  });

  socket.on("player:move", async (payload) => {
    try {
      const p = normalizePayload(payload);
      await moveUser(p.userId, p.location);
    } catch (e) {
      console.error("player:move error", e);
    }
  });

  // Optional presence utility
  socket.on("presence:check", ({ userIds }) => {
    try {
      const status = {};
      (userIds || []).forEach((id) => {
        const uid = String(id);
        const val = presence.get(uid);
        status[uid] = val instanceof Set ? val.size > 0 : Boolean(val);
      });
      socket.emit("presence:status", { status });
    } catch (e) {
      console.error("presence:check error", e);
    }
  });

  socket.on("disconnect", async () => {
    try {
      if (!socket.userId) return;

      const uid = String(socket.userId);
      const remaining = removeSocket(presence, uid, socket.id);

      if (remaining === 0) {
        await User.findByIdAndUpdate(uid, {
          "profile.onlineStatus": false,
          lastSeen: new Date(),
        });

        const onlineUsers = await getOnlineUsersFromPresence(presence);
        io.emit("presence:update", onlineUsers);

        io.emit("presence:user_offline", { userId: uid });
      }
    } catch (e) {
      console.error("disconnect presence error", e);
    }
  });
}

export { presenceGet };
