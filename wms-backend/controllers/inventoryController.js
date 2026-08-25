import { db } from "../db.js";
import { saveInventoryByCount } from "../services/inventoryService.js";
import { getInventorySessionStatusService } from "../services/inventory.count.js";
import { emitInventorySummary } from "../services/inventory.count.js";
import { buscarTodasLasExistenciasAlmacen } from "../integrations/citrus/citrus.erpStockSync.js";
import { getInventoryFinalReportExcelService, getInventoryLocationReportExcelService } from "../services/inventoryFinalReportExcel.service.js";
import {
  startInventoryAdjustmentWorker
} from "../services/inventoryAdjustment.worker.js";





// ============================================================
// FINALIZAR SESIÓN DE INVENTARIO
// REVIEW → POSTED
// ============================================================

export async function finalizeInventorySession(
  req,
  res
) {

  const client =
    await db.connect();

  let transactionStarted =
    false;


  try {

    console.log("");
    console.log(
      "🟩🟩🟩 ========================================"
    );

    console.log(
      "✅ FINALIZANDO SESIÓN DE INVENTARIO"
    );

    console.log(
      "🟩🟩🟩 ========================================"
    );


    // ==========================================================
    // OBTENER DATOS
    // ==========================================================

    const sessionId =
      Number(
        req.body?.id
      );


    const userId =
      Number(
        req.user?.id
      );


    console.log(
      "📥 SESSION ID:",
      sessionId
    );

    console.log(
      "👤 USER ID:",
      userId
    );


    // ==========================================================
    // VALIDAR SESSION ID
    // ==========================================================

    if (
      !Number.isInteger(sessionId) ||
      sessionId <= 0
    ) {

      return res
        .status(200)
        .json({

          success: false,

          title:
            "Sesión inválida",

          message:
            "Debe proporcionar una sesión de inventario válida."

        });

    }


    // ==========================================================
    // VALIDAR USER ID
    // ==========================================================

    if (
      !Number.isInteger(userId) ||
      userId <= 0
    ) {

      return res
        .status(200)
        .json({

          success: false,

          title:
            "Usuario inválido",

          message:
            "No se pudo identificar el usuario autenticado."

        });

    }


    // ==========================================================
    // INICIAR TRANSACCIÓN
    // ==========================================================

    await client.query(
      "BEGIN"
    );

    transactionStarted =
      true;


    // ==========================================================
    // BUSCAR Y BLOQUEAR SESIÓN
    // ==========================================================

    const sessionResult =
      await client.query(
        `
        SELECT
          id,
          code,
          user_id,
          status,
          erp_warehouse_id,
          completed_by,
          start_date,
          end_date,
          created_at,
          updated_at

        FROM inventory_sessions

        WHERE
          id = $1

        FOR UPDATE
        `,
        [
          sessionId
        ]
      );


    // ==========================================================
    // VALIDAR QUE EXISTA
    // ==========================================================

    if (
      sessionResult.rowCount === 0
    ) {

      await client.query(
        "ROLLBACK"
      );

      transactionStarted =
        false;


      return res
        .status(200)
        .json({

          success: false,

          title:
            "Sesión no encontrada",

          message:
            "La sesión de inventario no existe."

        });

    }


    const session =
      sessionResult.rows[0];


    console.log(
      "📦 SESIÓN:",
      {
        id:
          session.id,

        code:
          session.code,

        status:
          session.status,

        erpWarehouseId:
          session.erp_warehouse_id
      }
    );


    // ==========================================================
    // VALIDAR STATUS
    // ==========================================================
    //
    // Únicamente:
    //
    // review → posted
    //
    // ==========================================================

    if (
      session.status !==
      "review"
    ) {

      await client.query(
        "ROLLBACK"
      );

      transactionStarted =
        false;


      return res
        .status(200)
        .json({

          success: false,

          title:
            "Sesión no está en revisión",

          message:
            `La sesión debe estar en estado review para finalizarse. Estado actual: ${session.status}.`

        });

    }


    // ==========================================================
    // VALIDAR QUE NO HAYA AJUSTE EJECUTÁNDOSE
    // ==========================================================

    const activeJobResult =
      await client.query(
        `
        SELECT
          id,
          job_type,
          status

        FROM inventory_adjustment_jobs

        WHERE
          inventory_session_id = $1

          AND status IN (
            'pending',
            'processing',
            'waiting_citrus'
          )

        ORDER BY
          id DESC

        LIMIT 1
        `,
        [
          sessionId
        ]
      );


    if (
      activeJobResult.rowCount > 0
    ) {

      const activeJob =
        activeJobResult.rows[0];


      console.log(
        "⛔ AJUSTE TODAVÍA EN PROCESO:",
        activeJob
      );


      await client.query(
        "ROLLBACK"
      );

      transactionStarted =
        false;


      return res
        .status(200)
        .json({

          success: false,

          title:
            "Ajuste en proceso",

          message:
            `El ajuste ${activeJob.job_type} todavía está en estado ${activeJob.status}. Espere a que termine antes de finalizar la sesión.`,

          data: {
            jobId:
              activeJob.id,

            jobType:
              activeJob.job_type,

            status:
              activeJob.status
          }

        });

    }


    // ==========================================================
    // VALIDAR QUE EXISTA AL MENOS UN AJUSTE COMPLETADO
    // ==========================================================

    const completedAdjustmentResult =
      await client.query(
        `
        SELECT EXISTS (

          SELECT 1

          FROM inventory_adjustment_jobs

          WHERE
            inventory_session_id = $1

            AND status = 'completed'

        ) AS has_completed_adjustment
        `,
        [
          sessionId
        ]
      );


    const hasCompletedAdjustment =
      completedAdjustmentResult
        .rows[0]
        ?.has_completed_adjustment === true;


    console.log(
      "✅ ¿TIENE AJUSTE COMPLETADO?:",
      hasCompletedAdjustment
    );


    if (
      !hasCompletedAdjustment
    ) {

      await client.query(
        "ROLLBACK"
      );

      transactionStarted =
        false;


      return res
        .status(200)
        .json({

          success: false,

          title:
            "Inventario no ajustado",

          message:
            "Debe completar el ajuste de inventario antes de finalizar la sesión."

        });

    }


    // ==========================================================
    // FINALIZAR SESIÓN
    // ==========================================================

    console.log(
      "🟩 CAMBIANDO SESIÓN A POSTED"
    );


    const updateResult =
      await client.query(
        `
        UPDATE inventory_sessions

        SET
          status =
            'posted',

          end_date =
            COALESCE(
              end_date,
              NOW()
            ),

          updated_at =
            NOW()

        WHERE
          id = $1

        RETURNING
          id,
          code,
          user_id,
          status,
          erp_warehouse_id,
          completed_by,
          start_date,
          end_date,
          created_at,
          updated_at
        `,
        [
          sessionId
        ]
      );


    const postedSession =
      updateResult.rows[0];


    // ==========================================================
    // COMMIT
    // ==========================================================

    await client.query(
      "COMMIT"
    );

    transactionStarted =
      false;


    console.log("");
    console.log(
      "✅ INVENTARIO FINALIZADO CORRECTAMENTE"
    );

    console.log(
      "📦 SESIÓN:",
      postedSession.code
    );

    console.log(
      "📌 STATUS:",
      postedSession.status
    );

    console.log(
      "👤 FINALIZADA POR USER:",
      userId
    );

    console.log(
      "🟩🟩🟩 ========================================"
    );


    // ==========================================================
    // RESPUESTA FRONTEND
    // ==========================================================

    return res
      .status(200)
      .json({

        success: true,

        title:
          "Inventario finalizado",

        message:
          "La sesión de inventario fue finalizada correctamente.",

        hasActiveSession:
          false,

        session:
          null,

        postedSession

      });


  } catch (error) {

    if (
      transactionStarted
    ) {

      try {

        await client.query(
          "ROLLBACK"
        );

      } catch (
        rollbackError
      ) {

        console.error(
          "❌ ERROR ROLLBACK FINALIZE:",
          rollbackError
        );

      }

    }


    console.error("");
    console.error(
      "🟥 ERROR FINALIZANDO SESIÓN:"
    );

    console.error(
      error
    );


    return res
      .status(500)
      .json({

        success: false,

        title:
          "Error finalizando inventario",

        message:
          "Ocurrió un error al finalizar la sesión de inventario."

      });


  } finally {

    client.release();

  }

}



// ============================================================
// CONTROLLER
// INICIAR AJUSTE DE INVENTARIO
// ============================================================

