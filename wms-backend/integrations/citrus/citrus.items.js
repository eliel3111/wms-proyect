import { callERP, callERPPurchase } from "./erpClient.js";
import { db } from "../../db.js";
import { insertNewProductFromERP } from  "./citrus.product.service.js"

//ESTO ES PARA PODER BUSCAR POR PAGUINA Y CANTIDAD LOS PRODUCTOS
/*
#2Se obtiene la fecha y se formatea en un formato que entienda citrus. Luego hay un filtro que quita y pone el filtro de las fechas para poder ver todo o no. Luego esta el XML Body y se usa callERP para llamar al ERP

#4 lUEGO QUE LLEGA del callERP entonces se confirma si hubo resultado y si lo hubo de manda al syncAllItems()
*/
export async function fetchAllItems(lastWriteDate) {
  try {



    const fechaInicioFormatted = formatLocalDate(new Date(lastWriteDate));
    const fechaFinFormatted = formatLocalDate(new Date());

    console.log("FECHA DE INICIO: ", fechaInicioFormatted);
    console.log("FECHA DE FINAL: ", fechaFinFormatted);


    //Filtro para quitar y poner la fecha.
    const useDateFilter = true;
    const dateFilter = useDateFilter
      ? `
    <tem:FechaInicioActualizacion>${fechaInicioFormatted}</tem:FechaInicioActualizacion>
        <tem:FechaFinActualizacion>${fechaFinFormatted}</tem:FechaFinActualizacion>
  `
      : "";



    const xml = `
<soap:Envelope
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:tem="http://tempuri.org/"
  xmlns:bas="BaseModel.Where">
  <soap:Body>
    <tem:BuscarItems>
      <tem:itemWhere>
        <bas:CantidadPorPagina>100</bas:CantidadPorPagina>
        
        ${dateFilter}
      </tem:itemWhere>
    </tem:BuscarItems>
  </soap:Body>
</soap:Envelope>
`;

    const data = await callERP(
      "Inventario/ItemService.asmx",
      "http://tempuri.org/BuscarItems",
      xml
    );



    if (!data || data.Success === 0) {
      console.log("🔴 ERP respondió error:", data?.Mensaje);
      return [];
    }
    console.log("resultado items", data?.Data?.Items);
    return data?.Data?.Items || [];

  } catch (error) {
    console.error("🔥 fetchItemsPage error:", error.message);
    return [];
  }
}

export async function fetchAllItemsAndSync() {

  const client = await db.connect();

  try {

    let currentPage = 0;

    let totalProcessed = 0;

    while (true) {

      console.log("📄 PAGINA ACTUAL:", currentPage);

      const xml = `
<soap:Envelope 
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:tem="http://tempuri.org/"
  xmlns:bas="BaseModel.Where">

  <soap:Body>
    <tem:BuscarItems>
      <tem:itemWhere>

        <tem:Estatus>A</tem:Estatus>

        <bas:Pagina>${currentPage}</bas:Pagina>

        <bas:CantidadPorPagina>100</bas:CantidadPorPagina>

      </tem:itemWhere>
    </tem:BuscarItems>
  </soap:Body>

</soap:Envelope>
`;

      console.log("📡 CONSULTANDO ERP...");

      const data = await callERP(
        "Inventario/ItemService.asmx",
        "http://tempuri.org/BuscarItems",
        xml
      );

      // 🔴 VALIDAR RESPUESTA
      if (!data || data.Success === 0) {

        console.log(
          "🔴 ERP respondió error:",
          data?.Mensaje
        );

        break;
      }

      const items =
        data?.Data?.Items || [];

      console.log(
        `📦 ITEMS RECIBIDOS PAGINA ${currentPage}:`,
        items.length
      );

      // 🔴 SI NO HAY MÁS ITEMS
      if (items.length === 0) {

        console.log("✅ NO HAY MÁS ITEMS");

        break;
      }

      // 🔥 TRANSACCIÓN POR PÁGINA
      await client.query("BEGIN");

      try {

        for (const item of items) {

          console.log(
            "📦 PROCESANDO:",
            item.Nombre
          );

          await insertNewProductFromERP(
            client,
            item
          );

          totalProcessed++;
        }

        await client.query("COMMIT");

        console.log(
          `✅ PAGINA ${currentPage} PROCESADA`
        );

      } catch (error) {

        await client.query("ROLLBACK");

        console.error(
          `🔥 ERROR PAGINA ${currentPage}:`,
          error.message
        );

        throw error;
      }

      // ➡️ SIGUIENTE PAGINA
      currentPage++;
    }

    console.log(
      "✅ TOTAL PRODUCTOS PROCESADOS:",
      totalProcessed
    );

    return {
      success: true,
      totalProcessed
    };

  } catch (error) {

    console.error(
      "🔥 fetchAllItemsAndSync error:",
      error
    );

    return {
      success: false,
      error: error.message
    };

  } finally {

    client.release();
  }
}

