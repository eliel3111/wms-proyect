import axios from "axios";
import { getERPAuth, refreshERPToken } from "./citrus.auth.js";
import { parseStringPromise } from "xml2js";

const ERP_BASE = "https://testapi.citrus.com.do/40";

// =====================================================
// FUNCIÓN PRINCIPAL PARA LLAMAR ERP
// =====================================================
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
            console.log(error.message);
        }

        throw error;
    }


}
