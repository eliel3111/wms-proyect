//wms-backend/services/inventoryAdjustment.worker.js
import sgMail from "@sendgrid/mail";
//🟧🟧🟧🟧🟧🟧🟧🟧🟧🟧🟧🟧 Every ERP will have different function


import {
  emitInventoryAdjustmentProgress
} from "../services/inventoryAdjustmentSocketService.js";
// ============================================================
// AJUSTA ESTAS RUTAS SEGÚN TU PROYECTO
// ============================================================

import { db } from "../db.js";

// ============================================================
// ADM CLOUD - CONSULTAR EXISTENCIA ACTUAL
// ============================================================

import {
  buscarExistenciaActualAdmCloud
} from "../integrations/admcloud/admcloud.erpStockSync.js";

// ============================================================
// ADM CLOUD - CREAR AJUSTE DE INVENTARIO
// ============================================================

import {
  crearAjusteInventarioAdmCloud
} from "../integrations/admcloud/admcloud.adjustmentStock.js";

// ============================================================
// SENDGRID
// ============================================================

sgMail.setApiKey(
  process.env.SENDGRID_API_KEY
);


// ============================================================
// CONFIGURACIÓN
// ============================================================

const FAST_VERIFICATION_ATTEMPTS = 3;

const FAST_VERIFICATION_DELAY_MS =
  5_000;


// Después de mandar el correo,
// seguimos esperando Citrus cada 60 segundos.

const SLOW_VERIFICATION_DELAY_MS =
  60_000;


// Timeout adicional del worker.
//
// Tu servicio ajustarExistenciaAlmacen()
// ya tiene timeout de 30 segundos.
//
// Ponemos 35 segundos aquí como
// protección adicional.

const WORKER_REQUEST_TIMEOUT_MS =
  35_000;


const CITRUS_ALERT_EMAIL =
  "eliel3111@gmail.com";


const CITRUS_ALERT_FROM =
  "no-reply@sidialwms.com";


// ============================================================
// JOBS QUE ESTÁN CORRIENDO EN ESTE PROCESO NODE
// ============================================================
//
// Esto evita iniciar el mismo job dos veces
// dentro del mismo proceso.
//
// Adicionalmente utilizaremos PostgreSQL
// advisory locks para protegernos incluso
// si existen varios procesos Node.
// ============================================================

const runningJobs =
  new Set();



// ============================================================
// HELPER
// ESPERAR
// ============================================================

function sleep(ms) {

  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );

}



// ============================================================
// HELPER
// TIMEOUT ADICIONAL
// ============================================================

async function withTimeout(
  promise,
  timeoutMs,
  message
) {

  let timeout;


  const timeoutPromise =
    new Promise(
      (
        _resolve,
        reject
      ) => {

        timeout =
          setTimeout(
            () => {

              const error =
                new Error(
                  message ||
                  "Tiempo de espera agotado."
                );


              error.code =
                "WORKER_TIMEOUT";


              reject(
                error
              );

            },
            timeoutMs
          );

      }
    );


  try {

    return await Promise.race([
      promise,
      timeoutPromise
    ]);


  } finally {

    clearTimeout(
      timeout
    );

  }

}



// ============================================================
// HELPER
// NORMALIZAR RESULTADO DEL AJUSTE
// ============================================================
//
// Tu servicio actualmente devuelve:
//
// {
//   success: true,
//   data: {
//     citrusResult: {
//       Success: 0,
//       Warning: 1,
//       Mensaje: "..."
//     }
//   }
// }
//
// IMPORTANTE:
//
// NO usamos:
//
// resultado.success
//
// Usamos:
//
// resultado.data.citrusResult.Success
//
// porque Citrus puede devolver Success: 0
// mientras tu wrapper devuelve success: true.
//
// ============================================================

function getCitrusResult(
  resultado
) {

  return (
    resultado
      ?.data
      ?.citrusResult
    ??
    resultado
      ?.citrusResult
    ??
    resultado
  );

}



// ============================================================
// HELPER
// OBTENER SUCCESS COMO NÚMERO
// ============================================================

function getCitrusSuccess(
  citrusResult
) {

  if (
    citrusResult?.Success === undefined ||
    citrusResult?.Success === null
  ) {

    return null;

  }


  const success =
    Number(
      citrusResult.Success
    );


  if (
    success !== 0 &&
    success !== 1
  ) {

    return null;

  }


  return success;

}



// ============================================================
// HELPER
// SERIALIZAR ERROR
// ============================================================

function serializeError(
  error
) {

  return {

    message:
      error?.message ?? null,

    code:
      error?.code ?? null,

    statusCode:
      error?.statusCode ?? null,

    citrusResult:
      error?.citrusResult ?? null,

    citrusResponse:
      error?.citrusResponse ?? null

  };

}



// ============================================================
// ============================================================
// 🟥 SERVICIO DE BUSCAR EXISTENCIA
// ============================================================
// ============================================================
//
// TODAVÍA ME FALTA EL NOMBRE EXACTO
// DE TU SERVICIO.
//
// CUANDO ME LO DES:
//
// reemplazaremos solamente esta función.
//
// NO HABRÁ QUE CAMBIAR EL WORKER.
//
// Debe devolver SOLAMENTE la cantidad actual
// del producto en ese almacén.
//
// Ejemplo:
//
// return 170;
//
// ============================================================





// ============================================================
// ACTUALIZAR CONTADORES DEL JOB
// ============================================================
//
// En vez de hacer simplemente:
//
// successful_products + 1
//
// recalculamos directamente desde las líneas.
//
// Esto evita contadores incorrectos si:
//
// - Node reinicia.
// - una función se ejecuta dos veces.
// - una línea ya estaba success.
//
// ============================================================

async function refreshJobCounters(
  jobId
) {

  const result =
    await db.query(
      `
      SELECT

        COUNT(*)::integer
          AS total,

        COUNT(*) FILTER (
          WHERE status = 'success'
        )::integer
          AS successful,

        COUNT(*) FILTER (
          WHERE status = 'failed'
        )::integer
          AS failed

      FROM inventory_adjustment_job_lines

      WHERE
        job_id = $1
      `,
      [
        jobId
      ]
    );


  const counters =
    result.rows[0];


  const successful =
    Number(
      counters.successful || 0
    );


  const failed =
    Number(
      counters.failed || 0
    );


  const processed =
    successful +
    failed;


  await db.query(
    `
    UPDATE inventory_adjustment_jobs

    SET

      processed_products = $2,

      successful_products = $3,

      failed_products = $4,

      updated_at = NOW()

    WHERE
      id = $1
    `,
    [
      jobId,
      processed,
      successful,
      failed
    ]
  );

}



// ============================================================
// OBTENER JOB
// ============================================================

async function getJob(
  jobId
) {

  const result =
    await db.query(
      `
      SELECT *

      FROM inventory_adjustment_jobs

      WHERE
        id = $1

      LIMIT 1
      `,
      [
        jobId
      ]
    );


  return (
    result.rows[0] ||
    null
  );

}



// ============================================================
// OBTENER LÍNEA FRESCA
// ============================================================

async function getLine(
  lineId
) {

  const result =
    await db.query(
      `
      SELECT *

      FROM inventory_adjustment_job_lines

      WHERE
        id = $1

      LIMIT 1
      `,
      [
        lineId
      ]
    );


  return (
    result.rows[0] ||
    null
  );

}



// ============================================================
// OBTENER PRÓXIMA LÍNEA DEL JOB
// ============================================================
//
// PRIORIDAD:
//
// 1. verifying
// 2. waiting_citrus
// 3. pending
//
// Si una línea quedó insegura,
// debemos resolverla ANTES de continuar
// con otro producto.
//
// ============================================================

async function getNextJobLine(
  jobId
) {

  const result =
    await db.query(
      `
      SELECT *

      FROM inventory_adjustment_job_lines

      WHERE
        job_id = $1

        AND status IN (
          'verifying',
          'waiting_citrus',
          'pending'
        )

      ORDER BY

        CASE status

          WHEN 'verifying'
            THEN 1

          WHEN 'waiting_citrus'
            THEN 2

          WHEN 'pending'
            THEN 3

          ELSE 4

        END,

        id ASC

      LIMIT 1
      `,
      [
        jobId
      ]
    );


  return (
    result.rows[0] ||
    null
  );

}



// ============================================================
// MARCAR JOB PROCESSING
// ============================================================

async function markJobProcessing(
  jobId,
  lineId = null
) {

  await db.query(
    `
    UPDATE inventory_adjustment_jobs

    SET

      status =
        'processing',

      current_line_id =
        COALESCE(
          $2,
          current_line_id
        ),

      started_at =
        COALESCE(
          started_at,
          NOW()
        ),

      error_message =
        NULL,

      updated_at =
        NOW()

    WHERE
      id = $1
    `,
    [
      jobId,
      lineId
    ]
  );

}



// ============================================================
// MARCAR LÍNEA PROCESSING
// ============================================================

async function markLineProcessing(
  lineId
) {

  await db.query(
    `
    UPDATE inventory_adjustment_job_lines

    SET

      status =
        'processing',

      adjustment_attempts =
        adjustment_attempts + 1,

      started_at =
        COALESCE(
          started_at,
          NOW()
        ),

      next_retry_at =
        NULL,

      updated_at =
        NOW()

    WHERE
      id = $1
    `,
    [
      lineId
    ]
  );

}



// ============================================================
// MARCAR LÍNEA SUCCESS
// ============================================================

