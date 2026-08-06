import { db } from "../../db.js";
import { callERPExistenciaAlmacen } from "./erpClient.js"

export function buildBuscarExistenciaAlmacenXML({
    pagina = 0,
    cantidadPorPagina = 100,
    almacenId = 1,
    estatus = "A",
    excluirSinExistencia = false,
} = {}) {
    return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xmlns:xsd="http://www.w3.org/2001/XMLSchema"
    xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
    xmlns:bas="BaseModel.Where">
  <soap:Body>
    <BuscarExistenciaAlmacen xmlns="http://tempuri.org/">
      <existenciaWhere>
        <bas:Pagina>${pagina}</bas:Pagina>
        <bas:CantidadPorPagina>${cantidadPorPagina}</bas:CantidadPorPagina>

        <AlmacenId>${almacenId}</AlmacenId>
        <Estatus>${estatus}</Estatus>
        <ExcluirSinExistencia>${excluirSinExistencia}</ExcluirSinExistencia>
      </existenciaWhere>
    </BuscarExistenciaAlmacen>
  </soap:Body>
</soap:Envelope>`;
}


export async function buscarTodasLasExistenciasAlmacen(client, sessionId) {

   if (!sessionId) {
    throw new Error("sessionId es requerido en buscarTodasLasExistenciasAlmacen");
  } 

    const sessionResult = await client.query(
    `
    SELECT
      erp_warehouse_id
    FROM inventory_sessions
    WHERE id = $1
    LIMIT 1
    `,
    [sessionId]
  );

  if (sessionResult.rows.length === 0) {
    throw new Error(
      `No se encontró una sesión de inventario con ID ${sessionId}`
    );
  }

  const erpWarehouseId = Number(
    sessionResult.rows[0].erp_warehouse_id
  );

  if (!erpWarehouseId) {
    throw new Error(
      `La sesión ${sessionId} no tiene un erp_warehouse_id válido`
    );
  }

  console.log("🏭 ERP WAREHOUSE ID:", erpWarehouseId);
  
  const cantidadPorPagina = 3000;
  let pagina = 0;
  let todasLasExistencias = [];

  while (true) {
    console.log("======================================");
    console.log(`📡 Buscando existencias página ${pagina}`);
    console.log("======================================");

    const xml = buildBuscarExistenciaAlmacenXML({
      pagina,
      cantidadPorPagina,
      almacenId: erpWarehouseId,
      estatus: "A",
      excluirSinExistencia: false,
    });

    const data = await callERPExistenciaAlmacen(xml);

    const existenciasPagina = data?.Data?.Existencias ?? [];

    console.log(
      `📦 Existencias recibidas en página ${pagina}:`,
      existenciasPagina.length
    );

    if (existenciasPagina.length === 0) {
      console.log("🛑 No hay más existencias para buscar");
      break;
    }

    const existenciasLimpias = existenciasPagina.map((item) => ({
      ItemId: item.ItemId,
      AlmacenId: item.AlmacenId,
      Cantidad: item.Cantidad,
      Costo: item.Costo,
    }));

    todasLasExistencias.push(...existenciasLimpias);

    if (existenciasPagina.length < cantidadPorPagina) {
      console.log(
        `✅ Última página detectada porque trajo menos de ${cantidadPorPagina} registros`
      );
      break;
    }

    pagina++;
  }

  console.log("======================================");
  console.log("📦 TOTAL GENERAL EXISTENCIAS:", todasLasExistencias.length);
  console.log("======================================");

  const existenciasPorProductoMap = new Map();

  for (const item of todasLasExistencias) {
    const itemId = item.ItemId;

    if (!existenciasPorProductoMap.has(itemId)) {
      existenciasPorProductoMap.set(itemId, {
        ItemId: item.ItemId,
        TotalCantidad: 0,
        Costo: item.Costo,
      });
    }

    const producto = existenciasPorProductoMap.get(itemId);

    producto.TotalCantidad += Number(item.Cantidad || 0);

    // Último costo encontrado para ese ItemId
    producto.Costo = item.Costo;
  }

  const existenciasPorProducto = Array.from(
    existenciasPorProductoMap.values()
  )
    .filter((producto) => Number(producto.TotalCantidad) !== 0)
    .map((producto) => ({
      ItemId: producto.ItemId,
      TotalCantidad: producto.TotalCantidad,
      Costo: producto.Costo,
    }));

  console.log("📦 EXISTENCIAS SEPARADAS POR PRODUCTO:");
  console.log(JSON.stringify(existenciasPorProducto, null, 2));
  console.log("📦 TOTAL PRODUCTOS CON EXISTENCIA:", existenciasPorProducto.length);

 

  try {
  

    const syncResult = await syncExistenciasERPWithProductsService(
      client,
      existenciasPorProducto,
      sessionId
    );



    console.log("🟢 RESULTADO SYNC PRODUCTS:");
    console.log("Total recibidos:", syncResult.totalRecibidos);
    console.log("Total actualizados:", syncResult.totalActualizados);

    return {
      success: true,
      totalExistencias: todasLasExistencias.length,
      totalProductos: existenciasPorProducto.length,
      existencias: existenciasPorProducto,
      sync: syncResult,
      ultimaPaginaConsultada: pagina,
    };
  } catch (error) {
  

    console.error("🔥 ERROR SYNC EXISTENCIAS ERP/WMS:");
    console.error(error.message);

    throw error;
  } 
}



export async function syncExistenciasERPWithProductsService(
  client,
  existenciasPorProducto,
  sessionId
) {
  if (!Array.isArray(existenciasPorProducto)) {
    throw new Error("existenciasPorProducto debe ser un array");
  }

  if (existenciasPorProducto.length === 0) {
    return {
      success: true,
      totalRecibidos: 0,
      totalSnapshotGuardados: 0,
      totalLimpiados: 0,
      totalActualizados: 0,
      message: "No hay existencias para actualizar",
    };
  }

  // =====================================================
  // 1️⃣ GUARDAR SNAPSHOT ERP EN erp_inventory_snapshot
  // =====================================================
  console.log("📸 Antes de guardar snapshot ERP...");

  const snapshotResult = await saveERPInventorySnapshotService(
    client,
    existenciasPorProducto,
    sessionId
  );

  console.log("📸 Resultado snapshot ERP:", snapshotResult);

  if (!snapshotResult.success) {
    throw new Error(snapshotResult.message || "Error guardando snapshot ERP");
  }

  // =====================================================
  // 2️⃣ PREPARAR PAYLOAD
  // =====================================================
  const payload = existenciasPorProducto.map((item) => ({
    ItemId: Number(item.ItemId),
    TotalCantidad: Number(item.TotalCantidad || 0),
    Costo: Number(item.Costo || 0),
  }));

  // =====================================================
// 3️⃣ LIMPIAR COLUMNAS ANTES DEL SYNC
// =====================================================
const limpiezaResult = await client.query(`
  UPDATE products
  SET
    unit_cost = 0,
    erp_stock = 0,
    updated_at = NOW()
`);

console.log("🧹 Productos limpiados antes del sync:", limpiezaResult.rowCount);

// =====================================================
// 4️⃣ ACTUALIZAR SOLO LOS PRODUCTOS QUE EXISTEN EN ERP
// =====================================================
const result = await client.query(
  `
  WITH incoming AS (
    SELECT
      x."ItemId"::int AS item_id,
      x."TotalCantidad"::numeric AS total_cantidad,
      x."Costo"::numeric AS costo
    FROM jsonb_to_recordset($1::jsonb) AS x(
      "ItemId" int,
      "TotalCantidad" numeric,
      "Costo" numeric
    )
  )
  UPDATE products p
  SET
    unit_cost = COALESCE(incoming.costo, 0),
    erp_stock = COALESCE(incoming.total_cantidad, 0),
    updated_at = NOW()
  FROM incoming
  WHERE p.erp_id = incoming.item_id
  RETURNING 
    p.id,
    p.sku,
    p.erp_id,
    p.unit_cost,
    p.erp_stock
  `,
  [JSON.stringify(payload)]
);

  console.log("🟢 Productos actualizados con ERP:", result.rowCount);

  return {
    success: true,
    totalRecibidos: payload.length,
    snapshot: snapshotResult,
    totalSnapshotGuardados: snapshotResult.totalGuardados,
    totalLimpiados: limpiezaResult.rowCount,
    totalActualizados: result.rowCount,
    productosActualizados: result.rows,
  };
}



export async function saveERPInventorySnapshotService(
  client,
  existenciasPorProducto,
  sessionId
) {
  try {
    const sessionInventoryId = sessionId; // por ahora fijo

    console.log("🟥🟥 SESSION ID ", sessionId);

    if (!Array.isArray(existenciasPorProducto)) {
      throw new Error("existenciasPorProducto debe ser un array");
    }

    if (existenciasPorProducto.length === 0) {
      console.log("⚠️ No hay existencias para guardar en snapshot ERP");

      return {
        success: true,
        totalRecibidos: 0,
        totalGuardados: 0,
        message: "No hay existencias para guardar",
      };
    }

    console.log("======================================");
    console.log("📸 GUARDANDO SNAPSHOT ERP");
    console.log("🧾 Session Inventory ID:", sessionInventoryId);
    console.log("📦 Total productos recibidos:", existenciasPorProducto.length);
    console.log("======================================");

    const result = await client.query(
      `
      WITH incoming AS (
        SELECT
          x."ItemId"::int AS item_id,
          x."TotalCantidad"::numeric AS erp_stock,
          x."Costo"::numeric AS unit_cost
        FROM jsonb_to_recordset($1::jsonb) AS x(
          "ItemId" int,
          "TotalCantidad" numeric,
          "Costo" numeric
        )
      )
      INSERT INTO erp_inventory_snapshot (
        session_inventory_id,
        item_id,
        erp_stock,
        unit_cost,
        created_at
      )
      SELECT
        $2,
        incoming.item_id,
        incoming.erp_stock,
        incoming.unit_cost,
        NOW()
      FROM incoming
      ON CONFLICT (session_inventory_id, item_id)
      DO UPDATE SET
        erp_stock = EXCLUDED.erp_stock,
        unit_cost = EXCLUDED.unit_cost,
        created_at = NOW()
      RETURNING
        id,
        session_inventory_id,
        item_id,
        erp_stock,
        unit_cost
      `,
      [JSON.stringify(existenciasPorProducto), sessionInventoryId]
    );

    console.log("✅ Snapshot ERP guardado correctamente");
    console.log("📦 Total guardados/actualizados:", result.rowCount);

    return {
      success: true,
      sessionInventoryId,
      totalRecibidos: existenciasPorProducto.length,
      totalGuardados: result.rowCount,
      snapshotLines: result.rows,
    };
  } catch (error) {
    console.error("❌ Error saveERPInventorySnapshotService:");
    console.error(error.message);

    return {
      success: false,
      message: "Error guardando snapshot ERP",
      error: error.message,
    };
  }
}