
// ============================================================
// FILE: integrations/admcloud/
// admcloud.inspection.lines.controller.js
// ============================================================

import db from "../db.js";

import {
    getAdmCloudDispatchService
} from "../integrations/admcloud/admcloud.conduce.js";

import {
    getAdmCloudCreditInvoiceById
} from "../integrations/admcloud/admcloud_inspeccion.js";






// ============================================================
// NORMALIZAR CODIGO
// ============================================================

function normalizeCode(value) {

    return String(value ?? "")
        .replace(/[\r\n]/g, "")
        .trim();

}


// ============================================================
// BUSCAR CODIGO ESCANEADO
//
// POST /api/inspection/scan
//
// BODY:
// {
//     "code": "SKU-00001"
// }
//
// ORDEN:
//
// 1. products.sku
// 2. product_barcodes.barcode
// 3. products.erp_sku
// ============================================================

export async function resolveInspectionScanController(req, res) {

    const scannedCode = normalizeCode(
        req.body?.code
    );

    console.log("");
    console.log("🟪 ========================================");
    console.log("📡 INSPECCION - CODIGO ESCANEADO");
    console.log("📡 CODIGO:", scannedCode);
    console.log("🟪 ========================================");


    // ========================================================
    // 1. VALIDAR CODIGO
    // ========================================================

    if (
        !scannedCode ||
        scannedCode.length > 128
    ) {

        return res.status(400).json({

            success: false,
            code: "INVALID_CODE",

            message:
                "Debe enviar un código válido (máximo 128 caracteres)."

        });

    }


    try {

        // ====================================================
        // 2. BUSCAR DIRECTAMENTE EN products.sku
        // ====================================================

        const bySku = await db.query(

            `
                SELECT

                    p.id,
                    p.sku,
                    p.erp_sku,
                    p.erp_name,
                    p.description

                FROM products p

                WHERE UPPER(BTRIM(p.sku)) = UPPER($1)

                LIMIT 2
            `,

            [scannedCode]

        );


        // ====================================================
        // 3. VALIDAR SKU AMBIGUO
        // ====================================================

        if (bySku.rows.length > 1) {

            return res.status(409).json({

                success: false,
                code: "AMBIGUOUS_CODE",

                message:
                    "El código coincide con varios productos. Revise sus SKU."

            });

        }


        let product =
            bySku.rows[0] ?? null;

        let source =
            "products.sku";


        console.log(
            "🔍 RESULTADOS products.sku:",
            bySku.rows.length
        );


        // ====================================================
        // 4. SI NO EXISTE, BUSCAR BARCODE
        // ====================================================

        if (!product) {

            console.log(
                "🔍 BUSCANDO EN product_barcodes.barcode..."
            );

            const byBarcode = await db.query(

                `
                    SELECT DISTINCT ON (p.sku)

                        p.id,
                        p.sku,
                        p.erp_sku,
                        p.erp_name,
                        p.description

                    FROM product_barcodes pb

                    INNER JOIN products p
                        ON p.sku = pb.product_sku

                    WHERE UPPER(BTRIM(pb.barcode)) = UPPER($1)

                    ORDER BY

                        p.sku,

                        pb.is_primary DESC NULLS LAST,

                        pb.id ASC

                    LIMIT 2
                `,

                [scannedCode]

            );


            // ================================================
            // VALIDAR CODIGO DE BARRAS AMBIGUO
            // ================================================

            if (byBarcode.rows.length > 1) {

                return res.status(409).json({

                    success: false,

                    code: "AMBIGUOUS_BARCODE",

                    message:
                        "El código de barras está asociado con varios productos."

                });

            }


            product =
                byBarcode.rows[0] ?? null;

            source =
                "product_barcodes.barcode";


            console.log(
                "🔍 RESULTADOS product_barcodes:",
                byBarcode.rows.length
            );

        }


        // ====================================================
        // 5. NO EXISTE EN NINGUNA TABLA
        // ====================================================

        if (!product) {

            console.log(
                "❌ CODIGO NO ENCONTRADO:",
                scannedCode
            );

            return res.status(200).json({

                success: false,

                code: "NOT_FOUND",

                message:
                    `No se encontró el código ${scannedCode} ` +
                    "en productos ni códigos de barras."

            });

        }


        // ====================================================
        // 6. OBTENER ERP SKU
        // ====================================================

        const erpSku = String(
            product.erp_sku ?? ""
        ).trim();


        if (!erpSku) {

            return res.status(200).json({

                success: false,

                code: "ERP_SKU_MISSING",

                message:
                    `El producto ${product.sku} existe, ` +
                    "pero no tiene erp_sku configurado."

            });

        }


        // ====================================================
        // 7. LOG DE PRODUCTO ENCONTRADO
        // ====================================================

        console.log("");
        console.log("🟩 ========================================");
        console.log("✅ PRODUCTO ENCONTRADO");
        console.log("🔎 ENCONTRADO EN:", source);
        console.log("📦 SKU WMS:", product.sku);
        console.log("📦 ERP SKU:", erpSku);
        console.log("📦 DESCRIPCION:", product.description);
        console.log("🟩 ========================================");


        // ====================================================
        // 8. RESPONDER AL FRONTEND
        // ====================================================

        return res.status(200).json({

            success: true,

            type: "product",

            source,

            data: {

                id:
                    String(product.id),

                sku:
                    product.sku,

                erp_sku:
                    erpSku,

                erp_name:
                    product.erp_name ?? null,

                description:
                    product.description ?? null

            }

        });

    } catch (error) {

        console.error("");
        console.error("🟥 ========================================");
        console.error("❌ ERROR VALIDANDO PRODUCTO ESCANEADO");
        console.error(error);
        console.error("🟥 ========================================");

        return res.status(500).json({

            success: false,

            code: "SCAN_ERROR",

            message:
                "No se pudo validar el código escaneado."

        });

    }

}