async function markLineSuccess({
  lineId,
  citrusMessage,
  citrusResponse,
  currentQty = null
}) {

  await db.query(
    `
    UPDATE inventory_adjustment_job_lines

    SET

      status =
        'success',

      citrus_message =
        $2,

      citrus_response =
        $3::jsonb,

      citrus_qty_before =
        COALESCE(
          $4,
          citrus_qty_before
        ),

      processed_at =
        NOW(),

      next_retry_at =
        NULL,

      updated_at =
        NOW()

    WHERE
      id = $1
    `,
    [
      lineId,

      citrusMessage ||
      "Ajuste realizado correctamente.",

      JSON.stringify(
        citrusResponse || {}
      ),

      currentQty
    ]
  );

}



// ============================================================
// MARCAR LÍNEA FAILED
// ============================================================

async function markLineFailed({
  lineId,
  citrusMessage,
  citrusResponse
}) {

  await db.query(
    `
    UPDATE inventory_adjustment_job_lines

    SET

      status =
        'failed',

      citrus_message =
        $2,

      citrus_response =
        $3::jsonb,

      processed_at =
        NOW(),

      next_retry_at =
        NULL,

      updated_at =
        NOW()

    WHERE
      id = $1
    `,
    [
      lineId,

      citrusMessage,

      JSON.stringify(
        citrusResponse || {}
      )
    ]
  );

}



// ============================================================
// DETENER JOB POR ERROR DE CITRUS
// ============================================================

async function markJobFailed({
  jobId,
  lineId,
  message
}) {

  await refreshJobCounters(
    jobId
  );


  await db.query(
    `
    UPDATE inventory_adjustment_jobs

    SET

      status =
        'failed',

      current_line_id =
        $2,

      error_message =
        $3,

      updated_at =
        NOW()

    WHERE
      id = $1
    `,
    [
      jobId,
      lineId,
      message
    ]
  );

}



// ============================================================
// MARCAR LÍNEA VERIFYING
// ============================================================

async function markLineVerifying({
  lineId,
  message,
  response = null
}) {

  await db.query(
    `
    UPDATE inventory_adjustment_job_lines

    SET

      status =
        'verifying',

      citrus_message =
        $2,

      citrus_response =
        $3::jsonb,

      next_retry_at =
        NOW()
        + INTERVAL '5 seconds',

      updated_at =
        NOW()

    WHERE
      id = $1
    `,
    [
      lineId,

      message,

      JSON.stringify(
        response || {}
      )
    ]
  );

}



// ============================================================
// REGISTRAR INTENTO DE VERIFICACIÓN
// ============================================================

async function incrementVerificationAttempt({
  lineId,
  message,
  nextDelaySeconds
}) {

  await db.query(
    `
    UPDATE inventory_adjustment_job_lines

    SET

      verification_attempts =
        verification_attempts + 1,

      citrus_message =
        $2,

      next_retry_at =
        NOW()
        +
        ($3 * INTERVAL '1 second'),

      updated_at =
        NOW()

    WHERE
      id = $1
    `,
    [
      lineId,
      message,
      nextDelaySeconds
    ]
  );

}



// ============================================================
// MARCAR WAITING CITRUS
// ============================================================

async function markWaitingCitrus({
  jobId,
  lineId,
  message
}) {

  await db.query(
    `
    UPDATE inventory_adjustment_job_lines

    SET

      status =
        'waiting_citrus',

      citrus_message =
        $2,

      next_retry_at =
        NOW()
        + INTERVAL '60 seconds',

      updated_at =
        NOW()

    WHERE
      id = $1
    `,
    [
      lineId,
      message
    ]
  );


  await db.query(
    `
    UPDATE inventory_adjustment_jobs

    SET

      status =
        'waiting_citrus',

      current_line_id =
        $2,

      error_message =
        $3,

      updated_at =
        NOW()

    WHERE
      id = $1
    `,
    [
      jobId,
      lineId,
      message
    ]
  );

}



// ============================================================
// EMAIL CITRUS NO RESPONDE
// ============================================================

async function sendCitrusNoResponseEmail({
  job,
  line
}) {

  // Primero verificamos si ya enviamos
  // el email para este job.

  const currentJob =
    await getJob(
      job.id
    );


  if (
    currentJob?.email_sent === true
  ) {

    console.log(
      "📧 EMAIL DE ALERTA YA FUE ENVIADO."
    );

    return;

  }


  try {

    console.log("");
    console.log(
      "📧 ENVIANDO ALERTA SENDGRID..."
    );


    await sgMail.send({

      to:
        CITRUS_ALERT_EMAIL,

      from: {

        email:
          CITRUS_ALERT_FROM,

        name:
          "Sidial WMS"

      },

      subject:
        "Citrus no responde - Ajuste de inventario",

      text:
        `
Citrus no está respondiendo durante el proceso de ajuste de inventario.

Job ID: ${job.id}
Inventory Session ID: ${job.inventory_session_id}
Line ID: ${line.id}
Report Line ID: ${line.report_line_id}
ERP Product ID: ${line.erp_product_id}
ERP Warehouse ID: ${line.erp_warehouse_id}

Cantidad deseada: ${line.desired_qty}
Última cantidad conocida en Citrus: ${line.citrus_qty_before}

Intentos de verificación: ${line.verification_attempts}

El worker continuará intentando automáticamente.
        `,

      html:
        `
        <h2>Citrus no responde</h2>

        <p>
          El WMS no ha podido comunicarse con Citrus
          durante el proceso de ajuste de inventario.
        </p>

        <p>
          <b>Job ID:</b>
          ${job.id}
        </p>

        <p>
          <b>Inventory Session ID:</b>
          ${job.inventory_session_id}
        </p>

        <p>
          <b>Line ID:</b>
          ${line.id}
        </p>

        <p>
          <b>Report Line ID:</b>
          ${line.report_line_id}
        </p>

        <p>
          <b>ERP Product ID:</b>
          ${line.erp_product_id}
        </p>

        <p>
          <b>ERP Warehouse ID:</b>
          ${line.erp_warehouse_id}
        </p>

        <p>
          <b>Cantidad deseada:</b>
          ${line.desired_qty}
        </p>

        <p>
          <b>Última cantidad Citrus:</b>
          ${line.citrus_qty_before}
        </p>

        <p>
          El worker continuará verificando
          automáticamente hasta que Citrus vuelva.
        </p>
        `

    });


    await db.query(
      `
      UPDATE inventory_adjustment_jobs

      SET

        email_sent =
          true,

        updated_at =
          NOW()

      WHERE
        id = $1
      `,
      [
        job.id
      ]
    );


    console.log(
      "✅ EMAIL DE ALERTA ENVIADO."
    );


  } catch (error) {

    // IMPORTANTE:
    //
    // Si SendGrid falla,
    // NO detenemos el worker.

    console.error(
      "🟥 ERROR ENVIANDO EMAIL SENDGRID:"
    );

    console.error(
      error
    );

  }

}



// ============================================================
// EJECUTAR AJUSTE DE UNA LÍNEA
// ============================================================