export async function fetchPurchaseOrdersTest(lastWriteDate) {
  try {

    //console.log("🚨CPO CHECK 4-FETCH PURCHASE ");


    const fechaInicioFormatted = formatLocalDate(new Date(lastWriteDate));
    const fechaFinFormatted = formatLocalDate(new Date());




    console.log("PURCHASE FECHA DE INICIO: ", fechaInicioFormatted);
    console.log("FECHA DE FINAL: ", fechaFinFormatted);

   const baseDate = new Date(lastWriteDate);

// Inicio del día
const startOfDay = new Date(baseDate);
startOfDay.setHours(0, 0, 0, 0);

// Fin del día
const endOfDay = new Date(baseDate);
endOfDay.setHours(23, 59, 59, 0);

const fechaInicioFormattedNewPO = formatLocalDate(startOfDay);
const fechaFinFormattedNewPO = formatLocalDate(endOfDay);

console.log("🟨 PURCHASE FECHA DE INICIO: ", fechaInicioFormattedNewPO);
console.log("🟨 FECHA DE FINAL: ", fechaFinFormattedNewPO);




const xml = `
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" 
                  xmlns:tem="http://tempuri.org/" 
                  xmlns:bas="BaseModel.Where">
   <soapenv:Header/>
   <soapenv:Body>
      <tem:BuscarOrdenesCompras>
         <!--Optional:-->
         <tem:ordenCompraWhere>
            <bas:CantidadPorPagina>1000</bas:CantidadPorPagina>
            <tem:EsFecha>true</tem:EsFecha>
            <tem:FechaInicio>${fechaInicioFormattedNewPO}</tem:FechaInicio>
            <tem:FechaFin>${fechaFinFormatted}</tem:FechaFin>
         </tem:ordenCompraWhere>
      </tem:BuscarOrdenesCompras>
   </soapenv:Body>
</soapenv:Envelope>
`;

    const data1 = await callERPPurchase(
      "CxP/OrdenCompraService.asmx",
      "http://tempuri.org/BuscarOrdenesCompras",
      xml
    );

          if (!data1) {
      throw new Error(
        "Citrus no devolvió respuesta al buscar órdenes de compra NUEVAS"
      );
    }

    if (data1.Success === 0) {
      throw new Error(
        data1.Mensaje ||
        "Citrus devolvió un error al buscar órdenes de compra NUEVAS"
      );
    }



    const xml2 = `
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:tem="http://tempuri.org/"
                  xmlns:bas="BaseModel.Where">
    <soapenv:Header/>
    <soapenv:Body>
        <tem:BuscarOrdenesCompras>
            <!--Optional:-->
            <tem:ordenCompraWhere>
                <bas:Pagina>0</bas:Pagina>
                <bas:CantidadPorPagina>100</bas:CantidadPorPagina>
                <tem:EsFechaActualizacion>true</tem:EsFechaActualizacion>
                <tem:FechaInicioActualizacion>${fechaInicioFormatted}</tem:FechaInicioActualizacion>
                <tem:FechaFinActualizacion>${fechaFinFormatted}</tem:FechaFinActualizacion>
            </tem:ordenCompraWhere>
        </tem:BuscarOrdenesCompras>
    </soapenv:Body>
</soapenv:Envelope>
`;




    const data2 = await callERPPurchase(
      "CxP/OrdenCompraService.asmx",
      "http://tempuri.org/BuscarOrdenesCompras",
      xml2
    );

      if (!data2) {
      throw new Error(
        "Citrus no devolvió respuesta al buscar órdenes de compra ACTUALIZADAS"
      );
    }

    if (data2.Success === 0) {
      throw new Error(
        data2.Mensaje ||
        "Citrus devolvió un error al buscar órdenes de compra ACTUALIZADA"
      );
    }

    // Órdenes creadas
const ordersData1 =
  data1?.Data?.OrdenCompras || [];

// Órdenes actualizadas
const ordersData2 =
  data2?.Data?.OrdenCompras || [];

console.log(
  "📦 Órdenes nuevas:",
  ordersData1.length
);

console.log(
  "♻️ Órdenes actualizadas:",
  ordersData2.length
);

// Unir y eliminar duplicados por el ID del ERP
const ordersMap = new Map();

for (const order of [
  ...ordersData1,
  ...ordersData2
]) {
  if (!order?.Id) continue;

  ordersMap.set(
    Number(order.Id),
    order
  );
}

const orders = Array.from(
  ordersMap.values()
);

console.log(
  "📦 TOTAL ÓRDENES ÚNICAS:",
  orders.length
);

// Crear una respuesta unificada
const data = {
  ...(data1 || data2),
  Data: {
    ...(data1?.Data || data2?.Data || {}),
    OrdenCompras: orders
  }
};


console.log("🟨🟨 Respuesta de la base de datos: ", data);


    return data;

  } catch (error) {
    console.error(
      "🔥 ERROR fetchPurchaseOrdersTest:",
      error.message
    );

    throw error;
  }
}

function formatLocalDate(date) {
  const pad = (n) => String(n).padStart(2, "0");

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}


