// integrations/admcloud/admcloud.conduce.js

import admcloudClient from "./admcloudClient.js";

const GUID_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function createServiceError(
    statusCode,
    title,
    message,
    code,
    extra = {}
) {
    return Object.assign(
        new Error(message),
        {
            statusCode,
            title,
            code,
            ...extra,
        }
    );
}

function normalizeGuid(
    value,
    fieldName
) {
    const normalized = String(
        value ?? ""
    )
        .trim()
        .toLowerCase();

    if (!GUID_REGEX.test(normalized)) {
        throw createServiceError(
            422,
            "Datos incompletos del picking",
            `${fieldName} no contiene un GUID válido.`,
            "INVALID_GUID"
        );
    }

    return normalized;
}

function normalizeDecimal(
    value,
    {
        fieldName,
        moveId,
        defaultValue = 0,
    }
) {
    if (
        value === null ||
        value === undefined ||
        String(value).trim() === ""
    ) {
        return defaultValue;
    }

    const normalized = Number(value);

    if (
        !Number.isFinite(normalized) ||
        normalized < 0
    ) {
        throw createServiceError(
            422,
            "Valor numérico inválido",
            `${fieldName} es inválido en el movimiento ${moveId}.`,
            "INVALID_DECIMAL"
        );
    }

    return normalized;
}

function normalizeInteger(
    value,
    {
        fieldName,
        moveId,
        defaultValue = 0,
    }
) {
    if (
        value === null ||
        value === undefined ||
        String(value).trim() === ""
    ) {
        return defaultValue;
    }

    const normalized = Number(value);

    if (
        !Number.isSafeInteger(normalized) ||
        normalized < 0
    ) {
        throw createServiceError(
            422,
            "Valor entero inválido",
            `${fieldName} es inválido en el movimiento ${moveId}.`,
            "INVALID_INTEGER"
        );
    }

    return normalized;
}

function extractDispatchGuid(
    admCloudResult
) {
    const candidates = [
        admCloudResult?.data,
        admCloudResult?.data?.ID,
        admCloudResult?.data?.Id,
        admCloudResult?.data?.id,
        admCloudResult?.data?.GUID,
        admCloudResult?.data?.Guid,
        admCloudResult?.data?.guid,
    ];

    for (const candidate of candidates) {
        if (
            typeof candidate === "string" &&
            GUID_REGEX.test(candidate.trim())
        ) {
            return candidate
                .trim()
                .toLowerCase();
        }
    }

    return null;
}

/**
 * Crea un conduce en ADM Cloud.
 *
 * IMPORTANTE:
 * - Recibe una conexión de PostgreSQL ya obtenida.
 * - El controller controla BEGIN, COMMIT y ROLLBACK.
 * - El servicio no libera la conexión.
 * - Debe ejecutarse antes de marcar las líneas/picking como done.
 */
