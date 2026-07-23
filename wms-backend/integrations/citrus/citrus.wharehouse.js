import axios from "axios";
import { parseStringPromise } from "xml2js";
import { db } from "../../db.js";
import {
  getERPAuth,
  refreshERPToken
} from "./citrus.auth.js";



// ==========================================================
// 1. OBTENER TODOS LOS ALMACENES DE CITRUS
// ==========================================================

export async function fetchWarehousesTest() {
  const PAGE_SIZE = 100;
  const MAX_PAGES = 1000;

  try {
    console.log("🟨🟨🟨 ========================================");
    console.log("📦 INICIANDO BÚSQUEDA DE ALMACENES");
    console.log("🕒 Fecha:", new Date().toISOString());
    console.log("🟨🟨🟨 ========================================");

    /*
     * Se utiliza un Map para evitar que un almacén se agregue
     * más de una vez si Citrus repite registros entre páginas.
     *
     * La clave será el ID del almacén en Citrus.
     */
    const warehousesById = new Map();

    let page = 1;
    let finished = false;

    while (!finished && page <= MAX_PAGES) {
      console.log("------------------------------------------");
      console.log(`📄 BUSCANDO PÁGINA ${page}`);
      console.log(`📦 Cantidad por página: ${PAGE_SIZE}`);
      console.log("------------------------------------------");

      const xml = buildWarehouseSearchXml({
        page,
        pageSize: PAGE_SIZE
      });

      const data = await callERPWarehouses(xml);

      /*
       * Aunque callERPWarehouses ya valida Success,
       * volvemos a confirmar que Data exista.
       */
      if (!data?.Data) {
        throw new Error(
          `Citrus no devolvió Data en la página ${page}`
        );
      }

      /*
       * Cuando Citrus devuelve un solo almacén, dependiendo de
       * cómo venga la respuesta, podría ser un objeto en lugar
       * de un arreglo.
       *
       * Lo normalizamos siempre como arreglo.
       */
      const rawWarehouses = data.Data.Almacenes;

      const pageWarehouses = Array.isArray(rawWarehouses)
        ? rawWarehouses
        : rawWarehouses
          ? [rawWarehouses]
          : [];

      console.log(
        `📦 Almacenes recibidos en página ${page}:`,
        pageWarehouses.length
      );

      /*
       * Si la página no trajo resultados, ya terminamos.
       */
      if (pageWarehouses.length === 0) {
        console.log(
          `✅ La página ${page} no devolvió almacenes`
        );

        finished = true;
        break;
      }

      const totalBefore = warehousesById.size;

      for (const warehouse of pageWarehouses) {
        /*
         * El ID de Citrus es obligatorio para poder sincronizar
         * correctamente el almacén en PostgreSQL.
         */
        if (
          warehouse?.Id === null ||
          warehouse?.Id === undefined
        ) {
          console.warn(
            "⚠️ Citrus devolvió un almacén sin Id:",
            warehouse
          );

          continue;
        }

        const warehouseId = String(warehouse.Id);

        warehousesById.set(
          warehouseId,
          warehouse
        );
      }

      const totalAfter = warehousesById.size;
      const newWarehouses = totalAfter - totalBefore;

      console.log(
        `➕ Nuevos almacenes agregados: ${newWarehouses}`
      );

      console.log(
        `📊 Total acumulado: ${totalAfter}`
      );

      /*
       * Protección importante:
       *
       * Si Citrus devuelve una página completa pero todos los
       * registros ya habían sido recibidos, posiblemente está
       * ignorando el número de página y repitiendo la página 1.
       *
       * Se detiene el proceso para evitar un ciclo infinito.
       */
      if (newWarehouses === 0) {
        console.warn(
          `⚠️ La página ${page} no agregó almacenes nuevos.`
        );

        console.warn(
          "⚠️ Se detiene la paginación para evitar un ciclo infinito."
        );

        finished = true;
        break;
      }

      /*
       * Si Citrus devolvió menos registros que PAGE_SIZE,
       * significa que esta fue la última página.
       */
      if (pageWarehouses.length < PAGE_SIZE) {
        console.log(
          `✅ Última página detectada: ${page}`
        );

        finished = true;
        break;
      }

      page += 1;
    }

    if (page > MAX_PAGES) {
      throw new Error(
        `Se alcanzó el límite de ${MAX_PAGES} páginas buscando almacenes`
      );
    }

    const warehouses = Array.from(
      warehousesById.values()
    );

    console.log("==========================================");
    console.log("✅ BÚSQUEDA DE ALMACENES FINALIZADA");
    console.log(
      "📦 TOTAL DE ALMACENES:",
      warehouses.length
    );
    console.log("==========================================");

    return warehouses;

  } catch (error) {
    console.error("==========================================");
    console.error("🔥 ERROR BUSCANDO ALMACENES");
    console.error("Mensaje:", error.message);
    console.error("==========================================");

    /*
     * No devolver [].
     *
     * Si el cron recibe [] podría interpretar incorrectamente
     * que Citrus no tiene almacenes y desactivar todos los
     * almacenes existentes del WMS.
     */
    throw error;
  }
}


