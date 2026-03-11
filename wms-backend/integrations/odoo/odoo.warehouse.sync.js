console.log("🚨🚨🚨 ESTE ES EL FILE REAL QUE NODE ESTA EJECUTANDO 🚨🚨🚨");
import { getOdooClient } from "./odoo.client.js";
import { getOdooUid } from "./odoo.session.js";
import { db } from "../../db.js";
import { lockSyncControl, finishSyncControl, SYNC_STATUS } from "./syncControl.js";

const MODEL = "stock.warehouse";

/* =========================================
   🔵 OBTENER WAREHOUSES ODOO
========================================= */
async function getOdooWarehouses(uid) {

  const client = getOdooClient("object");

  return new Promise((resolve, reject) => {
    client.methodCall(
      "execute_kw",
      [
        process.env.ODOO_DB,
        uid,
        process.env.ODOO_API_KEY,
        MODEL,
        "search_read",
        [[]],
        {
          fields: ["id", "name", "code", "active", "lot_stock_id", "write_date"]
        }
      ],
      (err, value) => {
        if (err) return reject(err);
        resolve(value || []);
      }
    );
  });
}

/* =========================================
   🔵 UPSERT WAREHOUSE
========================================= */
async function upsertWarehouse(wh) {

  const formatted = {
    erp_id: wh.id,
    name: wh.name,
    code: wh.code,
    status: wh.active ? "ACTIVE" : "INACTIVE",
    erp_location_id: wh.lot_stock_id?.[0] || null
  };

  await db.query(`
    INSERT INTO warehouses (erp_warehouse_id,name,code,status,erp_location_id)
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (erp_warehouse_id)
    DO UPDATE SET
      name = EXCLUDED.name,
      code = EXCLUDED.code,
      status = EXCLUDED.status,
      erp_location_id = EXCLUDED.erp_location_id,
      updated_at = NOW()
  `, [
    formatted.erp_id,
    formatted.name,
    formatted.code,
    formatted.status,
    formatted.erp_location_id
  ]);
}

/* =========================================
   🚀 SYNC PRINCIPAL
========================================= */
export async function syncWarehousesFull() {

  const model = "stock.warehouse";

  const lock = await lockSyncControl(model);
  if (!lock) {
    console.log("[SYNC] warehouses ya corriendo");
    return;
  }

  let maxWriteDate = lock.lastWriteDate;

  try {
    console.log("🔄 Sync warehouses iniciado");

    const uid = await getOdooUid();

    const odooWarehouses = await getOdooWarehouses(uid);

    console.log("📦 Warehouses recibidos:", odooWarehouses.length);
    console.log("ANTES DEL LOOP");
    for (const wh of odooWarehouses) {

      console.log("Aqui se eliel: ", wh);
      await upsertWarehouse(wh);
      

      const dbDate = new Date(maxWriteDate);
      const odooDate = new Date(wh.write_date);

      console.log("fecha en la DB: ", dbDate);
      console.log("fecha del almacen: ", odooDate);

      if (wh.write_date && odooDate > dbDate) {
        maxWriteDate = odooDate;
        console.log("NUEVA FECHA DE REFERENCIA: ", maxWriteDate);
      }

      console.log("✔ synced:", wh.name);
    }

    await finishSyncControl(
      model,
      SYNC_STATUS.SUCCESS,
      maxWriteDate
    );

    console.log("✅ Sync warehouses finalizado");

  } catch (error) {

    console.error("❌ Sync warehouses error:", error);

    await finishSyncControl(
      model,
      SYNC_STATUS.FAILED,
      maxWriteDate,
      error.message
    );

    throw error;
  }
}