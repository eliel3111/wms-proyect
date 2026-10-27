// services/admCloudDispatchService.js

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