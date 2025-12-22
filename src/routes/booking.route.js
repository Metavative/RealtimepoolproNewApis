import express from "express";
import * as bc from "../controllers/bookingController.js";
import { authMiddleware } from "../middleware/authMiddleware.js";

// Factory so we can inject io + presence
export default function createBookingRouter(io, presence) {
  const router = express.Router();

  // list does not need io/presence
  router.get("/", authMiddleware, bc.listBookings);

  // cancel needs io/presence for realtime emits
  router.post("/cancel", authMiddleware, (req, res) =>
    bc.cancelBooking(req, res, io, presence)
  );

  return router;
}