async function executeAdjustment({ job, line, cantidadActual }) {

  console.log("");
  console.log("🟦 ========================================");
  console.log("📦 AJUSTE REAL ADM CLOUD");
  console.log("🟦 ========================================");

  const itemId = String(
    line.erp_product_id ?? ""
  ).trim();

  const locationId = String(
    line.erp_warehouse_id ?? ""
  ).trim();

  const desiredQty = Number(
    line.desired_qty
  );

  const reference =
    `WMS-INV-${job.inventory_session_id}-${job.id}-${line.id}`;

  const MAX_RECALCULOS = 3;
  const MAX_VERIFICACIONES = 5;
  const EPSILON = 0.000001;

  let postPuedeHaberOcurrido = false;
  let adjustmentId = null;
  let stockAntesDelPost = null;

  console.log("🆔 ITEM GUID:", itemId);
  console.log("🏬 LOCATION GUID:", locationId);
  console.log("🎯 CANTIDAD DESEADA:", desiredQty);
  console.log("📄 REFERENCIA:", reference);

  // ==========================================================
  // AUTORIZACIÓN PARA AJUSTES REALES
  // ==========================================================

  

  // ==========================================================
  // HELPER - CONFIRMAR PRODUCTO
  // ==========================================================

  const confirmarProducto = async ({
    stockAntes,
    stockFinal,
    mensaje,
    extra = {}
  }) => {

    await markLineSuccess({
      lineId: line.id,

      citrusMessage: mensaje,

      citrusResponse: {
        erp: "ADMCLOUD",
        verified: true,
        reference,
        adjustmentId,
        stockAntes,
        stockFinal,
        desiredQty,
        ...extra
      },

      currentQty: stockAntes
    });

    await refreshJobCounters(job.id);

    console.log(
      "✅ LÍNEA CONFIRMADA:",
      line.id,
      "STOCK:",
      stockFinal
    );

    return {
      status: "success"
    };
  };

  try {

    // ========================================================
    // 1. VALIDACIONES
    // ========================================================

    if (
      !itemId ||
      !locationId ||
      !Number.isFinite(desiredQty) ||
      desiredQty < 0
    ) {
      throw new Error(
        "ItemID, LocationID o cantidad deseada inválidos."
      );
    }

  

    await markJobProcessing(
      job.id,
      line.id
    );

    await markLineProcessing(
      line.id
    );

    // ========================================================
    // 2. CONSULTAR Y RECALCULAR STOCK
    // ========================================================

    for (
      let intento = 1;
      intento <= MAX_RECALCULOS;
      intento++
    ) {

      console.log("");
      console.log(
        `🔄 CONSULTA Y RECÁLCULO ${intento}/${MAX_RECALCULOS}`
      );

      const stockActual = Number(
        await buscarExistenciaActualAdmCloud({
          itemId,
          almacenId: locationId
        })
      );

      if (!Number.isFinite(stockActual)) {
        throw new Error(
          "ADM Cloud devolvió una existencia inválida."
        );
      }

      console.log(
        "📊 STOCK ADM CLOUD:",
        stockActual
      );

      console.log(
        "🎯 STOCK DESEADO:",
        desiredQty
      );

      // ======================================================
      // 3. STOCK YA COINCIDE
      // ======================================================

      if (
        Math.abs(stockActual - desiredQty) < EPSILON
      ) {

        console.log(
          "✅ STOCK YA COINCIDE. NO SE CREARÁ OTRO DOCUMENTO."
        );

        return await confirmarProducto({
          stockAntes: stockActual,
          stockFinal: stockActual,

          mensaje:
            "ADM Cloud ya tiene la existencia deseada. " +
            "No fue necesario crear otro ajuste.",

          extra: {
            skipped: true,
            motivo: "STOCK_ALREADY_MATCHES"
          }
        });
      }

      // ======================================================
      // 4. PREPARAR AJUSTE REAL
      // ======================================================

      stockAntesDelPost = stockActual;

      const datosAjuste = {

        ejecutar: true,

        fechaDocumento:
          new Date().toISOString().slice(0, 10),

        referencia: reference,

        notas:
          `Ajuste WMS - Sesión ${job.inventory_session_id}`,

        locationId,

        rowType: 0,

        items: [
          {
            itemId,
            cantidadActual: stockActual,
            cantidadNueva: desiredQty,
            precio: 0,

            comentario:
              `Job ${job.id}, línea ${line.id}`
          }
        ]
      };

      console.log(
        "📊 DIFERENCIA SOLICITADA:",
        desiredQty - stockActual
      );

      console.log(
        "🚀 SOLICITANDO AJUSTE REAL A ADM CLOUD"
      );

      // ======================================================
      // 5. ENVIAR AJUSTE REAL
      // ======================================================

      let resultado;

      postPuedeHaberOcurrido = true;

      try {

        resultado =
          await crearAjusteInventarioAdmCloud(
            datosAjuste
          );

      } catch (error) {

        // STOCK_CHANGED se detecta ANTES del POST.
        // Por eso se permite recalcular.

        if (error?.code === "STOCK_CHANGED") {

          postPuedeHaberOcurrido = false;

          console.warn(
            "🟨 STOCK_CHANGED ANTES DEL POST:",
            error.message
          );

          console.warn(
            "📦 NUEVO STOCK:",
            error.stockActual
          );

          if (intento < MAX_RECALCULOS) {
            continue;
          }
        }

        throw error;
      }

      // ======================================================
      // 6. ADM CLOUD YA NO TIENE DIFERENCIAS
      // ======================================================

      if (
        resultado?.success === true &&
        resultado?.ejecutado === false &&
        resultado?.modo === "SIN_DIFERENCIAS"
      ) {

        postPuedeHaberOcurrido = false;

        const verificado = Number(
          await buscarExistenciaActualAdmCloud({
            itemId,
            almacenId: locationId
          })
        );

        if (
          Number.isFinite(verificado) &&
          Math.abs(verificado - desiredQty) < EPSILON
        ) {

          return await confirmarProducto({
            stockAntes: verificado,
            stockFinal: verificado,

            mensaje:
              "ADM Cloud ya coincide. Ajuste omitido.",

            extra: {
              skipped: true,
              motivo: "NO_DIFFERENCES"
            }
          });
        }

        if (intento < MAX_RECALCULOS) {
          continue;
        }

        throw new Error(
          "ADM Cloud informó que no hay diferencias, " +
          "pero el stock consultado no coincide."
        );
      }

      // ======================================================
      // 7. VALIDAR RESPUESTA DEL POST
      // ======================================================

      if (
        resultado?.success !== true ||
        resultado?.ejecutado !== true
      ) {

        throw new Error(
          "ADM Cloud no confirmó la creación del ajuste."
        );
      }

      adjustmentId =
        resultado.data?.adjustmentId ?? null;

      console.log(
        "✅ DOCUMENTO ADM CLOUD CREADO:",
        adjustmentId
      );

      // ======================================================
      // 8. GUARDAR EVIDENCIA DEL DOCUMENTO
      // ======================================================

      await markLineVerifying({
        lineId: line.id,

        message:
          "Documento ADM Cloud creado. Verificando existencia.",

        response: {
          erp: "ADMCLOUD",
          adjustmentId,
          reference,
          resultado
        }
      });

      // ======================================================
      // 9. VERIFICAR STOCK DESPUÉS DEL POST
      // ======================================================

      for (
        let verificacion = 1;
        verificacion <= MAX_VERIFICACIONES;
        verificacion++
      ) {

        if (verificacion > 1) {
          await sleep(1500);
        }

        try {

          const stockDespues = Number(
            await buscarExistenciaActualAdmCloud({
              itemId,
              almacenId: locationId
            })
          );

          console.log(
            `🔎 VERIFICACIÓN ${verificacion}/${MAX_VERIFICACIONES}:`,
            stockDespues
          );

          if (
            Number.isFinite(stockDespues) &&
            Math.abs(stockDespues - desiredQty) < EPSILON
          ) {

            console.log(
              "✅ EXISTENCIA CONFIRMADA EN ADM CLOUD"
            );

            return await confirmarProducto({
              stockAntes: stockAntesDelPost,
              stockFinal: stockDespues,

              mensaje:
                "Documento ADM Cloud creado " +
                "y existencia confirmada.",

              extra: {
                adjustmentId,
                skipped: false
              }
            });
          }

        } catch (verificationError) {

          console.warn(
            "🟨 ERROR CONSULTANDO STOCK:",
            verificationError.message
          );
        }
      }

      // ======================================================
      // 10. POST ACEPTADO, PERO STOCK NO CONFIRMADO
      // ======================================================

      throw new Error(
        `ADM Cloud aceptó el documento ` +
        `${adjustmentId || reference}, pero el stock ` +
        `todavía no coincide con ${desiredQty}. ` +
        "Se requiere verificar el documento. " +
        "No se enviará otro POST."
      );
    }

    throw new Error(
      "Se agotaron los intentos de recálculo."
    );

  } catch (error) {

    // ========================================================
    // 11. MANEJAR ERROR
    // ========================================================

    const message = postPuedeHaberOcurrido
      ? "AJUSTE REAL POSIBLE O CONFIRMADO. " +
      "No reenviar POST. " +
      error.message
      : error.message;

    console.error(
      "🟥 ERROR EN AJUSTE ADM CLOUD:",
      message
    );

    if (postPuedeHaberOcurrido) {

      await markLineVerifying({
        lineId: line.id,
        message,

        response: {
          erp: "ADMCLOUD",
          reference,
          adjustmentId,
          possiblePost: true,
          errorCode: error.code ?? null,
          error: error.message
        }
      });

    } else {

      await markLineFailed({
        lineId: line.id,
        citrusMessage: message,

        citrusResponse: {
          erp: "ADMCLOUD",
          reference,
          code: error.code ?? null
        }
      });
    }

    await markJobFailed({
      jobId: job.id,
      lineId: line.id,
      message
    });

    return {
      status: "failed",
      message
    };
  }
}



// ============================================================
// VERIFICAR EXISTENCIA EN CITRUS
// ============================================================

async function verifyLine(job, originalLine) {

  const line = await getLine(
    originalLine.id
  );

  if (!line) {
    throw new Error(
      `No existe la línea ${originalLine.id}.`
    );
  }

  const itemId = String(
    line.erp_product_id
  ).trim();

  const locationId = String(
    line.erp_warehouse_id
  ).trim();

  const desiredQty = Number(
    line.desired_qty
  );

  console.log("");
  console.log("🔎 VERIFICANDO EXISTENCIA ADM CLOUD");
  console.log("📦 LINE ID:", line.id);
  console.log("🆔 ITEM GUID:", itemId);
  console.log("🏬 LOCATION GUID:", locationId);

  try {

    const stockActual =
      await buscarExistenciaActualAdmCloud({
        itemId,
        almacenId: locationId
      });

    console.log(
      "📊 STOCK ACTUAL:",
      stockActual
    );

    console.log(
      "🎯 STOCK DESEADO:",
      desiredQty
    );

    // ========================================================
    // EXISTENCIA COINCIDE
    // ========================================================

    if (
      Math.abs(stockActual - desiredQty) < 0.000001
    ) {

      await markLineSuccess({
        lineId: line.id,
        citrusMessage:
          "Existencia verificada en ADM Cloud.",
        citrusResponse: {
          erp: "ADMCLOUD",
          verified: true,
          stockActual,
          desiredQty
        },
        currentQty: stockActual
      });

      await markJobProcessing(
        job.id,
        line.id
      );

      await refreshJobCounters(
        job.id
      );

      return {
        status: "success"
      };
    }

    // ========================================================
    // EXISTENCIA NO COINCIDE
    // NO REINTENTAR POST
    // ========================================================

    const message =
      `La existencia de ADM Cloud es ${stockActual}, ` +
      `pero se esperaban ${desiredQty}. ` +
      "Revisar el ajuste antes de volver a enviarlo.";

    console.error(
      "🟥 VERIFICACIÓN NO CONFIRMADA:",
      message
    );

    await markJobFailed({
      jobId: job.id,
      lineId: line.id,
      message
    });

    return {
      status: "failed",
      message
    };

  } catch (error) {

    const message =
      "No fue posible verificar ADM Cloud: " +
      error.message;

    console.error(
      "❌ ERROR DE VERIFICACIÓN:",
      message
    );

    await markJobFailed({
      jobId: job.id,
      lineId: line.id,
      message
    });

    return {
      status: "failed",
      message
    };
  }
}














