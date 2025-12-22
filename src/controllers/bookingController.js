import Bookinng from "../models/booking.modal.js";

// Helper: emit to a user if online
function emitToUser(io, presence, userId, event, payload) {
  if (!io || !presence || !userId) return;
  const socketId = presence.get(String(userId));
  if (socketId) io.to(socketId).emit(event, payload);
}

// ============= L I S T  O F  B O O K I N G S  =========
// NOTE: unchanged signature, no socket needed here
export async function listBookings(req, res) {
  try {
    const bookings = await Bookinng.find({ user: req.userId }).populate("club");
    return res.json({ bookings });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

// ========== C A N C E L  B O O K I N G ==========
// UPDATED SIGNATURE: (req, res, io, presence)
// If your routes don’t pass io/presence yet, you can keep old signature.
// This will still work even if io/presence are undefined (emit will no-op).
export async function cancelBooking(req, res, io, presence) {
  try {
    const { bookingId } = req.body;

    if (!bookingId) {
      return res.status(400).json({ message: "bookingId is required" });
    }

    const b = await Bookinng.findById(bookingId).populate("club");

    if (!b) {
      return res.status(404).json({ message: "Not found" });
    }

    // ✅ Only owner can cancel (important security)
    if (String(b.user) !== String(req.userId)) {
      return res.status(403).json({ message: "Not authorized" });
    }

    b.status = "cancelled";
    await b.save();

    // ✅ Realtime notify the user (optional)
    emitToUser(io, presence, req.userId, "booking:cancelled", {
      bookingId: b._id,
      status: b.status,
      booking: b,
    });

    return res.json({ b });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