// ==========================================================
// 2. CONSTRUIR XML PARA BUSCAR UNA PÁGINA
// ==========================================================

function buildWarehouseSearchXml({
  page,
  pageSize
}) {
  if (!Number.isInteger(page) || page <= 0) {
    throw new Error(
      `Número de página inválido: ${page}`
    );
  }

  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new Error(
      `Cantidad por página inválida: ${pageSize}`
    );
  }

  return `
    <?xml version="1.0" encoding="utf-8"?>

    <soapenv:Envelope
      xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
      xmlns:tem="http://tempuri.org/">

      <soapenv:Header/>

      <soapenv:Body>

        <tem:BuscarAlmacenes>

          <tem:almacenWhere>

            <tem:Pagina>${page}</tem:Pagina>

            <tem:CantidadPorPagina>
              ${pageSize}
            </tem:CantidadPorPagina>

            <tem:EsAscendente>
              true
            </tem:EsAscendente>

            <tem:EsOrdenable>
              true
            </tem:EsOrdenable>

            

          </tem:almacenWhere>

        </tem:BuscarAlmacenes>

      </soapenv:Body>

    </soapenv:Envelope>
  `.trim();
}


// ==========================================================
// 3. LLAMAR AL SERVICIO DE ALMACENES DE CITRUS
// ==========================================================

export async function callERPWarehouses(xmlBody) {
  /*
   * getCitrusUrl debe devolver:
   *
   * app_prod:
   * https://api.citrus.com.do/40/
   *
   * wms_test:
   * https://testapi.citrus.com.do/40/
   */
  const url =
  "https://testapi.citrus.com.do/40/Inventario/AlmacenService.asmx";

  const soapAction =
    "http://tempuri.org/BuscarAlmacenes";

  try {
    let auth = await getERPAuth();

    validateERPAuth(auth);

    /*
     * Máximo dos intentos:
     *
     * 1. Token actual.
     * 2. Nuevo token después de refreshERPToken().
     */
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      console.log("------------------------------------------");
      console.log(
        `📡 CITRUS ALMACENES - INTENTO ${attempt}`
      );
      console.log("URL:", url);
      console.log("------------------------------------------");

      const response = await axios({
        method: "post",
        url,
        data: xmlBody,

        headers: {
          "Content-Type":
            "text/xml; charset=utf-8",

          SOAPAction: soapAction,

          Authorization:
            auth.token.trim(),

          UsuarioTicketId:
            String(auth.ticket).trim()
        },

        timeout: 30000,

        /*
         * Evita que Axios lance el error antes de que podamos
         * imprimir el XML devuelto por Citrus.
         */
        validateStatus: () => true,

        /*
         * Evita que Axios intente transformar el XML.
         */
        transformRequest: [
          (data) => data
        ]
      });

      console.log(
        "📥 HTTP STATUS:",
        response.status
      );

      /*
       * Citrus puede devolver un SOAP Fault con status 500.
       */
      if (
        response.status < 200 ||
        response.status >= 300
      ) {
        console.error(
          "🔴 RESPUESTA HTTP INVÁLIDA DE CITRUS"
        );

        console.error(
          "STATUS:",
          response.status
        );

        console.error(
          "BODY:",
          response.data
        );

        /*
         * Intentamos extraer el SOAP Fault para tener
         * un mensaje más claro.
         */
        const soapFaultMessage =
          await extractSoapFaultMessage(
            response.data
          );

        throw new Error(
          soapFaultMessage ||
          `Citrus respondió con HTTP ${response.status}`
        );
      }

      const data =
        await parseWarehouseSoapResponse(
          response.data
        );

      /*
       * Si el token o ticket expiraron, renovamos y repetimos
       * exactamente una vez.
       */
      const sessionExpired =
        Number(data?.SesionExpirada) === 1;

      const invalidTicket =
        Number(data?.TicketInvalido) === 1;

      if (sessionExpired || invalidTicket) {
        console.warn(
          "🔄 Sesión de Citrus expirada o ticket inválido"
        );

        if (attempt === 2) {
          throw new Error(
            "Citrus continúa rechazando la sesión después del relogin"
          );
        }

        auth = await refreshERPToken();

        validateERPAuth(auth);

        continue;
      }

      /*
       * Validación de la respuesta funcional de Citrus.
       */
      if (Number(data?.Success) !== 1) {
        const message =
          data?.Mensaje ||
          "Citrus no pudo buscar los almacenes";

        const errorCode =
          data?.CodigoError ??
          data?.Error ??
          "SIN_CODIGO";

        throw new Error(
          `Error Citrus ${errorCode}: ${message}`
        );
      }

      console.log(
        "✅ Citrus devolvió los almacenes correctamente"
      );

      /*
       * No se imprime NuevoToken para evitar exponer
       * credenciales en los logs.
       */
      return data;
    }

    throw new Error(
      "No fue posible obtener los almacenes de Citrus"
    );

  } catch (error) {
    console.error("==========================================");
    console.error("🔴 ERP WAREHOUSES ERROR");
    console.error("Mensaje:", error.message);

    if (error.response) {
      console.error(
        "STATUS:",
        error.response.status
      );

      console.error(
        "BODY:",
        error.response.data
      );
    }

    console.error("==========================================");

    throw error;
  }
}


