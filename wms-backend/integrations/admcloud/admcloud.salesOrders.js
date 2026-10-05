import admcloudClient from "./admcloudClient.js";
import db from "../../db.js";


// Define la zona horaria que utiliza tu operación.
const TIME_ZONE = "America/New_York";

function getCurrentMonthDateRange() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const values = Object.fromEntries(
    parts.map(({ type, value }) => [type, value])
  );

  const { year, month, day } = values;

  return {
    dateFrom: `${year}-${month}-01`,
    dateTo: `${year}-${month}-${day}`,
  };
}

//Controller with the main logic
export async function syncAdmCloudSalesOrdersController(req, res) {
  let clientDb;

  try {
    // Se calcula una vez por llamada y se usa en todas las páginas.
    const { dateFrom, dateTo } = getCurrentMonthDateRange();

    clientDb = await db.connect();

    const PAGE_SIZE = 50;
    const MAX_REQUESTS = 500;

    let skip = 0;
    let requests = 0;

    const orderIds = new Set();

    let totalReceived = 0;
    let totalUnique = 0;
    let inserted = 0;
    let updated = 0;
    let done = 0;
    let draft = 0;
    let failed = 0;

    const errors = [];

    console.log("🚚 ADM CLOUD - SALES ORDERS SYNC");
    console.log(`📅 Desde: ${dateFrom}`);
    console.log(`📅 Hasta: ${dateTo}`);

    while (requests < MAX_REQUESTS) {
      requests++;

      console.log(`📄 Request #${requests} | skip=${skip}`);

      const result = await getAdmCloudSalesOrders(
        skip,
        dateFrom,
        dateTo
      );

      const orders = Array.isArray(result?.data)
        ? result.data
        : [];

      console.log(`📦 Recibidas: ${orders.length}`);

      totalReceived += orders.length;

      if (orders.length === 0) {
        console.log("🏁 No hay más órdenes.");
        break;
      }

      let newOrders = 0;

      for (const order of orders) {
        if (!order?.ID) {
          console.warn("⚠️ Sales Order sin ID. Se omite.");

          failed++;

          errors.push({
            id: null,
            docId: order?.DocID ?? null,
            error: "Sales Order sin ID",
          });

          continue;
        }

        const erpId = String(order.ID);

        if (orderIds.has(erpId)) {
          console.log(
            `⏭️ Orden repetida omitida: ${order.DocID ?? erpId}`
          );

          continue;
        }

        orderIds.add(erpId);

        newOrders++;
        totalUnique++;

        try {
          console.log(
            `🔄 Sincronizando: ${order.DocID ?? erpId}`
          );

          const syncResult = await syncSalesOrder(
            clientDb,
            order
          );

          if (syncResult.created) {
            inserted++;
          } else {
            updated++;
          }

          if (syncResult.state === "done") {
            done++;
          }

          if (syncResult.state === "draft") {
            draft++;
          }

          console.log(
            `✅ ${syncResult.created ? "INSERTADA" : "ACTUALIZADA"
            }:`,
            syncResult.name,
            "|",
            syncResult.state
          );
        } catch (syncError) {
          failed++;

          console.error(
            `❌ Error sincronizando ${order.DocID ?? erpId}:`,
            syncError.message
          );

          errors.push({
            id: erpId,
            docId: order.DocID ?? null,
            dispatchStatus: order.DispatchStatus ?? null,
            error: syncError.message,
          });
        }
      }

      console.log(`➕ Nuevas en esta página: ${newOrders}`);
      console.log(`📊 Total únicas procesadas: ${totalUnique}`);

      if (newOrders === 0) {
        console.warn(
          "⚠️ Página sin órdenes nuevas. Se detiene paginación."
        );

        break;
      }

      if (orders.length < PAGE_SIZE) {
        console.log(
          `🏁 Última página (${orders.length}/${PAGE_SIZE})`
        );

        break;
      }

      skip += PAGE_SIZE;
    }

    if (requests >= MAX_REQUESTS) {
      console.warn(
        `⚠️ Se alcanzó MAX_REQUESTS=${MAX_REQUESTS}`
      );
    }

    const summary = {
      success: failed === 0,
      totalReceived,
      totalUnique,
      inserted,
      updated,
      done,
      draft,
      failed,
      requests,
      dateFrom,
      dateTo,
      errors,
    };

    console.log("✅ SALES ORDERS SYNC TERMINADO");
    console.log(summary);

    return res.status(200).json(summary);
  } catch (error) {
    console.error(
      "❌ ERROR SALES ORDERS SYNC:",
      error.response?.data || error.message
    );

    return res
      .status(error.response?.status || 500)
      .json({
        success: false,
        message: "Error sincronizando Sales Orders desde ADM Cloud",
        error: error.response?.data || error.message,
      });
  } finally {
    clientDb?.release();
  }
}




