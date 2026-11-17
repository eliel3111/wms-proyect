//file: wms-backend/integrations/admcloud/admcloud_inspeccion.js
import admcloudClient from "./admcloudClient.js";
import db from "../../db.js";

// ============================================================
// CONFIGURACIÓN GENERAL - INSPECCIÓN ADM CLOUD
// ============================================================

const showconsolelogdetails = true;

const MAX_PAGES = 10000;
const DISPATCH_SYNC_BATCH_SIZE = 250;

const TIME_ZONE = "America/Santo_Domingo";

// ============================================================
// CONSOLE LOG CONDICIONAL
// ============================================================

const logDetails = (...args) => {
    if (showconsolelogdetails) {
        console.log(...args);
    }
};

// ============================================================
// OBTENER FECHA ACTUAL DE REPÚBLICA DOMINICANA
// ============================================================

function getCurrentDateParts() {

    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: TIME_ZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(new Date());

    const getPart = (type) =>
        parts.find((part) => part.type === type)?.value;

    return {
        year: getPart("year"),
        month: getPart("month"),
        day: getPart("day"),
    };
}

// ============================================================
// OBTENER FECHAS DEL MES ACTUAL
// ============================================================

function getCurrentMonthDates() {

    const { year, month, day } = getCurrentDateParts();

    return {
        dateFrom: `${year}-${month}-01`,
        dateTo: `${year}-${month}-${day}`,
    };
}

// ============================================================
// OBTENER FECHAS DEL AÑO ACTUAL
// ============================================================

function getCurrentYearDates() {

    const { year } = getCurrentDateParts();

    return {
        dateFrom: `${year}-01-01`,
        dateTo: `${year}-12-31`,
    };
}

// ============================================================
// EXTRAER LISTADO DE CONDUCES
// ============================================================

function extractDispatches(data) {

    if (Array.isArray(data)) {
        return data;
    }

    if (Array.isArray(data?.items)) {
        return data.items;
    }

    if (Array.isArray(data?.Items)) {
        return data.Items;
    }

    if (Array.isArray(data?.results)) {
        return data.results;
    }

    if (Array.isArray(data?.Results)) {
        return data.Results;
    }

    throw new Error(
        "Formato de listado desconocido en Adm Cloud. " +
        "Revisar response.data.data."
    );
}

// ============================================================
// OBTENER TODOS LOS CONDUCES POR RANGO DE FECHAS
// FUNCIÓN REUTILIZABLE PARA MES Y AÑO
// ============================================================

async function getAdmCloudDispatchesByRange({
    dateFrom,
    dateTo,
    periodLabel,
}) {

    const startedAt = Date.now();

    const allDispatches = [];
    const seenIds = new Set();

    let skip = 0;
    let page = 0;
    let paginationCompleted = false;

    try {

        // ====================================================
        // 1. INICIO
        // ====================================================

        logDetails(
            "\n🟦🟦🟦 ========================================"
        );

        logDetails(
            "📦 ADM CLOUD - INSPECCIÓN DE CONDUCES"
        );

        logDetails(
            "🟦🟦🟦 ========================================"
        );

        logDetails("🗓️ PERÍODO:", periodLabel);
        logDetails("📅 FECHA INICIAL:", dateFrom);
        logDetails("📅 FECHA FINAL:", dateTo);
        logDetails("🌐 ENDPOINT: GET /Dispatchs");

        // ====================================================
        // 2. PAGINACIÓN
        // ====================================================

        while (page < MAX_PAGES) {

            page++;

            logDetails(
                "\n🟨 ========================================"
            );

            logDetails("📄 PÁGINA:", page);
            logDetails("📌 SKIP:", skip);

            // =================================================
            // 3. LLAMADA A ADM CLOUD
            // =================================================

            const response = await admcloudClient.get(
                "/Dispatchs",
                {
                    params: {
                        skip,
                        DateFrom: dateFrom,
                        DateTo: dateTo,
                        ShowVoid: true,
                    },

                    timeout: 60000,
                }
            );

            logDetails(
                "🌐 HTTP STATUS:",
                response.status
            );

            // =================================================
            // 4. VALIDAR RESPUESTA
            // =================================================

            const result = response.data;

            if (result?.success !== true) {

                throw new Error(
                    result?.message ||
                    "Adm Cloud devolvió success=false"
                );
            }

            logDetails(
                "📥 RESPUESTA ADM CLOUD:",
                result
            );

            // =================================================
            // 5. EXTRAER CONDUCES
            // =================================================

            const dispatches = extractDispatches(
                result.data
            );

            logDetails(
                "📦 CONDUCES EN ESTA PÁGINA:",
                dispatches.length
            );

            // =================================================
            // 6. VERIFICAR FINAL DE PAGINACIÓN
            // =================================================

            if (dispatches.length === 0) {

                paginationCompleted = true;

                logDetails(
                    "✅ No hay más conduces."
                );

                break;
            }

            // =================================================
            // 7. ACUMULAR CONDUCES
            // =================================================

            let newCount = 0;

            for (const dispatch of dispatches) {

                const id =
                    dispatch?.ID ??
                    dispatch?.Id ??
                    dispatch?.id;

                if (id == null) {

                    throw new Error(
                        "Adm Cloud devolvió un conduce sin ID."
                    );
                }

                const key = String(id).toLowerCase();

                if (seenIds.has(key)) {
                    continue;
                }

                seenIds.add(key);

                allDispatches.push(dispatch);
                newCount++;

                // =============================================
                // LOG DETALLADO POR CONDUCE
                // =============================================

                logDetails(
                    "📋 CONDUCE:",
                    {
                        ID: id,
                        DocID: dispatch.DocID,
                        DocDate: dispatch.DocDate,
                        Reference: dispatch.Reference,
                        RelationshipID: dispatch.RelationshipID,
                        RelationshipName: dispatch.RelationshipName,
                        LocationID: dispatch.LocationID,
                        LocationName: dispatch.LocationName,
                        Status: dispatch.Status,
                        StatusDesc: dispatch.StatusDesc,
                        Void: dispatch.Void,
                        TotalAmount: dispatch.TotalAmount,
                        CreationDate: dispatch.CreationDate,
                    }
                );
            }

            logDetails(
                "➕ NUEVOS CONDUCES:",
                newCount
            );

            logDetails(
                "📊 TOTAL ACUMULADO:",
                allDispatches.length
            );

            // =================================================
            // 8. VALIDAR QUE LA PAGINACIÓN AVANCE
            // =================================================

            if (newCount === 0) {

                throw new Error(
                    "La paginación no avanzó. " +
                    "Adm Cloud devolvió una página repetida."
                );
            }

            // =================================================
            // 9. SIGUIENTE PÁGINA
            // =================================================

            skip += dispatches.length;
        }

        if (!paginationCompleted) {

            throw new Error(
                "Se alcanzó el límite de páginas. " +
                "La consulta podría estar incompleta."
            );
        }

        // ====================================================
        // 10. RESULTADO FINAL
        // ====================================================

        const duration = (
            (Date.now() - startedAt) / 1000
        ).toFixed(2);

        logDetails(
            "\n🟩🟩🟩 ========================================"
        );

        logDetails(
            "✅ INSPECCIÓN DE CONDUCES COMPLETADA"
        );

        logDetails("🗓️ PERÍODO:", periodLabel);

        logDetails(
            "📦 TOTAL CONDUCES:",
            allDispatches.length
        );

        logDetails(
            "📄 PÁGINAS CONSULTADAS:",
            page
        );

        logDetails(
            "⏱️ DURACIÓN:",
            `${duration} segundos`
        );

        logDetails(
            "🟩🟩🟩 ========================================\n"
        );

        return {
            success: true,
            period: periodLabel,
            dateFrom,
            dateTo,
            total: allDispatches.length,
            pages: page,
            dispatches: allDispatches,
        };

    } catch (error) {

        logDetails(
            "\n🟥🟥🟥 ========================================"
        );

        logDetails(
            "❌ ERROR CONSULTANDO CONDUCES ADM CLOUD"
        );

        logDetails(
            "🗓️ PERÍODO:",
            periodLabel
        );

        logDetails(
            "📄 MESSAGE:",
            error.message
        );

        logDetails(
            "🌐 HTTP STATUS:",
            error.status ?? error.response?.status
        );

        logDetails(
            "📥 ERROR RESPONSE:",
            error.data ?? error.response?.data
        );

        logDetails(
            "📦 CONDUCES RECUPERADOS:",
            allDispatches.length
        );

        logDetails(
            "🟥🟥🟥 ========================================\n"
        );

        throw error;
    }
}

