import admcloudClient from "./admcloudClient.js";
import db from "../../db.js";

const GUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TERMINAL_STATES = new Set([
  "done",
  "cancel",
]);

/*
 * Debe coincidir con esta restricción:
 *
 * UNIQUE (
 *   picking_id,
 *   source_transaction_id,
 *   erp_move_id,
 *   erp_product_id
 * )
 */
const DISPATCH_UNIQUE_CONSTRAINT =
  "uq_despacho_move_source_product";

// =====================================================
// CREAR ERROR CONTROLADO
// =====================================================

function createServiceError(
  statusCode,
  title,
  message,
  code = "ERROR"
) {
  return Object.assign(
    new Error(message),
    {
      statusCode,
      title,
      code,
    }
  );
}

// =====================================================
// NORMALIZAR Y VALIDAR GUID
// =====================================================

function normalizeGuid(
  value,
  fieldName,
  statusCode = 422
) {
  const normalized =
    String(value ?? "")
      .trim()
      .toLowerCase();

  if (!GUID_REGEX.test(normalized)) {
    throw createServiceError(
      statusCode,
      "GUID inválido",
      `${fieldName} no es un GUID válido: ${value ?? "vacío"
      }.`,
      "INVALID_GUID"
    );
  }

  return normalized;
}

// =====================================================
// NORMALIZAR CANTIDADES
// =====================================================

function normalizeNonNegativeNumber(
  value,
  {
    fieldName,
    context,
    defaultValue = 0,
  }
) {
  const normalizedValue =
    value === null ||
      value === undefined ||
      String(value).trim() === ""
      ? defaultValue
      : Number(value);

  if (
    !Number.isFinite(normalizedValue) ||
    normalizedValue < 0
  ) {
    throw createServiceError(
      422,
      "Cantidad inválida",
      `${fieldName} inválido en ${context}: ${value}`,
      "INVALID_DISPATCH_QUANTITY"
    );
  }

  return normalizedValue;
}

// =====================================================
// EXTRAER LAS LÍNEAS DE LA RESPUESTA ADM CLOUD
// =====================================================

function extractPendingDispatchRows(
  payload
) {
  if (Array.isArray(payload)) {
    return payload;
  }

  const possibleArrays = [
    payload?.items,
    payload?.Items,
    payload?.rows,
    payload?.Rows,
    payload?.results,
    payload?.Results,
    payload?.data,
    payload?.Data,
  ];

  for (
    const possibleArray of
    possibleArrays
  ) {
    if (
      Array.isArray(
        possibleArray
      )
    ) {
      return possibleArray;
    }
  }

  throw createServiceError(
    502,
    "Respuesta inválida de ADM Cloud",
    "No se encontró un arreglo con los pendientes de despacho.",
    "INVALID_PENDING_DISPATCH_RESPONSE"
  );
}

// =====================================================
// CONSULTAR PENDIENTES DE DESPACHO EN ADM CLOUD
// =====================================================

export async function getPendingDispatchBySalesOrderService(
  saleId,
  options = {}
) {
  const normalizedSaleId =
    normalizeGuid(
      saleId,
      "saleId",
      400
    );

  const skip =
    Number(
      options.skip ?? 0
    );

  if (
    !Number.isSafeInteger(skip) ||
    skip < 0
  ) {
    throw createServiceError(
      400,
      "Paginación inválida",
      "skip debe ser un número entero mayor o igual a cero.",
      "INVALID_SKIP"
    );
  }

  const params = {
    skip,

    /*
     * GUID de la orden de venta.
     */
    SourceTransactionID:
      normalizedSaleId,
  };

  if (options.locationId) {
    params.LocationID =
      String(
        options.locationId
      ).trim();
  }

  if (options.itemId) {
    params.ItemID =
      String(
        options.itemId
      ).trim();
  }

  if (options.relationshipId) {
    params.RelationshipID =
      String(
        options.relationshipId
      ).trim();
  }

  if (options.dateFrom) {
    params.DateFrom =
      String(
        options.dateFrom
      ).trim();
  }

  if (options.dateTo) {
    params.DateTo =
      String(
        options.dateTo
      ).trim();
  }

  console.log(
    "======================================"
  );

  console.log(
    "📦 CONSULTANDO PENDIENTES ADM CLOUD"
  );

  console.log(
    "======================================"
  );

  console.log(
    "🔗 Request ADM Cloud:",
    {
      method: "GET",
      endpoint:
        "/InventoryReports/PendingDispatchByItem",
      params,
    }
  );

  try {
    const response =
      await admcloudClient.get(
        "/InventoryReports/PendingDispatchByItem",
        {
          params,
        }
      );

    const apiResponse =
      response.data;

    console.log(
      "✅ HTTP STATUS ADM CLOUD:",
      response.status
    );

    console.log(
      "📦 RESPUESTA COMPLETA ADM CLOUD:"
    );

    console.dir(
      apiResponse,
      {
        depth: null,
        colors: true,
      }
    );

    if (
      apiResponse?.success === false
    ) {
      throw createServiceError(
        422,
        "ADM Cloud rechazó la consulta",
        apiResponse.message ||
        "ADM Cloud no pudo obtener los pendientes de despacho.",
        "ADM_CLOUD_REQUEST_REJECTED"
      );
    }

    const responsePayload =
      apiResponse?.data ??
      apiResponse;

    const rows =
      extractPendingDispatchRows(
        responsePayload
      );

    return {
      request: {
        endpoint:
          "/InventoryReports/PendingDispatchByItem",

        params,
      },

      httpStatus:
        response.status,

      rawResponse:
        apiResponse,

      data:
        rows,
    };
  } catch (error) {
    /*
     * Si es un error creado por nuestro servicio,
     * se conserva sin modificar.
     */
    if (error.statusCode) {
      throw error;
    }

    const admCloudStatus =
      Number(
        error.response?.status
      ) || null;

    const admCloudData =
      error.response?.data ??
      null;

    console.error(
      "❌ ERROR CONSULTANDO PENDIENTES ADM CLOUD:",
      {
        message:
          error.message,

        status:
          admCloudStatus,

        data:
          admCloudData,
      }
    );

    throw Object.assign(
      new Error(
        admCloudData?.message ||
        error.message ||
        "No se pudo consultar ADM Cloud."
      ),
      {
        statusCode:
          admCloudStatus &&
            admCloudStatus >= 400 &&
            admCloudStatus <= 599
            ? admCloudStatus
            : 502,

        title:
          "Error consultando ADM Cloud",

        code:
          "ADM_CLOUD_PENDING_DISPATCH_ERROR",

        admCloudStatus,

        admCloudData,
      }
    );
  }
}

