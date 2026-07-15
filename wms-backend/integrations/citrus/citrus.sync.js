import { db } from "../../db.js";
import { fetchAllItems, fetchPurchaseOrdersTest } from "./citrus.items.js";
import { insertProductFromERP } from "./citrus.product.service.js";
import { callERP } from "./erpClient.js";
import {
    normalizeERPDate,
    getLocalERPDate,
    isERPDateGreater
} from "../../services/time.service.js";
import { syncPurchaseOrder, syncPurchaseOrderLines } from "./citrus.items.js"


//🚨🚨🚨🚨🚨Me quede en actualizar esto para ordenes de compra, la ordenes de compra llegan juntas con las lineas, tengo que buscar por fecha, pero primero chequiar si hay de actualizacion si no hay entonces usar de creacion. Solo he tocado syncAllPurchaseOrders tengo que moficar fetchAllItems(maxWriteDate); y luego adentro de fetch modificar callERP( si es necesario, quizas no🚨🚨🚨🚨🚨*/
export async function syncAllPurchaseOrders() {
    const model = "citrus.purchase";

    let lock = null;
    let maxWriteDate = null;

    try {
        console.log(
            "🚀🟥🟥🟥🟥🟥🟥🟥🟥 Sync PURCHASE ORDERS iniciado"
        );

        lock = await lockSyncControl(model);

        if (!lock) {
            console.log(
                `[SYNC] ${model} ya está corriendo`
            );

            return [];
        }

        maxWriteDate = lock.lastWriteDate;

        console.log(
            "LAST WRITE DATE:",
            maxWriteDate
        );

        /* ===============================
           1. CONSULTAR CITRUS
        =============================== */

        const purchaseOrdersResponse =
            await fetchPurchaseOrdersTest(maxWriteDate);

        const orders =
            purchaseOrdersResponse?.Data?.OrdenCompras || [];

        console.log(
            "📦 ÓRDENES RECIBIDAS PARA PROCESAR:",
            orders.length
        );
        if (orders.length === 0) {
            console.log(
                "⚠️ ERP no devolvió órdenes"
            );

            await db.query(
                `
        UPDATE sync_control
        SET
          status = 'success',
          updated_at = now(),
          error_message = NULL
        WHERE model = $1
        `,
                [model]
            );

            return [];
        };

        /* ===============================
           2. ABRIR TRANSACCIÓN
        =============================== */

        const clientDb = await db.connect();

        try {
            await clientDb.query("BEGIN");

            console.log(
                "🟢 BEGIN PURCHASE ORDERS"
            );

            /* ===============================
               3. PROCESAR ÓRDENES
            =============================== */

            for (const order of orders) {
                console.log(
                    "================================"
                );

                console.log(
                    "🟥 ORDEN DE COMPRA:",
                    order.Id
                );

                const purchaseOrderId =
                    await syncPurchaseOrder(
                        clientDb,
                        order
                    );

                if (!purchaseOrderId) {
                    throw new Error(
                        `No se pudo sincronizar la orden ERP ${order.Id}`
                    );
                }

                console.log(
                    "🆔 WMS PURCHASE ORDER ID:",
                    purchaseOrderId
                );

                console.log(
                    "🟨 ESTADO ERP:",
                    order.Estatus
                );

                // Si está cancelada/cerrada,
                // actualiza encabezado pero no las líneas.
                if (order.Estatus !== "C") {
                    await syncPurchaseOrderLines(
                        clientDb,
                        order,
                        purchaseOrderId
                    );
                } else {
                    console.log(
                        "⛔ Orden cancelada; se ignoran sus líneas"
                    );
                }

                /* ===============================
                   4. ACTUALIZAR FECHA MÁXIMA
                =============================== */

                const writeDate =
                    order.FechaActualizacion ||
                    order.FechaCreacion;

                if (!writeDate) {
                    console.log(
                        "⚠️ Orden sin fecha:",
                        order.Id
                    );

                    continue;
                }

                const writeDateDate =
                    new Date(writeDate);

                const maxWriteDateDate =
                    new Date(maxWriteDate);

                if (
                    Number.isNaN(
                        writeDateDate.getTime()
                    )
                ) {
                    console.log(
                        "⚠️ Fecha inválida:",
                        writeDate
                    );

                    continue;
                }

                console.log(
                    "🟨 FECHA ORDEN:",
                    writeDateDate.toISOString()
                );

                console.log(
                    "🟥 FECHA MÁXIMA:",
                    maxWriteDateDate.toISOString()
                );

                if (
                    writeDateDate.getTime() >
                    maxWriteDateDate.getTime()
                ) {
                    /*
                      Guarda la fecha exacta.
                      Como tus operaciones son UPSERT,
                      no pasa nada si Citrus devuelve
                      nuevamente una orden con la misma fecha.
                    */
                    maxWriteDate = writeDate;

                    console.log(
                        "🆕 NUEVA MAX WRITE DATE:",
                        maxWriteDate
                    );
                }
            }

            /* ===============================
               5. ACTUALIZAR CONTROL
            =============================== */

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
                [
                    maxWriteDate,
                    model
                ]
            );

            await clientDb.query("COMMIT");

            console.log(
                "✅ Sync Purchase Orders terminado"
            );

        } catch (dbError) {
            await clientDb.query("ROLLBACK");

            console.error(
                "🔴 ROLLBACK PURCHASE ORDERS:",
                dbError
            );

            throw dbError;

        } finally {
            clientDb.release();

            console.log(
                "🔚 Cliente PostgreSQL liberado"
            );
        }

        return orders;

    } catch (error) {
        console.error(
            `[SYNC ERROR] ${model}:`,
            error.message
        );

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
                [
                    error.message,
                    model
                ]
            );
        }

        throw error;
    }
}




