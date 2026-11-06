
import admcloudClient from "./admcloudClient.js";

import {
  getAdmCloudStockService
} from "./admcloud.erpStockSync.js";

// ============================================================
// ADM CLOUD - AJUSTES DE INVENTARIO
// API: POST /api/InventoryAdjustments
//
// IMPORTANTE:
// - Quantity es la DIFERENCIA, no la cantidad final.
// - ejecutar: false => VISTA PREVIA
// - ejecutar: true  => AJUSTE REAL
// - El ajuste real necesita además estar habilitado en .env
// ============================================================

const GUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ============================================================
// CREAR ERRORES CONTROLADOS
// ============================================================

function errorAjuste(
  message,
  code = "ADMCLOUD_ADJUSTMENT_ERROR",
  statusCode = 400
) {
  return Object.assign(
    new Error(message),
    { code, statusCode }
  );
}

// ============================================================
// VALIDAR GUID
// ============================================================

function guid(value, name) {
  const v = String(value ?? "")
    .trim()
    .toLowerCase();

  if (!GUID_RE.test(v)) {
    throw errorAjuste(
      `${name} debe ser un GUID válido.`,
      "INVALID_GUID"
    );
  }

  return v;
}

// ============================================================
// VALIDAR NÚMEROS
// ============================================================

function numero(
  value,
  name,
  min = -Infinity
) {
  if (
    value === null ||
    value === undefined ||
    value === "" ||
    typeof value === "boolean"
  ) {
    throw errorAjuste(
      `${name} es obligatorio.`,
      "INVALID_NUMBER"
    );
  }

  const n = Number(value);

  if (
    !Number.isFinite(n) ||
    n < min
  ) {
    throw errorAjuste(
      `${name} debe ser un número válido.`,
      "INVALID_NUMBER"
    );
  }

  return n;
}

// ============================================================
// VALIDAR FECHA
// ============================================================

function fechaValida(value) {
  const fecha = String(
    value ??
    new Date().toISOString().slice(0, 10)
  );

  const date = new Date(
    `${fecha}T00:00:00Z`
  );

  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(fecha) ||
    Number.isNaN(date.valueOf()) ||
    date.toISOString().slice(0, 10) !== fecha
  ) {
    throw errorAjuste(
      "fechaDocumento debe tener formato YYYY-MM-DD y ser una fecha válida.",
      "INVALID_DATE"
    );
  }

  return fecha;
}

// ============================================================
// VALIDAR ROW TYPE
//
// La documentación permite valores de 0 a 5.
// Se debe confirmar cuál representa una línea de artículo.
// ============================================================

function tipoFila(value) {
  if (
    value === undefined ||
    value === null ||
    String(value).trim() === ""
  ) {
    throw errorAjuste(
      "Configura rowType o ADMCLOUD_ADJUSTMENT_ITEM_ROW_TYPE con el valor de artículo confirmado en ADM Cloud.",
      "ROW_TYPE_REQUIRED"
    );
  }

  const n = Number(value);

  if (
    !Number.isInteger(n) ||
    n < 0 ||
    n > 5
  ) {
    throw errorAjuste(
      "rowType debe ser un entero entre 0 y 5.",
      "INVALID_ROW_TYPE"
    );
  }

  return n;
}


 // ============================================================
 // SERVICIO PRINCIPAL
 // CREAR AJUSTE DE INVENTARIO ADM CLOUD
 // ============================================================
 //
 // SOPORTA:
 // - GUID de productos y almacenes.
 // - Consulta de stock actual.
 // - Validación de cambios de stock.
 // - Cálculo de diferencia.
 // - Modo PREVIEW.
 // - Ejecución real protegida.
 // - Error STOCK_CHANGED para reintento seguro.
 //
 // IMPORTANTE:
 // El servicio NO reintenta el POST automáticamente.
 // Los reintentos por STOCK_CHANGED los hará el worker.
 //
 // ============================================================