// =====================================================
// NORMALIZAR LÍNEAS PENDIENTES
// =====================================================

function normalizePendingRows(
  pendingRows,
  sourceTransactionId
) {
  const summary = {
    received:
      pendingRows.length,

    validLines: 0,

    inserted: 0,

    updated: 0,

    skippedServices: 0,

    protectedMoves: [],
  };

  const normalizedLines = [];

  /*
   * row.ID puede repetirse porque en la respuesta
   * representa el documento.
   *
   * Por eso la identidad utiliza:
   *
   * sourceTransactionId
   * + row.ID
   * + row.ItemID
   */
  const seenCompositeKeys =
    new Set();

  for (
    const row of pendingRows
  ) {
    /*
     * Ignorar servicios.
     */
    if (
      row?.ItemType === "S"
    ) {
      summary.skippedServices += 1;

      continue;
    }

    /*
     * Solamente se procesan artículos de inventario.
     */
    if (
      row?.ItemType &&
      row.ItemType !== "I"
    ) {
      throw createServiceError(
        422,
        "Tipo de artículo inválido",
        `ItemType no contemplado: ${row.ItemType}.`,
        "UNSUPPORTED_ITEM_TYPE"
      );
    }

    /*
     * MAPEO OBLIGATORIO:
     *
     * row.ID
     *     ↓
     * despacho_stock_move.erp_move_id
     */
    const erpMoveId =
      normalizeGuid(
        row?.ID,
        "row.ID"
      );

    /*
     * MAPEO OBLIGATORIO:
     *
     * row.ItemID
     *     ↓
     * despacho_stock_move.erp_product_id
     */
    const productErpId =
      normalizeGuid(
        row?.ItemID,
        "row.ItemID"
      );

    const compositeKey =
      [
        sourceTransactionId,
        erpMoveId,
        productErpId,
      ].join(":");

    if (
      seenCompositeKeys.has(
        compositeKey
      )
    ) {
      throw createServiceError(
        409,
        "Movimiento repetido",
        `ADM Cloud devolvió más de una línea para ` +
        `row.ID ${erpMoveId} y producto ${productErpId}.`,
        "DUPLICATED_PENDING_MOVE"
      );
    }

    seenCompositeKeys.add(
      compositeKey
    );

    const context =
      `pedido ${row?.DocID ??
      sourceTransactionId
      }, producto ${row?.SKU ??
      productErpId
      }`;

    /*
     * Cantidad originalmente ordenada.
     */
    const productQty =
      normalizeNonNegativeNumber(
        row.QuantityOrdered,
        {
          fieldName:
            "QuantityOrdered",

          context,
        }
      );

    /*
     * Cantidad ya completada/despachada.
     */
    const quantityDone =
      normalizeNonNegativeNumber(
        row.QuantityCompleted,
        {
          fieldName:
            "QuantityCompleted",

          context,
        }
      );


    const salesUomId =
      normalizeGuid(
        row.SalesUOMID,
        `SalesUOMID del producto ${row.ItemID ??
        row.SKU ??
        "desconocido"
        }`,
        502
      );

    /*
     * Cantidad pendiente por despachar.
     */
    const pendingQty =
      normalizeNonNegativeNumber(
        row.PendingQuantity,
        {
          fieldName:
            "PendingQuantity",

          context,
        }
      );

    /*
     * Esta validación coincide con el CHECK:
     *
     * pending_qty <= product_qty
     */
    if (
      pendingQty >
      productQty
    ) {
      throw createServiceError(
        422,
        "Cantidad pendiente inválida",
        `PendingQuantity (${pendingQty}) no puede superar ` +
        `QuantityOrdered (${productQty}) en ${context}.`,
        "PENDING_QUANTITY_EXCEEDS_ORDERED"
      );
    }

    /*
     * Validación informativa.
     *
     * Se guarda PendingQuantity porque es el valor oficial
     * enviado por ADM Cloud.
     */
    const calculatedPending =
      Math.max(
        productQty -
        quantityDone,
        0
      );

    if (
      Math.abs(
        calculatedPending -
        pendingQty
      ) > 0.0001
    ) {
      console.warn(
        "⚠️ Cantidades ADM Cloud no coinciden:",
        {
          erpMoveId,
          productErpId,
          productQty,
          quantityDone,
          pendingQty,
          calculatedPending,
        }
      );
    }

    normalizedLines.push({
      /*
       * row.ID
       */
      erpMoveId,

      /*
       * GUID de la orden:
       * stock_picking.sale_id
       */
      sourceTransactionId,

      /*
       * row.ItemID
       */
      productErpId,

      docId:
        String(
          row.DocID ??
          sourceTransactionId
        ).trim(),

      admSku:
        String(
          row.SKU ?? ""
        ).trim(),

      itemName:
        String(
          row.ItemName ?? ""
        ).trim(),

      productQty,

      quantityDone,

      pendingQty,

      // Nueva propiedad
      salesUomId,
    });
  }

  summary.validLines =
    normalizedLines.length;

  return {
    summary,
    normalizedLines,
  };
}