// ============================================================
// OBTENER TODOS LOS CONDUCES DEL MES ACTUAL
// ============================================================

export async function getAdmCloudCurrentMonthDispatches() {

    return getAdmCloudDispatchesByRange({
        ...getCurrentMonthDates(),
        periodLabel: "MES ACTUAL",
    });
}

// ============================================================
// OBTENER TODOS LOS CONDUCES DEL AÑO ACTUAL
// ============================================================

export async function getAdmCloudCurrentYearDispatches() {

    return getAdmCloudDispatchesByRange({
        ...getCurrentYearDates(),
        periodLabel: "AÑO ACTUAL",
    });
}

// ============================================================
// MAPEAR CONDUCE ADM CLOUD -> erp_dispatches
// ============================================================

function mapDispatchForDatabase(dispatch) {

    if (!dispatch || typeof dispatch !== "object") {

        throw new Error(
            "Adm Cloud devolvió un conduce inválido."
        );
    }

    // ========================================================
    // VALIDAR ERP ID
    // ========================================================

    const uuidRegex =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    if (
        typeof dispatch.ID !== "string" ||
        !uuidRegex.test(dispatch.ID)
    ) {

        throw new Error(
            `Conduce sin ID UUID válido: ${
                dispatch.DocID ?? "(sin número)"
            }`
        );
    }

    // ========================================================
    // MAPEAR CAMPOS PARA POSTGRESQL
    // ========================================================

    return {

        erp_id:
            dispatch.ID,

        erp_numero:
            dispatch.DocID ?? null,

        erp_fecha:
            dispatch.DocDate
                ? String(dispatch.DocDate).slice(0, 10)
                : null,

        erp_cliente_id:
            dispatch.RelationshipID ?? null,

        erp_cliente:
            dispatch.RelationshipName ?? null,

        erp_ubicacion_id:
            dispatch.LocationID ?? null,

        erp_ubicacion:
            dispatch.LocationName ?? null,

        erp_referencia:
            dispatch.Reference ?? null,

        erp_estado:
            dispatch.Status ?? null,

        erp_estado_descripcion:
            dispatch.StatusDesc ?? null,

        erp_anulado:
            dispatch.Void ?? false,

        erp_total:
            dispatch.TotalAmount ?? null,

        // PostgreSQL TIMESTAMP admite hasta
        // 6 dígitos decimales.

        erp_fecha_creacion:
            dispatch.CreationDate
                ? String(dispatch.CreationDate).slice(0, 26)
                : null,

        erp_firmado:
            dispatch.Signed ?? null,

        erp_tipo_documento:
            dispatch.DocType ?? null,

        // JSON ORIGINAL COMPLETO

        erp_raw_data:
            dispatch,
    };
}

// ============================================================
// UPSERT MASIVO - erp_dispatches
// ============================================================

const UPSERT_DISPATCHES_SQL = `

    INSERT INTO erp_dispatches (

        erp_id,
        erp_numero,
        erp_fecha,

        erp_cliente_id,
        erp_cliente,

        erp_ubicacion_id,
        erp_ubicacion,

        erp_referencia,

        erp_estado,
        erp_estado_descripcion,

        erp_anulado,
        erp_total,

        erp_fecha_creacion,
        erp_firmado,
        erp_tipo_documento,

        erp_raw_data,
        last_synced_at
    )

    SELECT

        incoming.erp_id,
        incoming.erp_numero,
        incoming.erp_fecha,

        incoming.erp_cliente_id,
        incoming.erp_cliente,

        incoming.erp_ubicacion_id,
        incoming.erp_ubicacion,

        incoming.erp_referencia,

        incoming.erp_estado,
        incoming.erp_estado_descripcion,

        incoming.erp_anulado,
        incoming.erp_total,

        incoming.erp_fecha_creacion,
        incoming.erp_firmado,
        incoming.erp_tipo_documento,

        incoming.erp_raw_data,
        NOW()

    FROM jsonb_to_recordset($1::jsonb) AS incoming (

        erp_id UUID,
        erp_numero VARCHAR(100),
        erp_fecha DATE,

        erp_cliente_id UUID,
        erp_cliente TEXT,

        erp_ubicacion_id UUID,
        erp_ubicacion TEXT,

        erp_referencia TEXT,

        erp_estado INTEGER,
        erp_estado_descripcion VARCHAR(100),

        erp_anulado BOOLEAN,
        erp_total NUMERIC(18, 2),

        erp_fecha_creacion TIMESTAMP,
        erp_firmado INTEGER,
        erp_tipo_documento VARCHAR(50),

        erp_raw_data JSONB
    )

    WHERE TRUE

    ON CONFLICT (erp_id)

    DO UPDATE SET

        erp_numero =
            EXCLUDED.erp_numero,

        erp_fecha =
            EXCLUDED.erp_fecha,

        erp_cliente_id =
            EXCLUDED.erp_cliente_id,

        erp_cliente =
            EXCLUDED.erp_cliente,

        erp_ubicacion_id =
            EXCLUDED.erp_ubicacion_id,

        erp_ubicacion =
            EXCLUDED.erp_ubicacion,

        erp_referencia =
            EXCLUDED.erp_referencia,

        erp_estado =
            EXCLUDED.erp_estado,

        erp_estado_descripcion =
            EXCLUDED.erp_estado_descripcion,

        erp_anulado =
            EXCLUDED.erp_anulado,

        erp_total =
            EXCLUDED.erp_total,

        erp_fecha_creacion =
            EXCLUDED.erp_fecha_creacion,

        erp_firmado =
            EXCLUDED.erp_firmado,

        erp_tipo_documento =
            EXCLUDED.erp_tipo_documento,

        erp_raw_data =
            EXCLUDED.erp_raw_data,

        updated_at = NOW(),

        last_synced_at = NOW()

    RETURNING erp_id;

`;