async function applyCompletedInventoryJobToWms(client, job) {

  console.log("");
  console.log("📦📦📦 ========================================");
  console.log("📦 ACTUALIZANDO INVENTARIO LOCAL WMS");
  console.log("📦📦📦 ========================================");

  // ==========================================================
  // 1. VALIDAR INFORMACIÓN DEL JOB
  // ==========================================================

  const jobId = Number(job?.id);

  const sessionId = Number(
    job?.inventory_session_id
  );

  const erpWarehouseId = String(
    job?.erp_warehouse_id ?? ""
  ).trim().toLowerCase();

  const jobType = String(
    job?.job_type ?? ""
  ).trim().toLowerCase();

  if (
    !Number.isSafeInteger(jobId) ||
    jobId <= 0
  ) {
    throw new Error(
      "El ID del job de inventario es inválido."
    );
  }

  if (
    !Number.isSafeInteger(sessionId) ||
    sessionId <= 0
  ) {
    throw new Error(
      "El ID de sesión del job es inválido."
    );
  }

  if (!erpWarehouseId) {
    throw new Error(
      "El job no tiene un almacén ERP válido."
    );
  }

  const GUID_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const isAdmCloud =
    GUID_REGEX.test(erpWarehouseId);

  console.log("🆔 JOB ID:", jobId);
  console.log("🆔 SESSION ID:", sessionId);
  console.log("📌 JOB TYPE:", jobType);
  console.log("🏬 ERP WAREHOUSE:", erpWarehouseId);
  console.log(
    "🌐 ERP:",
    isAdmCloud ? "ADM CLOUD" : "ERP LEGADO"
  );

  // ==========================================================
  // 2. VALIDAR TODAS LAS LÍNEAS DEL JOB
  // ==========================================================

  const linesResult = await client.query(
    `
    SELECT

      COUNT(*)::integer AS total,

      COUNT(*) FILTER (
        WHERE status = 'success'
      )::integer AS successful,

      COUNT(*) FILTER (
        WHERE status <> 'success'
           OR status IS NULL
      )::integer AS not_success

    FROM inventory_adjustment_job_lines

    WHERE job_id = $1::bigint
    `,
    [jobId]
  );

  const totalLines = Number(
    linesResult.rows[0]?.total ?? 0
  );

  const successfulLines = Number(
    linesResult.rows[0]?.successful ?? 0
  );

  const notSuccess = Number(
    linesResult.rows[0]?.not_success ?? 0
  );

  console.log("📊 VALIDACIÓN DE LÍNEAS:", {
    jobId,
    totalLines,
    successfulLines,
    notSuccess
  });

  if (
    totalLines === 0 ||
    successfulLines !== totalLines ||
    notSuccess !== 0
  ) {
    throw new Error(
      `El job ${jobId} no puede actualizar WMS: ` +
      `${successfulLines}/${totalLines} líneas están success.`
    );
  }

  // ==========================================================
  // 3. COUNTED - PRODUCTOS CONTADOS
  // ==========================================================

  if (jobType === "counted") {

    console.log("");
    console.log("🟦 ========================================");
    console.log("📦 ACTUALIZANDO PRODUCTOS CONTADOS");
    console.log("🟦 ========================================");

    // ========================================================
    // 3.1. VALIDAR EL ALCANCE DE LA SESIÓN
    // ========================================================
    //
    // Este ajuste supone un inventario físico completo.
    // Las ubicaciones no contadas del mismo producto
    // se consideran vacías.
    //
    // ========================================================

    const sessionResult = await client.query(
      `
      SELECT

        s.id,
        s.code,
        s.status,
        s.start_date,
        s.end_date,

        w.id AS warehouse_id,
        w.name AS warehouse_name

      FROM inventory_sessions s

      INNER JOIN warehouses w
        ON LOWER(w.erp_warehouse_id::text) =
           LOWER(s.erp_warehouse_id::text)

      WHERE s.id = $1::bigint

        AND s.status = 'review'

        AND LOWER(s.erp_warehouse_id::text) =
            LOWER($2::text)

        AND s.start_date IS NOT NULL

      LIMIT 2
      `,
      [
        sessionId,
        erpWarehouseId
      ]
    );

    if (sessionResult.rows.length !== 1) {
      throw new Error(
        `No se pudo identificar una sesión y almacén ` +
        `válidos para el job ${jobId}.`
      );
    }

    const session = sessionResult.rows[0];

    const wmsWarehouseId = Number(
      session.warehouse_id
    );

    console.log("🏬 ALMACÉN COUNTED:", {
      id: wmsWarehouseId,
      name: session.warehouse_name,
      sessionCode: session.code
    });

    // ========================================================
    // 3.2. VALIDAR UBICACIONES NO CONTADAS CON RESERVAS
    // ========================================================
    //
    // No eliminar existencias locales automáticamente
    // si hay reservas pendientes.
    //
    // ========================================================

    const reservedLocationsResult = await client.query(
      `
      WITH counted_job_products AS (

        SELECT DISTINCT

          ier.sku AS product_sku

        FROM inventory_adjustment_job_lines jal

        INNER JOIN inventory_erp_report ier
          ON ier.id = jal.report_line_id

        WHERE jal.job_id = $1::bigint

          AND jal.status = 'success'

          AND ier.session_id = $2::bigint

          AND ier.wms_counted = true

          AND ier.sku IS NOT NULL

          AND LOWER(ier.erp_id::text) =
              LOWER(jal.erp_product_id::text)

          AND LOWER(jal.erp_warehouse_id::text) =
              LOWER($3::text)
      )

      SELECT

        ibl.id,
        ibl.product_sku,
        ibl.location_id,
        ibl.qty_on_hand,
        ibl.qty_reserved

      FROM inventory_by_location ibl

      INNER JOIN counted_job_products cjp
        ON cjp.product_sku = ibl.product_sku

      WHERE ibl.warehouse_id = $4::bigint

        AND ibl.counted_by IS NULL

        AND ibl.counted_at IS NULL

        AND ibl.inventory_quantity IS NULL

        AND COALESCE(ibl.qty_reserved, 0) <> 0

      LIMIT 20
      `,
      [
        jobId,
        sessionId,
        erpWarehouseId,
        wmsWarehouseId
      ]
    );

    if (reservedLocationsResult.rows.length > 0) {

      console.error(
        "🛑 UBICACIONES CON RESERVAS PENDIENTES:",
        reservedLocationsResult.rows
      );

      throw new Error(
        "Existen ubicaciones no contadas con reservas " +
        "pendientes para productos del job. " +
        "Es necesario conciliarlas antes de poner " +
        "esas ubicaciones en cero."
      );
    }

    // ========================================================
    // 3.3. ACTUALIZAR UBICACIONES CONTADAS
    // ========================================================
    //
    // SE CONSERVA LA LÓGICA ORIGINAL:
    //
    // qty_on_hand = inventory_quantity
    //
    // Solo:
    // - Almacén de la sesión
    // - Conteos de esta sesión
    // - Productos incluidos en el job COUNTED
    // - Líneas SUCCESS
    //
    // ========================================================

    console.log("");
    console.log("🟦 ACTUALIZANDO UBICACIONES CONTADAS");

    const result = await client.query(
      `
      WITH target_session AS (

        SELECT

          s.id,
          s.start_date,
          s.end_date,
          w.id AS warehouse_id

        FROM inventory_sessions s

        INNER JOIN warehouses w
          ON LOWER(w.erp_warehouse_id::text) =
             LOWER(s.erp_warehouse_id::text)

        WHERE s.id = $1::bigint

          AND s.status = 'review'

          AND LOWER(s.erp_warehouse_id::text) =
              LOWER($2::text)

          AND s.start_date IS NOT NULL
      )

      UPDATE inventory_by_location AS ibl

      SET

        old_qty_on_hand = ibl.qty_on_hand,

        qty_on_hand = ibl.inventory_quantity,

        updated_at = NOW()

      FROM target_session ts

      WHERE ibl.warehouse_id = ts.warehouse_id

        AND ibl.counted_by IS NOT NULL

        AND ibl.counted_at IS NOT NULL

        AND ibl.counted_at >= ts.start_date

        AND (
          ts.end_date IS NULL
          OR ibl.counted_at <= ts.end_date
        )

        AND ibl.inventory_quantity IS NOT NULL

        AND EXISTS (

          SELECT 1

          FROM inventory_adjustment_job_lines jal

          INNER JOIN inventory_erp_report ier
            ON ier.id = jal.report_line_id

          WHERE jal.job_id = $3::bigint

            AND jal.status = 'success'

            AND ier.session_id = ts.id

            AND ier.wms_counted = true

            AND ier.sku = ibl.product_sku

            AND LOWER(ier.erp_id::text) =
                LOWER(jal.erp_product_id::text)
        )

      RETURNING

        ibl.id,
        ibl.warehouse_id,
        ibl.location_id,
        ibl.product_sku,
        ibl.inventory_quantity,
        ibl.old_qty_on_hand,
        ibl.qty_on_hand
      `,
      [
        sessionId,
        erpWarehouseId,
        jobId
      ]
    );

    const updatedLines = result.rows.length;

    console.log("");
    console.log("✅ UBICACIONES CONTADAS ACTUALIZADAS:", updatedLines);

    if (updatedLines === 0) {
      throw new Error(
        `El job ${jobId} terminó sin actualizar ninguna ` +
        "línea contada del almacén seleccionado."
      );
    }

    // ========================================================
    // 3.4. NUEVO - UBICACIONES NO CONTADAS DEL MISMO PRODUCTO
    // ========================================================
    //
    // PROBLEMA QUE CORRIGE:
    //
    // SKU-00297
    //
    // Ubicación 159:
    //   inventory_quantity = 10
    //   qty_on_hand = 10
    //
    // Ubicación 158:
    //   inventory_quantity = NULL
    //   counted_by = NULL
    //   counted_at = NULL
    //   qty_on_hand = 15
    //
    // NUEVO RESULTADO:
    //
    // Ubicación 159 = 10
    // Ubicación 158 = 0
    //
    // IMPORTANTE:
    //
    // Solo se procesan productos del job COUNTED.
    // No se tocan productos de otros jobs.
    // No se modifica qty_available (columna generada).
    // No se modifica inventory_quantity.
    // No se envía un POST adicional a ADM Cloud.
    //
    // ========================================================

    console.log("");
    console.log("🟨 ========================================");
    console.log("📍 AJUSTANDO UBICACIONES NO CONTADAS");
    console.log("📌 SOLO PRODUCTOS DEL JOB COUNTED");
    console.log("🟨 ========================================");

    const zeroLocationsResult = await client.query(
      `
      WITH target_session AS (

        SELECT

          s.id,
          s.start_date,
          s.end_date,
          w.id AS warehouse_id

        FROM inventory_sessions s

        INNER JOIN warehouses w
          ON LOWER(w.erp_warehouse_id::text) =
             LOWER(s.erp_warehouse_id::text)

        WHERE s.id = $1::bigint

          AND s.status = 'review'

          AND LOWER(s.erp_warehouse_id::text) =
              LOWER($2::text)

          AND s.start_date IS NOT NULL

      ),

      counted_job_products AS (

        SELECT DISTINCT

          ier.sku AS product_sku

        FROM inventory_adjustment_job_lines jal

        INNER JOIN inventory_erp_report ier
          ON ier.id = jal.report_line_id

        INNER JOIN target_session ts
          ON ier.session_id = ts.id

        WHERE jal.job_id = $3::bigint

          AND jal.status = 'success'

          AND ier.wms_counted = true

          AND ier.sku IS NOT NULL

          AND LOWER(ier.erp_id::text) =
              LOWER(jal.erp_product_id::text)

          AND LOWER(jal.erp_warehouse_id::text) =
              LOWER($2::text)

      )

      UPDATE inventory_by_location AS ibl

      SET

        old_qty_on_hand = ibl.qty_on_hand,

        qty_on_hand = 0.000,

        updated_at = NOW()

      FROM target_session ts,
           counted_job_products cjp

      WHERE ibl.warehouse_id = ts.warehouse_id

        AND ibl.product_sku = cjp.product_sku

        -- Solo ubicaciones con cantidad pendiente.
        AND COALESCE(ibl.qty_on_hand, 0) <> 0

        -- Solo ubicaciones no contadas.
        AND ibl.counted_by IS NULL

        AND ibl.counted_at IS NULL

        AND ibl.inventory_quantity IS NULL

        -- No modificar ubicaciones con reservas.
        AND COALESCE(ibl.qty_reserved, 0) = 0

      RETURNING

        ibl.id,
        ibl.warehouse_id,
        ibl.location_id,
        ibl.product_sku,
        ibl.old_qty_on_hand,
        ibl.qty_on_hand,
        ibl.qty_reserved,
        ibl.qty_available
      `,
      [
        sessionId,
        erpWarehouseId,
        jobId
      ]
    );

    const zeroLocations =
      zeroLocationsResult.rows;

    console.log("");
    console.log("🟩 ========================================");
    console.log("✅ UBICACIONES NO CONTADAS AJUSTADAS");
    console.log("🆔 JOB ID:", jobId);
    console.log("📍 TOTAL UBICACIONES:", zeroLocations.length);

    zeroLocations.forEach(item => {

      console.log("📦 UBICACIÓN PUESTA EN CERO:", {
        id: item.id,
        sku: item.product_sku,
        warehouseId: item.warehouse_id,
        locationId: item.location_id,
        previousQty: item.old_qty_on_hand,
        newQty: item.qty_on_hand
      });

    });

    console.log("🟩 ========================================");

    // ========================================================
    // 3.5. RESUMEN FINAL COUNTED
    // ========================================================

    const totalUpdatedLocations =
      updatedLines + zeroLocations.length;

    console.log("");
    console.log("🟩🟩🟩 ========================================");
    console.log("✅ INVENTARIO COUNTED CONCILIADO EN WMS");
    console.log("🆔 JOB:", jobId);
    console.log("🆔 SESIÓN:", sessionId);
    console.log("🏬 ALMACÉN:", session.warehouse_name);
    console.log("📦 PRODUCTOS JOB:", totalLines);
    console.log("✅ UBICACIONES CONTADAS:", updatedLines);
    console.log("🟨 UBICACIONES NO CONTADAS A CERO:", zeroLocations.length);
    console.log("📍 TOTAL UBICACIONES ACTUALIZADAS:", totalUpdatedLocations);
    console.log("🟩🟩🟩 ========================================");

    return {

      type: "counted",

      jobId,

      sessionId,

      erpWarehouseId,

      wmsWarehouseId,

      totalProducts: totalLines,

      updatedLines: totalUpdatedLocations,

      updatedCountedLocations: updatedLines,

      updatedZeroLocations: zeroLocations.length,

      updatedInventory: [
        ...result.rows,
        ...zeroLocations
      ]
    };
  }

  // ==========================================================
  // 4. ZERO - PRODUCTOS NO CONTADOS
  // ==========================================================

  if (jobType === "zero") {

    console.log("");
    console.log("🟨 ========================================");
    console.log("📦 PROCESANDO JOB ZERO");
    console.log("🟨 ========================================");

    // ========================================================
    // 4.1. ERP LEGADO
    // ========================================================

    if (!isAdmCloud) {

      console.log(
        "📌 APLICANDO LÓGICA ZERO ERP LEGADO"
      );

      const result = await client.query(
        `
        UPDATE inventory_by_location AS ibl

        SET

          qty_on_hand = 0.000,

          qty_reserved = 0.000,

          updated_at = NOW()

        FROM warehouses w

        WHERE w.id = ibl.warehouse_id

          AND w.erp_warehouse_id::text = $1::text

          AND ibl.counted_by IS NULL

          AND ibl.counted_at IS NULL

          AND (
            COALESCE(ibl.qty_on_hand, 0) <> 0

            OR

            COALESCE(ibl.qty_reserved, 0) <> 0
          )

        RETURNING

          ibl.id,
          ibl.warehouse_id,
          ibl.product_sku,
          ibl.location_id,
          ibl.qty_on_hand,
          ibl.qty_reserved
        `,
        [erpWarehouseId]
      );

      return {
        type: "zero",
        jobId,
        sessionId,
        erpWarehouseId,
        totalProducts: totalLines,
        updatedLines: result.rows.length,
        updatedInventory: result.rows
      };
    }

    // ========================================================
    // 4.2. ZERO ADM CLOUD
    // ========================================================

    console.log("");
    console.log("🟦 ========================================");
    console.log("🌐 AJUSTE ZERO ADM CLOUD");
    console.log("🆔 JOB:", jobId);
    console.log("🆔 SESIÓN:", sessionId);
    console.log("🏬 ERP LOCATION:", erpWarehouseId);
    console.log("🟦 ========================================");

    // ========================================================
    // 4.3. VALIDAR SESIÓN Y ALMACÉN
    // ========================================================

    const sessionResult = await client.query(
      `
      SELECT

        s.id,
        s.code,
        s.status,
        s.start_date,
        s.end_date,
        s.erp_warehouse_id,

        w.id AS wms_warehouse_id,
        w.name AS warehouse_name

      FROM inventory_sessions s

      INNER JOIN warehouses w
        ON LOWER(w.erp_warehouse_id::text) =
           LOWER(s.erp_warehouse_id::text)

      WHERE s.id = $1::bigint

        AND LOWER(s.erp_warehouse_id::text) =
            LOWER($2::text)

      LIMIT 2
      `,
      [
        sessionId,
        erpWarehouseId
      ]
    );

    if (sessionResult.rows.length !== 1) {

      throw new Error(
        `No se pudo identificar un único almacén ` +
        `para la sesión ${sessionId}.`
      );
    }

    const session = sessionResult.rows[0];

    const wmsWarehouseId = Number(
      session.wms_warehouse_id
    );

    if (
      !Number.isSafeInteger(wmsWarehouseId) ||
      wmsWarehouseId <= 0
    ) {
      throw new Error(
        "El almacén interno WMS es inválido."
      );
    }

    if (session.status !== "review") {

      throw new Error(
        `La sesión ${session.code} no está en review.`
      );
    }

    if (!session.start_date) {

      throw new Error(
        "La sesión no tiene fecha de inicio."
      );
    }

    console.log("✅ SESIÓN Y ALMACÉN VALIDADOS:", {
      sessionId,
      code: session.code,
      wmsWarehouseId,
      warehouseName: session.warehouse_name
    });

    // ========================================================
    // 4.4. VALIDAR LÍNEAS ZERO
    // ========================================================

    const validationResult = await client.query(
      `
      SELECT

        COUNT(*)::integer AS total,

        COUNT(*) FILTER (

          WHERE jal.status <> 'success'
             OR jal.status IS NULL

             OR jal.desired_qty IS DISTINCT FROM 0

             OR LOWER(jal.erp_warehouse_id::text)
                IS DISTINCT FROM LOWER($2::text)

             OR ier.id IS NULL

             OR ier.session_id IS DISTINCT FROM $3::bigint

             OR ier.wms_counted IS DISTINCT FROM false

             OR LOWER(ier.erp_id::text)
                IS DISTINCT FROM
                LOWER(jal.erp_product_id::text)

        )::integer AS invalid_lines

      FROM inventory_adjustment_job_lines jal

      LEFT JOIN inventory_erp_report ier
        ON ier.id = jal.report_line_id

      WHERE jal.job_id = $1::bigint
      `,
      [
        jobId,
        erpWarehouseId,
        sessionId
      ]
    );

    const invalidLines = Number(
      validationResult.rows[0]?.invalid_lines ?? 0
    );

    if (
      Number(validationResult.rows[0]?.total ?? 0) !== totalLines ||
      invalidLines > 0
    ) {

      throw new Error(
        `El job ZERO ${jobId} contiene ` +
        `${invalidLines} líneas inválidas.`
      );
    }

    console.log(
      "✅ TODAS LAS LÍNEAS ZERO SON VÁLIDAS"
    );

    // ========================================================
    // 4.5. OBTENER PRODUCTOS DEL JOB
    // ========================================================

    const productsResult = await client.query(
      `
      SELECT DISTINCT

        jal.erp_product_id::text AS erp_product_id,

        p.sku

      FROM inventory_adjustment_job_lines jal

      INNER JOIN inventory_erp_report ier
        ON ier.id = jal.report_line_id

      LEFT JOIN products p
        ON LOWER(p.erp_id::text) =
           LOWER(jal.erp_product_id::text)

      WHERE jal.job_id = $1::bigint

        AND jal.status = 'success'

        AND jal.desired_qty = 0

        AND ier.session_id = $2::bigint

        AND ier.wms_counted = false

      ORDER BY
        jal.erp_product_id::text,
        p.sku
      `,
      [
        jobId,
        sessionId
      ]
    );

    const products = productsResult.rows;

    const mappedProducts = products.filter(
      item => item.sku
    );

    console.log("📦 PRODUCTOS DEL JOB:", products.length);
    console.log(
      "📦 PRODUCTOS CON SKU EN WMS:",
      mappedProducts.length
    );

    // ========================================================
    // 4.6. VALIDAR CONFLICTOS CON PRODUCTOS CONTADOS
    // ========================================================

    const countedConflictResult = await client.query(
      `
      SELECT DISTINCT

        ibl.product_sku,

        ibl.location_id,

        ibl.inventory_quantity,

        ibl.counted_at

      FROM inventory_by_location ibl

      INNER JOIN products p
        ON p.sku = ibl.product_sku

      INNER JOIN inventory_adjustment_job_lines jal
        ON LOWER(jal.erp_product_id::text) =
           LOWER(p.erp_id::text)

      WHERE jal.job_id = $1::bigint

        AND ibl.warehouse_id = $2::bigint

        AND ibl.counted_by IS NOT NULL

        AND ibl.counted_at IS NOT NULL

        AND ibl.inventory_quantity IS NOT NULL

        AND ibl.counted_at >= $3::timestamptz

        AND (
          $4::timestamptz IS NULL
          OR ibl.counted_at <= $4::timestamptz
        )

      LIMIT 10
      `,
      [
        jobId,
        wmsWarehouseId,
        session.start_date,
        session.end_date
      ]
    );

    if (countedConflictResult.rows.length > 0) {

      console.error(
        "🛑 PRODUCTOS CONTADOS EN JOB ZERO:",
        countedConflictResult.rows
      );

      throw new Error(
        "El job ZERO contiene productos que fueron " +
        "contados físicamente durante esta sesión."
      );
    }

    console.log(
      "✅ NO EXISTEN CONFLICTOS CON PRODUCTOS CONTADOS"
    );

    // ========================================================
    // 4.7. VALIDAR RESERVAS DE PRODUCTOS ZERO
    // ========================================================

    const reservedZeroResult = await client.query(
      `
      SELECT

        ibl.id,
        ibl.product_sku,
        ibl.location_id,
        ibl.qty_reserved

      FROM inventory_by_location ibl

      INNER JOIN products p
        ON p.sku = ibl.product_sku

      INNER JOIN inventory_adjustment_job_lines jal
        ON LOWER(jal.erp_product_id::text) =
           LOWER(p.erp_id::text)

      WHERE jal.job_id = $1::bigint

        AND ibl.warehouse_id = $2::bigint

        AND COALESCE(ibl.qty_reserved, 0) <> 0

      LIMIT 20
      `,
      [
        jobId,
        wmsWarehouseId
      ]
    );

    if (reservedZeroResult.rows.length > 0) {

      console.error(
        "🛑 RESERVAS PENDIENTES EN JOB ZERO:",
        reservedZeroResult.rows
      );

      throw new Error(
        "Existen reservas pendientes para productos " +
        "del job ZERO. Deben conciliarse antes " +
        "de actualizar sus existencias locales."
      );
    }

    // ========================================================
    // 4.8. ACTUALIZAR EXISTENCIAS LOCALES WMS
    // ========================================================
    //
    // qty_available ES UNA COLUMNA GENERATED.
    // NO SE ACTUALIZA DIRECTAMENTE.
    //
    // ========================================================

    console.log("");
    console.log("🟨 ACTUALIZANDO EXISTENCIAS LOCALES");

    const result = await client.query(
      `
      WITH job_products AS (

        SELECT DISTINCT

          p.sku AS product_sku

        FROM inventory_adjustment_job_lines jal

        INNER JOIN inventory_erp_report ier
          ON ier.id = jal.report_line_id

        INNER JOIN products p
          ON LOWER(p.erp_id::text) =
             LOWER(jal.erp_product_id::text)

        WHERE jal.job_id = $1::bigint

          AND jal.status = 'success'

          AND jal.desired_qty = 0

          AND LOWER(jal.erp_warehouse_id::text) =
              LOWER($2::text)

          AND ier.session_id = $3::bigint

          AND ier.wms_counted = false

          AND LOWER(ier.erp_id::text) =
              LOWER(jal.erp_product_id::text)
      )

      UPDATE inventory_by_location AS ibl

      SET

        old_qty_on_hand = ibl.qty_on_hand,

        qty_on_hand = 0.000,

        updated_at = NOW()

      FROM job_products jp

      WHERE ibl.warehouse_id = $4::bigint

        AND ibl.product_sku = jp.product_sku

        AND COALESCE(ibl.qty_on_hand, 0) <> 0

        AND COALESCE(ibl.qty_reserved, 0) = 0

        AND NOT EXISTS (

          SELECT 1

          FROM inventory_by_location counted

          WHERE counted.warehouse_id = ibl.warehouse_id

            AND counted.product_sku = ibl.product_sku

            AND counted.counted_by IS NOT NULL

            AND counted.counted_at IS NOT NULL

            AND counted.inventory_quantity IS NOT NULL

            AND counted.counted_at >= $5::timestamptz

            AND (
              $6::timestamptz IS NULL
              OR counted.counted_at <= $6::timestamptz
            )
        )

      RETURNING

        ibl.id,
        ibl.warehouse_id,
        ibl.location_id,
        ibl.product_sku,
        ibl.old_qty_on_hand,
        ibl.qty_on_hand,
        ibl.qty_available,
        ibl.qty_reserved
      `,
      [
        jobId,
        erpWarehouseId,
        sessionId,
        wmsWarehouseId,
        session.start_date,
        session.end_date
      ]
    );

    const updatedLines = result.rows.length;

    console.log("");
    console.log("🟩 ========================================");
    console.log("✅ JOB ZERO CONCILIADO EN WMS");
    console.log("🆔 JOB ID:", jobId);
    console.log("🆔 SESSION ID:", sessionId);
    console.log("🏬 ALMACÉN:", session.warehouse_name);
    console.log("📦 PRODUCTOS JOB:", totalLines);
    console.log("📍 UBICACIONES ACTUALIZADAS:", updatedLines);
    console.log("🟩 ========================================");

    return {
      type: "zero",
      jobId,
      sessionId,
      erpWarehouseId,
      wmsWarehouseId,
      totalProducts: totalLines,
      updatedLines,
      updatedInventory: result.rows
    };
  }

  // ==========================================================
  // 5. JOB TYPE NO SOPORTADO
  // ==========================================================

  throw new Error(
    `Job type no soportado para actualizar WMS: ${jobType}`
  );
}



















