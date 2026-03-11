import { getOdooClient } from "./odoo.client.js";
import { getOdooUid } from "./odoo.session.js";
import { db } from "../../db.js";
import { upsertPurchaseOrder } from "../purchaseOrder.upsert.js";

const OLD_DATE = "2000-01-01 00:00:00";


export async function lockSyncControl(model) {
  const client = await db.connect();

  try {
    await client.query("BEGIN");

    // 1️⃣ Buscar registro con lock
    const result = await client.query(
      `
      SELECT id, last_write_date, status
      FROM sync_control
      WHERE model = $1
      FOR UPDATE
      `,
      [model]
    );

    // 2️⃣ Si existe y está corriendo → salir
    if (result.rowCount > 0) {
      const row = result.rows[0];

      if (row.status === "running") {
        await client.query("ROLLBACK");
        return null; // ocupado
      }

      // 3️⃣ Existe y NO está corriendo → marcar running
      await client.query(
        `
        UPDATE sync_control
        SET status = 'running',
            updated_at = now(),
            error_message = NULL
        WHERE model = $1
        `,
        [model]
      );

      await client.query("COMMIT");

      return {
        id: row.id,
        lastWriteDate: row.last_write_date
      };
    }

    // 4️⃣ No existe → crear registro
    const insertResult = await client.query(
      `
      INSERT INTO sync_control (model, last_write_date, status)
      VALUES ($1, $2, 'running')
      RETURNING id, last_write_date
      `,
      [model, OLD_DATE]
    );

    await client.query("COMMIT");

    return {
      id: insertResult.rows[0].id,
      lastWriteDate: insertResult.rows[0].last_write_date
    };

  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}



export async function getActivePurchaseOrders() {
  const model = "purchase.order";
  let lock = null;
  let maxWriteDate = null;

  try {
    const uid = await getOdooUid();
    const client = getOdooClient("object");

    // 🔒 Lock global
    lock = await lockSyncControl(model);

    if (!lock) {
      console.log(`[SYNC] ${model} ya está corriendo, se omite este ciclo`);
      return;
    }

    maxWriteDate = lock.lastWriteDate;

    /* ==========================
       1️⃣ TRAER PURCHASE ORDERS
    ========================== */
    const poDomain = [
      ["state", "=", "purchase"],
      ["write_date", ">", maxWriteDate]
    ];

    const poFields = [
      "id",
      "name",
      "partner_id",
      "order_line",
      "picking_ids",
      "state",
      "write_date",
      "date_order",
      "date_planned",
      "incoming_picking_count",
      "receipt_status"
    ];

    const purchaseOrders = await new Promise((resolve, reject) => {
      client.methodCall(
        "execute_kw",
        [
          process.env.ODOO_DB,
          uid,
          process.env.ODOO_API_KEY,
          "purchase.order",
          "search_read",
          [poDomain],
          { fields: poFields }
        ],
        (err, res) => (err ? reject(err) : resolve(res))
      );
    });

    console.log("ORDENES DE COMPRA DE ODOO OBTENIDA", purchaseOrders);

    /* ==========================
       2️⃣ UPSERT EN DB
    ========================== */
    const clientDb = await db.connect();
    try {
      await clientDb.query("BEGIN");

      for (const po of purchaseOrders) {
        await upsertPurchaseOrder(clientDb, po);

        if (po.write_date && new Date(po.write_date) > new Date(maxWriteDate)) {
          maxWriteDate = po.write_date;
        }
      }

      await clientDb.query("COMMIT");
    } catch (dbError) {
      await clientDb.query("ROLLBACK");
      throw dbError;
    } finally {
      clientDb.release();
    }

    /* ==========================
       ✅ MARCAR SUCCESS
    ========================== */
    await db.query(
      `
      UPDATE sync_control
      SET
        last_write_date = $1,
        status = 'success',
        updated_at = now(),
        error_message = NULL
      WHERE model = $2
      `,
      [maxWriteDate, model]
    );

    return purchaseOrders;

  } catch (error) {
    console.error(`[SYNC ERROR] ${model}`, error.message);

    // 🟥 SI YA HABÍA LOCK → marcar failed
    if (lock?.id) {
      await db.query(
        `
        UPDATE sync_control
        SET
          status = 'failed',
          updated_at = now(),
          error_message = $1
        WHERE model = $2
        `,
        [error.message, model]
      );
    }

    throw error;
  }
}


export async function getPurchaseOrderLinesByOrderId(orderId) {
  const uid = await getOdooUid();
  const client = getOdooClient("object");

  return new Promise((resolve, reject) => {
    client.methodCall(
      "execute_kw",
      [
        process.env.ODOO_DB,
        uid,
        process.env.ODOO_API_KEY,
        "purchase.order.line",
        "search_read",
        [
          [["order_id", "=", orderId]]
        ],
        {
          fields: [
            "id",
            "order_id",
            "product_id",
            "name",
            "product_qty",
            "qty_received",
            "price_unit",
            "date_planned",
            "state",
            "write_date",
            "move_ids",
            "location_final_id"
          ]
        }
      ],
      (error, records) => {
        if (error) return reject(error);
        resolve(records);
      }
    );
  });
}



// ===============================================
// 🔥 PROCESAR LINEAS DE PURCHASE ORDER
// ===============================================

export async function processPurchaseOrderLines(orderLines) {

  if (!Array.isArray(orderLines) || orderLines.length === 0) {
    console.warn("⚠️ orderLines vacío o inválido");
    return;
  }

  const orderId = orderLines?.[0]?.order_id?.[0] || null;

  console.log("ORDER LINES:", orderLines);

  const result = await db.query(
    `
  SELECT id
  FROM purchase_orders
  WHERE erp_order_id = $1
  AND status IN ('open', 'partial')
  LIMIT 1
  `,
    [orderId]
  );

  const wmsOrderId = result.rows[0]?.id || null;

  /* =====================================
     1️⃣ EXTRAER ERP PRODUCT IDS
  ===================================== */

  const erpIds = orderLines
    .map(line => line.product_id?.[0])
    .filter(Boolean);

  if (erpIds.length === 0) {
    console.warn("⚠️ No hay ERP product IDs válidos");
    return;
  }

  /* =====================================
     2️⃣ TRAER PRODUCTOS ACTIVOS
  ===================================== */

  const productsResult = await db.query(
    `
    SELECT id, sku, description, erp_id
    FROM products
    WHERE erp_id = ANY($1)
      AND status = 'ACTIVE'
      AND deleted_erp = false
    `,
    [erpIds]
  );

  // Crear mapa erp_id → producto
  const productMap = new Map();

  for (const product of productsResult.rows) {
    productMap.set(product.erp_id, product);
  }

  /* =====================================
     3️⃣ TRAER BARCODES DE ESOS SKUS
  ===================================== */

  const skus = productsResult.rows.map(p => p.sku);

  let barcodeSet = new Set();

  if (skus.length > 0) {
    const barcodeResult = await db.query(
      `
      SELECT product_sku
      FROM product_barcodes
      WHERE product_sku = ANY($1)
      `,
      [skus]
    );

    barcodeSet = new Set(
      barcodeResult.rows.map(r => r.product_sku)
    );
  }

  /* =====================================
     4️⃣ PROCESAR CADA LINEA SIN MÁS QUERIES
  ===================================== */

  const processedLines = [];

  let sequence = 1; // 🔥 secuencia real por orden

  for (const line of orderLines) {

    const erpProductId = line.product_id?.[0] || null;

    if (!erpProductId) {
      console.warn("Linea sin ERP product ID:", line.id);
      continue;
    }

    const product = productMap.get(erpProductId);

    if (!product) {
      console.warn("Producto no encontrado en WMS:", erpProductId);
      continue;
    }

    const line_number = sequence; // 👈 usamos secuencia controlada
    sequence++;                   // 👈 incrementamos solo si la línea es válida

    const productId = product.id;
    const sku = product.sku;
    const description = product.description;

    const product_exists = barcodeSet.has(sku);

    const deleted_erp = line.state === "cancel";

    console.log("------------------------------------------------");
    console.log("ERP LINE ID:", line.id);
    console.log("LINE NUMBER:", line_number);
    console.log("ERP PRODUCT ID:", erpProductId);
    console.log("LOCAL PRODUCT ID:", productId);
    console.log("SKU:", sku);
    console.log("DESCRIPTION:", description);
    console.log("HAS BARCODE:", product_exists);

    processedLines.push({
      wms_order_id: wmsOrderId,
      erp_line_id: line.id,
      erp_order_id: orderId,
      erp_product_id: erpProductId,
      product_id: productId,
      sku,
      description,
      ordered_qty: line.product_qty,
      qty_received: line.qty_received,
      product_exists,
      deleted_erp,
      line_number
    });
  }

  return processedLines;
}



// ===============================================
// 🔥 UPSERT MASIVO CON deleted_erp VARIABLE
// ===============================================

export async function upsertPurchaseOrderLines(processedLines) {

  if (!Array.isArray(processedLines) || processedLines.length === 0) {
    console.log("⚠️ No hay líneas para upsert");
    return;
  }

  const values = [];
  const params = [];

  processedLines.forEach((line, i) => {

    const base = i * 9; // 👈 ahora son 9 columnas

    values.push(`
      ($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4},
       $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8},
       $${base + 9})
    `);

    params.push(
      line.erp_line_id,        // 1
      line.erp_order_id,       // 2
      line.sku,                // 3
      line.wms_order_id,       // 4 purchase_order_id
      line.product_exists,     // 5
      line.description,        // 6
      line.ordered_qty,        // 7
      line.deleted_erp,        // 8
      line.line_number         // 9 👈 NUEVO
    );
  });

  const query = `
    INSERT INTO purchase_order_lines (
      erp_line_id,
      erp_order_id,
      sku,
      purchase_order_id,
      product_exists,
      description,
      ordered_qty,
      deleted_erp,
      line_number
    )
    VALUES
      ${values.join(",")}
    ON CONFLICT (erp_line_id)
    DO UPDATE SET
      erp_order_id = EXCLUDED.erp_order_id,
      sku = EXCLUDED.sku,
      purchase_order_id = EXCLUDED.purchase_order_id,
      product_exists = EXCLUDED.product_exists,
      description = EXCLUDED.description,
      ordered_qty = EXCLUDED.ordered_qty,
      deleted_erp = EXCLUDED.deleted_erp,
      line_number = EXCLUDED.line_number, -- 👈 agregado
      updated_at = NOW()
    WHERE
      purchase_order_lines.erp_order_id IS DISTINCT FROM EXCLUDED.erp_order_id OR
      purchase_order_lines.sku IS DISTINCT FROM EXCLUDED.sku OR
      purchase_order_lines.purchase_order_id IS DISTINCT FROM EXCLUDED.purchase_order_id OR
      purchase_order_lines.product_exists IS DISTINCT FROM EXCLUDED.product_exists OR
      purchase_order_lines.description IS DISTINCT FROM EXCLUDED.description OR
      purchase_order_lines.ordered_qty IS DISTINCT FROM EXCLUDED.ordered_qty OR
      purchase_order_lines.deleted_erp IS DISTINCT FROM EXCLUDED.deleted_erp OR
      purchase_order_lines.line_number IS DISTINCT FROM EXCLUDED.line_number
  `;

  await db.query(query, params);

  console.log(`✅ UPSERT masivo ejecutado (${processedLines.length} líneas)`);
}