export async function prepareAdmCloudDispatchService(
    client,
    pickingId
) {
    if (
        !client ||
        typeof client.query !== "function"
    ) {
        throw createServiceError(
            500,
            "Conexión no disponible",
            "No se recibió una conexión válida a la base de datos.",
            "INVALID_DATABASE_CLIENT"
        );
    }

    const normalizedPickingId =
        Number(pickingId);

    if (
        !Number.isSafeInteger(
            normalizedPickingId
        ) ||
        normalizedPickingId <= 0
    ) {
        throw createServiceError(
            400,
            "Picking inválido",
            "Debe enviar un pickingId entero positivo válido.",
            "INVALID_PICKING_ID"
        );
    }

    console.log(
        "======================================"
    );
    console.log(
        "🚚 CREANDO CONDUCE ADM CLOUD"
    );
    console.log(
        "📦 Picking:",
        normalizedPickingId
    );
    console.log(
        "======================================"
    );

    // =====================================================
    // 1. BUSCAR Y BLOQUEAR EL PICKING
    // =====================================================

    const pickingResult =
        await client.query(
            `
        SELECT
          id,
          name,
          state,
          sale_id,
          user_id,
          erp_location_id,
          order_name,
          erp_cliente_id,
          TO_CHAR(
            CURRENT_DATE,
            'YYYY-MM-DD'
          ) AS document_date
        FROM public.stock_picking
        WHERE id = $1
        FOR UPDATE
      `,
            [normalizedPickingId]
        );

    const picking =
        pickingResult.rows[0];

    if (!picking) {
        throw createServiceError(
            404,
            "Picking no encontrado",
            `No existe el picking ${normalizedPickingId}.`,
            "PICKING_NOT_FOUND"
        );
    }

    // =====================================================
    // 2. VALIDAR ESTADO DEL PICKING
    // =====================================================

    const pickingState = String(
        picking.state ?? ""
    )
        .trim()
        .toLowerCase();

    if (
        ["done", "cancel"].includes(
            pickingState
        )
    ) {
        throw createServiceError(
            409,
            "Picking finalizado",
            pickingState === "done"
                ? "El picking ya fue completado y no puede generar otro conduce."
                : "El picking está cancelado y no puede generar un conduce.",
            "PICKING_TERMINAL_STATE"
        );
    }

    // =====================================================
    // 3. VALIDAR DATOS REQUERIDOS DEL ENCABEZADO
    // =====================================================

    const saleId = normalizeGuid(
        picking.sale_id,
        "sale_id"
    );

    const relationshipId =
        normalizeGuid(
            picking.erp_cliente_id,
            "erp_cliente_id"
        );

    const locationId =
        normalizeGuid(
            picking.erp_location_id,
            "erp_location_id"
        );

    const reference = String(
        picking.order_name ??
        picking.name ??
        ""
    ).trim();

    if (!reference) {
        throw createServiceError(
            422,
            "Referencia no disponible",
            "El picking no contiene order_name ni name para generar la referencia.",
            "MISSING_REFERENCE"
        );
    }

    // =====================================================
    // 4. BUSCAR MOVE LINES CON CANTIDAD RECOGIDA
    // =====================================================

    /*
     * Relación actual:
     *
     * stock_move_line.move_id
     *             ↓
     * despacho_stock_move.id
     *
     * Solamente se ignoran líneas canceladas.
     * Quantity se obtiene sumando qty_done.
     */
    const moveLinesResult =
  await client.query(
    `
      SELECT
        dsm.id AS dispatch_move_id,
        dsm.product_id,
        dsm.erp_product_id,
        dsm.erp_sales_uom_id,
        dsm.product_qty,
        dsm.pending_qty,
        dsm.erp_price,
        dsm.erp_cost,
        dsm.erp_exchange_rate,
        dsm.erp_warranty_days,
        dsm.erp_warranty_units,

        sml.id AS move_line_id,
        sml.qty_done,
        sml.state AS move_line_state

      FROM public.despacho_stock_move AS dsm

      INNER JOIN public.stock_move_line AS sml
        ON sml.move_id = dsm.id
       AND sml.picking_id = dsm.picking_id
       AND sml.product_id = dsm.product_id

      WHERE dsm.picking_id = $1

        AND COALESCE(
          dsm.state,
          ''
        ) <> 'cancel'

        AND COALESCE(
          sml.state,
          ''
        ) NOT IN (
          'cancel',
          'done'
        )

        AND COALESCE(
          sml.qty_done,
          0
        ) > 0

      ORDER BY
        dsm.id ASC,
        sml.id ASC

      FOR UPDATE OF dsm, sml
    `,
    [normalizedPickingId]
  );

    if (
        moveLinesResult.rowCount === 0
    ) {
        throw createServiceError(
            422,
            "Sin mercancía recogida",
            "El picking no contiene cantidades recogidas para crear el conduce.",
            "NO_PICKED_QUANTITIES"
        );
    }

    console.table(
        moveLinesResult.rows.map(
            (row) => ({
                dispatch_move_id:
                    row.dispatch_move_id,

                move_line_id:
                    row.move_line_id,

                product_id:
                    row.product_id,

                erp_product_id:
                    row.erp_product_id,

                erp_sales_uom_id:
                    row.erp_sales_uom_id,

                qty_done:
                    row.qty_done,

                state:
                    row.move_line_state,
            })
        )
    );

    // =====================================================
    // 5. AGRUPAR CANTIDADES POR despacho_stock_move
    // =====================================================

    const groupedMoves = new Map();

    for (
        const row of
        moveLinesResult.rows
    ) {
        const dispatchMoveId =
            Number(
                row.dispatch_move_id
            );

        const qtyDone =
            normalizeDecimal(
                row.qty_done,
                {
                    fieldName:
                        "stock_move_line.qty_done",
                    moveId:
                        dispatchMoveId,
                }
            );

        if (qtyDone <= 0) {
            continue;
        }

        if (
            !groupedMoves.has(
                dispatchMoveId
            )
        ) {
            groupedMoves.set(
                dispatchMoveId,
                {
                    dispatchMoveId,

                    itemId:
                        normalizeGuid(
                            row.erp_product_id,
                            `erp_product_id del movimiento ${dispatchMoveId}`
                        ),

                    uomId:
                        normalizeGuid(
                            row.erp_sales_uom_id,
                            `erp_sales_uom_id del movimiento ${dispatchMoveId}`
                        ),

                    quantity: 0,

                    pendingQty:
                        normalizeDecimal(
                            row.pending_qty,
                            {
                                fieldName:
                                    "pending_qty",
                                moveId:
                                    dispatchMoveId,
                            }
                        ),

                    cost:
                        normalizeDecimal(
                            row.erp_cost,
                            {
                                fieldName:
                                    "erp_cost",
                                moveId:
                                    dispatchMoveId,
                            }
                        ),

                    price:
                        normalizeDecimal(
                            row.erp_price,
                            {
                                fieldName:
                                    "erp_price",
                                moveId:
                                    dispatchMoveId,
                            }
                        ),

                    exchangeRate:
                        normalizeDecimal(
                            row.erp_exchange_rate,
                            {
                                fieldName:
                                    "erp_exchange_rate",
                                moveId:
                                    dispatchMoveId,
                                defaultValue: 1,
                            }
                        ),

                    warrantyDays:
                        normalizeInteger(
                            row.erp_warranty_days,
                            {
                                fieldName:
                                    "erp_warranty_days",
                                moveId:
                                    dispatchMoveId,
                            }
                        ),

                    warrantyUnits:
                        normalizeInteger(
                            row.erp_warranty_units,
                            {
                                fieldName:
                                    "erp_warranty_units",
                                moveId:
                                    dispatchMoveId,
                            }
                        ),
                }
            );
        }

        const groupedMove =
            groupedMoves.get(
                dispatchMoveId
            );

        groupedMove.quantity +=
            qtyDone;
    }

    const groupedLines =
        Array.from(
            groupedMoves.values()
        );

    if (groupedLines.length === 0) {
        throw createServiceError(
            422,
            "Sin mercancía recogida",
            "La suma de qty_done es cero. No se puede crear el conduce.",
            "ZERO_PICKED_QUANTITY"
        );
    }

    // =====================================================
    // 6. CREAR ITEMS DEL CONDUCE
    // =====================================================

    const dispatchItems =
        groupedLines.map(
            (line, index) => {
                /*
                 * Una tasa de cambio igual a cero no es
                 * válida para realizar cálculos monetarios.
                 */
                const exchangeRate =
                    line.exchangeRate > 0
                        ? line.exchangeRate
                        : 1;

                if (
                    line.quantity >
                    line.pendingQty +
                    0.000001
                ) {
                    throw createServiceError(
                        409,
                        "Cantidad recogida excedida",
                        `El movimiento ${line.dispatchMoveId} tiene ` +
                        `${line.quantity} recogidas, pero solamente ` +
                        `${line.pendingQty} pendientes en ADM Cloud.`,
                        "PICKED_QUANTITY_EXCEEDS_PENDING"
                    );
                }

                return {
                    RowOrder:
                        index + 1,

                    ItemID:
                        line.itemId,

                    UOMID:
                        line.uomId,

                    Cost:
                        line.cost,

                    Price:
                        line.price,

                    Quantity:
                        line.quantity,

                    ExchangeRate:
                        exchangeRate,

                    WarrantyDays:
                        line.warrantyDays,

                    WarrantyUnits:
                        line.warrantyUnits,

                    RowType: 0,

                    EstimatedDeliveryDate:
                        picking.document_date,

                    SourceTransactionID:
                        saleId,
                };
            }
        );

    // =====================================================
    // 7. CREAR PAYLOAD DEL CONDUCE
    // =====================================================

    const dispatchPayload = {
        DocDate:
            picking.document_date,

        RelationshipID:
            relationshipId,

        LocationID:
            locationId,

        SourceTransactionID:
            saleId,

        Reference:
            reference,

        Notes:
            `Conduce creado desde WMS Sidial para ${picking.name}`,

        Items:
            dispatchItems,
    };

    console.log(
        "📨 PAYLOAD DEL CONDUCE:"
    );

    console.log(
        JSON.stringify(
            dispatchPayload,
            null,
            2
        )
    );

    // =====================================================
    // 8. CREAR CONDUCE EN ADM CLOUD
    // =====================================================

    let response;

    /*try {
        response =
            await admcloudClient.post(
                "/Dispatchs",
                dispatchPayload
            );
    } catch (error) {
        throw createServiceError(
            502,
            "ADM Cloud rechazó el conduce",
            error.response?.data?.message ||
            error.message ||
            "No se pudo crear el conduce en ADM Cloud.",
            "ADMCLOUD_DISPATCH_REQUEST_FAILED",
            {
                admCloudStatus:
                    error.response?.status ||
                    null,

                admCloudData:
                    error.response?.data ||
                    null,
            }
        );
    }*/

    const moveLineIds = [
        ...new Set(
            moveLinesResult.rows.map(
                (row) =>
                    Number(row.move_line_id)
            )
        ),
    ];

    const dispatchMoveIds = [
        ...new Set(
            groupedLines.map(
                (line) =>
                    Number(
                        line.dispatchMoveId
                    )
            )
        ),
    ];

    console.log(
        "✅ Conduce preparado:",
        {
            pickingId:
                normalizedPickingId,
            moveLineIds,
            dispatchMoveIds,
            items:
                dispatchItems.length,
        }
    );

    return {
        success: true,
        title:
            "Conduce preparado",
        message:
            "El payload del conduce fue validado y preparado.",

        data: {
            pickingId:
                normalizedPickingId,

            pickingName:
                picking.name,

            saleId,

            moveLineIds,

            dispatchMoveIds,

            itemsCount:
                dispatchItems.length,

            payload:
                dispatchPayload,
        },
    };
}