// ==========================================================
// 4. CONVERTIR RESPUESTA SOAP A JSON
// ==========================================================

async function parseWarehouseSoapResponse(
  xmlResponse
) {
  if (
    typeof xmlResponse !== "string" ||
    !xmlResponse.trim()
  ) {
    throw new Error(
      "Citrus devolvió una respuesta SOAP vacía"
    );
  }

  const parsed = await parseStringPromise(
    xmlResponse,
    {
      explicitArray: false,
      ignoreAttrs: true,
      trim: true
    }
  );

  /*
   * Busca nodos por nombre local, sin depender de que el
   * prefijo sea soap, soapenv u otro.
   */
  const envelope =
    getNodeByLocalName(
      parsed,
      "Envelope"
    );

  if (!envelope) {
    throw new Error(
      "No se encontró el nodo SOAP Envelope"
    );
  }

  const body =
    getNodeByLocalName(
      envelope,
      "Body"
    );

  if (!body) {
    throw new Error(
      "No se encontró el nodo SOAP Body"
    );
  }

  const fault =
    getNodeByLocalName(
      body,
      "Fault"
    );

  if (fault) {
    const faultMessage =
      fault.faultstring ||
      fault.faultcode ||
      JSON.stringify(fault);

    throw new Error(
      `SOAP Fault: ${faultMessage}`
    );
  }

  const responseNode =
    getNodeByLocalName(
      body,
      "BuscarAlmacenesResponse"
    );

  if (!responseNode) {
    console.error(
      "BODY SOAP RECIBIDO:",
      JSON.stringify(body, null, 2)
    );

    throw new Error(
      "No existe BuscarAlmacenesResponse"
    );
  }

  const raw =
    getNodeByLocalName(
      responseNode,
      "BuscarAlmacenesResult"
    );

  if (
    raw === null ||
    raw === undefined ||
    raw === ""
  ) {
    throw new Error(
      "No existe BuscarAlmacenesResult"
    );
  }

  /*
   * Citrus devuelve el JSON como texto dentro del XML.
   */
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch (error) {
      console.error(
        "RESPUESTA SIN CONVERTIR:",
        raw
      );

      throw new Error(
        `BuscarAlmacenesResult no contiene JSON válido: ${error.message}`
      );
    }
  }

  /*
   * Se conserva por compatibilidad en caso de que alguna
   * versión del servicio ya entregue el objeto convertido.
   */
  if (typeof raw === "object") {
    return raw;
  }

  throw new Error(
    "Formato inválido en BuscarAlmacenesResult"
  );
}


