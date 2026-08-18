import axios from "axios";
import { parseStringPromise } from "xml2js";

import {
  getERPAuth,
  refreshERPToken
} from "./citrus.auth.js";



const ERP_URL =
  "https://testapi.citrus.com.do/40/Inventario/ExistenciaAlmacenService.asmx";

const SOAP_ACTION =
  "http://tempuri.org/AjustarExistenciaAlmacen";

/**
 * Ajusta la existencia de múltiples productos en Citrus.
 *
 * @param {Array<Object>} ajustes
 * @param {number|string} ajustes[].itemId
 * @param {number|string} ajustes[].almacenId
 * @param {number|string} ajustes[].cantidadNueva
 * @param {number|string} ajustes[].cantidadActual
 */
export async function ajustarExistenciaAlmacen(
  ajustes
) {
  console.log("");
  console.log(
    "🟨🟨🟨 ========================================"
  );
  console.log(
    "📦 INICIANDO AJUSTES DE EXISTENCIA EN CITRUS"
  );
  console.log("🕒 Fecha:", new Date().toISOString());
  console.log(
    "🟨🟨🟨 ========================================"
  );

  try {

    // ==========================================================
    // 1. VALIDAR QUE SE RECIBIÓ UN ARRAY
    // ==========================================================

    if (!Array.isArray(ajustes)) {
      throw new Error(
        "Los ajustes deben enviarse dentro de un array."
      );
    }

    if (ajustes.length === 0) {
      throw new Error(
        "El array de ajustes no puede estar vacío."
      );
    }

    console.log(
      "📦 TOTAL DE AJUSTES RECIBIDOS:",
      ajustes.length
    );


    // ==========================================================
    // 2. CONVERTIR Y VALIDAR CADA AJUSTE
    // ==========================================================

    const ajustesValidados = ajustes.map(
      (ajuste, index) => {

        if (
          !ajuste ||
          typeof ajuste !== "object"
        ) {
          throw new Error(
            `El ajuste en la posición ${index} no es válido.`
          );
        }

        const parsedItemId =
          Number(ajuste.itemId);

        const parsedAlmacenId =
          Number(ajuste.almacenId);

        const parsedCantidadNueva =
          Number(ajuste.cantidadNueva);

        const parsedCantidadActual =
          Number(ajuste.cantidadActual);


        if (
          !Number.isInteger(parsedItemId) ||
          parsedItemId <= 0
        ) {
          throw new Error(
            `ItemId inválido en la posición ${index}. ` +
            `Valor recibido: ${ajuste.itemId}`
          );
        }


        if (
          !Number.isInteger(parsedAlmacenId) ||
          parsedAlmacenId <= 0
        ) {
          throw new Error(
            `AlmacenId inválido en la posición ${index}. ` +
            `Valor recibido: ${ajuste.almacenId}`
          );
        }


        if (
          !Number.isFinite(
            parsedCantidadNueva
          ) ||
          parsedCantidadNueva < 0
        ) {
          throw new Error(
            `CantidadNueva inválida en la posición ${index}. ` +
            `Valor recibido: ${ajuste.cantidadNueva}`
          );
        }


        if (
          !Number.isFinite(
            parsedCantidadActual
          )
        ) {
          throw new Error(
            `CantidadActual inválida en la posición ${index}. ` +
            `Valor recibido: ${ajuste.cantidadActual}`
          );
        }


        return {
          itemId:
            parsedItemId,

          almacenId:
            parsedAlmacenId,

          cantidadNueva:
            parsedCantidadNueva,

          cantidadActual:
            parsedCantidadActual,

          diferencia:
            parsedCantidadNueva -
            parsedCantidadActual
        };
      }
    );


    console.log(
      "📨 AJUSTES VALIDADOS:"
    );


    ajustesValidados.forEach(
      (ajuste, index) => {

        console.log(
          `📦 Ajuste ${index + 1}:`,
          ajuste
        );

      }
    );


    // ==========================================================
    // 3. OBTENER AUTENTICACIÓN DE CITRUS
    // ==========================================================

    let auth =
      await getERPAuth();


    console.log(
      "✅ CITRUS AUTH RESULT:",
      {
        ticket:
          auth.ticket,

        companyId:
          auth.companyId,

        userId:
          auth.userId,

        hasToken:
          Boolean(
            auth.token
          )
      }
    );


    if (!auth.token) {

      throw new Error(
        "No se pudo obtener el token de autenticación de Citrus."
      );

    }


    if (!auth.ticket) {

      throw new Error(
        "No se pudo obtener el UsuarioTicketId de Citrus."
      );

    }


    console.log(
      "🔐 AUTENTICACIÓN ERP OBTENIDA:"
    );


    console.log({
      hasToken:
        Boolean(
          auth.token
        ),

      ticket:
        auth.ticket,

      companyId:
        auth.companyId,

      userId:
        auth.userId
    });



    // ==========================================================
    // 4. CREAR UN BLOQUE <ajuste> POR CADA OBJETO
    // ==========================================================

    const ajustesXml =
      ajustesValidados
        .map(
          ajuste => `
      <ajuste>
        <ItemId>${ajuste.itemId}</ItemId>
        <AlmacenId>${ajuste.almacenId}</AlmacenId>
        <CantidadNueva>${ajuste.cantidadNueva}</CantidadNueva>
        
      </ajuste>`
        )
        .join("");



    // ==========================================================
    // 5. CONSTRUIR XML SOAP COMPLETO
    // ==========================================================

    const xml =
`<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <AjustarExistenciaAlmacen xmlns="http://tempuri.org/">${ajustesXml}
    </AjustarExistenciaAlmacen>
  </soap:Body>
</soap:Envelope>`;


    console.log(
      "🌐 URL CITRUS:",
      ERP_URL
    );

    console.log(
      "📤 SOAPAction:",
      SOAP_ACTION
    );


    console.log(
      "📤 XML ENVIADO:"
    );

    console.log(
      xml
    );



    // ==========================================================
    // 6. FUNCIÓN PARA ENVIAR SOLICITUD A CITRUS
    // ==========================================================

    async function enviarAjusteCitrus(
      authActual
    ) {

      return await axios.post(
        ERP_URL,
        xml,
        {
          headers: {

            "Content-Type":
              "text/xml; charset=utf-8",

            SOAPAction:
              SOAP_ACTION,

            Authorization:
              authActual.token.trim(),

            UsuarioTicketId:
              String(
                authActual.ticket
              ).trim(),

            "Content-Length":
              Buffer.byteLength(
                xml,
                "utf8"
              )
          },

          timeout:
            30000,

          responseType:
            "text",

          validateStatus:
            () => true
        }
      );

    }



    // ==========================================================
    // 7. PRIMER INTENTO
    // ==========================================================

    let response =
      await enviarAjusteCitrus(
        auth
      );


    console.log(
      "📥 STATUS CITRUS:",
      response.status
    );


    console.log(
      "📥 HEADERS CITRUS:"
    );

    console.log(
      response.headers
    );


    console.log(
      "📥 RESPUESTA RAW CITRUS:"
    );


    console.log(
      response.data
    );



    // ==========================================================
    // 8. VALIDAR STATUS HTTP
    // ==========================================================

    if (
      response.status < 200 ||
      response.status >= 300
    ) {

      const error =
        new Error(
          `Citrus respondió con HTTP ${response.status}`
        );


      error.statusCode =
        response.status;


      error.citrusResponse =
        response.data;


      throw error;

    }


    if (
      !response.data ||
      typeof response.data !== "string"
    ) {

      throw new Error(
        "Citrus devolvió una respuesta vacía."
      );

    }



    // ==========================================================
    // 9. PARSEAR RESPUESTA XML
    // ==========================================================

    const parsedResponse =
      await parseStringPromise(
        response.data,
        {
          explicitArray:
            false,

          trim:
            true
        }
      );


    console.log(
      "🔎 RESPUESTA PARSEADA:"
    );


    console.dir(
      parsedResponse,
      {
        depth:
          null
      }
    );


    const envelope =
      parsedResponse?.["soap:Envelope"] ??
      parsedResponse?.["soapenv:Envelope"];


    const body =
      envelope?.["soap:Body"] ??
      envelope?.["soapenv:Body"];


    if (!body) {

      throw new Error(
        "La respuesta de Citrus no contiene soap:Body."
      );

    }



    // ==========================================================
    // 10. VALIDAR SOAP FAULT
    // ==========================================================

    const soapFault =
      body?.["soap:Fault"] ??
      body?.["soapenv:Fault"];


    if (soapFault) {

      const faultMessage =
        soapFault?.faultstring ??
        soapFault?.Reason?.Text ??
        "Citrus devolvió un SOAP Fault.";


      const error =
        new Error(
          faultMessage
        );


      error.citrusResponse =
        response.data;


      throw error;

    }



    // ==========================================================
    // 11. OBTENER RESULTADO DE CITRUS
    // ==========================================================

    const adjustmentResponse =
      body
        ?.AjustarExistenciaAlmacenResponse;


    if (!adjustmentResponse) {

      throw new Error(
        "No se encontró AjustarExistenciaAlmacenResponse."
      );

    }


    const rawResult =
      adjustmentResponse
        ?.AjustarExistenciaAlmacenResult;


    let citrusResult =
      rawResult;


    if (
      typeof rawResult ===
      "string"
    ) {

      try {

        citrusResult =
          JSON.parse(
            rawResult
          );

      } catch {

        citrusResult =
          rawResult;

      }

    }



    // ==========================================================
    // 12. REINTENTAR SI EL TICKET EXPIRÓ O ES INVÁLIDO
    // ==========================================================

    if (
      citrusResult &&
      typeof citrusResult === "object" &&
      (
        Number(
          citrusResult.TicketInvalido
        ) === 1 ||
        Number(
          citrusResult.SesionExpirada
        ) === 1
      )
    ) {

      console.log("");
      console.log(
        "🔄 TICKET CITRUS INVÁLIDO O SESIÓN EXPIRADA"
      );


      console.log(
        "🔐 REAUTENTICANDO..."
      );


      const oldTicket =
        auth.ticket;


      auth =
        await refreshERPToken();


      if (
        !auth.token ||
        !auth.ticket
      ) {

        throw new Error(
          "No se pudo obtener una nueva autenticación de Citrus."
        );

      }


      console.log(
        "✅ NUEVA AUTENTICACIÓN:",
        {
          oldTicket,

          newTicket:
            auth.ticket,

          companyId:
            auth.companyId,

          userId:
            auth.userId,

          hasToken:
            Boolean(
              auth.token
            )
        }
      );



      // ========================================================
      // VOLVER A ENVIAR EL AJUSTE UNA SOLA VEZ
      // ========================================================

      response =
        await enviarAjusteCitrus(
          auth
        );


      console.log(
        "📥 STATUS RETRY CITRUS:",
        response.status
      );


      console.log(
        "📥 RESPUESTA RETRY CITRUS:"
      );


      console.log(
        response.data
      );



      // ========================================================
      // VALIDAR HTTP DEL RETRY
      // ========================================================

      if (
        response.status < 200 ||
        response.status >= 300
      ) {

        const error =
          new Error(
            `Citrus respondió con HTTP ${response.status} durante el retry`
          );


        error.statusCode =
          response.status;


        error.citrusResponse =
          response.data;


        throw error;

      }


      if (
        !response.data ||
        typeof response.data !==
          "string"
      ) {

        throw new Error(
          "Citrus devolvió una respuesta vacía durante el retry."
        );

      }



      // ========================================================
      // PARSEAR RESPUESTA DEL RETRY
      // ========================================================

      const parsedRetry =
        await parseStringPromise(
          response.data,
          {
            explicitArray:
              false,

            trim:
              true
          }
        );


      const retryEnvelope =
        parsedRetry?.[
          "soap:Envelope"
        ] ??
        parsedRetry?.[
          "soapenv:Envelope"
        ];


      const retryBody =
        retryEnvelope?.[
          "soap:Body"
        ] ??
        retryEnvelope?.[
          "soapenv:Body"
        ];


      if (!retryBody) {

        throw new Error(
          "La respuesta retry de Citrus no contiene soap:Body."
        );

      }


      const retrySoapFault =
        retryBody?.["soap:Fault"] ??
        retryBody?.["soapenv:Fault"];


      if (retrySoapFault) {

        const faultMessage =
          retrySoapFault?.faultstring ??
          retrySoapFault?.Reason?.Text ??
          "Citrus devolvió un SOAP Fault durante el retry.";


        const error =
          new Error(
            faultMessage
          );


        error.citrusResponse =
          response.data;


        throw error;

      }


      const retryResponse =
        retryBody
          ?.AjustarExistenciaAlmacenResponse;


      if (!retryResponse) {

        throw new Error(
          "No se encontró AjustarExistenciaAlmacenResponse en el retry."
        );

      }


      const retryRawResult =
        retryResponse
          ?.AjustarExistenciaAlmacenResult;


      if (
        typeof retryRawResult ===
        "string"
      ) {

        try {

          citrusResult =
            JSON.parse(
              retryRawResult
            );

        } catch {

          citrusResult =
            retryRawResult;

        }

      } else {

        citrusResult =
          retryRawResult;

      }

    }



   // ==========================================================
// 13. VALIDAR RESULTADO FINAL DE CITRUS
// ==========================================================

if (
  !citrusResult ||
  typeof citrusResult !==
    "object"
) {

  throw new Error(
    "Citrus devolvió un resultado inválido."
  );

}


if (
  Number(
    citrusResult.Success
  ) !== 1
) {

  const citrusMessage =
    citrusResult.Mensaje ??
    citrusResult.Message ??
    citrusResult.ErrorMessage ??
    "Citrus rechazó los ajustes de existencia.";


  const error =
    new Error(
      citrusMessage
    );


  // 🟥 NUEVO
  // INDICA AL WORKER QUE CITRUS
  // RESPONDIÓ Y RECHAZÓ EL AJUSTE
  error.code =
    "CITRUS_REJECTED";


  error.citrusResult =
    citrusResult;


  error.citrusResponse =
    response.data;


  throw error;

}



    // ==========================================================
    // 14. AJUSTE EXITOSO
    // ==========================================================

    console.log("");

    console.log(
      "✅ AJUSTES REALIZADOS CORRECTAMENTE"
    );


    console.log(
      "📦 RESULTADO:",
      citrusResult
    );


    return {

      success:
        true,

      message:
        `${ajustesValidados.length} ajustes fueron enviados correctamente a Citrus.`,

      data: {

        totalAjustes:
          ajustesValidados.length,

        ajustes:
          ajustesValidados,

        citrusResult
      }

    };


  } catch (error) {

    console.error("");

    console.error(
      "🟥🟥🟥 ========================================"
    );

    console.error(
      "❌ ERROR AJUSTANDO EXISTENCIAS EN CITRUS"
    );

    console.error(
      "🟥🟥🟥 ========================================"
    );


    console.error(
      "Mensaje:",
      error.message
    );


    console.error(
      "Código:",
      error.code
    );


    console.error(
      "Status:",
      error.statusCode
    );


    if (
      error.citrusResult
    ) {

      console.error(
        "Resultado Citrus:",
        error.citrusResult
      );

    }


    if (
      error.citrusResponse
    ) {

      console.error(
        "Respuesta raw Citrus:",
        error.citrusResponse
      );

    }


    if (
      error.response
    ) {

      console.error(
        "Axios status:",
        error.response.status
      );


      console.error(
        "Axios headers:",
        error.response.headers
      );


      console.error(
        "Axios data:",
        error.response.data
      );

    }


    throw error;

  }
}