export async function startInventoryAdjustment(
  req,
  res
) {

  const client =
    await db.connect();

  let transactionStarted = false;

  let committed = false;

  let adjustmentJobId = null;


  try {

    console.log("");
    console.log(
      "🟥🟥🟥 ========================================"
    );
    console.log(
      "📦 INICIANDO PROCESO DE AJUSTE DE INVENTARIO"
    );
    console.log(
      "🟥🟥🟥 ========================================"
    );


    // ============================================================
    // NUEVO
    // OBTENER USER ID
    // ============================================================

    const userId =
      Number(
        req.user?.id ??
        req.body?.userId
      );


    console.log(
      "👤 USER ID:",
      userId
    );


    if (
      !Number.isInteger(userId) ||
      userId <= 0
    ) {

      return res.status(400).json({
        success: false,
        message:
          "Debe proporcionar un userId válido."
      });

    }


    // ============================================================
    // NUEVO
    // VALIDAR PERMISO DEL USUARIO
    // ============================================================

    /*
    🟥 PENDIENTE

    AQUÍ VAMOS A COLOCAR EL CÓDIGO
    QUE ME DARÁS PARA VALIDAR:

    ¿EL USUARIO TIENE PERMISO
    PARA AJUSTAR INVENTARIO?


    Ejemplo solamente:

    const canAdjustInventory =
      await validarPermisoAjusteInventario(
        userId
      );


    if (!canAdjustInventory) {

      return res.status(403).json({
        success: false,
        message:
          "No tiene permiso para ajustar inventario."
      });

    }

    */




    // ============================================================
    // DESDE AQUÍ:
    //
    // TU CÓDIGO ACTUAL
    //
    // NO SE CAMBIA
    // ============================================================


    console.log(
      "🟦🟦🟦 ================================"
    );

    console.log(
      "📄 INVENTORY REPORT"
    );

    console.log(
      "📌 GENERANDO REPORTE FINAL"
    );

    console.log(
      "🟦🟦🟦 ================================"
    );


    await client.query(
      "BEGIN"
    );

    transactionStarted = true;


    const sessionResult =
      await client.query(`
    SELECT
      id,
      code,
      status,
      user_id,
      erp_warehouse_id,
      start_date,
      end_date,
      created_at,
      updated_at
    FROM inventory_sessions
    WHERE status IN ('draft', 'in-progress', 'review')
    ORDER BY updated_at DESC
  `);


    if (
      sessionResult.rows.length === 0
    ) {

      await client.query(
        "ROLLBACK"
      );


      return res
        .status(200)
        .json({

          success: false,

          title:
            "No hay sesión de inventario",

          message:
            "No existe una sesión de inventario activa para generar el reporte final."

        });

    }


    const reviewSession =
      sessionResult.rows.find(

        (session) =>
          session.status === "review"

      );


    if (!reviewSession) {

      await client.query(
        "ROLLBACK"
      );


      return res
        .status(200)
        .json({

          success: false,

          title:
            "Sesión no está en revisión",

          message:
            "Para generar el reporte final, la sesión debe estar en estado review."

        });

    }


    const sessionId =
      Number(
        reviewSession.id
      );

    const erpWarehouseId =
      Number(
        reviewSession.erp_warehouse_id
      );

    console.log(
      "🏬 ERP WAREHOUSE ID DE LA SESIÓN:",
      erpWarehouseId
    );

    if (
      !Number.isInteger(erpWarehouseId) ||
      erpWarehouseId <= 0
    ) {

      await client.query(
        "ROLLBACK"
      );

      transactionStarted = false;

      return res.status(400).json({
        success: false,
        title:
          "ERROR DE ALMACEN",
        message:
          "La sesión no tiene un almacén ERP válido."
      });
    }


    console.log(
      "✅ SESIÓN REVIEW:",
      {

        sessionId,

        code:
          reviewSession.code,

        status:
          reviewSession.status

      }
    );



    // ============================================================
    // PRODUCTOS CONTADOS
    // ============================================================

    const countedProductsResult =
      await client.query(
        `
    WITH counted AS (
      SELECT
        ibl.product_sku,

        SUM(
          COALESCE(
            ibl.inventory_quantity,
            0
          )
        )::numeric
          AS total_inventory_qty

      FROM inventory_by_location ibl

      JOIN warehouses w
        ON w.id =
           ibl.warehouse_id

      WHERE
        w.erp_warehouse_id =
          $2

        AND ibl.counted_by
          IS NOT NULL

        AND ibl.counted_at
          IS NOT NULL

      GROUP BY
        ibl.product_sku
    ),

    prepared AS (
      SELECT
        p.erp_id::bigint AS erp_id,

        $1::bigint AS session_id,

        c.product_sku AS sku,

        p.erp_name,
        p.erp_sku,
        p.description,

        c.total_inventory_qty,

        COALESCE(
          eis.erp_stock,
          0
        )::numeric AS erp_stock,

        COALESCE(
          eis.unit_cost,
          0
        )::numeric AS unit_cost,

        CASE
          WHEN eis.item_id IS NULL
            THEN false
          ELSE true
        END AS exist_erp,

        false AS product_no_exist,

        true AS wms_counted

      FROM counted c

      JOIN products p
        ON p.sku =
           c.product_sku

      LEFT JOIN erp_inventory_snapshot eis
        ON eis.item_id =
           p.erp_id

       AND eis.session_inventory_id =
           $1

      WHERE
        p.erp_id IS NOT NULL
    )

    INSERT INTO inventory_erp_report (
      erp_id,
      session_id,
      sku,
      erp_name,
      erp_sku,
      description,
      total_inventory_qty,
      erp_stock,
      unit_cost,
      exist_erp,
      product_no_exist,
      wms_counted,
      updated_at
    )

    SELECT
      erp_id,
      session_id,
      sku,
      erp_name,
      erp_sku,
      description,
      total_inventory_qty,
      erp_stock,
      unit_cost,
      exist_erp,
      product_no_exist,
      wms_counted,
      NOW()

    FROM prepared

    ON CONFLICT (
      erp_id,
      session_id
    )

    DO UPDATE SET
      sku =
        EXCLUDED.sku,

      erp_name =
        EXCLUDED.erp_name,

      erp_sku =
        EXCLUDED.erp_sku,

      description =
        EXCLUDED.description,

      total_inventory_qty =
        EXCLUDED.total_inventory_qty,

      erp_stock =
        EXCLUDED.erp_stock,

      unit_cost =
        EXCLUDED.unit_cost,

      exist_erp =
        EXCLUDED.exist_erp,

      product_no_exist =
        EXCLUDED.product_no_exist,

      wms_counted =
        EXCLUDED.wms_counted,

      updated_at =
        NOW()

    RETURNING
      erp_id,
      session_id,
      sku AS product_sku,
      erp_name,
      erp_sku,
      description,
      total_inventory_qty,
      erp_stock,
      unit_cost,
      difference,
      status,
      exist_erp,
      product_no_exist,
      wms_counted
    `,
        [
          sessionId,
          erpWarehouseId
        ]
      );


    const countedProducts =
      countedProductsResult.rows;


    const wmsIds =
      countedProducts.map(
        (item) =>
          Number(
            item.erp_id
          )
      );


    console.log(
      "📦 TOTAL PRODUCTOS CONTADOS WMS:",
      countedProducts.length
    );


    console.log(
      "🆔 TOTAL ERP IDS EN WMS:",
      wmsIds.length
    );



    // ============================================================
    // PRODUCTOS ERP CON BALANCE NO CONTADOS
    // ============================================================

    /*   const productsMissingResult =
         await client.query(
           `
           WITH missing AS (
             SELECT
               eis.item_id::bigint AS erp_id,
               $1::bigint AS session_id,
               p.sku,
               p.erp_name,
               p.erp_sku,
               p.description,
               0::numeric AS total_inventory_qty,
               COALESCE(eis.erp_stock, 0)::numeric AS erp_stock,
               COALESCE(eis.unit_cost, 0)::numeric AS unit_cost,
               true AS exist_erp,
               CASE WHEN p.sku IS NULL THEN true ELSE false END AS product_no_exist
             FROM erp_inventory_snapshot eis
             LEFT JOIN LATERAL (
               SELECT sku, erp_name, erp_sku, description
               FROM products
               WHERE erp_id = eis.item_id
               LIMIT 1
             ) p ON true
             WHERE eis.session_inventory_id = $1
               AND COALESCE(eis.erp_stock, 0) > 0
               AND NOT (eis.item_id = ANY($2::bigint[]))
           )
           INSERT INTO inventory_erp_report (
             erp_id,
             session_id,
             sku,
             erp_name,
             erp_sku,
             description,
             total_inventory_qty,
             erp_stock,
             unit_cost,
             exist_erp,
             product_no_exist,
             updated_at
           )
           SELECT
             erp_id,
             session_id,
             sku,
             erp_name,
             erp_sku,
             description,
             total_inventory_qty,
             erp_stock,
             unit_cost,
             exist_erp,
             product_no_exist,
             NOW()
           FROM missing
           ON CONFLICT (erp_id, session_id)
           DO UPDATE SET
             sku = EXCLUDED.sku,
             erp_name = EXCLUDED.erp_name,
             erp_sku = EXCLUDED.erp_sku,
             description = EXCLUDED.description,
             total_inventory_qty = EXCLUDED.total_inventory_qty,
             erp_stock = EXCLUDED.erp_stock,
             unit_cost = EXCLUDED.unit_cost,
             exist_erp = EXCLUDED.exist_erp,
             product_no_exist = EXCLUDED.product_no_exist,
             updated_at = NOW()
           RETURNING
             erp_id AS item_id,
             session_id,
             erp_stock,
             unit_cost,
             sku,
             description,
             erp_name,
             erp_sku,
             product_no_exist,
             difference,
             status,
             exist_erp
           `,
           [
             sessionId,
             wmsIds
           ]
         );
   
   
       const productsMissing =
         productsMissingResult.rows;
   
   
       console.log(
         "🟥 TOTAL PRODUCTOS ERP CON BALANCE NO CONTADOS:",
         productsMissing.length
       );*/


    // ============================================================
    // HASTA AQUÍ ES EL CÓDIGO QUE YA TENÍAS
    // ============================================================




    // ============================================================
    // NUEVO
    // OBTENER TODAS LAS LÍNEAS DE inventory_erp_report
    // ============================================================

    console.log("");
    console.log(
      "🟨 OBTENIENDO PRODUCTOS PARA AJUSTE..."
    );


    const reportLinesResult =
      await client.query(
        `
        SELECT
          id,
          erp_id,
          session_id,
          sku,
          erp_name,
          erp_sku,
          description,
          total_inventory_qty,
          erp_stock,
          unit_cost,
          difference,
          status,
          exist_erp,
          product_no_exist,
          created_at,
          updated_at

        FROM inventory_erp_report

        WHERE session_id = $1
          AND wms_counted = true

        ORDER BY
          id ASC
        `,
        [
          sessionId
        ]
      );


    const reportLines =
      reportLinesResult.rows;


    console.log(
      "📦 TOTAL PRODUCTOS QUE IRÁN AL WORKER:",
      reportLines.length
    );


    if (
      reportLines.length === 0
    ) {

      await client.query(
        "ROLLBACK"
      );

      transactionStarted = false;


      return res
        .status(200)
        .json({

          success: false,

          message:
            "No existen productos para realizar el ajuste de inventario."

        });

    }





    // ============================================================
    // NUEVO
    // VERIFICAR SI YA EXISTE UN JOB
    // ============================================================
    //
    // Esto evita que el usuario presione el botón
    // dos veces y se creen 2,700 líneas duplicadas.
    // ============================================================

    const existingJobResult =
      await client.query(
        `
    SELECT
      id,
      job_type,
      status,
      total_products,
      processed_products,
      successful_products,
      failed_products,
      current_line_id,
      error_message

    FROM inventory_adjustment_jobs

    WHERE
      inventory_session_id = $1
      AND job_type = 'counted'

    ORDER BY
      id DESC

    LIMIT 1
    `,
        [
          sessionId
        ]
      );


    const existingJob =
      existingJobResult.rows[0];


    if (existingJob) {

      adjustmentJobId =
        Number(
          existingJob.id
        );


      console.log(
        "ℹ️ YA EXISTE JOB:",
        {
          jobId:
            adjustmentJobId,

          status:
            existingJob.status
        }
      );


      // Confirmamos cualquier actualización que
      // se haya hecho en inventory_erp_report.

      await client.query(
        "COMMIT"
      );


      committed = true;

      transactionStarted = false;


      // Si el job todavía puede ejecutarse,
      // llamamos al worker.
      //
      // El worker posteriormente tendrá su propia
      // protección para evitar ejecutarse dos veces.

      if (
        [
          "pending",
          "processing",
          "waiting_citrus"
        ].includes(
          existingJob.status
        )
      ) {

        startInventoryAdjustmentWorker(
          adjustmentJobId
        ).catch(
          (error) => {

            console.error(
              "🟥 ERROR WORKER:",
              error
            );

          }
        );

      }


      return res
        .status(200)
        .json({

          success: true,

          message:
            "Ya existe un proceso de ajuste para esta sesión.",

          data: {

            jobId:
              adjustmentJobId,

            status:
              existingJob.status,

            totalProducts:
              existingJob.total_products,

            processedProducts:
              existingJob.processed_products,

            successfulProducts:
              existingJob.successful_products,

            failedProducts:
              existingJob.failed_products,

            currentLineId:
              existingJob.current_line_id,

            errorMessage:
              existingJob.error_message

          }

        });

    }



    // ============================================================
    // NUEVO
    // CREAR JOB
    // ============================================================

    console.log("");
    console.log(
      "🟨 CREANDO INVENTORY ADJUSTMENT JOB"
    );


    const jobResult =
      await client.query(
        `
        INSERT INTO inventory_adjustment_jobs
(
  inventory_session_id,

  job_type,

  erp_warehouse_id,

  status,

  total_products,

  processed_products,

  successful_products,

  failed_products,

  current_line_id,

  error_message,

  email_sent,

  started_at,

  completed_at,

  created_at,

  updated_at
)

VALUES
(
  $1,

  'counted',

  $2,

  'pending',

  $3,

  0,

  0,

  0,

  NULL,

  NULL,

  false,

  NULL,

  NULL,

  NOW(),

  NOW()
)

RETURNING *
        `,
        [
          sessionId,

          erpWarehouseId,

          reportLines.length
        ]
      );


    const adjustmentJob =
      jobResult.rows[0];


    adjustmentJobId =
      Number(
        adjustmentJob.id
      );


    console.log(
      "✅ COUNTED JOB CREADO:",
      {
        jobId: adjustmentJobId,
        jobType: "counted",
        sessionId,
        totalProducts: reportLines.length
      }
    );



    // ============================================================
    // NUEVO
    // COPIAR TODOS LOS PRODUCTOS A
    // inventory_adjustment_job_lines
    // ============================================================
    //
    // NO HACEMOS:
    //
    // for (...) INSERT
    //
    // PostgreSQL copiará las ~2,700 líneas
    // directamente mediante INSERT ... SELECT.
    //
    // ============================================================

    console.log("");
    console.log(
      "📦 COPIANDO PRODUCTOS AL JOB..."
    );


    const insertJobLinesResult =
      await client.query(
        `
        INSERT INTO inventory_adjustment_job_lines
        (
          job_id,

          report_line_id,

          erp_product_id,

          erp_warehouse_id,

          desired_qty,

          citrus_qty_before,

          status,

          adjustment_attempts,

          verification_attempts,

          citrus_message,

          citrus_response,

          started_at,

          processed_at,

          next_retry_at,

          created_at,

          updated_at
        )


        SELECT

          $1::bigint,

          ier.id,

          ier.erp_id,

          $2::bigint,

          COALESCE(
            ier.total_inventory_qty,
            0
          )::numeric,

          COALESCE(
            ier.erp_stock,
            0
          )::numeric,

          'pending',

          0,

          0,

          NULL,

          NULL,

          NULL,

          NULL,

          NULL,

          NOW(),

          NOW()


        FROM
          inventory_erp_report ier


        WHERE
  ier.session_id = $3
  AND ier.wms_counted = true


        ORDER BY
          ier.id ASC


        RETURNING
          id,
          report_line_id,
          erp_product_id,
          desired_qty,
          citrus_qty_before,
          status
        `,
        [
          adjustmentJobId,

          erpWarehouseId,

          sessionId
        ]
      );


    const insertedLines =
      insertJobLinesResult.rows;


    console.log(
      "✅ TOTAL LÍNEAS CREADAS:",
      insertedLines.length
    );



    // ============================================================
    // VALIDACIÓN IMPORTANTE
    // ============================================================

    if (
      insertedLines.length !==
      reportLines.length
    ) {

      throw new Error(
        `Se esperaban ${reportLines.length} líneas ` +
        `pero solamente se insertaron ${insertedLines.length}.`
      );

    }



    // ============================================================
    // COMMIT
    // ============================================================
    //
    // El worker solamente empieza después de
    // confirmar que TODO quedó guardado.
    // ============================================================

    await client.query(
      "COMMIT"
    );


    committed = true;

    transactionStarted = false;


    console.log("");
    console.log(
      "✅ JOB Y LÍNEAS GUARDADOS CORRECTAMENTE"
    );



    // ============================================================
    // INICIAR WORKER
    // ============================================================
    //
    // IMPORTANTE:
    //
    // NO SE HACE:
    //
    // await startInventoryAdjustmentWorker()
    //
    // porque no queremos que la petición HTTP
    // espere los 2,700 productos.
    //
    // ============================================================

    console.log("");
    console.log(
      "🚀 INICIANDO INVENTORY ADJUSTMENT WORKER"
    );


    startInventoryAdjustmentWorker(
      adjustmentJobId
    )
      .catch(
        (error) => {

          console.error("");
          console.error(
            "🟥 ERROR NO CONTROLADO EN WORKER"
          );

          console.error(
            error
          );

        }
      );



    // ============================================================
    // RESPUESTA DEL CONTROLLER
    // ============================================================

    return res
      .status(200)
      .json({

        success: true,

        message:
          "El ajuste de productos contados fue iniciado correctamente.",

        data: {

          jobId:
            adjustmentJobId,

          sessionId,

          erpWarehouseId,

          totalProducts:
            insertedLines.length,

          status:
            "pending"

        }

      });


  } catch (error) {

    // ============================================================
    // ERROR
    // ============================================================

    if (
      transactionStarted &&
      !committed
    ) {

      try {

        await client.query(
          "ROLLBACK"
        );

      } catch (
      rollbackError
      ) {

        console.error(
          "🟥 ERROR HACIENDO ROLLBACK:",
          rollbackError
        );

      }

    }


    console.log("");
    console.log(
      "🟥🟥🟥 ========================================"
    );
    console.log(
      "❌ ERROR INICIANDO AJUSTE DE INVENTARIO"
    );
    console.log(
      "🟥🟥🟥 ========================================"
    );


    console.error(
      error
    );


    return res
      .status(500)
      .json({

        success: false,

        message:
          "ERROR INICIANDO EL AJUSTE DE INVENTARIO",

        error:
          error.message

      });


  } finally {

    client.release();

  }

}