//Obtain from the ERP all the sales orders
export async function getAdmCloudSalesOrders(
  skip = 0,
  dateFrom = null,
  dateTo = null
) {
  try {
    console.log("📦 ========================================");
    console.log("📦 OBTENIENDO SALES ORDERS DESDE ADM CLOUD");
    console.log("📦 ========================================");

    const params = {
      skip,
    };

    if (dateFrom) {
      params.DateFrom = dateFrom;
    }

    if (dateTo) {
      params.DateTo = dateTo;
    }

    console.log("📤 Params enviados:", params);

    const response = await admcloudClient.get("/SalesOrders", {
      params,
    });

    console.log("✅ SALES ORDERS RECIBIDOS");
    console.log(JSON.stringify(response.data, null, 2));

    return response.data;
  } catch (error) {
    console.error("❌ ERROR OBTENIENDO SALES ORDERS");

    console.error(
      "Status:",
      error.response?.status
    );

    console.error(
      "Data:",
      error.response?.data
    );

    console.error(
      "Message:",
      error.message
    );

    throw error;
  }
}





//Sync all the sale orders to the data base
export async function syncSalesOrder(clientDb, order) {
  try {
    console.log("");
    console.log("📦 ========================================");
    console.log("📦 UPSERT SALES ORDER ADM CLOUD");
    console.log("📦 ========================================");

    if (!clientDb) {
      throw new Error("clientDb is NULL ❌");
    }

    if (!order) {
      throw new Error("order is NULL ❌");
    }

    // ============================================================
    // 1. DATOS PRINCIPALES ADM CLOUD
    // ============================================================

    const erpId =
      order.ID
        ? String(order.ID)
        : null;

    const saleId =
      order.ID
        ? String(order.ID)
        : null;

    const saleName =
      order.DocID ?? null;


    // ============================================================
    // 2. CLIENTE
    // ============================================================

    const customerName =
      order.RelationshipName ?? null;

    const erpClienteId =
      order.RelationshipID
        ? String(order.RelationshipID)
        : null;


    // ============================================================
    // 3. LOCATION / ALMACÉN
    // ============================================================

    const erpLocationId =
      order.LocationID
        ? String(order.LocationID)
        : null;

    // Por ahora no usamos destination location
    const erpLocationDestId = null;


    // ============================================================
    // 4. VENDEDOR / EMPLOYEE
    // ============================================================

    const erpVendedorId =
      order.EmployeeID
        ? String(order.EmployeeID)
        : null;


    // ============================================================
    // 5. DISPATCH STATUS ADM CLOUD
    // ============================================================

    const dispatchStatus =
      Number(order.DispatchStatus);


    if (
      ![0, 1, 2].includes(dispatchStatus)
    ) {
      throw new Error(
        `DispatchStatus inválido para ${saleName}: ${order.DispatchStatus}`
      );
    }


    console.log(
      "🆔 ERP ID:",
      erpId
    );

    console.log(
      "📄 Orden:",
      saleName
    );

    console.log(
      "👤 Cliente:",
      customerName
    );

    console.log(
      "🏭 Location:",
      order.LocationName,
      erpLocationId
    );

    console.log(
      "🚚 DispatchStatus:",
      dispatchStatus,
      order.DispatchStatusDesc
    );


    // ============================================================
    // 6. VALIDAR ID
    // ============================================================

    if (!erpId) {
      throw new Error(
        `Sales Order sin ID en ADM Cloud: ${saleName ?? "UNKNOWN"}`
      );
    }


    // ============================================================
    // 7. UPDATE SI YA EXISTE
    // ============================================================

    const updateResult =
      await clientDb.query(
        `
        UPDATE stock_picking

        SET

          sale_id = $1,

          state = CASE

            -- ====================================================
            -- ADM CLOUD: DESPACHADO COMPLETAMENTE
            -- ====================================================

            WHEN $2 = 2
              THEN 'done'


            -- ====================================================
            -- ADM CLOUD: PENDIENTE O PARCIALMENTE DESPACHADO
            --
            -- Si WMS estaba DONE o CANCEL,
            -- la orden vuelve a DRAFT.
            -- ====================================================

            WHEN $2 IN (0, 1)
              AND state IN ('done', 'cancel')
              THEN 'draft'


            -- ====================================================
            -- Si está trabajando actualmente en WMS,
            -- NO modificar el estado.
            --
            -- draft
            -- confirmed
            -- waiting
            -- assigned
            -- ====================================================

            WHEN $2 IN (0, 1)
              AND state IN (
                'draft',
                'confirmed',
                'waiting',
                'assigned'
              )
              THEN state


            -- ====================================================
            -- CUALQUIER OTRO ESTADO
            -- CONSERVARLO
            -- ====================================================

            ELSE state

          END,

          erp_location_id = $3,

          erp_location_dest_id = $4,

          order_name = $5,

          erp_cliente = $6,

          erp_cliente_id = $7,

          erp_vendedor_id = $8,

          write_date = NOW()

        WHERE erp_id = $9

        RETURNING
          id,
          erp_id,
          sale_id,
          order_name,
          state
        `,
        [
          saleId,                 // $1
          dispatchStatus,         // $2
          erpLocationId,          // $3
          erpLocationDestId,      // $4
          saleName,               // $5
          customerName,           // $6
          erpClienteId,           // $7
          erpVendedorId,          // $8
          erpId                   // $9
        ]
      );


    // ============================================================
    // 8. YA EXISTÍA
    // ============================================================

    if (updateResult.rowCount > 0) {

      const picking =
        updateResult.rows[0];

      console.log("");
      console.log(
        "♻️ PICKING ACTUALIZADO"
      );

      console.log(
        "📄",
        picking.order_name
      );

      console.log(
        "📦 STATE:",
        picking.state
      );

      console.log(
        "🚚 ADM STATUS:",
        dispatchStatus,
        order.DispatchStatusDesc
      );


      return {
        id:
          picking.id,

        erpId:
          picking.erp_id,

        saleId:
          picking.sale_id,

        name:
          picking.order_name,

        state:
          picking.state,

        dispatchStatus,

        dispatchStatusDesc:
          order.DispatchStatusDesc ?? null,

        created:
          false
      };
    }


    // ============================================================
    // 9. NO EXISTE -> DETERMINAR ESTADO INICIAL
    // ============================================================

    const initialState =
      dispatchStatus === 2
        ? "done"
        : "draft";


    console.log("");
    console.log(
      "➕ INSERTANDO PICKING NUEVO"
    );

    console.log(
      "📦 Estado inicial:",
      initialState
    );


    // ============================================================
    // 10. INSERT
    // ============================================================

    const insertResult =
      await clientDb.query(
        `
        INSERT INTO stock_picking (

          erp_id,

          sale_id,

          state,

          picking_type,

          erp_location_id,

          erp_location_dest_id,

          order_name,

          erp_cliente,

          erp_cliente_id,

          erp_vendedor_id,

          create_date,

          write_date

        )

        VALUES (

          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          NOW(),
          NOW()

        )

        RETURNING
          id,
          erp_id,
          sale_id,
          order_name,
          state
        `,
        [
          erpId,                  // $1
          saleId,                 // $2
          initialState,           // $3
          "outgoing",             // $4
          erpLocationId,          // $5
          erpLocationDestId,      // $6
          saleName,               // $7
          customerName,           // $8
          erpClienteId,           // $9
          erpVendedorId           // $10
        ]
      );


    const picking =
      insertResult.rows[0];


    console.log("");
    console.log(
      "✅ PICKING INSERTADO"
    );

    console.log(
      "🆔 WMS ID:",
      picking.id
    );

    console.log(
      "📄 Orden:",
      picking.order_name
    );

    console.log(
      "📦 State:",
      picking.state
    );


    return {

      id:
        picking.id,

      erpId:
        picking.erp_id,

      saleId:
        picking.sale_id,

      name:
        picking.order_name,

      state:
        picking.state,

      dispatchStatus,

      dispatchStatusDesc:
        order.DispatchStatusDesc ?? null,

      created:
        true
    };


  } catch (error) {

    console.error("");
    console.error(
      "❌ ========================================"
    );

    console.error(
      "❌ ERROR UPSERT SALES ORDER ADM CLOUD"
    );

    console.error(
      "❌ Orden:",
      order?.DocID
    );

    console.error(
      "❌ ERP ID:",
      order?.ID
    );

    console.error(
      error
    );

    console.error(
      "❌ ========================================"
    );

    throw error;
  }
}





