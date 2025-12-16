import express from "express";
import {createPurchaseOrder} from "../controllers/erpController.js";


const router = express.Router();

// ERP envía una orden de compra al WMS
router.post("/purchase-orders", createPurchaseOrder);


// 🔹 Ejemplo: ERP consulta estado de una PO
router.get("/purchase-orders/:poNumber/status", (req, res) => {
  res.json({ status: "RECEIVING" });
});

export default router;