export async function startInventoryAdjustmentZero(
  req,
  res
) {

  const client =
    await db.connect();

  let transactionStarted = false;

  let committed = false;

  let adjustmentJobId = null;


  try {

    console.log("");
    console.log(
      "🟥🟥🟥 ========================================"
    );
    console.log(
      "📦 INICIANDO PROCESO DE AJUSTE DE INVENTARIO"
    );
    console.log(
      "🟥🟥🟥 ========================================"
    );


    // ============================================================
    // NUEVO
    // OBTENER USER ID
    // ============================================================

    const userId =
      Number(
        req.user?.id ??
        req.body?.userId
      );


    console.log(
      "👤 USER ID:",
      userId
    );


    if (
      !Number.isInteger(userId) ||
      userId <= 0
    ) {

      return res.status(400).json({
        success: false,
        message:
          "Debe proporcionar un userId válido."
      });

    }


    // ============================================================
    // NUEVO
    // VALIDAR PERMISO DEL USUARIO
    // ============================================================

    /*
    🟥 PENDIENTE

    AQUÍ VAMOS A COLOCAR EL CÓDIGO
    QUE ME DARÁS PARA VALIDAR:

    ¿EL USUARIO TIENE PERMISO
    PARA AJUSTAR INVENTARIO?


    Ejemplo solamente:

    const canAdjustInventory =
      await validarPermisoAjusteInventario(
        userId
      );


    if (!canAdjustInventory) {

      return res.status(403).json({
        success: false,
        message:
          "No tiene permiso para ajustar inventario."
      });

    }

    */




    // ============================================================
    // DESDE AQUÍ:
    //
    // TU CÓDIGO ACTUAL
    //
    // NO SE CAMBIA
    // ============================================================


    console.log(
      "🟦🟦🟦 ================================"
    );

    console.log(
      "📄 INVENTORY REPORT"
    );

    console.log(
      "📌 GENERANDO REPORTE FINAL"
    );

    console.log(
      "🟦🟦🟦 ================================"
    );


    await client.query(
      "BEGIN"
    );

    transactionStarted = true;


    const sessionResult =
      await client.query(`
    SELECT
      id,
      code,
      status,
      user_id,
      erp_warehouse_id,
      start_date,
      end_date,
      created_at,
      updated_at
    FROM inventory_sessions
    WHERE status IN ('draft', 'in-progress', 'review')
    ORDER BY updated_at DESC
  `);


    if (
      sessionResult.rows.length === 0
    ) {

      await client.query(
        "ROLLBACK"
      );


      return res
        .status(200)
        .json({

          success: false,

          title:
            "No hay sesión de inventario",

          message:
            "No existe una sesión de inventario activa para generar el reporte final."

        });

    }


    const reviewSession =
      sessionResult.rows.find(

        (session) =>
          session.status === "review"

      );


    if (!reviewSession) {

      await client.query(
        "ROLLBACK"
      );


      return res
        .status(200)
        .json({

          success: false,

          title:
            "Sesión no está en revisión",

          message:
            "Para generar el reporte final, la sesión debe estar en estado review."

        });

    }


    const sessionId =
      Number(
        reviewSession.id
      );


    const erpWarehouseId =
      Number(
        reviewSession.erp_warehouse_id
      );


    console.log(
      "🏬 ERP WAREHOUSE ID DE LA SESIÓN:",
      erpWarehouseId
    );


    if (
      !Number.isInteger(erpWarehouseId) ||
      erpWarehouseId <= 0
    ) {

      await client.query(
        "ROLLBACK"
      );

      transactionStarted = false;

      return res.status(400).json({
        success: false,

        message:
          "La sesión no tiene un almacén ERP válido."
      });
    }


    console.log(
      "✅ SESIÓN REVIEW:",
      {

        sessionId,

        code:
          reviewSession.code,

        status:
          reviewSession.status

      }
    );



    // ============================================================
    // PRODUCTOS CONTADOS
    // ============================================================

    const countedProductsResult =
      await client.query(
        `
    WITH counted AS (
      SELECT
        ibl.product_sku,

        SUM(
          COALESCE(
            ibl.inventory_quantity,
            0
          )
        )::numeric
          AS total_inventory_qty

      FROM inventory_by_location ibl

      JOIN warehouses w
        ON w.id =
           ibl.warehouse_id

      WHERE
        w.erp_warehouse_id =
          $2

        AND ibl.counted_by
          IS NOT NULL

        AND ibl.counted_at
          IS NOT NULL

      GROUP BY
        ibl.product_sku
    ),

    prepared AS (
      SELECT
        p.erp_id::bigint AS erp_id,

        $1::bigint AS session_id,

        c.product_sku AS sku,

        p.erp_name,
        p.erp_sku,
        p.description,

        c.total_inventory_qty,

        COALESCE(
          eis.erp_stock,
          0
        )::numeric AS erp_stock,

        COALESCE(
          eis.unit_cost,
          0
        )::numeric AS unit_cost,

        CASE
          WHEN eis.item_id IS NULL
            THEN false
          ELSE true
        END AS exist_erp,

        false AS product_no_exist,

        true AS wms_counted

      FROM counted c

      JOIN products p
        ON p.sku =
           c.product_sku

      LEFT JOIN erp_inventory_snapshot eis
        ON eis.item_id =
           p.erp_id

       AND eis.session_inventory_id =
           $1

      WHERE
        p.erp_id IS NOT NULL
    )

    INSERT INTO inventory_erp_report (
      erp_id,
      session_id,
      sku,
      erp_name,
      erp_sku,
      description,
      total_inventory_qty,
      erp_stock,
      unit_cost,
      exist_erp,
      product_no_exist,
      wms_counted,
      updated_at
    )

    SELECT
      erp_id,
      session_id,
      sku,
      erp_name,
      erp_sku,
      description,
      total_inventory_qty,
      erp_stock,
      unit_cost,
      exist_erp,
      product_no_exist,
      wms_counted,
      NOW()

    FROM prepared

    ON CONFLICT (
      erp_id,
      session_id
    )

    DO UPDATE SET
      sku =
        EXCLUDED.sku,

      erp_name =
        EXCLUDED.erp_name,

      erp_sku =
        EXCLUDED.erp_sku,

      description =
        EXCLUDED.description,

      total_inventory_qty =
        EXCLUDED.total_inventory_qty,

      erp_stock =
        EXCLUDED.erp_stock,

      unit_cost =
        EXCLUDED.unit_cost,

      exist_erp =
        EXCLUDED.exist_erp,

      product_no_exist =
        EXCLUDED.product_no_exist,

      wms_counted =
        EXCLUDED.wms_counted,

      updated_at =
        NOW()

    RETURNING
      erp_id,
      session_id,
      sku AS product_sku,
      erp_name,
      erp_sku,
      description,
      total_inventory_qty,
      erp_stock,
      unit_cost,
      difference,
      status,
      exist_erp,
      product_no_exist,
      wms_counted
    `,
        [
          sessionId,
          erpWarehouseId
        ]
      );


    const countedProducts =
      countedProductsResult.rows;


    const wmsIds =
      countedProducts.map(
        (item) =>
          Number(
            item.erp_id
          )
      );


    console.log(
      "📦 TOTAL PRODUCTOS CONTADOS WMS:",
      countedProducts.length
    );


    console.log(
      "🆔 TOTAL ERP IDS EN WMS:",
      wmsIds.length
    );



    // ============================================================
    // PRODUCTOS ERP CON BALANCE NO CONTADOS
    // ============================================================

    const productsMissingResult =
      await client.query(
        `
           WITH missing AS (
    SELECT
        eis.item_id::bigint AS erp_id,
        $1::bigint AS session_id,
        p.sku,
        p.erp_name,
        p.erp_sku,
        p.description,

        0::numeric AS total_inventory_qty,

        COALESCE(
            eis.erp_stock,
            0
        )::numeric AS erp_stock,

        COALESCE(
            eis.unit_cost,
            0
        )::numeric AS unit_cost,

        true AS exist_erp,

        CASE
            WHEN p.sku IS NULL
            THEN true
            ELSE false
        END AS product_no_exist,

        false AS wms_counted

    FROM erp_inventory_snapshot eis

    LEFT JOIN LATERAL (
        SELECT
            sku,
            erp_name,
            erp_sku,
            description
        FROM products
        WHERE erp_id = eis.item_id
        LIMIT 1
    ) p ON true

    WHERE eis.session_inventory_id = $1

      AND COALESCE(
          eis.erp_stock,
          0
      ) <> 0

      AND NOT (
          eis.item_id =
          ANY($2::bigint[])
      )
)INSERT INTO inventory_erp_report (
    erp_id,
    session_id,
    sku,
    erp_name,
    erp_sku,
    description,
    total_inventory_qty,
    erp_stock,
    unit_cost,
    exist_erp,
    product_no_exist,
    wms_counted,
    updated_at
)
           SELECT
    erp_id,
    session_id,
    sku,
    erp_name,
    erp_sku,
    description,
    total_inventory_qty,
    erp_stock,
    unit_cost,
    exist_erp,
    product_no_exist,
    wms_counted,
    NOW()
FROM missing
           ON CONFLICT (erp_id, session_id)
           DO UPDATE SET
             sku = EXCLUDED.sku,
             erp_name = EXCLUDED.erp_name,
             erp_sku = EXCLUDED.erp_sku,
             description = EXCLUDED.description,
             total_inventory_qty = EXCLUDED.total_inventory_qty,
             erp_stock = EXCLUDED.erp_stock,
             unit_cost = EXCLUDED.unit_cost,
             exist_erp = EXCLUDED.exist_erp,
             wms_counted =
    EXCLUDED.wms_counted,
             product_no_exist = EXCLUDED.product_no_exist,
             updated_at = NOW()
           RETURNING
             erp_id AS item_id,
             session_id,
             erp_stock,
             unit_cost,
             sku,
             description,
             erp_name,
             erp_sku,
             product_no_exist,
             difference,
             status,
             exist_erp
           `,
        [
          sessionId,
          wmsIds
        ]
      );


    const productsMissing =
      productsMissingResult.rows;


    console.log(
      "🟥 TOTAL PRODUCTOS ERP CON BALANCE NO CONTADOS:",
      productsMissing.length
    );


    // ============================================================
    // HASTA AQUÍ ES EL CÓDIGO QUE YA TENÍAS
    // ============================================================




    // ============================================================
    // NUEVO
    // OBTENER TODAS LAS LÍNEAS DE inventory_erp_report
    // ============================================================

    console.log("");
    console.log(
      "🟨 OBTENIENDO PRODUCTOS PARA AJUSTE..."
    );


    const reportLinesResult =
      await client.query(
        `
        SELECT
          id,
          erp_id,
          session_id,
          sku,
          erp_name,
          erp_sku,
          description,
          total_inventory_qty,
          erp_stock,
          unit_cost,
          difference,
          status,
          exist_erp,
          product_no_exist,
          created_at,
          updated_at

        FROM inventory_erp_report

        WHERE session_id = $1
          AND wms_counted = false

        ORDER BY
          id ASC
        `,
        [
          sessionId
        ]
      );


    const reportLines =
      reportLinesResult.rows;


    console.log(
      "📦 TOTAL PRODUCTOS QUE IRÁN AL WORKER:",
      reportLines.length
    );


    if (
  reportLines.length === 0
) {

  console.log("");
  console.log(
    "ℹ️ NO HAY PRODUCTOS PARA AJUSTAR A CERO EN CITRUS"
  );

  console.log(
    "📦 SE ACTUALIZARÁN A CERO LAS LÍNEAS NO CONTADAS DEL WMS"
  );


  // ========================================================
  // ACTUALIZAR WMS LOCAL
  // ========================================================

  const wmsResult =
    await client.query(
      `
      UPDATE inventory_by_location ibl

      SET
        qty_on_hand = 0.000,

        qty_reserved = 0.000,

        updated_at = NOW()

      FROM warehouses w

      WHERE
  w.id = ibl.warehouse_id

  AND w.erp_warehouse_id = $1

  AND ibl.counted_by IS NULL

  AND ibl.counted_at IS NULL

  AND (
    COALESCE(
      ibl.qty_on_hand,
      0
    ) <> 0

    OR COALESCE(
      ibl.qty_reserved,
      0
    ) <> 0
  )

      RETURNING
        ibl.id,
        ibl.product_sku,
        ibl.location_id,
        ibl.qty_on_hand
      `,
      [
        erpWarehouseId
      ]
    );


  console.log(
    "✅ LÍNEAS WMS PUESTAS EN CERO:",
    wmsResult.rows.length
  );


  // ========================================================
  // COMMIT
  // ========================================================

  await client.query(
    "COMMIT"
  );

  committed = true;

  transactionStarted = false;


  return res
    .status(200)
    .json({

      success: true,

      title:
        "Inventario actualizado",

      message:
        "No había productos pendientes para ajustar a cero en Citrus. Las líneas no contadas del WMS fueron actualizadas correctamente.",

      data: {

        sessionId,

        erpWarehouseId,

        citrusAdjustmentRequired:
          false,

        citrusProducts:
          0,

        wmsLinesUpdated:
          wmsResult.rows.length

      }

    });

}






    // ============================================================
    // NUEVO
    // VERIFICAR SI YA EXISTE UN JOB
    // ============================================================
    //
    // Esto evita que el usuario presione el botón
    // dos veces y se creen 2,700 líneas duplicadas.
    // ============================================================

    const existingJobResult =
      await client.query(
        `
    SELECT
      id,
      job_type,
      status,
      total_products,
      processed_products,
      successful_products,
      failed_products,
      current_line_id,
      error_message

    FROM inventory_adjustment_jobs

    WHERE
      inventory_session_id = $1
      AND job_type = 'zero'

    LIMIT 1
    `,
        [sessionId]
      );


    const existingJob =
      existingJobResult.rows[0];


    if (existingJob) {

      adjustmentJobId =
        Number(
          existingJob.id
        );


      console.log(
        "ℹ️ YA EXISTE JOB:",
        {
          jobId:
            adjustmentJobId,

          status:
            existingJob.status
        }
      );


      // Confirmamos cualquier actualización que
      // se haya hecho en inventory_erp_report.

      await client.query(
        "COMMIT"
      );


      committed = true;

      transactionStarted = false;


      // Si el job todavía puede ejecutarse,
      // llamamos al worker.
      //
      // El worker posteriormente tendrá su propia
      // protección para evitar ejecutarse dos veces.

      if (
        [
          "pending",
          "processing",
          "waiting_citrus"
        ].includes(
          existingJob.status
        )
      ) {

        startInventoryAdjustmentWorker(
          adjustmentJobId
        ).catch(
          (error) => {

            console.error(
              "🟥 ERROR WORKER:",
              error
            );

          }
        );

      }


      return res
        .status(200)
        .json({

          success: true,

          message:
            "Ya existe un proceso de ajuste para esta sesión.",

          data: {

            jobId:
              adjustmentJobId,

            status:
              existingJob.status,

            totalProducts:
              existingJob.total_products,

            processedProducts:
              existingJob.processed_products,

            successfulProducts:
              existingJob.successful_products,

            failedProducts:
              existingJob.failed_products,

            currentLineId:
              existingJob.current_line_id,

            errorMessage:
              existingJob.error_message

          }

        });

    }



    // ============================================================
    // NUEVO
    // CREAR JOB
    // ============================================================

    console.log("");
    console.log(
      "🟨 CREANDO INVENTORY ADJUSTMENT JOB"
    );


    const jobResult =
      await client.query(
        `
        INSERT INTO inventory_adjustment_jobs
(
    inventory_session_id,

    job_type,

    erp_warehouse_id,

    status,

    total_products,

    processed_products,

    successful_products,

    failed_products,

    current_line_id,

    error_message,

    email_sent,

    started_at,

    completed_at,

    created_at,

    updated_at
)

VALUES
(
    $1,

    'zero',

    $2,

    'pending',

    $3,

    0,

    0,

    0,

    NULL,

    NULL,

    false,

    NULL,

    NULL,

    NOW(),

    NOW()
)

RETURNING *
        `,
        [
          sessionId,

          erpWarehouseId,

          reportLines.length
        ]
      );


    const adjustmentJob =
      jobResult.rows[0];


    adjustmentJobId =
      Number(
        adjustmentJob.id
      );


    console.log(
      "✅ JOB CREADO:",
      {
        jobId:
          adjustmentJobId,

        sessionId,

        totalProducts:
          reportLines.length
      }
    );



    // ============================================================
    // NUEVO
    // COPIAR TODOS LOS PRODUCTOS A
    // inventory_adjustment_job_lines
    // ============================================================
    //
    // NO HACEMOS:
    //
    // for (...) INSERT
    //
    // PostgreSQL copiará las ~2,700 líneas
    // directamente mediante INSERT ... SELECT.
    //
    // ============================================================

    console.log("");
    console.log(
      "📦 COPIANDO PRODUCTOS AL JOB..."
    );


    const insertJobLinesResult =
      await client.query(
        `
        INSERT INTO inventory_adjustment_job_lines
        (
          job_id,

          report_line_id,

          erp_product_id,

          erp_warehouse_id,

          desired_qty,

          citrus_qty_before,

          status,

          adjustment_attempts,

          verification_attempts,

          citrus_message,

          citrus_response,

          started_at,

          processed_at,

          next_retry_at,

          created_at,

          updated_at
        )


        SELECT

          $1::bigint,

          ier.id,

          ier.erp_id,

          $2::bigint,

          COALESCE(
            ier.total_inventory_qty,
            0
          )::numeric,

          COALESCE(
            ier.erp_stock,
            0
          )::numeric,

          'pending',

          0,

          0,

          NULL,

          NULL,

          NULL,

          NULL,

          NULL,

          NOW(),

          NOW()


        FROM
          inventory_erp_report ier


        WHERE
  ier.session_id = $3
  AND ier.wms_counted = false


        ORDER BY
          ier.id ASC


        RETURNING
          id,
          report_line_id,
          erp_product_id,
          desired_qty,
          citrus_qty_before,
          status
        `,
        [
          adjustmentJobId,

          erpWarehouseId,

          sessionId
        ]
      );


    const insertedLines =
      insertJobLinesResult.rows;


    console.log(
      "✅ TOTAL LÍNEAS CREADAS:",
      insertedLines.length
    );



    // ============================================================
    // VALIDACIÓN IMPORTANTE
    // ============================================================

    if (
      insertedLines.length !==
      reportLines.length
    ) {

      throw new Error(
        `Se esperaban ${reportLines.length} líneas ` +
        `pero solamente se insertaron ${insertedLines.length}.`
      );

    }



    // ============================================================
    // COMMIT
    // ============================================================
    //
    // El worker solamente empieza después de
    // confirmar que TODO quedó guardado.
    // ============================================================

    await client.query(
      "COMMIT"
    );


    committed = true;

    transactionStarted = false;


    console.log("");
    console.log(
      "✅ JOB Y LÍNEAS GUARDADOS CORRECTAMENTE"
    );



    // ============================================================
    // INICIAR WORKER
    // ============================================================
    //
    // IMPORTANTE:
    //
    // NO SE HACE:
    //
    // await startInventoryAdjustmentWorker()
    //
    // porque no queremos que la petición HTTP
    // espere los 2,700 productos.
    //
    // ============================================================

    console.log("");
    console.log(
      "🚀 INICIANDO INVENTORY ADJUSTMENT WORKER"
    );


    startInventoryAdjustmentWorker(
      adjustmentJobId
    )
      .catch(
        (error) => {

          console.error("");
          console.error(
            "🟥 ERROR NO CONTROLADO EN WORKER"
          );

          console.error(
            error
          );

        }
      );



    // ============================================================
    // RESPUESTA DEL CONTROLLER
    // ============================================================

    return res
      .status(200)
      .json({

        success: true,

        message:
          "El proceso de ajuste de inventario fue iniciado correctamente.",

        data: {

          jobId:
            adjustmentJobId,

          sessionId,

          erpWarehouseId,

          totalProducts:
            insertedLines.length,

          status:
            "pending"

        }

      });


  } catch (error) {

    // ============================================================
    // ERROR
    // ============================================================

    if (
      transactionStarted &&
      !committed
    ) {

      try {

        await client.query(
          "ROLLBACK"
        );

      } catch (
      rollbackError
      ) {

        console.error(
          "🟥 ERROR HACIENDO ROLLBACK:",
          rollbackError
        );

      }

    }


    console.log("");
    console.log(
      "🟥🟥🟥 ========================================"
    );
    console.log(
      "❌ ERROR INICIANDO AJUSTE DE INVENTARIO"
    );
    console.log(
      "🟥🟥🟥 ========================================"
    );


    console.error(
      error
    );


    return res
      .status(500)
      .json({

        success: false,

        message:
          "ERROR INICIANDO EL AJUSTE DE INVENTARIO",

        error:
          error.message

      });


  } finally {

    client.release();

  }

}










