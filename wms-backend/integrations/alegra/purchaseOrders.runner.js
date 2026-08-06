//FILE: purchaseOrders.runner.js
import db from "../../db.js";


import {
  alegraPurchaseOrdersService
} from "./alegraItemService.js";

import {
  reconcileAllPurchaseOrders
} from "./alegra.purchaseOrder.js";

/**
 * Obtiene todas las órdenes de compra desde Alegra
 * y las sincroniza con la tabla purchase_orders del WMS.
 */
export async function runPurchaseOrdersSync() {
  console.log("");
  console.log("🚀 ========================================");
  console.log("🚀 INICIANDO SYNC DE ÓRDENES DE COMPRA");
  console.log("🕒 Fecha:", new Date().toISOString());
  console.log("🚀 ========================================");

  /*
   * alegraItemService.js ya tiene la paginación completa.
   */
  const alegraOrders =
    await alegraPurchaseOrdersService.getAllPurchaseOrders();

  if (!Array.isArray(alegraOrders)) {
    throw new Error(
      "Alegra no devolvió un arreglo de órdenes de compra"
    );
  }

  console.log(
    "📦 Total de órdenes obtenidas desde Alegra:",
    alegraOrders.length
  );

  const clientDb = await db.connect();

  try {
    const result =
      await reconcileAllPurchaseOrders(
        clientDb,
        alegraOrders
      );

    console.log("");
    console.log("✅ SYNC FINALIZADO");
    console.log("📊 Resultado:", result);

    return result;
  } catch (error) {
    console.error("");
    console.error(
      "🔥 ERROR EJECUTANDO SYNC DE ÓRDENES:",
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