export async function sendAdmCloudDispatchService(
    preparedDispatch
) {
    const dispatchPayload =
        preparedDispatch?.data?.payload ??
        preparedDispatch?.payload;

    if (
        !dispatchPayload ||
        typeof dispatchPayload !== "object"
    ) {
        throw createServiceError(
            500,
            "Conduce no preparado",
            "No se recibió un payload válido para enviar a ADM Cloud.",
            "INVALID_PREPARED_DISPATCH"
        );
    }

    if (
        !Array.isArray(
            dispatchPayload.Items
        ) ||
        dispatchPayload.Items.length === 0
    ) {
        throw createServiceError(
            422,
            "Conduce sin líneas",
            "El conduce preparado no contiene artículos.",
            "EMPTY_DISPATCH_ITEMS"
        );
    }

    console.log(
        "☁️ Enviando conduce a ADM Cloud..."
    );

    console.log(
        JSON.stringify(
            dispatchPayload,
            null,
            2
        )
    );

    let response;

    try {
        response =
            await admcloudClient.post(
                "/Dispatchs",
                dispatchPayload
            );
    } catch (error) {
        throw createServiceError(
            502,
            "ADM Cloud rechazó el conduce",
            error.response?.data?.message ||
            error.message ||
            "No se pudo crear el conduce en ADM Cloud.",
            "ADMCLOUD_DISPATCH_REQUEST_FAILED",
            {
                admCloudStatus:
                    error.response?.status ||
                    null,

                admCloudData:
                    error.response?.data ||
                    null,
            }
        );
    }

    const admCloudResult =
        response.data;

    console.log(
        "📨 Respuesta completa ADM Cloud:",
        JSON.stringify(
            admCloudResult,
            null,
            2
        )
    );

    if (
        admCloudResult?.success !== true
    ) {
        throw createServiceError(
            422,
            "No se pudo crear el conduce",
            admCloudResult?.message ||
            "ADM Cloud indicó que el conduce no pudo ser creado.",
            "ADMCLOUD_DISPATCH_REJECTED",
            {
                admCloudStatus:
                    response.status,

                admCloudData:
                    admCloudResult,
            }
        );
    }

    const dispatchGuid =
        extractDispatchGuid(
            admCloudResult
        );

    if (!dispatchGuid) {
        throw createServiceError(
            502,
            "Respuesta inválida de ADM Cloud",
            "ADM Cloud indicó éxito, pero no devolvió el GUID del conduce.",
            "MISSING_DISPATCH_GUID",
            {
                admCloudStatus:
                    response.status,

                admCloudData:
                    admCloudResult,
            }
        );
    }

    return {
        success: true,
        title:
            "Conduce creado",
        message:
            "El conduce fue creado correctamente en ADM Cloud.",

        data: {
            pickingId:
                preparedDispatch?.data
                    ?.pickingId,

            pickingName:
                preparedDispatch?.data
                    ?.pickingName,

            dispatchGuid,

            itemsCount:
                dispatchPayload.Items.length,

            payload:
                dispatchPayload,

            admCloudResponse:
                admCloudResult,
        },
    };
}








