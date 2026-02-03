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

