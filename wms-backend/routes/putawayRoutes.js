import express from "express";
import {getPendingPutaway}  from "../controllers/putawayController.js";

const router = express.Router();

router.get("/pending", getPendingPutaway);

export default router;
