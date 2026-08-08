

import sgMail from "@sendgrid/mail";
//🟧🟧🟧🟧🟧🟧🟧🟧🟧🟧🟧🟧 Every ERP will have different function
import {
  buscarExistenciaActualCitrus
} from "../integrations/citrus/citrus.erpStockSync.js";
// ============================================================
// AJUSTA ESTAS RUTAS SEGÚN TU PROYECTO
// ============================================================

import { db } from "../db.js";

import {
  ajustarExistenciaAlmacen
} from "../integrations/citrus/adjustWarehouseInventoryService.js";


// ============================================================
// SENDGRID
// ============================================================

sgMail.setApiKey(
  process.env.SENDGRID_API_KEY
);


// ============================================================
// CONFIGURACIÓN
// ============================================================

const FAST_VERIFICATION_ATTEMPTS = 12;

const FAST_VERIFICATION_DELAY_MS =
  10_000;


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
        + INTERVAL '10 seconds',

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

async function executeAdjustment({
  job,
  line,
  cantidadActual
}) {

  console.log("");
  console.log(
    "🟨🟨🟨 ========================================"
  );

  console.log(
    "📦 PROCESANDO LÍNEA:",
    line.id
  );

  console.log(
    "🆔 ERP PRODUCT:",
    line.erp_product_id
  );

  console.log(
    "🏬 ERP WAREHOUSE:",
    line.erp_warehouse_id
  );

  console.log(
    "📊 CANTIDAD ACTUAL:",
    cantidadActual
  );

  console.log(
    "🎯 CANTIDAD DESEADA:",
    line.desired_qty
  );

  console.log(
    "🟨🟨🟨 ========================================"
  );


  await markJobProcessing(
    job.id,
    line.id
  );


  await markLineProcessing(
    line.id
  );


  try {

    // ==========================================================
    // LLAMAR TU SERVICIO YA EXISTENTE
    // ==========================================================

    const resultado =
      await withTimeout(

        ajustarExistenciaAlmacen([
          {

            itemId:
              Number(
                line.erp_product_id
              ),

            almacenId:
              Number(
                line.erp_warehouse_id
              ),

            cantidadNueva:
              Number(
                line.desired_qty
              ),

            cantidadActual:
              Number(
                cantidadActual
              )

          }
        ]),

        WORKER_REQUEST_TIMEOUT_MS,

        "Citrus no respondió al ajuste dentro del tiempo esperado."

      );


    const citrusResult =
      getCitrusResult(
        resultado
      );


    console.log(
      "📦 CITRUS RESULT:",
      citrusResult
    );


    const success =
      getCitrusSuccess(
        citrusResult
      );


    // ==========================================================
    // SUCCESS = 1
    // ==========================================================

    if (
      success === 1
    ) {

      console.log(
        "✅ AJUSTE EXITOSO."
      );


      await markLineSuccess({

        lineId:
          line.id,

        citrusMessage:
          citrusResult?.Mensaje ||
          "OK",

        citrusResponse:
          citrusResult,

        currentQty:
          cantidadActual

      });


      await refreshJobCounters(
        job.id
      );


      return {
        status:
          "success"
      };

    }



    // ==========================================================
    // SUCCESS = 0
    // ==========================================================

    if (
      success === 0
    ) {

      const message =
        citrusResult?.Mensaje ||
        "Citrus rechazó el ajuste de inventario.";


      console.error("");
      console.error(
        "🟥 ERROR EN EL AJUSTE DE INVENTARIO"
      );

      console.error(
        "🟥 MENSAJE CITRUS:",
        message
      );


      await markLineFailed({

        lineId:
          line.id,

        citrusMessage:
          message,

        citrusResponse:
          citrusResult

      });


      await markJobFailed({

        jobId:
          job.id,

        lineId:
          line.id,

        message

      });


      return {

        status:
          "failed",

        message

      };

    }



    // ==========================================================
    // NO SUCCESS 0 NI SUCCESS 1
    // ==========================================================
    //
    // NO sabemos si Citrus realizó el ajuste.
    //
    // NO LO VOLVEMOS A MANDAR.
    //
    // Primero verificamos la existencia.
    //
    // ==========================================================

    console.log(
      "⚠️ RESPUESTA INDETERMINADA."
    );

    console.log(
      "🔎 SE VERIFICARÁ EXISTENCIA."
    );


    await markLineVerifying({

      lineId:
        line.id,

      message:
        "Respuesta indeterminada de Citrus. Verificando existencia.",

      response:
        citrusResult

    });


    return {
      status:
        "verify"
    };


  } catch (error) {

    // ==========================================================
    // TIMEOUT / INTERNET / CITRUS CAÍDO
    // ==========================================================
    //
    // NO sabemos si Citrus recibió el ajuste.
    //
    // Por eso NO ponemos failed
    // y NO reenviamos inmediatamente.
    //
    // ==========================================================

    console.error("");
    console.error(
      "⚠️ NO SE PUDO CONFIRMAR EL AJUSTE."
    );

    console.error(
      error.message
    );


    await markLineVerifying({

      lineId:
        line.id,

      message:
        error.message ||
        "No se pudo confirmar la respuesta de Citrus.",

      response:
        serializeError(
          error
        )

    });


    return {
      status:
        "verify"
    };

  }

}



