import admcloudClient from "./admcloudClient.js";
// ============================================================
// FILE:wms-backend/integrations/admcloud/ admcloud.purchaseOrders.runner.js
// ============================================================

import db from "../../db.js";






// ============================================================
// RUNNER PURCHASE ORDERS ADM CLOUD
// ============================================================

export async function runAdmCloudPurchaseOrdersSync() {

  console.log("");
  console.log("🚀 ========================================");
  console.log("🚀 INICIANDO SYNC PURCHASE ORDERS ADM CLOUD");
  console.log(
    "🕒 Fecha:",
    new Date().toISOString()
  );
  console.log("🚀 ========================================");


  // ==========================================================
  // 1. OBTENER TODAS LAS OC
  // ==========================================================

  const admCloudOrders =
    await getAdmCloudPurchaseOrders();


  if (!Array.isArray(admCloudOrders)) {

    throw new Error(
      "Adm Cloud no devolvió un arreglo de Purchase Orders"
    );

  }


  console.log(
    "📦 Total órdenes Adm Cloud:",
    admCloudOrders.length
  );


  // ==========================================================
  // 2. CONECTAR POSTGRES
  // ==========================================================

  const clientDb =
    await db.connect();


  try {

    // ========================================================
    // 3. RECONCILIAR
    // ========================================================

    const result =
      await reconcileAllAdmCloudPurchaseOrders(
        clientDb,
        admCloudOrders
      );


    console.log("");
    console.log(
      "✅ SYNC PURCHASE ORDERS ADM CLOUD FINALIZADO"
    );

    console.log(
      "📊 Resultado:",
      result
    );


    return result;


  } catch (error) {

    console.error("");

    console.error(
      "🔥 ERROR EJECUTANDO SYNC PURCHASE ORDERS ADM CLOUD:",
      error
    );


    throw error;


  } finally {

    clientDb.release();


    console.log(
      "🔌 Conexión PostgreSQL liberada"
    );

  }
}


// ============================================================
// FILE: admcloud.purchaseOrder.js
// ============================================================


// ============================================================
// RECONCILIAR TODAS LAS PURCHASE ORDERS
// ============================================================

export async function reconcileAllAdmCloudPurchaseOrders(
  clientDb,
  admCloudOrders
) {

  if (!clientDb) {
    throw new Error(
      "clientDb es requerido"
    );
  }


  if (!Array.isArray(admCloudOrders)) {
    throw new Error(
      "admCloudOrders debe ser un arreglo"
    );
  }


  console.log("");
  console.log("🟪 ========================================");
  console.log("🟪 RECONCILIACIÓN PURCHASE ORDERS ADM CLOUD");
  console.log(
    "📦 Total recibido:",
    admCloudOrders.length
  );
  console.log("🟪 ========================================");


  const summary = {
    received: admCloudOrders.length,
    created: 0,
    updated: 0,
    deletedFromErp: 0
  };


  const receivedErpIds = [];


  try {

    await clientDb.query("BEGIN");


    // ========================================================
    // CREAR / ACTUALIZAR
    // ========================================================

    for (const order of admCloudOrders) {

      const synchronizedOrder =
        await syncAdmCloudPurchaseOrder(
          clientDb,
          order
        );


      if (!synchronizedOrder) {
        continue;
      }


      receivedErpIds.push(
        String(order.ID)
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


    // ========================================================
    // DETECTAR ÓRDENES QUE YA NO EXISTEN EN ADM CLOUD
    // ========================================================

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
              ANY($1::TEXT[])
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
          "🗑️ Orden no encontrada en Adm Cloud:",
          deletedOrder
        );

      }

    } else {

      console.warn(
        "⚠️ Adm Cloud devolvió cero órdenes."
      );

      console.warn(
        "⚠️ No se marcarán órdenes como eliminadas."
      );
    }


    await clientDb.query("COMMIT");


    console.log("");
    console.log(
      "✅ RECONCILIACIÓN ADM CLOUD COMPLETADA"
    );

    console.log(
      "📊 Resultado:",
      summary
    );


    return {
      success: true,
      ...summary
    };


  } catch (error) {

    await clientDb.query(
      "ROLLBACK"
    );


    console.error(
      "🔥 ERROR EN RECONCILIACIÓN ADM CLOUD:",
      error
    );


    throw error;
  }
}



// ============================================================
// CONVERTIR NÚMEROS
// ============================================================

function toNumber(
  value,
  fallback = 0
) {

  const parsed =
    Number(value);


  return Number.isFinite(parsed)
    ? parsed
    : fallback;
}



// ============================================================
// ESTADO ADM CLOUD → WMS
// ============================================================

function resolveAdmCloudPurchaseOrderStatus({
  order,
  existingWmsStatus
}) {

  // ----------------------------------------------------------
  // VOID EN ADM CLOUD
  // ----------------------------------------------------------

  if (order.Void === true) {
    return "cancelled";
  }


  // ----------------------------------------------------------
  // SI YA HUBO RECEPCIÓN PARCIAL EN WMS
  // NO PERDER ESE ESTADO
  // ----------------------------------------------------------

  if (
    existingWmsStatus ===
    "partial"
  ) {
    return "partial";
  }


  // ----------------------------------------------------------
  // Por ahora el listado de Adm Cloud no nos está dando
  // un estado claro de "received/closed".
  //
  // AuthorizationStatusDesc = "Pendiente"
  // es estado de AUTORIZACIÓN, no de recepción.
  // ----------------------------------------------------------

  return "open";
}



// ============================================================
// OBSERVACIONES
// ============================================================

