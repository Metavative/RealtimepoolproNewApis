import User from "../models/user.model.js";
import { verifyAccessToken } from "../services/jwtService.js";

export async function authMiddleware(req, res, next) {
  try {
    const header = req.headers.authorization;

    if (!header) {
      return res.status(401).json({ message: "Authorization header missing" });
    }

    const parts = String(header).trim().split(" ");
    if (parts.length !== 2 || parts[0] !== "Bearer") {
      return res.status(401).json({ message: "Invalid Authorization format" });
    }

    const token = parts[1];
    const payload = verifyAccessToken(token);

    // ✅ Your authController signs: sign({ id: user._id })
    // Keep fallback to sub if any other token uses it.
    const userId = payload?.id || payload?.sub;

    if (!userId) {
      return res.status(401).json({ message: "Invalid token payload" });
    }

    const user = await User.findById(userId).select({ passwordHash: 0, otp: 0 });
    if (!user) {
      return res.status(401).json({ message: "User not found" });
    }

    req.userId = user._id;
    req.user = user;

    return next();
  } catch (e) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}