import { db } from "../db.js";
import { saveInventoryByCount } from "../services/inventoryService.js";
import { getInventorySessionStatusService } from "../services/inventory.count.js";
import { emitInventorySummary } from "../services/inventory.count.js";
import {
  buscarTodasLasExistenciasAlmacen
} from "../integrations/admcloud/admcloud.erpStockSync.js";
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





export async function startInventoryAdjustment(req, res) {

  const client = await db.connect();

  let transactionStarted = false;
  let committed = false;

  // ==========================================================
  // HABILITAR CREACIÓN DE JOBS PARA PRUEBA
  // Requiere la protección GUID del worker indicada arriba.
  // ==========================================================

  const ADMCLOUD_JOB_CREATION_ENABLED = true;

  const GUID_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // ==========================================================
  // ROLLBACK CONTROLADO
  // ==========================================================

  const rollback = async () => {

    if (!transactionStarted || committed) {
      return;
    }

    await client.query("ROLLBACK");

    transactionStarted = false;
  };

  const respondFailure = async (
    status,
    title,
    message
  ) => {

    await rollback();

    return res.status(status).json({
      success: false,
      title,
      message
    });
  };

  try {

    console.log("");
    console.log("🟦 ========================================");
    console.log("📦 INICIANDO AJUSTE DE INVENTARIO ADM CLOUD");
    console.log("🟦 ========================================");

    // ==========================================================
    // 1. VALIDAR USUARIO
    // ==========================================================

    const userId = Number(
      req.user?.id ?? req.body?.userId
    );

    console.log("👤 USER ID:", userId);

    if (
      !Number.isSafeInteger(userId) ||
      userId <= 0
    ) {
      return res.status(400).json({
        success: false,
        title: "Usuario inválido",
        message: "Debe proporcionar un usuario válido."
      });
    }

    // PENDIENTE:
    // Validar permisos reales usando req.user.
    // No confiar en req.body.userId para autorización.

    // ==========================================================
    // 2. INICIAR TRANSACCIÓN
    // ==========================================================

    await client.query("BEGIN");

    transactionStarted = true;

    // ==========================================================
    // 3. OBTENER SESIÓN EN REVISIÓN
    // ==========================================================

    const sessionResult = await client.query(`
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

      WHERE status IN (
        'draft',
        'in-progress',
        'review'
      )

      ORDER BY updated_at DESC
    `);

    if (sessionResult.rows.length === 0) {
      return await respondFailure(
        200,
        "No hay sesión de inventario",
        "No existe una sesión activa para generar el reporte."
      );
    }

    const reviewSession = sessionResult.rows.find(
      session => session.status === "review"
    );

    if (!reviewSession) {
      return await respondFailure(
        200,
        "Sesión no está en revisión",
        "Para generar el reporte final, la sesión debe estar en estado review."
      );
    }

    const sessionId = Number(
      reviewSession.id
    );

    const erpWarehouseId = String(
      reviewSession.erp_warehouse_id ?? ""
    ).trim().toLowerCase();

    console.log("🆔 SESSION ID:", sessionId);
    console.log("🏬 ERP LOCATION GUID:", erpWarehouseId);

    if (
      !Number.isSafeInteger(sessionId) ||
      sessionId <= 0
    ) {
      return await respondFailure(
        400,
        "Sesión inválida",
        "ID de sesión inválido."
      );
    }

    if (!GUID_REGEX.test(erpWarehouseId)) {
      return await respondFailure(
        400,
        "Almacén ERP inválido",
        "La sesión no tiene un LocationID GUID válido de ADM Cloud."
      );
    }

    // ==========================================================
    // 4. IDENTIFICAR ALMACÉN WMS
    // ==========================================================

    const warehouseResult = await client.query(
      `
      SELECT
        id,
        name,
        code

      FROM warehouses

      WHERE LOWER(erp_warehouse_id) = $1

      ORDER BY id

      LIMIT 2
      `,
      [erpWarehouseId]
    );

    if (warehouseResult.rowCount !== 1) {
      return await respondFailure(
        400,
        "Almacén WMS no identificado",
        "No se pudo identificar un único almacén WMS para el LocationID de la sesión."
      );
    }

    const wmsWarehouseId =
      warehouseResult.rows[0].id;

    console.log(
      "📦 ALMACÉN WMS:",
      wmsWarehouseId
    );

    // ==========================================================
    // 5. VALIDAR TIPOS DE COLUMNAS ADM CLOUD
    // ==========================================================

    const schemaResult = await client.query(`
      SELECT
        data_type

      FROM information_schema.columns

      WHERE table_schema = current_schema()
        AND table_name = 'inventory_erp_report'
        AND column_name = 'erp_id'

      LIMIT 1
    `);

    const reportIdType =
      schemaResult.rows[0]?.data_type;

    if (
      ![
        "text",
        "character varying",
        "uuid"
      ].includes(reportIdType)
    ) {
      return await respondFailure(
        409,
        "Migración de base de datos requerida",
        "inventory_erp_report.erp_id debe admitir GUID antes de generar el reporte."
      );
    }

    // ==========================================================
    // 6. GENERAR REPORTE DE PRODUCTOS CONTADOS
    // ==========================================================

    console.log("");
    console.log("📄 GENERANDO REPORTE FINAL");

    const countedProductsResult = await client.query(
      `
      WITH counted AS (

        SELECT
          ibl.product_sku,

          SUM(
            COALESCE(
              ibl.inventory_quantity,
              0
            )
          )::numeric AS total_inventory_qty

        FROM inventory_by_location ibl

        WHERE ibl.warehouse_id = $2::bigint

          AND ibl.counted_by IS NOT NULL

          AND ibl.counted_at IS NOT NULL

          AND ibl.counted_at >= $3::timestamptz

        GROUP BY ibl.product_sku
      ),

      prepared AS (

        SELECT
          p.erp_id::text AS erp_id,

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

          (
            eis.item_id IS NOT NULL
          ) AS exist_erp,

          false AS product_no_exist,

          true AS wms_counted

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

        sku = EXCLUDED.sku,

        erp_name = EXCLUDED.erp_name,

        erp_sku = EXCLUDED.erp_sku,

        description = EXCLUDED.description,

        total_inventory_qty =
          EXCLUDED.total_inventory_qty,

        erp_stock = EXCLUDED.erp_stock,

        unit_cost = EXCLUDED.unit_cost,

        exist_erp = EXCLUDED.exist_erp,

        product_no_exist =
          EXCLUDED.product_no_exist,

        wms_counted = EXCLUDED.wms_counted,

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
        product_no_exist,
        wms_counted
      `,
      [
        sessionId,
        wmsWarehouseId,
        reviewSession.start_date
      ]
    );

    const countedProducts =
      countedProductsResult.rows;

    const wmsIds = countedProducts.map(
      item => String(item.erp_id)
    );

    if (countedProducts.length === 0) {

      console.log(
        "🟨 NO SE ENCONTRARON CONTEOS DE ESTA SESIÓN"
      );

      return await respondFailure(
        409,
        "Sin conteos actuales",
        "No hay productos contados en este almacén " +
        "desde el inicio de la sesión. " +
        "No se creará un job con reportes anteriores."
      );
    }

    console.log(
      "📦 PRODUCTOS CONTADOS:",
      countedProducts.length
    );

    console.log(
      "🆔 ERP IDS (GUID):",
      wmsIds.length
    );

    // ==========================================================
    // 7. PRODUCTOS ERP NO CONTADOS
    // DESACTIVADO IGUAL QUE EN TU CÓDIGO ORIGINAL.
    // ==========================================================

    // ==========================================================
    // 8. OBTENER LÍNEAS DEL REPORTE
    // ==========================================================

    console.log("");
    console.log("🟨 OBTENIENDO PRODUCTOS PARA AJUSTE");

    const reportLinesResult = await client.query(
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

      ORDER BY id ASC
      `,
      [sessionId]
    );

    const reportLines =
      reportLinesResult.rows;

    console.log(
      "📄 LÍNEAS PARA AJUSTE:",
      reportLines.length
    );

    if (reportLines.length === 0) {
      return await respondFailure(
        200,
        "Sin productos contados",
        "No existen productos contados para generar el ajuste."
      );
    }

    // ==========================================================
    // 9. CONTROL DE CREACIÓN DE JOBS
    // ==========================================================

    if (!ADMCLOUD_JOB_CREATION_ENABLED) {

      await client.query("COMMIT");

      committed = true;
      transactionStarted = false;

      return res.status(200).json({
        success: true,
        title: "Reporte generado",
        message: "Se generó el reporte, pero no se crearon jobs.",
        data: {
          sessionId,
          erpWarehouseId,
          wmsWarehouseId,
          totalProducts: reportLines.length,
          status: "report_ready",
          workerStarted: false
        }
      });
    }

    // ==========================================================
    // 10. VALIDAR ESQUEMA DE JOBS
    // ==========================================================

    const requiredColumns = [
      [
        "inventory_adjustment_jobs",
        "erp_warehouse_id"
      ],
      [
        "inventory_adjustment_job_lines",
        "erp_product_id"
      ],
      [
        "inventory_adjustment_job_lines",
        "erp_warehouse_id"
      ]
    ];

    const columnResult = await client.query(`
      SELECT
        table_name,
        column_name,
        data_type

      FROM information_schema.columns

      WHERE table_schema = current_schema()

        AND (
          (
            table_name = 'inventory_adjustment_jobs'

            AND column_name = 'erp_warehouse_id'
          )

          OR

          (
            table_name = 'inventory_adjustment_job_lines'

            AND column_name IN (
              'erp_product_id',
              'erp_warehouse_id'
            )
          )
        )
    `);

    for (
      const [tableName, columnName]
      of requiredColumns
    ) {

      const column =
        columnResult.rows.find(
          row =>
            row.table_name === tableName &&
            row.column_name === columnName
        );

      if (
        ![
          "text",
          "character varying",
          "uuid"
        ].includes(column?.data_type)
      ) {

        return await respondFailure(
          409,
          "Esquema de jobs incompatible",
          `${tableName}.${columnName} debe admitir GUID como texto.`
        );
      }
    }

    // ==========================================================
    // 11. VERIFICAR JOB EXISTENTE
    // ==========================================================

    const existingJobResult = await client.query(
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

      WHERE inventory_session_id = $1

        AND job_type = 'counted'

      ORDER BY id DESC

      LIMIT 1
      `,
      [sessionId]
    );

    const existingJob =
      existingJobResult.rows[0];

    if (existingJob) {

      const existingJobId =
        Number(existingJob.id);

      console.log(
        "ℹ️ YA EXISTE JOB:",
        {
          jobId: existingJobId,
          status: existingJob.status
        }
      );

      await client.query("COMMIT");

      committed = true;
      transactionStarted = false;

      // ========================================================
      // INTENTAR REANUDAR WORKER ORIGINAL
      // ========================================================

      const workerStarted = [
        "pending",
        "processing",
        "waiting_citrus"
      ].includes(existingJob.status);

      if (workerStarted) {

        console.log(
          "🚀 REANUDANDO WORKER EXISTENTE:",
          existingJobId
        );

        startInventoryAdjustmentWorker(
          existingJobId
        ).catch(error => {

          console.error(
            "🟥 ERROR WORKER EXISTENTE:",
            error
          );

        });
      }

      return res.status(200).json({
        success: true,

        title: "Job existente",

        message: workerStarted
          ? "Se solicitó el inicio del worker para el job existente."
          : "El job existe y no se reiniciará automáticamente.",

        data: {
          jobId: existingJobId,
          sessionId,
          erpWarehouseId,
          status: existingJob.status,
          totalProducts: existingJob.total_products,
          processedProducts:
            existingJob.processed_products,
          successfulProducts:
            existingJob.successful_products,
          failedProducts:
            existingJob.failed_products,
          currentLineId:
            existingJob.current_line_id,
          errorMessage:
            existingJob.error_message,
          workerStarted
        }
      });
    }

    // ==========================================================
    // 12. CREAR NUEVO JOB
    // ==========================================================

    console.log("");
    console.log(
      "🟨 CREANDO INVENTORY ADJUSTMENT JOB"
    );

    const jobResult = await client.query(
      `
      INSERT INTO inventory_adjustment_jobs (
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

      VALUES (
        $1,
        'counted',
        $2::text,
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

      RETURNING id, status
      `,
      [
        sessionId,
        erpWarehouseId,
        reportLines.length
      ]
    );

    const adjustmentJobId =
      Number(jobResult.rows[0].id);

    console.log(
      "✅ JOB CREADO:",
      adjustmentJobId
    );

    // ==========================================================
    // 13. COPIAR LAS LÍNEAS AL JOB
    // ==========================================================

    console.log("");
    console.log(
      "📦 COPIANDO PRODUCTOS AL JOB"
    );

    const insertJobLinesResult =
      await client.query(
        `
        INSERT INTO inventory_adjustment_job_lines (
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
          ier.erp_id::text,
          $2::text,

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

        FROM inventory_erp_report ier

        WHERE ier.session_id = $3

          AND ier.wms_counted = true

        ORDER BY ier.id ASC

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

    if (
      insertedLines.length !== reportLines.length
    ) {
      throw new Error(
        `Se esperaban ${reportLines.length} líneas, ` +
        `pero se insertaron ${insertedLines.length}.`
      );
    }

    // ==========================================================
    // 14. COMMIT
    // ==========================================================

    await client.query("COMMIT");

    committed = true;
    transactionStarted = false;

    console.log("");
    console.log(
      "✅ JOB Y LÍNEAS GUARDADOS CORRECTAMENTE"
    );

    // ==========================================================
    // 15. INICIAR WORKER ORIGINAL
    //
    // No usar await.
    // El worker maneja su propio advisory lock.
    // ==========================================================

    console.log("");
    console.log(
      "🚀 INICIANDO INVENTORY ADJUSTMENT WORKER"
    );

    console.log(
      "🆔 JOB ID:",
      adjustmentJobId
    );

    startInventoryAdjustmentWorker(
      adjustmentJobId
    ).catch(error => {

      console.error("");
      console.error(
        "🟥 ERROR NO CONTROLADO EN WORKER"
      );
      console.error(error);

    });

    // ==========================================================
    // 16. RESPONSE
    // ==========================================================

    return res.status(200).json({

      success: true,

      title: "Worker iniciado",

      message:
        "El job fue creado y se solicitó el inicio del worker.",

      data: {
        jobId: adjustmentJobId,
        sessionId,
        erpWarehouseId,
        wmsWarehouseId,
        totalProducts: insertedLines.length,
        status: "pending",
        workerStarted: true
      }
    });

  } catch (error) {

    if (
      transactionStarted &&
      !committed
    ) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error(
          "🟥 ERROR EN ROLLBACK:",
          rollbackError
        );
      }
    }

    console.error("");
    console.error(
      "❌ ERROR PREPARANDO AJUSTE ADM CLOUD:",
      error
    );

    return res.status(500).json({
      success: false,
      title: "Error preparando ajuste",
      message:
        "No fue posible preparar el ajuste de inventario.",
      error: error.message
    });

  } finally {

    client.release();

  }
}






export async function startInventoryAdjustmentZero(req, res) {

  const client = await db.connect();

  let transactionStarted = false;
  let committed = false;
  let adjustmentJobId = null;

  // ============================================================
  // CONFIGURACIÓN
  // ============================================================

  const ADMCLOUD_JOB_CREATION_ENABLED = true;

  const GUID_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // ============================================================
  // ROLLBACK CONTROLADO
  // ============================================================

  const rollback = async () => {

    if (!transactionStarted || committed) {
      return;
    }

    try {
      await client.query("ROLLBACK");
    } finally {
      transactionStarted = false;
    }
  };

  // ============================================================
  // HELPER - RESPUESTA DE ERROR
  // ============================================================

  const respondFailure = async (
    status,
    title,
    message
  ) => {

    await rollback();

    return res.status(status).json({
      success: false,
      title,
      message
    });
  };

  try {

    console.log("");
    console.log("🟦🟦🟦 ========================================");
    console.log("📦 INICIANDO AJUSTE DE INVENTARIO A CERO");
    console.log("🌐 ERP: ADM CLOUD");
    console.log("🟦🟦🟦 ========================================");

    // ============================================================
    // 1. VALIDAR USUARIO AUTENTICADO
    // ============================================================

    const userId = Number(req.user?.id);

    console.log("👤 USER ID:", userId);

    if (
      !Number.isSafeInteger(userId) ||
      userId <= 0
    ) {
      return res.status(401).json({
        success: false,
        title: "Usuario no autorizado",
        message:
          "No se pudo identificar un usuario autenticado válido."
      });
    }

    // IMPORTANTE:
    // Agregar aquí la validación real de permisos para
    // ajustar inventario antes de habilitar esta acción
    // en producción.

    // ============================================================
    // 2. INICIAR TRANSACCIÓN
    // ============================================================

    await client.query("BEGIN");

    transactionStarted = true;

    // ============================================================
    // 3. EVITAR DOS PREPARACIONES SIMULTÁNEAS
    // ============================================================
    //
    // Este lock se libera automáticamente con
    // COMMIT o ROLLBACK.
    // ============================================================

    await client.query(`
      SELECT pg_advisory_xact_lock(94175, 2)
    `);

    // ============================================================
    // 4. OBTENER SESIÓN ACTIVA
    // ============================================================

    console.log("");
    console.log("📄 BUSCANDO SESIÓN DE INVENTARIO");

    const sessionResult = await client.query(`
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

      WHERE status IN (
        'draft',
        'in-progress',
        'review'
      )

      ORDER BY updated_at DESC

      LIMIT 1
    `);

    if (sessionResult.rows.length === 0) {

      return await respondFailure(
        200,
        "No hay sesión de inventario",
        "No existe una sesión activa para realizar el ajuste."
      );
    }

    const reviewSession = sessionResult.rows[0];

    // ============================================================
    // 5. VALIDAR ESTADO DE SESIÓN
    // ============================================================

    if (reviewSession.status !== "review") {

      return await respondFailure(
        200,
        "Sesión no está en revisión",
        `La sesión ${reviewSession.code} debe estar ` +
        "en estado review para aplicar el ajuste."
      );
    }

    const sessionId = Number(
      reviewSession.id
    );

    if (
      !Number.isSafeInteger(sessionId) ||
      sessionId <= 0
    ) {
      return await respondFailure(
        400,
        "Sesión inválida",
        "El ID de la sesión no es válido."
      );
    }

    // ============================================================
    // 6. OBTENER GUID DEL ALMACÉN ADM CLOUD
    // ============================================================
    //
    // CORRECCIÓN PRINCIPAL:
    //
    // ANTES:
    // Number(reviewSession.erp_warehouse_id)
    //
    // AHORA:
    // String(reviewSession.erp_warehouse_id)
    //
    // ADM CLOUD UTILIZA GUID.
    // ============================================================

    const erpWarehouseId = String(
      reviewSession.erp_warehouse_id ?? ""
    ).trim().toLowerCase();

    console.log("");
    console.log("✅ SESIÓN REVIEW:", {
      sessionId,
      code: reviewSession.code,
      status: reviewSession.status
    });

    console.log(
      "🏬 ERP LOCATION GUID:",
      erpWarehouseId
    );

    if (!GUID_REGEX.test(erpWarehouseId)) {

      return await respondFailure(
        400,
        "Almacén ERP inválido",
        "La sesión no tiene un LocationID GUID válido de ADM Cloud."
      );
    }

    if (!reviewSession.start_date) {

      return await respondFailure(
        400,
        "Fecha de inicio inválida",
        "La sesión no tiene fecha de inicio registrada."
      );
    }

    // ============================================================
    // 7. IDENTIFICAR ALMACÉN WMS
    // ============================================================

    console.log("");
    console.log("🏬 BUSCANDO ALMACÉN WMS");

    const warehouseResult = await client.query(
      `
      SELECT
        id,
        code,
        name,
        erp_warehouse_id

      FROM warehouses

      WHERE LOWER(erp_warehouse_id::text) = $1

      ORDER BY id ASC

      LIMIT 2
      `,
      [erpWarehouseId]
    );

    if (warehouseResult.rows.length !== 1) {

      return await respondFailure(
        400,
        "Almacén WMS no identificado",
        "No se pudo identificar un único almacén WMS " +
        "para el GUID de la sesión."
      );
    }

    const warehouse = warehouseResult.rows[0];

    const wmsWarehouseId = Number(
      warehouse.id
    );

    if (
      !Number.isSafeInteger(wmsWarehouseId) ||
      wmsWarehouseId <= 0
    ) {

      return await respondFailure(
        400,
        "Almacén WMS inválido",
        "El identificador interno del almacén no es válido."
      );
    }

    console.log("✅ ALMACÉN IDENTIFICADO:", {
      wmsWarehouseId,
      name: warehouse.name,
      erpWarehouseId
    });

    // ============================================================
    // 8. VERIFICAR COMPATIBILIDAD DE COLUMNAS GUID
    // ============================================================

    const schemaResult = await client.query(`
      SELECT
        table_name,
        column_name,
        data_type

      FROM information_schema.columns

      WHERE table_schema = current_schema()

        AND (
          (
            table_name = 'inventory_erp_report'
            AND column_name = 'erp_id'
          )

          OR (
            table_name = 'inventory_adjustment_jobs'
            AND column_name = 'erp_warehouse_id'
          )

          OR (
            table_name = 'inventory_adjustment_job_lines'
            AND column_name IN (
              'erp_product_id',
              'erp_warehouse_id'
            )
          )
        )
    `);

    const requiredColumns = [
      ["inventory_erp_report", "erp_id"],
      ["inventory_adjustment_jobs", "erp_warehouse_id"],
      ["inventory_adjustment_job_lines", "erp_product_id"],
      ["inventory_adjustment_job_lines", "erp_warehouse_id"]
    ];

    for (const [tableName, columnName] of requiredColumns) {

      const column = schemaResult.rows.find(
        row =>
          row.table_name === tableName &&
          row.column_name === columnName
      );

      if (
        ![
          "text",
          "character varying",
          "uuid"
        ].includes(column?.data_type)
      ) {

        return await respondFailure(
          409,
          "Esquema incompatible con ADM Cloud",
          `${tableName}.${columnName} debe admitir GUID.`
        );
      }
    }

    // ============================================================
    // 9. VERIFICAR SI YA EXISTE UN JOB ZERO
    // ============================================================

    const existingJobResult = await client.query(
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

      WHERE inventory_session_id = $1

        AND job_type = 'zero'

      ORDER BY id DESC

      LIMIT 1
      `,
      [sessionId]
    );

    const existingJob =
      existingJobResult.rows[0];

    if (existingJob) {

      adjustmentJobId = Number(
        existingJob.id
      );

      console.log("");
      console.log("ℹ️ YA EXISTE JOB ZERO:", {
        jobId: adjustmentJobId,
        status: existingJob.status
      });

      await client.query("COMMIT");

      committed = true;
      transactionStarted = false;

      const workerStarted = [
        "pending",
        "processing",
        "waiting_citrus"
      ].includes(existingJob.status);

      if (workerStarted) {

        startInventoryAdjustmentWorker(
          adjustmentJobId
        ).catch(error => {

          console.error(
            "🟥 ERROR REANUDANDO WORKER ZERO:",
            error
          );
        });
      }

      return res.status(200).json({
        success: true,

        title: "Job existente",

        message: workerStarted
          ? "Se solicitó continuar el proceso de ajuste existente."
          : "El proceso ya existe y no se reiniciará automáticamente.",

        data: {
          jobId: adjustmentJobId,
          sessionId,
          erpWarehouseId,
          wmsWarehouseId,
          status: existingJob.status,
          totalProducts: existingJob.total_products,
          processedProducts: existingJob.processed_products,
          successfulProducts: existingJob.successful_products,
          failedProducts: existingJob.failed_products,
          currentLineId: existingJob.current_line_id,
          errorMessage: existingJob.error_message,
          workerStarted
        }
      });
    }

    // ============================================================
    // 10. VALIDAR SNAPSHOT DE LA SESIÓN
    // ============================================================
    //
    // El snapshot representa las existencias ERP
    // guardadas al crear esta sesión de inventario.
    //
    // No utilizar productos de otras sesiones.
    // ============================================================

    console.log("");
    console.log("📦 VALIDANDO SNAPSHOT ADM CLOUD");

    const snapshotResult = await client.query(
      `
      SELECT
        COUNT(DISTINCT item_id::text)::integer
          AS total_products,

        COUNT(DISTINCT item_id::text) FILTER (
          WHERE erp_stock > 0
        )::integer AS positive_stock,

        COUNT(DISTINCT item_id::text) FILTER (
          WHERE erp_stock < 0
        )::integer AS negative_stock

      FROM erp_inventory_snapshot

      WHERE session_inventory_id = $1
      `,
      [sessionId]
    );

    const snapshotSummary =
      snapshotResult.rows[0];

    const totalSnapshotProducts = Number(
      snapshotSummary?.total_products ?? 0
    );

    console.log("📊 SNAPSHOT:", snapshotSummary);

    if (totalSnapshotProducts === 0) {

      return await respondFailure(
        409,
        "Snapshot vacío",
        "La sesión no tiene existencias ERP registradas. " +
        "No es seguro realizar un ajuste a cero."
      );
    }

    // ============================================================
    // 11. OBTENER PRODUCTOS CONTADOS EN ESTA SESIÓN
    // ============================================================
    //
    // La consulta:
    //
    // - Usa únicamente el almacén actual.
    // - Usa la fecha de inicio de la sesión.
    // - Usa la fecha final, cuando exista.
    // - No excluye conteos físicos de cero.
    // - No convierte GUID a BIGINT.
    //
    // ============================================================

    console.log("");
    console.log("🔍 IDENTIFICANDO PRODUCTOS CONTADOS");

    const countedProductsResult = await client.query(
      `
      SELECT
        ibl.product_sku,

        p.erp_id::text AS erp_id,

        SUM(
          COALESCE(ibl.inventory_quantity, 0)
        )::numeric AS total_inventory_qty

      FROM inventory_by_location AS ibl

      LEFT JOIN products AS p
        ON p.sku = ibl.product_sku

      WHERE ibl.warehouse_id = $1::bigint

        AND ibl.counted_by IS NOT NULL

        AND ibl.counted_at IS NOT NULL

        AND ibl.inventory_quantity IS NOT NULL

        AND ibl.counted_at >= $2::timestamptz

        AND (
          $3::timestamptz IS NULL
          OR ibl.counted_at <= $3::timestamptz
        )

      GROUP BY
        ibl.product_sku,
        p.erp_id
      `,
      [
        wmsWarehouseId,
        reviewSession.start_date,
        reviewSession.end_date
      ]
    );

    const countedProducts =
      countedProductsResult.rows;

    const countedErpIds = new Set(
      countedProducts
        .filter(item => item.erp_id)
        .map(item =>
          String(item.erp_id).trim().toLowerCase()
        )
    );

    console.log(
      "✅ PRODUCTOS FÍSICAMENTE CONTADOS:",
      countedProducts.length
    );

    console.log(
      "✅ PRODUCTOS CONTADOS CON ERP ID:",
      countedErpIds.size
    );

    // ============================================================
    // 12. PROTECCIONES ANTES DE AJUSTAR A CERO
    // ============================================================

    if (countedProducts.length === 0) {

      return await respondFailure(
        409,
        "No hay conteos registrados",
        "No se puede aplicar inventario en cero porque " +
        "esta sesión no tiene productos físicamente contados."
      );
    }

    const countedWithoutErpId = countedProducts.filter(
      item => !item.erp_id
    );

    if (countedWithoutErpId.length > 0) {

      console.error(
        "❌ PRODUCTOS CONTADOS SIN ERP ID:",
        countedWithoutErpId
      );

      return await respondFailure(
        409,
        "Productos sin identificación ERP",
        "Existen productos contados que no tienen ERP ID. " +
        "Corrige su identificación antes de ajustar a cero."
      );
    }

    const invalidCountedGuids = countedProducts.filter(
      item =>
        !GUID_REGEX.test(
          String(item.erp_id ?? "")
        )
    );

    if (invalidCountedGuids.length > 0) {

      return await respondFailure(
        409,
        "Productos con GUID inválido",
        "Algunos productos contados tienen un ERP ID inválido."
      );
    }

    // ============================================================
    // 13. VALIDAR GUIDS DEL SNAPSHOT
    // ============================================================

    const invalidSnapshotResult = await client.query(
      `
      SELECT item_id::text AS item_id

      FROM erp_inventory_snapshot

      WHERE session_inventory_id = $1

        AND COALESCE(erp_stock, 0) <> 0

        AND item_id::text !~
          '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

      LIMIT 5
      `,
      [sessionId]
    );

    if (invalidSnapshotResult.rows.length > 0) {

      console.error(
        "❌ GUIDS INVÁLIDOS EN SNAPSHOT:",
        invalidSnapshotResult.rows
      );

      return await respondFailure(
        409,
        "Snapshot incompatible",
        "El snapshot contiene identificadores ERP inválidos."
      );
    }

    // ============================================================
    // 14. GENERAR REPORTE SOLO DE NO CONTADOS
    // ============================================================
    //
    // IMPORTANTE:
    //
    // La fuente principal es erp_inventory_snapshot.
    //
    // Solo se incluyen productos:
    //
    // 1. Del snapshot de esta sesión.
    // 2. Con existencia ERP diferente de cero.
    // 3. Que NO fueron contados físicamente.
    //
    // Los productos contados no se modifican aquí.
    //
    // ============================================================

    console.log("");
    console.log("🟨 GENERANDO REPORTE DE PRODUCTOS NO CONTADOS");

    const productsMissingResult = await client.query(
      `
      WITH snapshot_items AS (

        SELECT DISTINCT ON (
          LOWER(eis.item_id::text)
        )

          eis.item_id::text AS erp_id,

          COALESCE(
            eis.erp_stock,
            0
          )::numeric AS erp_stock,

          COALESCE(
            eis.unit_cost,
            0
          )::numeric AS unit_cost

        FROM erp_inventory_snapshot AS eis

        WHERE eis.session_inventory_id = $1::bigint

          AND eis.item_id IS NOT NULL

          AND COALESCE(
            eis.erp_stock,
            0
          ) <> 0

        ORDER BY
          LOWER(eis.item_id::text)
      ),

      missing AS (

        SELECT

          si.erp_id,

          $1::bigint AS session_id,

          p.sku,
          p.erp_name,
          p.erp_sku,
          p.description,

          0::numeric AS total_inventory_qty,

          si.erp_stock,
          si.unit_cost,

          true AS exist_erp,

          (p.sku IS NULL) AS product_no_exist,

          false AS wms_counted

        FROM snapshot_items AS si

        LEFT JOIN LATERAL (

          SELECT
            p2.sku,
            p2.erp_name,
            p2.erp_sku,
            p2.description

          FROM products AS p2

          WHERE LOWER(p2.erp_id::text) =
                LOWER(si.erp_id)

          ORDER BY p2.id ASC

          LIMIT 1

        ) AS p ON true

        WHERE NOT EXISTS (

          SELECT 1

          FROM inventory_by_location AS ibl

          JOIN products AS cp
            ON cp.sku = ibl.product_sku

          WHERE LOWER(cp.erp_id::text) =
                LOWER(si.erp_id)

            AND ibl.warehouse_id = $2::bigint

            AND ibl.counted_by IS NOT NULL

            AND ibl.counted_at IS NOT NULL

            AND ibl.inventory_quantity IS NOT NULL

            AND ibl.counted_at >= $3::timestamptz

            AND (
              $4::timestamptz IS NULL
              OR ibl.counted_at <= $4::timestamptz
            )
        )
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

      FROM missing

      ON CONFLICT (
        erp_id,
        session_id
      )

      DO UPDATE SET

        sku = EXCLUDED.sku,

        erp_name = EXCLUDED.erp_name,

        erp_sku = EXCLUDED.erp_sku,

        description = EXCLUDED.description,

        total_inventory_qty =
          EXCLUDED.total_inventory_qty,

        erp_stock = EXCLUDED.erp_stock,

        unit_cost = EXCLUDED.unit_cost,

        exist_erp = EXCLUDED.exist_erp,

        product_no_exist =
          EXCLUDED.product_no_exist,

        wms_counted =
          EXCLUDED.wms_counted,

        updated_at = NOW()

      WHERE inventory_erp_report.wms_counted
        IS DISTINCT FROM TRUE

      RETURNING

        id,
        erp_id,
        session_id,
        sku,
        total_inventory_qty,
        erp_stock,
        wms_counted
      `,
      [
        sessionId,
        wmsWarehouseId,
        reviewSession.start_date,
        reviewSession.end_date
      ]
    );

    const productsMissing =
      productsMissingResult.rows;

    console.log(
      "🟥 PRODUCTOS NO CONTADOS PREPARADOS:",
      productsMissing.length
    );

    // ============================================================
    // 15. PROTECCIÓN CONTRA REPORTE INCONSISTENTE
    // ============================================================
    //
    // Validar que los productos preparados no coincidan
    // con productos contados físicamente.
    // ============================================================

    const conflicts = productsMissing.filter(
      item =>
        countedErpIds.has(
          String(item.erp_id).trim().toLowerCase()
        )
    );

    if (conflicts.length > 0) {

      console.error(
        "❌ CONFLICTO ENTRE CONTADOS Y NO CONTADOS:",
        conflicts
      );

      return await respondFailure(
        409,
        "Conflicto de inventario",
        "Se encontraron productos contados dentro del ajuste a cero."
      );
    }

    const reportLineIds = productsMissing.map(
      item => Number(item.id)
    );

    // ============================================================
    // 16. VALIDAR PRODUCTOS PENDIENTES
    // ============================================================

    if (productsMissing.length === 0) {

      console.log("");
      console.log(
        "ℹ️ NO HAY PRODUCTOS NO CONTADOS PARA AJUSTAR"
      );

      await client.query("COMMIT");

      committed = true;
      transactionStarted = false;

      return res.status(200).json({

        success: true,

        title: "Sin productos pendientes",

        message:
          "No se encontraron productos pendientes para ajustar a cero.",

        data: {
          sessionId,
          erpWarehouseId,
          wmsWarehouseId,
          totalProducts: 0,
          workerStarted: false,
          citrusAdjustmentRequired: false
        }
      });
    }

    // ============================================================
    // 17. VALIDAR IDS DE LÍNEAS DEL REPORTE
    // ============================================================

    if (
      reportLineIds.some(
        id =>
          !Number.isSafeInteger(id) ||
          id <= 0
      )
    ) {

      return await respondFailure(
        409,
        "Líneas inválidas",
        "Se encontraron identificadores inválidos " +
        "en el reporte de inventario."
      );
    }

    // ============================================================
    // 18. OPCIÓN DE CREACIÓN DE JOB
    // ============================================================

    if (!ADMCLOUD_JOB_CREATION_ENABLED) {

      await client.query("COMMIT");

      committed = true;
      transactionStarted = false;

      return res.status(200).json({
        success: true,

        title: "Reporte generado",

        message:
          "Se generó el reporte sin crear el job.",

        data: {
          sessionId,
          erpWarehouseId,
          wmsWarehouseId,
          totalProducts: productsMissing.length,
          status: "report_ready",
          workerStarted: false
        }
      });
    }

    // ============================================================
    // 19. CREAR JOB ZERO
    // ============================================================

    console.log("");
    console.log("🟨 CREANDO INVENTORY ADJUSTMENT JOB ZERO");

    const jobResult = await client.query(
      `
      INSERT INTO inventory_adjustment_jobs (

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

      VALUES (

        $1::bigint,
        'zero',
        $2::text,
        'pending',
        $3::integer,
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

      RETURNING id, status
      `,
      [
        sessionId,
        erpWarehouseId,
        productsMissing.length
      ]
    );

    adjustmentJobId = Number(
      jobResult.rows[0].id
    );

    console.log("✅ JOB ZERO CREADO:", {
      jobId: adjustmentJobId,
      sessionId,
      erpWarehouseId,
      totalProducts: productsMissing.length
    });

    // ============================================================
    // 20. COPIAR LÍNEAS DEL REPORTE AL JOB
    // ============================================================
    //
    // CORRECCIÓN IMPORTANTE:
    //
    // erp_product_id = GUID
    // erp_warehouse_id = GUID
    //
    // desired_qty = 0
    //
    // Solo insertar líneas que fueron preparadas
    // específicamente para este ajuste.
    //
    // ============================================================

    console.log("");
    console.log("📦 COPIANDO PRODUCTOS NO CONTADOS AL JOB");

    const insertJobLinesResult = await client.query(
      `
      INSERT INTO inventory_adjustment_job_lines (

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

        ier.erp_id::text,

        $2::text,

        0::numeric,

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

      FROM inventory_erp_report AS ier

      WHERE ier.session_id = $3::bigint

        AND ier.wms_counted = false

        AND ier.id = ANY($4::bigint[])

        AND COALESCE(
          ier.erp_stock,
          0
        ) <> 0

      ORDER BY ier.id ASC

      RETURNING
        id,
        report_line_id,
        erp_product_id,
        erp_warehouse_id,
        desired_qty,
        citrus_qty_before,
        status
      `,
      [
        adjustmentJobId,
        erpWarehouseId,
        sessionId,
        reportLineIds
      ]
    );

    const insertedLines =
      insertJobLinesResult.rows;

    console.log("");
    console.log(
      "✅ TOTAL LÍNEAS CREADAS:",
      insertedLines.length
    );

    // ============================================================
    // 21. VALIDAR CANTIDAD DE LÍNEAS
    // ============================================================

    if (
      insertedLines.length !== productsMissing.length
    ) {

      throw new Error(
        `Se esperaban ${productsMissing.length} líneas, ` +
        `pero se insertaron ${insertedLines.length}.`
      );
    }

    // ============================================================
    // 22. VALIDACIÓN FINAL DEL JOB
    // ============================================================

    const jobValidationResult = await client.query(
      `
      SELECT

        COUNT(*)::integer AS total_lines,

        COUNT(*) FILTER (
          WHERE desired_qty <> 0
        )::integer AS invalid_desired_qty,

        COUNT(*) FILTER (
          WHERE LOWER(erp_warehouse_id::text)
                <> LOWER($2::text)
        )::integer AS invalid_warehouse

      FROM inventory_adjustment_job_lines

      WHERE job_id = $1::bigint
      `,
      [
        adjustmentJobId,
        erpWarehouseId
      ]
    );

    const jobValidation =
      jobValidationResult.rows[0];

    if (
      Number(jobValidation.total_lines) !== insertedLines.length ||
      Number(jobValidation.invalid_desired_qty) !== 0 ||
      Number(jobValidation.invalid_warehouse) !== 0
    ) {

      throw new Error(
        "El job ZERO no superó la validación de seguridad."
      );
    }

    // ============================================================
    // 23. COMMIT
    // ============================================================

    await client.query("COMMIT");

    committed = true;
    transactionStarted = false;

    console.log("");
    console.log("🟩 ========================================");
    console.log("✅ JOB ZERO GUARDADO CORRECTAMENTE");
    console.log("🆔 JOB ID:", adjustmentJobId);
    console.log("🆔 SESSION ID:", sessionId);
    console.log("🏬 ALMACÉN:", warehouse.name);
    console.log("🌐 ERP LOCATION GUID:", erpWarehouseId);
    console.log("📦 PRODUCTOS NO CONTADOS:", insertedLines.length);
    console.log("🎯 CANTIDAD DESTINO:", 0);
    console.log("🟩 ========================================");

    // ============================================================
    // 24. INICIAR WORKER
    // ============================================================
    //
    // El worker se inicia solo después del COMMIT.
    //
    // ============================================================

    console.log("");
    console.log("🚀 INICIANDO INVENTORY ADJUSTMENT WORKER");
    console.log("🆔 JOB ID:", adjustmentJobId);

    startInventoryAdjustmentWorker(
      adjustmentJobId
    ).catch(error => {

      console.error("");
      console.error(
        "🟥 ERROR NO CONTROLADO EN WORKER ZERO:",
        error
      );
    });

    // ============================================================
    // 25. RESPUESTA
    // ============================================================

    return res.status(200).json({

      success: true,

      title: "Worker iniciado",

      message:
        "Se creó el ajuste a cero para los productos " +
        "no contados de esta sesión y se solicitó " +
        "el inicio del worker.",

      data: {
        jobId: adjustmentJobId,
        sessionId,
        erpWarehouseId,
        wmsWarehouseId,
        totalProducts: insertedLines.length,
        status: "pending",
        workerStarted: true
      }
    });

  } catch (error) {

    if (
      transactionStarted &&
      !committed
    ) {

      try {
        await rollback();
      } catch (rollbackError) {
        console.error(
          "🟥 ERROR HACIENDO ROLLBACK:",
          rollbackError
        );
      }
    }

    console.error("");
    console.error("🟥🟥🟥 ========================================");
    console.error("❌ ERROR PREPARANDO AJUSTE ZERO ADM CLOUD");
    console.error("🟥🟥🟥 ========================================");
    console.error(error);

    return res.status(500).json({

      success: false,

      title: "Error preparando ajuste a cero",

      message:
        "No fue posible preparar el ajuste a cero " +
        "de los productos no contados.",

      error:
        error instanceof Error
          ? error.message
          : String(error)
    });

  } finally {

    client.release();

    console.log(
      "🔌 CONEXIÓN POSTGRESQL LIBERADA"
    );
  }
}









