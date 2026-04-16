import express from "express";
import { getAvailablePickers, addPickers, removePicker, getAllPickers, updatePickerActiveToday, getPickings, cancelPicking, getActivePickers, reassignPicking, getAssignedPickings, getPickingProductsWithLocations, scanPickingCode, confirmPickingLine, getPickingDifferences, getBestShippingLocation, closePicking } from "../controllers/pickingController.js"
import { authMiddleware } from "../middleware/authMiddleware.js";
import { log } from "console";


const router = express.Router();



// Search ALL users
router.get("/available-users", authMiddleware, getAvailablePickers);

// Agrega un usuario a la tabla pickers o lo pone activo
router.post("/add-pickers", authMiddleware, addPickers);


// Elimina soft un picker, ya no saldra en all pickers
router.post("/remove-picker", authMiddleware, removePicker);


// Buscar todos los pickers cuando abres pantalla monitor 
router.get("/all-pickers", authMiddleware, getAllPickers);

// Elimina soft un picker, ya no saldra en all pickers
router.post("/active-today", authMiddleware, updatePickerActiveToday);

// obtiene todos los picking de despacho y sus asignaciones
router.get("/active-orders",authMiddleware,  getPickings);

// Cancela una orden 
router.post("/cancel",authMiddleware , cancelPicking);

//Obtener todos los pickers activos unicamente
router.get("/active-pickers", authMiddleware, getActivePickers);

//Reasignar un picking
router.post("/reassign", authMiddleware, reassignPicking);

//Obtener todos los pickings asignados a un usuario
router.get("/assigned", authMiddleware, getAssignedPickings);

//Calcular ruta ideal de un pedido
router.get(
  "/:pickingId/products-locations", authMiddleware,
  getPickingProductsWithLocations
);

//Reasignar un picking
router.post("/scan", authMiddleware, scanPickingCode);

//Confirmar una linea
router.post("/confirm-line", authMiddleware, confirmPickingLine);

//Confirmar una linea
router.get("/:pickingId/differences", authMiddleware, getPickingDifferences);

// Obtener mejor ubicación de despacho
router.get("/best-location/:pickingId", authMiddleware, getBestShippingLocation);

//Cerrar recogida de un pedido y mover cantidades
router.post("/close", authMiddleware, closePicking);


export default router;