// ============================================================
// SINCRONIZAR CONDUCES POR PERÍODO
// FUNCIÓN REUTILIZABLE PARA MES Y AÑO
// ============================================================

async function syncAdmCloudDispatches(
    getDispatches,
    periodLabel
) {

    const startedAt = Date.now();

    let client = null;
    let transactionStarted = false;

    let inserted = 0;
    let updated = 0;
    let processed = 0;

    try {

        // ====================================================
        // 1. INICIAR SINCRONIZACIÓN
        // ====================================================

        logDetails(
            "\n🟦🟦🟦 ========================================"
        );

        logDetails(
            "🔄 INICIANDO SINCRONIZACIÓN DE CONDUCES"
        );

        logDetails(
            "🗓️ PERÍODO:",
            periodLabel
        );

        logDetails(
            "🗄️ DESTINO: erp_dispatches"
        );

        logDetails(
            "🟦🟦🟦 ========================================"
        );

        // ====================================================
        // 2. OBTENER CONDUCES DE ADM CLOUD
        // ====================================================

        const apiResult = await getDispatches();

        const {
            dispatches,
            dateFrom,
            dateTo,
            pages,
        } = apiResult;

        // ====================================================
        // 3. MAPEAR CONDUCES PARA POSTGRESQL
        // ====================================================

        const mapped = dispatches.map(
            mapDispatchForDatabase
        );

        // ====================================================
        // 4. VALIDAR IDENTIFICADORES ÚNICOS
        // ====================================================

        const uniqueIds = new Set(
            mapped.map(
                (row) => row.erp_id.toLowerCase()
            )
        );

        if (uniqueIds.size !== mapped.length) {

            throw new Error(
                "El listado contiene IDs de conduces repetidos."
            );
        }

        logDetails(
            "📅 PERÍODO:",
            `${dateFrom} a ${dateTo}`
        );

        logDetails(
            "📄 PÁGINAS OBTENIDAS:",
            pages
        );

        logDetails(
            "📦 CONDUCES A GUARDAR:",
            mapped.length
        );

        // ====================================================
        // 5. CONECTAR A POSTGRESQL
        // ====================================================

        client = await db.connect();

        await client.query("BEGIN");

        transactionStarted = true;

        logDetails(
            "🗄️ TRANSACCIÓN POSTGRESQL INICIADA"
        );

        // ====================================================
        // 6. BLOQUEO CONTRA SINCRONIZACIONES SIMULTÁNEAS
        // ====================================================

        const lockResult = await client.query(`

            SELECT pg_try_advisory_xact_lock(

                hashtext('admcloud_inspeccion'),
                hashtext('erp_dispatches')

            ) AS acquired

        `);

        if (!lockResult.rows[0].acquired) {

            await client.query("ROLLBACK");

            transactionStarted = false;

            logDetails(
                "🟨 OTRA SINCRONIZACIÓN ESTÁ EN CURSO."
            );

            logDetails(
                "⏭️ ESTA EJECUCIÓN SE OMITE."
            );

            return {
                success: true,
                skipped: true,
                reason: "another_sync_in_progress",
                period: periodLabel,
                dateFrom,
                dateTo,
                total: mapped.length,
                inserted: 0,
                updated: 0,
                processed: 0,
            };
        }

        // ====================================================
        // 7. PROCESAR CONDUCES POR LOTES
        // ====================================================

        for (
            let offset = 0;
            offset < mapped.length;
            offset += DISPATCH_SYNC_BATCH_SIZE
        ) {

            const batch = mapped.slice(
                offset,
                offset + DISPATCH_SYNC_BATCH_SIZE
            );

            const batchNumber =
                Math.floor(
                    offset / DISPATCH_SYNC_BATCH_SIZE
                ) + 1;

            const batchIds = batch.map(
                (row) => row.erp_id
            );

            logDetails(
                "\n🟨 ========================================"
            );

            logDetails(
                "📥 LOTE:",
                batchNumber
            );

            logDetails(
                "📦 REGISTROS EN LOTE:",
                batch.length
            );

            // =================================================
            // 8. IDENTIFICAR REGISTROS EXISTENTES
            // =================================================

            const existingResult = await client.query(
                `
                    SELECT
                        erp_id::text AS erp_id
                    FROM erp_dispatches
                    WHERE erp_id = ANY($1::uuid[])
                `,
                [batchIds]
            );

            const existingIds = new Set(
                existingResult.rows.map(
                    (row) => row.erp_id.toLowerCase()
                )
            );

            logDetails(
                "🔎 REGISTROS EXISTENTES:",
                existingIds.size
            );

            // =================================================
            // 9. INSERTAR / ACTUALIZAR CONDUCES
            // =================================================

            const saveResult = await client.query(
                UPSERT_DISPATCHES_SQL,
                [JSON.stringify(batch)]
            );

            if (saveResult.rowCount !== batch.length) {

                throw new Error(
                    `Lote ${batchNumber}: ` +
                    `esperados ${batch.length}, ` +
                    `guardados ${saveResult.rowCount}.`
                );
            }

            // =================================================
            // 10. CONTABILIZAR INSERTADOS Y ACTUALIZADOS
            // =================================================

            for (const dispatch of batch) {

                const wasExisting = existingIds.has(
                    dispatch.erp_id.toLowerCase()
                );

                if (wasExisting) {
                    updated++;
                } else {
                    inserted++;
                }

                processed++;

                // =============================================
                // LOG DETALLADO POR CONDUCE
                // =============================================

                logDetails(
                    wasExisting
                        ? "🔁 ACTUALIZADO:"
                        : "🆕 INSERTADO:",
                    {
                        erp_id:
                            dispatch.erp_id,

                        erp_numero:
                            dispatch.erp_numero,

                        erp_fecha:
                            dispatch.erp_fecha,

                        erp_cliente:
                            dispatch.erp_cliente,

                        erp_ubicacion:
                            dispatch.erp_ubicacion,

                        erp_estado_descripcion:
                            dispatch.erp_estado_descripcion,

                        erp_anulado:
                            dispatch.erp_anulado,

                        erp_total:
                            dispatch.erp_total,
                    }
                );
            }

            logDetails(
                "✅ LOTE GUARDADO:",
                saveResult.rowCount
            );

            logDetails(
                "📊 PROGRESO:",
                `${processed}/${mapped.length}`
            );
        }

        // ====================================================
        // 11. CONFIRMAR TRANSACCIÓN
        // ====================================================

        await client.query("COMMIT");

        transactionStarted = false;

        const durationSeconds = (
            (Date.now() - startedAt) / 1000
        ).toFixed(2);

        // ====================================================
        // 12. RESULTADO EXITOSO
        // ====================================================

        logDetails(
            "\n🟩🟩🟩 ========================================"
        );

        logDetails(
            "✅ SINCRONIZACIÓN DE CONDUCES COMPLETADA"
        );

        logDetails(
            "🗓️ PERÍODO:",
            periodLabel
        );

        logDetails(
            "📅 RANGO:",
            `${dateFrom} a ${dateTo}`
        );

        logDetails(
            "🆕 INSERTADOS:",
            inserted
        );

        logDetails(
            "🔁 ACTUALIZADOS:",
            updated
        );

        logDetails(
            "📦 TOTAL PROCESADOS:",
            processed
        );

        logDetails(
            "⏱️ DURACIÓN:",
            `${durationSeconds} segundos`
        );

        logDetails(
            "🟩🟩🟩 ========================================\n"
        );

        return {
            success: true,
            skipped: false,
            period: periodLabel,
            dateFrom,
            dateTo,
            total: mapped.length,
            inserted,
            updated,
            processed,
            pages,
            durationSeconds: Number(durationSeconds),
        };

    } catch (error) {

        // ====================================================
        // 13. REVERTIR TRANSACCIÓN
        // ====================================================

        if (client && transactionStarted) {

            try {

                await client.query("ROLLBACK");

                logDetails(
                    "↩️ ROLLBACK REALIZADO."
                );

            } catch (rollbackError) {

                logDetails(
                    "❌ ERROR EN ROLLBACK:",
                    rollbackError.message
                );
            }
        }

        // ====================================================
        // 14. LOG DETALLADO DE ERROR
        // ====================================================

        logDetails(
            "\n🟥🟥🟥 ========================================"
        );

        logDetails(
            "❌ ERROR SINCRONIZANDO CONDUCES"
        );

        logDetails(
            "🗓️ PERÍODO:",
            periodLabel
        );

        logDetails(
            "📄 MENSAJE:",
            error.message
        );

        logDetails(
            "🗄️ CÓDIGO PG:",
            error.code ?? null
        );

        logDetails(
            "🗄️ DETALLE PG:",
            error.detail ?? null
        );

        logDetails(
            "🌐 ERROR ADM CLOUD:",
            error.data ?? null
        );

        logDetails(
            "📊 PROCESADOS ANTES DEL ERROR:",
            processed
        );

        logDetails(
            "🟥🟥🟥 ========================================\n"
        );

        throw error;

    } finally {

        // ====================================================
        // 15. LIBERAR CONEXIÓN POSTGRESQL
        // ====================================================

        if (client) {
            client.release();
        }
    }
}

