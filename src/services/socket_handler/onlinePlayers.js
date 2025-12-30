// socketHandlers/onlinePlayers.js
import User from "../../models/user.model.js";

/**
 * Multi-socket tracker:
 * userId -> Set(socketId)
 */
const userSockets = new Map();

function addSocket(userId, socketId) {
  const uid = String(userId);
  if (!userSockets.has(uid)) userSockets.set(uid, new Set());
  userSockets.get(uid).add(socketId);
}

function removeSocket(userId, socketId) {
  const uid = String(userId);
  const set = userSockets.get(uid);
  if (!set) return 0;

  set.delete(socketId);
  if (set.size === 0) userSockets.delete(uid);
  return set.size;
}

function isFirstSocket(userId) {
  const uid = String(userId);
  return !userSockets.has(uid) || userSockets.get(uid).size === 0;
}

/**
 * Helper to emit to both room formats:
 * - user:<id> (new)
 * - <id>      (legacy)
 */
function emitToUser(io, userId, event, payload) {
  const uid = String(userId);
  io.to(`user:${uid}`).emit(event, payload);
  io.to(uid).emit(event, payload);
}

/**
 * Server-side cache bust helper
 * (lets client add ?cb=<value>)
 */
function decoratePlayers(list) {
  const bust = Date.now();
  return (list || []).map((u) => {
    const obj = u?.toObject ? u.toObject() : u;
    return { ...obj, __avatarBust: bust };
  });
}

/**
 * Calculate nearest online players using GeoJSON query
 */
async function getNearbyPlayers(userId, radiusKm = 5) {
  const user = await User.findById(userId);
  if (!user || !user.location?.coordinates) return [];

  const [lng, lat] = user.location.coordinates;

  return User.find({
    _id: { $ne: userId },
    "profile.onlineStatus": true,
    location: {
      $near: {
        $geometry: { type: "Point", coordinates: [lng, lat] },
        $maxDistance: radiusKm * 1000,
      },
    },
  }).select(
    // ✅ include avatarUpdatedAt + updatedAt so client can cache-bust properly
    "profile.nickname profile.avatar profile.avatarUpdatedAt profile.verified stats.totalWinnings location updatedAt"
  );
}

/**
 * Get all online players (simple list)
 */
async function getOnlinePlayersList(userId) {
  return User.find({
    _id: { $ne: userId },
    "profile.onlineStatus": true,
  }).select(
    "profile.nickname profile.avatar profile.avatarUpdatedAt profile.verified stats.totalWinnings location updatedAt"
  );
}

/**
 * Unified handler: "user went online / identify"
 */
async function handleOnline(io, socket, { userId, location, radiusKm }) {
  try {
    if (!userId) return;

    const uid = String(userId);

    // Join rooms
    socket.join(`user:${uid}`);
    socket.join(uid);

    socket.userId = uid;

    const first = isFirstSocket(uid);
    addSocket(uid, socket.id);

    // Update DB
    if (location?.lng != null && location?.lat != null) {
      await User.findByIdAndUpdate(uid, {
        "profile.onlineStatus": true,
        location: {
          type: "Point",
          coordinates: [location.lng, location.lat],
        },
        lastSeen: new Date(),
      });
    } else {
      await User.findByIdAndUpdate(uid, {
        "profile.onlineStatus": true,
        lastSeen: new Date(),
      });
    }

    // Emit nearby + online lists to this socket
    const nearbyPlayers = await getNearbyPlayers(uid, radiusKm ?? 5);
    socket.emit("nearbyPlayers", decoratePlayers(nearbyPlayers));

    const onlinePlayers = await getOnlinePlayersList(uid);
    socket.emit("onlinePlayers", decoratePlayers(onlinePlayers));

    // Optional: global presence signal (only on first socket)
    if (first) {
      io.emit("presence:user_online", { userId: uid });
    }
  } catch (err) {
    console.error("handleOnline error:", err);
  }
}

/**
 * Unified handler: "user moved"
 */
async function handleMove(io, socket, { userId, location, radiusKm }) {
  try {
    if (!userId || !location) return;

    const uid = String(userId);

    await User.findByIdAndUpdate(uid, {
      location: {
        type: "Point",
        coordinates: [location.lng, location.lat],
      },
      lastSeen: new Date(),
    });

    const nearbyPlayers = await getNearbyPlayers(uid, radiusKm ?? 5);
    socket.emit("nearbyPlayers", decoratePlayers(nearbyPlayers));

    const onlinePlayers = await getOnlinePlayersList(uid);
    socket.emit("onlinePlayers", decoratePlayers(onlinePlayers));
  } catch (err) {
    console.error("handleMove error:", err);
  }
}

/**
 * Register Socket.IO logic
 */
export default function registerOnlinePlayerHandlers(io, socket) {
  // ✅ Original events (keep)
  socket.on("player:online", (payload) => handleOnline(io, socket, payload));
  socket.on("player:move", (payload) => handleMove(io, socket, payload));

  // ✅ Flutter aliases (your app emits these)
  socket.on("userOnline", ({ userId }) => handleOnline(io, socket, { userId }));
  socket.on("user:identify", ({ userId, location }) =>
    handleOnline(io, socket, { userId, location })
  );

  socket.on("updateLocation", ({ userId, lng, lat }) =>
    handleMove(io, socket, {
      userId,
      location: { lng, lat },
    })
  );

  // ✅ Presence list request events (your app emits many)
  const presenceResponder = async () => {
    try {
      const uid = String(socket.userId || "");
      if (!uid) return;

      const nearbyPlayers = await getNearbyPlayers(uid, 5);
      socket.emit("nearbyPlayers", decoratePlayers(nearbyPlayers));

      const onlinePlayers = await getOnlinePlayersList(uid);
      socket.emit("onlinePlayers", decoratePlayers(onlinePlayers));
    } catch (err) {
      console.error("presenceResponder error:", err);
    }
  };

  socket.on("presence:get", presenceResponder);
  socket.on("getOnlinePlayers", presenceResponder);
  socket.on("onlinePlayers:get", presenceResponder);
  socket.on("players:online:get", presenceResponder);
  socket.on("nearbyPlayers:get", presenceResponder);
  socket.on("players:nearby:get", presenceResponder);

  // Disconnect
  socket.on("disconnect", async () => {
    try {
      if (!socket.userId) return;

      const uid = String(socket.userId);
      const remaining = removeSocket(uid, socket.id);

      if (remaining === 0) {
        await User.findByIdAndUpdate(uid, {
          "profile.onlineStatus": false,
          lastSeen: new Date(),
        });

        io.emit("playerOffline", uid);
        io.emit("presence:user_offline", { userId: uid });
      }
    } catch (err) {
      console.error("disconnect onlinePlayers error:", err);
    }
  });
}