//Search an unique sale order using a GUID
export async function getAdmCloudSalesOrderByIdController(req, res) {
  let clientDb;
  let transactionStarted = false;
  let releaseError;

  try {
    // ==========================================================
    // 1. VALIDAR GUID
    // ==========================================================

    const id = req.params.id?.trim();

    const guidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    if (!id || !guidRegex.test(id)) {
      return res.status(400).json({
        success: false,
        message: "Debes enviar un ID con formato GUID válido.",
      });
    }

    // ==========================================================
    // 2. BUSCAR PEDIDO COMPLETO
    // ==========================================================

    console.log(`🔎 Buscando pedido ADM Cloud: ${id}`);

    const response = await admcloudClient.get(
      `/SalesOrders/${encodeURIComponent(id)}`
    );

    const result = response.data;

    if (result?.success === false) {
      return res.status(422).json({
        success: false,
        message:
          result.message || "ADM Cloud no pudo obtener el pedido.",
      });
    }

    if (!result?.data) {
      return res.status(404).json({
        success: false,
        message: "No se encontró el pedido en ADM Cloud.",
      });
    }

    const order = { ...result.data };

    if (
      typeof order.ID !== "string" ||
      order.ID.toLowerCase() !== id.toLowerCase()
    ) {
      return res.status(502).json({
        success: false,
        message: "El ID del pedido recibido no coincide con el solicitado.",
      });
    }

    if (!Array.isArray(order.Items)) {
      return res.status(502).json({
        success: false,
        message: "ADM Cloud no devolvió un arreglo Items válido.",
      });
    }

    // ==========================================================
    // 3. NORMALIZAR ESTADO PARA syncSalesOrder
    // ==========================================================

    const hasDispatchStatus =
      order.DispatchStatus !== null &&
      order.DispatchStatus !== undefined &&
      String(order.DispatchStatus).trim() !== "";

    if (!hasDispatchStatus) {
      // Equivalencia observada en el pedido que compartiste.
      const isPending =
        [0, "0"].includes(order.Status) &&
        order.StatusDesc?.trim().toLowerCase() ===
          "pendiente de despacho";

      if (!isPending) {
        return res.status(422).json({
          success: false,
          message:
            "El pedido no incluye DispatchStatus y su Status " +
            "todavía no tiene una equivalencia definida.",
          status: order.Status,
          statusDesc: order.StatusDesc,
        });
      }

      order.DispatchStatus = 0;
      order.DispatchStatusDesc = order.StatusDesc;
    }

    console.log("📦 Pedido recibido:", {
      id: order.ID,
      docId: order.DocID,
      cliente: order.RelationshipName,
      dispatchStatus: order.DispatchStatus,
      items: order.Items.length,
    });

    // ==========================================================
    // 4. INICIAR TRANSACCIÓN
    // ==========================================================

    clientDb = await db.connect();

    await clientDb.query("BEGIN");
    transactionStarted = true;

    // Serializa las llamadas de este controller para el mismo GUID,
    // incluso cuando el picking todavía no existe.
    await clientDb.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`admcloud:sales-order:${id.toLowerCase()}`]
    );

    // ==========================================================
    // 5. SINCRONIZAR ENCABEZADO
    // ==========================================================

    const picking = await syncSalesOrder(clientDb, order);

    if (!picking?.id) {
      throw new Error(
        "syncSalesOrder no devolvió el ID local del picking."
      );
    }

    console.log("✅ Encabezado procesado:", {
      pickingId: picking.id,
      name: picking.name,
      state: picking.state,
      created: picking.created,
    });

    // ==========================================================
    // 6. SINCRONIZAR LÍNEAS
    // ==========================================================

    const lines = await syncAdmCloudSalesOrderLines(
      clientDb,
      order,
      picking.id
    );

    // ==========================================================
    // 7. CONFIRMAR ENCABEZADO Y LÍNEAS
    // ==========================================================

    await clientDb.query("COMMIT");
    transactionStarted = false;

    console.log("✅ Pedido y líneas guardados:", {
      pickingId: picking.id,
      lines,
    });

    return res.status(200).json({
      success: true,
      message: "Sincronización completada.",
      picking,
      lines,
    });
  } catch (error) {
    // ==========================================================
    // 8. REVERTIR AMBAS OPERACIONES SI FALLA ALGUNA
    // ==========================================================

    if (clientDb && transactionStarted) {
      try {
        await clientDb.query("ROLLBACK");
        transactionStarted = false;
      } catch (rollbackError) {
        releaseError = rollbackError;

        console.error(
          "❌ Error realizando ROLLBACK:",
          rollbackError.message
        );
      }
    }

    console.error("❌ Error sincronizando pedido:", {
      id: req.params.id,
      message: error.message,
      data: error.response?.data,
    });

    const upstreamStatus = error.response?.status;

    const status =
      Number.isInteger(upstreamStatus) &&
      upstreamStatus >= 400 &&
      upstreamStatus <= 599
        ? upstreamStatus
        : 500;

    return res.status(status).json({
      success: false,
      message: "No se pudo completar la sincronización del pedido.",
      error: error.response?.data ?? error.message,
    });
  } finally {
    if (clientDb) {
      clientDb.release(releaseError);
    }
  }
}