export async function inventoryScan(req, res) {
  try {
    const { productScanned, locationScanned } = req.body;

    console.log("1️⃣  UBICACION: ", locationScanned);
    console.log("2️⃣  PRODUCT: ", productScanned);

    // 1️⃣ Si NO hay nada
    if (!productScanned && !locationScanned) {
      console.log("❌ Debe escanear una ubicación o un producto.");
      return res.json({
        success: false,
        title: "Escaneo requerido",
        message: "Debe escanear una ubicación o un producto."
      });
    }

    // ==============================
    // VALIDAR ESTADO DE LA SESIÓN
    // ==============================

    const result = await getInventorySessionStatusService();

    //console.log("📦 Resultado sesión:", result);

    if (!result.success) {
      console.log("❌ No se pudo obtener el estado de la sesión.");

      return res.json({
        success: false,
        title: "Error de sesión",
        message: "No se pudo obtener el estado actual de la sesión de inventario."
      });
    }

    /*console.log(
      "📦 Sesión activa:",
      result.hasActiveSession,
      "| Estado:",
      result.session?.status ?? "Sin sesión"
    );*/

    // No existe una sesión activa
    if (!result.hasActiveSession || !result.session) {
      console.log("❌ No existe una sesión de inventario activa.");

      return res.json({
        success: false,
        title: "No hay una sesión activa",
        message: "Debe crear e iniciar una sesión de inventario antes de realizar conteos."
      });
    }

    // Existe la sesión pero NO está iniciada
    if (result.session.status !== "in-progress") {
      console.log(
        `❌ La sesión ${result.session.code} se encuentra en estado '${result.session.status}'.`
      );

      return res.json({
        success: false,
        title: "Sesión no iniciada",
        message:
          "La sesión de inventario aún no ha sido iniciada. Inicie la sesión antes de comenzar a contar productos."
      });
    }

    console.log(
      `✅ Sesión ${result.session.code} en estado '${result.session.status}'. Puede continuar.`
    );


    // SOLO ubicación
    if (
      (locationScanned && !productScanned) ||
      (locationScanned === productScanned)
    ) {

      const location = await db.query(`
        SELECT id, code
        FROM locations
        WHERE code = $1
          AND is_active = true
        LIMIT 1
    `, [locationScanned]);

      if (location.rows.length === 0) {
        console.log("❌ La ubicación escaneada no existe o no está activa.");
        return res.json({
          success: false,
          title: "Ubicación inválida",
          message: "La ubicación escaneada no existe o no está activa."
        });
      }

      console.log("✅✅ UBICACION confirmada: ", location.rows[0])

      return res.json({
        success: true,
        type: "location",
        data: location.rows[0]
      });
    }


    // NO se encontró producto pero podría ser ubicación
    if (!locationScanned && productScanned) {

      const location = await db.query(`
        SELECT id, code
        FROM locations
        WHERE code = $1
          AND is_active = true
        LIMIT 1
    `, [productScanned]);

      if (location.rows.length === 0) {
        console.log("❌ Tiene que leer una ubicacion valida primero.");
        return res.json({
          success: false,
          title: "Ubicación inválida",
          message: "Tiene que leer una ubicacion valida primero."
        });
      }

      console.log("✅✅ UBICACION confirmada: ", location.rows[0])

      return res.json({
        success: true,
        type: "location",
        data: location.rows[0]
      });
    }




    // 3️⃣ Si viene producto SIN ubicación → ERROR
    if (productScanned && !locationScanned) {
      console.log("❌ Debe escanear una ubicación antes de escanear un producto.");
      return res.json({
        success: false,
        title: "Falta ubicación",
        message: "Debe escanear una ubicación antes de escanear un producto."
      });
    }

    // 4️⃣ Validar ubicación
    const location = await db.query(`
      SELECT id, code
      FROM locations
      WHERE code = $1
        AND is_active = true
      LIMIT 1
    `, [locationScanned]);

    if (location.rows.length === 0) {
      console.log("❌ La ubicación escaneada no existe o no está activa.");
      return res.json({
        success: false,
        title: "Ubicación inválida",
        message: "La ubicación escaneada no existe o no está activa."
      });
    }

    const locationId = location.rows[0].id;

    console.log("✅✅ UBICACION confirmada: ", locationId);
    console.log("🟨 Buscando PRODUCTO escaneado : ", productScanned);
    // 5️⃣ Buscar producto
    const productResult = await db.query(`
  SELECT 
    p.id,
    p.erp_id,
    p.sku,
    p.description,
    P.erp_name,
    p.erp_id,
    p.erp_sku
  FROM products p
  LEFT JOIN product_barcodes bp 
    ON p.sku = bp.product_sku
  WHERE 
        bp.product_sku = $1
     OR bp.barcode = $1
     OR p.sku = $1
     OR p.erp_sku = $1
  LIMIT 1
`, [productScanned]);

    if (productResult.rows.length === 0) {
      console.log("❌ El código escaneado no corresponde a ningún producto.");
      return res.json({
        success: false,
        title: "Producto no encontrado",
        message: "El código escaneado no corresponde a ningún producto."
      });
    }

    const product = productResult.rows[0];
    console.log("✅✅ PRODUCTO confirmada: ", product);

    // 6️⃣ Buscar inventario en esa ubicación
    let qty = 0;
    console.log("🟨 Buscando inventario de esta ubicacion: ", locationId, "y este producto: ", product.sku);
    const inventoryResult = await db.query(`
      SELECT inventory_quantity
      FROM inventory_by_location
      WHERE product_sku = $1
        AND location_id = $2
      LIMIT 1
    `, [product.sku, locationId]);

    if (inventoryResult.rows.length > 0) {
      const inventoryQty = Number(inventoryResult.rows[0].inventory_quantity);
      console.log("✅✅ INVENTARIO confirmada: ", inventoryResult.rows[0]);
      if (inventoryQty > 0) {
        qty = inventoryQty;
      }
    }

    // 7️⃣ Respuesta final
    return res.json({
      success: true,
      type: "product",
      data: product,
      location: location.rows[0], // 👈 opcional pero útil
      qty
    });

  } catch (error) {
    console.error("❌ Error en inventoryScan:", error);
    return res.status(500).json({
      success: false,
      title: "ERROR",
      message: "Error interno"
    });
  }
}




