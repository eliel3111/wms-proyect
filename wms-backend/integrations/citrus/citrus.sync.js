import { db } from "../../db.js";
import { fetchItemsPage, fetchPurchaseOrdersPage } from "./citrus.items.js";
import { insertProductFromERP } from "./citrus.product.service.js";

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
            console.log(fechaInicioFormatted);
            console.log(fechaFin);
            const items = await fetchItemsPage(page,
                pageSize, fechaInicioFormatted, fechaFinFormatted);

            const orders = await fetchPurchaseOrdersPage(
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
}
