import express from "express";
import { inventoryScan, applyInventoryCount, getInventorySessionStatus, updateInventoryAdjustmentMode, createInventorySession, startInventorySession, cancelInventorySession, completeInventorySession, getInventoryLiveSummary, getInventoryFinalReport, getInventoryLocationsReport } from "../controllers/inventoryController.js";
import { authMiddleware } from "../middleware/authMiddleware.js";



const router = express.Router();


router.post("/scanned", inventoryScan);
router.post("/apply-count", applyInventoryCount);


// Pantalla Inventory Monitor: obtiene la configuración de inventario y valida si existe una sesión activa.
router.get("/session-status", authMiddleware, getInventorySessionStatus);


// Actualiza el modo de ajuste de inventario (final/immediate) si no existe una sesión activa.
router.post("/adjustment-mode", authMiddleware , updateInventoryAdjustmentMode);


// Crea una nueva sesión de inventario validando que no exista otra activa.
router.post("/new-session", authMiddleware , createInventorySession);


//Inicia una session de inventario a in-progress donde los usuarios pueden contar
router.post("/session/start", authMiddleware, startInventorySession);


// Cancela una sesión de inventario activa y limpia los conteos realizados.
router.post("/session/cancel", authMiddleware, cancelInventorySession);


// Finaliza una sesión de inventario y la mueve a estado review.
router.post("/session/complete", authMiddleware, completeInventorySession);


//obtener summary
router.get("/live-summary", authMiddleware, getInventoryLiveSummary);


//Obtener reporte final de inventario en excell
router.get(
  "/report/final",
  authMiddleware,
  getInventoryFinalReport
);


//Obtener reporte de inventario por ubicaciones
router.get(
  "/report/locations",
  getInventoryLocationsReport
);




export default router;