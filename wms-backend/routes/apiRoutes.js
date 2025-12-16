import express from "express";
import authRoutes from "./authRoutes.js";
import erpRoutes from "./erpRoutes.js"

const router = express.Router();

// Subrutas dentro de /api
router.use("/auth", authRoutes);

//Rutas usadas por el ERP
router.use("/erp", erpRoutes);

// Aquí puedes agregar más subrutas
// router.use("/productos", productRoutes);
// router.use("/orders", orderRoutes);

export default router;