export async function applyInventoryCount(req, res) {
  const client = await db.connect();

  try {
    const { locationSelected, productSelected, qty } = req.body;
    const userId = req.user?.id ?? 1; //🟥🟥 quitar en produccion #QUITARPRODUCCION

    await client.query("BEGIN");

    const result = await saveInventoryByCount(client, {
      locationSelected,
      productSelected,
      qty,
      userId,
      referenceId: null,
      note: "Ajuste por conteo físico"
    });

    if (!result.success) {
      await client.query("ROLLBACK");
      return res.json(result);
    }

    const summary = await emitInventorySummary(client);
    console.log("Resumen 🟥🟩🟨🟪", summary);

    await client.query("COMMIT");
    return res.json(result);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("❌ Error applyInventoryCount:", error);

    return res.status(500).json({
      success: false,
      title: "No se pudo guardar conteo",
      message: "Ocurrió un error interno."
    });
  } finally {
    client.release();
  }
}




export async function getInventoryLiveSummary(req, res) {
  const client = await db.connect();

  try {
    const summary = await emitInventorySummary(client);

    console.log("Resumen 🟥🟩🟨🟪", summary);

    return res.json(summary);

  } catch (error) {
    console.error("❌ Error getInventoryLiveSummary:", error);

    return res.status(500).json({
      success: false,
      title: "No se pudo obtener el resumen",
      message: "Ocurrió un error interno."
    });

  } finally {
    client.release();
  }
}





// Obtiene el estado actual del monitor de inventario para determinar si existe una sesión activa y la configuración de ajuste.
export async function getInventorySessionStatus(req, res) {
  try {
    const userId = Number(req.user?.id);

    console.log("🟦🟦🟦 ================================");
    console.log("🟨 INVENTORY MONITOR getInventorySessionStatus");
    console.log("🔍 CONSULTANDO ESTADO DE SESIÓN");

    console.log("👤 Usuario:", userId);

    if (!userId) {
      console.log("❌ Usuario no autenticado");

      return res.status(200).json({
        success: false,
        title: "Usuario no encontrado",
        message: "No se pudo identificar el usuario autenticado."
      });
    }

    const result = await getInventorySessionStatusService();

    console.log(
      "📦 Resultado:",
      `Session=${result}`,
      `Mode=${result.adjustmentMode}`
    );

    if (result.hasActiveSession) {
      console.log(
        "🟢 Sesión activa:",
        result.session.code,
        `(${result.session.status})`
      );
    } else {
      console.log("🟥 No existe sesión activa");
    }
    console.log("================================ 🟦🟦🟦");
    return res.status(200).json(result);

  } catch (error) {

    console.error(
      "❌ Error en getInventorySessionStatus:",
      error
    );

    return res.status(200).json({
      success: false,
      title: "Error al consultar inventario",
      message: "Ocurrió un error buscando el estado de la sesión de inventario."
    });
  }
}






// Cambia la configuración de ajuste de inventario validando que no exista una sesión activa.
export async function updateInventoryAdjustmentMode(req, res) {
  const client = await db.connect();

  try {
    console.log("🟦🟦🟦 ================================");
    console.log("🟨 INVENTORY MONITOR");
    console.log("⚙️ CAMBIANDO MODO DE AJUSTE");

    const { adjustmentMode } = req.body;

    console.log("📥 MODO RECIBIDO:", adjustmentMode);

    // =====================================
    // VALIDAR MODO
    // =====================================

    if (
      adjustmentMode !== "final" &&
      adjustmentMode !== "immediate"
    ) {
      console.log("❌ MODO INVÁLIDO");

      return res.status(200).json({
        success: false,
        title: "Modo inválido",
        message: "El modo de ajuste debe ser final o immediate."
      });
    }

    console.log("✅ MODO VÁLIDO");

    // =====================================
    // VALIDAR SESIÓN ACTIVA
    // =====================================

    console.log("🔍 BUSCANDO SESIÓN ACTIVA...");

    const sessionResult = await client.query(`
      SELECT id, code, status
      FROM inventory_sessions
      WHERE status IN ('draft', 'in-progress')
      LIMIT 1
    `);

    console.log("📊 SESIONES ENCONTRADAS:", sessionResult.rowCount);

    if (sessionResult.rowCount > 0) {
      const session = sessionResult.rows[0];

      console.log(
        "⛔ SESIÓN ACTIVA:",
        session.code,
        "| STATUS:",
        session.status
      );

      return res.status(200).json({
        success: false,
        title: "Inventario activo",
        message:
          "No se puede cambiar el modo de ajuste mientras exista una sesión de inventario activa."
      });
    }

    console.log("✅ NO HAY SESIONES ACTIVAS");

    // =====================================
    // BUSCAR EMPRESA ACTIVA
    // =====================================

    console.log("🏢 BUSCANDO EMPRESA ACTIVA...");

    const companyResult = await client.query(`
      SELECT
        id,
        inventory_adjustment_mode
      FROM companies
      WHERE is_active = true
      ORDER BY created_at ASC
      LIMIT 1
    `);

    console.log("📊 EMPRESAS ENCONTRADAS:", companyResult.rowCount);

    if (companyResult.rowCount === 0) {
      console.log("❌ NO EXISTE EMPRESA ACTIVA");

      return res.status(200).json({
        success: false,
        title: "Empresa no encontrada",
        message: "No existe una empresa activa configurada."
      });
    }

    const company = companyResult.rows[0];

    console.log(
      "🏢 EMPRESA:",
      company.id
    );

    console.log(
      "⬅️ MODO ACTUAL:",
      company.inventory_adjustment_mode
    );

    // =====================================
    // ACTUALIZAR CONFIGURACIÓN
    // =====================================

    console.log(
      "➡️ ACTUALIZANDO MODO A:",
      adjustmentMode
    );

    await client.query(
      `
      UPDATE companies
      SET inventory_adjustment_mode = $1
      WHERE id = $2
      `,
      [adjustmentMode, company.id]
    );

    console.log("✅ CONFIGURACIÓN ACTUALIZADA");

    console.log("🟩 FIN INVENTORY MONITOR");
    console.log("================================ 🟦🟦🟦 ");

    return res.status(200).json({
      success: true,
      title: "Configuración actualizada",
      message:
        "El modo de ajuste de inventario fue actualizado correctamente.",
      adjustmentMode
    });

  } catch (error) {

    console.log("🟥 ERROR INVENTORY MONITOR");
    console.error(error);

    return res.status(200).json({
      success: false,
      title: "Error de configuración",
      message:
        "Ocurrió un error actualizando el modo de inventario."
    });

  } finally {
    client.release();
  }
}


//🟨🟨 funcion para iniciar la sincronizacion de buscar todas las existencias del erp y llevarnos a la base de datos del wms y tener snapshot de la existencias antes del almacen.
let syncExistenciaRunning = false;

async function runSyncExistenciaAlmacenOnce(client, sessionId) {

  if (!client) {
    return {
      success: false,
      message: "client es requerido para sincronizar existencia.",
    };
  }
  if (!sessionId) {
    return {
      success: false,
      skipped: false,
      message: "sessionId es requerido para sincronizar existencia.",
    };
  }

  if (syncExistenciaRunning) {
    console.log("⏳ Sync existencia almacén ya está corriendo, se omite esta ejecución");

    return {
      success: true,
      skipped: true,
      message: "La sincronización ya estaba corriendo.",
    };
  }

  syncExistenciaRunning = true;

  try {
    console.log("====================================");
    console.log("⏱️ SYNC EXISTENCIA ALMACÉN INICIADO");
    console.log("🆔 SESSION ID:", sessionId);
    console.log("====================================");

    const data = await buscarTodasLasExistenciasAlmacen(client, sessionId);

    console.log("✅ SYNC EXISTENCIA ALMACÉN FINALIZADO");

    return {
      success: true,
      skipped: false,
      data,
    };

  } catch (error) {
    console.error("🔥 ERROR SYNC EXISTENCIA ALMACÉN:");
    console.error(error);

    return {
      success: false,
      skipped: false,
      message: error.message || "Error sincronizando existencia almacén",
    };

  } finally {
    syncExistenciaRunning = false;
  }
}



// Crea una nueva sesión de inventario validando que no exista otra activa.
export async function createInventorySession(req, res) {
  const client = await db.connect();

  try {

    console.log("🟦🟦🟦 ================================");
    console.log("🟨 INVENTORY MONITOR");
    console.log("🆕 CREANDO NUEVA SESIÓN");



    //const userId = 2;
    const userId = Number(req.user?.id);

    console.log("👤 USER ID:", userId);

    if (!userId) {
      console.log("❌ USER ID INVÁLIDO");

      return res.status(200).json({
        success: false,
        title: "Usuario no encontrado",
        message: "No se pudo identificar el usuario autenticado."
      });
    }

    const erpWarehouseId = Number(req.body?.erpWarehouseId);

    console.log("🏬 ERP WAREHOUSE ID:", erpWarehouseId);

    if (!erpWarehouseId) {
      return res.status(200).json({
        success: false,
        title: "Almacén inválido",
        message:
          "No se recibió un almacén válido para crear la sesión de inventario."
      });
    }

    await client.query("BEGIN");

    // =====================================
    // VALIDAR SESIÓN ACTIVA
    // =====================================

    console.log("🔍 BUSCANDO SESIONES ACTIVAS");

    const activeSessionResult = await client.query(`
      SELECT
        id,
        code,
        status
      FROM inventory_sessions
      WHERE status IN ('draft', 'in-progress', 'review')
      LIMIT 1
    `);

    if (activeSessionResult.rowCount > 0) {

      const activeSession = activeSessionResult.rows[0];

      console.log(
        "⛔ SESIÓN ACTIVA:",
        activeSession.code
      );



      await client.query("ROLLBACK");

      return res.status(200).json({
        success: false,
        title: "Sesión activa encontrada",
        message:
          `Ya existe una sesión de inventario activa: ${activeSession.code}.`
      });
    }

    console.log("✅ NO HAY SESIONES ACTIVAS");

    // =====================================
    // OBTENER CONFIGURACIÓN
    // =====================================

    console.log("🏢 BUSCANDO EMPRESA ACTIVA");

    const companyResult = await client.query(`
      SELECT
        inventory_adjustment_mode
      FROM companies
      WHERE is_active = true
      ORDER BY created_at ASC
      LIMIT 1
    `);

    if (companyResult.rowCount === 0) {

      await client.query("ROLLBACK");

      return res.status(200).json({
        success: false,
        title: "Empresa no encontrada",
        message: "No existe una empresa activa configurada."
      });
    }

    const adjustmentMode =
      companyResult.rows[0].inventory_adjustment_mode;

    console.log(
      "⚙️ INVENTORY MODE:",
      adjustmentMode
    );

    if (
      adjustmentMode !== "final" &&
      adjustmentMode !== "immediate"
    ) {

      await client.query("ROLLBACK");

      return res.status(200).json({
        success: false,
        title: "Configuración inválida",
        message:
          "El modo de ajuste de inventario no está configurado correctamente."
      });
    }

    // =====================================
    // CREAR SESIÓN
    // =====================================

    console.log("📝 CREANDO SESIÓN");

    const sessionResult = await client.query(
      `
  INSERT INTO inventory_sessions
  (
    user_id,
    erp_warehouse_id
  )
  VALUES
  (
    $1,
    $2
  )
  RETURNING *
  `,
      [
        userId,
        erpWarehouseId
      ]
    );

    const session = sessionResult.rows[0];

    console.log(
      "✅ SESIÓN CREADA:",
      session.code,
      "| ERP WAREHOUSE ID:",
      session.erp_warehouse_id
    );



    // =====================================
    // OBTENER NOMBRE USUARIO
    // =====================================

    const userResult = await client.query(
      `
      SELECT
        id,
        full_name
      FROM users
      WHERE id = $1
      `,
      [userId]
    );

    const user =
      userResult.rowCount > 0
        ? userResult.rows[0]
        : null;

    // =====================================
    // SINCRONIZAR EXISTENCIA CON SESSION ID
    // =====================================

    const syncResult = await runSyncExistenciaAlmacenOnce(client, session.id);

    if (!syncResult.success) {
      await client.query("ROLLBACK");

      return res.status(200).json({
        success: false,
        title: "Error sincronizando inventario",
        message:
          syncResult.message ||
          "No se pudo sincronizar la existencia del almacén.",
      });
    }



    await client.query("COMMIT");

    console.log("🟩 SESIÓN CREADA CORRECTAMENTE");
    console.log("🟦🟦🟦 ================================");





    return res.status(200).json({
      success: true,
      title: "SESSION_CREATED",
      message: "Sesión de inventario creada correctamente.",

      hasActiveSession: true,

      adjustmentMode,

      session: {
        id: session.id,
        code: session.code,
        user_id: session.user_id,
        full_name: user?.full_name || "",
        status: session.status,
        start_date: session.start_date,
        end_date: session.end_date,
        created_at: session.created_at,
        updated_at: session.updated_at
      }
    });

  } catch (error) {

    await client.query("ROLLBACK");

    console.log("🟥 ERROR CREANDO SESIÓN");
    console.error(error);

    return res.status(200).json({
      success: false,
      title: "Error creando sesión",
      message:
        "Ocurrió un error al crear la sesión de inventario."
    });

  } finally {
    client.release();
  }
}