export async function updateInspectionLineQuantity(req, res) {

    // ========================================================
    // 1. OBTENER PARÁMETROS
    // ========================================================

    const documentType = String(
        req.params.tipo ?? ""
    )
        .trim()
        .toUpperCase();

    const documentGuid = String(
        req.params.guid ?? ""
    )
        .trim()
        .toLowerCase();

    const lineId = String(
        req.params.lineId ?? ""
    ).trim();


    // ========================================================
    // 2. OBTENER BODY
    // ========================================================

    const scannedCode = String(
        req.body?.scanned_code ?? ""
    )
        .trim()
        .toUpperCase();

    const quantity = String(
        req.body?.inspected_quantity ?? ""
    ).trim();


    console.log("");
    console.log("🟪 ========================================");
    console.log("📦 CONFIRMANDO LÍNEA DE INSPECCIÓN");
    console.log("📄 TIPO:", documentType);
    console.log("🆔 GUID:", documentGuid);
    console.log("🆔 LINE ID:", lineId);
    console.log("📡 ERP SKU:", scannedCode);
    console.log("🔢 CANTIDAD:", quantity);
    console.log("🟪 ========================================");


    // ========================================================
    // 3. VALIDAR TIPO DOCUMENTO
    // ========================================================

    if (!["CONDUCE", "FACTURA"].includes(documentType)) {

        return res.status(400).json({
            success: false,
            message:
                "El tipo de documento debe ser CONDUCE o FACTURA."
        });

    }


    // ========================================================
    // 4. VALIDAR GUID Y LINE ID
    // ========================================================

    if (
        !UUID_PATTERN.test(documentGuid) ||
        !/^[1-9]\d*$/.test(lineId)
    ) {

        return res.status(400).json({
            success: false,
            message:
                "El GUID del documento o ID de línea es inválido."
        });

    }


    // ========================================================
    // 5. VALIDAR PRODUCTO
    // ========================================================

    if (!scannedCode) {

        return res.status(400).json({
            success: false,
            message:
                "Debe escanear y confirmar el producto antes de guardar."
        });

    }


    // ========================================================
    // 6. VALIDAR CANTIDAD
    // ========================================================

    if (
        !/^\d+(?:\.\d{1,4})?$/.test(quantity) ||
        Number(quantity) > 99999999999999
    ) {

        return res.status(400).json({
            success: false,
            message:
                "La cantidad debe ser mayor o igual a cero y tener máximo 4 decimales."
        });

    }


    // ========================================================
    // 7. USUARIO AUTENTICADO
    // ========================================================

    const userIdCandidate =
        req.user?.id ??
        req.userId ??
        null;

    const inspectedBy =
        userIdCandidate != null &&
        /^\d+$/.test(String(userIdCandidate))
            ? String(userIdCandidate)
            : null;


    // ========================================================
    // 8. INICIAR TRANSACCIÓN
    // ========================================================

    let client = null;
    let transactionStarted = false;

    try {

        client = await db.connect();

        await client.query("BEGIN");

        transactionStarted = true;


        // ====================================================
        // 9. BLOQUEAR DOCUMENTO
        //
        // MISMO BLOQUEO UTILIZADO EN LA SINCRONIZACIÓN.
        // EVITA ACTUALIZACIONES SIMULTÁNEAS DEL DOCUMENTO.
        // ====================================================

        await client.query(
            `
                SELECT pg_advisory_xact_lock(
                    hashtext('erp_inspection_lines'),
                    hashtext($1::text)
                )
            `,
            [
                `${documentType}:${documentGuid}`
            ]
        );


        // ====================================================
        // 10. ACTUALIZAR CANTIDAD INSPECCIONADA
        // ====================================================

        const result = await client.query(
            `
                UPDATE erp_inspection_lines

                SET

                    inspected_quantity = $1::numeric,

                    inspected_by = COALESCE(
                        $2::bigint,
                        inspected_by
                    ),

                    inspected_at = NOW(),

                    updated_at = NOW()

                WHERE id = $3::bigint

                  AND document_type = $4

                  AND erp_document_id = $5::uuid

                  AND UPPER(
                      BTRIM(
                          COALESCE(erp_item_sku, '')
                      )
                  ) = $6

                RETURNING

                    id::text AS id,

                    erp_line_id,

                    erp_item_id,

                    COALESCE(
                        erp_item_sku,
                        ''
                    ) AS sku,

                    COALESCE(
                        erp_item_name,
                        ''
                    ) AS description,

                    erp_quantity::text AS quantity,

                    completed_quantity::text
                        AS completed_quantity,

                    inspected_quantity::text
                        AS inspected_quantity,

                    inspection_status,

                    erp_uom_name,

                    erp_row_order
            `,
            [
                quantity,
                inspectedBy,
                lineId,
                documentType,
                documentGuid,
                scannedCode
            ]
        );


        // ====================================================
        // 11. VALIDAR ACTUALIZACIÓN
        // ====================================================

        if (result.rowCount !== 1) {

            const error = new Error(
                "El producto escaneado no corresponde " +
                "a la línea seleccionada o la línea " +
                "no pertenece a este documento."
            );

            error.httpStatus = 409;

            throw error;

        }


        // ====================================================
        // 12. NUEVO - RECALCULAR ESTADO DEL DOCUMENTO
        //
        // REVISA TODAS LAS LÍNEAS:
        //
        // - PENDIENTE
        // - APROBADO
        // - RECHAZADO
        //
        // ACTUALIZA erp_dispatches O erp_invoices.
        // ====================================================

        const statusSummary =
            await recalculateInspectionDocumentStatus(
                client,
                documentType,
                documentGuid
            );


        // ====================================================
        // 13. PREPARAR LÍNEA PARA FRONTEND
        // ====================================================

        const row = result.rows[0];

        const line = {

            ...row,

            quantity:
                Number(row.quantity),

            completed_quantity:
                Number(row.completed_quantity),

            inspected_quantity:
                Number(row.inspected_quantity)

        };


        // ====================================================
        // 14. CONFIRMAR TRANSACCIÓN
        // ====================================================

        await client.query("COMMIT");

        transactionStarted = false;


        // ====================================================
        // 15. LOG FINAL
        // ====================================================

        console.log("");
        console.log("🟩 ========================================");
        console.log("✅ INSPECCIÓN GUARDADA CORRECTAMENTE");
        console.log("📄 DOCUMENTO:", documentGuid);
        console.log("📦 SKU:", line.sku);

        console.log(
            "🔢 CANTIDAD DOCUMENTO:",
            line.quantity
        );

        console.log(
            "✅ CANTIDAD INSPECCIONADA:",
            line.inspected_quantity
        );

        console.log(
            "🏷️ ESTADO DEL DOCUMENTO:",
            statusSummary.inspection_status
        );

        console.log(
            "👤 USUARIO:",
            inspectedBy
        );

        console.log("🟩 ========================================");


        // ====================================================
        // 16. RESPONDER AL FRONTEND
        // ====================================================

        return res.status(200).json({

            success: true,

            message:
                "Cantidad inspeccionada guardada correctamente.",

            line,

            inspection_status:
                statusSummary.inspection_status,

            inspection_summary:
                statusSummary

        });


    } catch (error) {

        // ====================================================
        // 17. ROLLBACK SI OCURRE UN ERROR
        // ====================================================

        if (client && transactionStarted) {

            try {

                await client.query("ROLLBACK");

                console.log(
                    "↩️ TRANSACCIÓN REVERTIDA"
                );

            } catch (rollbackError) {

                console.error(
                    "❌ ERROR AL REVERTIR TRANSACCIÓN:",
                    rollbackError
                );

            }

        }


        console.error(
            "🟥 ERROR GUARDANDO INSPECCIÓN:",
            error
        );


        const status =
            [404, 409].includes(error.httpStatus)
                ? error.httpStatus
                : 500;


        return res.status(status).json({

            success: false,

            message:
                status === 500
                    ? "No se pudo guardar la cantidad ni actualizar el estado de inspección."
                    : error.message

        });


    } finally {

        // ====================================================
        // 18. LIBERAR CONEXIÓN
        // ====================================================

        if (client) {
            client.release();
        }

    }

}








