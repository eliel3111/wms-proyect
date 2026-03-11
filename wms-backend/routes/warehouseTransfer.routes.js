import express from "express";
import { authMiddleware } from "../middleware/authMiddleware.js";
import { authorizeWarehouseSession, settingLocationOrigin, settingLocationDestination, addProductToInternalPicking, clearPickingLocations, deleteWarehouseTransferLine, closeTransferSession, getReceiveWarehouseTransfers, getReceivingByPickingId, saveWarehouseTransfer, getReceivingDifferences, closeWarehouseTransferReceptionFinal } from "../controllers/warehouseTransfer.controller.js";


const router = express.Router();

//Start putaway transfer pick session
router.get("/init", authMiddleware, authorizeWarehouseSession);

//set up location origen
router.post("/location-origen", authMiddleware, settingLocationOrigin);

//set location destino
router.post("/location-destino", authMiddleware, settingLocationDestination);

//saving internal picking
router.post("/save-picking", authMiddleware, addProductToInternalPicking);

//Clean all location of a picking
router.post("/clear-locations", authMiddleware, clearPickingLocations);

//Eliminar una linea de inventario:
router.post(
  "/delete-line",
  authMiddleware,
  deleteWarehouseTransferLine
);

//validar traslado
router.post(
  "/validar-traslado",
  authMiddleware,
  closeTransferSession
);

//obtener todos los traslados pending
router.get( "/receive-transfers", authMiddleware, getReceiveWarehouseTransfers);


// Search all the data related to an picking internal.
router.get("/:pickingId", authMiddleware, getReceivingByPickingId);



// Save warehouse transfer receiving
router.post(
  "/save",
  authMiddleware,
  saveWarehouseTransfer
);


// Get all purschase order lines with differences in an order
router.get(
  "/differences/:poId", authMiddleware, getReceivingDifferences
);

// Close warehouse transfer receiving
router.post(
  "/close",
  authMiddleware,
  closeWarehouseTransferReceptionFinal
);

export default router;
