import { db } from "../db.js";
import { getActiveProductById, getPrimaryBarcodeBySku, getActiveProductBySku } from "../services/productService.js";
import { getActiveStorageLocationByCode, getUserActiveLocation, getActiveLocationByCodeAndType } from "../services/locationService.js";
import { moveInventoryBetweenLocations, createInventoryMovement } from "../services/inventoryService.js";
import { getActiveTransferSession } from "../services/transferSession.service.js";
import { AppError } from "../utils/AppError.js";


// GET ALL PENDING TRANSFER LINES FOR A USER
export async function getPendingTransfer(req, res) {
    try {
        console.log("🔥 GET /transfer/pending funcionando");

        // 👉 si usas authMiddleware, normalmente viene de req.user
        const userId = req.user?.id || req.query.userId;
        console.log("🔥 userId:", userId);

        if (!userId) {
            return res.status(400).json({
                success: false,
                code: "USER_REQUIRED",
                message: "User id requerido"
            });
        }

        // 1️⃣ Buscar sesión activa de transferencia del usuario
        const session = await getActiveTransferSession(db, userId);


        if (!session) {
            return res.json({
                success: true,
                sessionId: null,
                totalLines: 0,
                data: []
            });
        }


        const transferSessionId = session.id;

        // 2️⃣ Buscar líneas pendientes (NO completed)
        const linesResult = await db.query(`
      SELECT
        tl.id,
        p.sku,
        p.description,
        p.uom,

        lf.code AS from_location,
        lt.code AS to_location,

        tl.picked_qty,
        tl.remaining_qty AS pending_qty
      FROM transfer_lines tl
      JOIN products p ON p.id = tl.product_id
      JOIN locations lf ON lf.id = tl.from_location_id
      JOIN locations lt ON lt.id = tl.to_location_id
      WHERE tl.transfer_session_id = $1
        AND tl.status IN ('open','partial')
      ORDER BY p.sku;
    `, [transferSessionId]);

        // 3️⃣ Enriquecer con código de barras (igual que putaway)
        const enrichedLines = [];

        for (const line of linesResult.rows) {
            const barcodeResult = await getPrimaryBarcodeBySku(db, line.sku);

            enrichedLines.push({
                ...line,
                barcode: barcodeResult.rowCount > 0
                    ? barcodeResult.rows[0].barcode
                    : null
            });
        }

        // 4️⃣ Responder al frontend
        return res.json({
            success: true,
            sessionId: transferSessionId,
            totalLines: enrichedLines.length,
            data: enrichedLines
        });

    } catch (error) {
        console.error("❌ Error en getPendingTransfers:", error);

        return res.status(500).json({
            success: false,
            code: "INTERNAL_ERROR",
            message: "Error buscando transferencias pendientes"
        });
    }
}


// START A TRANSFER SESSION FOR A USER
export async function startingTransfer(req, res) {
    try {
        console.log("🔥 GET /transfer/start");

        const userId = req.user?.id; // viene del authMiddleware

        if (!userId) {
            return res.status(403).json({
                success: false,
                code: "NO_USER",
                message: "Usuario no autenticado"
            });
        }

        // 1️⃣ Buscar sesión activa
        const activeSession = await db.query(`
      SELECT *
      FROM transfer_sessions
      WHERE user_id = $1
        AND status NOT IN ('completed', 'cancelled')
      ORDER BY started_at DESC
      LIMIT 1
    `, [userId]);

        if (activeSession.rowCount > 0) {
            return res.json({
                success: true,
                alreadyExists: true,
                session: activeSession.rows[0]
            });
        }

        // 2️⃣ Crear nueva sesión
        const newSession = await db.query(`
      INSERT INTO transfer_sessions
        (user_id, status)
      VALUES
        ($1, 'open')
      RETURNING *
    `, [userId]);

        return res.status(201).json({
            success: true,
            alreadyExists: false,
            session: newSession.rows[0]
        });

    } catch (error) {
        console.error("❌ Error en startingTransfer:", error);

        return res.status(500).json({
            success: false,
            code: "START_TRANSFER_ERROR",
            message: "Error iniciando sesión de transferencia"
        });
    }
}


export async function scanPutawayCode(req, res) {
    try {
        const { code, current_location_id } = req.body;

        console.log("SE LEYO ESTE CODIGO:", code, "UBICACION:", current_location_id);

        if (!code) {
            return res.status(400).json({
                success: false,
                message: "Código requerido"
            });
        }

        const normalized = code.trim().toUpperCase();

        /* ======================================
           1️⃣ ¿ES UNA UBICACIÓN?
        ====================================== */
        const locationResult = await getActiveStorageLocationByCode(db, normalized);

        if (locationResult.rowCount > 0) {
            return res.json({
                success: true,
                type: "location",
                location: locationResult.rows[0]
            });
        }

        /* ======================================
           2️⃣ ¿ES UN PRODUCTO?
        ====================================== */
    const productResult = await db.query(`
  SELECT DISTINCT
    p.id,
    p.sku,
    p.description,
    p.uom
  FROM products p
  LEFT JOIN product_barcodes pb
    ON pb.product_sku = p.sku
  WHERE UPPER(pb.barcode) = $1
     OR UPPER(p.sku) = $1
  LIMIT 1
`, [normalized]);

        if (productResult.rowCount === 0) {
            return res.json({
                success: false,
                code: "INVALID_CODE",
                message: "El código no corresponde a una ubicación ni a un producto"
            });
        }

        /* ======================================
           3️⃣ PRODUCTO SIN UBICACIÓN ESCANEADA
        ====================================== */
        if (!current_location_id) {
            return res.json({
                success: false,
                code: "NO_LOCATION",
                message: "Primero escanea una ubicación"
            });
        }

        const product = productResult.rows[0];

        /* ======================================
           4️⃣ VALIDAR INVENTARIO EN ESA UBICACIÓN
        ====================================== */
        const inventoryResult = await db.query(`
      SELECT 
        il.product_sku,
        il.location_id,
        il.qty_available
      FROM inventory_by_location il
      WHERE il.product_sku = $1
        AND il.location_id = $2
        AND il.qty_available > 0
      LIMIT 1
    `, [product.sku, current_location_id]);

        if (inventoryResult.rowCount === 0) {
            return res.json({
                success: false,
                code: "NO_STOCK_IN_LOCATION",
                message: "El producto no existe en esa ubicación o no tiene cantidad disponible"
            });
        }

        /* ======================================
           5️⃣ TODO OK
        ====================================== */
        return res.json({
            success: true,
            type: "product",
            product: {
                ...product,
                qty_available: inventoryResult.rows[0].qty_available,
                from_location_id: current_location_id
            }
        });

    } catch (error) {
        console.error("❌ scanPutawayCode:", error);
        return res.status(500).json({
            success: false,
            message: "Error procesando el código"
        });
    }
}










 // ============================================================
 // SCAN TRANSFER DROP
 // CONTROLLER ACTUALIZADO + LOGS DE DIAGNÓSTICO
 // ============================================================