async function recalculateInspectionDocumentStatus(
    client,
    documentType,
    documentGuid
) {

    // ========================================================
    // 1. REVISAR TODAS LAS LÍNEAS DEL DOCUMENTO
    // ========================================================

    const summaryResult = await client.query(
        `
            SELECT

                COUNT(*)::integer AS total_lines,

                COUNT(*) FILTER (
                    WHERE COALESCE(inspected_quantity, 0) = 0
                )::integer AS zero_lines,

                COUNT(*) FILTER (
                    WHERE erp_quantity IS NOT NULL
                      AND inspected_quantity IS NOT NULL
                      AND erp_quantity = inspected_quantity
                )::integer AS matching_lines

            FROM erp_inspection_lines

            WHERE document_type = $1
              AND erp_document_id = $2::uuid
        `,
        [
            documentType,
            documentGuid
        ]
    );


    const summary = summaryResult.rows[0];

    const totalLines = Number(summary.total_lines);
    const zeroLines = Number(summary.zero_lines);
    const matchingLines = Number(summary.matching_lines);


    // ========================================================
    // 2. DETERMINAR ESTADO
    // ========================================================

    let inspectionStatus;


    if (
        totalLines === 0 ||
        zeroLines === totalLines
    ) {

        inspectionStatus = "PENDIENTE";

    } else if (matchingLines === totalLines) {

        inspectionStatus = "APROBADO";

    } else {

        inspectionStatus = "RECHAZADO";

    }


    // ========================================================
    // 3. SELECCIONAR TABLA CORRECTA
    // ========================================================

    const headerTable =
        documentType === "CONDUCE"
            ? "erp_dispatches"
            : "erp_invoices";


    // ========================================================
    // 4. ACTUALIZAR ESTADO DEL ENCABEZADO
    // ========================================================

    const headerResult = await client.query(
        `
            UPDATE ${headerTable}

            SET

                inspection_status = $1,

                updated_at = NOW()

            WHERE erp_id = $2::uuid

            RETURNING
                erp_id,
                inspection_status
        `,
        [
            inspectionStatus,
            documentGuid
        ]
    );


    if (headerResult.rowCount !== 1) {

        const error = new Error(
            `No existe el encabezado del ${documentType} ` +
            `${documentGuid} en ${headerTable}.`
        );

        error.httpStatus = 404;

        throw error;

    }


    // ========================================================
    // 5. LOG DEL ESTADO
    // ========================================================

    console.log("");
    console.log("🟦 ========================================");
    console.log("📋 ESTADO GLOBAL DE INSPECCIÓN");
    console.log("📄 DOCUMENTO:", documentGuid);
    console.log("📦 TOTAL LÍNEAS:", totalLines);
    console.log("⚪ LÍNEAS EN CERO:", zeroLines);
    console.log("✅ LÍNEAS CORRECTAS:", matchingLines);
    console.log("🏷️ ESTADO:", inspectionStatus);
    console.log("🟦 ========================================");


    // ========================================================
    // 6. DEVOLVER RESUMEN
    // ========================================================

    return {

        inspection_status: inspectionStatus,

        total_lines: totalLines,

        zero_lines: zeroLines,

        matching_lines: matchingLines,

        difference_lines:
            totalLines - matchingLines

    };

}

// ============================================================
// CONFIGURACIÓN
// ============================================================

const showconsolelogdetails = true;

const BATCH_SIZE = 250;

const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


// ============================================================
// CONSOLE LOG - FONDO MORADO
// ============================================================

const PURPLE_BG = "\x1b[48;2;235;218;255m";
const PURPLE_TEXT = "\x1b[38;2;68;30;96m";
const RESET_COLOR = "\x1b[0m";

function logDetails(...args) {

    if (!showconsolelogdetails) {
        return;
    }

    console.log(
        `${PURPLE_BG}${PURPLE_TEXT}`,
        "🟪 [INSPECCIÓN]",
        ...args,
        RESET_COLOR
    );

}


// ============================================================
// VALIDAR TIPO DOCUMENTO
// ============================================================

function normalizeDocumentType(value) {

    const type = String(value ?? "")
        .trim()
        .toUpperCase();

    if (type === "CONDUCE" || type === "FACTURA") {
        return type;
    }

    return null;

}


// ============================================================
// VALIDAR UUID OBLIGATORIO
// ============================================================

function requireUuid(value, field) {

    if (
        typeof value !== "string" ||
        !UUID_PATTERN.test(value.trim())
    ) {

        throw new Error(
            `${field} debe ser un GUID válido.`
        );

    }

    return value.trim().toLowerCase();

}


// ============================================================
// VALIDAR UUID OPCIONAL
// ============================================================

function optionalUuid(value, field) {

    if (
        value == null ||
        value === "" ||
        value === "00000000-0000-0000-0000-000000000000"
    ) {
        return null;
    }

    return requireUuid(String(value), field);

}


// ============================================================
// CONVERTIR CANTIDADES
// ============================================================

function numericValue(
    value,
    field,
    defaultValue = null
) {

    if (value == null || value === "") {
        return defaultValue;
    }

    const number = Number(value);

    if (!Number.isFinite(number)) {

        throw new Error(
            `${field} no contiene un número válido: ${value}`
        );

    }

    return number;

}


