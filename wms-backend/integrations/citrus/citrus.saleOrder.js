import { db } from "../../db.js";
import { fetchAllItems, fetchPurchaseOrdersTest } from "./citrus.items.js";
import { insertProductFromERP } from "./citrus.product.service.js";

import { callERPSales, callERPCreateConduce } from "./erpClient.js";



const OLD_DATE = "2000-01-01 00:00:00";


export async function getActiveSaleOrders() {
  const model = "citrus.sale";
  let lock = null;
  let maxWriteDate = null;
  let clientDb = null;

  try {
    console.log("🚀 Sync SALE ORDERS iniciado");
    //🟨🟨
    lock = await lockSyncControl(model);

    if (!lock) {
      console.log(`[SYNC] ${model} ya está corriendo`);
      return;
    }

    maxWriteDate = lock.lastWriteDate || OLD_DATE;

    /* ==========================
       1️⃣ FETCH ERP
    ========================== */
    //🟨🟨
    const saleOrders = await fetchSalesOrdersTest(maxWriteDate);

    const orders = saleOrders || [];

    console.log("🟨 TOTAL ORDER VENTA ERP: ", orders.length);

    if (orders.length === 0) {
      console.log("⚠️ ERP no devolvió órdenes");

      await db.query(`
        UPDATE sync_control
        SET status = 'success', updated_at = now(), error_message = NULL
        WHERE model = $1
      `, [model]);

      return;
    }

    /* ==========================
       2️⃣ DB TRANSACTION
    ========================== */

    clientDb = await db.connect();

    try {
      await clientDb.query("BEGIN");

      // 🔹 UPSERT
      for (const so of orders) {
        //🟨🟨      
        console.log("🟥 ORDEN: ", so);
        const picking = await syncSalesOrder(clientDb, so);
        console.log("PICKING COMPLETO QUE SALE DE syncSalesOrder: ", picking);
        console.log("🆔 ID:", picking.id);
        console.log("📦 NAME:", picking.name);

        // 🔥 sync líneas (AQUÍ ESTÁ LA MAGIA)
        await syncSalesOrderLines(clientDb, so, picking.id);

        const writeDate = so.FechaActualizacion || so.FechaCreacion;



        const writeDateDate =
          new Date(writeDate);

        const maxWriteDateDate =
          new Date(maxWriteDate);

        console.log(
          "writeDateDate:",
          writeDateDate.toISOString()
        );

        console.log(
          "maxWriteDateDate:",
          maxWriteDateDate.toISOString()
        );

        if (
          writeDate &&
          writeDateDate.getTime() >
          maxWriteDateDate.getTime()
        ) {

          maxWriteDate = new Date(
            writeDateDate.getTime() + 1000
          );

        }
      }

      // 🔹 DELETE LOGIC (SI APLICA)
      // ⚠️ Aquí deberías adaptar porque ya no es Odoo
      // Ejemplo simple:
      /*
      for (const so of orders) {
        if (so.Estatus === "C") {
          await deleteSaleOrder(clientDb, so.Id);
        }
      }
      */

      /* ==========================
         ✅ SUCCESS
      ========================== */
      console.log("LAST WRITE DATE: ", maxWriteDate);
      await clientDb.query(
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

      await clientDb.query("COMMIT");

    } catch (dbError) {
      await clientDb.query("ROLLBACK");
      throw dbError;
    } finally {
      clientDb.release();
    }

    return orders;

  } catch (error) {
    console.error(`[SYNC ERROR x] ${model}`, error.message);

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
AND (
  status != 'running'
  OR updated_at < now() - interval '10 minutes'
)
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

function formatERPDate(date) {

  const d = new Date(date);

  const yyyy = d.getFullYear();

  const mm = String(
    d.getMonth() + 1
  ).padStart(2, "0");

  const dd = String(
    d.getDate()
  ).padStart(2, "0");

  const hh = String(
    d.getHours()
  ).padStart(2, "0");

  const mi = String(
    d.getMinutes()
  ).padStart(2, "0");

  const ss = String(
    d.getSeconds()
  ).padStart(2, "0");

  const ms = String(
    d.getMilliseconds()
  ).padStart(3, "0");

  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}.${ms}`;
}


export async function fetchSalesOrdersTest(lastWriteDate) {
  try {
    const fechaInicio =
      formatERPDate(lastWriteDate);

    const fechaFin =
      formatERPDate(new Date());

    console.log(
      "FECHA INICIO:",
      fechaInicio
    );

    console.log(
      "FECHA FIN:",
      fechaFin
    );

    // 🔥 Toggle filtros
    const useCreatedDate = false;
    const useUpdatedDate = true;

    let dateFilter = "";

    if (useCreatedDate) {
      dateFilter = `
        <tem:EsFecha>true</tem:EsFecha>
        <tem:FechaInicio>${fechaInicio}</tem:FechaInicio>
        <tem:FechaFin>${fechaFin}</tem:FechaFin>
      `;
    }

    if (useUpdatedDate) {
      dateFilter = `
        <tem:FechaInicioActualizacion>${fechaInicio}</tem:FechaInicioActualizacion>
        <tem:FechaFinActualizacion>${fechaFin}</tem:FechaFinActualizacion>
      `;
    }

    // 🧾 XML SOAP (VENTAS)
    const xml = `
        <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                        xmlns:tem="http://tempuri.org/">
        <soapenv:Header/>
        <soapenv:Body>
            <tem:BuscarOrdenesVentas>
                <tem:ordenVentaWhere>

                    <tem:CantidadPorPagina>10</tem:CantidadPorPagina>

                    ${dateFilter}

                </tem:ordenVentaWhere>
            </tem:BuscarOrdenesVentas>
        </soapenv:Body>
        </soapenv:Envelope>
        `;
    //🟨🟨
    const data = await callERPSales(xml);

    const orders = data?.Data?.OrdenesVentas || [];

    console.log("📦 Total órdenes:", orders.length);

    return orders;

  } catch (error) {
    console.error("🔥 ERROR FETCH SALES:", error.message);
    return [];
  }
}





async function syncSalesOrder(clientDb, order) {
  try {
    console.log("📦 UPSERT PICKING:");

    if (!clientDb) {
      throw new Error("clientDb is NULL ❌");
    }

    // 🔹 IDs
    const erpId = order.Id ?? null;
    const saleId = order.Id ?? null;
    const saleName = `SO-${order.Id}`;

    // 🔹 Locations
    const locationId = null;
    const locationDestId = null;

    const erp_tienda_id = order.TiendaId ?? null;
    const erp_vendedor_id = order.VendedorId ?? null;

    // 🔹 Cliente
    const supplierName = order.NombreCliente ?? null;
    const erp_cliente_id = order.ClienteId ?? null;
    const erp_direccion_cliente = order.DireccionCliente ?? null;

    // 🔹 Estado
    const statusMap = {
      A: "draft",
      C: "cancel",
    };

    const state = statusMap[order.Estatus] || "draft";

    console.log("🟥🟨 ESTATUS FINAL: ", state);

    /* =========================
       1️⃣ UPDATE
    ========================= */

    const updateResult = await clientDb.query(`
  UPDATE stock_picking
  SET
    sale_id = $1,
    state = $2,
    erp_location_id = $3,
    erp_location_dest_id = $4,
    order_name = $5,
    erp_cliente = $6,
    erp_cliente_id = $7,
    erp_direccion_cliente = $8,
    erp_tienda_id = $9,
    erp_vendedor_id = $10
  WHERE erp_id = $11
  RETURNING id, order_name
`, [
      saleId,
      state,
      locationId,
      locationDestId,
      saleName,
      supplierName,
      erp_cliente_id,
      erp_direccion_cliente,
      erp_tienda_id,
      erp_vendedor_id,
      erpId
    ]);

    if (updateResult.rowCount > 0) {
      console.log("♻️ PICKING ACTUALIZADO");

      return {
        id: updateResult.rows[0].id,
        name: updateResult.rows[0].order_name
      };
    }

    /* =========================
       2️⃣ INSERT
    ========================= */

    console.log("➕ INSERTANDO PICKING NUEVO");

    const insertResult = await clientDb.query(`
  INSERT INTO stock_picking (
    erp_id,
    sale_id,
    state,
    picking_type,
    erp_location_id,
    erp_location_dest_id,
    order_name,
    erp_cliente,
    erp_cliente_id,
    erp_direccion_cliente,
    erp_tienda_id,
    erp_vendedor_id
  )
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
  RETURNING id, order_name
`, [
      erpId,
      saleId,
      state,
      'outgoing',
      locationId,
      locationDestId,
      saleName,
      supplierName,
      erp_cliente_id,
      erp_direccion_cliente,
      erp_tienda_id,
      erp_vendedor_id
    ]);

    return {
      id: insertResult.rows[0].id,
      name: insertResult.rows[0].order_name
    };

  } catch (error) {
    console.error("❌ Error upserting picking:", error);
    throw error;
  }
}




async function syncSalesOrderLines(clientDb, order, pickingId) {

  const lines = order.OrdenVentaDetalle || [];

  const maxRetries = 3;
  let attempt = 0;

  console.log("LINEAS DE SALE ORDER:", lines);

  if (!lines.length) {
    console.log("⚠️ Orden sin líneas");
    return;
  }

  while (attempt < maxRetries) {



    try {

      console.log(
        `🚀 syncSalesOrderLines intento ${attempt + 1}`
      );

      const currentERPProducts = lines.map(
        line => line.Item?.Id
      );

      console.log(
        "🟩3️⃣ PRODUCTOS ERP ACTUALES:",
        currentERPProducts
      );

      const deleteResult = await clientDb.query(
        `
  DELETE FROM stock_move
  WHERE picking_id = $1
  AND erp_product_id IS NOT NULL
  AND erp_product_id != ALL($2::bigint[])
  RETURNING id, erp_product_id, product_id
  `,
        [
          pickingId,
          currentERPProducts
        ]
      );

      if (deleteResult.rows.length > 0) {

        console.log(
          "🗑️ MOVES ELIMINADOS:"
        );

        console.table(deleteResult.rows);

      } else {

        console.log(
          "✅ NO HABÍA MOVES PARA ELIMINAR"
        );

      }



      /* =====================================
         1️⃣ RECORRER LÍNEAS
      ===================================== */

      for (const line of lines) {

        const erp_move_id = line.Id;

        const erp_product_id =
          line.Item?.Id || null;

        const product_qty =
          parseInt(line.ItemCantidad || 0);

        const name =
          `MOVE-${line.Id}`;

        let state = null;

        // 🔥 SOLO SI ESTÁ CANCELADO
        if (line.EstatusDespacho === "C") {
          state = "cancel";
        }
        const pickingIdInt = parseInt(pickingId);

        console.log("🟨 PROCESANDO:", {
          erp_move_id,
          erp_product_id,
          product_qty,
          state,
          pickingIdInt
        });

        /* =====================================
           2️⃣ QUERY ÚNICO
        ===================================== */

        /* =====================================
    1️⃣ BUSCAR PICKING
 ===================================== */

        const pickingResult = await clientDb.query(
          `
  SELECT
    id,
    name
  FROM stock_picking
  WHERE id = $1
  `,
          [pickingIdInt]
        );

        if (!pickingResult.rows.length) {

          console.log(
            "⚠️ Picking no encontrado:",
            pickingIdInt
          );

          continue;

        }
        console.log("BUSCAR PICKING", pickingResult.rows[0]);
        const picking = pickingResult.rows[0];

        const reference = picking.name;

        /* =====================================
           2️⃣ BUSCAR PRODUCTO
        ===================================== */

        const productResult = await clientDb.query(
          `
  SELECT
    id,
    uom_id
  FROM products
  WHERE erp_id = $1
  LIMIT 1
  `,
          [erp_product_id]
        );

        if (!productResult.rows.length) {

          console.log(
            "❌ Producto no encontrado:",
            erp_product_id
          );

          continue;

        }

        console.log("BUSCAR PRODUCTO", productResult.rows[0]);

        const product = productResult.rows[0];

        const product_id =
          product.id;

        const product_uom_id =
          product.uom_id;

        /* =====================================
           3️⃣ VALIDAR SI MOVE EXISTE
        ===================================== */

        const moveResult = await clientDb.query(
          `
  SELECT EXISTS (
    SELECT 1
    FROM stock_move
    WHERE erp_product_id = $1
    AND picking_id = $2
  ) AS move_exists
  `,
          [
            erp_product_id,
            pickingIdInt
          ]
        );

        const moveExists =
          moveResult.rows[0].move_exists;

        console.log("VALIDAR SI MOVE EXISTE", moveExists);

        console.log("RESULTADOS:", {
          reference,
          product_id,
          product_uom_id,
          moveExists
        });

        console.log("🟥 PICKING:", pickingResult.rows);

        console.log("🟥 PRODUCT:", productResult.rows);

        console.log("🟥 MOVE:", moveResult.rows);



        /* if (!result.rows.length) {
 
           console.log(
             "⚠️ Picking no encontrado:",
             pickingIdInt
           );
 
           continue;
 
         }
 
         const row = result.rows[0];
 
         const reference =
           row.reference;
 
         const product_id =
           row.product_id;
 
         const product_uom_id =
           row.product_uom_id;
 
         const moveExists =
           row.move_exists;*/

        /* =====================================
 VALIDAR PRODUCTO
===================================== */

        if (!product_id) {

          console.log(
            "❌ Producto no encontrado:",
            erp_product_id
          );

          continue;

        }



        /* =====================================
           3️⃣ UPDATE
        ===================================== */

        if (moveExists) {

          console.log(
            "🟦 UPDATE MOVE:",
            erp_move_id
          );

          const updateFields = [
            `product_qty = $1`,
            `reference = $2`,
            `product_id = $3`,
            `product_uom_id = $4`,
            `write_date = now()`
          ];

          const params = [
            product_qty,
            reference,
            product_id,
            product_uom_id
          ];

          // 🔥 SOLO UPDATE STATE SI TIENE VALOR
          if (state) {
            updateFields.push(`state = $5`);

            params.push(state);
          }

          params.push(
            erp_product_id,
            pickingIdInt
          );

          const whereIndex1 =
            params.length - 1;

          const whereIndex2 =
            params.length;

          await clientDb.query(
            `
            UPDATE stock_move
            SET
              ${updateFields.join(", ")}

            WHERE erp_product_id = $${whereIndex1}
            AND picking_id = $${whereIndex2}
            `,
            params
          );

        }

        /* =====================================
           4️⃣ INSERT
        ===================================== */

        else {

          console.log(
            "🟩 INSERT MOVE:",
            erp_move_id
          );

          const columns = [
            `erp_move_id`,
            `picking_id`,
            `name`,
            `reference`,
            `erp_product_id`,
            `product_id`,
            `product_uom_id`,
            `product_qty`
          ];

          console.log("VALORES DEL INSERT O UPDATE: ", columns);

          const placeholders = [
            `$1`,
            `$2`,
            `$3`,
            `$4`,
            `$5`,
            `$6`,
            `$7`,
            `$8`
          ];

          const values = [
            erp_move_id,
            pickingIdInt,
            name,
            reference,
            erp_product_id,
            product_id,
            product_uom_id,
            product_qty
          ];

          // 🔥 SOLO INSERT STATE SI TIENE VALOR
          if (state) {

            columns.push(`state`);

            placeholders.push(`$9`);

            values.push(state);

          }

          await clientDb.query(
            `
            INSERT INTO stock_move (
              ${columns.join(", ")}
            )
            VALUES (
              ${placeholders.join(", ")}
            )
            `,
            values
          );

        }

      }

      /* =====================================
         5️⃣ COMMIT
      ===================================== */





      console.log("✅ Líneas sincronizadas");

      return;

    } catch (error) {


      attempt++;

      console.error(
        `❌ Error intento ${attempt}:`,
        error.message
      );

      if (attempt >= maxRetries) {

        console.error(
          "🔥 Máximo de reintentos alcanzado"
        );

        throw error;

      }

      const wait = 2000 * attempt;

      console.log(
        `⏳ Reintentando en ${wait / 1000}s...`
      );

      await new Promise(resolve =>
        setTimeout(resolve, wait)
      );

    }

  }

}


export async function createConduce(payloadERP) {
  console.log("🟨 [CITRUS] Enviando conduce");
  console.log("📤 Payload:", payloadERP);

  if (!payloadERP) {
    return {
      success: false,
      title: "Payload requerido",
      message: "No se puede crear conduce sin payload"
    };
  }
  try {

    // 🔹 1. Formatear fecha
    const fecha = new Date(payloadERP.Fecha)
      .toISOString()
      .slice(0, 19);

      console.log("🟨 PAYLOAD ERP:");
console.log(JSON.stringify(payloadERP, null, 2));

if (
  !payloadERP.ConduceDetalles ||
  !Array.isArray(payloadERP.ConduceDetalles) ||
  payloadERP.ConduceDetalles.length === 0
) {
  return {
    success: false,
    title: "Sin líneas",
    message: "El conduce no tiene líneas para enviar"
  };
}

    // 🔹 2. Construir detalles dinámicamente
   const detallesXML = payloadERP.ConduceDetalles.map(det => {

  console.log("🟦 DETALLE:");
  console.log(det);

  return  `<ConduceDetalle>
<ItemId>${det.ItemId}</ItemId>
<ItemNombre>${det.ItemNombre ?? ''}</ItemNombre>
<ItemCantidad>${det.ItemCantidad}</ItemCantidad>
</ConduceDetalle>`;
}).join("");

    // 🔹 3. Construir XML SOAP
    const xml =
`<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
xmlns:xsd="http://www.w3.org/2001/XMLSchema"
xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
<soap:Body>
<CrearConduce xmlns="http://tempuri.org/">
<conduce>
<ClienteId>${payloadERP.ClienteId}</ClienteId>
<ClienteNombre>${payloadERP.ClienteNombre}</ClienteNombre>
<ClienteDireccion>${payloadERP.ClienteDireccion ?? ''}</ClienteDireccion>
<Fecha>${fecha}</Fecha>
<Estatus>${payloadERP.Estatus}</Estatus>
<TiendaId>${payloadERP.TiendaId}</TiendaId>
<VendedorId>${payloadERP.VendedorId}</VendedorId>
<Nota>${payloadERP.Nota ?? ''}</Nota>
<OrdenVentaId>${payloadERP.OrdenVentaId}</OrdenVentaId>
<ConduceDetalles>
${detallesXML}
</ConduceDetalles>
</conduce>
</CrearConduce>
</soap:Body>
</soap:Envelope>`;

    console.log("🟨 XML CONDUCE:", xml);

  // 🔹 4. Llamar ERP SOAP
const data = await callERPCreateConduce(xml);

    // 🔹 5. Validar respuesta
if (!data || data.Success === 0) {

  console.log("🟥 ERP ERROR:", data?.Mensaje);

  return {
    success: false,
    title: "ERP_ERROR",
    message: data?.Mensaje || "Error desconocido del ERP",
    data
  };
}

    console.log("🟩 CONDUCE CREADO:", data);

    return data;

  } catch (error) {

    console.error("🟥 createConduce error:", error.message);

    return null;
  }
}



export function buildCitrusConducePayload(picking, lines) {
  console.log("🟦 [CITRUS] Iniciando armado de conduce");
  console.log("📦 Picking:", picking);
  console.log("📋 Líneas recibidas:", lines);

  const conduceLines = [];

  for (const line of lines) {
    const qtyDone = Number(line.qty_done || 0);
    const qtyPlanned = Number(line.product_uom_qty || 0);

    console.log("🔍 Revisando línea:", {
      lineId: line.id,
      sku: line.sku,
      qtyDone,
      qtyPlanned
    });

    if (qtyDone > qtyPlanned) {
      return {
        success: false,
        title: "Cantidad inválida",
        message: `El producto ${line.sku} tiene qty_done mayor que la cantidad requerida`
      };
    }

    if (qtyDone > 0) {
      conduceLines.push({
        ItemId: line.erp_id,
        ItemNombre: line.description,
        ItemCantidad: qtyDone
      });
    }
  }

  if (conduceLines.length === 0) {
    return {
      success: false,
      title: "Sin productos despachados",
      message: "Todas las líneas tienen cantidad despachada en cero"
    };
  }

  const payload = {
    ClienteId: picking.erp_cliente_id,
    ClienteNombre: picking.erp_cliente,
    ClienteDireccion: picking.erp_direccion_cliente,
    TiendaId: picking.erp_tienda_id,
    VendedorId: picking.erp_vendedor_id,
    OrdenVentaId: picking.sale_id,
    Estatus: "A",
    Fecha: new Date().toISOString().slice(0, 19),
    Nota: `Conduce generado desde WMS para picking ${picking.name}`,
    ConduceDetalles: conduceLines
  };

  console.log("✅ [CITRUS] Payload generado:", payload);

  return {
    success: true,
    payload,
    lines: conduceLines
  };
}