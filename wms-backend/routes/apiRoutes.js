import express from "express";
import authRoutes from "./authRoutes.js";
import erpRoutes from "./erpRoutes.js"
import receivingRoutes from "./receivingRoutes.js"
import putawayRoutes from "./putawayRoutes.js"
import transferRoutes from "./transferRoutes.js"
import odooRoutes from "./odoo.routes.js"
import warehouseTransfer from "./warehouseTransfer.routes.js"


const router = express.Router();

// Subrutas dentro de /api
router.use("/auth", authRoutes);
router.use("/erp", erpRoutes);
router.use("/receiving", receivingRoutes);
router.use("/putaway", putawayRoutes);
router.use("/transfer", transferRoutes);
router.use("/odoo", odooRoutes);
router.use("/warehouse-transfers", warehouseTransfer);

export default router;