// ============================================================
// CONVERTIR ENTEROS
// ============================================================

function integerValue(value, field) {

    const number = numericValue(
        value,
        field,
        null
    );

    if (number === null) {
        return null;
    }

    if (!Number.isSafeInteger(number)) {

        throw new Error(
            `${field} debe ser un entero válido.`
        );

    }

    return number;

}


// ============================================================
// CONVERTIR FECHAS
// ============================================================

function dateValue(value, field) {

    if (value == null || value === "") {
        return null;
    }

    const date = String(value).slice(0, 10);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {

        throw new Error(
            `${field} contiene una fecha inválida.`
        );

    }

    return date;

}


// ============================================================
// EXTRAER EL DOCUMENTO DE LA RESPUESTA ADM CLOUD
//
// ADM CLOUD PUEDE DEVOLVER:
//
// {
//     success: true,
//     data: {
//         ID: "...",
//         Items: [...]
//     }
// }
//
// O DIRECTAMENTE:
//
// {
//     ID: "...",
//     Items: [...]
// }
// ============================================================

function unwrapDocument(serviceResult) {

    if (serviceResult?.success === false) {

        throw new Error(
            serviceResult.message ||
            "Adm Cloud devolvió success=false."
        );

    }

    let document = serviceResult;

    for (let depth = 0; depth < 4; depth++) {

        if (
            document &&
            typeof document === "object" &&
            !Array.isArray(document)
        ) {

            if (
                Array.isArray(document.Items) ||
                Array.isArray(document.items)
            ) {

                return document;

            }

            if (
                document.data &&
                typeof document.data === "object"
            ) {

                document = document.data;

                continue;

            }

        }

        break;

    }

    throw new Error(
        "No se encontró el arreglo Items en la respuesta " +
        "del documento de Adm Cloud."
    );

}


// ============================================================
// MAPEAR LÍNEA ADM CLOUD A POSTGRESQL
// ============================================================

function mapInspectionLine(
    item,
    documentType,
    documentGuid
) {

    // ========================================================
    // 1. IDENTIFICADORES
    // ========================================================

    const lineId = requireUuid(
        item?.ID,
        "Items[].ID"
    );

    const productId = requireUuid(
        item?.ItemID,
        `Item ${lineId}: ItemID`
    );

    // ========================================================
    // 2. VALIDAR QUANTITY
    // ========================================================

    if (item.Quantity == null) {

        throw new Error(
            `La línea ${lineId} no tiene Quantity.`
        );

    }

    // ========================================================
    // 3. MAPEAR CAMPOS
    // ========================================================

    return {

        document_type:
            documentType,

        erp_document_id:
            documentGuid,

        erp_line_id:
            lineId,

        erp_trans_id:
            optionalUuid(item.TransID, "TransID"),

        erp_row_order:
            integerValue(item.RowOrder, "RowOrder"),

        erp_item_id:
            productId,

        erp_item_sku:
            item.ItemSKU ?? null,

        erp_item_name:
            item.Name ?? null,

        // Quantity de Adm Cloud

        erp_quantity:
            numericValue(
                item.Quantity,
                "Quantity"
            ),

        // CompletedQuantity de Adm Cloud

        completed_quantity:
            numericValue(
                item.CompletedQuantity,
                "CompletedQuantity",
                0
            ),

        erp_uom_id:
            optionalUuid(item.UOMID, "UOMID"),

        erp_uom_name:
            item.UOMName ?? null,

        erp_uom_factor:
            numericValue(
                item.UOMFactor,
                "UOMFactor",
                null
            ),

        erp_source_transaction_id:
            optionalUuid(
                item.SourceTransactionID,
                "SourceTransactionID"
            ),

        erp_source_row_id:
            optionalUuid(
                item.SourceRowID,
                "SourceRowID"
            ),

        erp_source_transaction_type:
            item.SourceTransactionType ?? null,

        erp_source_transaction_type_name:
            item.SourceTransactionTypeName ?? null,

        erp_source_transaction_doc_date:
            dateValue(
                item.SourceTransactionDocDate,
                "SourceTransactionDocDate"
            ),

        erp_source_transaction_reference:
            item.SourceTransactionReference ?? null

    };

}


// ============================================================
// SQL - INSERT / UPDATE LÍNEAS DE INSPECCIÓN
//
// IMPORTANTE:
//
// NO MODIFICAR:
//
// inspected_quantity
// inspection_status
// inspection_notes
// inspected_by
// inspected_at
// created_at
// ============================================================

const UPSERT_LINES_SQL = `

    INSERT INTO erp_inspection_lines (

        document_type,
        erp_document_id,
        erp_line_id,

        erp_trans_id,
        erp_row_order,

        erp_item_id,
        erp_item_sku,
        erp_item_name,

        erp_quantity,
        completed_quantity,

        erp_uom_id,
        erp_uom_name,
        erp_uom_factor,

        erp_source_transaction_id,
        erp_source_row_id,

        erp_source_transaction_type,
        erp_source_transaction_type_name,

        erp_source_transaction_doc_date,
        erp_source_transaction_reference

    )

    SELECT

        incoming.document_type,
        incoming.erp_document_id,
        incoming.erp_line_id,

        incoming.erp_trans_id,
        incoming.erp_row_order,

        incoming.erp_item_id,
        incoming.erp_item_sku,
        incoming.erp_item_name,

        incoming.erp_quantity,
        incoming.completed_quantity,

        incoming.erp_uom_id,
        incoming.erp_uom_name,
        incoming.erp_uom_factor,

        incoming.erp_source_transaction_id,
        incoming.erp_source_row_id,

        incoming.erp_source_transaction_type,
        incoming.erp_source_transaction_type_name,

        incoming.erp_source_transaction_doc_date,
        incoming.erp_source_transaction_reference

    FROM jsonb_to_recordset($1::jsonb) AS incoming (

        document_type VARCHAR,
        erp_document_id UUID,
        erp_line_id UUID,

        erp_trans_id UUID,
        erp_row_order INTEGER,

        erp_item_id UUID,
        erp_item_sku VARCHAR,
        erp_item_name TEXT,

        erp_quantity NUMERIC(18,4),
        completed_quantity NUMERIC,

        erp_uom_id UUID,
        erp_uom_name VARCHAR,
        erp_uom_factor NUMERIC,

        erp_source_transaction_id UUID,
        erp_source_row_id UUID,

        erp_source_transaction_type VARCHAR,
        erp_source_transaction_type_name VARCHAR,

        erp_source_transaction_doc_date DATE,
        erp_source_transaction_reference TEXT

    )

    WHERE TRUE

    ON CONFLICT (
        document_type,
        erp_document_id,
        erp_line_id
    )

    DO UPDATE SET

        erp_trans_id =
            EXCLUDED.erp_trans_id,

        erp_row_order =
            EXCLUDED.erp_row_order,

        erp_item_id =
            EXCLUDED.erp_item_id,

        erp_item_sku =
            EXCLUDED.erp_item_sku,

        erp_item_name =
            EXCLUDED.erp_item_name,

        erp_quantity =
            EXCLUDED.erp_quantity,

        completed_quantity =
            EXCLUDED.completed_quantity,

        erp_uom_id =
            EXCLUDED.erp_uom_id,

        erp_uom_name =
            EXCLUDED.erp_uom_name,

        erp_uom_factor =
            EXCLUDED.erp_uom_factor,

        erp_source_transaction_id =
            EXCLUDED.erp_source_transaction_id,

        erp_source_row_id =
            EXCLUDED.erp_source_row_id,

        erp_source_transaction_type =
            EXCLUDED.erp_source_transaction_type,

        erp_source_transaction_type_name =
            EXCLUDED.erp_source_transaction_type_name,

        erp_source_transaction_doc_date =
            EXCLUDED.erp_source_transaction_doc_date,

        erp_source_transaction_reference =
            EXCLUDED.erp_source_transaction_reference,

        updated_at = NOW()

    RETURNING id, erp_line_id;

`;


