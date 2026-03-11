import { getOdooClient } from "./odoo.client.js";
import { getOdooUid } from "./odoo.session.js";
import { db } from "../../db.js";
import { upsertPurchaseOrder } from "../purchaseOrder.upsert.js";
import { lockSyncControl } from "./odoo.purchase.service.js";

const OLD_DATE = "2000-01-01 00:00:00";


export async function getActiveSaleOrders() {
  const model = "sale.order";
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

    maxWriteDate = lock.lastWriteDate || OLD_DATE;

    /* ==========================
       1️⃣ TRAER SALES ORDERS
    ========================== */
    const poDomain = [
      ["state", "=", "sale"],
      ["write_date", ">", maxWriteDate],
      ["picking_ids", "!=", false] // 👈 solo órdenes con picking
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
      "amount_total",
      "currency_id",
      "user_id"
    ];

    const saleOrders = await new Promise((resolve, reject) => {
      client.methodCall(
        "execute_kw",
        [
          process.env.ODOO_DB,
          uid,
          process.env.ODOO_API_KEY,
          "sale.order",
          "search_read",
          [poDomain],
          { fields: poFields }
        ],
        (err, res) => (err ? reject(err) : resolve(res))
      );
    });

    /*console.log("ORDENES DE COMPRA DE ODOO OBTENIDA", saleOrders);*/

    const allPickingIds = saleOrders
      .flatMap(order => order.picking_ids)
      .filter(id => id); // eliminar null


    const pickingFields = [
      "id",
      "name",
      "state",
      "sale_id",
      "picking_type_code",
      "scheduled_date",
      "location_id",
      "partner_id",
      "location_dest_id"
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
          [[
            ["id", "in", allPickingIds],
            ["state", "not in", ["done", "cancel"]] // 👈 filtro
          ]],
          { fields: pickingFields }
        ],
        (err, res) => (err ? reject(err) : resolve(res))
      );
    });


    const pickingsById = Object.fromEntries(
      pickings.map(p => [p.id, p])
    );

    for (const order of saleOrders) {

      order.pickings = order.picking_ids.map(
        id => pickingsById[id]
      );

    }


    saleOrders.forEach(order => {
      console.log("ORDER:", order);
    });

    /* ==========================
       2️⃣ UPSERT EN DB
    ========================== */
    const clientDb = await db.connect();
    try {
      await clientDb.query("BEGIN");

      for (const so of saleOrders) {
        await upsertSaleOrder(clientDb, so);

        if (so.write_date && new Date(so.write_date) > new Date(maxWriteDate)) {
          maxWriteDate = so.write_date;
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
       2️⃣ DELETED SALES ORDERS
    ========================== */

    const deleteSoDomain = [
      ["state", "in", ["cancel", "done"]],
      ["write_date", ">", maxWriteDate],
      ["picking_ids", "!=", false] // solo órdenes con picking
    ];

    const deleteSoFields = [
      "id",
      "name",
      "order_line",
      "picking_ids",
      "state",
      "write_date"
    ];

    const deleteSoOrders = await new Promise((resolve, reject) => {
      client.methodCall(
        "execute_kw",
        [
          process.env.ODOO_DB,
          uid,
          process.env.ODOO_API_KEY,
          "sale.order",
          "search_read",
          [deleteSoDomain],
          { fields: deleteSoFields }
        ],
        (err, res) => (err ? reject(err) : resolve(res))
      );
    });

    console.log("🚨 DELETED SALES ORDERS: ", deleteSoOrders);
    for (const so of deleteSoOrders) {
      await deleteStockPickingBySaleOrderId(clientDb, so.id, so.state);

      if (so.write_date && new Date(so.write_date) > new Date(maxWriteDate)) {
          maxWriteDate = so.write_date;
        }
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

    return saleOrders;

  } catch (error) {
    console.error(`[SYNC ERROR x] ${model}`, error.message);

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




export async function upsertSaleOrder(client, so) {
  try {

    console.log("🟢 UPSERT SALE ORDER:", so.id);

    const erpOrderId = so.id;

    /* ==========================
       1️⃣ OBTENER NOMBRE
    ========================== */

    let orderNumber = so.name;

    if (!orderNumber) {

      console.log("⚠️ SO SIN NAME, GENERANDO PICK NUMBER");

      await client.query(
        "LOCK TABLE stock_picking IN SHARE ROW EXCLUSIVE MODE"
      );

      const last = await client.query(`
        SELECT name
        FROM stock_picking
        WHERE name LIKE 'PICK-%'
        ORDER BY id DESC
        LIMIT 1
      `);

      let nextNumber = 1;

      if (last.rows.length > 0) {
        const lastName = last.rows[0].name; // PICK-00008
        const num = parseInt(lastName.split("-")[1]);
        nextNumber = num + 1;
      }

      orderNumber = `PICK-${String(nextNumber).padStart(5, "0")}`;

      console.log("🆕 GENERATED ORDER:", orderNumber);
    }

    /* ==========================
       2️⃣ SUPPLIER
    ========================== */

    const supplierName = so.partner_id?.[1] ?? null;

    /* ==========================
       3️⃣ WRITE DATE
    ========================== */

    const erpWriteDate = so.write_date ?? null;

    /* ==========================
       4️⃣ UPSERT PICKINGS
    ========================== */

    if (so.pickings && so.pickings.length > 0) {

      for (const picking of so.pickings) {
        await upsertPicking(client, so, picking);
      }

    } else {

      console.log("⚠️ SALE ORDER SIN PICKINGS:", so.id);

    }

    console.log("✅ UPSERT SALE ORDER OK:", so.id);

    return so.id;

  } catch (error) {

    console.error("❌ ERROR UPSERT SALE ORDER:", error);
    throw error;

  }
}



async function upsertPicking(client, so, picking) {
  try {

    console.log("📦 UPSERT PICKING:", picking.id);

    const erpId = picking.id;
    const saleId = so.id;
    const saleName = so.name;

    const locationId = picking.location_id?.[0] ?? null;
    const locationDestId = picking.location_dest_id?.[0] ?? null;

    const statusMap = {
      draft: "draft",
      waiting: "waiting",
      confirmed: "confirmed",
      assigned: "confirmed", //El wms asigna el picking luego aunque el erp lo tenga asignado
      done: "done",
      cancel: "cancel"
    };

    const state = statusMap[picking.state] || "draft";

    await client.query(`
      INSERT INTO stock_picking (
        erp_id,
        sale_id,
        state,
        picking_type,
        erp_location_id,
        erp_location_dest_id,
        order_name
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (erp_id)
      DO UPDATE SET
        sale_id = EXCLUDED.sale_id,
        state = EXCLUDED.state,
        erp_location_id = EXCLUDED.erp_location_id,
        erp_location_dest_id = EXCLUDED.erp_location_dest_id
    `,
      [
        erpId,
        saleId,
        state,
        'outgoing',
        locationId,
        locationDestId,
        saleName
      ]);

  } catch (error) {
    console.error("❌ Error upserting picking:", error);
    throw error;
  }
}


//si una orden de venta esta cancel o done, entonces el wms picking lo ponemos cancel or done.
export async function deleteStockPickingBySaleOrderId(client, saleOrderId, soState) {
  try {

    console.log("🗑 CHECK PICKING FOR SALE ORDER:", saleOrderId);

    const statusMap = {
      cancel: "cancel",
      done: "done"
    };

    const newState = statusMap[soState];

    if (!newState) {
      console.log("⚠️ State no válido:", soState);
      return;
    }

    const result = await client.query(
      `
      UPDATE stock_picking
      SET state = $1
      WHERE sale_id = $2
      RETURNING id
      `,
      [newState, saleOrderId]
    );

    if (result.rowCount === 0) {
      console.log("ℹ️ No se encontraron pickings para sale_order:", saleOrderId);
      return;
    }

    console.log("✅ PICKINGS ACTUALIZADOS:", result.rowCount);

  } catch (error) {

    console.error("❌ ERROR deleting stock picking:", error);
    throw error;

  }
}