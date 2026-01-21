import express from "express";
import {getPendingPutaway, startingPutaway, getActivePutawaySession, scanPutawayProduct, getActivePutawaySessionExtended, createPutawayLine, scanPutawayLocation  }  from "../controllers/putawayController.js";
import { authMiddleware } from "../middleware/authMiddleware.js";

const router = express.Router();

router.get("/pending", authMiddleware, getPendingPutaway);

router.get("/start", authMiddleware, startingPutaway);
//VERIFY IF AN USER HAS ACTIVE SESSION AND GET ALL RECEPTION LOCATION
router.get("/active-session-extended", authMiddleware, getActivePutawaySessionExtended);
// VERIFY IF AN USER HAS AN ACTIVE SESSION
router.get("/active-session", authMiddleware, getActivePutawaySession);
//CONFIRM A PRODUCT
router.post("/scan-product", authMiddleware, scanPutawayProduct);

// Create a putaway line
router.post("/line", authMiddleware, createPutawayLine);

//Confirm a location in putaway 
router.post("/scan-putaway-location", authMiddleware, scanPutawayLocation);

export default router;
