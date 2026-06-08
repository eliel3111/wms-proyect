import axios from "axios";
import { parseStringPromise } from "xml2js";

const ERP_URL = "https://testapi.citrus.com.do/40/Seguridad/SeguridadService.asmx";

// 🔐 credenciales ERP
const ERP_USER = "api";
const ERP_PASS = "Ap4RkXUp1TxU";
const ERP_COMPANY = "garlascontrol2";

// 🧠 memoria interna
let session = {
  token: null,
  ticket: null,
  expiration: null,
  companyId: null,
  userId: null,
  taxes: [],
  currency: null
};

// =====================================================
// LOGIN AL ERP
// =====================================================
async function loginERP() {
  console.log("🔐 Logging into ERP...");

  const xml = `<?xml version="1.0" encoding="utf-8"?>
  <soap:Envelope 
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
    <soap:Body>
      <Autenticar xmlns="http://tempuri.org/">
        <autenticacion>
          <Usuario>${ERP_USER}</Usuario>
          <Clave>${ERP_PASS}</Clave>
          <CodigoCia>${ERP_COMPANY}</CodigoCia>
        </autenticacion>
      </Autenticar>
    </soap:Body>
  </soap:Envelope>`;

  const response = await axios.post(ERP_URL, xml, {
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      SOAPAction: "http://tempuri.org/Autenticar"
    }
  });

  const parsed = await parseStringPromise(response.data, { explicitArray: false });

  const rawJson =
    parsed["soap:Envelope"]["soap:Body"]["AutenticarResponse"]["AutenticarResult"];

  const data = JSON.parse(rawJson);

  if (!data.Success) {
    throw new Error("ERP login failed");
  }

  const info = data.Data;

  // guardar en memoria
  session.token = info.Token;
  session.ticket = info.UsuarioTicketId;
  session.companyId = info.UsuarioLogin.CompaniaId;
  session.userId = info.UsuarioLogin.Id;
  session.taxes = info.UsuarioLogin.CompaniaLogin.Impuestos;
  session.currency = info.UsuarioLogin.MonedaPredeterminada;

  // obtener expiración del JWT
  const tokenPayload = JSON.parse(
    Buffer.from(info.Token.split(".")[1], "base64").toString()
  );

  session.expiration = new Date(tokenPayload.FechaExpiracion);

  console.log("✅ ERP connected");
}

// =====================================================
// VALIDAR SI TOKEN EXPIRÓ
// =====================================================
function isExpired() {
  if (!session.token) return true;
  if (!session.expiration) return true;
  return new Date() >= session.expiration;
}

// =====================================================
// OBTENER TOKEN (auto refresh)
// =====================================================
export async function getERPAuth() {
  if (isExpired()) {
    await loginERP();
  }

  return {
    token: session.token,
    ticket: session.ticket,
    companyId: session.companyId,
    userId: session.userId,
    taxes: session.taxes,
    currency: session.currency
  };
}

// =====================================================
// FORZAR REFRESH MANUAL
// =====================================================
export async function refreshERPToken() {
  await loginERP();
  return getERPAuth();
}
