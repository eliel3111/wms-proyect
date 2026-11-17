
import express from "express";

import {
    getInspectionInitialDocuments,
    searchInspectionDocuments,
    syncInspectionDocumentLinesController,
    updateInspectionLineQuantity,
    resolveInspectionScanController
} from "../controllers/inspectionController.js";



import {
    authMiddleware
} from "../middleware/authMiddleware.js";


const router = express.Router();


// ============================================================
// 1. INITIAL
//
// GET /api/inspection/initial
//
// Si el input está vacío.
// ============================================================

router.get(
    "/initial",
    authMiddleware,
    getInspectionInitialDocuments
);


// ============================================================
// 2. SEARCH
//
// GET /api/inspection/search?q=texto
//
// Busca:
// - erp_dispatches
// - erp_invoices
//
// Devuelve máximo:
// - 10 conduces
// - 10 facturas
// ============================================================

router.get(
    "/search",
    authMiddleware,
    searchInspectionDocuments
);


// ============================================================
// 3. SCANNER - BUSCAR PRODUCTO
//
// POST /api/inspection/scan
//
// BODY:
//
// {
//     "code": "SKU-00001"
// }
//
// FUNCIONAMIENTO:
//
// 1. Recibe el código escaneado desde la PDA.
//
// 2. Busca primero en products.sku.
//
// 3. Si no existe, busca en product_barcodes.barcode.
//
// 4. Cuando encuentra un barcode:
//    - Obtiene product_barcodes.product_sku.
//    - Busca el producto en products.sku.
//
// 5. Obtiene products.erp_sku.
//
// 6. Devuelve el ERP SKU al frontend.
//
// 7. El frontend compara el ERP SKU con
//    InspectionLine.sku.
//
// 8. Si coincide:
//    - Abre el ScanModal.
//    - Producto confirmado en verde.
//
// 9. Si no coincide:
//    - Abre el modal de error rojo.
// ============================================================

router.post(
    "/scan",
    authMiddleware,
    resolveInspectionScanController
);


// ============================================================
// 4. INSPECTION DOCUMENT LINES
//
// POST /api/inspection/:tipo/:guid/lines/sync
//
// Recibe:
//
// tipo:
// - CONDUCE
// - FACTURA
//
// guid:
// - UUID del documento en Adm Cloud
//
// FUNCIONAMIENTO:
//
// 1. Recibe tipo y GUID.
// 2. Consulta el documento en Adm Cloud.
// 3. Obtiene sus productos.
// 4. Sincroniza erp_inspection_lines.
// 5. Conserva las cantidades inspeccionadas.
// 6. Devuelve las líneas al frontend.
// ============================================================

router.post(
    "/:tipo/:guid/lines/sync",
    authMiddleware,
    syncInspectionDocumentLinesController
);


// ============================================================
// 5. CONFIRMAR PRODUCTO Y CANTIDAD INSPECCIONADA
//
// PATCH /api/inspection/:tipo/:guid/lines/:lineId
//
// Recibe:
//
// tipo:
// - CONDUCE
// - FACTURA
//
// guid:
// - UUID del documento en Adm Cloud
//
// lineId:
// - ID de erp_inspection_lines
//
// BODY:
//
// {
//     "scanned_code": "WE-CHMF",
//     "inspected_quantity": "12"
// }
//
// FUNCIONAMIENTO:
//
// 1. Recibe el ERP SKU validado.
// 2. Verifica que coincida con la línea.
// 3. Verifica que pertenezca al documento.
// 4. Actualiza inspected_quantity.
// 5. Registra inspected_by.
// 6. Registra inspected_at.
// 7. Actualiza updated_at.
// 8. Devuelve la línea actualizada.
//
// NOTA:
// La cantidad reemplaza el valor anterior.
// No se acumula automáticamente.
// ============================================================

router.patch(
    "/:tipo/:guid/lines/:lineId",
    authMiddleware,
    updateInspectionLineQuantity
);


// ============================================================
// EXPORTAR ROUTER
// ============================================================

export default router;
