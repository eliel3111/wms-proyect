import axios from "axios";
import { getERPAuth, refreshERPToken } from "./citrus.auth.js";
import { parseStringPromise } from "xml2js";

const ERP_BASE = "https://testapi.citrus.com.do/40";

// =====================================================
// FUNCIÓN PRINCIPAL PARA LLAMAR ERP
// =====================================================
/*
#3La función callERP se encarga de llamar al ERP Citrus usando SOAP. Primero obtiene el token y ticket de autenticación, luego envía una petición POST con Axios al endpoint del ERP pasando el XML y los headers necesarios (SOAPAction, Authorization, UsuarioTicketId). Cuando recibe la respuesta, convierte el XML a JSON, extrae el resultado (BuscarItemsResult) y lo parsea si viene como string JSON. Si el ERP indica que la sesión expiró, automáticamente hace relogin y repite la petición. Finalmente devuelve los datos procesados; si ocurre un error, imprime el status, headers y XML del error para diagnóstico y lanza la excepción.*/
export async function callERP(endpoint, soapAction, xmlBody) {
    try {
        // 🔐 obtener token actual
        let auth = await getERPAuth();


        const url = `https://testapi.citrus.com.do/40/${endpoint}`;
        //console.log("SOAP", soapAction);


        //console.log("=========== XML SENT ===========");
        //console.log(xmlBody);

        //console.log("=========== HEADERS ===========");
        /*console.log({
            SOAPAction: soapAction,
            Authorization: auth.token,
            UsuarioTicketId: auth.ticket
        });*/



        const response = await axios({
            method: "post",
            url,
            data: xmlBody,
            headers: {
                "Content-Type": "text/xml; charset=utf-8",
                SOAPAction: soapAction,
                Authorization: auth.token.trim(),
                UsuarioTicketId: String(auth.ticket).trim()
            },
            timeout: 20000,
            transformRequest: [(data) => data] // 🔥 importante
        });

        //console.log("=========== RAW ERP RESPONSE ===========");
        //console.log(response.data);


        // =====================================================
        // 🔥 PARSEAR RESPUESTA CITRUS CORRECTAMENTE
        // =====================================================
        const parsed = await parseStringPromise(response.data, { explicitArray: false });

        const body = parsed["soap:Envelope"]["soap:Body"];

        // Citrus siempre devuelve: BuscarItemsResponse → BuscarItemsResult
        const responseNode = body["BuscarItemsResponse"];

        if (!responseNode || !responseNode["BuscarItemsResult"]) {
            console.log("⚠️ Unexpected ERP structure:", JSON.stringify(body, null, 2));
            return body;
        }

        const raw = responseNode["BuscarItemsResult"];

        let data;

        // 🔥 aquí viene el JSON real como string
        if (typeof raw === "string" && raw.trim().startsWith("{")) {
            data = JSON.parse(raw);
        } else {
            data = raw;
        }

        //console.log("=========== ERP DATA FINAL ===========");
        //console.log(data.Data.Items);


        // =====================================================
        // 🛑 SI SESIÓN EXPIRÓ → RELOGIN AUTOMÁTICO
        // =====================================================
        if (data.SesionExpirada === 1 || data.TicketInvalido === 1) {
            //console.log("🔄 ERP session expired → re-login");

            auth = await refreshERPToken();

            // 🔁 retry request
            const retry = await axios.post(url, xmlBody, {
                headers: {
                    "Content-Type": "text/xml; charset=utf-8",
                    SOAPAction: soapAction,
                    Authorization: auth.token,
                    UsuarioTicketId: auth.ticket
                }
            });

            const parsedRetry = await parseStringPromise(retry.data, { explicitArray: false });

            const bodyRetry = parsedRetry["soap:Envelope"]["soap:Body"];
            const firstRetry = Object.keys(bodyRetry)[0];
            const resultRetry = Object.keys(bodyRetry[firstRetry])[0];

            const rawRetry = bodyRetry[firstRetry][resultRetry];

            if (typeof rawRetry === "string" && rawRetry.trim().startsWith("{")) {
                try {
                    return JSON.parse(rawRetry);
                } catch {
                    return rawRetry;
                }
            }

            return rawRetry;

        }

        return data;

    } catch (error) {
        console.log("🔴 ERP ERROR REAL:");

        if (error.response) {
            console.log("STATUS:", error.response.status);
            console.log("HEADERS:", error.response.headers);
            console.log("BODY:", error.response.data); // ← XML real error
        } else {
            console.log("ERROR", error.message);
        }

        throw error;
    }


}





