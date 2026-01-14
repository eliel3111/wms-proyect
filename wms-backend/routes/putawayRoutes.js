import express from "express";
import {getPendingPutaway, startingPutaway, getActivePutawaySession, scanPutawayProduct}  from "../controllers/putawayController.js";
import { authMiddleware } from "../middleware/authMiddleware.js";

const router = express.Router();

router.get("/pending", authMiddleware, getPendingPutaway);

router.get("/start", authMiddleware, startingPutaway);
// VERIFY IF AN USER HAS AN ACTIVE SESSION
router.get("/active-session", authMiddleware, getActivePutawaySession);
//CONFIRM A PRODUCT
router.post("/scan-product", authMiddleware, scanPutawayProduct);

export default router;