export async function syncPurchaseOrder(clientDb, order) {

  const erpId = order.Id;

  // 🔥 VALIDACIÓN
  if (!erpId) {
    console.log("⚠️ Orden sin ID, ignorando");
    return null;
  }

  const result = await clientDb.query(
    `SELECT id, status FROM purchase_orders WHERE erp_order_id = $1`,
    [erpId]
  );

  // 🔥 status desde ERP
  const erpStatus = String(order.Estatus ?? "")
  .trim()
  .toUpperCase();

const newStatus = ["A", "F"].includes(erpStatus)
  ? "open"
  : "closed";

  if (result.rowCount > 0) {

    const existing = result.rows[0];
    let finalStatus = newStatus;

    // 🔥 REGLA CLAVE
    if (existing.status === "partial") {

      if (newStatus === "open") {
        finalStatus = "partial";
      }

      if (newStatus === "closed") {
        finalStatus = "closed";
      }
    }

    const updateResult = await clientDb.query(
      `
      UPDATE purchase_orders
      SET supplier_name = $1,
          status = $2,
          erp_write_date = NOW()
      WHERE erp_order_id = $3
      RETURNING id
      `,
      [
        order.NombreSuplidor,
        finalStatus,
        erpId
      ]
    );

    return updateResult.rows[0].id; // 🔥 ID del WMS

  } else {

    const poNumber = `PO-${erpId}`;

    const insertResult = await clientDb.query(
      `
      INSERT INTO purchase_orders (
        purchase_order_number,
        supplier_name,
        status,
        erp_order_id,
        erp_write_date
      )
      VALUES ($1, $2, $3, $4, NOW())
      RETURNING id
      `,
      [
        poNumber,
        order.NombreSuplidor,
        newStatus,
        erpId
      ]
    );

    return insertResult.rows[0].id; // 🔥 ID del WMS
  }
}




/**
 * Sincroniza las líneas de una orden de compra de Citrus con el WMS.
 *
 * Reglas:
 *
 * 1. Línea nueva en Citrus:
 *    - Se inserta en purchase_order_lines.
 *
 * 2. Línea existente con el mismo producto:
 *    - Se actualiza.
 *    - ordered_qty nunca puede ser menor que lo recibido.
 *
 * 3. Línea eliminada de Citrus:
 *    - Si no tiene recepción, se elimina físicamente.
 *    - Si tiene recepción, se conserva como historial:
 *        received_qty = total recibido
 *        ordered_qty = total recibido
 *        deleted_erp = true
 *        erp_line_id = null
 *
 * 4. Citrus reutiliza el mismo erp_line_id con otro producto:
 *    - La línea vieja se elimina o conserva como historial.
 *    - La nueva línea se inserta con el erp_line_id original.
 *
 * IMPORTANTE:
 * Esta función administra su propia transacción.
 * El clientDb debe ser una conexión obtenida mediante db.connect().
 */