export async function scanTransferDropCode(req, res) {

    console.log(
        "\x1b[45m\x1b[37m\x1b[1m 🚚 INICIANDO SCAN TRANSFER DROP \x1b[0m"
    );

    console.log("🕒 FECHA:", new Date().toISOString());
    console.log("🌐 METHOD:", req.method);
    console.log("🌐 ENDPOINT:", req.originalUrl || req.url);

    try {

        // =====================================================
        // 1️⃣ DATOS DEL REQUEST
        // =====================================================

        console.log(
            "\x1b[44m\x1b[37m\x1b[1m 📥 [DEBUG 01] REQUEST RECIBIDO \x1b[0m"
        );

        console.log("📦 REQUEST BODY:", req.body);
        console.log("👤 AUTH USER ID:", req.user?.id);

        const { code, current_location_id } = req.body;
        const userId = req.user.id;

        console.log("================================");
        console.log("🚚 SCAN TRANSFER DROP");
        console.log("================================");

        console.log("📥 CODE:", code);
        console.log("📍 DESTINATION LOCATION:", current_location_id);
        console.log("👤 USER:", userId);

        console.log("🔍 TIPOS DE DATOS:", {
            code: typeof code,
            current_location_id: typeof current_location_id,
            userId: typeof userId
        });

        console.log("🔍 REQUEST VALIDATION:", {
            codeExists: code !== undefined && code !== null,
            codeIsString: typeof code === "string",
            codeHasContent:
                typeof code === "string"
                    ? code.trim().length > 0
                    : false,
            destinationExists: Boolean(current_location_id),
            userExists: Boolean(userId)
        });

        // =====================================================
        // 2️⃣ VALIDAR CODE
        // =====================================================

        console.log(
            "\x1b[44m\x1b[37m 📋 [DEBUG 02] VALIDANDO CODE \x1b[0m"
        );

        if (typeof code !== "string" || !code.trim()) {

            console.log(
                "\x1b[41m\x1b[37m ❌ INVALID_CODE \x1b[0m"
            );

            console.log("🚨 VALIDATION FAILED:", {
                code,
                type: typeof code,
                reason: "Código requerido"
            });

            console.log("📤 RESPONSE STATUS: 400");

            console.log("📤 RESPONSE BODY:", {
                success: false,
                code: "INVALID_CODE",
                message: "Código requerido"
            });

            return res.status(400).json({
                success: false,
                code: "INVALID_CODE",
                message: "Código requerido"
            });
        }

        console.log("✅ CODE ORIGINAL VÁLIDO");

        const normalized = code.trim().toUpperCase();

        console.log(
            "\x1b[42m\x1b[30m ✅ [DEBUG 02] CODE NORMALIZADO \x1b[0m"
        );

        console.log({
            originalCode: code,
            normalizedCode: normalized,
            originalLength: code.length,
            normalizedLength: normalized.length,
            changed: code !== normalized
        });


        /* ======================================
           1️⃣ ¿ES UNA UBICACIÓN STORAGE?
        ====================================== */

        console.log(
            "\x1b[44m\x1b[37m\x1b[1m 📍 [DEBUG 03] BUSCANDO STORAGE LOCATION \x1b[0m"
        );

        console.log("================================");
        console.log("🔍 VALIDANDO UBICACIÓN STORAGE");
        console.log("================================");

        console.log("📍 CODE BUSCADO:", normalized);

        console.log(
            "🔧 FUNCTION:",
            "getActiveStorageLocationByCode"
        );

        console.log("🗄️ DB:", "db");

        console.log("📤 ARGUMENTOS:", {
            normalized
        });

        console.log(
            "⏳ EJECUTANDO BÚSQUEDA DE UBICACIÓN..."
        );

        const locationSearchStart = Date.now();

        const locationResult =
            await getActiveStorageLocationByCode(
                db,
                normalized
            );

        console.log(
            "⏱️ LOCATION QUERY TIME:",
            Date.now() - locationSearchStart,
            "ms"
        );

        console.log(
            "📍 LOCATION ROWCOUNT:",
            locationResult.rowCount
        );

        console.log(
            "📍 LOCATION ROWS:",
            locationResult.rows
        );

        console.log("📊 LOCATION QUERY RESULT:", {
            rowCount: locationResult.rowCount,
            found: locationResult.rowCount > 0,
            normalizedCode: normalized
        });

        console.table(locationResult.rows);

        if (locationResult.rowCount > 0) {

            const location = locationResult.rows[0];

            console.log(
                "\x1b[42m\x1b[30m\x1b[1m ✅ STORAGE LOCATION FOUND \x1b[0m"
            );

            console.log(
                "✅ STORAGE LOCATION:",
                location
            );

            console.log("📍 LOCATION DETAILS:", {
                id: location.id,
                code: location.code,
                warehouse_id: location.warehouse_id,
                location_type: location.location_type,
                is_active: location.is_active
            });

            console.log(
                "ℹ️ EL CÓDIGO FUE IDENTIFICADO COMO UBICACIÓN"
            );

            console.log(
                "ℹ️ NO SE CONTINUARÁ CON LA BÚSQUEDA DE PRODUCTOS"
            );

            console.log("📤 RESPONSE STATUS: 200");

            console.log("📤 RESPONSE BODY:", {
                success: true,
                type: "location",
                location
            });

            console.log(
                "\x1b[42m\x1b[30m ✅ SCAN TRANSFER DROP LOCATION SUCCESS \x1b[0m"
            );

            return res.json({
                success: true,
                type: "location",
                location
            });
        }

        console.log(
            "\x1b[43m\x1b[30m ⚠️ NO SE ENCONTRÓ UBICACIÓN STORAGE \x1b[0m"
        );

        console.log("🔍 RESULTADO:", {
            scannedCode: normalized,
            locationFound: false,
            nextStep: "BUSCAR PRODUCTO"
        });


        /* ======================================
           2️⃣ ¿ES UN PRODUCTO?
        ====================================== */

        console.log(
            "\x1b[44m\x1b[37m\x1b[1m 📦 [DEBUG 04] BUSCANDO PRODUCTO \x1b[0m"
        );

        console.log("================================");
        console.log("🔍 BUSCANDO PRODUCTO");
        console.log("CODE:", normalized);

        console.log("🔎 PRODUCT SEARCH FILTERS:", {
            barcode: normalized,
            sku: normalized
        });

        console.log(
            "🔎 SE BUSCARÁ POR:",
            [
                "product_barcodes.barcode",
                "products.sku"
            ]
        );

        console.log("🧾 SQL PRODUCT SEARCH:");

        console.log(`

            SELECT DISTINCT
                p.id,
                p.sku,
                p.description,
                p.uom

            FROM products p

            LEFT JOIN product_barcodes pb
                ON pb.product_sku = p.sku

            WHERE UPPER(pb.barcode) = $1
               OR UPPER(p.sku) = $1

            LIMIT 1

        `);

        console.log("📤 SQL PARAMETERS:", [
            normalized
        ]);

        console.log(
            "⏳ EJECUTANDO PRODUCT QUERY..."
        );

        const productSearchStart = Date.now();

        const productResult = await db.query(`

            SELECT DISTINCT
                p.id,
                p.sku,
                p.description,
                p.uom

            FROM products p

            LEFT JOIN product_barcodes pb
                ON pb.product_sku = p.sku

            WHERE UPPER(pb.barcode) = $1
               OR UPPER(p.sku) = $1

            LIMIT 1

        `, [normalized]);

        console.log(
            "⏱️ PRODUCT QUERY TIME:",
            Date.now() - productSearchStart,
            "ms"
        );

        console.log(
            "📦 PRODUCT ROWCOUNT:",
            productResult.rowCount
        );

        console.log(
            "📦 PRODUCT ROWS:",
            productResult.rows
        );

        console.log("📊 PRODUCT QUERY RESULT:", {
            rowCount: productResult.rowCount,
            found: productResult.rowCount > 0,
            scannedCode: normalized
        });

        console.table(productResult.rows);

        if (productResult.rowCount === 0) {

            console.log(
                "\x1b[43m\x1b[30m ⚠️ [DEBUG 04] INVALID_CODE \x1b[0m"
            );

            console.log("================================");
            console.log("🚨 CÓDIGO NO IDENTIFICADO");
            console.log("================================");

            console.log({
                scannedCode: normalized,
                locationFound: false,
                productFound: false
            });

            console.log(
                "⚠️ NO EXISTE COINCIDENCIA CON STORAGE NI PRODUCTO"
            );

            console.log("📤 RESPONSE STATUS: 200");

            console.log("📤 RESPONSE BODY:", {
                success: false,
                code: "INVALID_CODE",
                message:
                    "El código no corresponde a una ubicación ni a un producto"
            });

            return res.json({
                success: false,
                code: "INVALID_CODE",
                message:
                    "El código no corresponde a una ubicación ni a un producto"
            });

        }

        console.log(
            "\x1b[42m\x1b[30m ✅ PRODUCTO IDENTIFICADO EN DATABASE \x1b[0m"
        );

        console.log(
            "📦 PRODUCTO ENCONTRADO:",
            productResult.rows[0]
        );

        console.log(
            "⚠️ IMPORTANTE: PRODUCTO ENCONTRADO EN DATABASE"
        );

        console.log(
            "⚠️ TODAVÍA NO SE HA VALIDADO SI ESTÁ PENDIENTE EN TRANSFERENCIA"
        );


        /* ======================================
           3️⃣ VALIDAR UBICACIÓN DESTINO
        ====================================== */

        console.log(
            "\x1b[44m\x1b[37m\x1b[1m 📍 [DEBUG 05] VALIDANDO DESTINO \x1b[0m"
        );

        console.log("📍 CURRENT LOCATION ID:", current_location_id);

        console.log("📊 DESTINATION VALIDATION:", {
            current_location_id,
            exists: Boolean(current_location_id),
            type: typeof current_location_id
        });

        if (!current_location_id) {

            console.log(
                "\x1b[43m\x1b[30m ⚠️ NO_LOCATION \x1b[0m"
            );

            console.log(
                "🚨 NO EXISTE UNA UBICACIÓN DESTINO SELECCIONADA"
            );

            console.log("📤 RESPONSE STATUS: 200");

            console.log("📤 RESPONSE BODY:", {
                success: false,
                code: "NO_LOCATION",
                message:
                    "Primero escanea una ubicación de destino"
            });

            return res.json({
                success: false,
                code: "NO_LOCATION",
                message:
                    "Primero escanea una ubicación de destino"
            });

        }

        console.log(
            "✅ EXISTE CURRENT_LOCATION_ID"
        );

        const product = productResult.rows[0];

        console.log(
            "\x1b[42m\x1b[30m ✅ [DEBUG 05] PRODUCTO SELECCIONADO \x1b[0m"
        );

        console.log("📦 PRODUCT DETAILS:", {
            id: product.id,
            sku: product.sku,
            description: product.description,
            uom: product.uom
        });

        console.log("📊 DATA TYPES:", {
            productId: typeof product.id,
            productSku: typeof product.sku,
            destinationId: typeof current_location_id
        });


        /* ======================================
           4️⃣ OBTENER UBICACIÓN DESTINO
        ====================================== */

        console.log(
            "\x1b[44m\x1b[37m\x1b[1m 🏬 [DEBUG 06] OBTENIENDO DESTINATION \x1b[0m"
        );

        console.log("================================");
        console.log("🔍 BUSCANDO LOCATION POR ID");
        console.log("================================");

        console.log("📍 DESTINATION ID:", current_location_id);

        console.log("📋 EXPECTED FILTERS:", {
            id: current_location_id,
            location_type: "STORAGE",
            is_active: true
        });

        console.log("🧾 SQL DESTINATION:");

        console.log(`

            SELECT
                id,
                code,
                warehouse_id,
                location_type

            FROM locations

            WHERE id = $1
              AND location_type = 'STORAGE'
              AND is_active = true

            LIMIT 1

        `);

        console.log("📤 SQL PARAMETERS:", [
            current_location_id
        ]);

        console.log(
            "⏳ EJECUTANDO DESTINATION QUERY..."
        );

        const destinationSearchStart = Date.now();

        const destinationResult = await db.query(`

            SELECT
                id,
                code,
                warehouse_id,
                location_type

            FROM locations

            WHERE id = $1
              AND location_type = 'STORAGE'
              AND is_active = true

            LIMIT 1

        `, [current_location_id]);

        console.log(
            "⏱️ DESTINATION QUERY TIME:",
            Date.now() - destinationSearchStart,
            "ms"
        );

        console.log(
            "📍 DESTINATION ROWCOUNT:",
            destinationResult.rowCount
        );

        console.log(
            "📍 DESTINATION ROWS:",
            destinationResult.rows
        );

        console.table(destinationResult.rows);

        if (destinationResult.rowCount === 0) {

            console.log(
                "\x1b[41m\x1b[37m ❌ INVALID_STORAGE_LOCATION \x1b[0m"
            );

            console.log("🚨 DESTINATION NOT FOUND:", {
                current_location_id,
                expectedType: "STORAGE",
                expectedActive: true
            });

            console.log(
                "⚠️ POSIBLES CAUSAS:"
            );

            console.log(
                "1. La ubicación no existe."
            );

            console.log(
                "2. La ubicación no es STORAGE."
            );

            console.log(
                "3. La ubicación está inactiva."
            );

            console.log("📤 RESPONSE STATUS: 200");

            console.log("📤 RESPONSE BODY:", {
                success: false,
                code: "INVALID_STORAGE_LOCATION",
                message:
                    "La ubicación de destino no es válida"
            });

            return res.json({
                success: false,
                code: "INVALID_STORAGE_LOCATION",
                message:
                    "La ubicación de destino no es válida"
            });

        }

        console.log(
            "✅ DESTINATION LOCATION FOUND"
        );

        const destination = destinationResult.rows[0];

        console.log(
            "📍 DESTINATION DETAILS:",
            destination
        );

        const warehouseId = Number(
            destination.warehouse_id
        );

        console.log(
            "\x1b[42m\x1b[30m ✅ [DEBUG 06] DESTINATION VALIDATED \x1b[0m"
        );

        console.log("📊 DESTINATION SUMMARY:", {
            id: destination.id,
            code: destination.code,
            warehouse_id: destination.warehouse_id,
            location_type: destination.location_type,
            warehouseIdNumber: warehouseId
        });

        console.log("================================");
        console.log("🏬 DESTINATION WAREHOUSE:", warehouseId);

        console.log(
            "ℹ️ Este warehouse corresponde únicamente a la ubicación STORAGE de destino."
        );

        console.log(
            "ℹ️ El dock de origen se buscará por la sesión y por user_locations del usuario."
        );


        /* ======================================
           5️⃣ BUSCAR SESIÓN ACTIVA
        ====================================== */

        console.log(
            "\x1b[44m\x1b[37m\x1b[1m 📄 [DEBUG 07] BUSCANDO TRANSFER SESSION \x1b[0m"
        );

        console.log("================================");
        console.log("🔍 BUSCANDO SESIÓN DE TRANSFERENCIA");
        console.log("================================");

        console.log("👤 USER ID:", userId);

        console.log("📋 ACCEPTED STATUS:", [
            "open",
            "in_progress"
        ]);

        console.log(
            "🔎 ORDER: id DESC"
        );

        console.log(
            "🔎 LIMIT: 1"
        );

        console.log("🧾 SQL SESSION:");

        console.log(`

            SELECT id

            FROM transfer_sessions

            WHERE user_id = $1
              AND status IN (
                  'open',
                  'in_progress'
              )

            ORDER BY id DESC

            LIMIT 1

        `);

        console.log("📤 SQL PARAMETERS:", [
            userId
        ]);

        console.log(
            "⏳ EJECUTANDO SESSION QUERY..."
        );

        const sessionSearchStart = Date.now();

        const sessionResult = await db.query(`

            SELECT id

            FROM transfer_sessions

            WHERE user_id = $1
              AND status IN (
                  'open',
                  'in_progress'
              )

            ORDER BY id DESC

            LIMIT 1

        `, [userId]);

        console.log(
            "⏱️ SESSION QUERY TIME:",
            Date.now() - sessionSearchStart,
            "ms"
        );

        console.log(
            "📄 SESSION ROWCOUNT:",
            sessionResult.rowCount
        );

        console.log(
            "📄 SESSION ROWS:",
            sessionResult.rows
        );

        console.table(sessionResult.rows);

        if (sessionResult.rowCount === 0) {

            console.log(
                "\x1b[43m\x1b[30m ⚠️ NO_ACTIVE_TRANSFER_SESSION \x1b[0m"
            );

            console.log("🚨 SESSION SEARCH FAILED:", {
                userId,
                acceptedStatus: [
                    "open",
                    "in_progress"
                ]
            });

            console.log(
                "⚠️ NO EXISTE UNA SESIÓN ACTIVA PARA ESTE USUARIO"
            );

            console.log("📤 RESPONSE STATUS: 200");

            console.log("📤 RESPONSE BODY:", {
                success: false,
                code: "NO_ACTIVE_TRANSFER_SESSION",
                message:
                    "No existe una sesión de transferencia activa"
            });

            return res.json({
                success: false,
                code: "NO_ACTIVE_TRANSFER_SESSION",
                message:
                    "No existe una sesión de transferencia activa"
            });

        }

        console.log(
            "✅ TRANSFER SESSION FOUND"
        );

        const sessionId = sessionResult.rows[0].id;

        console.log(
            "📄 TRANSFER SESSION:",
            sessionId
        );

        console.log(
            "\x1b[42m\x1b[30m ✅ [DEBUG 07] ACTIVE SESSION IDENTIFIED \x1b[0m"
        );

        console.log("📊 SESSION DETAILS:", {
            sessionId,
            sessionIdType: typeof sessionId,
            userId,
            destinationWarehouseId: warehouseId
        });

        console.log(
            "ℹ️ ESTE SESSION ID SE UTILIZARÁ PARA FILTRAR TRANSFER_LINES"
        );


        // =====================================================
        // 6️⃣ BUSCAR PRODUCTO PENDIENTE EN DOCK REAL DEL USUARIO
        // =====================================================

        console.log(
            "\x1b[45m\x1b[37m\x1b[1m 🔍 [DEBUG 08] BUSCANDO TRANSFERENCIA PENDIENTE \x1b[0m"
        );

        console.log("================================");
        console.log("🔍 BUSCANDO TRANSFERENCIA PENDIENTE");
        console.log("================================");

        console.log("🎯 FILTROS EXACTOS:", {
            transfer_session_id: sessionId,
            product_id: product.id,
            user_id: userId,
            acceptedStatus: ["open", "partial"],
            remainingQtyGreaterThan: 0,
            dockLocationType: "PICKING",
            dockIsActive: true
        });

        console.log("📍 UBICACIÓN DESTINO (NO FILTRA EL DOCK):", {
            destinationId: destination.id,
            destinationCode: destination.code,
            destinationWarehouseId: warehouseId
        });

        console.log(
            "🔍 CRITERIO DE DOCK:",
            "JOIN user_locations ul ON ul.location_id = dock.id AND ul.user_id = " + userId
        );

        console.log("🧾 SQL PENDING QUERY:");

        console.log(`

            SELECT
                tl.id,
                tl.product_id,
                tl.from_location_id,
                tl.to_location_id,
                tl.remaining_qty,
                tl.status,
                dock.code AS dock_location_code,
                dock.warehouse_id AS dock_warehouse_id,
                dock.location_type AS dock_location_type,
                ul.user_id AS dock_user_id

            FROM transfer_lines tl

            JOIN locations dock
                ON dock.id = tl.to_location_id

            JOIN user_locations ul
                ON ul.location_id = dock.id

            WHERE tl.transfer_session_id = $1

              AND tl.product_id = $2

              AND ul.user_id = $3

              AND tl.status IN (
                  'open',
                  'partial'
              )

              AND tl.remaining_qty > 0

              AND dock.location_type = 'PICKING'

              AND dock.is_active = true

            ORDER BY tl.id

        `);

        console.log("📤 SQL PARAMETERS:", [
            sessionId,
            product.id,
            userId
        ]);

        console.log("⏳ EJECUTANDO PENDING QUERY...");

        const pendingSearchStart = Date.now();

        const pendingResult = await db.query(`

            SELECT
                tl.id,
                tl.product_id,
                tl.from_location_id,
                tl.to_location_id,
                tl.remaining_qty,
                tl.status,
                dock.code AS dock_location_code,
                dock.warehouse_id AS dock_warehouse_id,
                dock.location_type AS dock_location_type,
                ul.user_id AS dock_user_id

            FROM transfer_lines tl

            JOIN locations dock
                ON dock.id = tl.to_location_id

            JOIN user_locations ul
                ON ul.location_id = dock.id

            WHERE tl.transfer_session_id = $1

              AND tl.product_id = $2

              AND ul.user_id = $3

              AND tl.status IN (
                  'open',
                  'partial'
              )

              AND tl.remaining_qty > 0

              AND dock.location_type = 'PICKING'

              AND dock.is_active = true

            ORDER BY tl.id

        `, [
            sessionId,
            product.id,
            userId
        ]);

        console.log(
            "📦 PENDING ROWCOUNT:",
            pendingResult.rowCount
        );

        console.log(
            "📦 PENDING LINES:",
            pendingResult.rows
        );

        console.log(
            "⏱️ PENDING QUERY TIME:",
            Date.now() - pendingSearchStart,
            "ms"
        );

        console.log(
            "\x1b[44m\x1b[37m 📊 [DEBUG 08] PENDING QUERY RESULT \x1b[0m"
        );

        console.log("📊 PENDING SUMMARY:", {
            rowCount: pendingResult.rowCount,
            sessionId,
            productId: product.id,
            productSku: product.sku,
            userId,
            destinationWarehouseId: warehouseId,
            dockWarehousesFound: [
                ...new Set(
                    pendingResult.rows.map(
                        line => line.dock_warehouse_id
                    )
                )
            ]
        });

        console.table(pendingResult.rows);

        if (pendingResult.rowCount === 0) {

            console.log(
                "\x1b[43m\x1b[30m\x1b[1m ⚠️ NO_PENDING_TRANSFER \x1b[0m"
            );

            console.log("================================");
            console.log("🚨 NO SE ENCONTRARON LÍNEAS PENDIENTES");
            console.log("================================");

            console.log(
                "📋 REQUEST QUE NO ENCONTRÓ LÍNEAS:",
                {
                    code,
                    normalized,
                    current_location_id,
                    userId
                }
            );

            console.log("📦 PRODUCT IDENTIFIED:", {
                id: product.id,
                sku: product.sku,
                description: product.description
            });

            console.log("📍 DESTINATION IDENTIFIED:", {
                id: destination.id,
                code: destination.code,
                warehouse_id: destination.warehouse_id
            });

            console.log("📄 SESSION IDENTIFIED:", {
                sessionId
            });

            console.log("================================");
            console.log("⚠️ POSIBLES CAUSAS:");
            console.log("================================");

            console.log(
                "1. El producto no está en transfer_lines de esta sesión."
            );

            console.log(
                "2. El producto está en otra sesión de transferencia."
            );

            console.log(
                "3. El status de la línea no es open ni partial."
            );

            console.log(
                "4. remaining_qty es igual o menor que cero."
            );

            console.log(
                "5. La ubicación dock no está asignada al usuario en user_locations."
            );

            console.log(
                "6. La ubicación dock no es PICKING o está inactiva."
            );

            console.log(
                "7. El product_id de transfer_lines no coincide."
            );

            console.log("📤 RESPONSE STATUS: 200");

            console.log("📤 RESPONSE BODY:", {
                success: false,
                code: "NO_PENDING_TRANSFER",
                message:
                    "Este producto no tiene cantidades pendientes de transferencia en este almacén"
            });

            return res.json({
                success: false,
                code: "NO_PENDING_TRANSFER",
                message:
                    "Este producto no tiene cantidades pendientes de transferencia en este almacén"
            });

        }

        console.log(
            "\x1b[42m\x1b[30m\x1b[1m ✅ PENDING TRANSFER FOUND \x1b[0m"
        );

        console.log(
            "📦 MATCHING LINES:",
            pendingResult.rowCount
        );

        console.table(
            pendingResult.rows.map(line => ({
                id: line.id,
                product_id: line.product_id,
                from_location_id: line.from_location_id,
                to_location_id: line.to_location_id,
                dock_location_code: line.dock_location_code,
                dock_warehouse_id: line.dock_warehouse_id,
                dock_user_id: line.dock_user_id,
                remaining_qty: line.remaining_qty,
                status: line.status
            }))
        );

        console.log("🏬 COMPARACIÓN ORIGEN / DESTINO:", {
            dockWarehouses: [
                ...new Set(
                    pendingResult.rows.map(
                        line => Number(line.dock_warehouse_id)
                    )
                )
            ],
            destinationWarehouseId: warehouseId,
            destinationCode: destination.code,
            isCrossWarehouse: pendingResult.rows.some(
                line =>
                    Number(line.dock_warehouse_id) !== warehouseId
            )
        });


        /* ======================================
           7️⃣ CALCULAR CANTIDAD PENDIENTE
        ====================================== */

        console.log(
            "\x1b[44m\x1b[37m\x1b[1m 📊 [DEBUG 09] CALCULANDO CANTIDAD PENDIENTE \x1b[0m"
        );

        console.log(
            "📦 TOTAL LINES:",
            pendingResult.rows.length
        );

        console.log(
            "📊 REMAINING QTY POR LÍNEA:"
        );

        console.table(
            pendingResult.rows.map(line => ({
                lineId: line.id,
                remainingQtyOriginal: line.remaining_qty,
                remainingQtyNumber: Number(line.remaining_qty),
                status: line.status
            }))
        );

        const totalPending = pendingResult.rows.reduce(
            (total, line) =>
                total + Number(line.remaining_qty),
            0
        );

        console.log(
            "📦 TOTAL PENDING:",
            totalPending
        );

        console.log("📊 TOTAL PENDING DETAILS:", {
            productId: product.id,
            productSku: product.sku,
            sessionId,
            warehouseId,
            linesCount: pendingResult.rows.length,
            totalPending,
            isPositive: totalPending > 0,
            isFinite: Number.isFinite(totalPending)
        });

        console.log(
            "\x1b[42m\x1b[30m ✅ PENDING QTY CALCULATED \x1b[0m"
        );


        /* ======================================
           8️⃣ TODO OK
        ====================================== */

        console.log(
            "\x1b[42m\x1b[30m\x1b[1m ✅ [DEBUG 10] SUCCESS RESPONSE \x1b[0m"
        );

        console.log("================================");
        console.log("✅ TRANSFER DROP SCAN SUCCESS");
        console.log("================================");

        console.log("📦 FINAL PRODUCT:", {
            ...product,
            qty_available: totalPending,
            pending_qty: totalPending,
            to_location_id: destination.id,
            warehouse_id: warehouseId
        });

        console.log("📊 FINAL SUMMARY:", {
            scannedCode: normalized,
            userId,
            sessionId,
            productId: product.id,
            productSku: product.sku,
            destinationLocationId: destination.id,
            destinationLocationCode: destination.code,
            destinationWarehouseId: warehouseId,
            pendingQty: totalPending
        });

        console.log("📤 RESPONSE STATUS: 200");

        console.log("📤 RESPONSE BODY:", {

            success: true,

            type: "product",

            product: {

                ...product,

                qty_available: totalPending,

                pending_qty: totalPending,

                to_location_id: destination.id,

                warehouse_id: warehouseId

            }

        });

        return res.json({

            success: true,

            type: "product",

            product: {

                ...product,

                qty_available: totalPending,

                pending_qty: totalPending,

                to_location_id: destination.id,

                warehouse_id: warehouseId

            }

        });


    } catch (error) {

        // =====================================================
        // 🔴 ERROR DE SCAN TRANSFER DROP
        // =====================================================

        console.log(
            "\x1b[41m\x1b[37m\x1b[1m ❌ [DEBUG ERROR] SCAN TRANSFER DROP FAILED \x1b[0m"
        );

        console.log("================================");
        console.log("🚨 ERROR DETAILS");
        console.log("================================");

        console.log("📋 REQUEST QUE FALLÓ:", {
            body: req.body,
            userId: req.user?.id,
            endpoint: req.originalUrl || req.url
        });

        console.log(
            "🚨 ERROR TYPE:",
            error?.constructor?.name
        );

        console.log(
            "🚨 ERROR MESSAGE:",
            error?.message
        );

        console.log(
            "🚨 ERROR CODE:",
            error?.code
        );

        console.log(
            "🚨 ERROR DETAIL:",
            error?.detail
        );

        console.log(
            "🚨 ERROR HINT:",
            error?.hint
        );

        console.log(
            "🚨 ERROR TABLE:",
            error?.table
        );

        console.log(
            "🚨 ERROR COLUMN:",
            error?.column
        );

        console.log(
            "🚨 ERROR CONSTRAINT:",
            error?.constraint
        );

        console.log(
            "🚨 ERROR STACK:",
            error?.stack
        );

        console.log("📊 DB POOL STATUS:", {
            total: db.totalCount,
            idle: db.idleCount,
            waiting: db.waitingCount
        });

        console.error(
            "❌ SCAN TRANSFER DROP ERROR:",
            error
        );

        console.log("📤 RESPONSE STATUS: 500");

        console.log("📤 RESPONSE BODY:", {

            success: false,

            code: "INTERNAL_ERROR",

            message:
                "Error procesando el código de transferencia"

        });

        return res.status(500).json({

            success: false,

            code: "INTERNAL_ERROR",

            message:
                "Error procesando el código de transferencia"

        });

    }

}