function getAdmCloudPurchaseOrderObservations(
  order
) {

  const observations = [];


  if (
    order.Reference !== null &&
    order.Reference !== undefined &&
    String(order.Reference).trim()
  ) {

    observations.push(
      String(order.Reference).trim()
    );

  }


  return observations.length > 0
    ? observations.join(" | ")
    : null;
}



// ============================================================
// CREAR / ACTUALIZAR UNA PURCHASE ORDER
// ============================================================

export async function syncAdmCloudPurchaseOrder(
  clientDb,
  order
) {

  if (!clientDb) {
    throw new Error(
      "clientDb es requerido"
    );
  }


  if (
    !order ||
    typeof order !== "object"
  ) {

    throw new Error(
      "Purchase Order Adm Cloud inválida"
    );
  }


  // ==========================================================
  // ERP ID
  // ==========================================================

  const erpId =
    String(
      order.ID ?? ""
    ).trim();


  if (!erpId) {

    console.warn(
      "⚠️ Purchase Order Adm Cloud sin ID."
    );

    return null;
  }


  console.log("");
  console.log("🟦 ========================================");
  console.log("🟦 SINCRONIZANDO PURCHASE ORDER");
  console.log("🆔 Adm Cloud ID:", erpId);
  console.log("📄 DocID:", order.DocID);
  console.log("🟦 ========================================");


  // ==========================================================
  // BUSCAR / BLOQUEAR EXISTENTE
  // ==========================================================

  const existingResult =
    await clientDb.query(
      `
      SELECT
        id,
        status,
        deleted_erp

      FROM purchase_orders

      WHERE erp_order_id = $1::TEXT

      FOR UPDATE
      `,
      [erpId]
    );


  const existingOrder =
    existingResult.rows[0] ??
    null;


  // ==========================================================
  // STATUS
  // ==========================================================

  const finalStatus =
    resolveAdmCloudPurchaseOrderStatus({
      order,

      existingWmsStatus:
        existingOrder?.status ??
        null
    });


  // ==========================================================
  // MAP ADM CLOUD → WMS
  // ==========================================================

  const purchaseOrderNumber =
    String(
      order.DocID ||
      `PO-${erpId.substring(0, 8)}`
    ).trim();


  const supplierName =
    String(
      order.Name ?? ""
    ).trim() ||
    "SUPLIDOR SIN NOMBRE";


  const erpProviderId =
    order.RelationshipID
      ? String(
          order.RelationshipID
        )
      : null;


  const erpWarehouseId =
    order.LocationID
      ? String(
          order.LocationID
        )
      : null;


  const documentDate =
    order.DocDate ||
    null;


  // El listado actual no trae DeliveryDate.
  const deliveryDate =
    null;


  const observations =
    getAdmCloudPurchaseOrderObservations(
      order
    );


  const total =
    toNumber(
      order.TotalAmount
    );


  /*
   * Adm Cloud no está enviando Subtotal
   * en este listado.
   *
   * Por ahora usamos TotalAmount.
   *
   * Cuando obtengamos el detalle completo
   * de la OC podemos calcular/leer
   * subtotal correctamente.
   */
  const subtotal =
    total;


  console.log(
    "📄 Número:",
    purchaseOrderNumber
  );

  console.log(
    "🏢 Proveedor:",
    supplierName
  );

  console.log(
    "🏬 Warehouse:",
    order.LocationName,
    erpWarehouseId
  );

  console.log(
    "📦 Void:",
    order.Void
  );

  console.log(
    "🔐 Authorization:",
    order.AuthorizationStatusDesc
  );

  console.log(
    "📦 Estado WMS:",
    finalStatus
  );

  console.log(
    "📅 Fecha:",
    documentDate
  );

  console.log(
    "💰 Total:",
    total
  );


  // ==========================================================
  // UPDATE
  // ==========================================================

  if (existingOrder) {

    const updateResult =
      await clientDb.query(
        `
        UPDATE purchase_orders

        SET
          purchase_order_number = $1,

          supplier_name = $2,

          status =
            $3::purchase_order_status,

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


  // ==========================================================
  // INSERT
  // ==========================================================

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


const PAGE_SIZE = 50;

// ============================================================
// OBTENER TODAS LAS ÓRDENES DE COMPRA DE ADM CLOUD
// ============================================================

export async function getAdmCloudPurchaseOrders() {

  const allPurchaseOrders = [];

  let skip = 0;
  let callNumber = 1;

  console.log("");
  console.log("🧾 ========================================");
  console.log("🧾 OBTENIENDO PURCHASE ORDERS ADM CLOUD");
  console.log("🧾 ========================================");

  while (true) {

    const response = await admcloudClient.get(
      "/PurchaseOrders",
      {
        params: {
          skip
        }
      }
    );

    // Adm Cloud normalmente devuelve:
    //
    // {
    //   success: true,
    //   message: null,
    //   data: [...]
    // }

    const purchaseOrders =
      response.data?.data || [];

    console.log(
      `📡 Llamada #${callNumber}: ${purchaseOrders.length} órdenes`
    );

    allPurchaseOrders.push(
      ...purchaseOrders
    );

    // Si devuelve menos de 50,
    // llegamos a la última página.
    if (purchaseOrders.length < PAGE_SIZE) {
      break;
    }

    skip += purchaseOrders.length;
    callNumber++;
  }

  console.log("");
  console.log(
    `✅ TOTAL PURCHASE ORDERS: ${allPurchaseOrders.length}`
  );

  return allPurchaseOrders;
}


