import express from "express";
import { authMiddleware } from "../middleware/authMiddleware.js";
import * as c from "../controllers/matchController.js";

export default function matchRoutes(io, presence) {
  const router = express.Router();

  router.post("/challenge", authMiddleware, (req, res) =>
    c.createChallenge(req, res, io, presence)
  );

  router.post("/accept", authMiddleware, (req, res) =>
    c.acceptChallenge(req, res, io, presence)
  );

  router.post("/finish", authMiddleware, (req, res) =>
    c.finishMatch(req, res, io, presence)
  );

  return router;
}
