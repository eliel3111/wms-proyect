
import admcloudClient from "./admcloudClient.js";

// ============================================================
// ADM CLOUD - INVENTARIO / EXISTENCIAS
// Archivo: integrations/admcloud/admcloud.erpStockSync.js
// API: GET /api/Stock
//
// 1. getAdmCloudStockService: consulta por producto o almacén.
// 2. buscarTodasLasExistenciasAlmacen: consulta y sincroniza
//    el stock de la bodega de una sesión.
// 3. saveERPInventorySnapshotService: guarda el snapshot.
// 4. syncExistenciasERPWithProductsService: actualiza products.
// 5. buscarExistenciaActualAdmCloud: consulta SOLO una cantidad.
//
// IMPORTANTE:
// - products.erp_id debe almacenar GUID como texto.
// - erp_inventory_snapshot.item_id debe almacenar GUID como texto.
// - inventory_sessions.erp_warehouse_id debe almacenar GUID como texto.
// - Este archivo NO CREA ajustes en ADM Cloud.
// ============================================================

const GUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STOCK_PAGE_SIZE = 500;
const MAX_STOCK_PAGES = 200;

function createStockError(message, statusCode = 400, code = "ADMCLOUD_STOCK_ERROR") {
  return Object.assign(new Error(message), { statusCode, code });
}

function requireGuid(value, fieldName) {
  const id = String(value ?? "").trim();
  if (!GUID_REGEX.test(id)) {
    throw createStockError(
      `${fieldName} debe ser un GUID válido. Valor recibido: ${id || "(vacío)"}`,
      400,
      `INVALID_${fieldName.toUpperCase()}`
    );
  }
  return id.toLowerCase();
}

function requireNumber(value, fieldName, itemId) {
  // No tratar null / undefined / '' como cero: son datos ausentes.
  if (value === null || value === undefined || value === "") {
    throw createStockError(
      `ADM Cloud no devolvió ${fieldName} para el producto ${itemId}.`,
      502,
      "INVALID_ADMCLOUD_STOCK_VALUE"
    );
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw createStockError(
      `ADM Cloud devolvió ${fieldName} inválido para ${itemId}: ${value}`,
      502,
      "INVALID_ADMCLOUD_STOCK_VALUE"
    );
  }
  return number;
}

// ============================================================
// 1. CONSULTAR /api/Stock
//
// Admite ItemID o SKU para un producto, o ninguno para
// consultar TODOS los productos de una ubicación.
// 'take=0' solicita el resto del listado según la documentación.
// ============================================================
export async function getAdmCloudStockService({
  itemId = null,
  sku = null,
  locationId,
  skip = 0,
  take = 0,
  showNoStock = true,
  toDate = null
} = {}) {
  const normalizedItemId = String(itemId ?? "").trim();
  const normalizedSku = String(sku ?? "").trim();
  const normalizedLocationId = requireGuid(locationId, "LocationID");

  if (normalizedItemId && normalizedSku) {
    throw createStockError("Envía ItemID o SKU, no ambos.");
  }
  if (normalizedItemId) {
    requireGuid(normalizedItemId, "ItemID");
  }
  if (
    !Number.isInteger(skip) || skip < 0 ||
    !Number.isInteger(take) || take < 0
  ) {
    throw createStockError("skip y take deben ser enteros no negativos.");
  }
  if (typeof showNoStock !== "boolean") {
    throw createStockError("showNoStock debe ser un booleano.");
  }
  if (toDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(toDate))) {
    throw createStockError("toDate debe tener formato YYYY-MM-DD.");
  }

  const params = {
    skip,
    take,
    LocationID: normalizedLocationId,
    ShowNoStock: showNoStock
  };
  if (normalizedItemId) params.ItemID = normalizedItemId;
  if (normalizedSku) params.SKU = normalizedSku;
  if (toDate) params.ToDate = toDate;

  console.log("📡 ADM CLOUD GET /Stock", {
    itemId: normalizedItemId || null,
    sku: normalizedSku || null,
    locationId: normalizedLocationId,
    skip,
    take
  });

  // admcloudClient aplica automáticamente Basic Auth, company, role, appid.
  const response = await admcloudClient.get("/Stock", { params });
  const body = response.data;

  if (body?.success !== true) {
    throw createStockError(
      body?.message || "ADM Cloud rechazó la consulta de inventario.",
      502,
      "ADMCLOUD_STOCK_REJECTED"
    );
  }
  if (!Array.isArray(body.data)) {
    throw createStockError(
      "La respuesta de ADM Cloud no contiene un array en data.",
      502,
      "INVALID_ADMCLOUD_STOCK_RESPONSE"
    );
  }

  console.log(`✅ ADM CLOUD STOCK: ${body.data.length} filas recibidas`);

  return {
    success: true,
    message: body.message || "Stock consultado correctamente.",
    httpStatus: response.status,
    filters: {
      itemId: normalizedItemId || null,
      sku: normalizedSku || null,
      locationId: normalizedLocationId,
      skip,
      take,
      showNoStock,
      toDate
    },
    data: body.data,
    rawResponse: body
  };
}