// ============================================================
// FORMATO DE LÍNEAS PARA EL FRONTEND
// ============================================================

function mapLineForFrontend(row) {

    return {

        // PostgreSQL BIGINT

        id: String(row.id),

        erp_line_id:
            row.erp_line_id,

        // GUID PRODUCTO ADM CLOUD

        erp_item_id:
            row.erp_item_id,

        sku:
            row.erp_item_sku ?? "",

        description:
            row.erp_item_name ?? "",

        // erp_quantity

        quantity:
            Number(row.erp_quantity),

        // CompletedQuantity

        completed_quantity:
            Number(row.completed_quantity),

        // Conteo real de inspección

        inspected_quantity:
            Number(row.inspected_quantity),

        inspection_status:
            row.inspection_status,

        erp_uom_name:
            row.erp_uom_name ?? null,

        erp_row_order:
            row.erp_row_order

    };

}



export async function syncInspectionDocumentLinesController(
    req,
    res
) {

    // ========================================================
    // 1. OBTENER PARÁMETROS
    // ========================================================

    const documentType = normalizeDocumentType(
        req.params.tipo
    );

    const documentGuid = req.params.guid;


    // ========================================================
    // 2. VALIDAR TIPO
    // ========================================================

    if (!documentType) {

        return res.status(400).json({
            success: false,
            message: "El tipo debe ser CONDUCE o FACTURA."
        });

    }


    // ========================================================
    // 3. VALIDAR GUID
    // ========================================================

    if (
        typeof documentGuid !== "string" ||
        !UUID_PATTERN.test(documentGuid)
    ) {

        return res.status(400).json({
            success: false,
            message: "El GUID del documento es inválido."
        });

    }


    let client = null;
    let transactionStarted = false;


    try {

        logDetails("");
        logDetails("🟪 ========================================");
        logDetails("🟪 SINCRONIZANDO DOCUMENTO DE INSPECCIÓN");
        logDetails("🟪 ========================================");

        logDetails("📄 TIPO:", documentType);
        logDetails("🆔 GUID:", documentGuid);


        // ====================================================
        // 4. CONSULTAR ADM CLOUD
        // ====================================================

        let serviceResult;


        if (documentType === "CONDUCE") {

            logDetails(
                "🚚 CONSULTANDO CONDUCE EN ADM CLOUD..."
            );

            serviceResult =
                await getAdmCloudDispatchService({
                    id: documentGuid
                });

        } else {

            logDetails(
                "🧾 CONSULTANDO FACTURA EN ADM CLOUD..."
            );

            serviceResult =
                await getAdmCloudCreditInvoiceById(
                    documentGuid
                );

        }


        // ====================================================
        // 5. EXTRAER DOCUMENTO Y ITEMS
        // ====================================================

        const erpDocument = unwrapDocument(
            serviceResult
        );

        const rawItems =
            erpDocument.Items ??
            erpDocument.items;


        // ====================================================
        // VALIDAR QUE ADM CLOUD DEVOLVIÓ UN ARRAY
        //
        // IMPORTANTE:
        // NO ELIMINAR LÍNEAS SI LA RESPUESTA ES INVÁLIDA.
        // ====================================================

        if (!Array.isArray(rawItems)) {

            throw new Error(
                "Adm Cloud no devolvió un arreglo Items válido. " +
                "Se canceló la sincronización para evitar eliminar líneas."
            );

        }


        // ====================================================
        // 6. VERIFICAR IDENTIDAD DEL DOCUMENTO
        // ====================================================

        const returnedGuid =
            erpDocument.ID ??
            erpDocument.Id ??
            erpDocument.id;


        if (
            !returnedGuid ||
            String(returnedGuid).toLowerCase() !==
                documentGuid.toLowerCase()
        ) {

            throw new Error(
                "Adm Cloud no confirmó el GUID del documento solicitado. " +
                `GUID recibido: ${returnedGuid ?? "NINGUNO"}. ` +
                "No se modificaron las líneas de inspección."
            );

        }


        logDetails(
            "📦 LÍNEAS RECIBIDAS:",
            rawItems.length
        );


        // ====================================================
        // 7. NUEVO - FILTRAR SERVICIOS
        //
        // ItemType = "I" -> PRODUCTO DE INVENTARIO
        // ItemType = "S" -> SERVICIO
        //
        // NO GUARDAR SERVICIOS.
        //
        // LOS DEMÁS TIPOS SE CONSERVAN.
        // ====================================================

        const physicalItems = rawItems.filter(
            item => {

                const itemType = String(
                    item?.ItemType ??
                    item?.itemType ??
                    ""
                )
                    .trim()
                    .toUpperCase();

                return itemType !== "S";

            }
        );


        const excludedServices =
            rawItems.length - physicalItems.length;


        logDetails("");
        logDetails("🟦 ========================================");
        logDetails("📦 FILTRANDO PRODUCTOS Y SERVICIOS");
        logDetails("📦 LÍNEAS TOTALES:", rawItems.length);
        logDetails("📦 LÍNEAS NO SERVICIO:", physicalItems.length);
        logDetails("🚫 SERVICIOS IGNORADOS:", excludedServices);
        logDetails("🟦 ========================================");


        // ====================================================
        // 8. MAPEAR ÚNICAMENTE LAS LÍNEAS ADMITIDAS
        // ====================================================

        const mapped = physicalItems.map(
            item => mapInspectionLine(
                item,
                documentType,
                documentGuid
            )
        );


        // ====================================================
        // 9. VALIDAR LÍNEAS DUPLICADAS
        // ====================================================

        const lineIds = mapped.map(
            line => line.erp_line_id
        );


        if (
            new Set(lineIds).size !== lineIds.length
        ) {

            throw new Error(
                "Adm Cloud devolvió líneas duplicadas " +
                "con el mismo ID."
            );

        }


        // ====================================================
        // 10. CONECTAR A POSTGRESQL
        // ====================================================

        client = await db.connect();

        await client.query("BEGIN");

        transactionStarted = true;


        // ====================================================
        // 11. BLOQUEAR DOCUMENTO DURANTE SINCRONIZACIÓN
        // ====================================================

        await client.query(
            `
                SELECT pg_advisory_xact_lock(
                    hashtext('erp_inspection_lines'),
                    hashtext($1::text)
                )
            `,
            [
                `${documentType}:${documentGuid.toLowerCase()}`
            ]
        );


        logDetails(
            "🔒 BLOQUEO DEL DOCUMENTO ADQUIRIDO"
        );


        // ====================================================
        // 12. GUARDAR Y ACTUALIZAR LÍNEAS POR LOTES
        //
        // UTILIZA TU UPSERT EXISTENTE.
        //
        // NO SE GUARDAN SERVICIOS.
        // ====================================================

        let saved = 0;


        for (
            let offset = 0;
            offset < mapped.length;
            offset += BATCH_SIZE
        ) {

            const batch = mapped.slice(
                offset,
                offset + BATCH_SIZE
            );


            const result = await client.query(
                UPSERT_LINES_SQL,
                [JSON.stringify(batch)]
            );


            if (result.rowCount !== batch.length) {

                throw new Error(
                    "No se guardaron todas las líneas del lote."
                );

            }


            saved += result.rowCount;


            logDetails(
                "✅ LÍNEAS SINCRONIZADAS:",
                `${saved}/${mapped.length}`
            );

        }


        // ====================================================
        // 13. NUEVO - ELIMINAR LÍNEAS OBSOLETAS
        //
        // FUNCIONAMIENTO:
        //
        // 1. OBTIENE TODAS LAS LÍNEAS DEL DOCUMENTO.
        //
        // 2. COMPARA SUS erp_line_id CON LOS QUE
        //    DEVOLVIÓ ADM CLOUD.
        //
        // 3. SI UNA LÍNEA YA NO EXISTE EN ADM CLOUD,
        //    LA ELIMINA DE erp_inspection_lines.
        //
        // 4. SI UNA LÍNEA ANTES ERA PRODUCTO Y AHORA
        //    ES SERVICIO, TAMBIÉN SE ELIMINA.
        //
        // 5. SOLO AFECTA AL DOCUMENTO ACTUAL.
        //
        // IMPORTANTE:
        //
        // SI lineIds = [], SE ELIMINAN TODAS LAS
        // LÍNEAS DE ESTE DOCUMENTO.
        // ====================================================

        const deleteResult = await client.query(
            `
                DELETE FROM erp_inspection_lines

                WHERE document_type = $1

                  AND erp_document_id = $2::uuid

                  AND (
                      erp_line_id IS NULL
                      OR NOT (
                          erp_line_id = ANY($3::uuid[])
                      )
                  )

                RETURNING

                    id::text AS id,

                    erp_line_id,

                    erp_item_sku
            `,
            [
                documentType,
                documentGuid,
                lineIds
            ]
        );


        const deletedLines =
            deleteResult.rowCount ?? 0;


        console.log("");
        console.log("🗑️ ========================================");
        console.log("🗑️ DEPURANDO LÍNEAS DE INSPECCIÓN");
        console.log("🗑️ LÍNEAS ELIMINADAS:", deletedLines);
        console.log("🗑️ ========================================");


        if (deletedLines > 0) {

            console.log(
                "🗑️ DETALLE DE LÍNEAS ELIMINADAS:",
                deleteResult.rows
            );

        }


        // ====================================================
        // 14. CONSULTAR TODAS LAS LÍNEAS RESTANTES
        //
        // AHORA SOLO EXISTEN LÍNEAS ADMITIDAS
        // Y PRESENTES EN ADM CLOUD.
        // ====================================================

        const linesResult = await client.query(
            `
                SELECT

                    id,

                    erp_line_id,

                    erp_item_id,

                    erp_item_sku,

                    erp_item_name,

                    erp_quantity,

                    completed_quantity,

                    inspected_quantity,

                    inspection_status,

                    erp_uom_name,

                    erp_row_order

                FROM erp_inspection_lines

                WHERE document_type = $1

                  AND erp_document_id = $2::uuid

                ORDER BY

                    erp_row_order NULLS LAST,

                    id
            `,
            [
                documentType,
                documentGuid
            ]
        );


        // ====================================================
        // 15. OBTENER ENCABEZADO DESDE TABLA ORIGINAL
        // ====================================================

        const headerTable =
            documentType === "CONDUCE"
                ? "erp_dispatches"
                : "erp_invoices";


        const headerResult = await client.query(
            `
                SELECT

                    erp_numero,

                    erp_fecha,

                    erp_cliente,

                    erp_ubicacion,

                    erp_referencia,

                    inspection_status

                FROM ${headerTable}

                WHERE erp_id = $1::uuid

                LIMIT 1
            `,
            [documentGuid]
        );


        const header =
            headerResult.rows[0] ?? null;


        // ====================================================
        // 16. CONSTRUIR INFORMACIÓN DEL DOCUMENTO
        // ====================================================

        const document = {

            erp_id:
                documentGuid,

            tipo:
                documentType,

            numero:
                header?.erp_numero ??
                erpDocument.DocID ??
                null,

            fecha:
                header?.erp_fecha ??
                erpDocument.DocDate ??
                null,

            cliente:
                header?.erp_cliente ??
                erpDocument.RelationshipName ??
                null,

            ubicacion:
                header?.erp_ubicacion ??
                erpDocument.LocationName ??
                null,

            erp_referencia:
                header?.erp_referencia ??
                erpDocument.Reference ??
                null,

            inspeccion_status:
                header?.inspection_status ??
                "PENDIENTE"

        };


        // ====================================================
        // 17. CONFIRMAR TRANSACCIÓN
        // ====================================================

        await client.query("COMMIT");

        transactionStarted = false;


        // ====================================================
        // 18. PREPARAR RESPUESTA AL FRONTEND
        // ====================================================

        const lines = linesResult.rows.map(
            mapLineForFrontend
        );


        console.log("");
        console.log("🟩 ========================================");
        console.log("✅ SINCRONIZACIÓN COMPLETADA");
        console.log("📄 DOCUMENTO:", document.numero);
        console.log("📄 TIPO:", documentType);

        console.log(
            "📦 LÍNEAS ADM CLOUD:",
            rawItems.length
        );

        console.log(
            "🚫 SERVICIOS IGNORADOS:",
            excludedServices
        );

        console.log(
            "✅ LÍNEAS SINCRONIZADAS:",
            saved
        );

        console.log(
            "🗑️ LÍNEAS ELIMINADAS:",
            deletedLines
        );

        console.log(
            "📦 TOTAL LÍNEAS FINALES:",
            lines.length
        );

        console.log("🟩 ========================================");


        return res.status(200).json({

            success: true,

            document,

            documentType,

            documentGuid,

            total: lines.length,

            excludedServices,

            deletedLines,

            lines

        });


    } catch (error) {

        // ====================================================
        // 19. ROLLBACK SI OCURRE UN ERROR
        // ====================================================

        if (client && transactionStarted) {

            try {

                await client.query("ROLLBACK");

                logDetails(
                    "↩️ TRANSACCIÓN REVERTIDA"
                );

            } catch (rollbackError) {

                logDetails(
                    "❌ ERROR EN ROLLBACK:",
                    rollbackError.message
                );

            }

        }


        console.log("");
        console.log("🟥 ========================================");
        console.log("❌ ERROR SINCRONIZANDO INSPECCIÓN");

        console.log(
            "📄 MENSAJE:",
            error.message
        );

        console.log(
            "🗄️ PG CODE:",
            error.code ?? null
        );

        console.log(
            "🗄️ PG DETAIL:",
            error.detail ?? null
        );

        console.log(
            "🌐 HTTP STATUS:",
            error.status ?? error.response?.status
        );

        console.log("🟥 ========================================");


        return res.status(
            error.response?.status === 404 ? 404 : 500
        ).json({

            success: false,

            message: error.message

        });


    } finally {

        // ====================================================
        // 20. LIBERAR CONEXIÓN
        // ====================================================

        if (client) {
            client.release();
        }

    }

}