// ==========================================================
// 5. BUSCAR UN NODO XML SIN DEPENDER DEL PREFIJO
// ==========================================================

function getNodeByLocalName(
  object,
  localName
) {
  if (
    !object ||
    typeof object !== "object"
  ) {
    return undefined;
  }

  const key = Object.keys(object).find(
    (currentKey) => {
      const nameWithoutPrefix =
        currentKey.includes(":")
          ? currentKey.split(":").pop()
          : currentKey;

      return nameWithoutPrefix === localName;
    }
  );

  return key
    ? object[key]
    : undefined;
}


// ==========================================================
// 6. EXTRAER MENSAJE DE SOAP FAULT
// ==========================================================

async function extractSoapFaultMessage(
  xmlResponse
) {
  try {
    if (
      typeof xmlResponse !== "string" ||
      !xmlResponse.trim()
    ) {
      return null;
    }

    const parsed = await parseStringPromise(
      xmlResponse,
      {
        explicitArray: false,
        ignoreAttrs: true,
        trim: true
      }
    );

    const envelope =
      getNodeByLocalName(
        parsed,
        "Envelope"
      );

    const body =
      getNodeByLocalName(
        envelope,
        "Body"
      );

    const fault =
      getNodeByLocalName(
        body,
        "Fault"
      );

    return (
      fault?.faultstring ||
      fault?.faultcode ||
      null
    );

  } catch {
    return null;
  }
}


// ==========================================================
// 7. VALIDAR AUTENTICACIÓN
// ==========================================================

function validateERPAuth(auth) {
  if (!auth?.token) {
    throw new Error(
      "getERPAuth no devolvió el token de Citrus"
    );
  }

  if (
    auth.ticket === null ||
    auth.ticket === undefined
  ) {
    throw new Error(
      "getERPAuth no devolvió UsuarioTicketId"
    );
  }
}




// ==========================================================
// SINCRONIZAR TODOS LOS ALMACENES DE CITRUS
// ==========================================================



// ==========================================================
// GENERAR UN CODE DISPONIBLE
// ==========================================================


// ==========================================================
// SINCRONIZAR ALMACENES DE CITRUS CON POSTGRESQL
// ==========================================================