// ============================================================
// 2. TODAS LAS EXISTENCIAS DEL ALMACÉN DE UNA SESIÓN
// Equivalente de Citrus: buscarTodasLasExistenciasAlmacen.
//
// Respeta la conexión 'client' que recibe del controller para
// que snapshot + products participen en la misma transacción.
// ============================================================
export async function buscarTodasLasExistenciasAlmacen(client, sessionId) {
  if (!client || typeof client.query !== "function") {
    throw createStockError("Se requiere un cliente de PostgreSQL.");
  }
  if (!sessionId) {
    throw createStockError("sessionId es requerido.");
  }

  const sessionResult = await client.query(
    `SELECT erp_warehouse_id
       FROM inventory_sessions
      WHERE id = $1
      LIMIT 1`,
    [sessionId]
  );
  if (!sessionResult.rowCount) {
    throw createStockError(`No existe la sesión ${sessionId}.`, 404);
  }

  const erpWarehouseId = requireGuid(
    sessionResult.rows[0].erp_warehouse_id,
    "erp_warehouse_id"
  );

  console.log("========================================");
  console.log("🏬 ADM CLOUD - SYNC EXISTENCIAS ALMACÉN");
  console.log("🆔 SESSION ID:", sessionId);
  console.log("🏭 LOCATION ID:", erpWarehouseId);

  const allRows = [];
  const pageSignatures = new Set();
  let skip = 0;
  let pagesConsulted = 0;
  let completed = false;

  while (pagesConsulted < MAX_STOCK_PAGES) {
    const result = await getAdmCloudStockService({
      locationId: erpWarehouseId,
      skip,
      take: STOCK_PAGE_SIZE,
      showNoStock: true
    });
    const rows = result.data;
    pagesConsulted++;

    if (rows.length === 0) {
      completed = true;
      break;
    }

    // Detecta una API que ignora 'skip' y repite la misma página.
    const signature = JSON.stringify([
      rows.length,
      rows[0]?.ID,
      rows[rows.length - 1]?.ID
    ]);
    if (pageSignatures.has(signature)) {
      throw createStockError(
        `ADM Cloud repitió una página con skip=${skip}. No se sincronizó un inventario incompleto.`,
        502,
        "REPEATED_STOCK_PAGE"
      );
    }
    pageSignatures.add(signature);

    allRows.push(...rows);
    console.log(`📦 Página ${pagesConsulted}: ${rows.length} filas (acumuladas ${allRows.length})`);
    skip += rows.length;
  }

  if (!completed) {
    throw createStockError(
      `Se alcanzó el máximo de ${MAX_STOCK_PAGES} páginas sin finalizar la consulta.`,
      502,
      "STOCK_PAGINATION_LIMIT"
    );
  }

  // Agrupar como en Citrus, pero Stock y AverageCost son
  // los campos CORRECTOS para la ubicación seleccionada.
  const byItemId = new Map();
  for (const row of allRows) {
    const id = requireGuid(row?.ID, "ItemID");
    const quantity = requireNumber(row.Stock, "Stock", id);
    const cost = requireNumber(row.AverageCost, "AverageCost", id);
    const totalCost = requireNumber(row.TotalCost, "TotalCost", id);

    let item = byItemId.get(id);
    if (!item) {
      item = {
        ItemId: id,
        SKU: String(row.SKU ?? "").trim(),
        Name: row.Name ?? null,
        AlmacenId: erpWarehouseId,
        TotalCantidad: 0,
        Costo: cost,
        TotalCosto: 0,
        UOMID: row.UOMID ?? null
      };
      byItemId.set(id, item);
    }
    item.TotalCantidad += quantity;
    item.TotalCosto += totalCost;
    // Si hay varias filas del mismo artículo, usar costo ponderado.
    item.Costo = item.TotalCantidad !== 0
      ? item.TotalCosto / item.TotalCantidad
      : cost;
  }

  // Incluimos los productos con Stock=0 en el snapshot.
  // Es necesario para poder ajustar un producto de 0 a >0.
  const existenciasPorProducto = [...byItemId.values()];

  console.log("📦 FILAS DE STOCK:", allRows.length);
  console.log("📦 PRODUCTOS ÚNICOS:", existenciasPorProducto.length);
  console.log("📦 EJEMPLO:", existenciasPorProducto.slice(0, 3));

  const syncResult = await syncExistenciasERPWithProductsService(
    client,
    existenciasPorProducto,
    sessionId
  );

  return {
    success: true,
    totalExistencias: allRows.length,
    totalProductos: existenciasPorProducto.length,
    existencias: existenciasPorProducto,
    sync: syncResult,
    ultimaPaginaConsultada: pagesConsulted,
    erpWarehouseId
  };
}

