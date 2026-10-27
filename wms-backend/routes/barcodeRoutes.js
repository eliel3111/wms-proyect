import express from "express";
import { searchProducts, upsertSupplierBarcode, searchLocationsByCode } from "../controllers/barcodeController.js";
import { authMiddleware } from "../middleware/authMiddleware.js";



const router = express.Router();


router.post("/products/search", authMiddleware, searchProducts);

router.post("/supplierCode", authMiddleware, upsertSupplierBarcode);


/* =========================================================
   BUSCAR UBICACIONES
========================================================= */

router.get(
    "/locations/search",
    authMiddleware,
    searchLocationsByCode
);
               


export default router;