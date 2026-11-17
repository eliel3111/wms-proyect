import express from "express";


import {
    syncReturnDocumentLinesController
} from "../controllers/returnsController.js";


import {
    authMiddleware
} from "../middleware/authMiddleware.js";


const router =
    express.Router();



router.post(
    "/:tipo/:guid/lines/sync",
    authMiddleware,
    syncReturnDocumentLinesController
);


// ============================================================
// EXPORTAR ROUTER
// ============================================================

export default router;