// ============================================================
// 3. SNAPSHOT POR SESIÓN
// Requiere erp_inventory_snapshot.item_id = TEXT (GUID).
// ============================================================
export async function saveERPInventorySnapshotService(
  client,
  existenciasPorProducto,
  sessionId
) {
  if (!client || typeof client.query !== "function") {
    throw createStockError("Se requiere cliente PostgreSQL.");
  }
  if (!sessionId) {
    throw createStockError("sessionId es requerido.");
  }
  if (!Array.isArray(existenciasPorProducto)) {
    throw createStockError("existenciasPorProducto debe ser un array.");
  }
  if (existenciasPorProducto.length === 0) {
    return { success: true, totalRecibidos: 0, totalGuardados: 0, snapshotLines: [] };
  }

  const payload = existenciasPorProducto.map(item => ({
    ItemId: requireGuid(item.ItemId, "ItemID"),
    TotalCantidad: requireNumber(item.TotalCantidad, "TotalCantidad", item.ItemId),
    Costo: requireNumber(item.Costo, "Costo", item.ItemId)
  }));

  const result = await client.query(
    `WITH incoming AS (
       SELECT x."ItemId"::text AS item_id,
              x."TotalCantidad"::numeric AS erp_stock,
              x."Costo"::numeric AS unit_cost
         FROM jsonb_to_recordset($1::jsonb)
           AS x("ItemId" text, "TotalCantidad" numeric, "Costo" numeric)
     )
     INSERT INTO erp_inventory_snapshot (
       session_inventory_id, item_id, erp_stock, unit_cost, created_at
     )
     SELECT $2, item_id, erp_stock, unit_cost, NOW()
       FROM incoming
     ON CONFLICT (session_inventory_id, item_id)
     DO UPDATE SET
       erp_stock = EXCLUDED.erp_stock,
       unit_cost = EXCLUDED.unit_cost,
       created_at = NOW()
     RETURNING id, session_inventory_id, item_id, erp_stock, unit_cost`,
    [JSON.stringify(payload), sessionId]
  );

  console.log("📸 SNAPSHOT GUARDADO:", result.rowCount, "líneas");
  return {
    success: true,
    sessionInventoryId: sessionId,
    totalRecibidos: payload.length,
    totalGuardados: result.rowCount,
    snapshotLines: result.rows
  };
}