// =====================================================
// 🔍 OBTENER CONDUCE DESDE ADM CLOUD
// =====================================================

export async function getAdmCloudDispatchService({
    id,
    docId,
    reference
} = {}) {

    console.log(
        "======================================"
    );
    console.log(
        "🔍 BUSCANDO CONDUCE EN ADM CLOUD"
    );
    console.log(
        "======================================"
    );

    // ===============================================
    // 1. NORMALIZAR PARÁMETROS
    // ===============================================

    const dispatchId = String(id ?? "").trim();
    const dispatchDocId = String(docId ?? "").trim();
    const dispatchReference = String(reference ?? "").trim();

    const providedCount = [
        dispatchId,
        dispatchDocId,
        dispatchReference
    ].filter(Boolean).length;

    if (providedCount !== 1) {
        throw createServiceError(
            400,
            "Parámetros inválidos",
            "Debe proporcionar exactamente uno de estos valores: id, docId o reference.",
            "INVALID_DISPATCH_SEARCH"
        );
    }

    // ===============================================
    // 2. VALIDAR GUID
    // ===============================================

    if (
        dispatchId &&
        !GUID_REGEX.test(dispatchId)
    ) {
        throw createServiceError(
            422,
            "Identificador inválido",
            "El identificador del conduce no contiene un GUID válido.",
            "INVALID_DISPATCH_GUID"
        );
    }

    // ===============================================
    // 3. PREPARAR CONSULTA
    // ===============================================

    const EMPTY_GUID =
        "00000000-0000-0000-0000-000000000000";

    /*
     * IMPORTANTE:
     *
     * Buscar por GUID está documentado.
     *
     * Para DocID y Reference utilizamos temporalmente
     * EMPTY_GUID en la ruta porque OpenAPI exige ID.
     *
     * Este comportamiento debe validarse contra ADM Cloud.
     */

    const pathId = dispatchId || EMPTY_GUID;

    const params = {};

    if (dispatchDocId) {
        params.DocID = dispatchDocId;
    }

    if (dispatchReference) {
        params.Reference = dispatchReference;
    }

    console.log("📦 Búsqueda:", {
        id: dispatchId || null,
        docId: dispatchDocId || null,
        reference: dispatchReference || null
    });

    // ===============================================
    // 4. CONSULTAR ADM CLOUD
    // ===============================================

    let response;

    try {

        response = await admcloudClient.get(
            `/Dispatchs/${encodeURIComponent(pathId)}`,
            { params }
        );

    } catch (error) {

        console.error(
            "❌ ERROR CONSULTANDO CONDUCE:",
            error.response?.data || error.message
        );

        throw createServiceError(
            error.response?.status === 404 ? 404 : 502,
            "Error consultando conduce",
            error.response?.data?.message ||
                "No se pudo consultar el conduce en ADM Cloud.",
            "ADMCLOUD_DISPATCH_GET_FAILED",
            {
                admCloudStatus:
                    error.response?.status || null,

                admCloudData:
                    error.response?.data || null
            }
        );
    }

    // ===============================================
    // 5. VALIDAR RESPUESTA
    // ===============================================

    const admCloudResult = response.data;

    if (admCloudResult?.success !== true) {

        throw createServiceError(
            404,
            "Conduce no encontrado",
            admCloudResult?.message ||
                "ADM Cloud no encontró el conduce solicitado.",
            "DISPATCH_NOT_FOUND"
        );
    }

    const dispatch = admCloudResult.data;

    if (!dispatch) {

        throw createServiceError(
            404,
            "Conduce sin información",
            "ADM Cloud respondió correctamente, pero no devolvió los datos del conduce.",
            "EMPTY_DISPATCH_DATA"
        );
    }

    // ===============================================
    // 6. VERIFICAR BÚSQUEDAS ALTERNATIVAS
    // ===============================================

    if (dispatchDocId || dispatchReference) {

        const returnedValue = dispatchDocId
            ? dispatch.DocID ?? dispatch.DocId
            : dispatch.Reference ?? dispatch.reference;

        const expectedValue =
            dispatchDocId || dispatchReference;

        if (
            !returnedValue ||
            String(returnedValue).trim().toLowerCase() !==
            expectedValue.toLowerCase()
        ) {
            throw createServiceError(
                502,
                "Conduce no verificado",
                "ADM Cloud no devolvió un documento que coincida con el número o referencia solicitados.",
                "DISPATCH_LOOKUP_MISMATCH"
            );
        }
    }

    // ===============================================
    // 7. DEVOLVER CONDUCE
    // ===============================================

    console.log(
        "✅ CONDUCE ENCONTRADO:",
        {
            id: dispatch.ID,
            docId: dispatch.DocID,
            reference: dispatch.Reference,
            itemsCount:
                dispatch.Items?.length ?? 0
        }
    );

    return {
        success: true,
        title: "Conduce encontrado",
        message:
            "El conduce fue obtenido correctamente desde ADM Cloud.",

        data: dispatch
    };
}