// Inicia una sesión de inventario creada previamente en estado draft.
export async function startInventorySession(req, res) {
  const client = await db.connect();

  try {

    console.log("🟦🟦🟦 ================================");
    console.log("🟨 INVENTORY MONITOR");
    console.log("▶️ INICIANDO SESIÓN DE INVENTARIO");

    //const id = 2;
    const { id } = req.body;

    console.log("📥 SESSION ID:", id);

    if (!id) {
      console.log("❌ ID NO RECIBIDO");

      return res.status(200).json({
        success: false,
        title: "ID requerido",
        message: "Debe enviar el ID de la sesión."
      });
    }

    await client.query("BEGIN");

    // =====================================
    // BUSCAR SESIÓN
    // =====================================

    console.log("🔍 BUSCANDO SESIÓN");

    const sessionResult = await client.query(
      `
      SELECT
        id,
        code,
        user_id,
        status
      FROM inventory_sessions
      WHERE id = $1
      AND status NOT IN ('review', 'posted', 'cancelled')
      FOR UPDATE
      `,
      [id]
    );

    if (sessionResult.rowCount === 0) {

      console.log("❌ SESIÓN NO ENCONTRADA");

      await client.query("ROLLBACK");

      return res.status(200).json({
        success: false,
        title: "Sesión no encontrada",
        message: "La sesión no existe o no puede ser iniciada."
      });
    }

    const session = sessionResult.rows[0];

    console.log(
      "📋 SESSION:",
      session.code,
      "| STATUS:",
      session.status
    );

    // =====================================
    // VALIDAR YA INICIADA
    // =====================================

    if (session.status === "in-progress") {

      console.log("⚠️ SESIÓN YA INICIADA");

      await client.query("ROLLBACK");

      return res.status(200).json({
        success: false,
        title: "Sesión ya iniciada",
        message: "La sesión ya se encuentra en progreso."
      });
    }

    // =====================================
    // VALIDAR QUE SOLO SE INICIE DESDE DRAFT
    // =====================================

    if (session.status !== "draft") {

      console.log(
        "❌ ESTADO INVÁLIDO:",
        session.status
      );

      await client.query("ROLLBACK");

      return res.status(200).json({
        success: false,
        title: "Estado inválido",
        message:
          "Solo las sesiones en estado draft pueden iniciarse."
      });
    }

    // =====================================
    // VALIDAR OTRA SESIÓN EN PROGRESO
    // =====================================

    console.log("🔍 VALIDANDO OTRAS SESIONES EN PROGRESO");

    const otherSessionResult = await client.query(
      `
      SELECT
          id,
          code
      FROM inventory_sessions
      WHERE status = 'in-progress'
      AND id <> $1
      LIMIT 1
      `,
      [id]
    );

    if (otherSessionResult.rowCount > 0) {

      const otherSession = otherSessionResult.rows[0];

      console.log(
        "⛔ OTRA SESIÓN EN PROGRESO:",
        otherSession.code
      );

      await client.query("ROLLBACK");

      return res.status(200).json({
        success: false,
        title: "Inventario activo",
        message:
          `Ya existe una sesión en progreso (${otherSession.code}).`
      });
    }

    console.log("✅ NO HAY OTRAS SESIONES EN PROGRESO");

    // =====================================
    // OBTENER CONFIGURACIÓN
    // =====================================

    console.log("🏢 OBTENIENDO CONFIGURACIÓN");

    const companyResult = await client.query(`
      SELECT
        inventory_adjustment_mode
      FROM companies
      WHERE is_active = true
      ORDER BY created_at ASC
      LIMIT 1
    `);

    if (companyResult.rowCount === 0) {

      console.log("❌ EMPRESA ACTIVA NO ENCONTRADA");

      await client.query("ROLLBACK");

      return res.status(200).json({
        success: false,
        title: "Empresa no encontrada",
        message: "No existe una empresa activa configurada."
      });
    }

    const adjustmentMode =
      companyResult.rows[0].inventory_adjustment_mode || "final";

    console.log(
      "⚙️ MODO INVENTARIO:",
      adjustmentMode
    );

    // =====================================
    // ACTUALIZAR SESIÓN
    // =====================================

    console.log("✏️ ACTUALIZANDO SESIÓN");

    const updateResult = await client.query(
      `
      UPDATE inventory_sessions
      SET
          status = 'in-progress',
          start_date = NOW(),
          updated_at = NOW()
      WHERE id = $1
      RETURNING
          id,
          code,
          user_id,
          status,
          start_date,
          end_date,
          created_at,
          updated_at
      `,
      [id]
    );

    const updatedSession = updateResult.rows[0];

    // =====================================
    // OBTENER NOMBRE USUARIO
    // =====================================

    const userResult = await client.query(
      `
      SELECT
          full_name
      FROM users
      WHERE id = $1
      `,
      [updatedSession.user_id]
    );

    const fullName =
      userResult.rowCount > 0
        ? userResult.rows[0].full_name
        : "";

    await client.query("COMMIT");

    console.log(
      "✅ SESIÓN INICIADA:",
      updatedSession.code
    );

    console.log("🟩 SESSION STARTED");
    console.log("🟦🟦🟦 ================================");

    return res.status(200).json({
      success: true,
      title: "SESSION_STARTED",
      message:
        "La sesión de inventario fue iniciada correctamente.",

      hasActiveSession: true,

      adjustmentMode,

      session: {
        id: updatedSession.id,
        code: updatedSession.code,
        user_id: updatedSession.user_id,
        full_name: fullName,
        status: updatedSession.status,
        start_date: updatedSession.start_date,
        end_date: updatedSession.end_date,
        created_at: updatedSession.created_at,
        updated_at: updatedSession.updated_at
      }
    });

  } catch (error) {

    await client.query("ROLLBACK");

    console.log("🟥 ERROR INICIANDO SESIÓN");
    console.error(error);

    return res.status(200).json({
      success: false,
      title: "Error iniciando sesión",
      message:
        "Ocurrió un error al iniciar la sesión de inventario."
    });

  } finally {
    client.release();
  }
}





// ============================================================
// REANUDAR CONTEO DE INVENTARIO
// REVIEW → IN-PROGRESS
// ============================================================

export async function resumeInventorySession(
  req,
  res
) {

  const client =
    await db.connect();

  try {

    console.log("");
    console.log(
      "🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦========================================"
    );

    console.log(
      "🔄 REANUDANDO SESIÓN DE INVENTARIO"
    );

    console.log(
      "🟦🟦🟦 ========================================"
    );


    const {
      id
    } = req.body;


    // ==========================================================
    // 1. VALIDAR ID
    // ==========================================================

    if (!id) {

      return res.json({

        success:
          false,

        title:
          "Sesión inválida",

        message:
          "Debe enviar el id de la sesión."

      });

    }


    await client.query(
      "BEGIN"
    );


    // ==========================================================
    // 2. BUSCAR SESIÓN
    // ==========================================================
    //
    // FOR UPDATE evita que otro proceso
    // modifique la misma sesión al mismo tiempo.
    //
    // ==========================================================

    const sessionResult =
      await client.query(
        `
        SELECT
          s.*,
          u.full_name

        FROM inventory_sessions s

        LEFT JOIN users u
          ON u.id = s.user_id

        WHERE
          s.id = $1

        LIMIT 1

        FOR UPDATE OF s
        `,
        [
          id
        ]
      );


    // ==========================================================
    // 3. CONFIRMAR QUE EXISTE
    // ==========================================================

    if (
      sessionResult.rows.length === 0
    ) {

      await client.query(
        "ROLLBACK"
      );


      return res.json({

        success:
          false,

        title:
          "Sesión no encontrada",

        message:
          "La sesión de inventario no existe."

      });

    }


    const session =
      sessionResult.rows[0];


    console.log(
      "📦 SESIÓN ENCONTRADA:",
      {
        id:
          session.id,

        code:
          session.code,

        status:
          session.status
      }
    );


    // ==========================================================
    // 4. VALIDAR STATUS
    // ==========================================================
    //
    // Solamente permitimos:
    //
    // review → in-progress
    //
    // ==========================================================

    if (
      session.status !==
      "review"
    ) {

      await client.query(
        "ROLLBACK"
      );


      return res.json({

        success:
          false,

        title:
          "No se puede reanudar la sesión",

        message:
          `La sesión debe estar en estado review para reanudar el conteo. Estado actual: ${session.status}.`

      });

    }

    // VALIDAD QUE NO HAY NINGUN AJUSTE APLICADO A ESA SESSION.

    const completedAdjustmentResult =
      await client.query(
        `
    SELECT EXISTS (

      SELECT 1

      FROM inventory_adjustment_jobs

      WHERE
        inventory_session_id = $1

        AND status = 'completed'

    ) AS has_completed_adjustment
    `,
        [
          session.id
        ]
      );


    const hasCompletedAdjustment =
      completedAdjustmentResult
        .rows[0]
        ?.has_completed_adjustment === true;


    console.log(
      "🔎 ¿EXISTE AJUSTE COMPLETADO?:",
      hasCompletedAdjustment
    );


    // ==========================================================
    // SI YA SE APLICÓ UN AJUSTE → NO REANUDAR
    // ==========================================================

    if (
      hasCompletedAdjustment
    ) {

      await client.query(
        "ROLLBACK"
      );


      return res.json({

        success:
          false,

        title:
          "No se puede reanudar la sesión",

        message:
          "No se puede seguir contando luego de que se aplicó un ajuste en CITRUS."

      });

    }

    // ==========================================================
    // 5. CAMBIAR A IN-PROGRESS
    // ==========================================================

    const updateResult =
      await client.query(
        `
        UPDATE inventory_sessions

        SET

          status =
            'in-progress',

          updated_at =
            NOW()

        WHERE
          id = $1

        RETURNING
          *
        `,
        [
          id
        ]
      );


    const updatedSession =
      updateResult.rows[0];


    // ==========================================================
    // 6. AGREGAR FULL_NAME
    // ==========================================================

    updatedSession.full_name =
      session.full_name;


    // ==========================================================
    // 7. COMMIT
    // ==========================================================

    await client.query(
      "COMMIT"
    );


    console.log(
      "✅ SESIÓN REANUDADA:"
    );

    console.log(
      {
        id:
          updatedSession.id,

        code:
          updatedSession.code,

        status:
          updatedSession.status
      }
    );

    console.log(
      "🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦========================================"
    );
    // ==========================================================
    // 8. RESPUESTA FRONTEND
    // ==========================================================

    return res.json({

      success:
        true,

      title:
        "Conteo reanudado",

      message:
        "La sesión volvió a estar en progreso. Puede continuar realizando el conteo físico.",

      hasActiveSession:
        true,

      session:
        updatedSession

    });


  } catch (error) {

    try {

      await client.query(
        "ROLLBACK"
      );

    } catch (rollbackError) {

      console.error(
        "❌ ERROR EN ROLLBACK:",
        rollbackError
      );

    }


    console.error("");
    console.error(
      "🟥 ERROR REANUDANDO SESIÓN:"
    );

    console.error(
      error
    );


    return res.status(500).json({

      success:
        false,

      title:
        "Error reanudando sesión",

      message:
        "Ocurrió un error al intentar reanudar el conteo de inventario."

    });


  } finally {

    client.release();

  }

}