// ============================================================
// 4. SINCRONIZAR SNAPSHOT Y PRODUCTS
//
// A diferencia de la función vieja de Citrus, NO se hace
// UPDATE products SET unit_cost=0, erp_stock=0 SIN WHERE.
// Eso dañaría datos de otros almacenes o ERPs.
// ============================================================
export async function syncExistenciasERPWithProductsService(
  client,
  existenciasPorProducto,
  sessionId
) {
  if (!Array.isArray(existenciasPorProducto)) {
    throw createStockError("existenciasPorProducto debe ser un array.");
  }

  const snapshot = await saveERPInventorySnapshotService(
    client,
    existenciasPorProducto,
    sessionId
  );

  if (existenciasPorProducto.length === 0) {
    return {
      success: true,
      totalRecibidos: 0,
      totalSnapshotGuardados: 0,
      totalLimpiados: 0,
      totalActualizados: 0,
      snapshot,
      productosActualizados: []
    };
  }

  const payload = existenciasPorProducto.map(item => ({
    ItemId: requireGuid(item.ItemId, "ItemID"),
    TotalCantidad: requireNumber(item.TotalCantidad, "TotalCantidad", item.ItemId),
    Costo: requireNumber(item.Costo, "Costo", item.ItemId)
  }));

  const result = await client.query(
    `WITH incoming AS (
       SELECT x."ItemId"::text AS item_id,
              x."TotalCantidad"::numeric AS total_cantidad,
              x."Costo"::numeric AS costo
         FROM jsonb_to_recordset($1::jsonb)
           AS x("ItemId" text, "TotalCantidad" numeric, "Costo" numeric)
     )
     UPDATE products p
        SET unit_cost = incoming.costo,
            erp_stock = incoming.total_cantidad,
            updated_at = NOW()
       FROM incoming
      WHERE p.erp_id::text = incoming.item_id
     RETURNING p.id, p.sku, p.erp_id, p.unit_cost, p.erp_stock`,
    [JSON.stringify(payload)]
  );

  console.log("🟢 PRODUCTS ACTUALIZADOS:", result.rowCount);
  return {
    success: true,
    totalRecibidos: payload.length,
    snapshot,
    totalSnapshotGuardados: snapshot.totalGuardados,
    totalLimpiados: 0,
    totalActualizados: result.rowCount,
    productosActualizados: result.rows
  };
}

// ============================================================
// 5. EXISTENCIA ACTUAL DE UN PRODUCTO (SOLO LECTURA)
// Equivalente a buscarExistenciaActualCitrus.
// Útil para verificar si el ERP aplicó un ajuste tras timeout.
//
// return: número (Stock), nunca AllLocationStock.
// ============================================================
export async function buscarExistenciaActualAdmCloud({
  itemId = null,
  sku = null,
  almacenId = null,
  locationId = null
} = {}) {
  const normalizedLocationId = requireGuid(
    locationId ?? almacenId,
    "LocationID"
  );
  const normalizedItemId = String(itemId ?? "").trim();
  const normalizedSku = String(sku ?? "").trim();

  if (Boolean(normalizedItemId) === Boolean(normalizedSku)) {
    throw createStockError("Proporciona exactamente un filtro: itemId o sku.");
  }
  if (normalizedItemId) requireGuid(normalizedItemId, "ItemID");

  console.log("🔎 ADM CLOUD - STOCK ACTUAL", {
    itemId: normalizedItemId || null,
    sku: normalizedSku || null,
    locationId: normalizedLocationId
  });

  const result = await getAdmCloudStockService({
    itemId: normalizedItemId || null,
    sku: normalizedSku || null,
    locationId: normalizedLocationId,
    skip: 0,
    take: 0,
    showNoStock: true
  });

  const matching = result.data.filter(row => {
    if (normalizedItemId) {
      return String(row?.ID ?? "").toLowerCase() === normalizedItemId.toLowerCase();
    }
    return String(row?.SKU ?? "").trim().toLowerCase() === normalizedSku.toLowerCase();
  });

  // Misma semántica que Citrus: búsqueda válida sin filas => 0.
  // Esta conclusión solo es segura porque la solicitud terminó
  // correctamente y la respuesta fue validada.
  if (matching.length === 0) {
    console.log("ℹ️ Producto sin filas de stock; cantidad actual: 0");
    return 0;
  }

  const total = matching.reduce(
    (acc, row) => acc + requireNumber(row.Stock, "Stock", row.ID || normalizedSku),
    0
  );
  console.log("✅ STOCK ACTUAL DEL ALMACÉN:", total);
  return total;
}
