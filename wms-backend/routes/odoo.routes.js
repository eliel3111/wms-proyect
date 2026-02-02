import { Router } from "express";
import { authenticate } from "../controllers/odoo.controller.js";
import { getPurchaseOrders } from "../controllers/odoo.purchase.controller.js"

const router = Router();

router.post("/authenticate", authenticate);
router.get("/purchase-orders", getPurchaseOrders);

export default router;
