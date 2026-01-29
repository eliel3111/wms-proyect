import express from "express";
import { authMiddleware } from "../middleware/authMiddleware.js";
import { getPendingTransfer, startingTransfer, scanPutawayCode, createTransferLine, dropTransfer } from "../controllers/transferController.js";

const router = express.Router();

//Search for pending transfer lines and confirm session
router.get("/pending", authMiddleware, getPendingTransfer);

// Start a session
router.get("/start", authMiddleware, startingTransfer);

// Filter member scann
router.post("/scan-product", authMiddleware, scanPutawayCode);

//Create a transfer line
router.post("/line", authMiddleware, createTransferLine);

// DROP transfer
router.post("/drop", authMiddleware, dropTransfer);

export default router;