export async function cancelInventorySession(req, res) {
  const client = await db.connect();

  try {

    console.log("🟦🟦🟦 ================================");
    console.log("🟨 INVENTORY MONITOR");
    console.log("🚫 CANCELANDO SESIÓN");

    const { id } = req.body;
    //const userId = 1;
    const userId = Number(req.user?.id);

    console.log("📥 SESSION ID:", id);
    console.log("👤 USER ID:", userId);

    if (!userId) {

      console.log("❌ USER ID INVÁLIDO");

      return res.status(200).json({
        success: false,
        title: "Usuario no encontrado",
        message: "No se pudo identificar el usuario autenticado."
      });
    }

    if (!id) {

      console.log("❌ ID NO RECIBIDO");

      return res.status(200).json({
        success: false,
        title: "ID requerido",
        message: "Debe enviar el ID de la sesión."
      });
    }

    await client.query("BEGIN");

    // =====================================
    // BUSCAR SESIÓN
    // =====================================

    console.log("🔍 BUSCANDO SESIÓN");

    const sessionResult = await client.query(
      `
  SELECT
    id,
    code,
    user_id,
    status,
    erp_warehouse_id
  FROM inventory_sessions
  WHERE id = $1
    AND status NOT IN ('posted', 'cancelled')
  FOR UPDATE
  `,
      [id]
    );

    if (sessionResult.rowCount === 0) {

      console.log("❌ SESIÓN NO ENCONTRADA");

      await client.query("ROLLBACK");

      return res.status(200).json({
        success: false,
        title: "Sesión no encontrada",
        message:
          "La sesión no existe o ya fue cancelada."
      });
    }

    const session = sessionResult.rows[0];

    console.log(
      "📋 SESSION:",
      session.code,
      "| STATUS:",
      session.status
    );

    // =====================================
    // VALIDAR ESTADO
    // =====================================

    if (
      !["draft", "in-progress", "review"].includes(
        session.status
      )
    ) {

      console.log(
        "❌ ESTADO NO PERMITIDO:",
        session.status
      );

      await client.query("ROLLBACK");

      return res.status(200).json({
        success: false,
        title: "Estado inválido",
        message:
          "La sesión no puede ser cancelada."
      });
    }

    // =====================================
    // CANCELAR SESIÓN
    // =====================================

    console.log("✏️ CANCELANDO SESIÓN");

    const updateResult = await client.query(
      `
      UPDATE inventory_sessions
      SET
          status = 'cancelled',
          cancelled_by = $2,
          end_date = NOW(),
          updated_at = NOW()
      WHERE id = $1
      RETURNING
          id,
          code,
          user_id,
          status,
          cancelled_by,
          start_date,
          end_date,
          created_at,
          updated_at
      `,
      [id, userId]
    );

    const cancelledSession = updateResult.rows[0];

    // =====================================
    // LIMPIAR CONTEOS
    // =====================================

    console.log(
      "🧹 LIMPIANDO DATOS DE INVENTARIO"
    );

    // =====================================
    // LIMPIAR CONTEOS DEL WAREHOUSE
    // SELECCIONADO EN ESTA SESIÓN
    // =====================================

    const erpWarehouseId =
      Number(
        session.erp_warehouse_id
      );

    if (
      !Number.isInteger(erpWarehouseId) ||
      erpWarehouseId <= 0
    ) {
      throw new Error(
        `ERP Warehouse ID inválido: ${session.erp_warehouse_id}`
      );
    }

    console.log(
      "🧹 LIMPIANDO DATOS DE INVENTARIO DEL WAREHOUSE:",
      session.erp_warehouse_id
    );

    const cleanResult = await client.query(
      `
  UPDATE inventory_by_location ibl

  SET
    inventory_quantity = 0,
    counted_by = NULL,
    counted_at = NULL,
    old_qty_on_hand = NULL,
    updated_at = NOW()

  FROM warehouses w

  WHERE
    w.id = ibl.warehouse_id

    AND w.erp_warehouse_id = $1
  `,
      [
        erpWarehouseId
      ]
    );

    console.log(
      "📦 FILAS LIMPIADAS DEL WAREHOUSE:",
      cleanResult.rowCount
    );

    console.log(
      "📦 FILAS LIMPIADAS:",
      cleanResult.rowCount
    );

    await client.query("COMMIT");

    console.log(
      "✅ SESIÓN CANCELADA:",
      cancelledSession.code
    );

    console.log(
      "👤 CANCELADA POR:",
      cancelledSession.cancelled_by
    );

    console.log("🟦🟦🟦 ================================");

    return res.status(200).json({
      success: true,
      title: "SESSION_CANCELLED",
      message:
        "La sesión fue cancelada correctamente.",

      hasActiveSession: false,

      session: {
        id: cancelledSession.id,
        code: cancelledSession.code,
        user_id: cancelledSession.user_id,
        status: cancelledSession.status,
        cancelled_by: cancelledSession.cancelled_by,
        start_date: cancelledSession.start_date,
        end_date: cancelledSession.end_date,
        created_at: cancelledSession.created_at,
        updated_at: cancelledSession.updated_at
      }
    });

  } catch (error) {

    await client.query("ROLLBACK");

    console.log("🟥 ERROR CANCELANDO SESIÓN");
    console.error(error);

    return res.status(200).json({
      success: false,
      title: "Error cancelando sesión",
      message:
        "Ocurrió un error al cancelar la sesión."
    });

  } finally {

    client.release();

  }
}








// Finaliza el conteo de inventario y mueve la sesión a estado review.
export async function completeInventorySession(req, res) {
  const client = await db.connect();

  try {

    console.log("🟦🟦🟦 ================================");
    console.log("🟨 INVENTORY MONITOR");
    console.log("✅ COMPLETANDO SESIÓN");

    const { id } = req.body;
    const userId = 1;
    //const userId = Number(req.user?.id);

    console.log("📥 SESSION ID:", id);
    console.log("👤 USER ID:", userId);

    if (!id) {
      console.log("❌ ID NO RECIBIDO");

      return res.status(200).json({
        success: false,
        title: "ID requerido",
        message: "Debe enviar el ID de la sesión."
      });
    }

    if (!userId) {
      console.log("❌ USER ID INVÁLIDO");

      return res.status(200).json({
        success: false,
        title: "Usuario inválido",
        message: "No se pudo identificar el usuario."
      });
    }

    await client.query("BEGIN");

    // =====================================
    // BUSCAR SESIÓN
    // =====================================

    console.log("🔍 BUSCANDO SESIÓN");

    const sessionResult = await client.query(
      `
      SELECT
          id,
          code,
          status
      FROM inventory_sessions
      WHERE id = $1
      FOR UPDATE
      `,
      [id]
    );

    if (sessionResult.rowCount === 0) {

      console.log("❌ SESIÓN NO ENCONTRADA");

      await client.query("ROLLBACK");

      return res.status(200).json({
        success: false,
        title: "Sesión no encontrada",
        message: "La sesión indicada no existe."
      });
    }

    const session = sessionResult.rows[0];

    console.log(
      "📋 SESSION:",
      session.code,
      "| STATUS:",
      session.status
    );

    // =====================================
    // VALIDAR ESTADO
    // =====================================

    if (
      !["in-progress", "review"].includes(
        session.status
      )
    ) {

      console.log(
        "❌ ESTADO INVÁLIDO:",
        session.status
      );

      await client.query("ROLLBACK");

      return res.status(200).json({
        success: false,
        title: "Estado inválido",
        message:
          "La sesión debe estar en estado in-progress o review."
      });
    }

    // =====================================
    // CALCULAR ESTADÍSTICAS
    // =====================================

    console.log("📊 CALCULANDO ESTADÍSTICAS");

    // Ubicaciones contadas
    const countedResult = await client.query(`
      SELECT COUNT(*) AS total
      FROM inventory_by_location
      WHERE inventory_quantity > 0
    `);

    // Diferencias encontradas
    const differencesResult = await client.query(`
      SELECT COUNT(*) AS total
      FROM inventory_by_location
      WHERE inventory_diff_quantity <> 0
    `);

    // Ubicaciones pendientes
    const pendingResult = await client.query(`
      SELECT COUNT(*) AS total
      FROM inventory_by_location
      WHERE qty_on_hand > 0
      AND (
          inventory_quantity IS NULL
          OR inventory_quantity = 0
      )
    `);

    const countedLocations =
      Number(countedResult.rows[0].total);

    const differenceLocations =
      Number(differencesResult.rows[0].total);

    const pendingLocations =
      Number(pendingResult.rows[0].total);

    console.log(
      "📍 UBICACIONES CONTADAS:",
      countedLocations
    );

    console.log(
      "⚠️ DIFERENCIAS ENCONTRADAS:",
      differenceLocations
    );

    console.log(
      "⏳ UBICACIONES PENDIENTES:",
      pendingLocations
    );

    // =====================================
    // ACTUALIZAR SESIÓN
    // =====================================

    console.log("✏️ ACTUALIZANDO SESIÓN");

    const updateResult = await client.query(
      `
      UPDATE inventory_sessions
      SET
          status = 'review',
          counted_locations = $2,
          pending_locations = $3,
          difference_locations = $4,
          completed_by = $5,
          end_date = NOW(),
          updated_at = NOW()
      WHERE id = $1
      RETURNING
          id,
          code,
          user_id,
          status,
          counted_locations,
          pending_locations,
          difference_locations,
          completed_by,
          start_date,
          end_date,
          created_at,
          updated_at
      `,
      [
        id,
        countedLocations,
        pendingLocations,
        differenceLocations,
        userId
      ]
    );

    const updatedSession =
      updateResult.rows[0];

    await client.query("COMMIT");

    console.log("✅ SESIÓN COMPLETADA");
    console.log(
      "📍 CONTADAS:",
      countedLocations
    );
    console.log(
      "⚠️ DIFERENCIAS:",
      differenceLocations
    );
    console.log(
      "⏳ PENDIENTES:",
      pendingLocations
    );
    console.log("🟦🟦🟦 ================================");

    return res.status(200).json({
      success: true,
      title: "SESSION_COMPLETED",
      message:
        "La sesión fue enviada a revisión.",

      hasActiveSession: true,

      session: updatedSession,

      summary: {
        counted_locations: countedLocations,
        difference_locations: differenceLocations,
        pending_locations: pendingLocations
      }
    });

  } catch (error) {

    await client.query("ROLLBACK");

    console.log("🟥 ERROR COMPLETANDO SESIÓN");
    console.error(error);

    return res.status(200).json({
      success: false,
      title: "Error completando sesión",
      message:
        "Ocurrió un error completando la sesión."
    });

  } finally {

    client.release();

  }
}