export async function syncAdmCloudSalesOrderByGuidService(
  clientDb,
  id,
  expectedPickingId = null
) {
  // El controller inicia y cierra la transacción.
  const fail = (statusCode, title, message) =>
    Object.assign(new Error(message), {
      statusCode,
      title,
    });

  const guid = String(id ?? "").trim().toLowerCase();

  const guidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  if (!guidRegex.test(guid)) {
    throw fail(
      400,
      "GUID inválido",
      "Debes enviar un ID con formato GUID válido."
    );
  }

  // 1. Consultar el pedido en ADM Cloud
  console.log("🔎 Buscando pedido ADM Cloud:", guid);

  const response = await admcloudClient.get(
    `/SalesOrders/${encodeURIComponent(guid)}`
  );

  const result = response.data;

  if (result?.success === false) {
    throw fail(
      422,
      "No se pudo consultar el pedido",
      result.message || "ADM Cloud no pudo obtener el pedido."
    );
  }

  if (!result?.data) {
    throw fail(
      404,
      "Pedido no encontrado",
      "No se encontró el pedido en ADM Cloud."
    );
  }

  const order = { ...result.data };

  if (
    typeof order.ID !== "string" ||
    order.ID.toLowerCase() !== guid
  ) {
    throw fail(
      502,
      "Respuesta inválida de ADM Cloud",
      "El ID del pedido recibido no coincide con el solicitado."
    );
  }

  if (!Array.isArray(order.Items)) {
    throw fail(
      502,
      "Respuesta inválida de ADM Cloud",
      "ADM Cloud no devolvió un arreglo Items válido."
    );
  }

  // 2. Normalizar el estado
  const hasDispatchStatus =
    order.DispatchStatus !== null &&
    order.DispatchStatus !== undefined &&
    String(order.DispatchStatus).trim() !== "";

  if (!hasDispatchStatus) {
    const isPending =
      [0, "0"].includes(order.Status) &&
      String(order.StatusDesc ?? "").trim().toLowerCase() ===
        "pendiente de despacho";

    if (!isPending) {
      throw fail(
        422,
        "Estado del pedido sin equivalencia",
        "El pedido no incluye DispatchStatus y su Status todavía no tiene una equivalencia definida."
      );
    }

    order.DispatchStatus = 0;
    order.DispatchStatusDesc = order.StatusDesc;
  }

  // 3. Serializar la sincronización del mismo GUID
  await clientDb.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`admcloud:sales-order:${guid}`]
  );

  // 4. Verificar que sale_id no haya cambiado
  if (expectedPickingId !== null) {
    const lockedPickingResult = await clientDb.query(
      `
        SELECT id, sale_id
        FROM public.stock_picking
        WHERE id = $1
        FOR UPDATE
      `,
      [expectedPickingId]
    );

    const lockedPicking = lockedPickingResult.rows[0];

    if (!lockedPicking) {
      throw fail(
        404,
        "Picking no encontrado",
        "El picking solicitado ya no existe."
      );
    }

    const currentSaleId = String(
      lockedPicking.sale_id ?? ""
    ).trim().toLowerCase();

    if (currentSaleId !== guid) {
      throw fail(
        409,
        "El pedido del picking cambió",
        "El sale_id cambió mientras se consultaba ADM Cloud. Vuelve a cargar el picking."
      );
    }
  }

  // 5. Sincronizar encabezado
  const picking = await syncSalesOrder(clientDb, order);

  if (!picking?.id) {
    throw fail(
      500,
      "Error sincronizando el encabezado",
      "syncSalesOrder no devolvió el ID local del picking."
    );
  }

  if (
    expectedPickingId !== null &&
    String(picking.id) !== String(expectedPickingId)
  ) {
    throw fail(
      409,
      "Pedido asociado a otro picking",
      "La sincronización encontró un picking diferente del solicitado. Revisa sale_id y erp_id."
    );
  }

  // 6. Sincronizar líneas
  const lines = await syncAdmCloudSalesOrderLines(
    clientDb,
    order,
    picking.id
  );

  return {
    picking,
    lines,
  };
}




