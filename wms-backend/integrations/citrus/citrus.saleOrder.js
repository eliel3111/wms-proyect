import { db } from "../../db.js";
import { fetchAllItems, fetchPurchaseOrdersTest } from "./citrus.items.js";
import { insertProductFromERP } from "./citrus.product.service.js";

import { callERPSales } from "./erpClient.js";



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

console.log("🆔 ID:", picking.id);
console.log("📦 NAME:", picking.name);

        const writeDate = so.FechaActualizacion || so.Fecha;

        if (writeDate && new Date(writeDate) > new Date(maxWriteDate)) {
          maxWriteDate = writeDate;
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


export async function fetchSalesOrdersTest(lastWriteDate) {
  try {
    const fechaInicio = new Date(lastWriteDate)
      .toISOString()
      .slice(0, 19);

    const fechaFin = new Date()
      .toISOString()
      .slice(0, 19);

    console.log("FECHA INICIO:", fechaInicio);
    console.log("FECHA FIN:", fechaFin);

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

    // 🔹 Cliente
    const supplierName = order.NombreCliente ?? null;

    // 🔹 Estado
    const statusMap = {
      A: "draft",
      C: "cancel",
    };

    const state = statusMap[order.Estatus] || "draft";

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
        erp_cliente = $6
      WHERE erp_id = $7
      RETURNING id, name
    `, [
      saleId,
      state,
      locationId,
      locationDestId,
      saleName,
      supplierName,
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
        erp_cliente
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING id, name
    `, [
      erpId,
      saleId,
      state,
      'outgoing',
      locationId,
      locationDestId,
      saleName,
      supplierName
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