export async function callERPPurchase(endpoint, soapAction, xmlBody) {
  try {
    let auth = await getERPAuth();

    const url = `https://testapi.citrus.com.do/40/${endpoint}`;

    /* ===============================
       📡 REQUEST AL ERP
    =============================== */

    const response = await axios({
      method: "post",
      url,
      data: xmlBody,
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        SOAPAction: soapAction,
        Authorization: auth.token.trim(),
        UsuarioTicketId: String(auth.ticket).trim()
      },
      timeout: 20000,
      transformRequest: [(data) => data]
    });

    /* ===============================
       🔥 PARSE XML → JSON
    =============================== */

    const parsed = await parseStringPromise(response.data, {
      explicitArray: false,
      ignoreAttrs: true
    });

    // 🔥 manejar namespace dinámico (soap / soapenv / s)
    const envelopeKey = Object.keys(parsed)[0];
    const bodyKey = Object.keys(parsed[envelopeKey])[0];

    const body = parsed[envelopeKey][bodyKey];

    // 🔥 nodo específico de Citrus
    const responseNode = body["BuscarOrdenesComprasResponse"];

    if (!responseNode) {
      console.log("❌ No existe BuscarOrdenesComprasResponse");
      console.log(JSON.stringify(body, null, 2));
      return null;
    }

    // 🔥 aquí viene JSON STRING
    const raw = responseNode["BuscarOrdenesComprasResult"];

    if (!raw) {
      console.log("❌ No existe BuscarOrdenesComprasResult");
      return null;
    }

    let data;

    if (typeof raw === "string" && raw.trim().startsWith("{")) {
      data = JSON.parse(raw);
    } else {
      data = raw;
    }

    /* ===============================
       🔁 RELOGIN AUTOMÁTICO
    =============================== */

    if (data?.SesionExpirada === 1 || data?.TicketInvalido === 1) {

      console.log("🔄 ERP Purchase session expired → re-login");

      auth = await refreshERPToken();

      const retry = await axios.post(url, xmlBody, {
        headers: {
          "Content-Type": "text/xml; charset=utf-8",
          SOAPAction: soapAction,
          Authorization: auth.token.trim(),
          UsuarioTicketId: String(auth.ticket).trim()
        }
      });

      const parsedRetry = await parseStringPromise(retry.data, {
        explicitArray: false,
        ignoreAttrs: true
      });

      const envelopeRetry = Object.keys(parsedRetry)[0];
      const bodyRetryKey = Object.keys(parsedRetry[envelopeRetry])[0];

      const bodyRetry = parsedRetry[envelopeRetry][bodyRetryKey];

      const responseRetry = bodyRetry["BuscarOrdenesComprasResponse"];
      const rawRetry = responseRetry["BuscarOrdenesComprasResult"];

      if (typeof rawRetry === "string" && rawRetry.trim().startsWith("{")) {
        return JSON.parse(rawRetry);
      }

      return rawRetry;
    }

    /* ===============================
       ✅ RESULTADO FINAL
    =============================== */

    return data;

  } catch (error) {
    console.log("🔴 ERP PURCHASE ERROR:");

    if (error.response) {
      console.log("STATUS:", error.response.status);
      console.log("BODY:", error.response.data); // XML error real
    } else {
      console.log(error.message);
    }

    throw error;
  }
}




// 🔥 SOLO PARA VENTAS
export async function callERPSales(xmlBody) {
  try {
    let auth = await getERPAuth();

    const url =
      "https://testapi.citrus.com.do/40/Facturacion/OrdenVentaService.asmx";

    const soapAction = "http://tempuri.org/BuscarOrdenesVentas";

    /* ===============================
       📡 REQUEST
    =============================== */
    const response = await axios({
      method: "post",
      url,
      data: xmlBody,
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        SOAPAction: soapAction,
        Authorization: auth.token.trim(),
        UsuarioTicketId: String(auth.ticket).trim(),
      },
      timeout: 20000,
      transformRequest: [(data) => data],
    });

    /* ===============================
       🔥 XML → JSON
    =============================== */
    const parsed = await parseStringPromise(response.data, {
      explicitArray: false,
      ignoreAttrs: true,
    });

    const envelopeKey = Object.keys(parsed)[0];
    const bodyKey = Object.keys(parsed[envelopeKey])[0];
    const body = parsed[envelopeKey][bodyKey];

    /* ===============================
       🔥 RESPONSE VENTAS
    =============================== */
    const responseNode = body["BuscarOrdenesVentasResponse"];

    if (!responseNode) {
      console.log("❌ No existe BuscarOrdenesVentasResponse");
      console.log(JSON.stringify(body, null, 2));
      return null;
    }

    const raw = responseNode["BuscarOrdenesVentasResult"];

    if (!raw) {
      console.log("❌ No existe BuscarOrdenesVentasResult");
      return null;
    }

    /* ===============================
       🔥 STRING → JSON
    =============================== */
    let data;

    if (typeof raw === "string" && raw.trim().startsWith("{")) {
      data = JSON.parse(raw);
    } else {
      data = raw;
    }

    /* ===============================
       🔁 RELOGIN AUTO
    =============================== */
    if (data?.SesionExpirada === 1 || data?.TicketInvalido === 1) {
      console.log("🔄 ERP SALES session expired → re-login");

      auth = await refreshERPToken();

      const retry = await axios.post(url, xmlBody, {
        headers: {
          "Content-Type": "text/xml; charset=utf-8",
          SOAPAction: soapAction,
          Authorization: auth.token.trim(),
          UsuarioTicketId: String(auth.ticket).trim(),
        },
      });

      const parsedRetry = await parseStringPromise(retry.data, {
        explicitArray: false,
        ignoreAttrs: true,
      });

      const envelopeRetry = Object.keys(parsedRetry)[0];
      const bodyRetryKey = Object.keys(parsedRetry[envelopeRetry])[0];
      const bodyRetry = parsedRetry[envelopeRetry][bodyRetryKey];

      const responseRetry =
        bodyRetry["BuscarOrdenesVentasResponse"];

      const rawRetry =
        responseRetry["BuscarOrdenesVentasResult"];

      if (typeof rawRetry === "string") {
        return JSON.parse(rawRetry);
      }

      return rawRetry;
    }

    /* ===============================
       ✅ RESULT
    =============================== */
    return data;

  } catch (error) {
    console.log("🔴 ERP SALES ERROR:");

    if (error.response) {
      console.log("STATUS:", error.response.status);
      console.log("BODY:", error.response.data);
    } else {
      console.log(error.message);
    }

    throw error;
  }
}


