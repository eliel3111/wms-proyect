import express from "express";
import authRoutes from "./authRoutes.js";

const router = express.Router();

// Subrutas dentro de /api
router.use("/auth", authRoutes);

// Aquí puedes agregar más subrutas
// router.use("/productos", productRoutes);
// router.use("/orders", orderRoutes);

export default router;
