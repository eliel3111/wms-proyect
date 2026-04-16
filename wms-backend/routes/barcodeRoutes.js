import express from "express";
import { searchProducts, upsertSupplierBarcode } from "../controllers/barcodeController.js";
import { authMiddleware } from "../middleware/authMiddleware.js";



const router = express.Router();


router.post("/products/search", authMiddleware, searchProducts);

router.post("/supplierCode", authMiddleware, upsertSupplierBarcode);




export default router;