// =====================================================
// 🌐 CONTROLLER - GET ADM CLOUD DISPATCH
// =====================================================

export async function getAdmCloudDispatchController(
    req,
    res
) {
    try {
        const {
            id,
            docId,
            reference
        } = req.query;

        console.log("🔍 BUSCANDO CONDUCE:", {
            id,
            docId,
            reference
        });

        const result =
            await getAdmCloudDispatchService({
                id,
                docId,
                reference
            });

        return res.status(200).json(result);

    } catch (error) {

        console.error(
            "❌ ERROR GET ADM CLOUD DISPATCH:",
            error.message
        );

        return res.status(
            error.statusCode || 500
        ).json({
            success: false,
            title:
                error.title ||
                "Error consultando conduce",
            message:
                error.message ||
                "Ocurrió un error inesperado.",
            code:
                error.code ||
                "INTERNAL_ERROR"
        });
    }
}







/**
 * Sincroniza un conduce de ADM Cloud con PostgreSQL.
 *
 * - Busca el conduce completo por GUID.
 * - Inserta o actualiza el encabezado.
 * - Inserta o actualiza todas sus líneas.
 * - Utiliza una transacción independiente.
 *
 * IMPORTANTE:
 * Recibe el pool de PostgreSQL (db), no el client
 * utilizado por closePicking.
 */