// ============================================================
// MARCAR JOB COMPLETED
// ============================================================

// ============================================================
// MARCAR JOB COMPLETED
// ============================================================

async function markJobCompleted(
  jobId
) {

  // Primero sincronizamos contadores.
  await refreshJobCounters(
    jobId
  );


  const client =
    await db.connect();


  try {

    await client.query(
      "BEGIN"
    );


    // ========================================================
    // OBTENER JOB Y BLOQUEARLO
    // ========================================================

    const jobResult =
      await client.query(
        `
        SELECT
          id,
          inventory_session_id,
          job_type,
          erp_warehouse_id,
          status,
          total_products,
          processed_products,
          successful_products,
          failed_products

        FROM inventory_adjustment_jobs

        WHERE
          id = $1

        FOR UPDATE
        `,
        [
          jobId
        ]
      );


    const job =
      jobResult.rows[0];


    if (!job) {

      throw new Error(
        `No existe el job ${jobId}.`
      );

    }


    // ========================================================
    // SEGURIDAD:
    // TODAS LAS LÍNEAS DEBEN ESTAR SUCCESS
    // ========================================================

    const linesResult =
      await client.query(
        `
        SELECT
          COUNT(*)::integer AS total,

          COUNT(*) FILTER (
            WHERE status = 'success'
          )::integer AS successful,

          COUNT(*) FILTER (
            WHERE status <> 'success'
          )::integer AS not_success

        FROM inventory_adjustment_job_lines

        WHERE
          job_id = $1
        `,
        [
          jobId
        ]
      );


    const counters =
      linesResult.rows[0];


    const total =
      Number(
        counters.total || 0
      );


    const successful =
      Number(
        counters.successful || 0
      );


    const notSuccess =
      Number(
        counters.not_success || 0
      );


    console.log(
      "📊 VALIDANDO JOB ANTES DE ACTUALIZAR WMS:",
      {
        total,
        successful,
        notSuccess
      }
    );


    if (
      total === 0 ||
      notSuccess > 0 ||
      successful !== total
    ) {

      throw new Error(
        `El job ${jobId} no puede finalizar. ` +
        `${successful}/${total} líneas están success.`
      );

    }


    // ========================================================
    // ACTUALIZAR INVENTARIO LOCAL WMS
    // ========================================================

    const wmsResult =
      await applyCompletedInventoryJobToWms(
        client,
        job
      );


    console.log(
      "📦 RESULTADO ACTUALIZACIÓN WMS:",
      wmsResult
    );


    // ========================================================
    // MARCAR JOB COMPLETED
    // ========================================================

    await client.query(
      `
      UPDATE inventory_adjustment_jobs

      SET
        status =
          'completed',

        current_line_id =
          NULL,

        error_message =
          NULL,

        completed_at =
          NOW(),

        updated_at =
          NOW()

      WHERE
        id = $1
      `,
      [
        jobId
      ]
    );


    await client.query(
      "COMMIT"
    );


    console.log("");
    console.log(
      "🟩🟩🟩 ========================================"
    );

    console.log(
      "✅ AJUSTE CITRUS COMPLETADO"
    );

    console.log(
      "✅ INVENTARIO WMS ACTUALIZADO"
    );

    console.log(
      `✅ JOB ${jobId} COMPLETED`
    );

    console.log(
      "🟩🟩🟩 ========================================"
    );


  } catch (error) {

    await client.query(
      "ROLLBACK"
    );


    console.error(
      "🟥 ERROR FINALIZANDO INVENTORY JOB:",
      jobId
    );

    console.error(
      error
    );


    throw error;


  } finally {

    client.release();

  }

}