// =====================================================
// ELIMINAR MOVIMIENTOS BORRADOS EN ADM CLOUD
// =====================================================

export async function deleteMissingDispatchMoves(
  clientDb,
  {
    missingDispatchMoves,
    pickingId,
    orderGuid,
  }
) {
  const EPSILON = 0.000001;

  if (!Array.isArray(missingDispatchMoves)) {
    throw createServiceError(
      400,
      "Líneas inválidas",
      "missingDispatchMoves debe ser un arreglo.",
      "INVALID_MISSING_DISPATCH_MOVES"
    );
  }

  const pickingIdInt =
    Number(pickingId);

  if (
    !Number.isSafeInteger(pickingIdInt) ||
    pickingIdInt <= 0
  ) {
    throw createServiceError(
      400,
      "Picking inválido",
      "pickingId debe ser un entero positivo.",
      "INVALID_PICKING_ID"
    );
  }

  const sourceTransactionId =
    normalizeGuid(
      orderGuid,
      "orderGuid",
      400
    );

  const result = {
    requested:
      missingDispatchMoves.length,

    deleted:
      0,

    deletedMoveLines:
      0,

    protected:
      0,

    notFound:
      0,

    deletedMoves: [],

    protectedMoves: [],

    notFoundMoves: [],
  };

  if (missingDispatchMoves.length === 0) {
    console.log(
      "✅ No existen movimientos eliminados para procesar."
    );

    return result;
  }

  // Evitar procesar dos veces el mismo ID.
  const uniqueMoveIds =
    new Set();

  for (const missingMove of missingDispatchMoves) {
    const moveId =
      Number(missingMove?.id);

    if (
      !Number.isSafeInteger(moveId) ||
      moveId <= 0
    ) {
      throw createServiceError(
        400,
        "Movimiento inválido",
        `Movimiento eliminado con ID inválido: ${missingMove?.id ?? "vacío"
        }.`,
        "INVALID_MISSING_MOVE_ID"
      );
    }

    if (uniqueMoveIds.has(moveId)) {
      continue;
    }

    uniqueMoveIds.add(moveId);

    // =================================================
    // 1. BUSCAR Y BLOQUEAR despacho_stock_move
    // =================================================

    const dispatchMoveResult =
      await clientDb.query(
        `
          SELECT
            id,
            name,
            state,
            product_id,
            product_qty,
            quantity_done,
            pending_qty,
            picking_id,
            erp_move_id,
            erp_product_id,
            source_transaction_id,
            sku
          FROM despacho_stock_move
          WHERE id = $1
            AND picking_id = $2
            AND LOWER(
              source_transaction_id::text
            ) = $3
          LIMIT 1
          FOR UPDATE
        `,
        [
          moveId,
          pickingIdInt,
          sourceTransactionId,
        ]
      );

    const dispatchMove =
      dispatchMoveResult.rows[0];

    if (!dispatchMove) {
      result.notFound += 1;

      result.notFoundMoves.push({
        id:
          moveId,

        reason:
          "El movimiento ya no existe o no pertenece al picking.",
      });

      continue;
    }

    // =================================================
    // 2. BLOQUEAR SUS stock_move_line
    // =================================================

    const moveLinesResult =
      await clientDb.query(
        `
          SELECT
            id,
            move_id,
            picking_id,
            product_id,
            product_uom_qty,
            qty_done,
            state,
            location_id,
            warehouse_id
          FROM stock_move_line
          WHERE move_id = $1
            AND picking_id = $2
          ORDER BY id ASC
          FOR UPDATE
        `,
        [
          moveId,
          pickingIdInt,
        ]
      );

    const moveLines =
      moveLinesResult.rows;

    // =================================================
    // 3. VERIFICAR SI TIENE TRABAJO PROCESADO
    // =================================================

    const parentHasProcessedQty =
      Number(
        dispatchMove.quantity_done ?? 0
      ) > EPSILON;

    const hasProcessedMoveLines =
      moveLines.some(
        (line) =>
          Number(
            line.qty_done ?? 0
          ) > EPSILON ||
          String(
            line.state ?? ""
          ).toLowerCase() === "done"
      );

    const isTerminalMove =
      ["done", "cancel"].includes(
        String(
          dispatchMove.state ?? ""
        ).toLowerCase()
      );

    /*
     * No borrar físicamente un movimiento que ya
     * tenga cantidades recogidas o historial terminado.
     */
    if (
      parentHasProcessedQty ||
      hasProcessedMoveLines ||
      isTerminalMove
    ) {
      result.protected += 1;

      result.protectedMoves.push({
        id:
          dispatchMove.id,

        name:
          dispatchMove.name,

        sku:
          dispatchMove.sku,

        state:
          dispatchMove.state,

        quantity_done:
          dispatchMove.quantity_done,

        erp_move_id:
          dispatchMove.erp_move_id,

        erp_product_id:
          dispatchMove.erp_product_id,

        reason:
          isTerminalMove
            ? "El movimiento está finalizado o cancelado."
            : "El movimiento tiene cantidades procesadas.",
      });

      console.log(
        "\x1b[41m\x1b[37m\x1b[1m" +
        ` ⛔ MOVIMIENTO ${moveId} PROTEGIDO; NO FUE ELIMINADO ` +
        "\x1b[0m"
      );

      continue;
    }

    // =================================================
    // 4. ELIMINAR stock_move_line PRIMERO
    // =================================================

    /*
     * Es obligatorio eliminar primero las líneas hijas
     * porque move_id tiene una llave foránea hacia
     * despacho_stock_move con ON DELETE RESTRICT.
     */
    const deletedMoveLinesResult =
      await clientDb.query(
        `
          DELETE FROM stock_move_line
          WHERE move_id = $1
            AND picking_id = $2
            AND COALESCE(qty_done, 0) = 0
            AND COALESCE(state, '') <> 'done'
          RETURNING
            id,
            move_id,
            product_id,
            product_uom_qty,
            state
        `,
        [
          moveId,
          pickingIdInt,
        ]
      );

    /*
     * Como previamente comprobamos que no existe
     * actividad procesada, deben haberse eliminado
     * todas las líneas hijas.
     */
    if (
      deletedMoveLinesResult.rowCount !==
      moveLines.length
    ) {
      throw createServiceError(
        409,
        "No se eliminaron todas las líneas",
        `No se pudieron eliminar todas las stock_move_line ` +
        `del movimiento ${moveId}.`,
        "MOVE_LINES_NOT_COMPLETELY_DELETED"
      );
    }

    // =================================================
    // 5. ELIMINAR despacho_stock_move
    // =================================================

    const deletedMoveResult =
      await clientDb.query(
        `
          DELETE FROM despacho_stock_move
          WHERE id = $1
            AND picking_id = $2
            AND LOWER(
              source_transaction_id::text
            ) = $3
            AND COALESCE(quantity_done, 0) = 0
            AND COALESCE(state, '')
                NOT IN ('done', 'cancel')
          RETURNING
            id,
            name,
            sku,
            state,
            product_qty,
            pending_qty,
            erp_move_id,
            erp_product_id
        `,
        [
          moveId,
          pickingIdInt,
          sourceTransactionId,
        ]
      );

    if (
      deletedMoveResult.rowCount !== 1
    ) {
      throw createServiceError(
        409,
        "Movimiento no eliminado",
        `No se pudo eliminar despacho_stock_move ${moveId}.`,
        "DISPATCH_MOVE_NOT_DELETED"
      );
    }

    const deletedMove =
      deletedMoveResult.rows[0];

    result.deleted += 1;

    result.deletedMoveLines +=
      deletedMoveLinesResult.rowCount;

    result.deletedMoves.push({
      ...deletedMove,

      deleted_move_lines:
        deletedMoveLinesResult.rowCount,
    });

    // =================================================
    // 6. LOG ROJO
    // =================================================

    const RED_STYLE =
      "\x1b[41m\x1b[37m\x1b[1m";

    const RESET_STYLE =
      "\x1b[0m";

    console.log(
      `${RED_STYLE} 🗑️ MOVIMIENTO ELIMINADO DEL WMS ${RESET_STYLE}`
    );

    console.log(RED_STYLE);

    console.table([
      {
        id:
          deletedMove.id,

        name:
          deletedMove.name,

        sku:
          deletedMove.sku,

        product_qty:
          deletedMove.product_qty,

        pending_qty:
          deletedMove.pending_qty,

        erp_move_id:
          deletedMove.erp_move_id,

        erp_product_id:
          deletedMove.erp_product_id,

        deleted_move_lines:
          deletedMoveLinesResult.rowCount,
      },
    ]);

    console.log(RESET_STYLE);
  }

  console.log(
    "🧹 Resultado eliminación de movimientos:",
    result
  );

  return result;
}



