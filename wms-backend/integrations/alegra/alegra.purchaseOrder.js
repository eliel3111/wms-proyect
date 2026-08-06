//FILE alegra.purchaseOrder.js
/**
 * Sincroniza todas las órdenes recibidas desde Alegra.
 *
 * Esta función debe recibir todas las páginas completas.
 * Si una página falla, no debe llamarse.
 */
export async function reconcileAllPurchaseOrders(
  clientDb,
  alegraOrders
) {
  if (!clientDb) {
    throw new Error(
      "clientDb es requerido"
    );
  }

  if (!Array.isArray(alegraOrders)) {
    throw new Error(
      "alegraOrders debe ser un arreglo"
    );
  }

  console.log("");
  console.log("🟪 ========================================");
  console.log("🟪 RECONCILIACIÓN DE ÓRDENES DE COMPRA");
  console.log(
    "📦 Total recibido desde Alegra:",
    alegraOrders.length
  );
  console.log("🟪 ========================================");

  const summary = {
    received: alegraOrders.length,
    created: 0,
    updated: 0,
    deletedFromErp: 0
  };

  const receivedErpIds = [];

  try {
    await clientDb.query("BEGIN");

    for (const order of alegraOrders) {
      const synchronizedOrder =
        await syncPurchaseOrder(
          clientDb,
          order
        );

      if (!synchronizedOrder) {
        continue;
      }

      receivedErpIds.push(
        String(order.id)
      );

      if (
        synchronizedOrder.action ===
        "created"
      ) {
        summary.created += 1;
      } else {
        summary.updated += 1;
      }
    }

    /*
     * Si Alegra devolvió órdenes, podemos comparar
     * los IDs recibidos contra los IDs locales.
     *
     * Toda orden local que no aparezca en el resultado
     * completo será marcada como eliminada.
     */
    if (receivedErpIds.length > 0) {
      const deletedResult =
        await clientDb.query(
          `
          UPDATE purchase_orders
          SET
            status =
              'cancelled'::purchase_order_status,
            deleted_erp = TRUE,
            erp_write_date = NOW(),
            last_erp_sync_at = NOW()
          WHERE erp_order_id IS NOT NULL
            AND NOT (
              erp_order_id =
              ANY($1::BIGINT[])
            )
            AND deleted_erp = FALSE
          RETURNING
            id,
            erp_order_id,
            purchase_order_number,
            status
          `,
          [receivedErpIds]
        );

      summary.deletedFromErp =
        deletedResult.rowCount;

      for (
        const deletedOrder
        of deletedResult.rows
      ) {
        console.log(
          "🗑️ Orden no encontrada en Alegra:",
          deletedOrder
        );
      }
    } else {
      /*
       * Protección:
       * Si Alegra devuelve un arreglo vacío por algún
       * problema inesperado, no cancelamos todas las
       * órdenes locales automáticamente.
       */
      console.warn(
        "⚠️ Alegra devolvió cero órdenes."
      );

      console.warn(
        "⚠️ No se marcarán órdenes como eliminadas."
      );
    }

    await clientDb.query("COMMIT");

    console.log("");
    console.log("✅ RECONCILIACIÓN COMPLETADA");
    console.log("📊 Resultado:", summary);

    return {
      success: true,
      ...summary
    };
  } catch (error) {
    await clientDb.query("ROLLBACK");

    console.error(
      "🔥 ERROR EN RECONCILIACIÓN:",
      error
    );

    throw error;
  }
}





/**
 * Convierte un valor numérico de Alegra.
 *
 * Alegra normalmente devuelve cantidades y precios
 * como strings.
 */
function toNumber(value, fallback = 0) {
  const parsed = Number(value);

  return Number.isFinite(parsed)
    ? parsed
    : fallback;
}

/**
 * Normaliza los estados recibidos desde Alegra.
 *
 * Alegra puede devolver:
 * - open
 * - close
 * - closed
 * - void
 */
function normalizeAlegraPurchaseOrderStatus(status) {
  const normalized = String(status ?? "")
    .trim()
    .toLowerCase();

  switch (normalized) {
    case "open":
      return "open";

    case "close":
    case "closed":
      return "closed";

    case "void":
    case "cancelled":
    case "canceled":
      return "cancelled";

    default:
      throw new Error(
        `Estado de orden desconocido recibido desde Alegra: ${status}`
      );
  }
}

/**
 * Determina el estado final que se guardará en el WMS.
 *
 * Regla importante:
 * Si la orden ya está partial en el WMS y Alegra
 * todavía la mantiene open, se conserva partial.
 */
function resolveWmsPurchaseOrderStatus({
  alegraStatus,
  existingWmsStatus
}) {
  const normalizedStatus =
    normalizeAlegraPurchaseOrderStatus(
      alegraStatus
    );

  if (normalizedStatus === "closed") {
    return "closed";
  }

  if (normalizedStatus === "cancelled") {
    return "cancelled";
  }

  /*
   * Alegra está open, pero en el WMS ya hubo
   * una recepción parcial.
   */
  if (existingWmsStatus === "partial") {
    return "partial";
  }

  return "open";
}

/**
 * Combina las observaciones y anotaciones de Alegra.
 */
function getPurchaseOrderObservations(order) {
  const observations = [];

  if (
    order.observations !== null &&
    order.observations !== undefined &&
    String(order.observations).trim()
  ) {
    observations.push(
      String(order.observations).trim()
    );
  }

  if (
    order.anotation !== null &&
    order.anotation !== undefined &&
    String(order.anotation).trim()
  ) {
    observations.push(
      String(order.anotation).trim()
    );
  }

  return observations.length > 0
    ? observations.join(" | ")
    : null;
}

