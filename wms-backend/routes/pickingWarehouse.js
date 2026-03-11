import express from "express";
import { getAvailablePickers, addPickers, removePicker, getAllPickers, updatePickerActiveToday} from "../controllers/pickingController.js"
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


export default router;
