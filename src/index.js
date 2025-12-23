import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import Http from "http";
import helmet from "helmet";
import { Server } from "socket.io";
import dotenv from "dotenv";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import colors from "colors";

import connectDb from "./config/db.js";
import connectCloudinary from "./config/cloudinary.config.js";

import authRoutes from "./routes/auth.route.js";
import userRoutes from "./routes/user.route.js";
import matchRoutesFactory from "./routes/match.route.js";
import clubRoutes from "./routes/club.route.js";
import bookingRoutes from "./routes/booking.route.js";
import zegoRoutes from "./routes/zego.route.js";
import friendRoutesFactory from "./routes/friend.route.js";

import registerMatchHandlers from "./services/socket_handler/matchHandler.js";
import registerPresenceHandlers, {
  // this export exists in the updated presenceHandler I gave you
  presenceGet,
} from "./services/socket_handler/presenceHandler.js";

dotenv.config();

const app = express();

// Middleware setup
app.use(helmet());
app.use(express.json());
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));

// CORS setup
app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    credentials: true,
  })
);

// Logger
app.use(morgan("dev"));

// Rate limiter
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// ✅ Create HTTP server first
const server = Http.createServer(app);

// ✅ Create io + presence BEFORE using route factories
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    methods: ["GET", "POST"],
    credentials: true,
  },
  transports: ["websocket", "polling"],
});

// ✅ Presence map (single source of truth)
// With updated presenceHandler, presence values become Set(socketIds)
const presence = new Map();

/**
 * Helper: online check that works for:
 * - presence value = string socketId (legacy)
 * - presence value = Set(socketIds)  (multi-device)
 */
function isOnline(presenceMap, userId) {
  const uid = String(userId);
  if (!presenceMap.has(uid)) return false;

  const val = presenceMap.get(uid);
  if (val instanceof Set) return val.size > 0;
  if (typeof val === "string") return val.length > 0;
  return false;
}

// Routes (normal)
app.use("/api/auth", authRoutes);
app.use("/api/user", userRoutes);
app.use("/api/club", clubRoutes);
app.use("/api/booking", bookingRoutes);
app.use("/api/zego", zegoRoutes);

// ✅ Routes that NEED io + presence (factories)
app.use("/api/friend", friendRoutesFactory(io, presence));
app.use("/api/match", matchRoutesFactory(io, presence));

// User status endpoint (updated: multi-device safe)
app.get("/api/user/status/:id", (req, res) => {
  const { id } = req.params;
  res.json({ userId: String(id), online: isOnline(presence, id) });
});

// Health check
app.get("/api/health", (req, res) => {
  console.log("Health check endpoint hit");
  res.status(200).json({
    status: "ok",
    message: "Server is healthy",
    time: new Date().toISOString(),
  });
});

// ✅ Socket.io connection handler
io.on("connection", (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  // Presence system (emits presence:update + nearbyPlayers)
  // (updated presenceHandler makes it multi-device safe + joins rooms)
  registerPresenceHandlers(io, socket, presence);

  // Match socket handlers (if you use any socket-only match flows)
  registerMatchHandlers(io, socket, presence);

  socket.on("disconnect", () => {
    console.log(`Socket disconnected: ${socket.id}`);
    // presenceHandler already handles cleanup + emits presence:update
  });
});

// Error handling middleware (keep after routes)
app.use((err, req, res, next) => {
  console.error("Server Error:", err.stack);
  res.status(500).json({
    success: false,
    message: "Internal Server Error",
    error: err.message,
  });
});

const PORT = process.env.PORT || 4000;

(async () => {
  try {
    await connectDb();
    await connectCloudinary();
    server.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on port ${PORT}`.bgBrightGreen.black.bold);
    });
  } catch (err) {
    console.error("Failed to start server:", err.message);
    process.exit(1);
  }
})();

process.on("SIGINT", () => {
  console.log("\nServer shutting down...");
  server.close(() => {
    console.log("HTTP server closed");
    process.exit(0);
  });
});