//Obtener reporte final de inventario en excell
// Obtener reporte final de inventario en Excel
export async function getInventoryFinalReport(req, res) {
  const client = await db.connect();
  let transactionStarted = false;
  let committed = false;

  try {
    console.log("🟦🟦🟦 ================================");
    console.log("📄 INVENTORY REPORT");
    console.log("📌 GENERANDO REPORTE FINAL");
    console.log("🟦🟦🟦 ================================");

    await client.query("BEGIN");
    transactionStarted = true;

    const sessionResult = await client.query(`
      SELECT id, code, status, user_id, start_date, end_date, created_at, updated_at
      FROM inventory_sessions
      WHERE status IN ('draft', 'in-progress', 'review')
      ORDER BY updated_at DESC
    `);

    if (sessionResult.rows.length === 0) {
      await client.query("ROLLBACK");

      return res.status(200).json({
        success: false,
        title: "No hay sesión de inventario",
        message: "No existe una sesión de inventario activa para generar el reporte final.",
      });
    }

    const reviewSession = sessionResult.rows.find(
      (session) => session.status === "review"
    );

    if (!reviewSession) {
      await client.query("ROLLBACK");

      return res.status(200).json({
        success: false,
        title: "Sesión no está en revisión",
        message: "Para generar el reporte final, la sesión debe estar en estado review.",
      });
    }

    const sessionId = Number(reviewSession.id);

    console.log("✅ SESIÓN REVIEW:", {
      sessionId,
      code: reviewSession.code,
      status: reviewSession.status,
    });

    const countedProductsResult = await client.query(
      `
      WITH counted AS (
        SELECT
          ibl.product_sku,
          SUM(COALESCE(ibl.inventory_quantity, 0))::numeric AS total_inventory_qty
        FROM inventory_by_location ibl
        WHERE ibl.counted_by IS NOT NULL
          AND ibl.counted_at IS NOT NULL
        GROUP BY ibl.product_sku
      ),
      prepared AS (
        SELECT
          p.erp_id::bigint AS erp_id,
          $1::bigint AS session_id,
          c.product_sku AS sku,
          p.erp_name,
          p.erp_sku,
          p.description,
          c.total_inventory_qty,
          COALESCE(eis.erp_stock, 0)::numeric AS erp_stock,
          COALESCE(eis.unit_cost, 0)::numeric AS unit_cost,
          CASE WHEN eis.item_id IS NULL THEN false ELSE true END AS exist_erp,
          false AS product_no_exist
        FROM counted c
        JOIN products p
          ON p.sku = c.product_sku
        LEFT JOIN erp_inventory_snapshot eis
          ON eis.item_id = p.erp_id
         AND eis.session_inventory_id = $1
        WHERE p.erp_id IS NOT NULL
      )
      INSERT INTO inventory_erp_report (
        erp_id,
        session_id,
        sku,
        erp_name,
        erp_sku,
        description,
        total_inventory_qty,
        erp_stock,
        unit_cost,
        exist_erp,
        product_no_exist,
        updated_at
      )
      SELECT
        erp_id,
        session_id,
        sku,
        erp_name,
        erp_sku,
        description,
        total_inventory_qty,
        erp_stock,
        unit_cost,
        exist_erp,
        product_no_exist,
        NOW()
      FROM prepared
      ON CONFLICT (erp_id, session_id)
      DO UPDATE SET
        sku = EXCLUDED.sku,
        erp_name = EXCLUDED.erp_name,
        erp_sku = EXCLUDED.erp_sku,
        description = EXCLUDED.description,
        total_inventory_qty = EXCLUDED.total_inventory_qty,
        erp_stock = EXCLUDED.erp_stock,
        unit_cost = EXCLUDED.unit_cost,
        exist_erp = EXCLUDED.exist_erp,
        product_no_exist = EXCLUDED.product_no_exist,
        updated_at = NOW()
      RETURNING
        erp_id,
        session_id,
        sku AS product_sku,
        erp_name,
        erp_sku,
        description,
        total_inventory_qty,
        erp_stock,
        unit_cost,
        difference,
        status,
        exist_erp,
        product_no_exist
      `,
      [sessionId]
    );

    const countedProducts = countedProductsResult.rows;
    const wmsIds = countedProducts.map((item) => Number(item.erp_id));

    console.log("📦 TOTAL PRODUCTOS CONTADOS WMS:", countedProducts.length);
    console.log("🆔 TOTAL ERP IDS EN WMS:", wmsIds.length);

    const productsMissingResult = await client.query(
      `
      WITH missing AS (
        SELECT
          eis.item_id::bigint AS erp_id,
          $1::bigint AS session_id,
          p.sku,
          p.erp_name,
          p.erp_sku,
          p.description,
          0::numeric AS total_inventory_qty,
          COALESCE(eis.erp_stock, 0)::numeric AS erp_stock,
          COALESCE(eis.unit_cost, 0)::numeric AS unit_cost,
          true AS exist_erp,
          CASE WHEN p.sku IS NULL THEN true ELSE false END AS product_no_exist
        FROM erp_inventory_snapshot eis
        LEFT JOIN LATERAL (
          SELECT sku, erp_name, erp_sku, description
          FROM products
          WHERE erp_id = eis.item_id
          LIMIT 1
        ) p ON true
        WHERE eis.session_inventory_id = $1
  AND COALESCE(eis.erp_stock, 0) <> 0
  AND NOT (eis.item_id = ANY($2::bigint[]))
      )
      INSERT INTO inventory_erp_report (
        erp_id,
        session_id,
        sku,
        erp_name,
        erp_sku,
        description,
        total_inventory_qty,
        erp_stock,
        unit_cost,
        exist_erp,
        product_no_exist,
        updated_at
      )
      SELECT
        erp_id,
        session_id,
        sku,
        erp_name,
        erp_sku,
        description,
        total_inventory_qty,
        erp_stock,
        unit_cost,
        exist_erp,
        product_no_exist,
        NOW()
      FROM missing
      ON CONFLICT (erp_id, session_id)
      DO UPDATE SET
        sku = EXCLUDED.sku,
        erp_name = EXCLUDED.erp_name,
        erp_sku = EXCLUDED.erp_sku,
        description = EXCLUDED.description,
        total_inventory_qty = EXCLUDED.total_inventory_qty,
        erp_stock = EXCLUDED.erp_stock,
        unit_cost = EXCLUDED.unit_cost,
        exist_erp = EXCLUDED.exist_erp,
        product_no_exist = EXCLUDED.product_no_exist,
        updated_at = NOW()
      RETURNING
        erp_id AS item_id,
        session_id,
        erp_stock,
        unit_cost,
        sku,
        description,
        erp_name,
        erp_sku,
        product_no_exist,
        difference,
        status,
        exist_erp
      `,
      [sessionId, wmsIds]
    );

    const productsMissing = productsMissingResult.rows;

    console.log("🟥 TOTAL PRODUCTOS ERP CON BALANCE NO CONTADOS:", productsMissing.length);








    const result = await getInventoryFinalReportExcelService(client, sessionId);

    if (!result.success) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(200).json(result);
    }

    await client.query("COMMIT");
    committed = true;
    transactionStarted = false;

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${result.fileName}"`
    );

    return res.send(result.buffer);
  } catch (error) {
    if (transactionStarted && !committed) {
      await client.query("ROLLBACK");
    }

    console.log("🟥 ERROR GENERANDO REPORTE FINAL");
    console.error(error);

    return res.status(500).json({
      success: false,
      title: "Error generando reporte",
      message: "Ocurrió un error al generar el reporte final de inventario.",
      error: error.message,
    });
  } finally {
    client.release();
  }
}





//Obener el reporte de inventario por ubicaciones
// Obtener el reporte de inventario por ubicaciones
export async function getInventoryLocationsReport(req, res) {
  let client = null;
  let transactionStarted = false;

  /**
   * Ejecuta ROLLBACK solamente si existe una transacción activa.
   */
  const rollbackTransaction = async () => {
    if (!client || !transactionStarted) {
      return;
    }

    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error(
        "❌ ERROR EJECUTANDO ROLLBACK:",
        rollbackError
      );
    } finally {
      transactionStarted = false;
    }
  };

  try {
    console.log("🟦🟦🟦 ================================");
    console.log("📄 CREANDO REPORTE DE INVENTARIO FÍSICO");
    console.log("📌 INCLUYENDO UBICACIONES");
    console.log("🟦🟦🟦 ================================");

    // 1. Obtener una conexión del pool
    client = await db.connect();

    // 2. Iniciar transacción
    await client.query("BEGIN");
    transactionStarted = true;

    // 3. Buscar sesiones activas
    const sessionResult = await client.query(`
      SELECT
        id,
        code,
        status,
        user_id,
        start_date,
        end_date,
        created_at,
        updated_at
      FROM inventory_sessions
      WHERE status IN ('draft', 'in-progress', 'review')
      ORDER BY updated_at DESC
    `);

    console.log(
      "📋 TOTAL DE SESIONES ACTIVAS ENCONTRADAS:",
      sessionResult.rows.length
    );

    // 4. Validar que exista una sesión activa
    if (sessionResult.rows.length === 0) {
      await rollbackTransaction();

      return res.status(200).json({
        success: false,
        title: "No hay sesión de inventario",
        message:
          "No existe una sesión de inventario activa para generar el reporte.",
      });
    }

    const activeSession = sessionResult.rows[0];

    console.log("📌 SESIÓN ACTIVA MÁS RECIENTE:", {
      id: activeSession.id,
      code: activeSession.code,
      status: activeSession.status,
      updated_at: activeSession.updated_at,
    });

    // 5. La sesión más reciente debe estar en review
    if (activeSession.status !== "review") {
      await rollbackTransaction();

      return res.status(200).json({
        success: false,
        title: "Sesión no está en revisión",
        message:
          `La sesión activa ${activeSession.code} está en estado ` +
          `"${activeSession.status}". Para generar el reporte debe estar en estado "review".`,
      });
    }

    const sessionId = Number(activeSession.id);

    console.log("✅ SESIÓN REVIEW SELECCIONADA:", {
      sessionId,
      code: activeSession.code,
      status: activeSession.status,
    });

    // 6. Consultar las líneas contadas
    let inventoryResult;

    try {
      inventoryResult = await client.query(`
        SELECT
          ibl.id,
          ibl.location_id,
          ibl.product_sku,
          ibl.qty_on_hand,
          ibl.inventory_quantity,

          p.erp_id,
          p.erp_name,
          p.erp_sku,
          p.description,

          l.code AS location_code

        FROM inventory_by_location AS ibl

        LEFT JOIN products AS p
          ON p.sku = ibl.product_sku

        LEFT JOIN locations AS l
          ON l.id = ibl.location_id
          AND l.is_active IS TRUE

        WHERE ibl.counted_by IS NOT NULL
          AND ibl.counted_at IS NOT NULL

        ORDER BY
          l.code ASC,
          ibl.product_sku ASC,
          ibl.id ASC
      `);
    } catch (queryError) {
      await rollbackTransaction();

      const queryMessage =
        queryError instanceof Error
          ? queryError.message
          : String(queryError);

      console.error(
        "❌ ERROR CONSULTANDO LAS LÍNEAS DEL INVENTARIO:",
        queryError
      );

      return res.status(500).json({
        success: false,
        title: "Error consultando el inventario físico",
        message: queryMessage,
      });
    }

    // 7. Validar que el query haya encontrado líneas
    if (inventoryResult.rows.length === 0) {
      await rollbackTransaction();

      console.log(
        "⚠️ El query funcionó, pero no encontró líneas contadas."
      );

      return res.status(200).json({
        success: false,
        title: "No hay líneas contadas",
        message:
          "No existen líneas de inventario con un conteo físico registrado.",
      });
    }

    console.log(
      "📊 TOTAL DE LÍNEAS DEL REPORTE:",
      inventoryResult.rows.length
    );

    // 8. Crear el mismo objeto DATA que recibe el servicio
    const reportData = {
      success: true,
      title: "Reporte de inventario generado",
      message:
        "Las líneas contadas fueron obtenidas correctamente.",

      session: {
        id: sessionId,
        code: activeSession.code,
        status: activeSession.status,
        user_id: activeSession.user_id,
        start_date: activeSession.start_date,
        end_date: activeSession.end_date,
        created_at: activeSession.created_at,
        updated_at: activeSession.updated_at,
      },

      totalLines: inventoryResult.rows.length,
      data: inventoryResult.rows,
    };

    console.log("📄 ENVIANDO DATA AL SERVICIO DE EXCEL");

    // 9. Generar el archivo Excel
    const excelResult =
      await getInventoryLocationReportExcelService(
        reportData
      );

    // 10. Validar el resultado del servicio
    if (!excelResult.success) {
      await rollbackTransaction();

      return res.status(200).json({
        success: false,
        title:
          excelResult.title ||
          "No se pudo generar el Excel",
        message:
          excelResult.message ||
          "Ocurrió un error generando el reporte.",
      });
    }

    // 11. Confirmar la transacción
    await client.query("COMMIT");
    transactionStarted = false;

    console.log("✅ EXCEL GENERADO CORRECTAMENTE");
    console.log("📄 ARCHIVO:", excelResult.fileName);
    console.log(
      "📊 TOTAL DE LÍNEAS:",
      excelResult.totalLines
    );
    console.log("🟦🟦🟦 ================================");

    // 12. Configurar la respuesta como archivo Excel
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${excelResult.fileName}"`
    );

    res.setHeader(
      "Content-Length",
      excelResult.buffer.length
    );

    // 13. Enviar el Excel al frontend
    return res.status(200).send(excelResult.buffer);
  } catch (error) {
    await rollbackTransaction();

    console.error(
      "❌ ERROR GENERAL GENERANDO REPORTE DE INVENTARIO:",
      error
    );

    const errorMessage =
      error instanceof Error
        ? error.message
        : String(error);

    return res.status(500).json({
      success: false,
      title: "No se pudo generar el reporte",
      message:
        errorMessage ||
        "Ocurrió un error inesperado.",
    });
  } finally {
    if (client) {
      client.release();
      console.log("🔌 CONEXIÓN A POSTGRESQL LIBERADA");
    }
  }
}







// ==========================================================
// OBTENER ALMACENES ACTIVOS
// ==========================================================

export async function getActiveWarehouses(req, res) {
  let client = null;

  try {
    console.log("🟦🟦🟦 ========================================");
    console.log("🏬 BUSCANDO ALMACENES ACTIVOS");
    console.log("🕒 Fecha:", new Date().toISOString());
    console.log("========================================");

    client = await db.connect();

    console.log("✅ Conexión PostgreSQL obtenida");

    const warehouseResult = await client.query(`
      SELECT
        id,
        code,
        name,
        erp_warehouse_id
      FROM warehouses
      WHERE status = 'ACTIVE'
      ORDER BY
        is_default DESC,
        name ASC
    `);

    console.log(
      "📦 TOTAL ALMACENES ACTIVOS:",
      warehouseResult.rowCount
    );

    if (warehouseResult.rowCount === 0) {
      console.log("⚠️ No se encontraron almacenes activos");

      return res.status(200).json({
        success: false,
        title: "No encontramos almacenes",
        message:
          "Asegúrese de crear o sincronizar almacenes activos antes de iniciar una sesión de inventario.",
        warehouses: []
      });
    }

    console.log(
      "✅ ALMACENES ACTIVOS:",
      warehouseResult.rows
    );

    return res.status(200).json({
      success: true,
      title: "Almacenes encontrados",
      message: "Los almacenes fueron obtenidos correctamente.",
      warehouses: warehouseResult.rows
    });

  } catch (error) {
    console.error(
      "❌ ERROR OBTENIENDO ALMACENES:",
      error
    );

    return res.status(500).json({
      success: false,
      title: "Error obteniendo almacenes",
      message:
        "Ocurrió un error buscando los almacenes disponibles.",
      warehouses: []
    });

  } finally {
    if (client) {
      client.release();

      console.log(
        "🔌 Conexión PostgreSQL liberada"
      );
    }
  }
}