import express from "express";
import { inventoryScan, applyInventoryCount } from "../controllers/inventoryController.js";
import { authMiddleware } from "../middleware/authMiddleware.js";



const router = express.Router();


router.post("/scanned", inventoryScan);
router.post("/apply-count", applyInventoryCount);






export default router;