// ============================================================
// RECUPERAR LÍNEAS INTERRUMPIDAS
// ============================================================
//
// CASO:
//
// Node estaba procesando:
//
// línea 100 → processing
//
// Citrus recibió el ajuste,
// pero Node/PM2 se reinició.
//
// NO podemos ponerla pending.
//
// Porque podríamos ejecutar el ajuste nuevamente.
//
// Primero debe verificarse.
//
// ============================================================

async function recoverInterruptedLines(
  jobId
) {

  const result =
    await db.query(
      `
      UPDATE inventory_adjustment_job_lines

      SET

        status =
          'verifying',

        citrus_message =
          'El worker fue interrumpido mientras procesaba esta línea. Se verificará la existencia antes de continuar.',

        next_retry_at =
          NOW(),

        updated_at =
          NOW()

      WHERE
        job_id = $1

        AND status =
          'processing'

      RETURNING
        id
      `,
      [
        jobId
      ]
    );


  if (
    result.rows.length > 0
  ) {

    console.log(
      "⚠️ LÍNEAS INTERRUMPIDAS RECUPERADAS:",
      result.rows.map(
        row =>
          row.id
      )
    );

  }

}



// ============================================================
// ============================================================
// WORKER PRINCIPAL
// ============================================================
// ============================================================

