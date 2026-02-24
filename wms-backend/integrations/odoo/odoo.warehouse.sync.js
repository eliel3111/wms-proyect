import { getOdooWarehouses } from "../services/odoo.service.js";
import {
  findWarehouseByErpId,
  insertWarehouse,
  updateWarehouse
} from "../repositories/warehouse.repository.js";

export async function syncWarehouses(uid) {

  console.log("🔄 Sync warehouses iniciado");

  const odooWarehouses = await getOdooWarehouses(uid);

  for (const wh of odooWarehouses) {

    const existing = await findWarehouseByErpId(wh.id);

    const formattedData = {
      erp_id: wh.id,
      name: wh.name,
      code: wh.code,
      status: wh.active ? "ACTIVE" : "INACTIVE",
      erp_location_id: wh.lot_stock_id?.[0] || null
    };

    if (!existing) {
      console.log("➕ Insertando warehouse:", wh.name);
      await insertWarehouse(formattedData);
    } else {
      console.log("✏️ Actualizando warehouse:", wh.name);
      await updateWarehouse(formattedData);
    }
  }

  console.log("✅ Sync warehouses finalizado");
}