/*
#1Se declara el model, luego de usa lockSyncControl para bloquiar ese modelo en la sincronizacion. Si esta lock anteriormente entonces no se continua, pero si todo bien se define el la fecha de inicio del sync. Luego se usa fetchAllItems para buscar todos los items usando la fecha de inicio.

#5Cuando llega desde fetchAllItems, se verifica si el ERP devolvió productos; si no hay, se marca la sincronización como success y se termina. Si hay items, se inicia una transacción, se recorren y se insertan o actualizan con insertProductFromERP, actualizando también maxWriteDate con la fecha más reciente. Si todo sale bien se hace COMMIT y se guarda el nuevo last_write_date; si ocurre un error se hace ROLLBACK y el estado del sync se marca como failed.
*/
export async function syncAllItems() {

    const model = "citrus.items";

    let lock = null;
    let maxWriteDate = null;

    try {

        console.log("🚀🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩 Sync items iniciado");

        // 🔒 obtener lock
        lock = await lockSyncControl(model);

        console.log("LOCK: ", lock)

        if (!lock) {
            console.log(`[SYNC] ${model} ya está corriendo`);
            return;
        }

        maxWriteDate = lock.lastWriteDate;

        console.log("LAST WRITE DATE:", maxWriteDate);

        /* ===============================
           1️⃣ LLAMAR ERP
        =============================== */

        const items = await fetchAllItems(maxWriteDate);

        if (!items || items.length === 0) {

            console.log("⚠️ ERP no devolvió items");

            await db.query(`
    UPDATE sync_control
    SET
      status = 'success',
      updated_at = now(),
      error_message = NULL
    WHERE model = $1
  `, [model]);

            return;
        }

        console.log(`📦 ${items.length} items recibidos`);

        /* ===============================
           2️⃣ UPSERT DB
        =============================== */

        const client = await db.connect();

        try {

            await client.query("BEGIN");

            for (const item of items) {

                await insertProductFromERP(client, item);
                const itemDate =
                    item.FechaActualizacion ||
                    item.FechaCreacion;
                console.log("itemdate", itemDate);
                console.log("MAX WRITE DATE:", normalizeERPDate(maxWriteDate));
                console.log("ITEMDATE > MAXWRITEDATE", isERPDateGreater(itemDate, normalizeERPDate(maxWriteDate)));

                if (isERPDateGreater(itemDate, normalizeERPDate(maxWriteDate))) {
                    maxWriteDate = itemDate;
                } else {
                    maxWriteDate = getLocalERPDate();
                }

                //console.log("local time", getLocalERPDate())
                //maxWriteDate = getLocalERPDate()


            }

            await client.query("COMMIT");

        } catch (error) {

            await client.query("ROLLBACK");
            throw error;

        } finally {
            client.release();
        }

        /* ===============================
           ✅ MARCAR SUCCESS
        =============================== */
        console.log("🟪 NEW LASTWRITE: ", maxWriteDate);
        await db.query(`
      UPDATE sync_control
      SET
        last_write_date = $1,
        status = 'success',
        updated_at = now(),
        error_message = NULL
      WHERE model = $2
    `, [maxWriteDate, model]);

        console.log("🟨🟨🟨🟨🟨🟨🟨🟨🟨🟨🟨🟨🟨🟨🟨🟨🟨🟨🟨 Sync items terminado");

    } catch (error) {

        console.error(`[SYNC ERROR] citrus.items`, error.message);

        if (lock?.id) {

            await db.query(`
        UPDATE sync_control
        SET
          status = 'failed',
          updated_at = now(),
          error_message = $1
        WHERE model = $2
      `, [error.message, model]);

        }

        throw error;
    }
}