// ============================================================
// GET INITIAL INSPECTION DOCUMENTS
//
// Obtiene:
//
// 10 últimos conduces:
// erp_dispatches
//
// 10 últimas facturas:
// erp_invoices
//
// Ambos se normalizan al mismo formato para el frontend.
// ============================================================

export async function getInspectionInitialDocuments(req, res) {

    console.log("");
    console.log("======================================================");
    console.log("🔎 GET INITIAL INSPECTION DOCUMENTS");
    console.log("======================================================");


    try {

        // ====================================================
        // 1. BUSCAR ÚLTIMOS 10 CONDUCES
        // ====================================================

        console.log("");
        console.log("🚚 Buscando últimos 10 conduces...");


        const dispatchesResult =
            await db.query(
                `
                SELECT
                    id,
                    erp_id,
                    erp_numero,
                    erp_fecha,
                    erp_cliente,
                    erp_ubicacion,
                    erp_referencia,
                    inspection_status
                FROM erp_dispatches
                ORDER BY
                    erp_fecha DESC NULLS LAST,
                    id DESC
                LIMIT 10
                `
            );


        console.log(
            `✅ Conduces encontrados: ${dispatchesResult.rows.length}`
        );


        // ====================================================
        // 2. BUSCAR ÚLTIMAS 10 FACTURAS
        // ====================================================

        console.log("");
        console.log("🧾 Buscando últimas 10 facturas...");


        const invoicesResult =
            await db.query(
                `
                SELECT
                    id,
                    erp_id,
                    erp_numero,
                    erp_fecha,
                    erp_cliente,
                    erp_ubicacion,
                    erp_referencia,
                    inspection_status
                FROM erp_invoices
                ORDER BY
                    erp_fecha DESC NULLS LAST,
                    id DESC
                LIMIT 10
                `
            );


        console.log(
            `✅ Facturas encontradas: ${invoicesResult.rows.length}`
        );


        // ====================================================
        // 3. NORMALIZAR CONDUCES
        // ====================================================

        const dispatches =
            dispatchesResult.rows.map(
                row => {

                    return {

                        /*
                            ID interno de PostgreSQL.
                        */
                        id:
                            row.id,


                        /*
                            ID proveniente de ADM Cloud.

                            Este será el ID que luego utilizarás
                            cuando el usuario haga click en la línea.
                        */
                        erp_id:
                            row.erp_id,


                        /*
                            Tipo normalizado.
                        */
                        tipo:
                            "CONDUCE",


                        /*
                            Número visible del conduce.
                        */
                        numero:
                            row.erp_numero || "-",


                        /*
                            Fecha del documento.
                        */
                        fecha:
                            row.erp_fecha || null,


                        /*
                            Cliente.
                        */
                        cliente:
                            row.erp_cliente || "-",


                        /*
                            Ubicación / almacén.
                        */
                        ubicacion:
                            row.erp_ubicacion || "-",


                        /*
                            Referencia del ERP.
                        */
                        erp_referencia:
                            row.erp_referencia || "-",


                        /*
                            Estado de inspección.

                            Si por algún motivo viene NULL,
                            lo tratamos como PENDIENTE.
                        */
                        inspeccion_status:
                            row.inspection_status ||
                            "PENDIENTE",

                    };

                }
            );


        // ====================================================
        // 4. NORMALIZAR FACTURAS
        // ====================================================

        const invoices =
            invoicesResult.rows.map(
                row => {

                    return {

                        id:
                            row.id,

                        erp_id:
                            row.erp_id,

                        tipo:
                            "FACTURA",

                        numero:
                            row.erp_numero || "-",

                        fecha:
                            row.erp_fecha || null,

                        cliente:
                            row.erp_cliente || "-",

                        ubicacion:
                            row.erp_ubicacion || "-",

                        erp_referencia:
                            row.erp_referencia || "-",

                        inspeccion_status:
                            row.inspection_status ||
                            "PENDIENTE",

                    };

                }
            );


        // ====================================================
        // 5. COMBINAR
        // ====================================================

        const documents = [
            ...dispatches,
            ...invoices,
        ];


        console.log("");
        console.log("📦 DOCUMENTOS PARA INSPECCIÓN");
        console.log({
            conduces:
                dispatches.length,

            facturas:
                invoices.length,

            total:
                documents.length,
        });


        // ====================================================
        // 6. RESPONSE
        // ====================================================

        return res.status(200).json({

            success: true,

            message:
                "Documentos de inspección obtenidos correctamente.",

            data: {

                dispatches,

                invoices,

                documents,

                totals: {

                    dispatches:
                        dispatches.length,

                    invoices:
                        invoices.length,

                    documents:
                        documents.length,

                },

            },

        });


    } catch (error) {

        console.error("");
        console.error(
            "❌ ERROR GET INSPECTION INITIAL DOCUMENTS:"
        );

        console.error(
            error
        );


        return res.status(500).json({

            success: false,

            message:
                "No se pudieron obtener los documentos para inspección.",

            error:
                error.message,

        });

    }

}