export async function syncAdmCloudDispatchService({
    db,
    pickingId,
    saleId,
    dispatchGuid
}) {
    console.log("========================================");
    console.log("🔄 SINCRONIZANDO CONDUCE ADM CLOUD");
    console.log("📦 Picking:", pickingId);
    console.log("🛒 Sale ID:", saleId);
    console.log("🚚 Conduce:", dispatchGuid);
    console.log("========================================");

    const normalizedPickingId = Number(pickingId);
    const normalizedGuid = String(dispatchGuid ?? "")
        .trim()
        .toLowerCase();

    if (
        !Number.isSafeInteger(normalizedPickingId) ||
        normalizedPickingId <= 0 ||
        !GUID_REGEX.test(normalizedGuid)
    ) {
        throw new Error(
            "Identificadores inválidos para sincronizar el conduce."
        );
    }

    // =====================================================
    // 1. CONSULTAR CONDUCE COMPLETO EN ADM CLOUD
    // =====================================================

    const result = await getAdmCloudDispatchService({
        id: normalizedGuid
    });

    if (!result?.success || !result.data) {
        throw new Error(
            "No se pudo obtener el conduce desde ADM Cloud."
        );
    }

    const dispatch = result.data;

    if (
        String(dispatch.ID ?? "").toLowerCase() !==
        normalizedGuid
    ) {
        throw new Error(
            "El GUID del conduce obtenido no coincide con el solicitado."
        );
    }

    if (!Array.isArray(dispatch.Items)) {
        throw new Error(
            "ADM Cloud no devolvió un arreglo Items válido."
        );
    }

    const items = dispatch.Items;

    // Validamos antes de modificar PostgreSQL.
    const lineIds = new Set();

    for (const item of items) {
        const lineId = String(item.ID ?? "").toLowerCase();
        const transId = String(item.TransID ?? "").toLowerCase();

        if (!GUID_REGEX.test(lineId)) {
            throw new Error(
                "ADM Cloud devolvió una línea sin ID válido."
            );
        }

        if (transId !== normalizedGuid) {
            throw new Error(
                `La línea ${lineId} pertenece a otro conduce.`
            );
        }

        if (lineIds.has(lineId)) {
            throw new Error(
                `La línea ${lineId} aparece duplicada.`
            );
        }

        lineIds.add(lineId);
    }

    console.log("✅ Conduce obtenido:", {
        docId: dispatch.DocID,
        items: items.length
    });

    const toDate = (value) =>
        value ? String(value).slice(0, 10) : null;

    // =====================================================
    // 2. ABRIR UNA NUEVA CONEXIÓN
    // =====================================================

    const client = await db.connect();
    let transactionStarted = false;

    try {
        await client.query("BEGIN");
        transactionStarted = true;

        // =================================================
        // 3. INSERTAR O ACTUALIZAR ENCABEZADO
        // =================================================

        const headerResult = await client.query(
            `
            INSERT INTO public.admcloud_dispatches (
                picking_id,
                sale_id,
                erp_conduce_id,
                erp_doc_id,
                erp_reference,
                erp_relationship_id,
                erp_relationship_name,
                erp_location_id,
                erp_ship_to_address_id,
                erp_ship_to_address1,
                erp_ship_to_address2,
                erp_billing_status_desc,
                erp_status,
                erp_creation_date,
                erp_calculated_total_cost,
                erp_doc_type,
                erp_doc_date
            )
            VALUES (
                $1, $2, $3, $4, $5, $6,
                $7, $8, $9, $10, $11, $12,
                $13, $14, $15, $16, $17
            )
            ON CONFLICT (erp_conduce_id)
            DO UPDATE SET
                erp_doc_id = EXCLUDED.erp_doc_id,
                erp_reference = EXCLUDED.erp_reference,
                erp_relationship_id = EXCLUDED.erp_relationship_id,
                erp_relationship_name = EXCLUDED.erp_relationship_name,
                erp_location_id = EXCLUDED.erp_location_id,
                erp_ship_to_address_id = EXCLUDED.erp_ship_to_address_id,
                erp_ship_to_address1 = EXCLUDED.erp_ship_to_address1,
                erp_ship_to_address2 = EXCLUDED.erp_ship_to_address2,
                erp_billing_status_desc = EXCLUDED.erp_billing_status_desc,
                erp_status = EXCLUDED.erp_status,
                erp_creation_date = EXCLUDED.erp_creation_date,
                erp_calculated_total_cost =
                    EXCLUDED.erp_calculated_total_cost,
                erp_doc_type = EXCLUDED.erp_doc_type,
                erp_doc_date = EXCLUDED.erp_doc_date,
                updated_at = NOW()

            -- No permitir que un conduce cambie de picking.
            WHERE
                admcloud_dispatches.picking_id =
                    EXCLUDED.picking_id
                AND admcloud_dispatches.sale_id
                    IS NOT DISTINCT FROM EXCLUDED.sale_id

            RETURNING id
            `,
            [
                normalizedPickingId,
                saleId,
                dispatch.ID,
                dispatch.DocID,
                dispatch.Reference,
                dispatch.RelationshipID,
                dispatch.RelationshipName,
                dispatch.LocationID,
                dispatch.ShipToAddressID,
                dispatch.ShipToAddress1,
                dispatch.ShipToAddress2,
                dispatch.BillingStatusDesc,
                dispatch.Status,
                dispatch.CreationDate,
                dispatch.CalculatedTotalCost,
                dispatch.DocType,
                toDate(dispatch.DocDate)
            ]
        );

        if (headerResult.rowCount !== 1) {
            throw new Error(
                "El conduce ya está asociado a otro picking u orden de venta."
            );
        }

        const admcloudDispatchId = headerResult.rows[0].id;

        console.log(
            "✅ Encabezado sincronizado:",
            admcloudDispatchId
        );

        // =================================================
        // 4. INSERTAR O ACTUALIZAR CADA LÍNEA
        // =================================================

        let syncedLines = 0;

        for (const item of items) {
            await client.query(
                `
                INSERT INTO public.admcloud_dispatch_lines (
                    admcloud_dispatch_id,
                    erp_line_id,
                    erp_trans_id,
                    erp_row_order,
                    erp_item_id,
                    erp_name,
                    erp_item_sku,
                    erp_quantity,
                    erp_completed_quantity,
                    erp_pending_completed_quantity,
                    erp_uom_name,
                    erp_uom_factor,
                    erp_uom_id,
                    erp_source_transaction_id,
                    erp_source_row_id,
                    erp_source_transaction_type,
                    erp_source_transaction_type_name,
                    erp_source_transaction_doc_date,
                    erp_source_transaction_doc_date_string,
                    erp_source_transaction_reference,
                    erp_source_transaction_relationship_id,
                    erp_source_transaction_relationship_name
                )
                VALUES (
                    $1, $2, $3, $4, $5, $6,
                    $7, $8, $9, $10, $11, $12,
                    $13, $14, $15, $16, $17, $18,
                    $19, $20, $21, $22
                )
                ON CONFLICT (erp_line_id)
                DO UPDATE SET
                    erp_trans_id = EXCLUDED.erp_trans_id,
                    erp_row_order = EXCLUDED.erp_row_order,
                    erp_item_id = EXCLUDED.erp_item_id,
                    erp_name = EXCLUDED.erp_name,
                    erp_item_sku = EXCLUDED.erp_item_sku,
                    erp_quantity = EXCLUDED.erp_quantity,
                    erp_completed_quantity =
                        EXCLUDED.erp_completed_quantity,
                    erp_pending_completed_quantity =
                        EXCLUDED.erp_pending_completed_quantity,
                    erp_uom_name = EXCLUDED.erp_uom_name,
                    erp_uom_factor = EXCLUDED.erp_uom_factor,
                    erp_uom_id = EXCLUDED.erp_uom_id,
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
                    erp_source_transaction_doc_date_string =
                        EXCLUDED.erp_source_transaction_doc_date_string,
                    erp_source_transaction_reference =
                        EXCLUDED.erp_source_transaction_reference,
                    erp_source_transaction_relationship_id =
                        EXCLUDED.erp_source_transaction_relationship_id,
                    erp_source_transaction_relationship_name =
                        EXCLUDED.erp_source_transaction_relationship_name,
                    updated_at = NOW()

                -- Evitar reasignar una línea a otro encabezado.
                WHERE
                    admcloud_dispatch_lines.admcloud_dispatch_id =
                        EXCLUDED.admcloud_dispatch_id

                RETURNING id
                `,
                [
                    admcloudDispatchId,
                    item.ID,
                    item.TransID,
                    item.RowOrder,
                    item.ItemID,
                    item.Name,
                    item.ItemSKU,
                    item.Quantity,
                    item.CompletedQuantity,
                    item.PendingCompletedQuantity,
                    item.UOMName,
                    item.UOMFactor,
                    item.UOMID,
                    item.SourceTransactionID,
                    item.SourceRowID,
                    item.SourceTransactionType,
                    item.SourceTransactionTypeName,
                    toDate(item.SourceTransactionDocDate),
                    item.SourceTransactionDocDateString,
                    item.SourceTransactionReference,
                    item.SourceTransactionRelationshipID,
                    item.SourceTransactionRelationshipName
                ]
            ).then((lineResult) => {
                if (lineResult.rowCount !== 1) {
                    throw new Error(
                        `La línea ${item.ID} está asociada a otro conduce.`
                    );
                }
            });

            syncedLines++;
        }

        // =================================================
        // 5. CONFIRMAR SINCRONIZACIÓN
        // =================================================

        await client.query("COMMIT");
        transactionStarted = false;

        console.log("========================================");
        console.log("✅ CONDUCE SINCRONIZADO CORRECTAMENTE");
        console.log("📄 Documento:", dispatch.DocID);
        console.log("📦 Picking:", normalizedPickingId);
        console.log("📋 Líneas sincronizadas:", syncedLines);
        console.log("========================================");

        return {
            success: true,
            title: "Conduce sincronizado",
            message:
                "El encabezado y sus líneas fueron sincronizados correctamente.",
            data: {
                pickingId: normalizedPickingId,
                saleId,
                dispatchGuid: normalizedGuid,
                admcloudDispatchId,
                docId: dispatch.DocID,
                syncedLines
            }
        };

    } catch (error) {
        if (transactionStarted) {
            try {
                await client.query("ROLLBACK");
                console.log("🔄 ROLLBACK sincronización ADM Cloud");
            } catch (rollbackError) {
                console.error(
                    "❌ Error en ROLLBACK:",
                    rollbackError.message
                );
            }
        }

        console.error(
            "❌ ERROR SINCRONIZANDO CONDUCE:",
            error.message
        );

        throw error;

    } finally {
        client.release();
    }
}
