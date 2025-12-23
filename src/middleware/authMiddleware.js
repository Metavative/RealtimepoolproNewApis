import User from "../models/user.model.js";
import { verifyAccessToken } from "../services/jwtService.js";

export async function authMiddleware(req, res, next) {
  try {
    // 1) Get token from Authorization header OR cookie fallback
    const header = req.headers.authorization;
    let token = null;

    if (header) {
      const parts = String(header).trim().split(" ");
      if (parts.length === 2 && parts[0] === "Bearer") {
        token = parts[1];
      } else {
        return res.status(401).json({ message: "Invalid Authorization format" });
      }
    } else {
      // Optional cookie support (only if you use it)
      token =
        req.cookies?.accessToken ||
        req.cookies?.token ||
        req.cookies?.authToken ||
        null;

      if (!token) {
        return res.status(401).json({ message: "Authorization token missing" });
      }
    }

    // 2) Verify JWT
    const payload = verifyAccessToken(token);

    // ✅ Your authController signs: sign({ id: user._id })
    // Keep fallback to sub if any other token uses it.
    const userId = payload?.id || payload?.sub;

    if (!userId) {
      return res.status(401).json({ message: "Invalid token payload" });
    }

    // 3) Fetch user (sanitize)
    const user = await User.findById(userId).select({ passwordHash: 0, otp: 0 });
    if (!user) {
      return res.status(401).json({ message: "User not found" });
    }

    // 4) Attach to request (string userId is consistent everywhere)
    req.userId = String(user._id);
    req.user = user;

    return next();
  } catch (e) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}