// CREATE A TRANSFER LINE 
export async function createTransferLine(req, res) {
    const { productId, fromLocationId, qty } = req.body;
    const userId = req.user.id;

    const client = await db.connect();

    try {
        await client.query("BEGIN");
        console.log(" ERROR 1");
        // 1️⃣ Validar producto activo
        const product = await getActiveProductById(client, productId);
        if (!product) {
            throw new AppError(
                "PRODUCT_NOT_FOUND_OR_INACTIVE",
                "El producto no existe o está inactivo."
            );
        }


        // 2️⃣ Validar sesión activa
        const sessionResult = await client.query(`
            SELECT id
            FROM transfer_sessions
            WHERE user_id = $1
                AND status IN ('open','in_progress')
            LIMIT 1
            FOR UPDATE
            `, [userId]);

        if (sessionResult.rowCount === 0) {
            throw new AppError(
                "NO_ACTIVE_TRANSFER_SESSION",
                "No existe una sesión de transferencia activa para este usuario."
            );
        }


        const sessionId = sessionResult.rows[0].id;
        console.log("2");

        // 3️⃣ Validar ubicación origen STORAGE y obtener warehouse
        const locResult = await client.query(`
            SELECT id, location_type, warehouse_id
            FROM locations
            WHERE id = $1 AND is_active = true
            FOR UPDATE
            `, [fromLocationId]);

        if (
            locResult.rowCount === 0 ||
            !["STORAGE", "RECEIVING"].includes(
                locResult.rows[0].location_type
            )
        ) {
            throw new AppError(
                "INVALID_SOURCE_LOCATION",
                "La ubicación escaneada no es una ubicación válida de origen."
            );
        }


        const { warehouse_id } = locResult.rows[0];

        console.log("3 - warehouse desde location:", warehouse_id);


        // 4️⃣ Validar inventario disponible
        const stockResult = await client.query(`
      SELECT qty_on_hand, qty_reserved, qty_available
      FROM inventory_by_location
      WHERE product_sku = $1 AND location_id = $2
      FOR UPDATE
    `, [product.sku, fromLocationId]);

        if (
            stockResult.rowCount === 0 ||
            Number(stockResult.rows[0].qty_available) < Number(qty)
        ) {
            throw new AppError(
                "QTY_EXCEEDS_AVAILABLE",
                "La cantidad ingresada excede el inventario disponible en esta ubicación."
            );
        }

        console.log("4", userId);
        console.log("5", warehouse_id);


        // 5️⃣ Ubicación destino del usuario
       const userLocation = await getUserActiveLocation(
    client,
    userId,
    warehouse_id
);

        if (!userLocation) {
            throw new AppError(
                "USER_LOCATION_NOT_FOUND",
                "No se encontró una ubicación de destino activa para el usuario."
            );
        }


        if (userLocation.warehouse_id !== warehouse_id) {
            throw new AppError(
                "WAREHOUSE_MISMATCH",
                "La ubicación de origen y destino no pertenecen al mismo almacén."
            );
        }



        // 6️⃣ Buscar línea existente
        const existingLineResult = await client.query(`
      SELECT id, picked_qty, remaining_qty
      FROM transfer_lines
      WHERE transfer_session_id = $1
        AND product_id = $2
        AND from_location_id = $3
        AND to_location_id = $4
        AND status IN ('open','partial')
      FOR UPDATE
    `, [sessionId, productId, fromLocationId, userLocation.id]);

        if (existingLineResult.rowCount > 0) {
            const line = existingLineResult.rows[0];
            const newQty = Number(line.picked_qty) + Number(qty);

            const updateResult = await client.query(`
        UPDATE transfer_lines
        SET picked_qty = $1,
            remaining_qty = $1,
            status = 'open'
        WHERE id = $2
        RETURNING *
      `, [newQty, line.id]);


            console.log("5", warehouse_id);


            await moveInventoryBetweenLocations(client, {
                warehouseId: warehouse_id,
                productSku: product.sku,
                fromLocationId,
                toLocationId: userLocation.id,
                qty
            });
            console.log("6");

            await createInventoryMovement(client, {
                productSku: product.sku,
                fromLocationId,
                toLocationId: userLocation.id,
                qty: Number(qty),
                movementType: "MOVE",
                referenceType: "TRANSFER",
                referenceId: String(sessionId),
                createdBy: userId,
                note: `Transfer pick (update) hacia ubicación del usuario`
            });



            await client.query("COMMIT");

            return res.json({ success: true, line: updateResult.rows[0], mode: "updated" });
        }

        // 7️⃣ Crear línea nueva
        const insertResult = await client.query(`
      INSERT INTO transfer_lines
      (transfer_session_id, product_id, from_location_id, to_location_id,
       picked_qty, remaining_qty, status)
      VALUES ($1,$2,$3,$4,$5,$5,'open')
      RETURNING *
    `, [sessionId, productId, fromLocationId, userLocation.id, qty]);

        // 8️⃣ Mover inventario real
        await moveInventoryBetweenLocations(client, {
            warehouseId: warehouse_id,
            productSku: product.sku,
            fromLocationId,
            toLocationId: userLocation.id,
            qty
        });

        await createInventoryMovement(client, {
            productSku: product.sku,
            fromLocationId,
            toLocationId: userLocation.id,
            qty: Number(qty),
            movementType: "MOVE",
            referenceType: "TRANSFER",
            referenceId: String(sessionId),
            createdBy: userId,
            note: `Transfer pick hacia ubicación del usuario`
        });


        await client.query("COMMIT");

        res.json({ success: true, line: insertResult.rows[0], mode: "created" });

    } catch (err) {
        await client.query("ROLLBACK");

        if (err instanceof AppError) {
            return res.status(err.status).json({
                success: false,
                code: err.code,
                message: err.message
            });
        }

        console.error("❌ TRANSFER ERROR:", err);

        return res.status(500).json({
            success: false,
            code: "TRANSFER_ERROR",
            message: "Ocurrió un error inesperado al procesar la transferencia."
        });
    }
    finally {
        client.release();
    }
}


 // ============================================================
 // POST /transfer/drop
 // DROP TRANSFER - ACTUALIZADO
 // ============================================================