/**
 * Crea o actualiza una orden de compra de Alegra
 * dentro de la tabla purchase_orders.
 *
 * Esta función solamente sincroniza la cabecera.
 * No modifica purchase_order_lines.
 */
export async function syncPurchaseOrder(
  clientDb,
  order
) {
  if (!clientDb) {
    throw new Error(
      "clientDb es requerido"
    );
  }

  if (!order || typeof order !== "object") {
    throw new Error(
      "La orden recibida desde Alegra no es válida"
    );
  }

  /*
   * Alegra devuelve el ID como string.
   */
  const erpId = String(
    order.id ?? ""
  ).trim();

  if (!erpId) {
    console.warn(
      "⚠️ Orden de Alegra sin ID. Será ignorada."
    );

    return null;
  }

  console.log("");
  console.log("🟦 ========================================");
  console.log("🟦 SINCRONIZANDO ORDEN DE COMPRA");
  console.log("🆔 Alegra ID:", erpId);
  console.log("🟦 ========================================");

  /*
   * Bloqueamos la orden si ya existe para evitar
   * actualizaciones simultáneas.
   */
  const existingResult =
    await clientDb.query(
      `
      SELECT
        id,
        status,
        deleted_erp
      FROM purchase_orders
      WHERE erp_order_id = $1::BIGINT
      FOR UPDATE
      `,
      [erpId]
    );

  const existingOrder =
    existingResult.rows[0] ?? null;

  const finalStatus =
    resolveWmsPurchaseOrderStatus({
      alegraStatus: order.status,
      existingWmsStatus:
        existingOrder?.status ?? null
    });

  const purchaseOrderNumber =
    order.numberTemplate?.formattedNumber ||
    order.numberTemplate?.fullNumber ||
    order.numberTemplate?.number ||
    `PO-${erpId}`;

  const supplierName =
    String(
      order.provider?.name ?? ""
    ).trim() ||
    "SUPLIDOR SIN NOMBRE";

  const erpProviderId =
    order.provider?.id
      ? String(order.provider.id)
      : null;

  const erpWarehouseId =
    order.warehouse?.id
      ? String(order.warehouse.id)
      : null;

  const documentDate =
    order.date || null;

  const deliveryDate =
    order.deliveryDate || null;

  const observations =
    getPurchaseOrderObservations(order);

  const subtotal =
    toNumber(order.subTotal);

  const total =
    toNumber(order.total);

  console.log(
    "📄 Número:",
    purchaseOrderNumber
  );

  console.log(
    "🏢 Proveedor:",
    supplierName
  );

  console.log(
    "📦 Estado recibido:",
    order.status
  );

  console.log(
    "📦 Estado final WMS:",
    finalStatus
  );

  console.log(
    "📅 Fecha:",
    documentDate
  );

  console.log(
    "🚚 Fecha de entrega:",
    deliveryDate
  );

  console.log(
    "🏬 Almacén Alegra:",
    erpWarehouseId
  );

  console.log(
    "💰 Total:",
    total
  );

  /*
   * ACTUALIZAR ORDEN EXISTENTE
   */
  if (existingOrder) {
    const updateResult =
      await clientDb.query(
        `
        UPDATE purchase_orders
        SET
          purchase_order_number = $1,
          supplier_name = $2,
          status = $3::purchase_order_status,
          erp_provider_id = $4,
          erp_warehouse_id = $5,
          erp_document_date = $6,
          expected_delivery_date = $7,
          observations = $8,
          subtotal = $9,
          total = $10,
          deleted_erp = FALSE,
          erp_write_date = NOW(),
          last_erp_sync_at = NOW()
        WHERE id = $11
        RETURNING
          id,
          erp_order_id,
          purchase_order_number,
          supplier_name,
          status,
          deleted_erp
        `,
        [
          purchaseOrderNumber,
          supplierName,
          finalStatus,
          erpProviderId,
          erpWarehouseId,
          documentDate,
          deliveryDate,
          observations,
          subtotal,
          total,
          existingOrder.id
        ]
      );

    console.log(
      "🔄 Orden actualizada:",
      updateResult.rows[0]
    );

    return {
      action: "updated",
      ...updateResult.rows[0]
    };
  }

  /*
   * CREAR ORDEN NUEVA
   */
  const insertResult =
    await clientDb.query(
      `
      INSERT INTO purchase_orders
      (
        purchase_order_number,
        supplier_name,
        status,
        erp_order_id,
        erp_provider_id,
        erp_warehouse_id,
        erp_document_date,
        expected_delivery_date,
        observations,
        subtotal,
        total,
        deleted_erp,
        erp_write_date,
        last_erp_sync_at
      )
      VALUES
      (
        $1,
        $2,
        $3::purchase_order_status,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        $10,
        $11,
        FALSE,
        NOW(),
        NOW()
      )
      RETURNING
        id,
        erp_order_id,
        purchase_order_number,
        supplier_name,
        status,
        deleted_erp
      `,
      [
        purchaseOrderNumber,
        supplierName,
        finalStatus,
        erpId,
        erpProviderId,
        erpWarehouseId,
        documentDate,
        deliveryDate,
        observations,
        subtotal,
        total
      ]
    );

  console.log(
    "✅ Orden creada:",
    insertResult.rows[0]
  );

  return {
    action: "created",
    ...insertResult.rows[0]
  };
}