import express from "express";
import {gettingOpenOrders, confirmingIdOrder, getReceivingByPoId} from "../controllers/receivingController.js"
import { authMiddleware } from "../middleware/authMiddleware.js";


const router = express.Router();

// Search ALL open or patial purchase orders
router.get("/open", authMiddleware, gettingOpenOrders);

// Confirm than especific id exist
router.post("/by-number", confirmingIdOrder);

// Search all the data related to an purschase order.
router.get("/:poId", getReceivingByPoId);



export default router;
