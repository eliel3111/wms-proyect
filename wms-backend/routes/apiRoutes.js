import express from "express";
import authRoutes from "./authRoutes.js";
import erpRoutes from "./erpRoutes.js"
import receivingRoutes from "./receivingRoutes.js"
import putawayRoutes from "./putawayRoutes.js"
import transferRoutes from "./transferRoutes.js"

const router = express.Router();

// Subrutas dentro de /api
router.use("/auth", authRoutes);
router.use("/erp", erpRoutes);
router.use("/receiving", receivingRoutes);
router.use("/putaway", putawayRoutes);
router.use("/transfer", transferRoutes);

export default router;