export async function syncWarehouses(citrusWarehouses) {
  let clientDb = null;
  let transactionStarted = false;

  try {
    // ======================================================
    // 1. VALIDAR RESPUESTA DE CITRUS
    // ======================================================

    if (!Array.isArray(citrusWarehouses)) {
      throw new Error(
        "citrusWarehouses debe ser un arreglo"
      );
    }

    /*
     * Evita marcar todos los almacenes como INACTIVE si
     * Citrus falla y devuelve un arreglo vacío.
     */
    if (citrusWarehouses.length === 0) {
      throw new Error(
        "Citrus devolvió cero almacenes. Se canceló la sincronización para evitar desactivar todos los registros."
      );
    }

    // ======================================================
    // 2. NORMALIZAR Y ELIMINAR DUPLICADOS
    // ======================================================

    const warehousesByErpId = new Map();

    for (const warehouse of citrusWarehouses) {
      const erpWarehouseId = Number(
        warehouse?.Id
      );

      if (
        !Number.isSafeInteger(erpWarehouseId) ||
        erpWarehouseId <= 0
      ) {
        console.warn(
          "⚠️ Almacén ignorado porque no tiene un Id válido:",
          warehouse
        );

        continue;
      }

      const shortDescription =
        cleanNullableString(
          warehouse.DescripcionCorta
        );

      const description =
        cleanNullableString(
          warehouse.Descripcion
        );

      /*
       * DescripcionCorta se guarda como name.
       *
       * Si viene vacía, utiliza Descripcion.
       */
      const name = truncateString(
        shortDescription ||
          description ||
          `Almacén ${erpWarehouseId}`,
        150
      );

      /*
       * Citrus:
       * A = ACTIVE
       * Cualquier otro valor = INACTIVE
       */
      const status =
        String(warehouse.Estatus ?? "")
          .trim()
          .toUpperCase() === "A"
          ? "ACTIVE"
          : "INACTIVE";

      /*
       * Citrus actualmente no envía un código, pero se
       * deja soporte por si lo agrega posteriormente.
       */
      const incomingCode =
        cleanNullableString(
          warehouse.Codigo ??
            warehouse.Code ??
            warehouse.code
        );

      /*
       * Si Citrus repite el mismo Id, conserva la última
       * versión recibida.
       */
      warehousesByErpId.set(
        String(erpWarehouseId),
        {
          erpWarehouseId,
          incomingCode,
          name,
          description,
          status
        }
      );
    }

    const normalizedWarehouses =
      Array.from(
        warehousesByErpId.values()
      );

    if (normalizedWarehouses.length === 0) {
      throw new Error(
        "Ningún almacén recibido tenía un Id válido"
      );
    }

    const receivedErpIds =
  normalizedWarehouses.map(
    (warehouse) =>
      String(warehouse.erpWarehouseId)
  );

    console.log("========================================");
    console.log("🏬 INICIANDO SINCRONIZACIÓN DE ALMACENES");
    console.log(
      "📦 Almacenes recibidos:",
      citrusWarehouses.length
    );
    console.log(
      "📦 Almacenes válidos:",
      normalizedWarehouses.length
    );
    console.log(
      "🔢 IDs recibidos:",
      receivedErpIds
    );
    console.log("========================================");

    // ======================================================
    // 3. OBTENER CONEXIÓN POSTGRESQL
    // ======================================================

    console.log(
      "🔌 Conectando con PostgreSQL..."
    );

    clientDb = await db.connect();

    if (
      !clientDb ||
      typeof clientDb.query !== "function"
    ) {
      throw new Error(
        "No fue posible obtener una conexión válida de PostgreSQL"
      );
    }

    console.log(
      "✅ Conexión PostgreSQL obtenida"
    );

    // ======================================================
    // 4. INICIAR TRANSACCIÓN
    // ======================================================

    await clientDb.query("BEGIN");
    transactionStarted = true;

    console.log(
      "🔄 Transacción iniciada"
    );

    /*
     * Evita dos sincronizaciones de almacenes ejecutándose
     * simultáneamente.
     */
    await clientDb.query(`
      SELECT pg_advisory_xact_lock(
        hashtext('citrus_warehouses_sync')
      )
    `);

    // ======================================================
    // 5. BUSCAR ALMACENES EXISTENTES
    // ======================================================

    const existingResult =
  await clientDb.query(
    `
    SELECT
      id,
      code,
      name,
      status,
      description,
      address_line,
      is_default,
      erp_warehouse_id,
      erp_location_id,
      created_at,
      updated_at
    FROM warehouses
    WHERE erp_warehouse_id::text = ANY($1::text[])
    FOR UPDATE
    `,
    [receivedErpIds]
  );

    const existingByErpId =
      new Map(
        existingResult.rows.map(
          (row) => [
            String(row.erp_warehouse_id),
            row
          ]
        )
      );

    const summary = {
      received: normalizedWarehouses.length,
      inserted: 0,
      updated: 0,
      unchanged: 0,
      inactivated: 0,
      active: 0,
      inactive: 0
    };

    const insertedWarehouses = [];
    const updatedWarehouses = [];
    const inactivatedWarehouses = [];

    // ======================================================
    // 6. INSERTAR O ACTUALIZAR ALMACENES
    // ======================================================

    for (const warehouse of normalizedWarehouses) {
      const existingWarehouse =
        existingByErpId.get(
          String(
            warehouse.erpWarehouseId
          )
        );

      if (warehouse.status === "ACTIVE") {
        summary.active += 1;
      } else {
        summary.inactive += 1;
      }

      // ====================================================
      // 6A. ACTUALIZAR ALMACÉN EXISTENTE
      // ====================================================

      if (existingWarehouse) {
        /*
         * Si Citrus no envía code, conserva el código que
         * actualmente tiene el almacén.
         */
        let finalCode =
          existingWarehouse.code;

        /*
         * Si Citrus comienza a enviar un code, valida que no
         * esté siendo utilizado por otro almacén.
         */
        if (warehouse.incomingCode) {
          finalCode =
            await getAvailableWarehouseCode(
              clientDb,
              warehouse.incomingCode,
              warehouse.erpWarehouseId
            );
        }

        const updateResult =
          await clientDb.query(
            `
            UPDATE warehouses
            SET
              code = $2,
              name = $3,
              status = $4,
              description = $5,
              updated_at = NOW()
            WHERE erp_warehouse_id::text = $1::text
              AND (
                code IS DISTINCT FROM $2
                OR name IS DISTINCT FROM $3
                OR status IS DISTINCT FROM $4
                OR description IS DISTINCT FROM $5
              )
            RETURNING
              id,
              code,
              name,
              status,
              description,
              address_line,
              is_default,
              erp_warehouse_id,
              erp_location_id,
              created_at,
              updated_at
            `,
            [
              String(warehouse.erpWarehouseId),
              finalCode,
              warehouse.name,
              warehouse.status,
              warehouse.description
            ]
          );

        if (updateResult.rowCount > 0) {
          summary.updated += 1;

          updatedWarehouses.push(
            updateResult.rows[0]
          );

          console.log(
            "♻️ ALMACÉN ACTUALIZADO:",
            {
              id:
                updateResult.rows[0].id,
              erpWarehouseId:
                warehouse.erpWarehouseId,
              code: finalCode,
              name: warehouse.name,
              status: warehouse.status
            }
          );
        } else {
          summary.unchanged += 1;

          console.log(
            "✅ ALMACÉN SIN CAMBIOS:",
            {
              id:
                existingWarehouse.id,
              erpWarehouseId:
                warehouse.erpWarehouseId,
              code:
                existingWarehouse.code,
              name:
                existingWarehouse.name,
              status:
                existingWarehouse.status
            }
          );
        }

        continue;
      }

      // ====================================================
      // 6B. INSERTAR ALMACÉN NUEVO
      // ====================================================

      /*
       * Si Citrus no envía código:
       *
       * Id 1 → WH-1
       * Id 2 → WH-2
       * Id 7 → WH-7
       */
      const requestedCode =
        warehouse.incomingCode ||
        `WH-${warehouse.erpWarehouseId}`;

      const generatedCode =
        await getAvailableWarehouseCode(
          clientDb,
          requestedCode,
          warehouse.erpWarehouseId
        );

      const insertResult =
        await clientDb.query(
          `
          INSERT INTO warehouses (
            code,
            name,
            status,
            description,
            address_line,
            is_default,
            erp_warehouse_id,
            erp_location_id,
            created_at,
            updated_at
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            NULL,
            FALSE,
            $5,
            NULL,
            NOW(),
            NOW()
          )
          RETURNING
            id,
            code,
            name,
            status,
            description,
            address_line,
            is_default,
            erp_warehouse_id,
            erp_location_id,
            created_at,
            updated_at
          `,
          [
            generatedCode,
            warehouse.name,
            warehouse.status,
            warehouse.description,
            warehouse.erpWarehouseId
          ]
        );

      summary.inserted += 1;

      insertedWarehouses.push(
        insertResult.rows[0]
      );

      console.log(
        "➕ ALMACÉN INSERTADO:",
        {
          id:
            insertResult.rows[0].id,
          erpWarehouseId:
            warehouse.erpWarehouseId,
          code:
            generatedCode,
          name:
            warehouse.name,
          status:
            warehouse.status
        }
      );
    }

    // ======================================================
    // 7. MARCAR INACTIVE LOS QUE YA NO LLEGARON
    // ======================================================

    const inactiveResult =
  await clientDb.query(
    `
    UPDATE warehouses
    SET
      status = 'INACTIVE',
      updated_at = NOW()
    WHERE erp_warehouse_id IS NOT NULL
      AND erp_warehouse_id::text <> ALL($1::text[])
      AND status IS DISTINCT FROM 'INACTIVE'
    RETURNING
      id,
      code,
      name,
      status,
      description,
      address_line,
      is_default,
      erp_warehouse_id,
      erp_location_id,
      created_at,
      updated_at
    `,
    [receivedErpIds]
  );

    summary.inactivated =
      inactiveResult.rowCount;

    inactivatedWarehouses.push(
      ...inactiveResult.rows
    );

    for (
      const warehouse
      of inactiveResult.rows
    ) {
      console.log(
        "🚫 ALMACÉN MARCADO COMO INACTIVE:",
        {
          id:
            warehouse.id,
          erpWarehouseId:
            warehouse.erp_warehouse_id,
          code:
            warehouse.code,
          name:
            warehouse.name
        }
      );
    }

    // ======================================================
    // 8. COMMIT
    // ======================================================

    await clientDb.query("COMMIT");
    transactionStarted = false;

    console.log(
      "✅ COMMIT realizado correctamente"
    );

    console.log("========================================");
    console.log("✅ SINCRONIZACIÓN FINALIZADA");
    console.log("📊 RESUMEN:", summary);
    console.log("========================================");

    return {
      success: true,
      summary,
      insertedWarehouses,
      updatedWarehouses,
      inactivatedWarehouses
    };

  } catch (error) {
    console.error(
      "❌ ERROR SINCRONIZANDO ALMACENES:",
      error.message
    );

    // ======================================================
    // 9. ROLLBACK
    // ======================================================

    if (clientDb && transactionStarted) {
      try {
        await clientDb.query(
          "ROLLBACK"
        );

        transactionStarted = false;

        console.log(
          "↩️ ROLLBACK realizado correctamente"
        );
      } catch (rollbackError) {
        console.error(
          "❌ ERROR DURANTE EL ROLLBACK:",
          rollbackError.message
        );
      }
    }

    throw error;

  } finally {
    // ======================================================
    // 10. LIBERAR CONEXIÓN
    // ======================================================

    if (clientDb) {
      try {
        clientDb.release();

        console.log(
          "🔌 Conexión PostgreSQL liberada"
        );
      } catch (releaseError) {
        console.error(
          "❌ ERROR LIBERANDO LA CONEXIÓN:",
          releaseError.message
        );
      }
    }
  }
}


