import jwt from "jsonwebtoken";

// Function to retrieve the secret key for JWT
function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    console.error("JWT_SECRET is missing in .env file.".red); // Log an error if the secret is missing
    throw new Error("JWT_SECRET is missing");
  }
  return secret;
}

// Function to retrieve JWT expiration time
function getExpires() {
  const v = process.env.JWT_EXPIRES;
  if (v && String(v).trim()) {
    return String(v).trim();
  }
  console.warn("JWT_EXPIRES not defined, defaulting to '7d'".yellow); // Log a warning if the expiration time is not set
  return "7d"; // Default expiration time is 7 days
}

// Function to sign the JWT token
export function sign(payload, expiresIn) {
  if (!payload || typeof payload !== "object") {
    throw new Error("JWT payload must be an object");
  }

  return jwt.sign(payload, getSecret(), {
    expiresIn: expiresIn || getExpires(),
  });
}

// Function to verify the JWT token
export function verify(token) {
  if (!token) {
    throw new Error("JWT token required");
  }

  try {
    return jwt.verify(token, getSecret());
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      throw new Error("JWT token has expired");
    }
    if (err.name === "JsonWebTokenError") {
      throw new Error("Invalid JWT token");
    }
    throw new Error("Error verifying JWT token: " + err.message);
  }
}

/**
 * ✅ Backwards-compatible export for middleware expecting verifyAccessToken
 * Your authMiddleware imports:
 *   import { verifyAccessToken } from "../services/jwtService.js";
 */
export function verifyAccessToken(token) {
  return verify(token);
}