export async function syncPurchaseOrderLines(
  clientDb,
  order,
  purchaseOrderId
  ) {
  let transactionStarted = false;

  const summary = {
    inserted: 0,
    updated: 0,
    deleted: 0,
    archived: 0,
    unchanged: 0
  };

  try {
    console.log("");
    console.log("🟥🟥🟥 ========================================");
    console.log("📦 INICIANDO SINCRONIZACIÓN DE LÍNEAS DE OC");
    console.log("🟥🟥🟥 ========================================");

    // ==========================================================
    // 1. VALIDACIONES GENERALES
    // ==========================================================

    if (!clientDb) {
      throw new Error(
        "No se recibió una conexión válida de PostgreSQL"
      );
    }

    if (!order?.Id) {
      throw new Error(
        "La orden recibida desde Citrus no tiene order.Id"
      );
    }

    if (!purchaseOrderId) {
      throw new Error( "No se recibió el purchaseOrderId interno del WMS"
      );
    }

    const citrusOrderId = Number(order.Id);
    const rawLines = Array.isArray(order.OrdenCompraDetalles)
      ? order.OrdenCompraDetalles
      : [];

    console.log("📌 Citrus order ID:", citrusOrderId);
    console.log("📌 WMS purchase order ID:", purchaseOrderId);
    console.log("📌 Líneas recibidas desde Citrus:", rawLines.length);

    /*
     * Si Citrus no envía absolutamente ninguna línea, no hacemos
     * nada para evitar eliminar una orden completa por una respuesta
     * incompleta o dañada del ERP.
     *
     * Si Citrus sí envía líneas, pero todas tienen cantidad 0,
     * entonces sí serán tratadas como líneas eliminadas.
     */
    if (rawLines.length === 0) {
      console.log(
        "⚠️ Citrus no devolvió líneas. Se omite la sincronización."
      );

      return {
        success: true,
        skipped: true,
        reason: "ERP_WITHOUT_LINES",
        summary
      };
    }

     // ==========================================================
    // 2. CONSTRUIR VALUES DEL ERP
    // ==========================================================

    const values = rawLines
      .map((line, index) => {
        const erpLineId = Number(line?.Id);
        const erpProductId = line?.Item?.Id
          ? Number(line.Item.Id)
          : null;

        return {
          erp_line_id: Number.isFinite(erpLineId)
            ? erpLineId
            : null,

          erp_order_id: citrusOrderId,

          erp_product_id: Number.isFinite(erpProductId)
            ? erpProductId
            : null,

          qty: Number(line?.ItemCantidad || 0),

          original_line_number: index + 1,

          description:
            line?.ItemDescripcion ||
            line?.Item?.Nombre ||
            null
        };
      })

      /*
       * Una línea con cantidad 0 no se considera una línea activa.
       * Al no aparecer en values, será procesada como eliminada.
       */
      .filter((line) => line.qty > 0);

    console.log("📨 ERP VALUES:");
    console.dir(values, {
      depth: null
    });

    // ==========================================================
    // 3. VALIDAR DUPLICADOS EN CITRUS
    // ==========================================================

    const duplicatedErpLineIds = [];
    const seenErpLineIds = new Set();

    for (const line of values) {
      if (!line.erp_line_id) {
        throw new Error(
          `Citrus devolvió una línea sin ID válido. ` +
          `Posición: ${line.original_line_number}`
        );
      }

      const key = String(line.erp_line_id);

      if (seenErpLineIds.has(key)) {
        duplicatedErpLineIds.push(line.erp_line_id);
      }

      seenErpLineIds.add(key);
    }

    if (duplicatedErpLineIds.length > 0) {
       throw new Error(
        `Citrus devolvió erp_line_id duplicados: ` +
        duplicatedErpLineIds.join(", ")
      );
    }

    // ==========================================================
    // 4. INICIAR TRANSACCIÓN
    // ==========================================================

    await clientDb.query("BEGIN");
    transactionStarted = true;

    // ==========================================================
    // 5. BLOQUEAR LA ORDEN
    // ==========================================================

    const purchaseOrderLockResult = await clientDb.query(
      `
      SELECT id
      FROM purchase_orders
      WHERE id = $1
      FOR UPDATE
      `,
      [purchaseOrderId]
    );

    if (purchaseOrderLockResult.rows.length === 0) {
      throw new Error(
        `No existe la orden de compra WMS con ID ${purchaseOrderId}`
      );
    }

    // ==========================================================
    // 6. OBTENER LAS LÍNEAS ACTUALES DEL WMS
    // ==========================================================

     const wmsResult = await clientDb.query(
      `
      SELECT
        pol.id,
        pol.purchase_order_id,
        pol.erp_order_id,
        pol.erp_line_id,
        pol.erp_product_id,
        pol.line_number,
        pol.description,
        pol.ordered_qty,
        pol.received_qty,
        pol.sku,
        pol.product_exists,
        pol.deleted_erp,

        GREATEST(
  COALESCE(pol.received_qty, 0),
  COALESCE(receipts.latest_received_qty, 0)
)::numeric AS total_received

FROM purchase_order_lines pol

LEFT JOIN LATERAL (
  SELECT
    COALESCE(rl.received_qty, 0)::numeric
      AS latest_received_qty
  FROM receipt_lines rl
  WHERE rl.purchase_order_line_id = pol.id
  ORDER BY rl.id DESC
  LIMIT 1
) receipts
  ON TRUE
      WHERE pol.purchase_order_id = $1
        AND pol.erp_order_id = $2

         ORDER BY
        CASE
          WHEN pol.line_number ~ '^[0-9]+$'
          THEN pol.line_number::integer
          ELSE 999999999
        END,
        pol.id

      FOR UPDATE OF pol
      `,
      [
        purchaseOrderId,
        citrusOrderId
      ]
    );

    const wmsValues = wmsResult.rows.map((line) => ({
      ...line,

      id: Number(line.id),

      purchase_order_id: Number(
        line.purchase_order_id
      ),

      erp_order_id: line.erp_order_id !== null
        ? Number(line.erp_order_id)
        : null,

      erp_line_id: line.erp_line_id !== null
        ? Number(line.erp_line_id)
        : null,

      erp_product_id: line.erp_product_id !== null
        ? Number(line.erp_product_id)
        : null,
         ordered_qty: Number(line.ordered_qty || 0),

      received_qty: Number(line.received_qty || 0),

      total_received: Number(
        line.total_received || 0
      )
    }));

    console.log("📦 WMS VALUES:");
    console.dir(wmsValues, {
      depth: null
    });

    // ==========================================================
    // 7. OBTENER INFORMACIÓN DE LOS PRODUCTOS
    // ==========================================================

    const erpProductIds = [
      ...new Set(
        values
          .map((line) => line.erp_product_id)
          .filter((id) => id !== null)
      )
    ];

    const productMap = new Map();

    if (erpProductIds.length > 0) {
      const productsResult = await clientDb.query(
        `
           SELECT
          p.erp_id,
          p.sku,
          p.description,
          COALESCE(p.deleted_erp, false)
            AS product_deleted_erp,

          EXISTS (
            SELECT 1
            FROM product_barcodes pb
            WHERE pb.product_sku = p.sku
          ) AS has_barcode

        FROM products p
        WHERE p.erp_id = ANY($1::bigint[])
        `,
        [erpProductIds]
      );

      for (const product of productsResult.rows) {
        productMap.set(
          String(product.erp_id),
          {
            erp_id: Number(product.erp_id),
            sku: product.sku || null,
            description:
              product.description || null,
            deleted_erp:
              product.product_deleted_erp === true,
            product_exists:
              product.has_barcode === true
          }
        );
      }
       }

   // ==========================================================
// 8. CREAR MAPAS DE COMPARACIÓN
// ==========================================================

/*
 * Las líneas activas conservan erp_line_id.
 * Las archivadas tienen erp_line_id = null.
 */
const activeWmsValues = wmsValues.filter(
  (line) => line.erp_line_id !== null
);

const erpByErpLineId = new Map(
  values.map((line) => [
    String(line.erp_line_id),
    line
  ])
);

// ==========================================================
// 9. CLASIFICAR LAS LÍNEAS
// ==========================================================

const linesToRemoveMap = new Map();
const linesToInsertMap = new Map();
const linesToUpdateMap = new Map();

/*
 * Evitan que una línea sea procesada dos veces.
 */
const matchedWmsIds = new Set();
const matchedErpLineIds = new Set();

// ==========================================================
// PASO 1:
// BUSCAR COINCIDENCIAS EXACTAS POR erp_line_id
// ==========================================================

for (const wmsLine of activeWmsValues) {
  const erpLine = erpByErpLineId.get(
    String(wmsLine.erp_line_id)
  );

  /*
   * No la declaramos eliminada todavía.
   *
   * Más adelante intentaremos encontrarla
   * por erp_product_id.
   */
  if (!erpLine) {
    continue;
  }

  const wmsProductId =
    wmsLine.erp_product_id !== null
      ? Number(wmsLine.erp_product_id)
      : null;

  const erpProductId =
    erpLine.erp_product_id !== null
      ? Number(erpLine.erp_product_id)
      : null;

  /*
   * Solo existe reemplazo de producto si ambos IDs
   * existen y son realmente diferentes.
   */
  const productChanged =
    wmsProductId !== null &&
    erpProductId !== null &&
    wmsProductId !== erpProductId;

  console.log(
    "🔎 COMPARACIÓN EXACTA POR ERP_LINE_ID:",
    {
      purchase_order_line_id: wmsLine.id,
      wms_erp_line_id: wmsLine.erp_line_id,
      citrus_erp_line_id: erpLine.erp_line_id,
      wms_product_id: wmsProductId,
      citrus_product_id: erpProductId,
      productChanged
    }
  );

  /*
   * Estas dos líneas ya fueron emparejadas
   * por erp_line_id.
   */
  matchedWmsIds.add(
    String(wmsLine.id)
  );

  matchedErpLineIds.add(
    String(erpLine.erp_line_id)
  );

  // --------------------------------------------------------
  // MISMO ERP_LINE_ID, PERO PRODUCTO DIFERENTE
  // --------------------------------------------------------

  if (productChanged) {
    console.log(
      "🔄 PRODUCTO REEMPLAZADO EN CITRUS:",
      {
        purchase_order_line_id: wmsLine.id,
        erp_line_id: wmsLine.erp_line_id,
        previous_product_id: wmsProductId,
        new_product_id: erpProductId
      }
    );

    linesToRemoveMap.set(
      String(wmsLine.id),
      {
        wmsLine,
        reason: "PRODUCT_REPLACED"
      }
    );

    linesToInsertMap.set(
      String(erpLine.erp_line_id),
      erpLine
    );

    continue;
  }

  // --------------------------------------------------------
  // MISMO ERP_LINE_ID Y MISMO PRODUCTO
  // --------------------------------------------------------

  linesToUpdateMap.set(
    String(wmsLine.id),
    {
      wmsLine,
      erpLine,
      reason: "ERP_LINE_ID_MATCH"
    }
  );
}

// ==========================================================
// PASO 2:
// BUSCAR MISMO PRODUCTO CUANDO CAMBIÓ EL erp_line_id
// ==========================================================

const unmatchedWmsLines = activeWmsValues.filter(
  (wmsLine) =>
    !matchedWmsIds.has(
      String(wmsLine.id)
    )
);

const unmatchedErpLines = values.filter(
  (erpLine) =>
    !matchedErpLineIds.has(
      String(erpLine.erp_line_id)
    )
);

for (const erpLine of unmatchedErpLines) {
  /*
   * Puede haber sido emparejada en una iteración anterior.
   */
  if (
    matchedErpLineIds.has(
      String(erpLine.erp_line_id)
    )
  ) {
    continue;
  }

  const erpProductId =
    erpLine.erp_product_id !== null
      ? Number(erpLine.erp_product_id)
      : null;

  if (erpProductId === null) {
    continue;
  }

  /*
   * Buscar líneas WMS no emparejadas con el mismo producto.
   */
  const wmsCandidates = unmatchedWmsLines.filter(
    (wmsLine) => {
      if (
        matchedWmsIds.has(
          String(wmsLine.id)
        )
      ) {
        return false;
      }

      const wmsProductId =
        wmsLine.erp_product_id !== null
          ? Number(wmsLine.erp_product_id)
          : null;

      return wmsProductId === erpProductId;
    }
  );

  /*
   * Buscar cuántas líneas ERP no emparejadas tienen
   * ese mismo producto.
   *
   * Solo emparejamos si existe una sola de cada lado.
   */
  const erpCandidates = unmatchedErpLines.filter(
    (candidate) => {
      if (
        matchedErpLineIds.has(
          String(candidate.erp_line_id)
        )
      ) {
        return false;
      }

      return (
        Number(candidate.erp_product_id) ===
        erpProductId
      );
    }
  );

  /*
   * Una línea WMS y una línea ERP con el mismo producto:
   * asumimos que Citrus cambió el erp_line_id.
   */
  if (
    wmsCandidates.length === 1 &&
    erpCandidates.length === 1
  ) {
    const wmsLine = wmsCandidates[0];

    console.log(
      "🔄 MISMO PRODUCTO CON NUEVO ERP_LINE_ID:",
      {
        purchase_order_line_id:
          wmsLine.id,

        previous_erp_line_id:
          wmsLine.erp_line_id,

        new_erp_line_id:
          erpLine.erp_line_id,

        erp_product_id:
          erpProductId,

        sku:
          wmsLine.sku,

        previous_ordered_qty:
          wmsLine.ordered_qty,

        received_qty:
          wmsLine.received_qty,

        citrus_qty:
          erpLine.qty
      }
    );

    linesToUpdateMap.set(
      String(wmsLine.id),
      {
        wmsLine,
        erpLine,
        reason: "ERP_LINE_ID_CHANGED"
      }
    );

    matchedWmsIds.add(
      String(wmsLine.id)
    );

    matchedErpLineIds.add(
      String(erpLine.erp_line_id)
    );
  }
}

// ==========================================================
// PASO 3:
// LÍNEAS WMS QUE REALMENTE FUERON ELIMINADAS DEL ERP
// ==========================================================

for (const wmsLine of activeWmsValues) {
  if (
    matchedWmsIds.has(
      String(wmsLine.id)
    )
  ) {
    continue;
  }

  linesToRemoveMap.set(
    String(wmsLine.id),
    {
      wmsLine,
      reason: "REMOVED_FROM_ERP"
    }
  );
}

// ==========================================================
// PASO 4:
// LÍNEAS QUE REALMENTE SON NUEVAS EN CITRUS
// ==========================================================

for (const erpLine of values) {
  if (
    matchedErpLineIds.has(
      String(erpLine.erp_line_id)
    )
  ) {
    continue;
  }

  linesToInsertMap.set(
    String(erpLine.erp_line_id),
    erpLine
  );
}

// ==========================================================
// CREAR ARRAYS FINALES
// ==========================================================

const linesToRemove = [
  ...linesToRemoveMap.values()
];

const linesToInsert = [
  ...linesToInsertMap.values()
];

const linesToUpdate = [
  ...linesToUpdateMap.values()
];

console.log("📊 CLASIFICACIÓN:");
console.log(
  "🗑️ Para eliminar o archivar:",
  linesToRemove.length
);
console.log(
  "➕ Para insertar:",
  linesToInsert.length
);
console.log(
  "✏️ Para actualizar:",
  linesToUpdate.length
);

console.log(
  "📌 MATCHED WMS IDS:",
  [...matchedWmsIds]
);

console.log(
  "📌 MATCHED ERP LINE IDS:",
  [...matchedErpLineIds]
);

    // ==========================================================
// 10. PROCESAR LÍNEAS ELIMINADAS O REEMPLAZADAS
// ==========================================================

for (const item of linesToRemove) {
  const { wmsLine, reason } = item;

  const receiptInfoResult = await clientDb.query(
    `
    SELECT
      COUNT(*)::int AS receipt_count,

      COALESCE(
        SUM(received_qty),
        0
      )::numeric AS total_received,

      COUNT(*) FILTER (
         WHERE COALESCE(received_qty, 0) > 0
      )::int AS received_lines_count

    FROM receipt_lines
    WHERE purchase_order_line_id = $1
    `,
    [wmsLine.id]
  );

  const receiptCount = Number(
    receiptInfoResult.rows[0].receipt_count || 0
  );

  const totalReceived = Number(
    receiptInfoResult.rows[0].total_received || 0
  );

  const receivedLinesCount = Number(
    receiptInfoResult.rows[0].received_lines_count || 0
  );

  console.log("🗑️ Procesando línea:", {
    purchase_order_line_id: wmsLine.id,
    erp_line_id: wmsLine.erp_line_id,
    sku: wmsLine.sku,
    receiptCount,
    totalReceived,
    receivedLinesCount,
    reason
  });

   // ========================================================
  // CASO 1:
  // No existe ninguna receipt_line con received_qty > 0
  // ========================================================

  if (receivedLinesCount === 0) {
    /*
     * Puede no existir ninguna receipt_line,
     * o pueden existir receipt_lines con received_qty = 0.
     *
     * Primero eliminamos las receipt_lines vacías para liberar
     * la foreign key.
     */
    const deletedReceiptLinesResult = await clientDb.query(
      `
      DELETE FROM receipt_lines
      WHERE purchase_order_line_id = $1
        AND COALESCE(received_qty, 0) <= 0
      RETURNING id
      `,
      [wmsLine.id]
    );

    console.log(
      `🧹 Receipt lines vacías eliminadas: ${deletedReceiptLinesResult.rowCount}`
    );

    /*
     * Ahora que no existen filas hijas relacionadas,
     * podemos eliminar purchase_order_lines.
     */
    const deleteResult = await clientDb.query(
      `
      DELETE FROM purchase_order_lines
      WHERE id = $1
      RETURNING id
       `,
      [wmsLine.id]
    );

    if (deleteResult.rowCount > 0) {
      summary.deleted += 1;

      console.log(
        `✅ Línea ${wmsLine.id} eliminada junto con sus receipt_lines vacías`
      );
    }

    continue;
  }

  // ========================================================
  // CASO 2:
  // Existe al menos una receipt_line con received_qty > 0
  // ========================================================

  /*
   * La línea no se elimina porque ya tiene recepción real.
   *
   * Se conserva como historial y se libera erp_line_id
   * para permitir insertar otra línea si Citrus reutilizó
   * el mismo erp_line_id.
   */
  const archiveResult = await clientDb.query(
    `
    UPDATE purchase_order_lines
    SET
      ordered_qty = $2,
      received_qty = $2,
      deleted_erp = true,
      erp_line_id = NULL
    WHERE id = $1
     RETURNING
      id,
      ordered_qty,
      received_qty,
      deleted_erp,
      erp_line_id
    `,
    [
      wmsLine.id,
      totalReceived
    ]
  );

  if (archiveResult.rowCount > 0) {
    summary.archived += 1;

    console.log(
      `📚 Línea ${wmsLine.id} archivada porque tiene cantidad recibida:`,
      archiveResult.rows[0]
    );
  }
}

    // ==========================================================
    // 11. DETERMINAR EL PRÓXIMO LINE_NUMBER
    // ==========================================================

    let maxLineNumber = wmsValues.reduce(
      (currentMax, line) => {
        const parsedLineNumber = Number(
          line.line_number
        );

        if (!Number.isFinite(parsedLineNumber)) {
          return currentMax;
        }
           return Math.max(
          currentMax,
          parsedLineNumber
        );
      },
      0
    );

    // ==========================================================
    // 12. INSERTAR LÍNEAS NUEVAS
    // ==========================================================

    for (const erpLine of linesToInsert) {

      const existingLineResult =
  await clientDb.query(
    `
    SELECT
      id,
      erp_line_id,
      erp_product_id,
      ordered_qty,
      received_qty
    FROM purchase_order_lines
    WHERE purchase_order_id = $1
      AND erp_order_id = $2
      AND erp_line_id = $3
    FOR UPDATE
    `,
    [
      purchaseOrderId,
      erpLine.erp_order_id,
      erpLine.erp_line_id
    ]
  );

if (existingLineResult.rowCount > 0) {
  console.log(
    "⚠️ INSERT OMITIDO: la línea ERP ya existe:",
    existingLineResult.rows[0]
  );

  continue;
}

      maxLineNumber += 1;

      const product = erpLine.erp_product_id !== null
        ? productMap.get(
            String(erpLine.erp_product_id)
          )
        : null;

      const sku = product?.sku || null;

      const description =
        product?.description ||
        erpLine.description ||
        "UNKNOWN";

      const productExists =
        product?.product_exists === true;

      console.log("➕ Insertando línea:", {
        purchase_order_id: purchaseOrderId,
        line_number: maxLineNumber,
        erp_line_id: erpLine.erp_line_id,
         erp_order_id: erpLine.erp_order_id,
        erp_product_id: erpLine.erp_product_id,
        sku,
        ordered_qty: erpLine.qty,
        product_exists: productExists
      });

      const insertResult = await clientDb.query(
        `
        INSERT INTO purchase_order_lines (
          purchase_order_id,
          line_number,
          description,
          ordered_qty,
          received_qty,
          deleted_erp,
          erp_line_id,
          erp_order_id,
          erp_product_id,
          sku,
          product_exists
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          0,
          false,
          $5,
          $6,
          $7,
          $8,
          $9
        )
        RETURNING
          id,
          erp_line_id,
          erp_product_id,
          sku,
          ordered_qty
        `,
        [
          purchaseOrderId,
          String(maxLineNumber),
          description,
          erpLine.qty,
          erpLine.erp_line_id,
          erpLine.erp_order_id,
          erpLine.erp_product_id,
          sku,
          productExists
        ]
      );

      if (insertResult.rowCount > 0) {
        summary.inserted += 1;

        console.log(
          "✅ Línea insertada:",
          insertResult.rows[0]
        );
      }
    }

   // ==========================================================
// 13. ACTUALIZAR LAS LÍNEAS EXISTENTES
// ==========================================================

for (const item of linesToUpdate) {
  const {
    wmsLine,
    erpLine,
    reason
  } = item;

  const product =
    erpLine.erp_product_id !== null
      ? productMap.get(
          String(erpLine.erp_product_id)
        )
      : null;

  const erpQty = Number(
    erpLine.qty || 0
  );

  /*
   * received_qty en purchase_order_lines contiene
   * la cantidad acumulada realmente recibida.
   *
   * Nunca debe reducirse porque Citrus bajó la orden.
   */
  const actualReceived = Number(
    wmsLine.received_qty || 0
  );

  /*
   * Si Citrus baja ordered_qty por debajo de lo recibido,
   * ordered_qty debe igualarse a received_qty.
   *
   * Ejemplo:
   * Citrus = 1
   * Recibido = 2
   * Resultado = 2 ordenado / 2 recibido
   */
  const newOrderedQty = Math.max(
    erpQty,
    actualReceived
  );

  const newDescription =
    product?.description ||
    erpLine.description ||
    wmsLine.description ||
    "UNKNOWN";

  const newSku =
    product?.sku ||
    wmsLine.sku ||
    null;

  /*
   * Si no encontramos el producto en productMap,
   * conservamos el valor actual.
   */
  const newProductExists = product
    ? product.product_exists === true
    : wmsLine.product_exists === true;

  const newErpLineId = Number(
    erpLine.erp_line_id
  );

  const newErpOrderId = Number(
    erpLine.erp_order_id
  );

  const newErpProductId =
    erpLine.erp_product_id !== null
      ? Number(erpLine.erp_product_id)
      : null;

  const changed =
    Number(wmsLine.ordered_qty) !==
      newOrderedQty ||

    Number(wmsLine.received_qty) !==
      actualReceived ||

    Number(wmsLine.erp_line_id) !==
      newErpLineId ||

    Number(wmsLine.erp_order_id) !==
      newErpOrderId ||

    Number(wmsLine.erp_product_id) !==
      Number(newErpProductId) ||

    wmsLine.description !==
      newDescription ||

    wmsLine.sku !==
      newSku ||

    wmsLine.product_exists !==
      newProductExists ||

    wmsLine.deleted_erp === true;

  if (!changed) {
    summary.unchanged += 1;

    console.log(
      `⏭️ Línea ${wmsLine.id} sin cambios`
    );

    continue;
  }

  console.log(
    `✏️ Actualizando línea ${wmsLine.id}:`,
    {
      reason,

      previous_erp_line_id:
        wmsLine.erp_line_id,

      new_erp_line_id:
        newErpLineId,

      previous_ordered_qty:
        wmsLine.ordered_qty,

      citrus_qty:
        erpQty,

      actual_received:
        actualReceived,

      new_ordered_qty:
        newOrderedQty,

      final_result:
        `${newOrderedQty}/${actualReceived}`,

      sku:
        newSku
    }
  );

  const updateResult = await clientDb.query(
    `
    UPDATE purchase_order_lines
    SET
      description = $2,
      ordered_qty = $3,
      received_qty = $4,
      erp_line_id = $5,
      erp_order_id = $6,
      erp_product_id = $7,
      sku = $8,
      product_exists = $9,
      deleted_erp = false
    WHERE id = $1
    RETURNING
      id,
      line_number,
      erp_line_id,
      erp_order_id,
      erp_product_id,
      sku,
      ordered_qty,
      received_qty,
      deleted_erp
    `,
    [
      wmsLine.id,          // $1
      newDescription,     // $2
      newOrderedQty,      // $3
      actualReceived,     // $4
      newErpLineId,       // $5
      newErpOrderId,      // $6
      newErpProductId,    // $7
      newSku,             // $8
      newProductExists    // $9
    ]
  );

  if (updateResult.rowCount > 0) {
    summary.updated += 1;

    console.log(
      "✅ Línea actualizada:",
      updateResult.rows[0]
    );
  }
}

    // ==========================================================
    // 14. VALIDACIÓN FINAL
    // ==========================================================

    const finalLinesResult = await clientDb.query(
      `
      SELECT
        pol.id,
        pol.line_number,
        pol.erp_line_id,
         pol.erp_order_id,
        pol.erp_product_id,
        pol.sku,
        pol.ordered_qty,
        pol.received_qty,
        pol.deleted_erp
      FROM purchase_order_lines pol
      WHERE pol.purchase_order_id = $1
      ORDER BY
        CASE
          WHEN pol.line_number ~ '^[0-9]+$'
          THEN pol.line_number::integer
          ELSE 999999999
        END,
        pol.id
      `,
      [purchaseOrderId]
    );

    // ==========================================================
    // 15. COMMIT
    // ==========================================================

    await clientDb.query("COMMIT");
    transactionStarted = false;

    console.log("");
    console.log("🟩🟩🟩 ========================================");
    console.log("✅ SINCRONIZACIÓN TERMINADA CORRECTAMENTE");
    console.log("🟩🟩🟩 ========================================");
    console.log("📊 RESUMEN:", summary);
    console.log("📦 LÍNEAS FINALES:");
    console.dir(finalLinesResult.rows, {
      depth: null
    });

     return {
      success: true,
      purchaseOrderId,
      citrusOrderId,
      summary,
      lines: finalLinesResult.rows
    };
  } catch (error) {
    if (transactionStarted) {
      try {
        await clientDb.query("ROLLBACK");

        console.log(
          "↩️ ROLLBACK ejecutado correctamente"
        );
      } catch (rollbackError) {
        console.error(
          "❌ Error ejecutando ROLLBACK:",
          rollbackError
        );
      }
    }

    console.error("");
    console.error("🟥🟥🟥 ========================================");
    console.error("❌ ERROR SINCRONIZANDO LÍNEAS DE OC");
    console.error("🟥🟥🟥 ========================================");
    console.error("Mensaje:", error.message);
    console.error("Stack:", error.stack);

    throw error;
  }
}