// ============================================================
// SINCRONIZAR TODOS LOS CONDUCES DEL MES ACTUAL
// ============================================================

export async function syncAdmCloudCurrentMonthDispatches() {

    return syncAdmCloudDispatches(
        getAdmCloudCurrentMonthDispatches,
        "MES ACTUAL"
    );
}

// ============================================================
// SINCRONIZAR TODOS LOS CONDUCES DEL AÑO ACTUAL
// ============================================================

export async function syncAdmCloudCurrentYearDispatches() {

    return syncAdmCloudDispatches(
        getAdmCloudCurrentYearDispatches,
        "AÑO ACTUAL"
    );
}




// ============================================================
// CONFIGURACIÓN - FACTURAS A CRÉDITO
// ============================================================

const INVOICE_SYNC_BATCH_SIZE = 250;

const INVOICE_ENDPOINT = "/CreditInvoices";

// Bloqueo exclusivo para erp_invoices.
// No interfiere con el bloqueo de Conduces.

const INVOICE_LOCK_SQL = `
    SELECT pg_try_advisory_lock(
        hashtext('admcloud_inspeccion'),
        hashtext('erp_invoices')
    ) AS acquired
`;

const INVOICE_UNLOCK_SQL = `
    SELECT pg_advisory_unlock(
        hashtext('admcloud_inspeccion'),
        hashtext('erp_invoices')
    ) AS released
`;


// ============================================================
// EXTRAER FACTURAS DE LA RESPUESTA ADM CLOUD
// ============================================================

function extractCreditInvoices(data) {

    if (Array.isArray(data)) {
        return data;
    }

    const keys = [
        "items",
        "Items",
        "results",
        "Results",
        "records",
        "Records",
        "rows",
        "Rows",
        "data",
        "Data"
    ];

    for (const key of keys) {

        const value = data?.[key];

        if (Array.isArray(value)) {
            return value;
        }

        if (value && typeof value === "object") {

            for (const nestedKey of keys) {

                if (Array.isArray(value[nestedKey])) {
                    return value[nestedKey];
                }

            }
        }
    }

    throw new Error(
        "Formato desconocido en listado de CreditInvoices. " +
        "Revisar la estructura de response.data."
    );

}


// ============================================================
// OBTENER FACTURAS A CRÉDITO POR RANGO DE FECHAS
// REUTILIZABLE PARA MES Y AÑO
// ============================================================

