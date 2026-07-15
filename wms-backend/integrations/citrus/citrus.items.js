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

    let currentPage = 134;

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
            <bas:CantidadPorPagina>100</bas:CantidadPorPagina>
            <tem:EsFecha>true</tem:EsFecha>
            <tem:FechaInicio>${fechaInicioFormattedNewPO}</tem:FechaInicio>
            <tem:FechaFin>${fechaFinFormattedNewPO}</tem:FechaFin>
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
        data.Mensaje ||
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
        data.Mensaje ||
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
  let newStatus = order.Estatus === "A" ? "open" : "closed";

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

export async function syncPurchaseOrderLines(clientDb, order, purchaseOrderId) {

  const lines = order.OrdenCompraDetalles || [];

  if (!lines.length) {
    console.log("⚠️ Orden sin líneas");
    return;
  }

const values = lines
  .map((line, index) => ({
    erp_line_id: line.Id,
    erp_order_id: order.Id,
    erp_product_id: line.Item?.Id || null,
    qty: Number(line.ItemCantidad || 0),
    line_number: index + 1,
    description: line.ItemDescripcion || line.Item?.Nombre || null
  }))
  .filter((line) => line.qty > 0);


 


  // 🔥 QUERY MASIVA
  await clientDb.query(
  `
  INSERT INTO purchase_order_lines (
    purchase_order_id,
    line_number,
    description,
    ordered_qty,
    deleted_erp,
    erp_line_id,
    erp_order_id,
    sku,
    product_exists
  )
  SELECT
    $1,
    v.line_number,

    COALESCE(p.description, v.description, 'UNKNOWN'),

    v.qty,

    COALESCE(p.deleted_erp, false),

    v.erp_line_id,
    v.erp_order_id,

    p.sku,

    -- 🔥 AQUÍ ESTÁ LA MAGIA
    CASE 
      WHEN EXISTS (
        SELECT 1 
        FROM product_barcodes pb 
        WHERE pb.product_sku = p.sku
      ) THEN true
      ELSE false
    END AS product_exists

  FROM jsonb_to_recordset($2::jsonb) AS v(
    erp_line_id bigint,
    erp_order_id bigint,
    erp_product_id bigint,
    qty numeric,
    line_number int,
    description text
  )

  LEFT JOIN products p 
    ON p.erp_id = v.erp_product_id

  ON CONFLICT (erp_line_id, erp_order_id)
  DO UPDATE SET
    description = EXCLUDED.description,
    ordered_qty = EXCLUDED.ordered_qty,
    deleted_erp = EXCLUDED.deleted_erp,
    sku = EXCLUDED.sku,
    product_exists = EXCLUDED.product_exists
  `,
  [
    purchaseOrderId,
    JSON.stringify(values)
  ]
);

  console.log(`✅ Líneas sincronizadas: ${values.length}`);
}