import express from "express";
import { authMiddleware } from "../middleware/authMiddleware.js";
import * as useCtrl from "../controllers/userController.js";
import userUpload from "../lib/user.multer.js";
import User from "../models/user.model.js";
// import { calculateDistance } from "../utils/geolocation.js";  // Utility function for distance calculation

const router = express.Router();

/**
 * Get online players (simple REST fallback)
 * NOTE: Uses DB flag profile.onlineStatus (set by sockets)
 */
router.get("/online", authMiddleware, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 50), 200);

    const users = await User.find({ "profile.onlineStatus": true })
      .select("profile.nickname profile.avatar profile.onlineStatus stats.rank stats.totalWinnings stats.userIdTag lastSeen")
      .sort({ lastSeen: -1 })
      .limit(limit)
      .lean();

    return res.json({ users });
  } catch (err) {
    console.error("Error fetching online users:", err);
    return res.status(500).json({ message: "Server error", error: err.message || err });
  }
});

// Get current user details
router.get("/me", authMiddleware, useCtrl.me);

// Update current user profile and avatar
router.patch("/me", authMiddleware, userUpload.single("userAvatar"), useCtrl.updateProfile);

// Get nearest players
router.get("/nearest", authMiddleware, useCtrl.nearestPlayers);

// Get nearest players to a specific user by userId
router.get("/nearest/:id", authMiddleware, async (req, res) => {
  try {
    const userId = req.params.id;

    // Fetch current user by ID
    const currentUser = await User.findById(userId);
    if (!currentUser) {
      return res.status(404).json({ message: "User not found" });
    }

    const { latitude, longitude } = currentUser.profile || {};
    if (latitude === undefined || longitude === undefined) {
      return res.status(400).json({ message: "Location not set" });
    }

    // Fetch all online users
    const allUsers = await User.find({ "profile.onlineStatus": true });

    // Map users to get their distance from current user
    const nearby = allUsers
      .filter((u) => u._id.toString() !== userId) // Exclude the current user
      .map((u) => {
        const distance = calculateDistance(
          latitude,
          longitude,
          u.profile?.latitude,
          u.profile?.longitude
        );
        return {
          id: u._id,
          nickname: u.profile?.nickname,
          avatar: u.profile?.avatar,
          distance,
        };
      })
      .sort((a, b) => a.distance - b.distance) // Sort by distance
      .slice(0, 10); // Return the closest 10 users

    return res.json(nearby);
  } catch (err) {
    console.error("Error in fetching nearest players:", err);
    return res.status(500).json({
      message: "Server error",
      error: err.message || err,
    });
  }
});

export default router;