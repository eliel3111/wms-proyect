import express from "express";
import {gettingOpenOrders, confirmingIdOrder, getReceivingByPoId, savingReception, getReceivingDifferences, gettingReceptionLocation } from "../controllers/receivingController.js"
import { authMiddleware } from "../middleware/authMiddleware.js";


const router = express.Router();

// Search ALL open or patial purchase orders
router.get("/open", authMiddleware, gettingOpenOrders);

// Confirm than especific id exist
router.post("/by-number", authMiddleware, confirmingIdOrder);

// Save received quantity in the back end
router.post("/save", authMiddleware, savingReception);

// Get all purschase order lines with differences in an order
router.get(
  "/differences/:poId", authMiddleware, getReceivingDifferences
);

// Search all the reception information for reception
router.get(
  "/locations", authMiddleware, gettingReceptionLocation
);

// Search all the data related to an purschase order.
router.get("/:poId", authMiddleware, getReceivingByPoId);



export default router;