// ============================================================
// SEARCH INSPECTION DOCUMENTS
//
// GET /api/inspection/search?q=texto
//
// Busca en:
//
// erp_dispatches
// erp_invoices
//
// Máximo:
// 10 conduces
// 10 facturas
// ============================================================

export async function searchInspectionDocuments(
    req,
    res
) {

    console.log("");
    console.log("======================================================");
    console.log("🔎 SEARCH INSPECTION DOCUMENTS");
    console.log("======================================================");


    try {

        // ====================================================
        // 1. GET SEARCH
        // ====================================================

        const search =
            String(
                req.query.q || ""
            )
                .trim();


        console.log(
            "🔎 SEARCH VALUE:",
            search
        );


        // ====================================================
        // 2. VALIDATE
        //
        // El frontend NO debería llamar este endpoint vacío.
        // Pero lo validamos de todas maneras.
        // ====================================================

        if (
            !search
        ) {

            return res.status(400).json({

                success:
                    false,

                message:
                    "Debe proporcionar un valor de búsqueda.",

            });

        }


        // ====================================================
        // 3. SEARCH VALUE FOR ILIKE
        // ====================================================

        const searchValue =
            `%${search}%`;


        // ====================================================
        // 4. SEARCH DISPATCHES
        //
        // Últimos 10 que coincidan.
        // ====================================================

        const dispatchesResult =
            await db.query(
                `
                SELECT
                    id,
                    erp_id,
                    erp_numero,
                    erp_fecha,
                    erp_cliente,
                    erp_ubicacion,
                    erp_referencia,
                    inspection_status

                FROM erp_dispatches

                WHERE
                    erp_numero ILIKE $1
                    OR erp_referencia ILIKE $1
                    OR erp_cliente ILIKE $1

                ORDER BY
                    erp_fecha DESC NULLS LAST,
                    id DESC

                LIMIT 10
                `,
                [
                    searchValue
                ]
            );


        console.log(
            "🚚 CONDUCES ENCONTRADOS:",
            dispatchesResult.rows.length
        );


        // ====================================================
        // 5. SEARCH INVOICES
        //
        // Últimas 10 que coincidan.
        // ====================================================

        const invoicesResult =
            await db.query(
                `
                SELECT
                    id,
                    erp_id,
                    erp_numero,
                    erp_fecha,
                    erp_cliente,
                    erp_ubicacion,
                    erp_referencia,
                    inspection_status

                FROM erp_invoices

                WHERE
                    erp_numero ILIKE $1
                    OR erp_referencia ILIKE $1
                    OR erp_cliente ILIKE $1

                ORDER BY
                    erp_fecha DESC NULLS LAST,
                    id DESC

                LIMIT 10
                `,
                [
                    searchValue
                ]
            );


        console.log(
            "🧾 FACTURAS ENCONTRADAS:",
            invoicesResult.rows.length
        );


        // ====================================================
        // 6. NORMALIZE DISPATCHES
        // ====================================================

        const dispatches =
            dispatchesResult.rows.map(
                row => ({

                    id:
                        row.id,

                    erp_id:
                        row.erp_id,

                    tipo:
                        "CONDUCE",

                    numero:
                        row.erp_numero || "-",

                    fecha:
                        row.erp_fecha || null,

                    cliente:
                        row.erp_cliente || "-",

                    ubicacion:
                        row.erp_ubicacion || "-",

                    erp_referencia:
                        row.erp_referencia || "-",

                    inspeccion_status:
                        row.inspection_status ||
                        "PENDIENTE",

                })
            );


        // ====================================================
        // 7. NORMALIZE INVOICES
        // ====================================================

        const invoices =
            invoicesResult.rows.map(
                row => ({

                    id:
                        row.id,

                    erp_id:
                        row.erp_id,

                    tipo:
                        "FACTURA",

                    numero:
                        row.erp_numero || "-",

                    fecha:
                        row.erp_fecha || null,

                    cliente:
                        row.erp_cliente || "-",

                    ubicacion:
                        row.erp_ubicacion || "-",

                    erp_referencia:
                        row.erp_referencia || "-",

                    inspeccion_status:
                        row.inspection_status ||
                        "PENDIENTE",

                })
            );


        // ====================================================
        // 8. COMBINE
        // ====================================================

        const documents = [

            ...dispatches,

            ...invoices,

        ];


        console.log(
            "📦 TOTAL RESULTADOS:",
            documents.length
        );


        // ====================================================
        // 9. RESPONSE
        // ====================================================

        return res.status(200).json({

            success:
                true,

            search,

            data: {

                dispatches,

                invoices,

                documents,

                totals: {

                    dispatches:
                        dispatches.length,

                    invoices:
                        invoices.length,

                    documents:
                        documents.length,

                },

            },

        });


    } catch (
        error
    ) {

        console.error(
            "❌ ERROR SEARCH INSPECTION:",
            error
        );


        return res.status(500).json({

            success:
                false,

            message:
                "No se pudieron buscar los documentos de inspección.",

            error:
                error.message,

        });

    }

}