const OLD_DATE = "2000-01-01 00:00:00";

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

            console.log("LOCK LAST WRITE DATE:", normalizeERPDate(row.last_write_date));

            return {
                id: row.id,
                lastWriteDate: normalizeERPDate(row.last_write_date)
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


/*
export async function syncAllItems() {

    console.log("🚀 Iniciando sync productos...");
    const pageSize = 100;

    let page = 0;
    let jobId = null;
    let client;

    try {

        client = await db.connect();   // 🔥 AQUI


        // -------------------------------------------------
        // 🔐 1. LOCK GLOBAL (evita 2 sync simultáneos)
        // -------------------------------------------------
        const lock = await client.query(`
      SELECT pg_try_advisory_lock(999999) as locked
    `);

        if (!lock.rows[0].locked) {
            console.log("⛔ Ya existe un sync corriendo. Abortando.");
            return;
        }

        // -------------------------------------------------
        // 2. BUSCAR JOB ACTIVO
        // -------------------------------------------------
        const jobSearch = await client.query(`
SELECT 
  id,
  DATE(fecha_inicio) AS fecha_inicio
FROM sincronizacion_productos
ORDER BY id DESC
LIMIT 1
`);

        let fechaInicio = null;
        let fechaFin = new Date();

        if (jobSearch.rowCount > 0) {
            fechaInicio = jobSearch.rows[0].fecha_inicio;
            jobId = jobSearch.rows[0].id;
            console.log("Fecha desde DB:", fechaInicio);
        }

        if (!fechaInicio) {
            fechaInicio = "2000-01-01";
        }

        const fechaInicioFormatted = new Date(fechaInicio)
            .toISOString()
            .slice(0, 10);

        const fechaFinFormatted = new Date()
            .toISOString()
            .slice(0, 10);

        console.log("Fecha Inicio:", fechaInicioFormatted);
        console.log("Fecha Fin:", fechaFinFormatted);

        if (jobSearch.rows.length > 0) {

            const job = jobSearch.rows[0];
            jobId = job.id;

            // 🔁 reutilizar misma fila
            await client.query(`
    UPDATE sincronizacion_productos
    SET pagina_actual = 0,
        fecha_inicio = NOW(),
        fecha_ultima_actualizacion = NOW(),
        estado='RUNNING',
        total_procesados = 0,
        total_errores = 0
    WHERE id=$1
  `, [jobId]);

            page = 0;

            //console.log(`♻️ Reutilizando job ${jobId}`);
        }
        else {
            // primera vez en la vida
            const insert = await client.query(`
    INSERT INTO sincronizacion_productos
    (pagina_actual, tamano_pagina, estado)
    VALUES (0, $1, 'RUNNING')
    RETURNING id
  `, [pageSize]);

            jobId = insert.rows[0].id;
            page = 0;

            //console.log(`🆕 Primer job creado ID ${jobId}`);
        }


        // -------------------------------------------------
        // 4. LOOP PRINCIPAL
        // -------------------------------------------------
        while (true) {

            //console.log(`📄 Página actual: ${page}`);
            console.log("FORMATO CORRECTO", fechaInicioFormatted);
            console.log(fechaFin);
            const items = await fetchItemsPage(page,
                pageSize, fechaInicioFormatted, fechaFinFormatted);

            /*const orders = await fetchPurchaseOrdersPage(
                1,
                50,
                "2024-01-01T00:00:00",
                fechaFinFormatted
            );

            if (!items || items.length === 0) {
                console.log("🏁 No hay más items");

                await client.query(`
          UPDATE sincronizacion_productos
          SET estado='DONE',
              fecha_ultima_actualizacion=NOW()
          WHERE id=$1
        `, [jobId]);

                break;
            }

            // -------------------------------------------------
            // 5. GUARDAR ITEMS
            // -------------------------------------------------
            let erroresPagina = 0;

            for (const item of items) {
                try {
                    // 🔥 AQUI TU UPSERT
                    console.log(item);
                    const wmsResult = await insertProductFromERP(client, item);
                    console.log(wmsResult);

                } catch (err) {
                    erroresPagina++;
                    console.error("❌ Error item:", err.message);

                    // opcional: guardar error en tabla errores
                    await client.query(`
            INSERT INTO sincronizacion_errores
            (producto_id, pagina, mensaje_error, payload)
            VALUES ($1,$2,$3,$4)
          `, [
                        item?.Id || null,
                        page,
                        err.message,
                        JSON.stringify(item)
                    ]);
                }
            }

            // -------------------------------------------------
            // 6. ACTUALIZAR PROGRESO
            // -------------------------------------------------
            await client.query(`
        UPDATE sincronizacion_productos
        SET pagina_actual=$1,
            fecha_ultima_actualizacion=NOW(),
            total_procesados = total_procesados + $2,
            total_errores = total_errores + $3
        WHERE id=$4
      `, [page, items.length, erroresPagina, jobId]);

            //console.log(`💾 Página ${page} guardada (${items.length})`);

            // -------------------------------------------------
            // 7. DETECTAR ULTIMA PAGINA
            // -------------------------------------------------
            if (items.length < pageSize) {

                //console.log("🏁 Última página detectada");

                await client.query(`
          UPDATE sincronizacion_productos
          SET estado='DONE',
              fecha_ultima_actualizacion=NOW()
          WHERE id=$1
        `, [jobId]);

                break;
            }

            page++;
        }

        console.log("✅ Sync completo finalizado");

    } catch (error) {

        console.error("🔴 ERROR SYNC:", error.message);

        if (jobId) {
            await client.query(`
        UPDATE sincronizacion_productos
        SET estado='ERROR',
            fecha_ultima_actualizacion=NOW()
        WHERE id=$1
      `, [jobId]);
        }

    } finally {
        try {
            if (client) {
                await client.query(`SELECT pg_advisory_unlock(999999)`);
                client.release();   // 🔥 MUY IMPORTANTE
            }
        } catch (err) {
            console.error("Error liberando recursos:", err.message);
        }
    }
}*/