export async function dropTransfer(req, res) {

    const client = await db.connect();

    console.log("========================================");
    console.log("🚚 INICIO DROP TRANSFER");
    console.log("========================================");

    console.log("🕒 FECHA:", new Date().toISOString());

    try {

        await client.query("BEGIN");

        console.log("🟢 TRANSACCIÓN INICIADA");

        const userId = req.user.id;

        const {
            transfer_session_id,
            product_sku,
            to_location_code,
            qty
        } = req.body;

        console.log("========================================");
        console.log("📥 REQUEST DATA");
        console.log("========================================");

        console.log("👤 USER ID:", userId);
        console.log("📄 SESSION ID:", transfer_session_id);
        console.log("📦 PRODUCT SKU:", product_sku);
        console.log("📍 DESTINATION CODE:", to_location_code);
        console.log("📦 QUANTITY:", qty);


        /* ======================================
           1️⃣ VALIDAR QTY
        ====================================== */

        console.log("========================================");
        console.log("🔍 [STEP 01] VALIDAR CANTIDAD");
        console.log("========================================");

        const parsedQty = Number(qty);

        if (
            qty === null ||
            qty === undefined ||
            qty === "" ||
            !Number.isFinite(parsedQty) ||
            parsedQty <= 0
        ) {

            console.log("❌ INVALID_QTY:", qty);

            throw new AppError(
                "INVALID_QTY",
                "qty debe ser un número mayor que 0",
                400
            );
        }

        console.log("✅ CANTIDAD VÁLIDA:", parsedQty);


        /* ======================================
           2️⃣ VALIDAR SESIÓN
        ====================================== */

        console.log("========================================");
        console.log("🔍 [STEP 02] VALIDAR SESIÓN");
        console.log("========================================");

        const sessionResult = await client.query(`

            SELECT
                id,
                status,
                user_id,
                warehouse_id

            FROM transfer_sessions

            WHERE id = $1

            FOR UPDATE

        `, [
            transfer_session_id
        ]);

        console.log(
            "📄 SESSION ROWCOUNT:",
            sessionResult.rowCount
        );

        console.log(
            "📄 SESSION ROWS:",
            sessionResult.rows
        );

        if (sessionResult.rowCount === 0) {

            throw new AppError(
                "SESSION_NOT_FOUND",
                "La sesión no existe",
                404
            );
        }

        const session = sessionResult.rows[0];

        console.log("📄 SESSION:", session);

        if (
            Number(session.user_id) !== Number(userId)
        ) {

            throw new AppError(
                "SESSION_NOT_OWNED",
                "La sesión no pertenece al usuario",
                403
            );
        }

        if (
            !["open", "in_progress"].includes(
                session.status
            )
        ) {

            throw new AppError(
                "SESSION_NOT_ACTIVE",
                "La sesión no está activa"
            );
        }

        console.log("✅ SESSION ESTA ACTIVA");


        /* ======================================
           3️⃣ OBTENER USER-HAND REAL
           DESDE TRANSFER_LINES
        ====================================== */

        console.log("========================================");
        console.log("🔍 [STEP 03] BUSCAR USER-HAND REAL");
        console.log("========================================");

        console.log("🎯 SEARCH FILTERS:", {
            transfer_session_id,
            product_sku,
            userId,
            statuses: ["open", "partial"],
            location_type: "PICKING"
        });

        // IMPORTANTE:
        // No buscamos el USER-HAND utilizando
        // el warehouse de destino.
        //
        // Buscamos la ubicación donde realmente
        // está el producto recogido por el usuario.

        const userLocationResult = await client.query(`

            SELECT DISTINCT
                l.id,
                l.code,
                l.warehouse_id,
                l.location_type

            FROM transfer_lines tl

            INNER JOIN products p
                ON p.id = tl.product_id

            INNER JOIN locations l
                ON l.id = tl.to_location_id

            INNER JOIN user_locations ul
                ON ul.location_id = l.id

            WHERE tl.transfer_session_id = $1

              AND p.sku = $2

              AND ul.user_id = $3

              AND tl.status IN (
                  'open',
                  'partial'
              )

              AND tl.remaining_qty > 0

              AND l.location_type = 'PICKING'

              AND l.is_active = true

            ORDER BY l.id

        `, [
            transfer_session_id,
            product_sku,
            userId
        ]);

        console.log(
            "📍 USER-HAND ROWCOUNT:",
            userLocationResult.rowCount
        );

        console.log(
            "📍 USER-HAND ROWS:",
            userLocationResult.rows
        );

        console.table(userLocationResult.rows);

        if (userLocationResult.rowCount === 0) {

            console.log(
                "❌ USER_LOCATION_NOT_FOUND"
            );

            throw new AppError(
                "USER_LOCATION_NOT_FOUND",
                "No se encontró una ubicación PICKING con cantidades pendientes para este producto y usuario.",
                404
            );
        }

        if (userLocationResult.rowCount > 1) {

            console.log(
                "⚠️ MULTIPLE_USER_LOCATIONS"
            );

            console.table(userLocationResult.rows);

            throw new AppError(
                "MULTIPLE_USER_LOCATIONS",
                "El producto tiene cantidades pendientes en varias ubicaciones PICKING.",
                409
            );
        }

        const userLocation = userLocationResult.rows[0];

        const userLocationId = Number(
            userLocation.id
        );

        const sourceWarehouseId = Number(
            userLocation.warehouse_id
        );

        console.log("========================================");
        console.log("✅ USER-HAND REAL IDENTIFICADO");
        console.log("========================================");

        console.log("📍 USER LOCATION:", userLocation);
        console.log("📍 USER LOCATION ID:", userLocationId);
        console.log("🏬 SOURCE WAREHOUSE:", sourceWarehouseId);

        if (
            !Number.isInteger(userLocationId) ||
            userLocationId <= 0 ||
            !Number.isInteger(sourceWarehouseId) ||
            sourceWarehouseId <= 0
        ) {

            throw new AppError(
                "INVALID_SOURCE_LOCATION",
                "La ubicación o el almacén de origen no es válido.",
                400
            );
        }


        /* ======================================
           4️⃣ VALIDAR UBICACIÓN DESTINO STORAGE
        ====================================== */

        console.log("========================================");
        console.log("🔍 [STEP 04] VALIDAR DESTINO");
        console.log("========================================");

        console.log(
            "📍 DESTINATION CODE:",
            to_location_code
        );

        const locationResult =
            await getActiveLocationByCodeAndType(
                client,
                to_location_code,
                "STORAGE"
            );

        console.log(
            "📍 DESTINATION ROWCOUNT:",
            locationResult.rowCount
        );

        console.log(
            "📍 DESTINATION ROWS:",
            locationResult.rows
        );

        if (locationResult.rowCount === 0) {

            throw new AppError(
                "INVALID_STORAGE_LOCATION",
                "Ubicación destino inválida"
            );
        }

        const toLocation = locationResult.rows[0];

        console.log(
            "✅ SE OBTUVO UBICACIÓN DESTINO:",
            toLocation
        );

        const destinationWarehouseId = Number(
            toLocation.warehouse_id
        );

        console.log("========================================");
        console.log("🏬 COMPARACIÓN DE ALMACENES");
        console.log("========================================");

        console.log({
            sourceWarehouseId,
            destinationWarehouseId,
            fromLocationId: userLocationId,
            toLocationId: Number(toLocation.id),
            isCrossWarehouse:
                sourceWarehouseId !== destinationWarehouseId
        });


        /* ======================================
           5️⃣ RESOLVER PRODUCTO POR SKU
        ====================================== */

        console.log("========================================");
        console.log("🔍 [STEP 05] BUSCAR PRODUCTO");
        console.log("========================================");

        console.log("📦 PRODUCT SKU:", product_sku);

        const product = await getActiveProductBySku(
            client,
            product_sku
        );

        if (!product) {

            throw new AppError(
                "PRODUCT_NOT_FOUND",
                "Producto no existe o no está activo",
                404
            );
        }

        const productId = Number(product.id);

        console.log(
            "✅ SE OBTUVO EL PRODUCTO:",
            product
        );

        console.log("📦 PRODUCT ID:", productId);


        /* ======================================
           6️⃣ TRAER LÍNEAS DISPONIBLES EN MANO
        ====================================== */

        console.log("========================================");
        console.log("🔍 [STEP 06] BUSCAR TRANSFER_LINES");
        console.log("========================================");

        console.log("🎯 FILTERS:", {
            transfer_session_id,
            productId,
            userLocationId,
            status: ["open", "partial"]
        });

        const linesResult = await client.query(`

            SELECT
                tl.id,
                tl.transfer_session_id,
                tl.product_id,
                tl.from_location_id,
                tl.to_location_id,
                tl.picked_qty,
                tl.remaining_qty,
                tl.status

            FROM transfer_lines tl

            WHERE tl.transfer_session_id = $1

              AND tl.product_id = $2

              AND tl.to_location_id = $3

              AND tl.status IN (
                  'open',
                  'partial'
              )

            ORDER BY tl.id

            FOR UPDATE

        `, [
            transfer_session_id,
            productId,
            userLocationId
        ]);

        console.log(
            "📦 LINES ROWCOUNT:",
            linesResult.rowCount
        );

        console.log(
            "📦 LINES ROWS:",
            linesResult.rows
        );

        console.table(linesResult.rows);

        if (linesResult.rowCount === 0) {

            throw new AppError(
                "NO_LINES_IN_USER_LOCATION",
                "No hay líneas disponibles de este producto en la ubicación del usuario"
            );
        }

        const availableLines = linesResult.rows;

        console.log(
            "✅ TRANSFER LINES ENCONTRADAS:",
            availableLines.length
        );


        /* ======================================
           7️⃣ VALIDAR TOTAL PENDIENTE
        ====================================== */

        console.log("========================================");
        console.log("🔍 [STEP 07] VALIDAR PENDIENTES");
        console.log("========================================");

        const totalRemaining = availableLines.reduce(
            (sum, l) =>
                sum + Number(l.remaining_qty),
            0
        );

        console.log("📦 TOTAL PENDING:", totalRemaining);
        console.log("📦 REQUEST QTY:", parsedQty);

        if (parsedQty > totalRemaining) {

            console.log(
                "❌ QTY_EXCEEDS_PENDING_IN_HAND"
            );

            throw new AppError(
                "QTY_EXCEEDS_PENDING_IN_HAND",
                "Cantidad mayor que el total pendiente en la ubicación del usuario"
            );
        }

        console.log(
            "✅ CANTIDAD PENDIENTE VALIDADA"
        );


        /* ======================================
           8️⃣ CONSUMIR CANTIDADES
           Y CREAR TRANSFER_DROP_LINES
        ====================================== */

        console.log("========================================");
        console.log("🔍 [STEP 08] PROCESAR TRANSFER_LINES");
        console.log("========================================");

        let qtyToMove = parsedQty;

        for (const line of availableLines) {

            if (qtyToMove <= 0) break;

            const currentRemaining = Number(
                line.remaining_qty
            );

            if (currentRemaining <= 0) continue;

            const take = Math.min(
                currentRemaining,
                qtyToMove
            );

            const newRemaining =
                currentRemaining - take;

            const newStatus =
                newRemaining === 0
                    ? "completed"
                    : "partial";

            console.log("========================================");
            console.log("📦 PROCESSING LINE:", line.id);
            console.log("========================================");

            console.log({
                currentRemaining,
                qtyToMove,
                take,
                newRemaining,
                newStatus
            });

            // ======================================
            // ACTUALIZAR TRANSFER_LINES
            // ======================================

            await client.query(`

                UPDATE transfer_lines

                SET
                    remaining_qty = $1,
                    status = $2

                WHERE id = $3

            `, [
                newRemaining,
                newStatus,
                line.id
            ]);

            console.log(
                "✅ TRANSFER_LINE UPDATED:",
                line.id
            );

            // ======================================
            // CREAR TRAZABILIDAD
            // ======================================

            await client.query(`

                INSERT INTO transfer_drop_lines
                (
                    transfer_session_id,
                    transfer_line_id,
                    product_id,
                    from_location_id,
                    to_location_id,
                    qty_moved,
                    status,
                    created_by_user_id
                )

                VALUES
                (
                    $1,
                    $2,
                    $3,
                    $4,
                    $5,
                    $6,
                    'confirmed',
                    $7
                )

            `, [
                transfer_session_id,
                line.id,
                productId,
                userLocationId,
                toLocation.id,
                take,
                userId
            ]);

            console.log(
                "✅ TRANSFER_DROP_LINE INSERTADA"
            );

            qtyToMove -= take;

            console.log(
                "📊 QTY TO MOVE REMAINING:",
                qtyToMove
            );
        }

        if (qtyToMove > 0) {

            throw new AppError(
                "QTY_NOT_FULFILLED",
                "No se pudo completar la cantidad solicitada"
            );
        }

        console.log(
            "✅ TODAS LAS LÍNEAS PROCESADAS"
        );


        /* ======================================
           9️⃣ MOVER INVENTARIO REAL
        ====================================== */

        console.log("========================================");
        console.log("🚚 [STEP 09] MOVE INVENTORY");
        console.log("========================================");

        console.log("📦 MOVEMENT:", {
            productSku: product.sku,
            sourceWarehouseId,
            destinationWarehouseId,
            fromLocationId: userLocationId,
            toLocationId: Number(toLocation.id),
            qty: parsedQty
        });

        // IMPORTANTE:
        // warehouseId debe ser el almacén del origen.
        // El servicio obtiene el destino por toLocationId.

        await moveInventoryBetweenLocations(
            client,
            {
                warehouseId: sourceWarehouseId,

                productSku: product.sku,

                fromLocationId: userLocationId,

                toLocationId: Number(toLocation.id),

                qty: parsedQty
            }
        );

        console.log(
            "✅ INVENTARIO MOVIDO CORRECTAMENTE"
        );


        /* ======================================
           🔟 REGISTRAR MOVIMIENTO HISTÓRICO
        ====================================== */

        console.log("========================================");
        console.log("🧾 [STEP 10] INVENTORY MOVEMENT");
        console.log("========================================");

        await createInventoryMovement(
            client,
            {
                productSku: product.sku,

                fromLocationId: userLocationId,

                toLocationId: Number(toLocation.id),

                qty: parsedQty,

                movementType: "MOVE",

                referenceType: "TRANSFER",

                referenceId: String(
                    transfer_session_id
                ),

                createdBy: userId,

                note:
                    `Transfer drop a ubicación ${toLocation.code}`
            }
        );

        console.log(
            "✅ INVENTORY MOVEMENT REGISTRADO"
        );


        /* ======================================
           1️⃣1️⃣ CERRAR SESIÓN SI NO HAY PENDIENTES
        ====================================== */

        console.log("========================================");
        console.log("📄 [STEP 11] VALIDAR CIERRE");
        console.log("========================================");

        const sessionUpdateResult = await client.query(`

            UPDATE transfer_sessions

            SET
                status = 'completed',
                completed_at = now(),
                updated_at = now()

            WHERE id = $1

              AND NOT EXISTS (
                  SELECT 1

                  FROM transfer_lines

                  WHERE transfer_session_id = $1

                    AND status IN (
                        'open',
                        'partial'
                    )
              )

        `, [
            transfer_session_id
        ]);

        if (sessionUpdateResult.rowCount > 0) {

            console.log(
                "✅ TRANSFER SESSION COMPLETED"
            );

        } else {

            console.log(
                "📦 TRANSFER SESSION TODAVÍA TIENE PENDIENTES"
            );
        }


        /* ======================================
           1️⃣2️⃣ COMMIT
        ====================================== */

        console.log("========================================");
        console.log("💾 [STEP 12] COMMIT");
        console.log("========================================");

        await client.query("COMMIT");

        console.log(
            "✅ COMMIT COMPLETADO"
        );

        console.log("========================================");
        console.log("✅ TRANSFER DROP SUCCESS");
        console.log("========================================");


        /* ======================================
           1️⃣3️⃣ RESPUESTA
        ====================================== */

        return res.status(200).json({

            success: true,

            message: "Transfer drop confirmado",

            data: {

                session_id: transfer_session_id,

                user_location_id: userLocationId,

                to_location: toLocation,

                product: {
                    id: productId,
                    sku: product.sku
                },

                qty: parsedQty

            }

        });


    } catch (error) {

        console.log("========================================");
        console.log("❌ TRANSFER DROP ERROR");
        console.log("========================================");

        console.log("🚨 ERROR CODE:", error?.code);
        console.log("🚨 ERROR MESSAGE:", error?.message);
        console.log("🚨 ERROR DETAIL:", error?.detail);
        console.log("🚨 ERROR STACK:", error?.stack);

        try {

            await client.query("ROLLBACK");

            console.log(
                "↩️ ROLLBACK COMPLETADO"
            );

        } catch (rollbackError) {

            console.error(
                "❌ ROLLBACK ERROR:",
                rollbackError
            );
        }

        if (error instanceof AppError) {

            return res.status(error.status).json({
                success: false,
                code: error.code,
                message: error.message
            });
        }

        console.error(
            "❌ TRANSFER DROP ERROR:",
            error
        );

        return res.status(500).json({
            success: false,
            code: "SERVER_ERROR",
            message: "Error interno"
        });

    } finally {

        client.release();

        console.log(
            "🔓 DATABASE CLIENT RELEASED"
        );

    }

}