// ============================================================
// VERIFICAR EXISTENCIA EN CITRUS
// ============================================================

async function verifyLine(
  job,
  originalLine
) {

  let line =
    await getLine(
      originalLine.id
    );


  if (!line) {

    throw new Error(
      `No existe la línea ${originalLine.id}.`
    );

  }



  // ============================================================
  // SI ESTÁ EN WAITING_CITRUS
  // YA SUPERÓ LOS 12 INTENTOS RÁPIDOS
  // ============================================================

  const slowMode =
    line.status ===
      "waiting_citrus";



  // ============================================================
  // RESPETAR next_retry_at
  // ============================================================

  if (
    line.next_retry_at
  ) {

    const nextRetry =
      new Date(
        line.next_retry_at
      ).getTime();


    const now =
      Date.now();


    if (
      nextRetry > now
    ) {

      const waitTime =
        nextRetry -
        now;


      console.log(
        `⏳ Esperando ${Math.ceil(
          waitTime / 1000
        )} segundos antes de consultar Citrus...`
      );


      await sleep(
        waitTime
      );

    }

  }



  console.log("");
  console.log(
    "🔎 VERIFICANDO EXISTENCIA EN CITRUS"
  );

  console.log(
    "📦 LINE ID:",
    line.id
  );

  console.log(
    "🆔 ERP PRODUCT:",
    line.erp_product_id
  );

  console.log(
    "🎯 CANTIDAD DESEADA:",
    line.desired_qty
  );



  try {

    // ==========================================================
    // CONSULTAR EXISTENCIA REAL
    // ==========================================================

    const existenciaActual =
      await withTimeout(

        buscarExistenciaActualCitrus({

          itemId:
            Number(
              line.erp_product_id
            ),

          almacenId:
            Number(
              line.erp_warehouse_id
            )

        }),

        WORKER_REQUEST_TIMEOUT_MS,

        "Citrus no respondió al consultar existencia."

      );


    const currentQty =
      Number(
        existenciaActual
      );


    if (
      !Number.isFinite(
        currentQty
      )
    ) {

      throw new Error(
        `La existencia obtenida de Citrus no es válida: ${existenciaActual}`
      );

    }


    console.log(
      "✅ CITRUS RESPONDIÓ."
    );

    console.log(
      "📊 EXISTENCIA ACTUAL:",
      currentQty
    );


    const desiredQty =
      Number(
        line.desired_qty
      );



    // ==========================================================
    // EXISTENCIA YA ES IGUAL A LA DESEADA
    // ==========================================================
    //
    // Significa que probablemente el ajuste anterior
    // sí se realizó pero perdimos la respuesta.
    //
    // NO volvemos a ajustar.
    //
    // ==========================================================

    if (
      currentQty ===
      desiredQty
    ) {

      console.log(
        "✅ EXISTENCIA YA COINCIDE."
      );

      console.log(
        "✅ MARCANDO LÍNEA COMO SUCCESS."
      );


      await markLineSuccess({

        lineId:
          line.id,

        citrusMessage:
          "Ajuste confirmado mediante consulta de existencia en Citrus.",

        citrusResponse: {
          verified:
            true,

          currentQty,

          desiredQty
        },

        currentQty

      });


      await markJobProcessing(
        job.id,
        line.id
      );


      await refreshJobCounters(
        job.id
      );


      return {
        status:
          "success"
      };

    }



    // ==========================================================
    // CITRUS RESPONDIÓ PERO LA EXISTENCIA ES DIFERENTE
    // ==========================================================
    //
    // AHORA SÍ podemos volver a ajustar.
    //
    // PERO utilizamos:
    //
    // cantidadActual = EXISTENCIA RECIÉN CONSULTADA
    //
    // cantidadNueva = desired_qty
    //
    // ==========================================================

    console.log("");
    console.log(
      "⚠️ EXISTENCIA DIFERENTE."
    );

    console.log(
      "📊 Citrus:",
      currentQty
    );

    console.log(
      "🎯 Deseada:",
      desiredQty
    );

    console.log(
      "🔄 REINTENTANDO AJUSTE CON EXISTENCIA NUEVA."
    );


    // Actualizar cantidad actual conocida.

    await db.query(
      `
      UPDATE inventory_adjustment_job_lines

      SET

        citrus_qty_before =
          $2,

        status =
          'verifying',

        next_retry_at =
          NULL,

        updated_at =
          NOW()

      WHERE
        id = $1
      `,
      [
        line.id,
        currentQty
      ]
    );


    line =
      await getLine(
        line.id
      );


    // ==========================================================
    // VOLVER A EJECUTAR AJUSTE
    // ==========================================================

    const result =
      await executeAdjustment({

        job,

        line,

        cantidadActual:
          currentQty

      });


    return result;


  } catch (error) {

    // ==========================================================
    // CITRUS SIGUE SIN RESPONDER
    // ==========================================================

    console.error("");
    console.error(
      "🟥 CITRUS NO RESPONDE A CONSULTA DE EXISTENCIA."
    );

    console.error(
      error.message
    );


    // Volver a leer línea.

    line =
      await getLine(
        line.id
      );


    const attempts =
      Number(
        line.verification_attempts ||
        0
      ) + 1;



    // ==========================================================
    // PRIMEROS 12 INTENTOS
    // ==========================================================

    if (
      attempts <
      FAST_VERIFICATION_ATTEMPTS
    ) {

      console.log(
        `🔄 INTENTO ${attempts}/${FAST_VERIFICATION_ATTEMPTS}`
      );


      await incrementVerificationAttempt({

        lineId:
          line.id,

        message:
          `Citrus no responde. Intento ${attempts}/${FAST_VERIFICATION_ATTEMPTS}.`,

        nextDelaySeconds:
          FAST_VERIFICATION_DELAY_MS /
          1000

      });


      return {
        status:
          "verify"
      };

    }



    // ==========================================================
    // INTENTO 12
    // ==========================================================

    if (
      attempts ===
      FAST_VERIFICATION_ATTEMPTS
    ) {

      console.error("");
      console.error(
        "🟥 CITRUS NO RESPONDIÓ DESPUÉS DE 12 INTENTOS."
      );


      await incrementVerificationAttempt({

        lineId:
          line.id,

        message:
          "Citrus no respondió después de 12 intentos.",

        nextDelaySeconds:
          SLOW_VERIFICATION_DELAY_MS /
          1000

      });


      const freshLine =
        await getLine(
          line.id
        );


      await markWaitingCitrus({

        jobId:
          job.id,

        lineId:
          line.id,

        message:
          "Citrus no responde. El worker continuará verificando automáticamente."

      });


      await sendCitrusNoResponseEmail({

        job,

        line:
          freshLine

      });


      return {
        status:
          "waiting_citrus"
      };

    }



    // ==========================================================
    // MÁS DE 12 INTENTOS
    // ==========================================================
    //
    // El correo ya debió enviarse.
    //
    // Seguimos verificando cada 60 segundos.
    //
    // ==========================================================

    console.log(
      "⏳ CITRUS SIGUE CAÍDO."
    );

    console.log(
      "🔄 SE VOLVERÁ A INTENTAR EN 60 SEGUNDOS."
    );


    await incrementVerificationAttempt({

      lineId:
        line.id,

      message:
        `Citrus sigue sin responder. Intento ${attempts}.`,

      nextDelaySeconds:
        SLOW_VERIFICATION_DELAY_MS /
        1000

    });


    await markWaitingCitrus({

      jobId:
        job.id,

      lineId:
        line.id,

      message:
        "Esperando que Citrus vuelva a estar disponible."

    });


    return {
      status:
        "waiting_citrus"
    };

  }

}



// ============================================================
// MARCAR JOB COMPLETED
// ============================================================

async function markJobCompleted(
  jobId
) {

  await refreshJobCounters(
    jobId
  );


  await db.query(
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


  console.log("");
  console.log(
    "🟩🟩🟩 ========================================"
  );

  console.log(
    "✅ AJUSTE DE INVENTARIO COMPLETADO"
  );

  console.log(
    "🟩🟩🟩 ========================================"
  );

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

      if (!line) {

        await markJobCompleted(
          jobId
        );

        return;

      }



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

          // siguiente línea

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


          return;

        }



        // ======================================================
        // VERIFICAR
        // ======================================================

        if (
          result.status ===
          "verify"
        ) {

          // No continuar con otra línea.
          //
          // Primero debemos determinar
          // qué pasó con esta.

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