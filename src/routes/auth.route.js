import express from "express";
import rateLimit from "express-rate-limit";

import * as authctrl from "../controllers/authController.js";
import { authMiddleware } from "../middleware/authMiddleware.js";

// optional (guarded below)
import { requireCsrf } from "../middleware/csrf.middleware.js";

const router = express.Router();

/**
 * Separate limiters (better UX + still secure)
 */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many login attempts from this IP, please try again later.",
});

const signupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many signup attempts from this IP, please try again later.",
});

const otpSendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10, // ✅ increase a bit (people resend)
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many OTP requests from this IP, please try again later.",
});

const otpVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20, // ✅ allow more because users mistype codes
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many OTP verification attempts, please try again later.",
});

/* ============================
   Public Auth Routes
   ============================ */

// Signup
router.post("/signup", signupLimiter, authctrl.signUp);

// Login
router.post("/login", loginLimiter, authctrl.login);

// Canonical OTP routes
router.post("/otp/request", otpSendLimiter, authctrl.requestOtp);
router.post("/otp/verify", otpVerifyLimiter, authctrl.verifyOtp);

// ✅ Compatibility: email
router.post("/send-otp-email", otpSendLimiter, authctrl.requestOtp);
router.post("/verify-otp-email", otpVerifyLimiter, authctrl.verifyOtp);

// ✅ Compatibility: phone (both names)
router.post("/send-otp-phone", otpSendLimiter, authctrl.requestOtp);
router.post("/verify-otp-phone", otpVerifyLimiter, authctrl.verifyOtp);

router.post("/send-otp-sms", otpSendLimiter, authctrl.requestOtp);
router.post("/verify-otp-sms", otpVerifyLimiter, authctrl.verifyOtp);

// Password recovery (also uses OTP internally, so limit a bit)
router.post("/forgot", otpSendLimiter, authctrl.forgotPassword);
router.post("/reset", otpVerifyLimiter, authctrl.resetPassword);

// Clerk authentication (treat like login)
router.post("/clerk", loginLimiter, authctrl.clerkLogin);

/* ============================
   Token / Session Management
   ============================ */
if (typeof authctrl.refresh === "function" && typeof requireCsrf === "function") {
  router.post("/refresh", requireCsrf, authctrl.refresh);
}
if (typeof authctrl.logout === "function" && typeof requireCsrf === "function") {
  router.post("/logout", requireCsrf, authctrl.logout);
}
if (typeof authctrl.logoutAll === "function") {
  router.post("/logout-all", authMiddleware, authctrl.logoutAll);
}

export default router;