async function getAdmCloudCreditInvoicesByRange({
    dateFrom,
    dateTo,
    periodLabel
}) {

    const startedAt = Date.now();

    const allInvoices = [];
    const seenIds = new Set();

    let skip = 0;
    let page = 0;
    let paginationCompleted = false;

    try {

        // ====================================================
        // 1. INICIAR CONSULTA
        // ====================================================

        logDetails("");
        logDetails("🟪🟪🟪 ========================================");
        logDetails("🧾 ADM CLOUD - FACTURAS A CRÉDITO");
        logDetails("🟪🟪🟪 ========================================");

        logDetails("📅 PERÍODO:", periodLabel);
        logDetails("📅 DESDE:", dateFrom);
        logDetails("📅 HASTA:", dateTo);
        logDetails("🌐 ENDPOINT:", INVOICE_ENDPOINT);

        // ====================================================
        // 2. RECORRER TODAS LAS PÁGINAS
        // ====================================================

        while (page < MAX_PAGES) {

            page++;

            logDetails("");
            logDetails("🟨 ========================================");
            logDetails("📄 PÁGINA:", page);
            logDetails("📌 SKIP:", skip);

            // =================================================
            // 3. CONSULTAR ADM CLOUD
            // =================================================

            const response = await admcloudClient.get(
                INVOICE_ENDPOINT,
                {
                    params: {
                        skip,
                        DateFrom: dateFrom,
                        DateTo: dateTo
                    },

                    timeout: 60000
                }
            );

            logDetails(
                "🌐 HTTP STATUS:",
                response.status
            );

            // =================================================
            // 4. VALIDAR RESPUESTA
            // =================================================

            const result = response.data;

            if (result?.success === false) {

                throw new Error(
                    result.message ||
                    "Adm Cloud devolvió success=false."
                );
            }

            const responseData =
                result?.data ?? result;

            const invoices =
                extractCreditInvoices(responseData);

            logDetails(
                "🧾 FACTURAS EN ESTA PÁGINA:",
                invoices.length
            );

            // =================================================
            // 5. FINAL DE PAGINACIÓN
            // =================================================

            if (invoices.length === 0) {

                paginationCompleted = true;

                logDetails(
                    "✅ No hay más facturas por consultar."
                );

                break;
            }

            // =================================================
            // 6. ACUMULAR FACTURAS SIN DUPLICADOS
            // =================================================

            let newCount = 0;

            for (const invoice of invoices) {

                const id =
                    invoice?.ID ??
                    invoice?.Id ??
                    invoice?.id;

                if (id == null) {

                    throw new Error(
                        "Adm Cloud devolvió una factura sin ID."
                    );
                }

                const key = String(id).toLowerCase();

                if (seenIds.has(key)) {
                    continue;
                }

                seenIds.add(key);

                allInvoices.push(invoice);
                newCount++;

                // =============================================
                // LOG DETALLADO DE CADA FACTURA
                // =============================================

                logDetails(
                    "📋 FACTURA A CRÉDITO:",
                    {
                        ID: id,
                        DocID: invoice.DocID,
                        DocDate: invoice.DocDate,
                        NCF: invoice.NCF,
                        RelationshipID: invoice.RelationshipID,
                        RelationshipName: invoice.RelationshipName,
                        LocationID: invoice.LocationID,
                        LocationName: invoice.LocationName,
                        Reference: invoice.Reference,
                        Status: invoice.Status,
                        StatusDesc: invoice.StatusDesc,
                        Void: invoice.Void,
                        TotalAmount: invoice.TotalAmount,
                        CreationDate: invoice.CreationDate
                    }
                );

            }

            // =================================================
            // 7. VALIDAR AVANCE
            // =================================================

            logDetails(
                "➕ FACTURAS NUEVAS EN PÁGINA:",
                newCount
            );

            logDetails(
                "📊 TOTAL ACUMULADO:",
                allInvoices.length
            );

            if (newCount === 0) {

                throw new Error(
                    "La paginación de CreditInvoices no avanzó. " +
                    "Se recibieron únicamente IDs repetidos."
                );
            }

            // =================================================
            // 8. SIGUIENTE PÁGINA
            // =================================================

            skip += invoices.length;

        }

        // ====================================================
        // 9. VALIDAR PAGINACIÓN COMPLETA
        // ====================================================

        if (!paginationCompleted) {

            throw new Error(
                "Se alcanzó MAX_PAGES. " +
                "La consulta de facturas podría estar incompleta."
            );
        }

        // ====================================================
        // 10. RESULTADO FINAL
        // ====================================================

        const durationSeconds = Number(
            ((Date.now() - startedAt) / 1000).toFixed(2)
        );

        logDetails("");
        logDetails("🟩🟩🟩 ========================================");
        logDetails("✅ CONSULTA DE FACTURAS COMPLETADA");
        logDetails("📅 PERÍODO:", periodLabel);
        logDetails("🧾 TOTAL FACTURAS:", allInvoices.length);
        logDetails("📄 PÁGINAS CONSULTADAS:", page);
        logDetails("⏱️ DURACIÓN:", durationSeconds, "segundos");
        logDetails("🟩🟩🟩 ========================================");
        logDetails("");

        return {
            success: true,
            period: periodLabel,
            dateFrom,
            dateTo,
            total: allInvoices.length,
            pages: page,
            durationSeconds,
            invoices: allInvoices
        };

    } catch (error) {

        logDetails("");
        logDetails("🟥🟥🟥 ========================================");
        logDetails("❌ ERROR CONSULTANDO CREDIT INVOICES");
        logDetails("📅 PERÍODO:", periodLabel);
        logDetails("📄 MENSAJE:", error.message);
        logDetails("🌐 STATUS:", error.status ?? error.response?.status);
        logDetails("🧾 FACTURAS RECUPERADAS:", allInvoices.length);
        logDetails("📄 PÁGINAS INTENTADAS:", page);
        logDetails("🟥🟥🟥 ========================================");
        logDetails("");

        throw error;
    }
}


// ============================================================
// OBTENER FACTURAS A CRÉDITO DEL MES ACTUAL
// ============================================================

export async function getAdmCloudCurrentMonthCreditInvoices() {

    return getAdmCloudCreditInvoicesByRange({
        ...getCurrentMonthDates(),
        periodLabel: "MES ACTUAL"
    });

}


// ============================================================
// OBTENER FACTURAS A CRÉDITO DEL AÑO ACTUAL
// ============================================================

export async function getAdmCloudCurrentYearCreditInvoices() {

    return getAdmCloudCreditInvoicesByRange({
        ...getCurrentYearDates(),
        periodLabel: "AÑO ACTUAL"
    });

}


// ============================================================
// MAPEAR FACTURA ADM CLOUD -> erp_invoices
// ============================================================

function mapCreditInvoiceForDatabase(invoice) {

    if (!invoice || typeof invoice !== "object") {

        throw new Error(
            "Adm Cloud devolvió una factura inválida."
        );
    }

    // ========================================================
    // VALIDAR ERP ID
    // ========================================================

    const erpId =
        invoice.ID ??
        invoice.Id ??
        invoice.id;

    const uuidRegex =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    if (
        typeof erpId !== "string" ||
        !uuidRegex.test(erpId)
    ) {

        throw new Error(
            `Factura sin ID UUID válido: ${
                invoice.DocID ?? "(sin número)"
            }`
        );
    }

    // ========================================================
    // NORMALIZAR CAMPOS OPCIONALES
    // ========================================================

    const invoiceStatus =
        invoice.Status == null
            ? null
            : String(invoice.Status);

    // Si Void no viene en el listado, guardar NULL
    // en lugar de asumir que la factura no está anulada.

    const isVoid =
        invoice.Void == null
            ? null
            : (
                invoice.Void === true ||
                invoice.Void === 1 ||
                String(invoice.Void).toLowerCase() === "true" ||
                String(invoice.Void) === "1"
            );

    // ========================================================
    // MAPEAR DATOS
    // ========================================================

    return {

        erp_id: erpId,

        erp_numero:
            invoice.DocID ?? null,

        erp_fecha:
            invoice.DocDate
                ? String(invoice.DocDate).slice(0, 10)
                : null,

        erp_ncf:
            invoice.NCF ?? null,

        erp_cliente_id:
            invoice.RelationshipID ?? null,

        erp_cliente:
            invoice.RelationshipName ?? null,

        erp_ubicacion_id:
            invoice.LocationID ?? null,

        erp_ubicacion:
            invoice.LocationName ?? null,

        erp_referencia:
            invoice.Reference ?? null,

        erp_estado:
            invoiceStatus,

        erp_estado_descripcion:
            invoice.StatusDesc ?? null,

        erp_anulado:
            isVoid,

        erp_total:
            invoice.TotalAmount ?? null,

        erp_fecha_creacion:
            invoice.CreationDate
                ? String(invoice.CreationDate).slice(0, 26)
                : null,

        erp_tipo_documento:
            invoice.DocType == null
                ? "CREDIT_INVOICE"
                : String(invoice.DocType),

        // Se conserva la respuesta completa del ERP.
        // Es útil si encontramos campos adicionales.

        erp_raw_data:
            invoice

    };

}