export async function callERPGeneral(
  servicePath,
  soapAction,
  responseTag,
  resultTag,
  xmlBody
) {

  try {

    let auth = await getERPAuth();

    const url = `https://testapi.citrus.com.do/40/${servicePath}`;

    /* ==================================
       📡 REQUEST
    ================================== */

    const response = await axios({

      method: "post",

      url,

      data: xmlBody,

      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        SOAPAction: soapAction,
        Authorization: auth.token.trim(),
        UsuarioTicketId: String(auth.ticket).trim(),
      },

      timeout: 20000,

      transformRequest: [(data) => data],
    });

    /* ==================================
       🔥 XML → JSON
    ================================== */

    const parsed = await parseStringPromise(response.data, {
      explicitArray: false,
      ignoreAttrs: true,
    });

    const envelopeKey = Object.keys(parsed)[0];
    const bodyKey = Object.keys(parsed[envelopeKey])[0];

    const body = parsed[envelopeKey][bodyKey];

    /* ==================================
       🔥 RESPONSE NODE
    ================================== */

    const responseNode = body[responseTag];

    if (!responseNode) {

      console.log(`❌ No existe ${responseTag}`);

      console.log(JSON.stringify(body, null, 2));

      return null;
    }

    /* ==================================
       🔥 RESULT NODE
    ================================== */

    const raw = responseNode[resultTag];

    if (!raw) {

      console.log(`❌ No existe ${resultTag}`);

      return null;
    }

    /* ==================================
       🔥 STRING → JSON
    ================================== */

    let data;

    if (
      typeof raw === "string" &&
      raw.trim().startsWith("{")
    ) {

      data = JSON.parse(raw);

    } else {

      data = raw;
    }

    /* ==================================
       🔄 RELOGIN AUTO
    ================================== */

    if (
      data?.SesionExpirada === 1 ||
      data?.TicketInvalido === 1
    ) {

      console.log("🔄 ERP session expired → re-login");

      auth = await refreshERPToken();

      const retry = await axios.post(url, xmlBody, {

        headers: {
          "Content-Type": "text/xml; charset=utf-8",
          SOAPAction: soapAction,
          Authorization: auth.token.trim(),
          UsuarioTicketId: String(auth.ticket).trim(),
        },

      });

      const parsedRetry = await parseStringPromise(
        retry.data,
        {
          explicitArray: false,
          ignoreAttrs: true,
        }
      );

      const envelopeRetry = Object.keys(parsedRetry)[0];

      const bodyRetryKey =
        Object.keys(parsedRetry[envelopeRetry])[0];

      const bodyRetry =
        parsedRetry[envelopeRetry][bodyRetryKey];

      const responseRetry =
        bodyRetry[responseTag];

      const rawRetry =
        responseRetry[resultTag];

      if (
        typeof rawRetry === "string" &&
        rawRetry.trim().startsWith("{")
      ) {

        return JSON.parse(rawRetry);
      }

      return rawRetry;
    }

    /* ==================================
       ✅ RESULT
    ================================== */

    return data;

  } catch (error) {

    console.log("🔴 ERP ERROR:");

    if (error.response) {

      console.log("STATUS:", error.response.status);

      console.log("BODY:", error.response.data);

    } else {

      console.log(error.message);
    }

    throw error;
  }
}