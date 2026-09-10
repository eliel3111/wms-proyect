import {
  callERPCancelConduce
} from "./erpClient.js";


export async function cancelConduce(
  conduceId,
  comentario = "Cancelado automáticamente por WMS"
) {

  console.log("=================================");
  console.log("🟥 [CITRUS] CANCEL CONDUCE");
  console.log("🆔 Conduce ID:", conduceId);
  console.log("📝 Comentario:", comentario);
  console.log("=================================");


  // ==========================================
  // VALIDACIONES
  // ==========================================

  if (!conduceId) {

    return {
      success: false,
      code: "CONDUCE_ID_REQUIRED",
      title: "Conduce requerido",
      message: "No se recibió el ID del conduce.",
      conduceId: null
    };
  }


  const numericConduceId =
    Number(conduceId);


  if (
    !Number.isInteger(numericConduceId) ||
    numericConduceId <= 0
  ) {

    return {
      success: false,
      code: "INVALID_CONDUCE_ID",
      title: "Conduce inválido",
      message:
        `El conduceId ${conduceId} no es válido.`,
      conduceId: conduceId
    };
  }


  // ==========================================
  // ESCAPAR XML
  // ==========================================

  const escapeXml = (value = "") =>
    String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");


  // ==========================================
  // XML
  // ==========================================

  const xml = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <CancelarConduce xmlns="http://tempuri.org/">
      <conduceId>${numericConduceId}</conduceId>
      <comentario>${escapeXml(comentario)}</comentario>
    </CancelarConduce>
  </soap:Body>
</soap:Envelope>`;


  try {

    // ==========================================
    // LLAMAR CITRUS
    // ==========================================

    const citrusResult =
      await callERPCancelConduce(xml);


    console.log(
      "🟥 RESULTADO callERPCancelConduce:"
    );

    console.dir(
      citrusResult,
      { depth: null }
    );


    // ==========================================
    // SIN RESPUESTA
    // ==========================================

    if (!citrusResult) {

      return {
        success: false,

        code:
          "CITRUS_EMPTY_RESPONSE",

        title:
          "Error cancelando conduce",

        message:
          "Citrus no devolvió respuesta.",

        conduceId:
          numericConduceId,

        citrus:
          null
      };
    }


    // ==========================================
    // ERROR DEVUELTO POR CITRUS
    // ==========================================

    if (
      Number(citrusResult.Success) !== 1 ||
      Number(citrusResult.Error) === 1
    ) {

      return {
        success: false,

        code:
          "CITRUS_CANCEL_FAILED",

        title:
          "No se pudo cancelar el conduce",

        message:
          citrusResult.Mensaje ||
          "Citrus no pudo cancelar el conduce.",

        conduceId:
          numericConduceId,

        citrus: {
          Success:
            citrusResult.Success,

          Error:
            citrusResult.Error,

          Warning:
            citrusResult.Warning,

          Confirm:
            citrusResult.Confirm,

          CodigoError:
            citrusResult.CodigoError,

          Mensaje:
            citrusResult.Mensaje
        }
      };
    }


    // ==========================================
    // VALIDAR QUE REALMENTE FUE CANCELADO
    // ==========================================

    const cancelada =
      Number(
        citrusResult?.Data?.Cancelada
      );


    if (cancelada !== 1) {

      return {
        success: false,

        code:
          "CITRUS_NOT_CANCELLED",

        title:
          "Conduce no cancelado",

        message:
          citrusResult.Mensaje ||
          "Citrus respondió correctamente, pero no confirmó la cancelación.",

        conduceId:
          numericConduceId,

        citrus: {
          Success:
            citrusResult.Success,

          Error:
            citrusResult.Error,

          Mensaje:
            citrusResult.Mensaje,

          Cancelada:
            citrusResult?.Data?.Cancelada
        }
      };
    }


    // ==========================================
    // SUCCESS
    // ==========================================

    return {
      success: true,

      code:
        "CONDUCE_CANCELLED",

      title:
        "Conduce cancelado",

      message:
        citrusResult.Mensaje ||
        "El conduce fue cancelado correctamente.",

      conduceId:
        numericConduceId,

      cancelled:
        true,

      citrus: {
        Success:
          citrusResult.Success,

        Error:
          citrusResult.Error,

        Mensaje:
          citrusResult.Mensaje,

        Cancelada:
          citrusResult.Data.Cancelada
      }
    };


  } catch (error) {

    console.error(
      "❌ ERROR cancelConduce:",
      error
    );


    return {
      success: false,

      code:
        "CANCEL_CONDUCE_ERROR",

      title:
        "Error cancelando conduce",

      message:
        error.message,

      conduceId:
        numericConduceId
    };
  }
}