// ============================================================
// UPSERT MASIVO DE FACTURAS A CRÉDITO
// ============================================================

const UPSERT_CREDIT_INVOICES_SQL = `

    INSERT INTO erp_invoices (

        erp_id,
        erp_numero,
        erp_fecha,
        erp_ncf,

        erp_cliente_id,
        erp_cliente,

        erp_ubicacion_id,
        erp_ubicacion,

        erp_referencia,

        erp_estado,
        erp_estado_descripcion,

        erp_anulado,
        erp_total,

        erp_fecha_creacion,
        erp_tipo_documento,

        erp_raw_data,
        last_synced_at

    )

    SELECT

        incoming.erp_id,
        incoming.erp_numero,
        incoming.erp_fecha,
        incoming.erp_ncf,

        incoming.erp_cliente_id,
        incoming.erp_cliente,

        incoming.erp_ubicacion_id,
        incoming.erp_ubicacion,

        incoming.erp_referencia,

        incoming.erp_estado,
        incoming.erp_estado_descripcion,

        incoming.erp_anulado,
        incoming.erp_total,

        incoming.erp_fecha_creacion,
        incoming.erp_tipo_documento,

        incoming.erp_raw_data,
        NOW()

    FROM jsonb_to_recordset($1::jsonb) AS incoming (

        erp_id UUID,
        erp_numero VARCHAR(100),
        erp_fecha DATE,
        erp_ncf VARCHAR(100),

        erp_cliente_id UUID,
        erp_cliente TEXT,

        erp_ubicacion_id UUID,
        erp_ubicacion TEXT,

        erp_referencia TEXT,

        erp_estado TEXT,
        erp_estado_descripcion TEXT,

        erp_anulado BOOLEAN,
        erp_total NUMERIC(18, 2),

        erp_fecha_creacion TIMESTAMP,
        erp_tipo_documento VARCHAR(50),

        erp_raw_data JSONB

    )

    WHERE TRUE

    ON CONFLICT (erp_id)

    DO UPDATE SET

        erp_numero =
            EXCLUDED.erp_numero,

        erp_fecha =
            EXCLUDED.erp_fecha,

        erp_ncf =
            EXCLUDED.erp_ncf,

        erp_cliente_id =
            EXCLUDED.erp_cliente_id,

        erp_cliente =
            EXCLUDED.erp_cliente,

        erp_ubicacion_id =
            EXCLUDED.erp_ubicacion_id,

        erp_ubicacion =
            EXCLUDED.erp_ubicacion,

        erp_referencia =
            EXCLUDED.erp_referencia,

        erp_estado =
            EXCLUDED.erp_estado,

        erp_estado_descripcion =
            EXCLUDED.erp_estado_descripcion,

        erp_anulado =
            EXCLUDED.erp_anulado,

        erp_total =
            EXCLUDED.erp_total,

        erp_fecha_creacion =
            EXCLUDED.erp_fecha_creacion,

        erp_tipo_documento =
            EXCLUDED.erp_tipo_documento,

        erp_raw_data =
            EXCLUDED.erp_raw_data,

        updated_at = NOW(),

        last_synced_at = NOW()

    RETURNING erp_id;

`;


// ============================================================
// SINCRONIZAR FACTURAS A CRÉDITO POR PERÍODO
// REUTILIZABLE PARA MES Y AÑO
// ============================================================