export async function startInventoryAdjustmentWorker(
  jobId
) {

  jobId =
    Number(
      jobId
    );


  if (
    !Number.isInteger(
      jobId
    ) ||
    jobId <= 0
  ) {

    throw new Error(
      `Job ID inválido: ${jobId}`
    );

  }



  // ============================================================
  // PROTECCIÓN EN MEMORIA
  // ============================================================

  if (
    runningJobs.has(
      jobId
    )
  ) {

    console.log(
      `ℹ️ El job ${jobId} ya está ejecutándose en este proceso.`
    );

    return;

  }



  // ============================================================
  // POSTGRES ADVISORY LOCK
  // ============================================================
  //
  // Si por alguna razón existen:
  //
  // - dos llamadas al controller
  // - dos procesos PM2
  // - dos workers
  //
  // solamente uno podrá ejecutar este job.
  //
  // ============================================================

  const lockClient =
    await db.connect();


  let lockAcquired =
    false;


  try {

    const lockResult =
      await lockClient.query(
        `
        SELECT
          pg_try_advisory_lock(
            $1::bigint
          ) AS locked
        `,
        [
          jobId
        ]
      );


    lockAcquired =
      lockResult
        .rows[0]
        ?.locked === true;


    if (
      !lockAcquired
    ) {

      console.log(
        `ℹ️ Otro worker ya tiene bloqueado el job ${jobId}.`
      );

      return;

    }


    runningJobs.add(
      jobId
    );


    console.log("");
    console.log(
      "🚀🚀🚀 ========================================"
    );

    console.log(
      "🚀 INVENTORY ADJUSTMENT WORKER"
    );

    console.log(
      "🆔 JOB ID:",
      jobId
    );

    console.log(
      "🚀🚀🚀 ========================================"
    );



    // ==========================================================
    // BUSCAR JOB
    // ==========================================================

    let job =
      await getJob(
        jobId
      );


    if (!job) {

      throw new Error(
        `No existe inventory_adjustment_job ${jobId}.`
      );

    }



    // ==========================================================
    // NO PROCESAR JOB FINALIZADO
    // ==========================================================

    if (
      job.status ===
      "completed"
    ) {

      console.log(
        `✅ Job ${jobId} ya está completed.`
      );

      return;

    }



    // ==========================================================
    // NO REANUDAR FAILED AUTOMÁTICAMENTE
    // ==========================================================
    //
    // Success = 0 significa un error real de Citrus.
    //
    // Ejemplo:
    //
    // "No existe Almacén con Id 0."
    //
    // Ese problema debe corregirse antes.
    //
    // ==========================================================

    if (
      job.status ===
      "failed"
    ) {

      console.log(
        `🟥 Job ${jobId} está failed. No se reanudará automáticamente.`
      );

      console.log(
        "Mensaje:",
        job.error_message
      );

      return;

    }



    // ==========================================================
    // RECUPERAR PROCESSING
    // ==========================================================

    await recoverInterruptedLines(
      jobId
    );


    await markJobProcessing(
      jobId
    );

    await emitInventoryAdjustmentProgress(
      jobId,
      {
        phase:
          "processing",

        message:
          "Iniciando ajuste de inventario..."
      }
    );

    // ==========================================================
    // LOOP PRINCIPAL
    // ==========================================================

    while (true) {

      // Volvemos a obtener job.

      job =
        await getJob(
          jobId
        );


      if (!job) {

        throw new Error(
          `El job ${jobId} dejó de existir.`
        );

      }


      if (
        job.status ===
        "failed"
      ) {

        console.log(
          "🟥 JOB FAILED. DETENIENDO WORKER."
        );

        return;

      }


      if (
        job.status ===
        "completed"
      ) {

        return;

      }



      // ========================================================
      // OBTENER SIGUIENTE LÍNEA
      // ========================================================

      const line =
        await getNextJobLine(
          jobId
        );


      // ========================================================
      // NO QUEDAN LÍNEAS
      // ========================================================
      //
      // IMPORTANTE:
      //
      // SI getNextJobLine() DEVUELVE NULL,
      // SIGNIFICA QUE YA NO HAY NADA MÁS QUE PROCESAR.
      //
      // DEBEMOS VALIDAR ESTO ANTES DE USAR:
      // line.status
      // line.id
      // line.erp_product_id
      //
      // ========================================================

      if (!line) {

        console.log("");
        console.log(
          "✅✅✅ ========================================"
        );

        console.log(
          `✅ NO QUEDAN LÍNEAS PARA EL JOB ${jobId}`
        );

        console.log(
          "✅ MARCANDO JOB COMO COMPLETED"
        );

        console.log(
          "✅✅✅ ========================================"
        );


        try {

          await markJobCompleted(jobId);

        } catch (closeError) {

          const message =
            "El ERP puede estar ajustado, pero falló " +
            "el cierre local WMS: " +
            closeError.message +
            ". Revisar la sesión sin repetir el POST ADM Cloud.";

          console.error(
            "🟥 ERROR DE CONCILIACIÓN FINAL:",
            message
          );

          await markJobFailed({
            jobId,
            lineId: job.current_line_id ?? null,
            message
          });

          await emitInventoryAdjustmentProgress(jobId, {
            phase: "failed",
            message
          });

          return;
        }


        await emitInventoryAdjustmentProgress(
          jobId,
          {

            phase:
              "completed",

            message:
              "El ajuste de inventario terminó correctamente."

          }
        );


        console.log(
          `🏁 JOB ${jobId} COMPLETADO CORRECTAMENTE`
        );


        return;

      }


      // ========================================================
      // EMITIR PRODUCTO QUE SE VA A PROCESAR
      // ========================================================
      //
      // AQUÍ YA SABEMOS QUE line EXISTE.
      //
      // ========================================================

      await emitInventoryAdjustmentProgress(
        jobId,
        {

          phase:
            line.status,

          message:
            "Procesando producto...",

          currentProduct: {

            lineId:
              Number(
                line.id
              ),

            erpProductId: String(line.erp_product_id),

            desiredQty:
              Number(
                line.desired_qty
              ),

            citrusQtyBefore:
              Number(
                line.citrus_qty_before
              )

          }

        }
      );



      console.log("");
      console.log(
        "────────────────────────────────────────"
      );

      console.log(
        "📦 SIGUIENTE LÍNEA:",
        line.id
      );

      console.log(
        "📊 ESTADO:",
        line.status
      );

      console.log(
        "📈 PROGRESO:",
        `${job.processed_products}/${job.total_products}`
      );

      console.log(
        "────────────────────────────────────────"
      );



      // ========================================================
      // PENDING
      // ========================================================

      if (
        line.status ===
        "pending"
      ) {

        const result =
          await executeAdjustment({

            job,

            line,

            cantidadActual:
              Number(
                line.citrus_qty_before
              )

          });



        // ======================================================
        // SUCCESS
        // ======================================================

        if (
          result.status ===
          "success"
        ) {

          await emitInventoryAdjustmentProgress(
            jobId,
            {

              phase:
                "product_completed",

              message:
                `Producto ${line.erp_product_id} ajustado correctamente.`,

              currentProduct: {

                lineId:
                  Number(line.id),

                erpProductId: String(line.erp_product_id),

                desiredQty:
                  Number(
                    line.desired_qty
                  )

              }

            }
          );


          continue;

        }



        // ======================================================
        // FAILED REAL
        // ======================================================

        if (
          result.status ===
          "failed"
        ) {

          console.error("");
          console.error(
            "🟥 WORKER DETENIDO."
          );

          console.error(
            "🟥 ERROR EN EL AJUSTE DE INVENTARIO"
          );

          console.error(
            "🟥 LINE ID:",
            line.id
          );

          console.error(
            "🟥 MESSAGE:",
            result.message
          );

          await emitInventoryAdjustmentProgress(
            jobId,
            {

              phase:
                "failed",

              message:
                result.message,

              currentProduct: {

                lineId:
                  Number(line.id),

                erpProductId: String(line.erp_product_id)

              }

            }
          );




          return;

        }



        // ======================================================
        // VERIFICAR
        // ======================================================

        if (
          result.status ===
          "verify"
        ) {

          await emitInventoryAdjustmentProgress(
            jobId,
            {

              phase:
                "verifying",

              message:
                "Verificando el ajuste con Citrus...",

              currentProduct: {

                lineId:
                  Number(line.id),

                erpProductId: String(line.erp_product_id)

              }

            }
          );


          continue;

        }

      }



      // ========================================================
      // VERIFYING
      // ========================================================

      if (
        line.status ===
        "verifying"
      ) {

        const result =
          await verifyLine(
            job,
            line
          );


        if (
          result.status ===
          "failed"
        ) {

          return;

        }


        continue;

      }



      // ========================================================
      // WAITING CITRUS
      // ========================================================

      if (
        line.status ===
        "waiting_citrus"
      ) {

        await emitInventoryAdjustmentProgress(
          jobId,
          {

            phase:
              "waiting_citrus",

            message:
              "Esperando confirmación de Citrus...",

            currentProduct: {

              lineId:
                Number(line.id),

              erpProductId: String(line.erp_product_id)

            }

          }
        );

        const result =
          await verifyLine(
            job,
            line
          );


        if (
          result.status ===
          "failed"
        ) {

          return;

        }


        continue;

      }

    }


  } catch (error) {

    console.error("");
    console.error(
      "🟥🟥🟥 ========================================"
    );

    console.error(
      "❌ ERROR NO CONTROLADO EN INVENTORY WORKER"
    );

    console.error(
      "JOB:",
      jobId
    );

    console.error(
      error
    );

    console.error(
      "🟥🟥🟥 ========================================"
    );


    // IMPORTANTE:
    //
    // NO ponemos el job automáticamente failed.
    //
    // Un crash inesperado puede ocurrir justo después
    // de que Citrus realizó un ajuste.
    //
    // Al reiniciar, processing será convertido
    // en verifying.


  } finally {

    // ==========================================================
    // LIBERAR ADVISORY LOCK
    // ==========================================================

    if (
      lockAcquired
    ) {

      try {

        await lockClient.query(
          `
          SELECT
            pg_advisory_unlock(
              $1::bigint
            )
          `,
          [
            jobId
          ]
        );


      } catch (error) {

        console.error(
          "🟥 ERROR LIBERANDO ADVISORY LOCK:",
          error
        );

      }

    }


    runningJobs.delete(
      jobId
    );


    lockClient.release();


    console.log(
      `🛑 Worker job ${jobId} finalizado/liberado.`
    );

  }

}



