// socketHandlers/onlinePlayers.js
import User from "../../models/user.model.js";

/**
 * Multi-socket tracker:
 * userId -> Set(socketId)
 * So a user remains "online" until ALL their devices disconnect.
 */
const userSockets = new Map();

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
        $maxDistance: radiusKm * 1000, // meters
      },
    },
  }).select(
    "profile.nickname profile.avatar stats.totalWinnings profile.verified location"
  );
}

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
  io.to(uid).emit(event, payload); // legacy support
}

/**
 * Register Socket.IO logic for live online + nearby player syncing
 */
export default function registerOnlinePlayerHandlers(io, socket) {
  // Player connects / goes online
  socket.on("player:online", async ({ userId, location, radiusKm }) => {
    try {
      if (!userId || !location) return;

      const uid = String(userId);

      // Join rooms for this user (supports both new + existing emits)
      socket.join(`user:${uid}`);
      socket.join(uid);

      // Mark socket userId
      socket.userId = uid;

      const first = isFirstSocket(uid);
      addSocket(uid, socket.id);

      // Update DB only once per user session start (optional but good)
      // Still updates location/lastSeen every time.
      await User.findByIdAndUpdate(uid, {
        "profile.onlineStatus": true,
        location: {
          type: "Point",
          coordinates: [location.lng, location.lat],
        },
        lastSeen: new Date(),
      });

      // Emit nearby players list to this socket
      const nearbyPlayers = await getNearbyPlayers(uid, radiusKm ?? 5);
      socket.emit("nearbyPlayers", nearbyPlayers);

      // Notify nearby players that this user is nearby/online
      for (const player of nearbyPlayers) {
        emitToUser(io, player._id, "playerNearby", {
          userId: uid,
          nickname: undefined, // keep payload minimal; if you want, fetch current user nickname
          avatar: undefined,
          location,
        });
      }

      // Optional: global presence signal (only on first socket)
      if (first) {
        io.emit("presence:user_online", { userId: uid });
      }
    } catch (err) {
      // silent fail to avoid crashing socket loop
      console.error("player:online error:", err);
    }
  });

  // Player moves (live update)
  socket.on("player:move", async ({ userId, location, radiusKm }) => {
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
      socket.emit("nearbyPlayers", nearbyPlayers);
    } catch (err) {
      console.error("player:move error:", err);
    }
  });

  // Player disconnects
  socket.on("disconnect", async () => {
    try {
      if (!socket.userId) return;

      const uid = String(socket.userId);
      const remaining = removeSocket(uid, socket.id);

      // Only mark offline when last device disconnects
      if (remaining === 0) {
        await User.findByIdAndUpdate(uid, {
          "profile.onlineStatus": false,
          lastSeen: new Date(),
        });

        // Keep your existing event
        io.emit("playerOffline", uid);

        // Also emit standardized presence event
        io.emit("presence:user_offline", { userId: uid });
      }
    } catch (err) {
      console.error("disconnect onlinePlayers error:", err);
    }
  });
}