async function syncAdmCloudCreditInvoices(
    getInvoices,
    periodLabel
) {

    const startedAt = Date.now();

    let client = null;

    let lockAcquired = false;
    let transactionStarted = false;
    let discardClient = false;

    let inserted = 0;
    let updated = 0;
    let processed = 0;

    let dateFrom = null;
    let dateTo = null;
    let pages = 0;
    let total = 0;

    try {

        // ====================================================
        // 1. INICIAR SINCRONIZACIÓN
        // ====================================================

        logDetails("");
        logDetails("🟪🟪🟪 ========================================");
        logDetails("🔄 SINCRONIZANDO FACTURAS A CRÉDITO");
        logDetails("📅 PERÍODO:", periodLabel);
        logDetails("🗄️ TABLA: erp_invoices");
        logDetails("🟪🟪🟪 ========================================");

        // ====================================================
        // 2. OBTENER CONEXIÓN POSTGRESQL
        // ====================================================

        client = await db.connect();

        // ====================================================
        // 3. ADQUIRIR BLOQUEO ENTRE PROCESOS
        // ====================================================

        // Este bloqueo es de sesión PostgreSQL.
        // Permite proteger tanto la consulta a Adm Cloud
        // como el guardado en erp_invoices.

        const lockResult = await client.query(
            INVOICE_LOCK_SQL
        );

        if (!lockResult.rows[0].acquired) {

            logDetails(
                "⏭️ FACTURAS SYNC OMITIDA:",
                "otra sincronización de facturas está ejecutándose."
            );

            return {
                success: true,
                skipped: true,
                reason: "another_invoice_sync_in_progress",
                period: periodLabel,
                inserted: 0,
                updated: 0,
                processed: 0
            };
        }

        lockAcquired = true;

        logDetails(
            "🔒 BLOQUEO DE FACTURAS ADQUIRIDO"
        );

        // ====================================================
        // 4. OBTENER FACTURAS DE ADM CLOUD
        // ====================================================

        const apiResult = await getInvoices();

        const invoices = apiResult.invoices;

        dateFrom = apiResult.dateFrom;
        dateTo = apiResult.dateTo;
        pages = apiResult.pages;
        total = invoices.length;

        logDetails(
            "📅 RANGO:",
            `${dateFrom} a ${dateTo}`
        );

        logDetails(
            "🧾 FACTURAS RECUPERADAS:",
            total
        );

        logDetails(
            "📄 PÁGINAS:",
            pages
        );

        // ====================================================
        // 5. MAPEAR FACTURAS
        // ====================================================

        const mapped = invoices.map(
            mapCreditInvoiceForDatabase
        );

        // ====================================================
        // 6. VALIDAR QUE NO HAYA IDs DUPLICADOS
        // ====================================================

        const uniqueIds = new Set(
            mapped.map(
                row => row.erp_id.toLowerCase()
            )
        );

        if (uniqueIds.size !== mapped.length) {

            throw new Error(
                "Se encontraron IDs duplicados en CreditInvoices."
            );
        }

        // ====================================================
        // 7. INICIAR TRANSACCIÓN
        // ====================================================

        await client.query("BEGIN");

        transactionStarted = true;

        logDetails(
            "🗄️ TRANSACCIÓN POSTGRESQL INICIADA"
        );

        // ====================================================
        // 8. PROCESAR POR LOTES
        // ====================================================

        for (
            let offset = 0;
            offset < mapped.length;
            offset += INVOICE_SYNC_BATCH_SIZE
        ) {

            const batch = mapped.slice(
                offset,
                offset + INVOICE_SYNC_BATCH_SIZE
            );

            const batchNumber =
                Math.floor(
                    offset / INVOICE_SYNC_BATCH_SIZE
                ) + 1;

            const batchIds = batch.map(
                row => row.erp_id
            );

            logDetails("");
            logDetails("🟨 ========================================");
            logDetails("📦 LOTE DE FACTURAS:", batchNumber);
            logDetails("🧾 CANTIDAD:", batch.length);

            // =================================================
            // 9. IDENTIFICAR FACTURAS EXISTENTES
            // =================================================

            const existingResult = await client.query(
                `
                    SELECT
                        erp_id::text AS erp_id
                    FROM erp_invoices
                    WHERE erp_id = ANY($1::uuid[])
                `,
                [batchIds]
            );

            const existingIds = new Set(
                existingResult.rows.map(
                    row => row.erp_id.toLowerCase()
                )
            );

            logDetails(
                "🔎 FACTURAS EXISTENTES:",
                existingIds.size
            );

            // =================================================
            // 10. INSERT / UPDATE
            // =================================================

            const saveResult = await client.query(
                UPSERT_CREDIT_INVOICES_SQL,
                [JSON.stringify(batch)]
            );

            if (saveResult.rowCount !== batch.length) {

                throw new Error(
                    `Error guardando lote ${batchNumber}. ` +
                    `Esperados: ${batch.length}. ` +
                    `Guardados: ${saveResult.rowCount}.`
                );
            }

            // =================================================
            // 11. CONTABILIZAR Y MOSTRAR DETALLE
            // =================================================

            for (const invoice of batch) {

                const wasExisting = existingIds.has(
                    invoice.erp_id.toLowerCase()
                );

                if (wasExisting) {
                    updated++;
                } else {
                    inserted++;
                }

                processed++;

                logDetails(
                    wasExisting
                        ? "🔁 FACTURA ACTUALIZADA:"
                        : "🆕 FACTURA INSERTADA:",
                    {
                        erp_id: invoice.erp_id,
                        erp_numero: invoice.erp_numero,
                        erp_fecha: invoice.erp_fecha,
                        erp_ncf: invoice.erp_ncf,
                        erp_cliente: invoice.erp_cliente,
                        erp_ubicacion: invoice.erp_ubicacion,
                        erp_total: invoice.erp_total,
                        erp_estado: invoice.erp_estado,
                        erp_anulado: invoice.erp_anulado
                    }
                );
            }

            logDetails(
                "✅ LOTE GUARDADO:",
                saveResult.rowCount
            );

            logDetails(
                "📊 PROGRESO:",
                `${processed}/${mapped.length}`
            );

        }

        // ====================================================
        // 12. CONFIRMAR TRANSACCIÓN
        // ====================================================

        await client.query("COMMIT");

        transactionStarted = false;

        // ====================================================
        // 13. RESUMEN
        // ====================================================

        const durationSeconds = Number(
            ((Date.now() - startedAt) / 1000).toFixed(2)
        );

        logDetails("");
        logDetails("🟩🟩🟩 ========================================");
        logDetails("✅ FACTURAS SINCRONIZADAS CORRECTAMENTE");
        logDetails("📅 PERÍODO:", periodLabel);
        logDetails("📅 DESDE:", dateFrom);
        logDetails("📅 HASTA:", dateTo);
        logDetails("🧾 TOTAL RECUPERADAS:", total);
        logDetails("🆕 INSERTADAS:", inserted);
        logDetails("🔁 ACTUALIZADAS:", updated);
        logDetails("📊 PROCESADAS:", processed);
        logDetails("📄 PÁGINAS:", pages);
        logDetails("⏱️ DURACIÓN:", durationSeconds, "segundos");
        logDetails("🟩🟩🟩 ========================================");
        logDetails("");

        return {
            success: true,
            skipped: false,
            period: periodLabel,
            dateFrom,
            dateTo,
            total,
            inserted,
            updated,
            processed,
            pages,
            durationSeconds
        };

    } catch (error) {

        // ====================================================
        // 14. ROLLBACK SI OCURRE ERROR
        // ====================================================

        if (client && transactionStarted) {

            try {

                await client.query("ROLLBACK");

                transactionStarted = false;

                logDetails(
                    "↩️ ROLLBACK: cambios de esta ejecución revertidos."
                );

            } catch (rollbackError) {

                discardClient = true;

                logDetails(
                    "❌ ERROR EN ROLLBACK:",
                    rollbackError.message
                );
            }
        }

        // ====================================================
        // 15. ERROR DETALLADO
        // ====================================================

        logDetails("");
        logDetails("🟥🟥🟥 ========================================");
        logDetails("❌ ERROR SINCRONIZANDO FACTURAS");
        logDetails("📅 PERÍODO:", periodLabel);
        logDetails("📄 MENSAJE:", error.message);
        logDetails("🗄️ PG CODE:", error.code ?? null);
        logDetails("🗄️ PG DETAIL:", error.detail ?? null);
        logDetails("🌐 HTTP STATUS:", error.status ?? error.response?.status);
        logDetails("📊 PROCESADAS ANTES DEL ERROR:", processed);
        logDetails("🟥🟥🟥 ========================================");
        logDetails("");

        throw error;

    } finally {

        // ====================================================
        // 16. LIBERAR BLOQUEO Y CONEXIÓN
        // ====================================================

        if (client) {

            if (lockAcquired && !discardClient) {

                try {

                    const unlockResult = await client.query(
                        INVOICE_UNLOCK_SQL
                    );

                    if (!unlockResult.rows[0].released) {

                        discardClient = true;

                        logDetails(
                            "⚠️ No se confirmó la liberación del bloqueo."
                        );

                    } else {

                        logDetails(
                            "🔓 BLOQUEO FACTURAS LIBERADO"
                        );
                    }

                } catch (unlockError) {

                    discardClient = true;

                    logDetails(
                        "❌ ERROR LIBERANDO BLOQUEO:",
                        unlockError.message
                    );
                }
            }

            // Si la conexión está dañada o el bloqueo
            // no pudo liberarse, eliminarla del pool.

            client.release(discardClient);
        }
    }
}


// ============================================================
// SINCRONIZAR FACTURAS A CRÉDITO DEL MES ACTUAL
// ============================================================

export async function syncAdmCloudCurrentMonthCreditInvoices() {

    return syncAdmCloudCreditInvoices(
        getAdmCloudCurrentMonthCreditInvoices,
        "MES ACTUAL"
    );

}


// ============================================================
// SINCRONIZAR FACTURAS A CRÉDITO DEL AÑO ACTUAL
// ============================================================

export async function syncAdmCloudCurrentYearCreditInvoices() {

    return syncAdmCloudCreditInvoices(
        getAdmCloudCurrentYearCreditInvoices,
        "AÑO ACTUAL"
    );

}



// ============================================================
// OBTENER FACTURA A CRÉDITO COMPLETA POR GUID
//
// ADM CLOUD:
//
// GET /CreditInvoices/{ID}
//
// Devuelve:
//
// - Encabezado completo
// - Detalles completos
// - Cualquier otro campo enviado por ADM Cloud
//
// NO se mapea.
// NO se modifica.
// Se devuelve la factura completa.
// ============================================================