export async function crearAjusteInventarioAdmCloud(
  entrada = {}
) {

  console.log("");
  console.log("🟦 ===========================================");
  console.log("📦 INICIANDO AJUSTE DE INVENTARIO ADM CLOUD");
  console.log("🟦 ===========================================");

  // ==========================================================
  // 1. VALIDAR BODY
  // ==========================================================

  if (
    !entrada ||
    Array.isArray(entrada) ||
    typeof entrada !== "object"
  ) {

    throw errorAjuste(
      "El body debe ser un objeto JSON."
    );

  }

  // ==========================================================
  // VALIDAR LOCATION GUID
  // ==========================================================

  const locationId = guid(
    entrada.locationId,
    "locationId"
  );

  // ==========================================================
  // FECHA DEL DOCUMENTO
  // ==========================================================

  const fechaDocumento = fechaValida(
    entrada.fechaDocumento
  );

  // ==========================================================
  // TIPO DE FILA
  // ==========================================================

  const rowType = tipoFila(
    entrada.rowType ?? 0
  );

  
  // ==========================================================
  // MODO DE EJECUCIÓN REAL
  // SIN VARIABLES DE ENTORNO
  // ==========================================================

  const ejecutar =
    entrada.ejecutar === true;

  console.log(
    "🚀 EJECUTAR AJUSTE REAL:",
    ejecutar
  );

  // ==========================================================
  // VALIDAR EJECUCIÓN EXPLÍCITA
  // ==========================================================

  if (!ejecutar) {

    throw errorAjuste(
      "El servicio requiere ejecutar: true " +
      "para crear un ajuste real.",
      "EXECUTION_REQUIRED",
      400
    );

  }

  // ==========================================================
  // REFERENCIA DEL DOCUMENTO
  // ==========================================================

  const referencia = String(
    entrada.referencia ?? ""
  ).trim();

  // ==========================================================
  // NOTAS
  // ==========================================================

  const notas = String(
    entrada.notas ??
    "Ajuste por conteo físico desde WMS"
  ).trim();

  // ==========================================================
  // VALIDAR REFERENCIA
  // ==========================================================

  if (
    !referencia ||
    referencia.length > 200
  ) {

    throw errorAjuste(
      "Para crear un ajuste real debes indicar " +
      "una referencia única de hasta 200 caracteres.",
      "REFERENCE_REQUIRED",
      400
    );

  }

  console.log(
    "📄 REFERENCIA ADM CLOUD:",
    referencia
  );

  console.log(
    "✅ EJECUCIÓN REAL SOLICITADA CORRECTAMENTE"
  );


  // ==========================================================
  // 3. VALIDAR PRODUCTOS
  // ==========================================================

  if (
    !Array.isArray(entrada.items) ||
    entrada.items.length === 0
  ) {

    throw errorAjuste(
      "Debes enviar items con al menos un producto.",
      "EMPTY_ITEMS"
    );

  }

  if (entrada.items.length > 100) {

    throw errorAjuste(
      "Este servicio de prueba limita cada documento a 100 líneas.",
      "TOO_MANY_ITEMS"
    );

  }

  // ==========================================================
  // NORMALIZAR PRODUCTOS
  // ==========================================================

  const lineas = entrada.items.map(
    (item, index) => {

      if (
        !item ||
        typeof item !== "object" ||
        Array.isArray(item)
      ) {

        throw errorAjuste(
          `items[${index}] debe ser un objeto.`
        );

      }

      return {

        itemId: guid(
          item.itemId,
          `items[${index}].itemId`
        ),

        cantidadNueva: numero(
          item.cantidadNueva,
          `items[${index}].cantidadNueva`,
          0
        ),

        cantidadActual:
          item.cantidadActual == null
            ? null
            : numero(
                item.cantidadActual,
                `items[${index}].cantidadActual`
              ),

        uomId:
          item.uomId
            ? guid(
                item.uomId,
                `items[${index}].uomId`
              )
            : null,

        costo:
          item.costo == null
            ? null
            : numero(
                item.costo,
                `items[${index}].costo`,
                0
              ),

        precio:
          item.precio == null
            ? 0
            : numero(
                item.precio,
                `items[${index}].precio`,
                0
              ),

        exchangeRate:
          item.exchangeRate == null
            ? null
            : numero(
                item.exchangeRate,
                `items[${index}].exchangeRate`,
                0
              ),

        comentario: String(
          item.comentario ??
          "Conteo físico WMS"
        ).slice(0, 1000)

      };

    }
  );

  // ==========================================================
  // 4. EVITAR PRODUCTOS DUPLICADOS
  // ==========================================================

  const uniqueItems = new Set(
    lineas.map(
      item => item.itemId.toLowerCase()
    )
  );

  if (
    uniqueItems.size !== lineas.length
  ) {

    throw errorAjuste(
      "Hay productos repetidos. Envía una línea por ItemID.",
      "DUPLICATE_ITEMS"
    );

  }

  // ==========================================================
  // VALIDAR STOCK ESPERADO PARA EJECUCIÓN REAL
  // ==========================================================

  if (
    ejecutar &&
    lineas.some(
      item => item.cantidadActual === null
    )
  ) {

    throw errorAjuste(
      "Para ejecutar debes indicar cantidadActual " +
      "en cada producto. Debe coincidir con el stock " +
      "actual de ADM Cloud.",
      "EXPECTED_STOCK_REQUIRED"
    );

  }

  // ==========================================================
  // 5. CONSULTAR STOCK ACTUAL EN ADM CLOUD
  // ==========================================================

  const cambios = [];
  const omisiones = [];

  for (const linea of lineas) {

    console.log("");
    console.log(
      "🔍 CONSULTANDO STOCK:",
      linea.itemId
    );

    const consulta =
      await getAdmCloudStockService({

        itemId: linea.itemId,

        locationId,

        showNoStock: true,

        skip: 0,

        take: 0

      });

    // ========================================================
    // VALIDAR RESPUESTA
    // ========================================================

    if (
      !Array.isArray(consulta?.data)
    ) {

      throw errorAjuste(
        `ADM Cloud devolvió una respuesta de stock inválida para ${linea.itemId}.`,
        "INVALID_STOCK_RESPONSE",
        502
      );

    }

    const coincidencias =
      consulta.data.filter(
        row =>
          String(
            row?.ID ?? ""
          ).toLowerCase() ===
          linea.itemId.toLowerCase()
      );

    if (coincidencias.length !== 1) {

      throw errorAjuste(
        `No se encontró exactamente un registro de stock ` +
        `para ${linea.itemId}. ` +
        `Coincidencias: ${coincidencias.length}. ` +
        "No se asume stock cero.",
        "STOCK_NOT_FOUND",
        409
      );

    }

    const stock = coincidencias[0];

    // ========================================================
    // STOCK ACTUAL
    // ========================================================

    const actual = numero(
      stock.Stock,
      `Stock de ${linea.itemId}`
    );

    console.log(
      "📊 STOCK ACTUAL ADM CLOUD:",
      actual
    );

    console.log(
      "🎯 CANTIDAD DESEADA:",
      linea.cantidadNueva
    );

    // ========================================================
    // 6. DETECTAR STOCK_CHANGED
    // ========================================================
    //
    // EJEMPLO:
    //
    // El WMS esperaba 19.
    // ADM Cloud ahora tiene 20.
    //
    // Antes:
    //   Se detenía sin información adicional.
    //
    // Ahora:
    //   Devuelve STOCK_CHANGED.
    //   Incluye el stock actual encontrado.
    //
    // IMPORTANTE:
    // En este punto NO se ha ejecutado ningún POST.
    //
    // ========================================================

    if (
      linea.cantidadActual !== null &&
      Math.abs(
        actual - linea.cantidadActual
      ) > 0.000001
    ) {

      console.warn("");
      console.warn(
        "🟨 ========================================"
      );

      console.warn(
        "🟨 STOCK_CHANGED DETECTADO"
      );

      console.warn(
        "🆔 ITEM:",
        linea.itemId
      );

      console.warn(
        "📦 STOCK ESPERADO:",
        linea.cantidadActual
      );

      console.warn(
        "📊 STOCK ADM CLOUD:",
        actual
      );

      console.warn(
        "🎯 CANTIDAD DESEADA:",
        linea.cantidadNueva
      );

      console.warn(
        "🟨 ========================================"
      );

      const error = errorAjuste(
        `El stock de ${linea.itemId} cambió: ` +
        `esperado=${linea.cantidadActual}, ` +
        `ADM Cloud=${actual}.`,
        "STOCK_CHANGED",
        409
      );

      // ======================================================
      // INFORMACIÓN PARA QUE EL WORKER PUEDA RECALCULAR
      // ======================================================

      error.code = "STOCK_CHANGED";

      error.stockActual = actual;

      error.stockEsperado =
        linea.cantidadActual;

      error.cantidadDeseada =
        linea.cantidadNueva;

      error.itemId =
        linea.itemId;

      error.locationId =
        locationId;

      // El servicio NO ejecuta el POST
      // y devuelve el control al worker.

      throw error;

    }

    // ========================================================
    // 7. OBTENER UNIDAD DE MEDIDA Y COSTO
    // ========================================================

    const uomId =
      linea.uomId ??
      guid(
        stock.UOMID,
        `UOMID de ${linea.itemId}`
      );

    const costo =
      linea.costo ??
      numero(
        stock.AverageCost,
        `AverageCost de ${linea.itemId}`,
        0
      );

    // ========================================================
    // 8. CALCULAR DIFERENCIA
    // ========================================================

    const diferencia = Number(
      (
        linea.cantidadNueva - actual
      ).toPrecision(15)
    );

    console.log(
      "📊 DIFERENCIA:",
      {
        itemId: linea.itemId,
        stockActual: actual,
        cantidadNueva: linea.cantidadNueva,
        diferencia
      }
    );

    const detalle = {

      itemId: linea.itemId,

      sku: stock.SKU ?? null,

      stockActual: actual,

      cantidadNueva:
        linea.cantidadNueva,

      diferencia,

      uomId,

      costo,

      precio: linea.precio,

      exchangeRate:
        linea.exchangeRate,

      comentario:
        linea.comentario

    };

    // ========================================================
    // CLASIFICAR DIFERENCIAS
    // ========================================================

    if (
      Math.abs(diferencia) < 0.000001
    ) {

      omisiones.push(detalle);

    } else {

      cambios.push(detalle);

    }

  }

  // ==========================================================
  // 9. CONSTRUIR DOCUMENTO ADM CLOUD
  // ==========================================================

  const payload = {

    DocDate:
      fechaDocumento,

    LocationID:
      locationId,

    Reference:
      referencia ||
      `WMS-PREVIEW-${fechaDocumento}`,

    Notes:
      notas,

    Items:
      cambios.map(
        (item, index) => {

          const row = {

            RowOrder:
              index + 1,

            RowType:
              rowType,

            ItemID:
              item.itemId,

            LocationID:
              locationId,

            UOMID:
              item.uomId,

            Quantity:
              item.diferencia,

            Cost:
              item.costo,

            Price:
              item.precio,

            Comments:
              item.comentario

          };

          if (
            item.exchangeRate !== null
          ) {

            row.ExchangeRate =
              item.exchangeRate;

          }

          return row;

        }
      )

  };

  // ==========================================================
  // SUBSIDIARY OPCIONAL
  // ==========================================================

  if (entrada.subsidiaryId) {

    payload.SubsidiaryID = guid(
      entrada.subsidiaryId,
      "subsidiaryId"
    );

  }

  console.log("");
  console.log(
    "📦 DOCUMENTO PREPARADO:",
    {
      locationId,
      referencia: payload.Reference,
      ejecutar,
      rowType,
      cambios: cambios.length,
      sinDiferencia: omisiones.length
    }
  );

  // ==========================================================
  // 10. SIN DIFERENCIAS
  // ==========================================================

  if (cambios.length === 0) {

    console.log(
      "✅ NO HAY DIFERENCIAS DE INVENTARIO"
    );

    return {

      success: true,

      ejecutado: false,

      modo: "SIN_DIFERENCIAS",

      message:
        "El stock de ADM Cloud ya coincide con el conteo. " +
        "No se creó documento.",

      data: {
        cambios,
        omisiones,
        payload
      }

    };

  }

 
  // ==========================================================
  // 12. ENVIAR AJUSTE REAL A ADM CLOUD
  // ==========================================================
  //
  // A PARTIR DE AQUÍ:
  //
  // - El POST puede crear un documento real.
  // - No se debe reintentar a ciegas.
  // - Un timeout puede ocurrir después de crear el documento.
  //
  // ==========================================================

  console.log("");
  console.log(
    "🚀 VALIDANDO AUTORIZACIONES ANTES DEL POST"
  );

 

  console.log(
    "🚀 ENVIANDO AJUSTE REAL A ADM CLOUD"
  );

  let respuesta;

  try {

    respuesta = await admcloudClient.post(
      "/InventoryAdjustments",
      payload,
      {
        timeout: 45000
      }
    );

  } catch (error) {

    // ========================================================
    // RESULTADO DEL POST INCIERTO
    // ========================================================
    //
    // No sabemos si ADM Cloud creó el documento.
    //
    // El worker NO debe repetir el POST
    // sin consultar el documento por referencia.
    //
    // ========================================================

    console.error(
      "🟥 ERROR DURANTE POST ADM CLOUD:",
      error.message
    );

    throw errorAjuste(
      `No se pudo confirmar la creación del ajuste ` +
      `(${error.message || "fallo de red"}). ` +
      `Verifica la referencia ${payload.Reference} ` +
      "en ADM Cloud ANTES de reintentarlo.",
      "ADJUSTMENT_RESULT_UNCERTAIN",
      error.status || 502
    );

  }

  // ==========================================================
  // 13. VALIDAR RESPUESTA ADM CLOUD
  // ==========================================================

  const body = respuesta.data;

  if (
    !body ||
    body.success !== true
  ) {

    throw errorAjuste(
      body?.message ||
      "ADM Cloud rechazó el ajuste.",
      "ADMCLOUD_ADJUSTMENT_REJECTED",
      502
    );

  }

  // ==========================================================
  // 14. OBTENER GUID DEL DOCUMENTO
  // ==========================================================

  const rawId =
    typeof body.data === "string"
      ? body.data
      : body.data?.ID ??
        body.data?.id ??
        body.data?.guid ??
        null;

  const adjustmentId =
    rawId &&
    GUID_RE.test(
      String(rawId)
    )
      ? String(rawId).toLowerCase()
      : null;

  console.log("");
  console.log(
    "✅ ADM CLOUD RESPONDIÓ ÉXITO",
    {
      referencia:
        payload.Reference,

      adjustmentId
    }
  );

  // ==========================================================
  // 15. DEVOLVER RESULTADO
  // ==========================================================

  return {

    success: true,

    ejecutado: true,

    modo: "REAL",

    message:
      adjustmentId
        ? "Ajuste creado correctamente en ADM Cloud."
        : "ADM Cloud respondió éxito, pero no devolvió " +
          "un GUID identificable. Verifica el documento por referencia.",

    data: {

      adjustmentId,

      referencia:
        payload.Reference,

      cambios,

      omisiones,

      payload,

      respuestaAdmCloud:
        body

    }

  };

}
