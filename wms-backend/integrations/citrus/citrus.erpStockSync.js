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











// ============================================================
// BUSCAR EXISTENCIA ACTUAL DE UN PRODUCTO EN CITRUS
// ============================================================
//
// OBJETIVO:
//
// Buscar la existencia REAL ACTUAL de UN producto
// dentro de UN almacén.
//
// Este servicio es utilizado por el worker cuando:
//
// - Citrus no respondió al ajuste.
// - Hubo timeout.
// - Se perdió la conexión.
// - El backend no sabe si Citrus aplicó el ajuste.
//
// IMPORTANTE:
//
// Esta función:
//
// ✅ SOLO CONSULTA CITRUS.
// ✅ NO modifica products.
// ✅ NO modifica inventory.
// ✅ NO guarda snapshot.
// ✅ NO ejecuta sync.
// ✅ NO hace ajustes.
//
// Devuelve solamente la cantidad actual.
//
// Ejemplo:
//
// const cantidad = await buscarExistenciaActualCitrus({
//   itemId: 13465,
//   almacenId: 1
// });
//
// Resultado:
//
// 120
//
// ============================================================

export async function buscarExistenciaActualCitrus({
  itemId,
  almacenId
}) {

  console.log("");
  console.log(
    "🔎🔎🔎 ========================================"
  );

  console.log(
    "📦 BUSCANDO EXISTENCIA ACTUAL EN CITRUS"
  );

  console.log(
    "🔎🔎🔎 ========================================"
  );


  // ============================================================
  // 1. VALIDAR ITEM ID
  // ============================================================

  const parsedItemId =
    Number(
      itemId
    );


  if (
    !Number.isInteger(
      parsedItemId
    ) ||
    parsedItemId <= 0
  ) {

    throw new Error(
      `ItemId inválido para consultar existencia. Valor recibido: ${itemId}`
    );

  }



  // ============================================================
  // 2. VALIDAR ALMACÉN
  // ============================================================

  const parsedAlmacenId =
    Number(
      almacenId
    );


  if (
    !Number.isInteger(
      parsedAlmacenId
    ) ||
    parsedAlmacenId <= 0
  ) {

    throw new Error(
      `AlmacenId inválido para consultar existencia. Valor recibido: ${almacenId}`
    );

  }



  console.log(
    "🆔 ITEM ID:",
    parsedItemId
  );


  console.log(
    "🏭 ALMACÉN ID:",
    parsedAlmacenId
  );



  // ============================================================
  // 3. CONFIGURACIÓN
  // ============================================================
  //
  // Actualmente tu consulta general utiliza 3000.
  //
  // Como tienes aproximadamente 2,700 productos,
  // normalmente Citrus debería devolver todo en
  // una sola página.
  //
  // Pero mantenemos paginación por seguridad.
  //
  // ============================================================

  const cantidadPorPagina =
    3000;


  const MAX_PAGES =
    100;


  let pagina =
    0;


  let cantidadTotal =
    0;


  let productoEncontrado =
    false;



  // ============================================================
  // 4. BUSCAR EN CITRUS
  // ============================================================

  while (
    pagina < MAX_PAGES
  ) {

    console.log("");
    console.log(
      "────────────────────────────────────────"
    );

    console.log(
      `📡 CONSULTANDO CITRUS - PÁGINA ${pagina}`
    );

    console.log(
      "────────────────────────────────────────"
    );



    // ==========================================================
    // CONSTRUIR SOAP
    // ==========================================================

    const xml =
      buildBuscarExistenciaAlmacenXML({

        pagina,

        cantidadPorPagina,

        almacenId:
          parsedAlmacenId,

        estatus:
          "A",

        // IMPORTANTE:
        //
        // false porque necesitamos poder determinar
        // correctamente si un producto tiene 0.
        excluirSinExistencia:
          false

      });



    // ==========================================================
    // LLAMAR CITRUS
    // ==========================================================

    const data =
      await callERPExistenciaAlmacen(
        xml
      );



    // ==========================================================
    // 5. VALIDAR RESPUESTA CITRUS
    // ==========================================================

    if (!data) {

      throw new Error(
        "Citrus devolvió una respuesta vacía al consultar existencia."
      );

    }



    // Si Citrus incluye Success en la respuesta,
    // validamos el valor.
    //
    // No exigimos que exista porque tu servicio
    // actual consume directamente Data.Existencias.

    if (
      data.Success !== undefined &&
      data.Success !== null
    ) {

      const citrusSuccess =
        Number(
          data.Success
        );


      if (
        citrusSuccess === 0
      ) {

        const message =
          data.Mensaje ||
          "Citrus rechazó la consulta de existencia.";


        throw new Error(
          message
        );

      }

    }



    // ==========================================================
    // 6. OBTENER EXISTENCIAS DE LA PÁGINA
    // ==========================================================

    const existenciasPagina =
      data?.Data?.Existencias ?? [];


    if (
      !Array.isArray(
        existenciasPagina
      )
    ) {

      throw new Error(
        "Citrus devolvió un formato inválido en Data.Existencias."
      );

    }



    console.log(
      `📦 PRODUCTOS RECIBIDOS EN PÁGINA ${pagina}:`,
      existenciasPagina.length
    );



    // ==========================================================
    // NO HAY MÁS REGISTROS
    // ==========================================================

    if (
      existenciasPagina.length === 0
    ) {

      console.log(
        "🛑 NO HAY MÁS EXISTENCIAS EN CITRUS"
      );

      break;

    }



    // ==========================================================
    // 7. BUSCAR SOLAMENTE EL PRODUCTO NECESARIO
    // ==========================================================

    for (
      const item
      of existenciasPagina
    ) {

      const currentItemId =
        Number(
          item?.ItemId
        );


      if (
        currentItemId !==
        parsedItemId
      ) {

        continue;

      }



      // ========================================================
      // PRODUCTO ENCONTRADO
      // ========================================================

      productoEncontrado =
        true;


      const cantidad =
        Number(
          item?.Cantidad ?? 0
        );


      if (
        !Number.isFinite(
          cantidad
        )
      ) {

        throw new Error(
          `Citrus devolvió una cantidad inválida para ItemId ${parsedItemId}.`
        );

      }



      // ========================================================
      // SUMAR EXISTENCIAS
      // ========================================================
      //
      // Lo hacemos así porque tu servicio actual también
      // agrupa por ItemId y suma Cantidad.
      //
      // Si Citrus devuelve más de una fila para el mismo
      // producto, obtenemos el total correctamente.
      //
      // ========================================================

      cantidadTotal +=
        cantidad;


      console.log(
        "✅ PRODUCTO ENCONTRADO:"
      );


      console.log({

        ItemId:
          item.ItemId,

        AlmacenId:
          item.AlmacenId,

        Cantidad:
          cantidad

      });

    }



    // ==========================================================
    // 8. DETECTAR ÚLTIMA PÁGINA
    // ==========================================================

    if (
      existenciasPagina.length <
      cantidadPorPagina
    ) {

      console.log(
        "✅ ÚLTIMA PÁGINA DETECTADA"
      );

      break;

    }



    pagina++;

  }



  // ============================================================
  // 9. PROTECCIÓN CONTRA PAGINACIÓN INFINITA
  // ============================================================

  if (
    pagina >= MAX_PAGES
  ) {

    throw new Error(
      `Se alcanzó el límite máximo de ${MAX_PAGES} páginas consultando Citrus.`
    );

  }



  // ============================================================
  // 10. PRODUCTO NO ENCONTRADO
  // ============================================================
  //
  // IMPORTANTE:
  //
  // Solo consideramos 0 después de completar correctamente
  // la consulta de Citrus.
  //
  // Si Citrus se hubiera caído, callERPExistenciaAlmacen()
  // debería lanzar error y nunca llegaríamos aquí.
  //
  // ============================================================

  if (
    !productoEncontrado
  ) {

    console.log("");
    console.log(
      "ℹ️ PRODUCTO NO ENCONTRADO EN LAS EXISTENCIAS DE CITRUS"
    );

    console.log(
      "📦 EXISTENCIA ACTUAL = 0"
    );

    console.log(
      "🆔 ITEM ID:",
      parsedItemId
    );


    return 0;

  }



  // ============================================================
  // 11. VALIDAR TOTAL
  // ============================================================

  if (
    !Number.isFinite(
      cantidadTotal
    )
  ) {

    throw new Error(
      `No se pudo determinar la existencia del ItemId ${parsedItemId}.`
    );

  }



  // ============================================================
  // 12. RESULTADO
  // ============================================================

  console.log("");
  console.log(
    "🟩🟩🟩 ========================================"
  );

  console.log(
    "✅ EXISTENCIA ENCONTRADA"
  );

  console.log(
    "🆔 ITEM ID:",
    parsedItemId
  );

  console.log(
    "🏭 ALMACÉN:",
    parsedAlmacenId
  );

  console.log(
    "📦 EXISTENCIA ACTUAL:",
    cantidadTotal
  );

  console.log(
    "🟩🟩🟩 ========================================"
  );


  return cantidadTotal;

}