// =====================================================
// SINCRONIZAR despacho_stock_move
//
// Debe ejecutarse dentro de una transacción.
//
// El controller realiza:
// BEGIN
// COMMIT
// ROLLBACK
// =====================================================

export async function syncAdmCloudPendingDispatchMoves(
  clientDb,
  pendingRows,
  pickingId,
  orderGuid
) {
  // ===================================================
  // DEBUG CON FONDO AMARILLO
  // ===================================================

  const YELLOW_BACKGROUND =
    "\x1b[43m";

  const BLACK_TEXT =
    "\x1b[30m";

  const BOLD_TEXT =
    "\x1b[1m";

  const RESET_COLOR =
    "\x1b[0m";

  const yellowStyle =
    `${YELLOW_BACKGROUND}${BLACK_TEXT}${BOLD_TEXT}`;

  console.log(
    `${yellowStyle} 📦 SINCRONIZACIÓN DE DESPACHO ADM CLOUD ${RESET_COLOR}`
  );

  // Información general
  console.log(yellowStyle);

  console.table([
    {
      picking_id:
        pickingId,

      order_guid:
        orderGuid,

      pending_rows:
        Array.isArray(pendingRows)
          ? pendingRows.length
          : "INVALIDO",
    },
  ]);

  console.log(RESET_COLOR);

  // Líneas recibidas
  console.log(
    `${yellowStyle} 📋 PENDING ROWS RECIBIDOS ${RESET_COLOR}`
  );

  if (Array.isArray(pendingRows)) {
    console.log(yellowStyle);

    console.table(
      pendingRows.map(
        (row, index) => ({
          index:
            index + 1,

          picking_id:
            pickingId,

          order_guid:
            orderGuid,

          erp_move_id:
            row?.ID ?? null,

          erp_product_id:
            row?.ItemID ?? null,

          sku:
            row?.SKU ?? null,

          producto:
            row?.ItemName ?? null,

          sales_uom_id:
            row?.SalesUOMID ?? null,

          uom_name:
            row?.UOMName ?? null,

          ordered:
            row?.QuantityOrdered ?? 0,

          completed:
            row?.QuantityCompleted ?? 0,

          pending:
            row?.PendingQuantity ?? 0,
        })
      )
    );

    console.log(RESET_COLOR);
  } else {
    console.log(
      `${yellowStyle} pendingRows no es un arreglo ${RESET_COLOR}`
    );

    console.log(
      "Valor recibido:",
      pendingRows
    );
  }

  // ===================================================
  // VALIDACIÓN ORIGINAL
  // ===================================================



  if (
    !Array.isArray(
      pendingRows
    )
  ) {
    throw createServiceError(
      502,
      "Respuesta inválida",
      "Los pendientes de ADM Cloud no son un arreglo.",
      "INVALID_PENDING_ROWS"
    );
  }

  const pickingIdInt =
    Number(
      pickingId
    );

  if (
    !Number.isSafeInteger(
      pickingIdInt
    ) ||
    pickingIdInt <= 0
  ) {
    throw createServiceError(
      400,
      "Picking inválido",
      "pickingId debe ser un entero positivo.",
      "INVALID_PICKING_ID"
    );
  }

  /*
   * MAPEO OBLIGATORIO:
   *
   * stock_picking.sale_id
   *     ↓
   * despacho_stock_move.source_transaction_id
   */
  const sourceTransactionId =
    normalizeGuid(
      orderGuid,
      "orderGuid",
      400
    );

  const {
    summary,
    normalizedLines,
  } =
    normalizePendingRows(
      pendingRows,
      sourceTransactionId
    );

  // ===================================================
  // 1. BLOQUEAR PICKING
  // ===================================================

  const pickingResult =
    await clientDb.query(
      `
        SELECT
          id,
          name,
          state,
          sale_id
        FROM stock_picking
        WHERE id = $1
        FOR UPDATE
      `,
      [
        pickingIdInt
      ]
    );

  const picking =
    pickingResult.rows[0];

  if (!picking) {
    throw createServiceError(
      404,
      "Picking no encontrado",
      `No existe el picking ${pickingIdInt}.`,
      "PICKING_NOT_FOUND"
    );
  }

  const lockedSaleId =
    String(
      picking.sale_id ?? ""
    )
      .trim()
      .toLowerCase();

  /*
   * Verificar que el picking no haya cambiado
   * mientras se consultaba ADM Cloud.
   */
  if (
    lockedSaleId !==
    sourceTransactionId
  ) {
    throw createServiceError(
      409,
      "El pedido del picking cambió",
      "El sale_id cambió mientras se consultaba ADM Cloud.",
      "PICKING_SALE_ID_CHANGED"
    );
  }

  // ===================================================
  // 2. BLOQUEAR SINCRONIZACIÓN DE LA ORDEN
  // ===================================================

  /*
   * Evita que dos solicitudes sincronicen
   * simultáneamente la misma orden.
   */
  await clientDb.query(
    `
      SELECT pg_advisory_xact_lock(
        hashtextextended($1, 0)
      )
    `,
    [
      `admcloud:pending-dispatch:${sourceTransactionId}`
    ]
  );

  //Aqui quiero buscar con el picking id todas las lineas de despacho_Stock_move que tengan picking id igual y obtenerlos y luego aqui en una tabla con background amarillo id, name, state, product_qty, pending_qty, erp_move_id, erp_product_id que no esten cancel ni completed. entonces luego con esa informacion y cada linea que existe en mi db se compara con la que llegaron pendingRows y ahi se obtiene cual fue la linea que se elimine y haces console log de esa para identificarla con background red.
  // ===================================================
  // 2B. COMPARAR LÍNEAS LOCALES CONTRA ADM CLOUD
  // ===================================================

  /*
   * En este sistema el estado final normalmente es
   * "done", no "completed". Se incluyen ambos por
   * seguridad.
   */
  const localDispatchResult =
    await clientDb.query(
      `
        SELECT
          id,
          name,
          state,
          product_qty,
          pending_qty,
          erp_move_id,
          erp_product_id
        FROM despacho_stock_move
        WHERE picking_id = $1
          AND COALESCE(
            LOWER(state),
            ''
          ) NOT IN (
            'cancel',
            'done',
            'completed'
          )
        ORDER BY id ASC
        FOR UPDATE
      `,
      [
        pickingIdInt
      ]
    );

  const localDispatchMoves =
    localDispatchResult.rows;

  // ===================================================
  // MOSTRAR LÍNEAS LOCALES EN AMARILLO
  // ===================================================

  console.log(
    `${yellowStyle} 📦 LÍNEAS ACTIVAS EN despacho_stock_move ${RESET_COLOR}`
  );

  console.log(yellowStyle);

  console.table(
    localDispatchMoves.map(
      (move) => ({
        id:
          move.id,

        name:
          move.name,

        state:
          move.state,

        product_qty:
          move.product_qty,

        pending_qty:
          move.pending_qty,

        erp_move_id:
          move.erp_move_id,

        erp_product_id:
          move.erp_product_id,
      })
    )
  );

  console.log(RESET_COLOR);

  // ===================================================
  // CREAR IDENTIFICADORES DE LAS LÍNEAS QUE LLEGARON
  // ===================================================

  /*
   * No se compara únicamente erp_move_id porque
   * ADM Cloud está enviando el mismo row.ID para
   * todos los productos de la orden.
   *
   * La identificación correcta utiliza:
   *
   * erp_move_id + erp_product_id
   */
  const pendingMoveKeys =
    new Set(
      normalizedLines.map(
        (line) => {
          const erpMoveId =
            String(
              line.erpMoveId ?? ""
            )
              .trim()
              .toLowerCase();

          const erpProductId =
            String(
              line.productErpId ?? ""
            )
              .trim()
              .toLowerCase();

          return (
            `${erpMoveId}:` +
            `${erpProductId}`
          );
        }
      )
    );

  console.log(
    `${yellowStyle} 🔑 IDENTIFICADORES RECIBIDOS DESDE ADM CLOUD ${RESET_COLOR}`
  );

  console.log(yellowStyle);

  console.table(
    normalizedLines.map(
      (line, index) => ({
        index:
          index + 1,

        erp_move_id:
          line.erpMoveId,

        erp_product_id:
          line.productErpId,

        sku:
          line.admSku,

        product_qty:
          line.productQty,

        pending_qty:
          line.pendingQty,

        sales_uom_id:
          line.salesUomId,
      })
    )
  );

  console.log(RESET_COLOR);

  // ===================================================
  // IDENTIFICAR LÍNEAS QUE YA NO LLEGARON
  // ===================================================

  const missingDispatchMoves =
    localDispatchMoves.filter(
      (move) => {
        const erpMoveId =
          String(
            move.erp_move_id ?? ""
          )
            .trim()
            .toLowerCase();

        const erpProductId =
          String(
            move.erp_product_id ?? ""
          )
            .trim()
            .toLowerCase();

        const localKey =
          `${erpMoveId}:` +
          `${erpProductId}`;

        return !pendingMoveKeys.has(
          localKey
        );
      }
    );

  // ===================================================
  // MOSTRAR LÍNEAS AUSENTES EN ROJO
  // ===================================================

  const RED_BACKGROUND =
    "\x1b[41m";

  const WHITE_TEXT =
    "\x1b[37m";

  const redStyle =
    `${RED_BACKGROUND}${WHITE_TEXT}${BOLD_TEXT}`;

  if (
    missingDispatchMoves.length > 0
  ) {
    console.log(
      `${redStyle} 🚨 LÍNEAS LOCALES QUE YA NO LLEGARON DESDE ADM CLOUD ${RESET_COLOR}`
    );

    console.log(redStyle);

    console.table(
      missingDispatchMoves.map(
        (move) => ({
          id:
            move.id,

          name:
            move.name,

          state:
            move.state,

          product_qty:
            move.product_qty,

          pending_qty:
            move.pending_qty,

          erp_move_id:
            move.erp_move_id,

          erp_product_id:
            move.erp_product_id,

          diagnostico:
            "AUSENTE_EN_PENDING_ROWS",
        })
      )
    );

    console.log(RESET_COLOR);
  } else {
    console.log(
      `${yellowStyle} ✅ No existen líneas locales ausentes en ADM Cloud ${RESET_COLOR}`
    );
  }

  console.log(
    "📊 Resumen de comparación:",
    {
      localActiveLines:
        localDispatchMoves.length,

      admCloudLines:
        normalizedLines.length,

      missingLines:
        missingDispatchMoves.length,
    }
  );



  const deleteMissingResult =
    await deleteMissingDispatchMoves(
      clientDb,
      {
        missingDispatchMoves,

        pickingId:
          pickingIdInt,

        orderGuid:
          sourceTransactionId,
      }
    );

  // Agregar resultado al resumen de sincronización.
  summary.deleted =
    deleteMissingResult.deleted;

  summary.deletedMoveLines =
    deleteMissingResult.deletedMoveLines;

  summary.protectedDeletedMoves =
    deleteMissingResult.protectedMoves;

  summary.missingNotFound =
    deleteMissingResult.notFoundMoves;



  // ===================================================
  // 3. PROCESAR CADA LÍNEA
  // ===================================================

  for (
    const line of
    normalizedLines
  ) {
    // =================================================
    // 3A. BUSCAR PRODUCTO LOCAL
    // =================================================

    /*
     * Buscar products utilizando:
     *
     * products.erp_id = row.ItemID
     */
    const productResult =
      await clientDb.query(
        `
          SELECT
            id,
            sku,
            description,
            uom_id
          FROM products
          WHERE LOWER(
            erp_id::text
          ) = $1
        `,
        [
          line.productErpId
        ]
      );

    if (
      productResult.rows.length !== 1
    ) {
      throw createServiceError(
        422,
        "Producto local no encontrado",
        `Se esperaba un producto local para ` +
        `${line.admSku ||
        line.productErpId
        }; se encontraron ` +
        `${productResult.rows.length}.`,
        "LOCAL_PRODUCT_NOT_FOUND"
      );
    }

    const product =
      productResult.rows[0];

    /*
     * El SKU se obtiene de products,
     * no directamente de ADM Cloud.
     */
    const localSku =
      String(
        product.sku ?? ""
      ).trim();

    if (!localSku) {
      throw createServiceError(
        422,
        "Producto sin SKU",
        `El producto local ${product.id} no tiene SKU.`,
        "LOCAL_PRODUCT_WITHOUT_SKU"
      );
    }

    /*
     * reference se obtiene de:
     *
     * products.description
     */
    const reference =
      String(
        product.description ||
        line.itemName ||
        localSku
      )
        .trim()
        .slice(0, 120);

    /*
     * Generar un nombre identificable.
     */
    const name =
      `DISPATCH-${line.docId}-${localSku}`
        .slice(0, 120);

    // =================================================
    // 3B. BUSCAR MOVIMIENTO EXISTENTE
    // =================================================

    /*
     * La búsqueda utiliza exactamente las columnas
     * de la restricción:
     *
     * uq_despacho_move_source_product
     */
    const existingResult =
      await clientDb.query(
        `
      SELECT
        id,
        state,
        product_id,
        product_uom_id,
        erp_sales_uom_id,
        product_qty,
        quantity_done,
        pending_qty
      FROM despacho_stock_move
      WHERE picking_id = $1
        AND source_transaction_id = $2
        AND erp_move_id = $3
        AND erp_product_id = $4
      FOR UPDATE
    `,
        [
          pickingIdInt,
          line.sourceTransactionId,
          line.erpMoveId,
          line.productErpId,
        ]
      );

    if (
      existingResult.rows.length >
      1
    ) {
      throw createServiceError(
        409,
        "Movimiento duplicado",
        `Existen varios movimientos para picking ` +
        `${pickingIdInt}, orden ` +
        `${line.sourceTransactionId}, row.ID ` +
        `${line.erpMoveId} y producto ` +
        `${line.productErpId}.`,
        "DUPLICATED_LOCAL_DISPATCH_MOVE"
      );
    }

    const currentMove =
      existingResult.rows[0];

    // =================================================
    // 3C. PROTEGER MOVIMIENTOS TERMINADOS
    // =================================================

    if (
      currentMove &&
      TERMINAL_STATES.has(
        currentMove.state
      )
    ) {
      summary.protectedMoves.push({
        id:
          currentMove.id,

        erp_move_id:
          line.erpMoveId,

        source_transaction_id:
          line.sourceTransactionId,

        erp_product_id:
          line.productErpId,

        state:
          currentMove.state,

        reason:
          "Movimiento local finalizado; no fue modificado.",
      });

      continue;
    }

    /*
     * No se pueden agregar movimientos nuevos
     * a un picking cerrado o cancelado.
     */
    if (
      !currentMove &&
      TERMINAL_STATES.has(
        picking.state
      )
    ) {
      throw createServiceError(
        409,
        "Picking finalizado",
        `No se pueden agregar movimientos al picking ${picking.state}.`,
        "PICKING_TERMINAL"
      );
    }

    // =================================================
    // 3D. INSERTAR O ACTUALIZAR
    // =================================================

    /*
     * El ON CONFLICT utiliza la nueva restricción:
     *
     * UNIQUE (
     *   picking_id,
     *   source_transaction_id,
     *   erp_move_id,
     *   erp_product_id
     * )
     */
    const upsertResult =
  await clientDb.query(
    `
      INSERT INTO despacho_stock_move AS dsm (
        name,
        reference,
        state,

        product_id,
        sku,
        erp_product_id,
        product_uom_id,
        erp_sales_uom_id,

        product_qty,
        quantity_done,
        pending_qty,

        picking_id,
        erp_move_id,
        source_transaction_id,

        create_date,
        write_date
      )
      VALUES (
        $1,
        $2,
        'draft',

        $3,
        $4,
        $5,
        $6,
        $7,

        $8,
        $9,
        $10,

        $11,
        $12,
        $13,

        NOW(),
        NOW()
      )

      ON CONFLICT ON CONSTRAINT
        ${DISPATCH_UNIQUE_CONSTRAINT}

      DO UPDATE SET
        name =
          EXCLUDED.name,

        reference =
          EXCLUDED.reference,

        product_id =
          EXCLUDED.product_id,

        sku =
          EXCLUDED.sku,

        product_uom_id =
          EXCLUDED.product_uom_id,

        erp_sales_uom_id =
          EXCLUDED.erp_sales_uom_id,

        product_qty =
          EXCLUDED.product_qty,

        quantity_done =
          EXCLUDED.quantity_done,

        pending_qty =
          EXCLUDED.pending_qty,

        write_date =
          NOW()

      WHERE COALESCE(
        dsm.state,
        ''
      ) NOT IN (
        'done',
        'cancel'
      )

      RETURNING
        id,
        state,
        picking_id,
        erp_move_id,
        source_transaction_id,
        erp_product_id,
        product_id,
        sku,
        product_uom_id,
        erp_sales_uom_id,
        product_qty,
        quantity_done,
        pending_qty
    `,
    [
      // $1 y $2
      name,
      reference,

      // $3 - $7
      product.id,
      localSku,
      line.productErpId,
      product.uom_id,
      line.salesUomId,

      // $8 - $10
      line.productQty,
      line.quantityDone,
      line.pendingQty,

      // $11
      pickingIdInt,

      // $12: row.ID
      line.erpMoveId,

      // $13: GUID de la orden
      line.sourceTransactionId,
    ]
  );

    if (
      upsertResult.rows.length !== 1
    ) {
      throw createServiceError(
        409,
        "Movimiento protegido",
        `No se pudo sincronizar row.ID ` +
        `${line.erpMoveId} y producto ` +
        `${line.productErpId}.`,
        "DISPATCH_MOVE_NOT_SYNCED"
      );
    }

    if (currentMove) {
      summary.updated += 1;
    } else {
      summary.inserted += 1;
    }

    console.log(
      currentMove
        ? "🔄 Movimiento actualizado:"
        : "🟢 Movimiento insertado:",
      upsertResult.rows[0]
    );
  }

  /*
   * No se eliminan movimientos ausentes porque:
   *
   * 1. El endpoint está paginado.
   * 2. Devuelve solamente pendientes.
   * 3. Puede utilizar filtros.
   * 4. Una línea puede desaparecer porque ya fue despachada.
   *
   * Para reconciliar eliminaciones sería necesario
   * obtener todas las páginas antes de modificar líneas ausentes.
   */

  console.log(
    "✅ despacho_stock_move sincronizado:",
    summary
  );

  return summary;
}