// ============================================================
// ============================================================
// RECUPERAR JOBS AL REINICIAR NODE / PM2
// ============================================================
// ============================================================
//
// DEBES LLAMAR ESTA FUNCIÓN UNA VEZ
// CUANDO ARRANQUE TU SERVIDOR.
//
// Ejemplo:
//
// resumeInventoryAdjustmentWorkers();
//
// ============================================================

export async function resumeInventoryAdjustmentWorkers() {

  console.log("");
  console.log(
    "🔄 BUSCANDO JOBS DE INVENTARIO INTERRUMPIDOS..."
  );


  try {

    const result =
      await db.query(
        `
        SELECT
          id,
          status

        FROM inventory_adjustment_jobs

        WHERE
          status IN (
            'pending',
            'processing',
            'waiting_citrus'
          )

        ORDER BY
          id ASC
        `
      );


    const jobs =
      result.rows;


    console.log(
      "📦 JOBS PARA RECUPERAR:",
      jobs.length
    );


    for (
      const job
      of jobs
    ) {

      const jobId =
        Number(
          job.id
        );


      console.log(
        "🔄 RECUPERANDO JOB:",
        jobId,
        "STATUS:",
        job.status
      );


      // No await.
      //
      // Cada worker queda independiente.

      startInventoryAdjustmentWorker(
        jobId
      )
        .catch(
          error => {

            console.error(
              `🟥 ERROR RECUPERANDO JOB ${jobId}:`,
              error
            );

          }
        );

    }


  } catch (error) {

    console.error(
      "🟥 ERROR BUSCANDO JOBS PARA RECUPERAR:"
    );

    console.error(
      error
    );

  }

}



// ============================================================
// EMAIL ERROR AJUSTE CITRUS
// ============================================================

async function sendCitrusAdjustmentErrorEmail({
  job,
  line,
  error
}) {

  try {

    console.log("");
    console.log(
      "📧 ENVIANDO EMAIL DE ERROR DE AJUSTE..."
    );


    await sgMail.send({

      to:
        CITRUS_ALERT_EMAIL,

      from: {
        email:
          CITRUS_ALERT_FROM,

        name:
          "Sidial WMS"
      },

      subject:
        `Error ajustando inventario en Citrus - Job ${job.id}`,

      text:
        `
Ocurrió un error durante el ajuste de inventario en Citrus.

Job ID: ${job.id}
Inventory Session ID: ${job.inventory_session_id}

Line ID: ${line.id}
Report Line ID: ${line.report_line_id}

ERP Product ID: ${line.erp_product_id}
ERP Warehouse ID: ${line.erp_warehouse_id}

Cantidad actual: ${line.citrus_qty_before}
Cantidad deseada: ${line.desired_qty}

Error:
${error.message}

Código:
${error.code || "N/A"}

El job fue detenido para evitar ajustes incorrectos.
      `,

      html:
        `
<h2>Error ajustando inventario en Citrus</h2>

<p>
  Citrus rechazó uno de los ajustes de inventario.
</p>

<p>
  <b>Job ID:</b>
  ${job.id}
</p>

<p>
  <b>Inventory Session ID:</b>
  ${job.inventory_session_id}
</p>

<p>
  <b>Line ID:</b>
  ${line.id}
</p>

<p>
  <b>ERP Product ID:</b>
  ${line.erp_product_id}
</p>

<p>
  <b>ERP Warehouse ID:</b>
  ${line.erp_warehouse_id}
</p>

<p>
  <b>Cantidad actual:</b>
  ${line.citrus_qty_before}
</p>

<p>
  <b>Cantidad deseada:</b>
  ${line.desired_qty}
</p>

<p>
  <b>Error:</b>
  ${error.message}
</p>

<p>
  <b>Código:</b>
  ${error.code || "N/A"}
</p>

<p>
  El proceso fue detenido para evitar ajustes incorrectos.
</p>
      `
    });


    console.log(
      "✅ EMAIL DE ERROR ENVIADO."
    );


  } catch (emailError) {

    // El fallo del correo NO debe romper
    // el manejo del error original.

    console.error(
      "🟥 ERROR ENVIANDO EMAIL DE ERROR:"
    );

    console.error(
      emailError
    );

  }

}
