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
  const uid = await getOdooUid();
  const client = getOdooClient("object");

  const model = "purchase.order";

  const lock = await lockSyncControl(model);
  console.log("ESTE ES EL TIME: ", lock.lastWriteDate)
  if (!lock) {
    console.log(`[SYNC] ${model} ya está corriendo y no se pudo activar funcion getActivePurchaseOrders`);
    return;
  }

  let maxWriteDate = lock.lastWriteDate;


  /* ==========================
     1️⃣ TRAER PURCHASE ORDERS
  ========================== */
  const poDomain = [
    ["state", "=", "purchase"],
    ["write_date", ">", lock.lastWriteDate]
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

  console.log("ESTA ES LA ORDEN DE COMPRA", purchaseOrders);

  // ... todo tu código igual

  const clientDb = await db.connect();
  try {
    await clientDb.query("BEGIN");

    for (let i = 0; i < purchaseOrders.length; i++) {
      await upsertPurchaseOrder(clientDb, purchaseOrders[i]);

      const po = purchaseOrders[i];
      if (!po.write_date) continue;

      if (new Date(po.write_date) > new Date(maxWriteDate)) {
        maxWriteDate = po.write_date;
      }
    }

    await clientDb.query("COMMIT");
  } catch (error) {
    await clientDb.query("ROLLBACK");

    // 🔴 Marcar sync como failed
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

    throw error;
  } finally {
    clientDb.release();
  }

  /* ✅ SOLO SI TODO SALIÓ BIEN */
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


  /* ==========================
     2️⃣ OBTENER TODOS LOS PICKING IDS
  ========================== */
  const pickingIds = [
    ...new Set(
      purchaseOrders.flatMap(po => po.picking_ids || [])
    )
  ];

  if (pickingIds.length === 0) {
    return purchaseOrders;
  }

  /* ==========================
     3️⃣ TRAER STOCK.PICKING
  ========================== */
  const pickingFields = [
    "id",
    "name",
    "origin",
    "state",
    "picking_type_id",
    "location_id",
    "location_dest_id",
    "scheduled_date",
    "date_done",
    "move_ids",
    "company_id"
  ];


  const pickings = await new Promise((resolve, reject) => {
    client.methodCall(
      "execute_kw",
      [
        process.env.ODOO_DB,
        uid,
        process.env.ODOO_API_KEY,
        "stock.picking",
        "search_read",
        [[["id", "in", pickingIds]]],
        { fields: pickingFields }
      ],
      (err, res) => (err ? reject(err) : resolve(res))
    );
  });

  console.log(pickings);

  /* ==========================
     4️⃣ INDEXAR PICKINGS POR ID
  ========================== */
  const pickingMap = Object.fromEntries(
    pickings.map(p => [p.id, p])
  );

  /* ==========================
     5️⃣ MERGE EN CADA PO
  ========================== */
  return purchaseOrders.map(po => ({
    ...po,
    pickings: (po.picking_ids || []).map(id => pickingMap[id]).filter(Boolean)
  }));
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