export async function inventoryScan(req, res) {

  try {

    // ============================================================
    // 1. OBTENER DATOS DEL ESCÁNER
    // ============================================================

    const {
      productScanned,
      locationScanned
    } = req.body ?? {};

    const productCode =
      String(productScanned ?? "").trim();

    const locationCode =
      String(locationScanned ?? "").trim();

    console.log("");
    console.log("🟦 ========================================");
    console.log("📦 INVENTORY SCAN");
    console.log("🟦 ========================================");

    console.log("📍 UBICACIÓN:", locationCode);
    console.log("📦 PRODUCTO:", productCode);

    // ============================================================
    // 2. VALIDAR QUE EXISTA UN CÓDIGO ESCANEADO
    // ============================================================

    if (!productCode && !locationCode) {

      console.log(
        "❌ Debe escanear una ubicación o un producto."
      );

      return res.json({
        success: false,
        title: "Escaneo requerido",
        message:
          "Debe escanear una ubicación o un producto."
      });

    }

    // ============================================================
    // 3. VALIDAR ESTADO DE LA SESIÓN DE INVENTARIO
    // ============================================================

    console.log("");
    console.log("🔍 VALIDANDO SESIÓN DE INVENTARIO");

    const result =
      await getInventorySessionStatusService();

    if (!result.success) {

      console.log(
        "❌ No se pudo consultar la sesión."
      );

      return res.json({
        success: false,
        title: "Error de sesión",
        message:
          "No se pudo obtener el estado actual de la sesión de inventario."
      });

    }

    // ============================================================
    // 4. VALIDAR QUE EXISTA UNA SESIÓN ACTIVA
    // ============================================================

    if (
      !result.hasActiveSession ||
      !result.session
    ) {

      console.log(
        "❌ No existe una sesión activa."
      );

      return res.json({
        success: false,
        title: "No hay una sesión activa",
        message:
          "Debe crear e iniciar una sesión de inventario antes de realizar conteos."
      });

    }

    // ============================================================
    // 5. VALIDAR QUE LA SESIÓN ESTÉ IN-PROGRESS
    // ============================================================

    if (
      result.session.status !== "in-progress"
    ) {

      console.log(
        "❌ ESTADO DE LA SESIÓN:",
        result.session.status
      );

      return res.json({
        success: false,
        title: "Sesión no iniciada",
        message:
          "La sesión de inventario debe estar iniciada para poder escanear ubicaciones y productos."
      });

    }

    const sessionId =
      Number(result.session.id);

    if (
      !Number.isSafeInteger(sessionId) ||
      sessionId <= 0
    ) {

      return res.json({
        success: false,
        title: "Sesión inválida",
        message:
          "La sesión de inventario no tiene un identificador válido."
      });

    }

    console.log(
      "✅ SESIÓN EN PROGRESO:",
      {
        sessionId,
        code: result.session.code,
        status: result.session.status
      }
    );

    // ============================================================
    // 6. OBTENER ALMACÉN WMS DE LA SESIÓN ACTIVA
    //
    // La sesión almacena:
    // inventory_sessions.erp_warehouse_id = GUID ADM Cloud
    //
    // La tabla warehouses contiene:
    // warehouses.erp_warehouse_id = GUID ADM Cloud
    // warehouses.id = ID interno WMS
    // ============================================================

    console.log("");
    console.log("🏬 VALIDANDO ALMACÉN DE LA SESIÓN");

    const sessionWarehouseResult =
      await db.query(
        `
        SELECT
          s.id AS session_id,
          s.code AS session_code,
          s.status AS session_status,
          s.erp_warehouse_id,

          w.id AS wms_warehouse_id,
          w.name AS warehouse_name,
          w.code AS warehouse_code

        FROM inventory_sessions s

        INNER JOIN warehouses w
          ON LOWER(w.erp_warehouse_id::text) =
             LOWER(s.erp_warehouse_id::text)

        WHERE s.id = $1
          AND s.status = 'in-progress'

        ORDER BY w.id
        LIMIT 2
        `,
        [sessionId]
      );

    // ============================================================
    // 7. VALIDAR ALMACÉN EN WMS
    // ============================================================

    if (
      sessionWarehouseResult.rows.length !== 1
    ) {

      console.error(
        "❌ NO SE IDENTIFICÓ UN ÚNICO ALMACÉN PARA LA SESIÓN"
      );

      return res.status(409).json({
        success: false,
        title: "Error de almacén",
        message:
          "No se pudo identificar el almacén WMS asociado a esta sesión de inventario."
      });

    }

    const sessionWarehouse =
      sessionWarehouseResult.rows[0];

    const sessionWarehouseId =
      Number(sessionWarehouse.wms_warehouse_id);

    if (
      !Number.isSafeInteger(sessionWarehouseId) ||
      sessionWarehouseId <= 0
    ) {

      return res.status(409).json({
        success: false,
        title: "Almacén inválido",
        message:
          "El almacén de esta sesión no tiene un ID WMS válido."
      });

    }

    console.log(
      "✅ ALMACÉN DE LA SESIÓN:",
      {
        sessionId,
        wmsWarehouseId: sessionWarehouseId,
        warehouseName:
          sessionWarehouse.warehouse_name,
        warehouseCode:
          sessionWarehouse.warehouse_code,
        erpWarehouseId:
          sessionWarehouse.erp_warehouse_id
      }
    );

    // ============================================================
    // 8. FUNCIÓN PARA VALIDAR UNA UBICACIÓN
    //
    // IMPORTANTE:
    // La ubicación debe cumplir:
    //
    // 1. Existir en locations.
    // 2. Estar activa.
    // 3. Pertenecer al warehouse_id de la sesión.
    //
    // Se utiliza tanto para escanear ubicaciones
    // como para escanear productos dentro de ellas.
    // ============================================================

    const buscarUbicacionDeSesion =
      async (codigo) => {

        const locationResult =
          await db.query(
            `
            SELECT
              l.id,
              l.code,
              l.warehouse_id

            FROM locations l

            WHERE l.code = $1

              AND l.warehouse_id = $2

              AND l.is_active = true

            LIMIT 1
            `,
            [
              codigo,
              sessionWarehouseId
            ]
          );

        return locationResult.rows[0] ?? null;

      };

    // ============================================================
    // 9. FUNCIÓN PARA RESPONDER UBICACIÓN NO PERMITIDA
    // ============================================================

    const responderUbicacionInvalida =
      (codigo) => {

        console.error(
          "❌ UBICACIÓN NO PERMITIDA:",
          {
            codigo,
            sessionId,
            sessionWarehouseId
          }
        );

        return res.json({
          success: false,
          title: "Ubicación no permitida",
          message:
            "La ubicación escaneada no existe, está inactiva o no pertenece al almacén seleccionado para esta sesión de inventario."
        });

      };

    // ============================================================
    // 10. DETECTAR ESCANEO DE UBICACIÓN
    //
    // Conservamos los casos originales:
    //
    // A. locationScanned con productScanned vacío.
    // B. Ambos códigos son iguales.
    // C. Solo productScanned (se interpreta como
    //    posible código de ubicación).
    // ============================================================

    const soloUbicacion =
      (
        locationCode &&
        !productCode
      ) ||
      (
        locationCode &&
        productCode &&
        locationCode === productCode
      ) ||
      (
        !locationCode &&
        productCode
      );

    if (soloUbicacion) {

      console.log("");
      console.log("📍 ESCANEO DE UBICACIÓN");

      const codigoUbicacion =
        locationCode || productCode;

      // ==========================================================
      // 11. VALIDAR UBICACIÓN DENTRO DEL ALMACÉN
      // ==========================================================

      const location =
        await buscarUbicacionDeSesion(
          codigoUbicacion
        );

      if (!location) {

        return responderUbicacionInvalida(
          codigoUbicacion
        );

      }

      console.log(
        "✅ UBICACIÓN VALIDADA:",
        {
          id: location.id,
          code: location.code,
          warehouseId: location.warehouse_id,
          sessionWarehouseId
        }
      );

      // ==========================================================
      // 12. RESPUESTA DEL ESCANEO DE UBICACIÓN
      // ==========================================================

      return res.json({
        success: true,
        type: "location",
        data: location
      });

    }

    // ============================================================
    // 13. ESCANEO DE PRODUCTO
    //
    // Para llegar aquí:
    // locationCode y productCode deben estar presentes.
    // ============================================================

    if (!locationCode) {

      console.log(
        "❌ Debe escanear una ubicación primero."
      );

      return res.json({
        success: false,
        title: "Falta ubicación",
        message:
          "Debe escanear una ubicación antes de escanear un producto."
      });

    }

    // ============================================================
    // 14. VALIDAR UBICACIÓN ANTES DEL PRODUCTO
    //
    // Este paso impide que el frontend envíe
    // un producto con una ubicación de otro almacén.
    // ============================================================

    console.log("");
    console.log("🔍 VALIDANDO UBICACIÓN DEL PRODUCTO");

    const location =
      await buscarUbicacionDeSesion(
        locationCode
      );

    if (!location) {

      return responderUbicacionInvalida(
        locationCode
      );

    }

    const locationId =
      Number(location.id);

    console.log(
      "✅ UBICACIÓN CONFIRMADA:",
      {
        locationId,
        code: location.code,
        warehouseId: location.warehouse_id,
        sessionWarehouseId
      }
    );

    // ============================================================
    // 15. BUSCAR PRODUCTO POR SKU O CÓDIGO DE BARRAS
    //
    // Conservamos los mismos campos del código original.
    // ============================================================

    console.log("");
    console.log(
      "🔍 BUSCANDO PRODUCTO:",
      productCode
    );

    const productResult =
      await db.query(
        `
        SELECT
          p.id,
          p.erp_id,
          p.sku,
          p.description,
          p.erp_name,
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
        `,
        [productCode]
      );

    // ============================================================
    // 16. VALIDAR PRODUCTO
    // ============================================================

    if (
      productResult.rows.length === 0
    ) {

      console.log(
        "❌ PRODUCTO NO ENCONTRADO:",
        productCode
      );

      return res.json({
        success: false,
        title: "Producto no encontrado",
        message:
          "El código escaneado no corresponde a ningún producto."
      });

    }

    const product =
      productResult.rows[0];

    console.log(
      "✅ PRODUCTO CONFIRMADO:",
      {
        id: product.id,
        sku: product.sku,
        erpId: product.erp_id
      }
    );

    // ============================================================
    // 17. CONSULTAR INVENTARIO CONTADO
    //
    // NUEVA SEGURIDAD:
    // Además de location_id y SKU,
    // filtramos también por warehouse_id.
    // ============================================================

    console.log("");
    console.log(
      "📊 CONSULTANDO CANTIDAD CONTADA"
    );

    const inventoryResult =
      await db.query(
        `
        SELECT
          inventory_quantity

        FROM inventory_by_location

        WHERE product_sku = $1

          AND location_id = $2

          AND warehouse_id = $3

        LIMIT 1
        `,
        [
          product.sku,
          locationId,
          sessionWarehouseId
        ]
      );

    // ============================================================
    // 18. OBTENER CANTIDAD CONTADA
    // ============================================================

    let qty = 0;

    if (
      inventoryResult.rows.length > 0
    ) {

      const inventoryQty =
        Number(
          inventoryResult.rows[0].inventory_quantity
        );

      console.log(
        "📊 CANTIDAD CONTADA ENCONTRADA:",
        inventoryResult.rows[0].inventory_quantity
      );

      if (
        Number.isFinite(inventoryQty) &&
        inventoryQty > 0
      ) {

        qty = inventoryQty;

      }

    }

    console.log(
      "✅ CANTIDAD A DEVOLVER:",
      qty
    );

    // ============================================================
    // 19. RESPUESTA FINAL DEL ESCANEO DE PRODUCTO
    // ============================================================

    console.log("");
    console.log("🟩 ========================================");
    console.log("✅ INVENTORY SCAN COMPLETADO");
    console.log("📦 PRODUCTO:", product.sku);
    console.log("📍 UBICACIÓN:", location.code);
    console.log("🏬 ALMACÉN WMS:", sessionWarehouseId);
    console.log("📊 CANTIDAD CONTADA:", qty);
    console.log("🟩 ========================================");

    return res.json({
      success: true,
      type: "product",
      data: product,
      location,
      qty
    });

  } catch (error) {

    // ============================================================
    // 20. MANEJO DE ERRORES
    // ============================================================

    console.error("");
    console.error(
      "❌ ERROR EN inventoryScan:",
      error
    );

    return res.status(500).json({
      success: false,
      title: "Error al escanear",
      message:
        "Ocurrió un error interno al procesar el código escaneado."
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

// ============================================================
// SINCRONIZAR EXISTENCIAS ADM CLOUD
// GUARDAR SOLO PRODUCTOS CON STOCK DIFERENTE DE CERO
// ============================================================

async function runSyncExistenciaAlmacenOnce(client, sessionId) {

  // ============================================================
  // 1. VALIDAR CLIENT
  // ============================================================

  if (!client) {
    return {
      success: false,
      skipped: false,
      message: "client es requerido para sincronizar existencia."
    };
  }

  // ============================================================
  // 2. VALIDAR SESSION ID
  // ============================================================

  const inventorySessionId = Number(sessionId);

  if (
    !Number.isSafeInteger(inventorySessionId) ||
    inventorySessionId <= 0
  ) {
    return {
      success: false,
      skipped: false,
      message: "sessionId debe ser un identificador válido."
    };
  }

  // ============================================================
  // 3. EVITAR SINCRONIZACIONES SIMULTÁNEAS
  // ============================================================

  if (syncExistenciaRunning) {

    console.log(
      "⏳ Ya existe una sincronización de inventario en proceso."
    );

    return {
      success: false,
      skipped: true,
      message: "La sincronización ya está en ejecución."
    };
  }

  syncExistenciaRunning = true;

  try {

    console.log("");
    console.log("🟦 ========================================");
    console.log("⏱️ SYNC EXISTENCIAS ADM CLOUD INICIADO");
    console.log("🆔 SESSION ID:", inventorySessionId);
    console.log("🟦 ========================================");

    // ========================================================
    // 4. SINCRONIZAR EXISTENCIAS DEL ERP
    // ========================================================
    //
    // Este servicio consulta ADM Cloud e inserta
    // los productos en erp_inventory_snapshot.
    //
    // ========================================================

    const data = await buscarTodasLasExistenciasAlmacen(
      client,
      inventorySessionId
    );

    // ========================================================
    // 5. ELIMINAR STOCK IGUAL A CERO
    // ========================================================
    //
    // CONSERVAR:
    //   erp_stock > 0
    //   erp_stock < 0
    //
    // ELIMINAR:
    //   erp_stock = 0
    //
    // También elimina valores NULL, porque no representan
    // una existencia numérica válida.
    //
    // Solo afecta al snapshot de la sesión actual.
    // ========================================================

    console.log("");
    console.log("🧹 FILTRANDO EXISTENCIAS IGUALES A CERO");

    const cleanupResult = await client.query(
      `
      DELETE FROM erp_inventory_snapshot

      WHERE session_inventory_id = $1

        AND (
          erp_stock = 0
          OR erp_stock IS NULL
        )

      RETURNING item_id
      `,
      [inventorySessionId]
    );

    const totalRemoved =
      cleanupResult.rowCount ?? 0;

    console.log(
      "🗑️ PRODUCTOS CON STOCK CERO ELIMINADOS:",
      totalRemoved
    );

    // ========================================================
    // 6. OBTENER RESUMEN DE PRODUCTOS CONSERVADOS
    // ========================================================

    const summaryResult = await client.query(
      `
      SELECT

        COUNT(*)::integer AS total_products,

        COUNT(*) FILTER (
          WHERE erp_stock > 0
        )::integer AS positive_stock,

        COUNT(*) FILTER (
          WHERE erp_stock < 0
        )::integer AS negative_stock

      FROM erp_inventory_snapshot

      WHERE session_inventory_id = $1
      `,
      [inventorySessionId]
    );

    const summary = summaryResult.rows[0];

    const totalSaved =
      Number(summary?.total_products ?? 0);

    const positiveStock =
      Number(summary?.positive_stock ?? 0);

    const negativeStock =
      Number(summary?.negative_stock ?? 0);

    // ========================================================
    // 7. LOGS
    // ========================================================

    console.log("");
    console.log("🟩 ========================================");
    console.log("✅ SINCRONIZACIÓN ADM CLOUD FINALIZADA");
    console.log("🆔 SESSION:", inventorySessionId);
    console.log("📦 PRODUCTOS CONSERVADOS:", totalSaved);
    console.log("📈 STOCK POSITIVO:", positiveStock);
    console.log("📉 STOCK NEGATIVO:", negativeStock);
    console.log("🗑️ STOCK CERO ELIMINADO:", totalRemoved);
    console.log("🟩 ========================================");

    // ========================================================
    // 8. RESPUESTA FINAL
    // ========================================================

    return {
      success: true,
      skipped: false,

      message:
        "Existencias sincronizadas correctamente. " +
        "Solo se conservaron productos con stock diferente de cero.",

      data: {
        syncResult: data,
        sessionId: inventorySessionId,
        totalSaved,
        positiveStock,
        negativeStock,
        totalRemoved
      }
    };

  } catch (error) {

    console.error("");
    console.error("🔥 ERROR SINCRONIZANDO EXISTENCIAS:");
    console.error(error);

    return {
      success: false,
      skipped: false,
      message:
        error.message ||
        "Error sincronizando existencia del almacén."
    };

  } finally {

    syncExistenciaRunning = false;

  }
}






export async function createInventorySession(req, res) {

  const client = await db.connect();

  let transactionStarted = false;

  // ============================================================
  // HELPER - ROLLBACK SEGURO
  // ============================================================

  const rollback = async () => {

    if (!transactionStarted) {
      return;
    }

    await client.query("ROLLBACK");

    transactionStarted = false;

    console.log("🔄 ROLLBACK EJECUTADO");

  };

  // ============================================================
  // HELPER - RESPUESTA DE ERROR
  // ============================================================

  const respondFailure = async (
    title,
    message
  ) => {

    await rollback();

    return res.status(200).json({
      success: false,
      title,
      message
    });

  };

  try {

    console.log("");
    console.log("🟦🟦🟦 ========================================");
    console.log("🟨 INVENTORY MONITOR");
    console.log("🆕 CREANDO NUEVA SESIÓN");
    console.log("🟦🟦🟦 ========================================");

    // ============================================================
    // 1. VALIDAR USUARIO AUTENTICADO
    // ============================================================

    const userId = Number(
      req.user?.id
    );

    console.log("👤 USER ID:", userId);

    if (
      !Number.isSafeInteger(userId) ||
      userId <= 0
    ) {

      console.error(
        "❌ USER ID INVÁLIDO"
      );

      return res.status(200).json({
        success: false,
        title: "Usuario no encontrado",
        message:
          "No se pudo identificar el usuario autenticado."
      });

    }

    // ============================================================
    // 2. OBTENER ERP WAREHOUSE ID
    //
    // ADM CLOUD USA GUID
    // NO CONVERTIR A NUMBER()
    // ============================================================

    const erpWarehouseId = String(
      req.body?.erpWarehouseId ?? ""
    ).trim().toLowerCase();

    console.log(
      "🏬 ERP WAREHOUSE ID:",
      erpWarehouseId
    );

    // ============================================================
    // 3. VALIDAR GUID DE ADM CLOUD
    //
    // Se valida ANTES de comenzar la transacción.
    // ============================================================

    const GUID_REGEX =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    if (!GUID_REGEX.test(erpWarehouseId)) {

      console.error(
        "❌ GUID ADM CLOUD INVÁLIDO:",
        erpWarehouseId
      );

      return res.status(200).json({
        success: false,
        title: "Almacén no compatible",
        message:
          "El almacén seleccionado no tiene un identificador GUID válido de ADM Cloud."
      });

    }

    // ============================================================
    // 4. INICIAR TRANSACCIÓN POSTGRESQL
    // ============================================================

    await client.query("BEGIN");

    transactionStarted = true;

    console.log(
      "🔐 TRANSACCIÓN INICIADA"
    );

    // ============================================================
    // 5. EVITAR DOS CREACIONES SIMULTÁNEAS
    //
    // El advisory lock se libera automáticamente
    // al hacer COMMIT o ROLLBACK.
    // ============================================================

    await client.query(`
      SELECT pg_advisory_xact_lock(94175, 1)
    `);

    // ============================================================
    // 6. VALIDAR QUE EL ALMACÉN EXISTA EN WMS
    // ============================================================

    console.log("");
    console.log(
      "🔍 VALIDANDO ALMACÉN EN WMS"
    );

    const warehouseResult = await client.query(
      `
      SELECT
        id,
        code,
        name,
        erp_warehouse_id

      FROM warehouses

      WHERE LOWER(erp_warehouse_id::text) = $1

      ORDER BY id ASC

      LIMIT 2
      `,
      [erpWarehouseId]
    );

    if (warehouseResult.rows.length !== 1) {

      console.error(
        "❌ ALMACÉN NO IDENTIFICADO DE FORMA ÚNICA:",
        erpWarehouseId
      );

      return await respondFailure(
        "Almacén no encontrado",
        "No se pudo identificar un único almacén WMS para el almacén seleccionado."
      );

    }

    const warehouse =
      warehouseResult.rows[0];

    // ============================================================
    // 7. OBTENER ID INTERNO DEL ALMACÉN WMS
    //
    // warehouse.id = ID interno WMS
    // warehouse.erp_warehouse_id = GUID ADM CLOUD
    // ============================================================

    const wmsWarehouseId =
      Number(warehouse.id);

    if (
      !Number.isSafeInteger(wmsWarehouseId) ||
      wmsWarehouseId <= 0
    ) {

      return await respondFailure(
        "Almacén inválido",
        "El almacén seleccionado no tiene un ID interno WMS válido."
      );

    }

    console.log("");
    console.log(
      "✅ ALMACÉN WMS IDENTIFICADO:",
      {
        wmsWarehouseId,
        code: warehouse.code,
        name: warehouse.name,
        erpWarehouseId
      }
    );

    // ============================================================
    // 8. VALIDAR QUE NO EXISTAN SESIONES ACTIVAS
    //
    // Se mantiene la regla de una sola sesión.
    // ============================================================

    console.log("");
    console.log(
      "🔍 BUSCANDO SESIONES ACTIVAS"
    );

    const activeSessionResult =
      await client.query(
        `
        SELECT
          id,
          code,
          status

        FROM inventory_sessions

        WHERE status IN (
          'draft',
          'in-progress',
          'review'
        )

        ORDER BY created_at DESC

        LIMIT 1
        `
      );

    if (activeSessionResult.rowCount > 0) {

      const activeSession =
        activeSessionResult.rows[0];

      console.log(
        "⛔ SESIÓN ACTIVA:",
        {
          id: activeSession.id,
          code: activeSession.code,
          status: activeSession.status
        }
      );

      return await respondFailure(
        "Sesión activa encontrada",
        `Ya existe una sesión de inventario activa: ${activeSession.code}.`
      );

    }

    console.log(
      "✅ NO HAY SESIONES ACTIVAS"
    );

    // ============================================================
    // 9. LIMPIAR CONTEOS ANTERIORES
    //
    // NUEVA LÓGICA:
    //
    // Solamente se limpian los registros del
    // almacén seleccionado.
    //
    // NO SE MODIFICAN:
    // - Otros almacenes
    // - qty_on_hand
    // - qty_reserved
    // - qty_available
    //
    // SOLO SE LIMPIAN:
    // - inventory_quantity
    // - counted_by
    // - counted_at
    // - old_qty_on_hand
    // ============================================================

    console.log("");
    console.log("🧹 LIMPIANDO CONTEOS ANTERIORES");
    console.log(
      "🏬 ALMACÉN WMS:",
      wmsWarehouseId
    );

    console.log(
      "📦 ALMACÉN:",
      warehouse.name
    );

    const cleanInventoryResult =
      await client.query(
        `
        UPDATE inventory_by_location AS ibl

        SET

          inventory_quantity = NULL,

          counted_by = NULL,

          counted_at = NULL,

          old_qty_on_hand = NULL,

          updated_at = NOW()

        WHERE ibl.warehouse_id = $1

          AND (
               ibl.inventory_quantity IS NOT NULL

            OR ibl.counted_by IS NOT NULL

            OR ibl.counted_at IS NOT NULL

            OR ibl.old_qty_on_hand IS NOT NULL
          )
        `,
        [wmsWarehouseId]
      );

    const totalCleaned =
      cleanInventoryResult.rowCount;

    console.log("");
    console.log(
      "✅ CONTEOS ANTERIORES LIMPIADOS:"
    );

    console.log(
      "🏬 ALMACÉN WMS:",
      wmsWarehouseId
    );

    console.log(
      "📊 REGISTROS LIMPIADOS:",
      totalCleaned
    );

    console.log(
      "🛡️ LOS DEMÁS ALMACENES NO FUERON MODIFICADOS"
    );

    // ============================================================
    // 10. OBTENER CONFIGURACIÓN DE EMPRESA
    // ============================================================

    console.log("");
    console.log(
      "🏢 BUSCANDO EMPRESA ACTIVA"
    );

    const companyResult =
      await client.query(
        `
        SELECT
          inventory_adjustment_mode

        FROM companies

        WHERE is_active = true

        ORDER BY created_at ASC

        LIMIT 1
        `
      );

    if (companyResult.rowCount === 0) {

      console.error(
        "❌ EMPRESA ACTIVA NO ENCONTRADA"
      );

      return await respondFailure(
        "Empresa no encontrada",
        "No existe una empresa activa configurada."
      );

    }

    const adjustmentMode =
      companyResult.rows[0].inventory_adjustment_mode;

    console.log(
      "⚙️ INVENTORY MODE:",
      adjustmentMode
    );

    // ============================================================
    // 11. VALIDAR MODO DE AJUSTE
    // ============================================================

    if (
      adjustmentMode !== "final" &&
      adjustmentMode !== "immediate"
    ) {

      console.error(
        "❌ MODO DE AJUSTE INVÁLIDO:",
        adjustmentMode
      );

      return await respondFailure(
        "Configuración inválida",
        "El modo de ajuste de inventario no está configurado correctamente."
      );

    }

    console.log(
      "✅ MODO DE AJUSTE VÁLIDO"
    );

    // ============================================================
    // 12. CREAR NUEVA SESIÓN DE INVENTARIO
    //
    // La sesión almacena el GUID de ADM Cloud.
    // ============================================================

    console.log("");
    console.log(
      "📝 CREANDO SESIÓN DE INVENTARIO"
    );

    const sessionResult =
      await client.query(
        `
        INSERT INTO inventory_sessions (
          user_id,
          erp_warehouse_id
        )

        VALUES (
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

    const session =
      sessionResult.rows[0];

    if (!session) {
      throw new Error(
        "PostgreSQL no devolvió la sesión creada."
      );
    }

    console.log("");
    console.log(
      "✅ SESIÓN CREADA:",
      {
        sessionId: session.id,
        code: session.code,
        status: session.status,
        erpWarehouseId: session.erp_warehouse_id
      }
    );

    // ============================================================
    // 13. OBTENER NOMBRE DEL USUARIO
    // ============================================================

    console.log("");
    console.log(
      "👤 OBTENIENDO DATOS DEL USUARIO"
    );

    const userResult =
      await client.query(
        `
        SELECT
          id,
          full_name

        FROM users

        WHERE id = $1

        LIMIT 1
        `,
        [userId]
      );

    const user =
      userResult.rows[0] ?? null;

    console.log(
      "👤 USUARIO:",
      user?.full_name || "No disponible"
    );

    // ============================================================
    // 14. SINCRONIZAR EXISTENCIA DESDE ADM CLOUD
    //
    // Se conserva tu servicio actual.
    // Se envía el ID de la sesión recién creada.
    // ============================================================

    console.log("");
    console.log(
      "🔄 SINCRONIZANDO EXISTENCIA ADM CLOUD"
    );

    console.log(
      "🆔 SESSION ID:",
      session.id
    );

    console.log(
      "🏬 ALMACÉN WMS:",
      warehouse.name
    );

    console.log(
      "🌐 ERP LOCATION GUID:",
      erpWarehouseId
    );

    const syncResult =
      await runSyncExistenciaAlmacenOnce(
        client,
        session.id
      );

    // ============================================================
    // 15. VALIDAR RESULTADO DE SINCRONIZACIÓN
    // ============================================================

    if (!syncResult?.success) {

      console.error(
        "❌ ERROR SINCRONIZANDO INVENTARIO ADM CLOUD"
      );

      console.error(
        "📥 RESULTADO:",
        syncResult
      );

      return await respondFailure(
        "Error sincronizando inventario",
        syncResult?.message ||
        "No se pudo sincronizar la existencia del almacén."
      );

    }

    console.log("");
    console.log(
      "✅ EXISTENCIA SINCRONIZADA CORRECTAMENTE"
    );

    // ============================================================
    // 16. CONFIRMAR TRANSACCIÓN
    // ============================================================

    await client.query("COMMIT");

    transactionStarted = false;

    console.log("");
    console.log("🟩 ========================================");
    console.log("✅ SESIÓN CREADA CORRECTAMENTE");
    console.log("🟩 ========================================");

    console.log(
      "📄 SESSION CODE:",
      session.code
    );

    console.log(
      "🆔 SESSION ID:",
      session.id
    );

    console.log(
      "🏬 ALMACÉN WMS:",
      warehouse.name
    );

    console.log(
      "🌐 ERP LOCATION GUID:",
      erpWarehouseId
    );

    console.log(
      "🧹 CONTEOS ANTERIORES LIMPIADOS:",
      totalCleaned
    );

    console.log(
      "⚙️ MODO DE AJUSTE:",
      adjustmentMode
    );

    console.log(
      "🟩 ========================================"
    );

    // ============================================================
    // 17. RESPUESTA FINAL
    //
    // Se conserva el formato utilizado por el frontend.
    // ============================================================

    return res.status(200).json({

      success: true,

      title: "SESSION_CREATED",

      message:
        "Sesión de inventario creada correctamente.",

      hasActiveSession: true,

      adjustmentMode,

      warehouse: {

        id: warehouse.id,

        code: warehouse.code,

        name: warehouse.name,

        erp_warehouse_id:
          warehouse.erp_warehouse_id

      },

      session: {

        id: session.id,

        code: session.code,

        user_id: session.user_id,

        full_name:
          user?.full_name || "",

        erp_warehouse_id:
          session.erp_warehouse_id,

        status: session.status,

        start_date: session.start_date,

        end_date: session.end_date,

        created_at: session.created_at,

        updated_at: session.updated_at

      }

    });

  } catch (error) {

    // ============================================================
    // 18. MANEJO DE ERRORES
    // ============================================================

    console.error("");
    console.error(
      "🟥 ERROR CREANDO SESIÓN DE INVENTARIO"
    );

    console.error(error);

    if (transactionStarted) {

      try {

        await rollback();

      } catch (rollbackError) {

        console.error(
          "❌ ERROR EJECUTANDO ROLLBACK:",
          rollbackError
        );

      }

    }

    return res.status(200).json({

      success: false,

      title:
        "Error creando sesión",

      message:
        "Ocurrió un error al crear la sesión de inventario."

    });

  } finally {

    client.release();

    console.log(
      "🔌 CONEXIÓN POSTGRESQL LIBERADA"
    );

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














 // ============================================================
 // 🟨 SERVICIO INTERNO
 // GENERAR REPORTE FINAL EN POSTGRESQL
 //
 // NO GENERA EXCEL.
 // NO USA req NI res.
 // NO ENVÍA RESPUESTAS AL FRONTEND.
 //
 // SE EJECUTA DESPUÉS DE COMPLETAR UNA SESIÓN.
 // ============================================================

async function generateInventoryReportAfterReview(sessionId) {

  let client = null;
  let transactionStarted = false;

  try {

    console.log("");
    console.log("🟦🟦🟦 ========================================");
    console.log("📄 GENERANDO REPORTE FINAL AUTOMÁTICO");
    console.log("🆔 SESSION ID:", sessionId);
    console.log("🟦🟦🟦 ========================================");

    // ========================================================
    // 1. CONEXIÓN INDEPENDIENTE
    // ========================================================

    client = await db.connect();

    await client.query("BEGIN");
    transactionStarted = true;

    // Evita dos generaciones simultáneas
    // para la misma sesión.

    await client.query(
      `
      SELECT pg_advisory_xact_lock(
        94175,
        $1::integer
      )
      `,
      [Number(sessionId)]
    );

    // ========================================================
    // 2. OBTENER LA SESIÓN ESPECÍFICA
    // ========================================================

    const sessionResult = await client.query(
      `
      SELECT
        id,
        code,
        status,
        user_id,
        erp_warehouse_id,
        start_date,
        end_date

      FROM inventory_sessions

      WHERE id = $1::bigint

        AND status = 'review'

      LIMIT 1
      `,
      [sessionId]
    );

    if (sessionResult.rows.length === 0) {

      throw new Error(
        `La sesión ${sessionId} no existe o no está en review.`
      );
    }

    const session = sessionResult.rows[0];

    const erpWarehouseId = String(
      session.erp_warehouse_id ?? ""
    ).trim().toLowerCase();

    if (
      !erpWarehouseId ||
      !session.start_date ||
      !session.end_date
    ) {
      throw new Error(
        "La sesión no tiene almacén o fechas válidas."
      );
    }

    console.log("✅ SESIÓN IDENTIFICADA:", {
      id: session.id,
      code: session.code,
      status: session.status,
      erpWarehouseId
    });

    // ========================================================
    // 3. IDENTIFICAR ALMACÉN WMS
    // ========================================================

    const warehouseResult = await client.query(
      `
      SELECT
        id,
        code,
        name,
        erp_warehouse_id

      FROM warehouses

      WHERE LOWER(erp_warehouse_id::text) =
            LOWER($1::text)

      ORDER BY id ASC

      LIMIT 2
      `,
      [erpWarehouseId]
    );

    if (warehouseResult.rows.length !== 1) {

      throw new Error(
        "No se pudo identificar un único almacén WMS " +
        `para la sesión ${session.code}.`
      );
    }

    const warehouse = warehouseResult.rows[0];

    const wmsWarehouseId = Number(
      warehouse.id
    );

    console.log("🏬 ALMACÉN WMS:", {
      id: wmsWarehouseId,
      name: warehouse.name
    });

    // ========================================================
    // 4. GENERAR PRODUCTOS FÍSICAMENTE CONTADOS
    // ========================================================
    //
    // REGLAS:
    //
    // - Solo almacén de esta sesión.
    // - Solo conteos dentro de las fechas de sesión.
    // - Incluye conteos físicos de cero.
    // - Agrupa las cantidades por producto.
    // - Utiliza GUID de ADM Cloud como texto.
    //
    // ========================================================

    console.log("");
    console.log("🟨 GENERANDO PRODUCTOS CONTADOS");

    const countedProductsResult = await client.query(
      `
      WITH counted AS (

        SELECT
          ibl.product_sku,

          SUM(
            ibl.inventory_quantity
          )::numeric AS total_inventory_qty

        FROM inventory_by_location ibl

        WHERE ibl.warehouse_id = $2::bigint

          AND ibl.counted_by IS NOT NULL

          AND ibl.counted_at IS NOT NULL

          AND ibl.inventory_quantity IS NOT NULL

          AND ibl.counted_at >= $3::timestamptz

          AND ibl.counted_at <= $4::timestamptz

        GROUP BY ibl.product_sku
      ),

      prepared AS (

        SELECT
          p.erp_id::text AS erp_id,

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

          (
            eis.item_id IS NOT NULL
          ) AS exist_erp,

          false AS product_no_exist,

          true AS wms_counted

        FROM counted c

        INNER JOIN products p
          ON p.sku = c.product_sku

        LEFT JOIN LATERAL (

          SELECT
            item_id,
            erp_stock,
            unit_cost

          FROM erp_inventory_snapshot

          WHERE session_inventory_id = $1::bigint

            AND LOWER(item_id::text) =
                LOWER(p.erp_id::text)

          LIMIT 1

        ) eis ON TRUE

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

        sku = EXCLUDED.sku,

        erp_name = EXCLUDED.erp_name,

        erp_sku = EXCLUDED.erp_sku,

        description = EXCLUDED.description,

        total_inventory_qty =
          EXCLUDED.total_inventory_qty,

        erp_stock = EXCLUDED.erp_stock,

        unit_cost = EXCLUDED.unit_cost,

        exist_erp = EXCLUDED.exist_erp,

        product_no_exist =
          EXCLUDED.product_no_exist,

        wms_counted = true,

        updated_at = NOW()

      RETURNING
        erp_id,
        session_id,
        sku,
        total_inventory_qty,
        wms_counted
      `,
      [
        sessionId,
        wmsWarehouseId,
        session.start_date,
        session.end_date
      ]
    );

    const countedProducts =
      countedProductsResult.rows;

    console.log(
      "✅ PRODUCTOS CONTADOS:",
      countedProducts.length
    );

    // ========================================================
    // 5. OBTENER GUIDS DE PRODUCTOS CONTADOS
    // ========================================================

    const countedErpIds = countedProducts.map(
      item =>
        String(item.erp_id)
          .trim()
          .toLowerCase()
    );

    // ========================================================
    // 6. GENERAR PRODUCTOS ERP NO CONTADOS
    // ========================================================
    //
    // REGLAS:
    //
    // - Solo snapshot de esta sesión.
    // - Stock ERP diferente de cero.
    // - No incluir productos contados.
    // - Cantidad física = 0.
    // - wms_counted = false.
    //
    // IMPORTANTE:
    // Este paso SOLO genera el reporte.
    // NO modifica las existencias reales del WMS.
    // NO realiza ajustes en ADM Cloud.
    //
    // ========================================================

    console.log("");
    console.log("🟨 GENERANDO PRODUCTOS NO CONTADOS");

    const missingProductsResult = await client.query(
      `
      WITH snapshot_items AS (

        SELECT DISTINCT ON (
          LOWER(eis.item_id::text)
        )

          eis.item_id::text AS erp_id,

          COALESCE(
            eis.erp_stock,
            0
          )::numeric AS erp_stock,

          COALESCE(
            eis.unit_cost,
            0
          )::numeric AS unit_cost

        FROM erp_inventory_snapshot eis

        WHERE eis.session_inventory_id = $1::bigint

          AND eis.item_id IS NOT NULL

          AND COALESCE(
            eis.erp_stock,
            0
          ) <> 0

        ORDER BY
          LOWER(eis.item_id::text)

      ),

      missing AS (

        SELECT

          si.erp_id,

          $1::bigint AS session_id,

          p.sku,
          p.erp_name,
          p.erp_sku,
          p.description,

          0::numeric AS total_inventory_qty,

          si.erp_stock,
          si.unit_cost,

          true AS exist_erp,

          (
            p.sku IS NULL
          ) AS product_no_exist,

          false AS wms_counted

        FROM snapshot_items si

        LEFT JOIN LATERAL (

          SELECT
            sku,
            erp_name,
            erp_sku,
            description

          FROM products

          WHERE LOWER(erp_id::text) =
                LOWER(si.erp_id)

          ORDER BY id ASC

          LIMIT 1

        ) p ON TRUE

        WHERE LOWER(si.erp_id) <> ALL(
          $2::text[]
        )

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

      FROM missing

      ON CONFLICT (
        erp_id,
        session_id
      )

      DO UPDATE SET

        sku = EXCLUDED.sku,

        erp_name = EXCLUDED.erp_name,

        erp_sku = EXCLUDED.erp_sku,

        description = EXCLUDED.description,

        total_inventory_qty =
          EXCLUDED.total_inventory_qty,

        erp_stock = EXCLUDED.erp_stock,

        unit_cost = EXCLUDED.unit_cost,

        exist_erp = EXCLUDED.exist_erp,

        product_no_exist =
          EXCLUDED.product_no_exist,

        wms_counted =
          EXCLUDED.wms_counted,

        updated_at = NOW()

      WHERE inventory_erp_report.wms_counted
            IS DISTINCT FROM TRUE

      RETURNING
        erp_id,
        session_id,
        sku,
        erp_stock,
        wms_counted
      `,
      [
        sessionId,
        countedErpIds
      ]
    );

    const missingProducts =
      missingProductsResult.rows;

    console.log(
      "✅ PRODUCTOS NO CONTADOS:",
      missingProducts.length
    );

    // ========================================================
    // 7. OBTENER RESUMEN FINAL DESDE POSTGRESQL
    // ========================================================

    const summaryResult = await client.query(
      `
      SELECT

        COUNT(*)::integer AS total_products,

        COUNT(*) FILTER (
          WHERE wms_counted IS TRUE
        )::integer AS counted_products,

        COUNT(*) FILTER (
          WHERE wms_counted IS FALSE
        )::integer AS missing_products

      FROM inventory_erp_report

      WHERE session_id = $1::bigint
      `,
      [sessionId]
    );

    const summary = summaryResult.rows[0];

    // ========================================================
    // 8. CONFIRMAR TODOS LOS CAMBIOS
    // ========================================================

    await client.query("COMMIT");
    transactionStarted = false;

    console.log("");
    console.log("🟩🟩🟩 ========================================");
    console.log("✅ REPORTE FINAL GUARDADO EN POSTGRESQL");
    console.log("🆔 SESSION:", session.code);
    console.log("📦 TOTAL PRODUCTOS:", summary.total_products);
    console.log("✅ CONTADOS:", summary.counted_products);
    console.log("🟨 NO CONTADOS:", summary.missing_products);
    console.log("🟩🟩🟩 ========================================");

    return {
      success: true,
      sessionId,
      sessionCode: session.code,
      totalProducts: Number(
        summary.total_products
      ),
      countedProducts: Number(
        summary.counted_products
      ),
      missingProducts: Number(
        summary.missing_products
      )
    };

  } catch (error) {

    if (client && transactionStarted) {

      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error(
          "❌ ERROR EN ROLLBACK DEL REPORTE:",
          rollbackError
        );
      }
    }

    console.error("");
    console.error("🟥 ========================================");
    console.error("❌ ERROR GENERANDO REPORTE AUTOMÁTICO");
    console.error("🆔 SESSION:", sessionId);
    console.error(error);
    console.error("🟥 ========================================");

    return {
      success: false,
      sessionId,
      message:
        error instanceof Error
          ? error.message
          : String(error)
    };

  } finally {

    if (client) {
      client.release();
    }
  }
}


// ============================================================
// 🟨 CONTROLLER
// FINALIZAR SESIÓN DE INVENTARIO
//
// 1. CAMBIA SESIÓN A REVIEW.
// 2. RESPONDE AL FRONTEND.
// 3. GENERA AUTOMÁTICAMENTE EL REPORTE EN POSTGRESQL.
// 4. NO GENERA EXCEL.
// ============================================================

export async function completeInventorySession(req, res) {

  const client = await db.connect();

  let transactionStarted = false;

  try {

    console.log("");
    console.log("🟦🟦🟦 ========================================");
    console.log("🟨 INVENTORY MONITOR");
    console.log("✅ COMPLETANDO SESIÓN");
    console.log("🟦🟦🟦 ========================================");

    // ========================================================
    // 1. VALIDAR DATOS
    // ========================================================

    const sessionId = Number(
      req.body?.id
    );

    const userId = Number(
      req.user?.id
    );

    console.log("📥 SESSION ID:", sessionId);
    console.log("👤 USER ID:", userId);

    if (
      !Number.isSafeInteger(sessionId) ||
      sessionId <= 0
    ) {

      return res.status(200).json({
        success: false,
        title: "ID requerido",
        message:
          "Debe enviar un ID de sesión válido."
      });
    }

    if (
      !Number.isSafeInteger(userId) ||
      userId <= 0
    ) {

      return res.status(200).json({
        success: false,
        title: "Usuario inválido",
        message:
          "No se pudo identificar el usuario autenticado."
      });
    }

    // ========================================================
    // 2. INICIAR TRANSACCIÓN
    // ========================================================

    await client.query("BEGIN");
    transactionStarted = true;

    // ========================================================
    // 3. BUSCAR SESIÓN Y BLOQUEARLA
    // ========================================================

    console.log("🔍 BUSCANDO SESIÓN");

    const sessionResult = await client.query(
      `
      SELECT
        id,
        code,
        status,
        user_id,
        erp_warehouse_id,
        start_date,
        end_date

      FROM inventory_sessions

      WHERE id = $1::bigint

      FOR UPDATE
      `,
      [sessionId]
    );

    if (sessionResult.rows.length === 0) {

      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(200).json({
        success: false,
        title: "Sesión no encontrada",
        message:
          "La sesión indicada no existe."
      });
    }

    const session = sessionResult.rows[0];

    console.log("📋 SESIÓN:", {
      code: session.code,
      status: session.status,
      erpWarehouseId: session.erp_warehouse_id
    });

    // ========================================================
    // 4. VALIDAR ESTADO
    // ========================================================

    if (
      !["in-progress", "review"].includes(
        session.status
      )
    ) {

      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(200).json({
        success: false,
        title: "Estado inválido",
        message:
          "La sesión debe estar en estado in-progress o review."
      });
    }

    // ========================================================
    // 5. NO MODIFICAR UNA SESIÓN YA COMPLETADA
    // ========================================================
    //
    // Si ya está en review:
    // - No actualizar end_date.
    // - No recalcular estadísticas.
    // - No generar nuevamente el reporte.
    //
    // ========================================================

    if (session.status === "review") {

      await client.query("COMMIT");
      transactionStarted = false;

      return res.status(200).json({
        success: true,
        title: "SESSION_ALREADY_COMPLETED",
        message:
          "La sesión ya se encuentra en revisión.",

        hasActiveSession: true,

        session: {
          id: session.id,
          code: session.code,
          status: session.status,
          end_date: session.end_date
        }
      });
    }

    // ========================================================
    // 6. IDENTIFICAR ALMACÉN WMS
    // ========================================================

    const warehouseResult = await client.query(
      `
      SELECT
        id,
        code,
        name

      FROM warehouses

      WHERE LOWER(erp_warehouse_id::text) =
            LOWER($1::text)

      ORDER BY id ASC

      LIMIT 2
      `,
      [
        String(session.erp_warehouse_id)
      ]
    );

    if (warehouseResult.rows.length !== 1) {

      throw new Error(
        "No se pudo identificar un único almacén WMS."
      );
    }

    const warehouse = warehouseResult.rows[0];

    const wmsWarehouseId = Number(
      warehouse.id
    );

    // ========================================================
    // 7. CALCULAR ESTADÍSTICAS DE ESTA SESIÓN
    // ========================================================
    //
    // ANTES:
    // Buscaba todos los almacenes y todas las sesiones.
    //
    // AHORA:
    // - Solo el almacén de esta sesión.
    // - Solo conteos dentro del período.
    // - Incluye conteos físicos de cero.
    //
    // ========================================================

    console.log("");
    console.log("📊 CALCULANDO ESTADÍSTICAS DE SESIÓN");

    const statisticsResult = await client.query(
      `
      SELECT

        COUNT(*) FILTER (

          WHERE counted_by IS NOT NULL

            AND counted_at IS NOT NULL

            AND inventory_quantity IS NOT NULL

            AND counted_at >= $2::timestamptz

            AND counted_at <= NOW()

        )::integer AS counted_locations,

        COUNT(*) FILTER (

          WHERE counted_by IS NOT NULL

            AND counted_at IS NOT NULL

            AND inventory_quantity IS NOT NULL

            AND counted_at >= $2::timestamptz

            AND counted_at <= NOW()

            AND inventory_quantity
                IS DISTINCT FROM qty_on_hand

        )::integer AS difference_locations,

        COUNT(*) FILTER (

          WHERE COALESCE(qty_on_hand, 0) <> 0

            AND NOT (

              counted_by IS NOT NULL

              AND counted_at IS NOT NULL

              AND inventory_quantity IS NOT NULL

              AND counted_at >= $2::timestamptz

              AND counted_at <= NOW()

            )

        )::integer AS pending_locations

      FROM inventory_by_location

      WHERE warehouse_id = $1::bigint
      `,
      [
        wmsWarehouseId,
        session.start_date
      ]
    );

    const stats = statisticsResult.rows[0];

    const countedLocations = Number(
      stats.counted_locations ?? 0
    );

    const differenceLocations = Number(
      stats.difference_locations ?? 0
    );

    const pendingLocations = Number(
      stats.pending_locations ?? 0
    );

    console.log("📍 UBICACIONES CONTADAS:", countedLocations);
    console.log("⚠️ DIFERENCIAS:", differenceLocations);
    console.log("⏳ UBICACIONES PENDIENTES:", pendingLocations);

    // ========================================================
    // 8. ACTUALIZAR SESIÓN A REVIEW
    // ========================================================

    console.log("");
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

      WHERE id = $1::bigint

        AND status = 'in-progress'

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
        sessionId,
        countedLocations,
        pendingLocations,
        differenceLocations,
        userId
      ]
    );

    if (updateResult.rows.length !== 1) {

      throw new Error(
        "No se pudo cambiar la sesión a review."
      );
    }

    const updatedSession = updateResult.rows[0];

    // ========================================================
    // 9. CONFIRMAR TRANSACCIÓN
    // ========================================================

    await client.query("COMMIT");
    transactionStarted = false;

    console.log("");
    console.log("🟩 ========================================");
    console.log("✅ SESIÓN COMPLETADA");
    console.log("🆔 SESIÓN:", updatedSession.code);
    console.log("📍 CONTADAS:", countedLocations);
    console.log("⚠️ DIFERENCIAS:", differenceLocations);
    console.log("⏳ PENDIENTES:", pendingLocations);
    console.log("🟩 ========================================");

    // ========================================================
    // 10. PROGRAMAR REPORTE DESPUÉS DE LA RESPUESTA HTTP
    // ========================================================
    //
    // La generación:
    //
    // - Se ejecuta al terminar de enviar la respuesta.
    // - Utiliza otra conexión PostgreSQL.
    // - No tiene acceso a res.
    // - No genera Excel.
    // - No modifica cantidades reales de inventario.
    //
    // ========================================================

    res.once("finish", () => {

      setImmediate(() => {

        generateInventoryReportAfterReview(
          sessionId
        )
          .then(result => {

            if (result.success) {

              console.log("");
              console.log(
                "✅ REPORTE AUTOMÁTICO COMPLETADO:",
                result
              );

            } else {

              console.error("");
              console.error(
                "❌ REPORTE AUTOMÁTICO FALLIDO:",
                result
              );
            }

          })
          .catch(error => {

            console.error("");
            console.error(
              "🟥 ERROR NO CONTROLADO GENERANDO REPORTE:",
              error
            );

          });

      });

    });

    // ========================================================
    // 11. RESPONDER INMEDIATAMENTE AL FRONTEND
    // ========================================================

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

    if (transactionStarted) {

      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error(
          "❌ ERROR EJECUTANDO ROLLBACK:",
          rollbackError
        );
      }
    }

    console.error("");
    console.error(
      "🟥 ERROR COMPLETANDO SESIÓN"
    );
    console.error(error);

    return res.status(200).json({
      success: false,
      title: "Error completando sesión",
      message:
        "Ocurrió un error completando la sesión."
    });

  } finally {

    client.release();

    console.log(
      "🔌 CONEXIÓN POSTGRESQL LIBERADA"
    );

  }
}














/* Finaliza el conteo de inventario y mueve la sesión a estado review.
export async function completeInventorySession(req, res) {
  const client = await db.connect();

  try {

    console.log("🟦🟦🟦 ================================");
    console.log("🟨 INVENTORY MONITOR");
    console.log("✅ COMPLETANDO SESIÓN");

    const { id } = req.body;
    //const userId = 1;
    const userId = Number(req.user?.id);

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
}*/










export async function getInventoryFinalReport(req, res) {

  const client = await db.connect();

  let transactionStarted = false;
  let committed = false;

  try {

    console.log("");
    console.log("🟦🟦🟦 ================================");
    console.log("📄 INVENTORY REPORT");
    console.log("📌 GENERANDO REPORTE FINAL ADM CLOUD");
    console.log("🟦🟦🟦 ================================");

    // ==========================================================
    // 1. INICIAR TRANSACCIÓN
    // ==========================================================

    await client.query("BEGIN");
    transactionStarted = true;

    // ==========================================================
    // 2. BUSCAR ÚLTIMA SESIÓN EN REVIEW
    // ==========================================================

    const sessionResult = await client.query(`
      SELECT
        id,
        code,
        status,
        user_id,
        start_date,
        end_date,
        erp_warehouse_id,
        created_at,
        updated_at
      FROM inventory_sessions
      WHERE status = 'review'
      ORDER BY updated_at DESC
      LIMIT 1
    `);

    const reviewSession = sessionResult.rows[0];

    if (!reviewSession) {

      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(200).json({
        success: false,
        title: "No hay sesión en revisión",
        message:
          "No existe una sesión de inventario en estado review."
      });
    }

    const sessionId = Number(reviewSession.id);

    if (
      !Number.isSafeInteger(sessionId) ||
      sessionId <= 0
    ) {
      throw new Error(
        "El ID de la sesión de inventario es inválido."
      );
    }

    console.log("✅ SESIÓN REVIEW:", {
      sessionId,
      code: reviewSession.code,
      status: reviewSession.status,
      erpWarehouseId: reviewSession.erp_warehouse_id
    });

    // ==========================================================
    // 3. VALIDAR ALMACÉN DE LA SESIÓN
    // ==========================================================

    const warehouseResult = await client.query(
      `
      SELECT
        w.id,
        w.code,
        w.name,
        w.erp_warehouse_id
      FROM warehouses w
      WHERE LOWER(w.erp_warehouse_id::text) =
            LOWER($1::text)
      ORDER BY w.id
      `,
      [
        String(reviewSession.erp_warehouse_id)
      ]
    );

    if (warehouseResult.rows.length !== 1) {

      throw new Error(
        "La sesión debe corresponder a exactamente " +
        "un almacén WMS. Coincidencias: " +
        warehouseResult.rows.length
      );
    }

    const warehouse = warehouseResult.rows[0];

    console.log("🏬 ALMACÉN WMS:", {
      id: warehouse.id,
      code: warehouse.code,
      name: warehouse.name,
      erpWarehouseId: warehouse.erp_warehouse_id
    });

    // ==========================================================
    // 4. PRODUCTOS CONTADOS EN ESTA SESIÓN
    // ==========================================================
    //
    // IMPORTANTE:
    // - Filtra por almacén WMS.
    // - Filtra por fechas de la sesión.
    // - Conserva los ERP IDs como texto.
    // - Suma cantidades por SKU.
    // ==========================================================

    console.log("");
    console.log("🟨 OBTENIENDO PRODUCTOS CONTADOS");

    const countedProductsResult = await client.query(
      `
      WITH target_session AS (

        SELECT
          s.id,
          s.start_date,
          s.end_date,
          $2::bigint AS warehouse_id

        FROM inventory_sessions s

        WHERE s.id = $1::bigint
          AND s.status = 'review'
          AND s.start_date IS NOT NULL

      ),

      counted AS (

        SELECT
          ibl.product_sku,

          SUM(
            COALESCE(
              ibl.inventory_quantity,
              0
            )
          )::numeric AS total_inventory_qty

        FROM inventory_by_location ibl

        INNER JOIN target_session ts
          ON ts.warehouse_id = ibl.warehouse_id

        WHERE ibl.counted_by IS NOT NULL
          AND ibl.counted_at IS NOT NULL

          AND ibl.counted_at >= ts.start_date

          AND (
            ts.end_date IS NULL
            OR ibl.counted_at <= ts.end_date
          )

        GROUP BY ibl.product_sku

      ),

      prepared AS (

        SELECT
          p.erp_id::text AS erp_id,

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
            WHEN eis.item_id IS NULL THEN false
            ELSE true
          END AS exist_erp,

          false AS product_no_exist,

          true AS wms_counted

        FROM counted c

        INNER JOIN products p
          ON p.sku = c.product_sku

        LEFT JOIN erp_inventory_snapshot eis
          ON LOWER(eis.item_id::text) =
             LOWER(p.erp_id::text)

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

      ON CONFLICT (erp_id, session_id)

      DO UPDATE SET

        sku = EXCLUDED.sku,

        erp_name = EXCLUDED.erp_name,

        erp_sku = EXCLUDED.erp_sku,

        description = EXCLUDED.description,

        total_inventory_qty =
          EXCLUDED.total_inventory_qty,

        erp_stock = EXCLUDED.erp_stock,

        unit_cost = EXCLUDED.unit_cost,

        exist_erp = EXCLUDED.exist_erp,

        product_no_exist =
          EXCLUDED.product_no_exist,

        wms_counted = EXCLUDED.wms_counted,

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
        product_no_exist,
        wms_counted
      `,
      [
        sessionId,
        warehouse.id
      ]
    );

    const countedProducts =
      countedProductsResult.rows;

    // ==========================================================
    // 5. OBTENER ERP IDS SIN CONVERTIRLOS A NUMBER
    // ==========================================================

    const wmsIds = countedProducts.map(
      item =>
        String(item.erp_id)
          .trim()
          .toLowerCase()
    );

    console.log(
      "📦 TOTAL PRODUCTOS CONTADOS WMS:",
      countedProducts.length
    );

    console.log(
      "🆔 TOTAL ERP IDS EN WMS:",
      wmsIds.length
    );

    // ==========================================================
    // 6. PRODUCTOS ERP CON STOCK NO CONTADOS
    // ==========================================================

    console.log("");
    console.log(
      "🟨 OBTENIENDO PRODUCTOS ERP NO CONTADOS"
    );

    const productsMissingResult = await client.query(
      `
      WITH missing AS (

        SELECT

          eis.item_id::text AS erp_id,

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
            WHEN p.sku IS NULL THEN true
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

          WHERE LOWER(erp_id::text) =
                LOWER(eis.item_id::text)

          LIMIT 1

        ) p ON true

        WHERE eis.session_inventory_id = $1

          AND eis.item_id IS NOT NULL

          AND COALESCE(
            eis.erp_stock,
            0
          ) <> 0

          AND NOT (
            LOWER(eis.item_id::text) =
            ANY($2::text[])
          )

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

      FROM missing

      ON CONFLICT (erp_id, session_id)

      DO UPDATE SET

        sku = EXCLUDED.sku,

        erp_name = EXCLUDED.erp_name,

        erp_sku = EXCLUDED.erp_sku,

        description = EXCLUDED.description,

        total_inventory_qty =
          EXCLUDED.total_inventory_qty,

        erp_stock = EXCLUDED.erp_stock,

        unit_cost = EXCLUDED.unit_cost,

        exist_erp = EXCLUDED.exist_erp,

        product_no_exist =
          EXCLUDED.product_no_exist,

        wms_counted = EXCLUDED.wms_counted,

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
        exist_erp,
        wms_counted
      `,
      [
        sessionId,
        wmsIds
      ]
    );

    const productsMissing =
      productsMissingResult.rows;

    console.log(
      "🟥 PRODUCTOS ERP CON BALANCE NO CONTADOS:",
      productsMissing.length
    );

    // ==========================================================
    // 7. GENERAR EXCEL
    // ==========================================================

    console.log("");
    console.log(
      "📄 GENERANDO ARCHIVO EXCEL"
    );

    const result =
      await getInventoryFinalReportExcelService(
        client,
        sessionId
      );

    if (!result.success) {

      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(200).json(result);
    }

    if (
      !Buffer.isBuffer(result.buffer)
    ) {

      throw new Error(
        "El servicio Excel no devolvió un Buffer válido."
      );
    }

    // ==========================================================
    // 8. CONFIRMAR TRANSACCIÓN
    // ==========================================================

    await client.query("COMMIT");

    transactionStarted = false;
    committed = true;

    console.log("");
    console.log("🟩 ========================================");
    console.log("✅ REPORTE FINAL GENERADO");
    console.log("🆔 SESSION:", sessionId);
    console.log("📦 PRODUCTOS CONTADOS:", countedProducts.length);
    console.log("📦 PRODUCTOS NO CONTADOS:", productsMissing.length);
    console.log("🟩 ========================================");

    // ==========================================================
    // 9. DESCARGAR EXCEL
    // ==========================================================

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

    // ==========================================================
    // 10. MANEJO DE ERRORES
    // ==========================================================

    if (
      transactionStarted &&
      !committed
    ) {

      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {

        console.error(
          "🟥 ERROR HACIENDO ROLLBACK:",
          rollbackError
        );
      }
    }

    console.error("");
    console.error(
      "🟥 ERROR GENERANDO REPORTE FINAL"
    );

    console.error(
      "🟥 ERROR CODE:",
      error.code
    );

    console.error(
      "🟥 ERROR MESSAGE:",
      error.message
    );

    console.error(
      "🟥 ERROR COMPLETO:",
      error
    );

    return res.status(500).json({
      success: false,

      title:
        "Error generando reporte",

      message:
        "Ocurrió un error al generar el " +
        "reporte final de inventario.",

      code:
        error.code || null
    });

  } finally {

    client.release();

  }
}








// ============================================================
// OBTENER REPORTE DETALLADO DE UNA SESIÓN
//
// POST /api/inventory/report/session/details
//
// BODY:
// {
//   "sessionId": 26,
//   "code": "INV-00026",
//   "erpWarehouseId": "GUID-del-almacen"
// }
//
// LEE inventory_erp_report.
// NO REGENERA EL REPORTE.
// NO MODIFICA INVENTARIO.
// ============================================================

export async function getInventoryReportSessionDetails(req, res) {

  const sessionId = Number(req.body?.sessionId);

  const code = String(
    req.body?.code ?? ""
  ).trim();

  const erpWarehouseId = String(
    req.body?.erpWarehouseId ?? ""
  ).trim().toLowerCase();

  if (
    !Number.isSafeInteger(sessionId) ||
    sessionId <= 0 ||
    !code ||
    !erpWarehouseId
  ) {
    return res.status(400).json({
      success: false,
      message: "Los datos de la sesión son inválidos."
    });
  }

  let client;

  try {

    client = await db.connect();

    console.log("");
    console.log("🟦 ========================================");
    console.log("📄 CONSULTANDO REPORTE DE SESIÓN");
    console.log("🆔 SESSION ID:", sessionId);
    console.log("📋 CODE:", code);
    console.log("🏬 ERP WAREHOUSE:", erpWarehouseId);
    console.log("🟦 ========================================");

    // ========================================================
    // 1. VALIDAR LA SESIÓN CONTRA POSTGRESQL
    // ========================================================

    const sessionResult = await client.query(
      `
      SELECT
        s.id,
        s.code,
        s.status,
        s.user_id,
        s.erp_warehouse_id,
        s.start_date,
        s.end_date,
        s.created_at,
        s.updated_at,

        u.full_name AS user_full_name,

        w.name AS warehouse_name

      FROM inventory_sessions s

      LEFT JOIN users u
        ON u.id = s.user_id

      LEFT JOIN LATERAL (

        SELECT name
        FROM warehouses
        WHERE LOWER(erp_warehouse_id::text) =
              LOWER(s.erp_warehouse_id::text)

          AND status = 'ACTIVE'

        ORDER BY id
        LIMIT 1

      ) w ON TRUE

      WHERE s.id = $1::bigint

      LIMIT 1
      `,
      [sessionId]
    );

    if (sessionResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "La sesión de inventario no existe."
      });
    }

    const session = sessionResult.rows[0];

    // Nunca confiar únicamente en el frontend.
    // Confirmar código y almacén reales.

    if (
      session.code !== code ||
      String(session.erp_warehouse_id ?? "")
        .trim()
        .toLowerCase() !== erpWarehouseId
    ) {
      return res.status(409).json({
        success: false,
        message:
          "Los datos recibidos no coinciden con la sesión almacenada."
      });
    }

    const allowedStatuses = [
      "review",
      "posted",
      "completed"
    ];

    if (!allowedStatuses.includes(session.status)) {
      return res.status(409).json({
        success: false,
        message:
          "Esta sesión todavía no tiene un reporte final disponible."
      });
    }

    // ========================================================
    // 2. OBTENER SOLO LAS LÍNEAS DE ESTA SESIÓN
    // ========================================================

    const productsResult = await client.query(
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
        wms_counted,
        created_at,
        updated_at

      FROM inventory_erp_report

      WHERE session_id = $1::bigint

      ORDER BY
        wms_counted DESC NULLS LAST,
        sku ASC NULLS LAST,
        id ASC
      `,
      [sessionId]
    );

    const products = productsResult.rows;

    // El reporte se prepara automáticamente cuando
    // la sesión entra a review. Si todavía no hay
    // líneas, el frontend podrá intentar nuevamente.

    if (products.length === 0) {
      return res.status(409).json({
        success: false,
        message:
          "El reporte todavía no está disponible. " +
          "Puede intentar nuevamente en unos momentos."
      });
    }

    // ========================================================
    // 3. CALCULAR ESTADÍSTICAS
    // ========================================================

    const totalProducts = products.length;

    const countedProducts = products.filter(
      product => product.wms_counted === true
    ).length;

    const notCountedProducts = products.filter(
      product => product.wms_counted === false
    ).length;

    const lossProducts = products.filter(
      product => Number(product.difference) < 0
    ).length;

    const gainProducts = products.filter(
      product => Number(product.difference) > 0
    ).length;

    const matchedProducts = products.filter(
      product => Number(product.difference) === 0
    ).length;

    const summary = {
      total_products: totalProducts,
      counted_products: countedProducts,
      not_counted_products: notCountedProducts,
      loss_products: lossProducts,
      gain_products: gainProducts,
      matched_products: matchedProducts
    };

    console.log("✅ REPORTE OBTENIDO:", {
      sessionId,
      code: session.code,
      ...summary
    });

    // ========================================================
    // 4. RESPONDER AL FRONTEND
    // ========================================================

    return res.status(200).json({
      success: true,
      message: "Reporte de inventario obtenido correctamente.",
      session,
      summary,
      products
    });

  } catch (error) {

    console.error(
      "🟥 ERROR CONSULTANDO REPORTE DE SESIÓN:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Ocurrió un error consultando el reporte de inventario."
    });

  } finally {

    if (client) {
      client.release();
    }
  }
}


// ============================================================
// DESCARGAR EXCEL DE UNA SESIÓN ESPECÍFICA
//
// GET /api/inventory/report/session/:sessionId/excel
//
// REUTILIZA:
// getInventoryFinalReportExcelService(client, sessionId)
//
// NO BUSCA LA ÚLTIMA SESIÓN EN REVIEW.
// NO REGENERA inventory_erp_report.
// NO MODIFICA EXISTENCIAS WMS.
// ============================================================

export async function downloadInventoryReportSessionExcel(req, res) {

  const sessionId = Number(
    req.params?.sessionId
  );

  if (
    !Number.isSafeInteger(sessionId) ||
    sessionId <= 0
  ) {
    return res.status(400).json({
      success: false,
      message: "El ID de la sesión es inválido."
    });
  }

  let client;
  let transactionStarted = false;

  try {

    client = await db.connect();

    console.log("");
    console.log("🟦 ========================================");
    console.log("📊 DESCARGANDO EXCEL HISTÓRICO");
    console.log("🆔 SESSION ID:", sessionId);
    console.log("🟦 ========================================");

    await client.query("BEGIN");
    transactionStarted = true;

    // ========================================================
    // 1. VALIDAR SESIÓN
    // ========================================================

    const sessionResult = await client.query(
      `
      SELECT
        id,
        code,
        status
      FROM inventory_sessions
      WHERE id = $1::bigint
      LIMIT 1
      `,
      [sessionId]
    );

    if (sessionResult.rows.length === 0) {

      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(404).json({
        success: false,
        message: "La sesión no existe."
      });
    }

    const session = sessionResult.rows[0];

    if (!["review", "posted", "completed"].includes(
      session.status
    )) {

      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(409).json({
        success: false,
        message:
          "Esta sesión no tiene un reporte final disponible."
      });
    }

    // ========================================================
    // 2. CONFIRMAR QUE EL REPORTE EXISTE
    // ========================================================

    const reportResult = await client.query(
      `
      SELECT COUNT(*)::integer AS total
      FROM inventory_erp_report
      WHERE session_id = $1::bigint
      `,
      [sessionId]
    );

    const total = Number(
      reportResult.rows[0]?.total ?? 0
    );

    if (total === 0) {

      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(409).json({
        success: false,
        message:
          "No existen datos de reporte para esta sesión."
      });
    }

    // ========================================================
    // 3. REUTILIZAR SERVICIO EXCEL EXISTENTE
    // ========================================================

    console.log(
      "📄 GENERANDO EXCEL DE:",
      session.code
    );

    const result =
      await getInventoryFinalReportExcelService(
        client,
        sessionId
      );

    if (!result.success) {

      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(500).json({
        success: false,
        message:
          result.message ||
          "No se pudo generar el archivo Excel."
      });
    }

    if (!Buffer.isBuffer(result.buffer)) {
      throw new Error(
        "El servicio Excel no devolvió un Buffer válido."
      );
    }

    await client.query("COMMIT");
    transactionStarted = false;

    // ========================================================
    // 4. RESPONDER EXCEL
    // ========================================================

    const safeCode = String(session.code)
      .replace(/[^a-zA-Z0-9_-]/g, "_");

    const fileName =
      `reporte-inventario-${safeCode}.xlsx`;

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${fileName}"`
    );

    console.log(
      "✅ DESCARGA DE REPORTE PREPARADA:",
      fileName
    );

    return res.send(result.buffer);

  } catch (error) {

    if (client && transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error(
          "🟥 ERROR EN ROLLBACK:",
          rollbackError
        );
      }
    }

    console.error(
      "🟥 ERROR DESCARGANDO EXCEL HISTÓRICO:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Ocurrió un error generando el Excel de la sesión."
    });

  } finally {

    if (client) {
      client.release();
    }
  }
}





// Obtener el reporte de inventario por ubicaciones
export async function getInventoryLocationsReport(req, res) {

  let client = null;
  let transactionStarted = false;

  // ============================================================
  // HELPER - ROLLBACK SEGURO
  // ============================================================

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

    console.log("");
    console.log("🟦🟦🟦 ========================================");
    console.log("📄 CREANDO REPORTE DE INVENTARIO FÍSICO");
    console.log("📌 INCLUYENDO UBICACIONES DE LA SESIÓN");
    console.log("🟦🟦🟦 ========================================");

    // ==========================================================
    // 1. OBTENER CONEXIÓN
    // ==========================================================

    client = await db.connect();

    await client.query("BEGIN");
    transactionStarted = true;

    // ==========================================================
    // 2. BUSCAR SESIÓN ACTIVA MÁS RECIENTE
    // ==========================================================

    const sessionResult = await client.query(`
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
      WHERE status IN (
        'draft',
        'in-progress',
        'review'
      )
      ORDER BY updated_at DESC
      LIMIT 1
    `);

    if (sessionResult.rows.length === 0) {

      await rollbackTransaction();

      return res.status(200).json({
        success: false,
        title: "No hay sesión de inventario",
        message:
          "No existe una sesión de inventario activa " +
          "para generar el reporte."
      });
    }

    const activeSession = sessionResult.rows[0];

    console.log("📌 SESIÓN SELECCIONADA:", {
      id: activeSession.id,
      code: activeSession.code,
      status: activeSession.status,
      erpWarehouseId: activeSession.erp_warehouse_id
    });

    // ==========================================================
    // 3. VALIDAR ESTADO REVIEW
    // ==========================================================

    if (activeSession.status !== "review") {

      await rollbackTransaction();

      return res.status(200).json({
        success: false,
        title: "Sesión no está en revisión",
        message:
          `La sesión ${activeSession.code} está en estado ` +
          `"${activeSession.status}". ` +
          "Debe estar en estado review."
      });
    }

    const sessionId = Number(activeSession.id);

    if (
      !Number.isSafeInteger(sessionId) ||
      sessionId <= 0
    ) {
      throw new Error(
        "El ID de la sesión es inválido."
      );
    }

    const erpWarehouseId = String(
      activeSession.erp_warehouse_id ?? ""
    ).trim();

    if (!erpWarehouseId) {
      throw new Error(
        "La sesión no tiene un almacén ERP asociado."
      );
    }

    if (!activeSession.start_date) {
      throw new Error(
        "La sesión no tiene fecha de inicio."
      );
    }

    // ==========================================================
    // 4. IDENTIFICAR ALMACÉN WMS DE LA SESIÓN
    // ==========================================================

    const warehouseResult = await client.query(
      `
      SELECT
        id,
        code,
        name,
        erp_warehouse_id
      FROM warehouses
      WHERE LOWER(erp_warehouse_id::text) =
            LOWER($1::text)
      ORDER BY id ASC
      LIMIT 2
      `,
      [erpWarehouseId]
    );

    if (warehouseResult.rows.length !== 1) {

      throw new Error(
        "No se pudo identificar un único almacén WMS " +
        `para la sesión ${activeSession.code}.`
      );
    }

    const warehouse = warehouseResult.rows[0];

    const wmsWarehouseId = Number(warehouse.id);

    console.log("🏬 ALMACÉN DE LA SESIÓN:", {
      wmsWarehouseId,
      name: warehouse.name,
      erpWarehouseId
    });

    
    // ==========================================================
    // 5. CONSULTAR SOLO LÍNEAS CONTADAS EN ESTA SESIÓN
    // ==========================================================
    //
    // SESIÓN ACTUAL: INV-00018
    //
    // FILTROS:
    // - Almacén WMS correspondiente a la sesión
    // - Productos que fueron contados
    // - Conteos realizados desde el inicio de la sesión
    // - Conteos hasta el cierre de la sesión, si existe
    // - Se incluyen conteos físicos de cantidad cero
    //
    // ==========================================================

    console.log("");
    console.log("🔍 CONSULTANDO INVENTARIO POR UBICACIONES");

    console.log("📌 SESSION ID:", sessionId);
    console.log("🏬 WMS WAREHOUSE ID:", wmsWarehouseId);
    console.log("📅 START DATE:", activeSession.start_date);
    console.log("📅 END DATE:", activeSession.end_date);

    const inventoryResult = await client.query(
      `
      SELECT
        ibl.id,
        ibl.warehouse_id,
        ibl.location_id,
        ibl.product_sku,
        ibl.qty_on_hand,
        ibl.inventory_quantity,
        ibl.counted_by,
        ibl.counted_at,

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

      WHERE ibl.warehouse_id = $1

        AND ibl.counted_by IS NOT NULL

        AND ibl.counted_at IS NOT NULL

        AND ibl.inventory_quantity IS NOT NULL

        AND ibl.counted_at >= $2

        AND (
          $3::timestamptz IS NULL
          OR ibl.counted_at <= $3::timestamptz
        )

      ORDER BY
        l.code ASC NULLS LAST,
        ibl.product_sku ASC,
        ibl.id ASC
      `,
      [
        wmsWarehouseId,
        activeSession.start_date,
        activeSession.end_date
      ]
    );

    const inventoryLines = inventoryResult.rows;

    console.log("");
    console.log("🟩 CONSULTA DE INVENTARIO COMPLETADA");
    console.log("🆔 SESIÓN:", activeSession.code);
    console.log("🏬 ALMACÉN:", warehouse.name);
    console.log("📊 LÍNEAS ENCONTRADAS:", inventoryLines.length);


    // ==========================================================
    // 6. VALIDAR LÍNEAS CONTADAS
    // ==========================================================

    if (inventoryLines.length === 0) {

      await rollbackTransaction();

      return res.status(200).json({
        success: false,
        title: "No hay líneas contadas",
        message:
          `No existen productos contados en la sesión ` +
          `${activeSession.code}.`
      });
    }

    // ==========================================================
    // 7. CONTAR PRODUCTOS DISTINTOS
    // ==========================================================

    const uniqueProducts = new Set(
      inventoryLines.map(
        item => String(item.product_sku)
      )
    );

    console.log("📦 PRODUCTOS DISTINTOS:", uniqueProducts.size);
    console.log("📍 UBICACIONES CONTADAS:", inventoryLines.length);

    // ==========================================================
    // 8. PREPARAR DATOS DEL EXCEL
    // ==========================================================

    const reportData = {

      success: true,

      title:
        "Reporte de inventario generado",

      message:
        "Las líneas contadas de la sesión " +
        "fueron obtenidas correctamente.",

      session: {
        id: sessionId,
        code: activeSession.code,
        status: activeSession.status,
        user_id: activeSession.user_id,
        erp_warehouse_id: erpWarehouseId,
        start_date: activeSession.start_date,
        end_date: activeSession.end_date,
        created_at: activeSession.created_at,
        updated_at: activeSession.updated_at
      },

      warehouse: {
        id: warehouse.id,
        code: warehouse.code,
        name: warehouse.name
      },

      totalProducts: uniqueProducts.size,

      totalLines: inventoryLines.length,

      data: inventoryLines
    };

    // ==========================================================
    // 9. GENERAR EXCEL
    // ==========================================================

    console.log("");
    console.log("📄 ENVIANDO DATOS AL SERVICIO EXCEL");

    const excelResult =
      await getInventoryLocationReportExcelService(
        reportData
      );

    if (!excelResult.success) {

      await rollbackTransaction();

      return res.status(200).json({
        success: false,
        title:
          excelResult.title ||
          "No se pudo generar el Excel",
        message:
          excelResult.message ||
          "Ocurrió un error generando el reporte."
      });
    }

    // ==========================================================
    // 10. CONFIRMAR TRANSACCIÓN
    // ==========================================================

    await client.query("COMMIT");

    transactionStarted = false;

    console.log("");
    console.log("🟩 ========================================");
    console.log("✅ EXCEL GENERADO CORRECTAMENTE");
    console.log("🆔 SESIÓN:", activeSession.code);
    console.log("📦 PRODUCTOS:", uniqueProducts.size);
    console.log("📍 LÍNEAS POR UBICACIÓN:", inventoryLines.length);
    console.log("📄 ARCHIVO:", excelResult.fileName);
    console.log("🟩 ========================================");

    // ==========================================================
    // 11. ENVIAR ARCHIVO AL FRONTEND
    // ==========================================================

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

    return res.status(200).send(
      excelResult.buffer
    );

  } catch (error) {

    await rollbackTransaction();

    console.error("");
    console.error(
      "❌ ERROR GENERANDO REPORTE POR UBICACIONES:",
      error
    );

    return res.status(500).json({
      success: false,
      title: "No se pudo generar el reporte",
      message:
        error instanceof Error
          ? error.message
          : "Ocurrió un error inesperado."
    });

  } finally {

    if (client) {
      client.release();

      console.log(
        "🔌 CONEXIÓN POSTGRESQL LIBERADA"
      );
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






export async function adjustInventoryByLocation(req, res) {
  const client = await db.connect();

  try {
    const {
      warehouse_id,
      location_id,
      product_sku,
      new_qty,
    } = req.body;

    // Validaciones básicas
    if (
      warehouse_id == null ||
      location_id == null ||
      !product_sku ||
      new_qty == null
    ) {
      return res.status(400).json({
        success: false,
        title: "Datos incompletos",
        message:
          "warehouse_id, location_id, product_sku y new_qty son requeridos",
      });
    }

    const qty = Number(new_qty);

    if (Number.isNaN(qty) || qty < 0) {
      return res.status(400).json({
        success: false,
        title: "Cantidad inválida",
        message: "La nueva cantidad debe ser un número mayor o igual a 0",
      });
    }

    await client.query("BEGIN");

    // Buscar y bloquear la fila
    const currentResult = await client.query(
      `
            SELECT
                id,
                warehouse_id,
                location_id,
                product_sku,
                qty_on_hand,
                qty_reserved
            FROM inventory_by_location
            WHERE warehouse_id = $1
              AND location_id = $2
              AND product_sku = $3
            LIMIT 1
            FOR UPDATE
            `,
      [
        warehouse_id,
        location_id,
        product_sku,
      ]
    );

    if (currentResult.rows.length === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        title: "Inventario no encontrado",
        message:
          "No existe inventario para ese producto en esa ubicación",
      });
    }

    const currentInventory = currentResult.rows[0];

    const updateResult = await client.query(
      `
            UPDATE inventory_by_location
            SET
                old_qty_on_hand = qty_on_hand,
                qty_on_hand = $1,
                updated_at = NOW()
            WHERE id = $2
            RETURNING
                id,
                warehouse_id,
                location_id,
                product_sku,
                qty_on_hand,
                qty_reserved,
                qty_available,
                old_qty_on_hand,
                updated_at
            `,
      [
        qty,
        currentInventory.id,
      ]
    );

    await client.query("COMMIT");

    return res.status(200).json({
      success: true,
      title: "Inventario actualizado",
      message: "La cantidad fue actualizada correctamente",
      data: updateResult.rows[0],
    });

  } catch (error) {
    await client.query("ROLLBACK");

    console.error(
      "Error ajustando inventario por ubicación:",
      error
    );

    return res.status(500).json({
      success: false,
      title: "Error interno",
      message: "No se pudo actualizar el inventario",
    });

  } finally {
    client.release();
  }
}







export async function addLocationStock(req, res) {

  const client =
    await db.connect();


  try {

    const {
      warehouse_id,
      location_id,
      product_sku,
      new_qty,
    } = req.body;


    // =========================================================
    // 1. VALIDACIONES BÁSICAS
    // =========================================================

    if (
      warehouse_id == null ||
      location_id == null ||
      !product_sku ||
      new_qty == null
    ) {

      return res.status(400).json({
        success: false,
        title: "Datos incompletos",
        message:
          "warehouse_id, location_id, product_sku y new_qty son requeridos",
      });

    }


    const warehouseId =
      Number(warehouse_id);


    const locationId =
      Number(location_id);


    const qty =
      Number(new_qty);


    if (
      !Number.isInteger(warehouseId) ||
      warehouseId <= 0
    ) {

      return res.status(400).json({
        success: false,
        title: "Almacén inválido",
        message:
          "warehouse_id debe ser un valor válido",
      });

    }


    if (
      !Number.isInteger(locationId) ||
      locationId <= 0
    ) {

      return res.status(400).json({
        success: false,
        title: "Ubicación inválida",
        message:
          "location_id debe ser un valor válido",
      });

    }


    if (
      !Number.isFinite(qty) ||
      qty <= 0
    ) {

      return res.status(400).json({
        success: false,
        title: "Cantidad inválida",
        message:
          "La cantidad debe ser un número mayor que 0",
      });

    }


    const sku =
      String(product_sku)
        .trim();


    if (!sku) {

      return res.status(400).json({
        success: false,
        title: "Producto inválido",
        message:
          "El producto no tiene un SKU válido",
      });

    }


    // =========================================================
    // 2. INICIAR TRANSACCIÓN
    // =========================================================

    await client.query(
      "BEGIN"
    );


    // =========================================================
    // 3. VALIDAR PRODUCTO
    // =========================================================

    const productResult =
      await client.query(
        `
                SELECT
                    id,
                    sku,
                    description,
                    erp_name

                FROM products

                WHERE sku = $1

                LIMIT 1
                `,
        [
          sku
        ]
      );


    if (
      productResult.rows.length === 0
    ) {

      await client.query(
        "ROLLBACK"
      );


      return res.status(404).json({
        success: false,
        title: "Producto no encontrado",
        message:
          "No existe un producto con ese SKU",
      });

    }


    // =========================================================
    // 4. VALIDAR UBICACIÓN
    // =========================================================

    const locationResult =
      await client.query(
        `
                SELECT
                    id,
                    warehouse_id,
                    code,
                    description,
                    is_active,
                    location_type

                FROM locations

                WHERE id = $1

                LIMIT 1

                FOR UPDATE
                `,
        [
          locationId
        ]
      );


    if (
      locationResult.rows.length === 0
    ) {

      await client.query(
        "ROLLBACK"
      );


      return res.status(404).json({
        success: false,
        title: "Ubicación no encontrada",
        message:
          "La ubicación seleccionada no existe",
      });

    }


    const location =
      locationResult.rows[0];


    // =========================================================
    // 5. VALIDAR QUE ESTÉ ACTIVA
    // =========================================================

    if (!location.is_active) {

      await client.query(
        "ROLLBACK"
      );


      return res.status(400).json({
        success: false,
        title: "Ubicación inactiva",
        message:
          "No se puede agregar inventario a una ubicación inactiva",
      });

    }


    // =========================================================
    // 6. NO PERMITIR SHIPPING
    // =========================================================

    if (
      String(
        location.location_type || ""
      )
        .trim()
        .toUpperCase() ===
      "SHIPPING"
    ) {

      await client.query(
        "ROLLBACK"
      );


      return res.status(400).json({
        success: false,
        title: "Ubicación no permitida",
        message:
          "No se puede agregar inventario directamente a una ubicación de despacho",
      });

    }


    // =========================================================
    // 7. VALIDAR WAREHOUSE
    // =========================================================

    if (
      Number(
        location.warehouse_id
      ) !==
      warehouseId
    ) {

      await client.query(
        "ROLLBACK"
      );


      return res.status(400).json({
        success: false,
        title: "Almacén incorrecto",
        message:
          "La ubicación seleccionada no pertenece al almacén indicado",
      });

    }


    // =========================================================
    // 8. VERIFICAR SI YA EXISTE INVENTARIO
    // =========================================================

    const inventoryResult =
      await client.query(
        `
                SELECT
                    id,
                    warehouse_id,
                    location_id,
                    product_sku,
                    qty_on_hand,
                    qty_reserved

                FROM inventory_by_location

                WHERE warehouse_id = $1
                  AND location_id = $2
                  AND product_sku = $3

                LIMIT 1

                FOR UPDATE
                `,
        [
          warehouseId,
          locationId,
          sku
        ]
      );


    // =========================================================
    // 9. SI YA EXISTE, NO CREAR DUPLICADO
    // =========================================================

    if (
      inventoryResult.rows.length > 0
    ) {

      await client.query(
        "ROLLBACK"
      );


      return res.status(409).json({
        success: false,
        title: "Inventario existente",
        message:
          "Este producto ya tiene inventario registrado en esa ubicación",
      });

    }


    // =========================================================
    // 10. CREAR INVENTARIO
    // =========================================================

    const insertResult =
      await client.query(
        `
                INSERT INTO inventory_by_location
                (
                    warehouse_id,
                    location_id,
                    product_sku,
                    qty_on_hand,
                    qty_reserved,
                    old_qty_on_hand,
                    updated_at
                )

                VALUES
                (
                    $1,
                    $2,
                    $3,
                    $4,
                    0,
                    0,
                    NOW()
                )

                RETURNING
                    id,
                    warehouse_id,
                    location_id,
                    product_sku,
                    qty_on_hand,
                    qty_reserved,
                    qty_available,
                    old_qty_on_hand,
                    updated_at
                `,
        [
          warehouseId,
          locationId,
          sku,
          qty
        ]
      );


    // =========================================================
    // 11. COMMIT
    // =========================================================

    await client.query(
      "COMMIT"
    );


    // =========================================================
    // 12. RESPONSE
    // =========================================================

    return res.status(201).json({
      success: true,
      title: "Inventario agregado",
      message:
        `${qty} unidades fueron agregadas a la ubicación ${location.code}`,
      data:
        insertResult.rows[0],
    });


  } catch (error) {

    try {

      await client.query(
        "ROLLBACK"
      );

    } catch (
    rollbackError
    ) {

      console.error(
        "Error ejecutando ROLLBACK:",
        rollbackError
      );

    }


    console.error(
      "Error agregando inventario a ubicación:",
      error
    );


    /*
     * Si tienes UNIQUE:
     *
     * warehouse_id,
     * location_id,
     * product_sku
     *
     * PostgreSQL devuelve 23505
     */

    if (
      error.code === "23505"
    ) {

      return res.status(409).json({
        success: false,
        title: "Inventario existente",
        message:
          "Este producto ya tiene inventario registrado en esa ubicación",
      });

    }


    return res.status(500).json({
      success: false,
      title: "Error interno",
      message:
        "No se pudo agregar el inventario a la ubicación",
    });


  } finally {

    client.release();

  }

}









// ============================================================
// OBTENER TODAS LAS SESIONES DE INVENTARIO
//
// GET /api/inventory/sessions/history
//
// REGLAS:
// - Excluir sesiones canceladas.
// - Obtener full_name del usuario.
// - Obtener nombre del almacén ACTIVE.
// - Contar todos los productos del reporte.
// - Contar productos físicamente contados.
// - Contar productos no contados.
// ============================================================

export async function getInventorySessionsHistory(req, res) {

  const client = await db.connect();

  try {

    console.log("");
    console.log("🟦🟦🟦 ========================================");
    console.log("📋 INVENTORY SESSIONS HISTORY");
    console.log("🔍 CONSULTANDO SESIONES");
    console.log("🟦🟦🟦 ========================================");

    const result = await client.query(`
      SELECT
        s.id,
        s.code,
        s.status,
        s.user_id,

        u.full_name AS user_full_name,

        s.erp_warehouse_id,

        w.name AS warehouse_name,

        COALESCE(
          r.total_products,
          0
        ) AS total_products,

        COALESCE(
          r.counted_products,
          0
        ) AS counted_products,

        COALESCE(
          r.not_counted_products,
          0
        ) AS not_counted_products,

        s.start_date,
        s.end_date,
        s.created_at,
        s.updated_at

      FROM inventory_sessions AS s

      LEFT JOIN users AS u
        ON u.id = s.user_id

      LEFT JOIN warehouses AS w
        ON LOWER(w.erp_warehouse_id::text) =
           LOWER(s.erp_warehouse_id::text)

        AND w.status = 'ACTIVE'

      LEFT JOIN (

        SELECT
          session_id,

          COUNT(*)::integer AS total_products,

          COUNT(*) FILTER (
            WHERE wms_counted IS TRUE
          )::integer AS counted_products,

          COUNT(*) FILTER (
            WHERE wms_counted IS FALSE
          )::integer AS not_counted_products

        FROM inventory_erp_report

        GROUP BY session_id

      ) AS r
        ON r.session_id = s.id

      WHERE s.status IS DISTINCT FROM 'cancelled'

      ORDER BY s.id DESC
    `);

    const sessions = result.rows;

    console.log(
      "✅ TOTAL SESIONES:",
      sessions.length
    );

    return res.status(200).json({
      success: true,

      message:
        "Sesiones de inventario obtenidas correctamente.",

      total: sessions.length,

      sessions
    });

  } catch (error) {

    console.error("");
    console.error(
      "🟥 ERROR CONSULTANDO SESIONES DE INVENTARIO"
    );
    console.error(error);

    return res.status(500).json({
      success: false,

      message:
        "No fue posible obtener las sesiones de inventario.",

      error: error.message
    });

  } finally {

    client.release();
  }
}
