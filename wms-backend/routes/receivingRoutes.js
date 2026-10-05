import express from "express";
import {gettingOpenOrders, confirmingIdOrder, getReceivingByPoId, savingReception, getReceivingDifferences, gettingReceptionLocation, CloseReception, getRecentCompletedReceipts,
  searchPurchaseOrdersWithReceipts, getPurchaseOrderFullDetails } from "../controllers/receivingController.js"
import { authMiddleware } from "../middleware/authMiddleware.js";
import { log } from "console";


const router = express.Router();

// Close a reception process
router.post("/close",authMiddleware, CloseReception);


// Search ALL open or patial purchase orders
router.get("/open", authMiddleware, gettingOpenOrders);

// Confirm than especific id exist
router.post("/by-number", authMiddleware, confirmingIdOrder);

// Save received quantity in the back end
router.post("/save", authMiddleware, savingReception);

// Get all purschase order lines with differences in an order
router.get(
  "/differences",
  authMiddleware,
  getReceivingDifferences
);

// Search all the reception information for reception
router.get(
  "/locations", authMiddleware, gettingReceptionLocation
);


//Last 10 receptions done
router.get(
  "/recent-completed-receipts", authMiddleware,
  getRecentCompletedReceipts
);


//Search a specific reception completed
router.get(
  "/search-purchase-orders/:id", authMiddleware,
  searchPurchaseOrdersWithReceipts
);


//Obtaining reception details from PO
router.get(
  "/purchase-order-details/:id",
  authMiddleware,
  getPurchaseOrderFullDetails
);

// Search all the data related to an purschase order.
router.get("/by-ids", authMiddleware, getReceivingByPoId);



export default router;