// =====================================================
// CONTROLLER
// CONSULTAR ADM CLOUD Y SINCRONIZAR
// =====================================================

export async function getPendingDispatchByPickingController(
  req,
  res
) {
  console.log(
    "======================================"
  );

  console.log(
    "🚚 GET + SYNC PENDING DISPATCH"
  );

  console.log(
    "======================================"
  );

  let clientDb;

  let transactionStarted =
    false;

  let releaseError;

  try {
    const pickingId =
      Number(
        req.params.pickingId
      );

    const skip =
      req.query.skip === undefined
        ? 0
        : Number(
          req.query.skip
        );

    // =================================================
    // 1. VALIDAR PICKING ID
    // =================================================

    if (
      !Number.isSafeInteger(
        pickingId
      ) ||
      pickingId <= 0
    ) {
      return res
        .status(400)
        .json({
          success: false,

          code:
            "INVALID_PICKING_ID",

          title:
            "Picking inválido",

          message:
            "Debes enviar un pickingId entero positivo.",
        });
    }

    // =================================================
    // 2. VALIDAR SKIP
    // =================================================

    if (
      !Number.isSafeInteger(
        skip
      ) ||
      skip < 0
    ) {
      return res
        .status(400)
        .json({
          success: false,

          code:
            "INVALID_SKIP",

          title:
            "Paginación inválida",

          message:
            "skip debe ser un entero mayor o igual a cero.",
        });
    }

    // =================================================
    // 3. BUSCAR PICKING
    // =================================================

    /*
     * Se busca antes de llamar a ADM Cloud.
     * Todavía no se abre la transacción.
     */
    const initialPickingResult =
      await db.query(
        `
          SELECT
            id,
            name,
            sale_id,
            erp_cliente_id,
            erp_cliente
          FROM stock_picking
          WHERE id = $1
          LIMIT 1
        `,
        [
          pickingId
        ]
      );

    const initialPicking =
      initialPickingResult.rows[0];

    if (!initialPicking) {
      return res
        .status(404)
        .json({
          success: false,

          code:
            "PICKING_NOT_FOUND",

          title:
            "Picking no encontrado",

          message:
            `No existe el picking ${pickingId}.`,
        });
    }

    // =================================================
    // 4. OBTENER GUID DE LA ORDEN
    // =================================================

    /*
     * MAPEO:
     *
     * stock_picking.sale_id
     *     ↓
     * despacho_stock_move.source_transaction_id
     */
    const orderGuid =
      normalizeGuid(
        initialPicking.sale_id,
        `sale_id del picking ${pickingId}`,
        422
      );

    console.log(
      "📦 Picking encontrado:",
      {
        pickingId,
        name:
          initialPicking.name,

        /*
         * GUID que se guardará en
         * source_transaction_id.
         */
        orderGuid,
      }
    );

    // =================================================
    // 5. CONSULTAR ADM CLOUD
    // =================================================

    /*
     * La consulta externa se realiza antes de BEGIN
     * para no dejar una transacción abierta mientras
     * se espera la respuesta HTTP.
     */
    const pendingResult =
      await getPendingDispatchBySalesOrderService(
        orderGuid,
        {
          skip,

          locationId:
            req.query.locationId,

          itemId:
            req.query.itemId,

          relationshipId:
            req.query.relationshipId,

          dateFrom:
            req.query.dateFrom,

          dateTo:
            req.query.dateTo,
        }
      );

    // =================================================
    // 6. ABRIR CONEXIÓN Y TRANSACCIÓN
    // =================================================

    clientDb =
      await db.connect();

    await clientDb.query(
      "BEGIN"
    );

    transactionStarted =
      true;

    console.log(
      "🟢 BEGIN ejecutado"
    );

    // =================================================
    // 7. SINCRONIZAR despacho_stock_move
    // =================================================

    const syncSummary =
      await syncAdmCloudPendingDispatchMoves(
        clientDb,

        pendingResult.data,

        pickingId,

        /*
         * Orden GUID:
         *
         * despacho_stock_move.source_transaction_id
         */
        orderGuid
      );

    // =================================================
    // 8. COMMIT
    // =================================================

    await clientDb.query(
      "COMMIT"
    );

    transactionStarted =
      false;

    console.log(
      "✅ COMMIT ejecutado"
    );

    // =================================================
    // 9. RESPUESTA
    // =================================================

    return res
      .status(200)
      .json({
        success: true,

        title:
          "Pendientes sincronizados",

        message:
          pendingResult.data.length > 0
            ? "Los pendientes de despacho fueron sincronizados."
            : "ADM Cloud no devolvió pendientes para esta página.",

        picking: {
          id:
            initialPicking.id,

          name:
            initialPicking.name,

          sale_id:
            orderGuid,

          customer_id:
            initialPicking.erp_cliente_id,

          customer:
            initialPicking.erp_cliente,
        },

        pagination: {
          skip,

          rowsReceived:
            pendingResult.data.length,
        },

        sync:
          syncSummary,

        request:
          pendingResult.request,

        admCloudHttpStatus:
          pendingResult.httpStatus,

        data:
          pendingResult.data,
      });
  } catch (error) {
    // =================================================
    // 10. ROLLBACK
    // =================================================

    if (
      clientDb &&
      transactionStarted
    ) {
      try {
        await clientDb.query(
          "ROLLBACK"
        );

        transactionStarted =
          false;

        console.log(
          "🟠 ROLLBACK ejecutado"
        );
      } catch (
      rollbackError
      ) {
        releaseError =
          rollbackError;

        console.error(
          "❌ Error realizando ROLLBACK:",
          rollbackError.message
        );
      }
    }

    console.error(
      "🔥 ERROR pending-dispatch:",
      {
        message:
          error.message,

        code:
          error.code,

        statusCode:
          error.statusCode,

        admCloudStatus:
          error.admCloudStatus,

        admCloudData:
          error.admCloudData,
      }
    );

    const candidateStatus =
      Number(
        error.statusCode ??
        error.response?.status
      );

    const status =
      Number.isInteger(
        candidateStatus
      ) &&
        candidateStatus >= 400 &&
        candidateStatus <= 599
        ? candidateStatus
        : error.isAxiosError
          ? 502
          : 500;

    return res
      .status(status)
      .json({
        success: false,

        code:
          error.code ||
          "PENDING_DISPATCH_ERROR",

        title:
          error.title ||
          "Error sincronizando pendientes",

        message:
          error.message ||
          "No se pudieron sincronizar los pendientes de despacho.",

        admCloudStatus:
          error.admCloudStatus ||
          null,

        admCloudError:
          error.admCloudData ||
          null,
      });
  } finally {
    // =================================================
    // 11. LIBERAR CONEXIÓN
    // =================================================

    if (clientDb) {
      clientDb.release(
        releaseError
      );
    }

    console.log(
      "🔚 END GET + SYNC PENDING DISPATCH"
    );
  }
}