export async function getAdmCloudCreditInvoiceById(
    invoiceId
) {

    const startedAt =
        Date.now();


    try {

        // ====================================================
        // 1. NORMALIZAR ID
        // ====================================================

        const cleanInvoiceId =
            String(
                invoiceId ?? ""
            ).trim();


        logDetails("");

        logDetails(
            "🟪🟪🟪 ========================================"
        );

        logDetails(
            "🧾 ADM CLOUD - OBTENER FACTURA POR GUID"
        );

        logDetails(
            "🟪🟪🟪 ========================================"
        );

        logDetails(
            "🆔 GUID:",
            cleanInvoiceId
        );


        // ====================================================
        // 2. VALIDAR QUE VENGA EL ID
        // ====================================================

        if (
            !cleanInvoiceId
        ) {

            const error =
                new Error(
                    "El GUID de la factura es requerido."
                );


            error.statusCode =
                400;


            throw error;

        }


        // ====================================================
        // 3. VALIDAR UUID / GUID
        // ====================================================

        const uuidRegex =
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


        if (
            !uuidRegex.test(
                cleanInvoiceId
            )
        ) {

            const error =
                new Error(
                    `GUID de factura inválido: ${cleanInvoiceId}`
                );


            error.statusCode =
                400;


            throw error;

        }


        // ====================================================
        // 4. CONSTRUIR ENDPOINT
        //
        // Ejemplo:
        //
        // /CreditInvoices/
        // d85133b5-6c22-4934-8212-012345678901
        // ====================================================

        const endpoint =
            `${INVOICE_ENDPOINT}/${encodeURIComponent(
                cleanInvoiceId
            )}`;


        logDetails(
            "🌐 ENDPOINT:",
            endpoint
        );


        // ====================================================
        // 5. CONSULTAR ADM CLOUD
        // ====================================================

        const response =
            await admcloudClient.get(
                endpoint,
                {

                    timeout:
                        60000,

                }
            );


        logDetails(
            "🌐 HTTP STATUS:",
            response.status
        );


        // ====================================================
        // 6. RESPUESTA ADM CLOUD
        // ====================================================

        const result =
            response.data;


        logDetails(
            "📥 RESPUESTA COMPLETA ADM CLOUD:",
            result
        );


        // ====================================================
        // 7. VALIDAR SUCCESS
        // ====================================================

        if (
            result?.success ===
            false
        ) {

            const error =
                new Error(
                    result?.message ||
                    "Adm Cloud no pudo obtener la factura."
                );


            error.statusCode =
                400;


            throw error;

        }


        // ====================================================
        // 8. EXTRAER FACTURA
        //
        // La documentación indica:
        //
        // {
        //    success,
        //    message,
        //    data
        // }
        //
        // data contiene:
        //
        // encabezado
        // +
        // detalles
        // ====================================================

        const invoice =
            result?.data ??
            result;


        // ====================================================
        // 9. VALIDAR FACTURA
        // ====================================================

        if (
            !invoice ||
            typeof invoice !==
                "object" ||
            Array.isArray(
                invoice
            )
        ) {

            throw new Error(
                "Adm Cloud no devolvió una factura válida."
            );

        }


        // ====================================================
        // 10. MOSTRAR DATOS PRINCIPALES
        // ====================================================

        logDetails("");

        logDetails(
            "🧾 FACTURA ENCONTRADA:"
        );


        logDetails(
            {

                ID:
                    invoice.ID ??
                    invoice.Id ??
                    invoice.id,

                DocID:
                    invoice.DocID,

                Reference:
                    invoice.Reference,

                DocDate:
                    invoice.DocDate,

                NCF:
                    invoice.NCF,

                RelationshipID:
                    invoice.RelationshipID,

                RelationshipName:
                    invoice.RelationshipName,

                LocationID:
                    invoice.LocationID,

                LocationName:
                    invoice.LocationName,

                Status:
                    invoice.Status,

                StatusDesc:
                    invoice.StatusDesc,

                TotalAmount:
                    invoice.TotalAmount,

            }
        );


        // ====================================================
        // 11. BUSCAR ARRAY DE DETALLES
        //
        // No estamos asumiendo que necesariamente ADM Cloud
        // lo llama Items.
        //
        // Solo lo usamos para LOG.
        //
        // La factura completa siempre se devuelve intacta.
        // ====================================================

        const details =
            invoice.Items ??
            invoice.items ??
            invoice.Details ??
            invoice.details ??
            invoice.Lines ??
            invoice.lines ??
            invoice.InvoiceDetails ??
            null;


        if (
            Array.isArray(
                details
            )
        ) {

            logDetails(
                "📦 CANTIDAD DE DETALLES:",
                details.length
            );


            logDetails(
                "📦 DETALLES:",
                details
            );

        } else {

            logDetails(
                "ℹ️ No se encontró un array de detalles con los nombres conocidos."
            );


            logDetails(
                "📋 FACTURA COMPLETA:",
                invoice
            );

        }


        // ====================================================
        // 12. DURACIÓN
        // ====================================================

        const durationSeconds =
            Number(
                (
                    (
                        Date.now() -
                        startedAt
                    ) /
                    1000
                ).toFixed(
                    2
                )
            );


        // ====================================================
        // 13. RESULTADO
        // ====================================================

        logDetails("");

        logDetails(
            "🟩🟩🟩 ========================================"
        );

        logDetails(
            "✅ FACTURA OBTENIDA CORRECTAMENTE"
        );

        logDetails(
            "🆔 GUID:",
            cleanInvoiceId
        );

        logDetails(
            "⏱️ DURACIÓN:",
            durationSeconds,
            "segundos"
        );

        logDetails(
            "🟩🟩🟩 ========================================"
        );

        logDetails("");


        // ====================================================
        // IMPORTANTE:
        //
        // invoice se devuelve COMPLETA.
        //
        // No quitamos:
        // - Items
        // - Details
        // - campos adicionales
        // - metadata
        // ====================================================

        return {

            success:
                true,

            message:
                null,

            data:
                invoice,

            durationSeconds,

        };


    } catch (
        error
    ) {

        // ====================================================
        // ERROR
        // ====================================================

        logDetails("");

        logDetails(
            "🟥🟥🟥 ========================================"
        );

        logDetails(
            "❌ ERROR OBTENIENDO FACTURA POR GUID"
        );

        logDetails(
            "🆔 GUID:",
            invoiceId
        );

        logDetails(
            "📄 MESSAGE:",
            error.message
        );

        logDetails(
            "🌐 HTTP STATUS:",
            error.statusCode ??
            error.response?.status ??
            null
        );

        logDetails(
            "📥 ADM CLOUD ERROR:",
            error.response?.data ??
            null
        );

        logDetails(
            "🟥🟥🟥 ========================================"
        );

        logDetails("");


        throw error;

    }

}