// ==========================================================
// GENERAR UN CODE ÚNICO PARA EL ALMACÉN
// ==========================================================

async function getAvailableWarehouseCode(
  clientDb,
  requestedCode,
  erpWarehouseId
) {
  const normalizedBaseCode =
    normalizeWarehouseCode(
      requestedCode
    ) ||
    `WH-${erpWarehouseId}`;

  /*
   * warehouses.code permite máximo 20 caracteres.
   *
   * Si existe un conflicto:
   *
   * WH-2
   * WH-2-1
   * WH-2-2
   */
  for (
    let attempt = 0;
    attempt <= 99;
    attempt += 1
  ) {
    const suffix =
      attempt === 0
        ? ""
        : `-${attempt}`;

    const availableLength =
      20 - suffix.length;

    const candidate =
      normalizedBaseCode
        .slice(
          0,
          availableLength
        ) + suffix;

    const conflictResult =
  await clientDb.query(
    `
    SELECT
      id,
      erp_warehouse_id
    FROM warehouses
    WHERE code = $1
      AND erp_warehouse_id::text
          IS DISTINCT FROM $2::text
    LIMIT 1
    `,
    [
      candidate,
      String(erpWarehouseId)
    ]
  );

    if (
      conflictResult.rowCount === 0
    ) {
      return candidate;
    }
  }

  throw new Error(
    `No fue posible generar un code único para el almacén ERP ${erpWarehouseId}`
  );
}





// ==========================================================
// LIMPIAR STRINGS OPCIONALES
// ==========================================================

function cleanNullableString(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }

  const cleaned =
    String(value).trim();

  return cleaned || null;
}


// ==========================================================
// LIMITAR LONGITUD DE UN STRING
// ==========================================================

function truncateString(
  value,
  maxLength
) {
  return String(value)
    .trim()
    .slice(0, maxLength);
}


// ==========================================================
// NORMALIZAR CODE
// ==========================================================

function normalizeWarehouseCode(
  value
) {
  if (
    value === null ||
    value === undefined
  ) {
    return "";
  }

  return String(value)
    .normalize("NFD")
    .replace(
      /[\u0300-\u036f]/g,
      ""
    )
    .trim()
    .toUpperCase()
    .replace(
      /[^A-Z0-9]+/g,
      "-"
    )
    .replace(
      /^-+|-+$/g,
      ""
    )
    .slice(0, 20);
}