//Sync order lines 
export async function syncAdmCloudSalesOrderLines(
  clientDb,
  order,
  pickingId
) {
  // Debe ejecutarse dentro de la transacción del pedido.
  // El llamador realiza BEGIN, COMMIT y ROLLBACK.

  if (!Array.isArray(order?.Items)) {
    throw new Error(
      "El pedido no contiene Items válidos. No se sincronizaron líneas."
    );
  }

  const pickingIdInt = Number(pickingId);

  if (!Number.isSafeInteger(pickingIdInt) || pickingIdInt <= 0) {
    throw new Error("pickingId inválido.");
  }

  const guidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const summary = {
    inserted: 0,
    updated: 0,
    deleted: 0,
    skippedServices: 0,
    protectedMoves: [],
  };

  const lines = [];
  const seenIds = new Set();

  // 1. Validar todas las líneas antes de modificar movimientos.
  for (const item of order.Items) {
    if (item?.ItemType === "S") {
      summary.skippedServices++;
      continue;
    }

    if (item?.ItemType !== "I") {
      throw new Error(
        `Tipo de artículo no contemplado: ${item?.ItemType}. ` +
        `Línea: ${item?.ID ?? "sin ID"}`
      );
    }

    if (
      !guidRegex.test(item.ID ?? "") ||
      !guidRegex.test(item.ItemID ?? "")
    ) {
      throw new Error("Una línea contiene ID o ItemID inválido.");
    }

    if (
      !order.ID ||
      String(item.TransID).toLowerCase() !==
        String(order.ID).toLowerCase()
    ) {
      throw new Error(
        `La línea ${item.ID} no corresponde al pedido ${order.ID}.`
      );
    }

    const lineId = item.ID.toLowerCase();
    const productErpId = item.ItemID.toLowerCase();

    if (seenIds.has(lineId)) {
      throw new Error(`ID de línea repetido: ${lineId}`);
    }

    seenIds.add(lineId);

    if (
      item.Quantity === null ||
      item.Quantity === undefined ||
      String(item.Quantity).trim() === ""
    ) {
      throw new Error(`Cantidad ausente en la línea ${lineId}.`);
    }

    const quantity = Number(item.Quantity);

    if (!Number.isFinite(quantity) || quantity < 0) {
      throw new Error(`Cantidad inválida en la línea ${lineId}.`);
    }

    lines.push({
      lineId,
      productErpId,
      quantity,
      sku: item.ItemSKU,
    });
  }

  // 2. Bloquear el picking durante la sincronización.
  const pickingResult = await clientDb.query(
    `
      SELECT id, name, state
      FROM stock_picking
      WHERE id = $1
      FOR UPDATE
    `,
    [pickingIdInt]
  );

  const picking = pickingResult.rows[0];

  if (!picking) {
    throw new Error(`Picking no encontrado: ${pickingIdInt}`);
  }

  // 3. Leer y bloquear sus movimientos actuales.
  const moveResult = await clientDb.query(
    `
      SELECT
        sm.id,
        sm.erp_move_id,
        sm.product_id,
        sm.product_uom_id,
        sm.product_qty,
        sm.reserved_qty,
        sm.state,
        EXISTS (
          SELECT 1
          FROM stock_move_line sml
          WHERE sml.move_id = sm.id
        ) AS has_details
      FROM stock_move sm
      WHERE sm.picking_id = $1
      FOR UPDATE OF sm
    `,
    [pickingIdInt]
  );

  const existingMoves = new Map();

  for (const move of moveResult.rows) {
    if (move.erp_move_id === null) continue;

    const key = String(move.erp_move_id).toLowerCase();

    if (existingMoves.has(key)) {
      throw new Error(
        `Hay movimientos duplicados para la línea ERP ${key}.`
      );
    }

    existingMoves.set(key, move);
  }

  // 4. Insertar o actualizar por ID de línea, no por producto.
  for (const line of lines) {
    const productResult = await clientDb.query(
      `
        SELECT id, uom_id
        FROM products
        WHERE erp_id = $1
      `,
      [line.productErpId]
    );

    if (productResult.rows.length !== 1) {
      throw new Error(
        `Se esperaba un producto para ${line.sku ?? line.productErpId}; ` +
        `se encontraron ${productResult.rows.length}.`
      );
    }

    const product = productResult.rows[0];
    const currentMove = existingMoves.get(line.lineId);

    if (!currentMove) {
      if (["done", "cancel"].includes(picking.state)) {
        throw new Error(
          `No se pueden agregar líneas al picking ${picking.state}.`
        );
      }

      await clientDb.query(
        `
          INSERT INTO stock_move (
            erp_move_id,
            picking_id,
            name,
            reference,
            erp_product_id,
            product_id,
            product_uom_id,
            product_qty,
            state
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'draft')
        `,
        [
          line.lineId,
          pickingIdInt,
          `MOVE-${line.lineId}`,
          picking.name,
          line.productErpId,
          product.id,
          product.uom_id,
          line.quantity,
        ]
      );

      summary.inserted++;
      continue;
    }

    const productChanged =
      String(currentMove.product_id) !== String(product.id);

    const uomChanged =
      String(currentMove.product_uom_id) !== String(product.uom_id);

    const quantityChanged =
      Number(currentMove.product_qty) !== line.quantity;

    const hasActivity =
      currentMove.has_details ||
      Number(currentMove.reserved_qty ?? 0) !== 0;

    const isTerminal =
      ["done", "cancel"].includes(picking.state) ||
      ["done", "cancel"].includes(currentMove.state);

    if (
      (productChanged || uomChanged || quantityChanged) &&
      isTerminal
    ) {
      throw new Error(
        `El movimiento ${currentMove.id} pertenece a un proceso finalizado.`
      );
    }

    if ((productChanged || uomChanged) && hasActivity) {
      throw new Error(
        `No se puede cambiar el producto o unidad del movimiento ` +
        `${currentMove.id}: tiene reservas o líneas operativas.`
      );
    }

    // Una reducción requiere reconciliar reservas y cantidades
    // procesadas con la lógica operativa del WMS.
    if (
      line.quantity < Number(currentMove.product_qty) &&
      hasActivity
    ) {
      throw new Error(
        `No se puede reducir la cantidad del movimiento ` +
        `${currentMove.id} sin reconciliar sus reservas y detalles.`
      );
    }

    await clientDb.query(
      `
        UPDATE stock_move
        SET
          erp_product_id = $1,
          product_id = $2,
          product_uom_id = $3,
          product_qty = $4,
          reference = $5,
          write_date = NOW()
        WHERE id = $6
      `,
      [
        line.productErpId,
        product.id,
        product.uom_id,
        line.quantity,
        picking.name,
        currentMove.id,
      ]
    );

    summary.updated++;
  }

  // 5. Eliminar líneas desaparecidas del ERP solo cuando
  // no tengan reservas, detalles operativos ni estado final.
  for (const [erpLineId, move] of existingMoves) {
    if (seenIds.has(erpLineId)) continue;

    const protectedMove =
      move.has_details ||
      Number(move.reserved_qty ?? 0) !== 0 ||
      ["done", "cancel"].includes(move.state) ||
      ["done", "cancel"].includes(picking.state);

    if (protectedMove) {
      summary.protectedMoves.push({
        id: move.id,
        erp_move_id: move.erp_move_id,
        reason:
          "Línea ausente del ERP conservada por actividad o estado final.",
      });

      continue;
    }

    await clientDb.query(
      "DELETE FROM stock_move WHERE id = $1 AND picking_id = $2",
      [move.id, pickingIdInt]
    );

    summary.deleted++;
  }

  console.log("✅ Líneas ADM Cloud sincronizadas:", summary);

  return summary;
}