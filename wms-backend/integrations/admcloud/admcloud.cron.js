
// ============================================================
// FILE: integrations/admcloud/admcloud.cron.js
// ============================================================

import cron from "node-cron";

import {
    getAdmCloudProducts
} from "./admcloud.items.js";

import {
    syncAdmCloudProducts
} from "./admcloud.products.processor.js";

import {
    syncAdmCloudWarehouses
} from "./admcloud.locations.js";

import {
    syncAdmCloudUoms
} from "./admcloud.uom.service.js";

import {
    runAdmCloudPurchaseOrdersSync
} from "./admcloud.purchaseOrders.js";

import {
    runAdmCloudSalesOrdersSync
} from "./admcloud.salesOrders.js";

import {
    syncAdmCloudCurrentMonthDispatches,
    syncAdmCloudCurrentYearDispatches,
    syncAdmCloudCurrentMonthCreditInvoices,
    syncAdmCloudCurrentYearCreditInvoices
} from "./admcloud_inspeccion.js";


// ============================================================
// CONFIGURACIÓN GENERAL
// ============================================================

const TIME_ZONE = "America/Santo_Domingo";


// ============================================================
// CONSOLE LOG - FONDO MORADO CLARO PARA INSPECCIÓN
// ============================================================

const PURPLE_BG = "\x1b[48;2;235;218;255m";
const PURPLE_TEXT = "\x1b[38;2;68;30;96m";
const RESET_COLOR = "\x1b[0m";

function formatPurpleArgs(args) {

    return args.map((value) => {

        if (typeof value === "string") {
            return value;
        }

        if (value instanceof Error) {
            return value.stack || value.message;
        }

        if (value === undefined) {
            return "undefined";
        }

        try {

            return JSON.stringify(value, null, 2);

        } catch {

            return String(value);

        }

    }).join(" ");

}

function purpleLog(...args) {

    console.log(
        `${PURPLE_BG}${PURPLE_TEXT}${formatPurpleArgs(args)}${RESET_COLOR}`
    );

}

function purpleError(...args) {

    console.error(
        `${PURPLE_BG}${PURPLE_TEXT}${formatPurpleArgs(args)}${RESET_COLOR}`
    );

}


// ============================================================
// OBTENER HORA LOCAL DE REPÚBLICA DOMINICANA
// ============================================================

function getDominicanTime() {

    const parts = new Intl.DateTimeFormat("en-US", {

        timeZone: TIME_ZONE,

        hour: "2-digit",

        minute: "2-digit",

        hourCycle: "h23"

    }).formatToParts(new Date());

    const getPart = (type) =>
        parts.find((part) => part.type === type)?.value;

    return {

        hour: Number(getPart("hour")),

        minute: Number(getPart("minute"))

    };

}


// ============================================================
// IDENTIFICAR MINUTOS RESERVADOS PARA EL CRON ANUAL
//
// CONDUCES:
// 2:00 AM / 2:20 AM / 2:40 AM
//
// FACTURAS A CRÉDITO:
// 2:10 AM / 2:30 AM / 2:50 AM
// ============================================================

function isAnnualInspectionTime(group) {

    const { hour, minute } = getDominicanTime();

    if (hour !== 2) {
        return false;
    }

    return group.annualMinutes.includes(minute);

}


// ============================================================
// SINCRONIZACIÓN GENERAL ADM CLOUD
// ============================================================

export async function syncAdmCloud() {

    console.log("");

    console.log(
        "🔄 ========================================"
    );

    console.log(
        "🔄 INICIANDO SYNC GENERAL ADM CLOUD"
    );

    console.log(
        "🕒",
        new Date().toISOString()
    );

    console.log(
        "🔄 ========================================"
    );


    // ========================================================
    // 1. UOM
    // ========================================================

    console.log("");

    console.log(
        "📏 SINCRONIZANDO UOM..."
    );

    const uomResult =
        await syncAdmCloudUoms();

    console.log(
        "✅ UOM sincronizados:",
        uomResult
    );


    // ========================================================
    // 2. WAREHOUSES / LOCATIONS
    // ========================================================

    console.log("");

    console.log(
        "🏭 SINCRONIZANDO WAREHOUSES..."
    );

    const warehouseResult =
        await syncAdmCloudWarehouses();

    console.log(
        "✅ Warehouses sincronizados:",
        warehouseResult
    );


    // ========================================================
    // 3. PRODUCTS
    // ========================================================

    console.log("");

    console.log(
        "📦 SINCRONIZANDO PRODUCTOS..."
    );

    const products =
        await getAdmCloudProducts();

    const productResult =
        await syncAdmCloudProducts(products);

    console.log(
        `✅ Productos sincronizados: ${products.length}`
    );


    // ========================================================
    // 4. PURCHASE ORDERS
    // ========================================================

    console.log("");

    console.log(
        "🧾 SINCRONIZANDO PURCHASE ORDERS..."
    );

    const purchaseOrderResult =
        await runAdmCloudPurchaseOrdersSync();

    console.log(
        "✅ Purchase Orders sincronizadas:",
        purchaseOrderResult
    );


    // ========================================================
    // FINAL
    // ========================================================

    console.log("");

    console.log(
        "✅ ========================================"
    );

    console.log(
        "✅ SYNC GENERAL ADM CLOUD COMPLETADO"
    );

    console.log(
        "✅ ========================================"
    );

    return {

        uom: uomResult,

        warehouses: warehouseResult,

        products: {

            total: products.length,

            result: productResult

        },

        purchaseOrders: purchaseOrderResult

    };

}


// ============================================================
// CONTROLES DE EJECUCIÓN
// ============================================================

let isSyncRunning = false;

let salesOrdersSyncRunning = false;

let admCloudCronStarted = false;


// ============================================================
// GRUPOS DE INSPECCIÓN
//
// CADA GRUPO TIENE:
//
// 1. TABLA
// 2. SERVICIO MENSUAL
// 3. SERVICIO ANUAL
// 4. CONTROL DE EJECUCIÓN
// 5. HORARIOS ANUALES
// ============================================================

const inspectionGroups = {

    // ========================================================
    // CONDUCES
    // ========================================================

    dispatches: {

        label: "CONDUCES",

        table: "erp_dispatches",

        active: null,

        pendingAnnual: false,

        // 2:00 / 2:20 / 2:40 AM
        annualMinutes: [0, 20, 40],

        annualCron: "0,20,40 2 * * *",

        syncMonth: syncAdmCloudCurrentMonthDispatches,

        syncYear: syncAdmCloudCurrentYearDispatches

    },


    // ========================================================
    // FACTURAS A CRÉDITO
    // ========================================================

    invoices: {

        label: "FACTURAS A CRÉDITO",

        table: "erp_invoices",

        active: null,

        pendingAnnual: false,

        // 2:10 / 2:30 / 2:50 AM
        annualMinutes: [10, 30, 50],

        annualCron: "10,30,50 2 * * *",

        syncMonth: syncAdmCloudCurrentMonthCreditInvoices,

        syncYear: syncAdmCloudCurrentYearCreditInvoices

    }

};


// ============================================================
// EJECUTOR GENERAL DE SINCRONIZACIÓN DE INSPECCIÓN
//
// SIRVE PARA:
//
// - CONDUCES MENSUALES
// - CONDUCES ANUALES
// - FACTURAS MENSUALES
// - FACTURAS ANUALES
// ============================================================

async function executeInspectionSync(group, period) {

    // ========================================================
    // 1. EVITAR DOS SINCRONIZACIONES SIMULTÁNEAS
    // DEL MISMO TIPO DE DOCUMENTO
    // ========================================================

    if (group.active !== null) {

        // ====================================================
        // SI LLEGA EL ANUAL MIENTRAS CORRE EL MENSUAL,
        // PROGRAMARLO PARA EJECUTARSE AL TERMINAR.
        // ====================================================

        if (
            period === "ANUAL" &&
            group.active === "MENSUAL"
        ) {

            group.pendingAnnual = true;

            purpleLog(
                `📌 ${group.label} ANUAL EN ESPERA:`,
                "se ejecutará al finalizar el mensual.",
                "Siempre que siga siendo la hora 2 AM."
            );

            return;
        }

        purpleLog(
            `⏭️ ${group.label} SYNC OMITIDO:`,
            {
                solicitado: period,
                ejecutandose: group.active
            }
        );

        return;
    }


    // ========================================================
    // 2. ACTIVAR CONTROL DE SINCRONIZACIÓN
    // ========================================================

    group.active = period;

    const startedAt = Date.now();

    purpleLog("");

    purpleLog(
        "🟪🟪🟪 ========================================"
    );

    purpleLog(
        `🚀 CRON ADM CLOUD: ${group.label} ${period}`
    );

    purpleLog(
        "🕒 FECHA:",
        new Date().toISOString()
    );

    purpleLog(
        "🌎 TIMEZONE:",
        TIME_ZONE
    );

    purpleLog(
        "🗄️ TABLA:",
        group.table
    );

    purpleLog(
        "🟪🟪🟪 ========================================"
    );


    try {

        // ====================================================
        // 3. SELECCIONAR SERVICIO
        // ====================================================

        const syncFunction =
            period === "ANUAL"
                ? group.syncYear
                : group.syncMonth;


        // ====================================================
        // 4. EJECUTAR SINCRONIZACIÓN
        // ====================================================

        const result = await syncFunction();


        // ====================================================
        // 5. VALIDAR SI FUE OMITIDO POR BLOQUEO
        // ====================================================

        if (result?.skipped) {

            purpleLog(
                `⏭️ ${group.label} ${period} OMITIDO:`,
                result.reason
            );

            return;
        }


        // ====================================================
        // 6. VALIDAR RESULTADO
        // ====================================================

        if (!result || result.success !== true) {

            throw new Error(
                `El servicio de ${group.label} ${period} no confirmó éxito.`
            );

        }


        // ====================================================
        // 7. CALCULAR DURACIÓN
        // ====================================================

        const durationSeconds = (
            (Date.now() - startedAt) / 1000
        ).toFixed(2);


        // ====================================================
        // 8. MOSTRAR RESUMEN EN MORADO
        // ====================================================

        purpleLog("");

        purpleLog(
            "🟪🟪🟪 ========================================"
        );

        purpleLog(
            `✅ ${group.label} ${period} SINCRONIZADOS`
        );

        purpleLog(
            "📅 FECHA DESDE:",
            result.dateFrom
        );

        purpleLog(
            "📅 FECHA HASTA:",
            result.dateTo
        );

        purpleLog(
            "📦 TOTAL RECUPERADOS:",
            result.total
        );

        purpleLog(
            "📄 PÁGINAS ADM CLOUD:",
            result.pages
        );

        purpleLog(
            "🆕 INSERTADOS:",
            result.inserted
        );

        purpleLog(
            "🔁 ACTUALIZADOS:",
            result.updated
        );

        purpleLog(
            "📊 PROCESADOS:",
            result.processed
        );

        purpleLog(
            "⏱️ DURACIÓN:",
            `${durationSeconds} segundos`
        );

        purpleLog(
            "🟪🟪🟪 ========================================"
        );

        purpleLog("");


    } catch (error) {

        // ====================================================
        // 9. LOG DETALLADO DE ERROR
        // ====================================================

        purpleError("");

        purpleError(
            "🟪🟪🟪 ========================================"
        );

        purpleError(
            `❌ ERROR CRON ${group.label} ${period}`
        );

        purpleError(
            "📄 MENSAJE:",
            error.message
        );

        purpleError(
            "🔢 CÓDIGO:",
            error.code ?? null
        );

        purpleError(
            "🌐 HTTP STATUS:",
            error.status ?? error.response?.status
        );

        purpleError(
            "📥 DATA:",
            error.data ?? error.response?.data
        );

        purpleError(
            "📋 STACK:",
            error.stack
        );

        purpleError(
            "🟪🟪🟪 ========================================"
        );


    } finally {

        // ====================================================
        // 10. LIBERAR CONTROL
        // ====================================================

        group.active = null;


        // ====================================================
        // 11. EJECUTAR ANUAL PENDIENTE
        // ====================================================

        if (
            period === "MENSUAL" &&
            group.pendingAnnual
        ) {

            group.pendingAnnual = false;

            const { hour } = getDominicanTime();

            if (hour === 2) {

                purpleLog(
                    `🚀 EJECUTANDO ${group.label} ANUAL PENDIENTE...`
                );

                await executeInspectionSync(
                    group,
                    "ANUAL"
                );

            } else {

                purpleLog(
                    `⚠️ ${group.label} ANUAL PENDIENTE OMITIDO:`,
                    "terminó la ventana de las 2 AM."
                );

            }

        }

    }

}


// ============================================================
// INICIAR TODOS LOS CRONS ADM CLOUD
// ============================================================

export function startAdmCloudCron() {

    // ========================================================
    // 0. EVITAR REGISTRAR CRONS DUPLICADOS
    // ========================================================

    if (admCloudCronStarted) {

        console.log(
            "⏭️ Crons Adm Cloud ya fueron iniciados."
        );

        return;
    }

    admCloudCronStarted = true;


    // ========================================================
    // CRON 1 - SINCRONIZACIÓN GENERAL ADM CLOUD
    // CADA 2 MINUTOS
    // ========================================================

    console.log(
        "⏰ Adm Cloud cron general iniciado - cada 2 min"
    );

    cron.schedule(
        "*/2 * * * *",
        async () => {

            if (isSyncRunning) {

                console.log(
                    "⏭️ Adm Cloud sync omitido: ya hay uno ejecutándose"
                );

                return;
            }

            isSyncRunning = true;

            try {

                console.log("");

                console.log(
                    "⏰ Ejecutando sincronización automática Adm Cloud..."
                );

                const result =
                    await syncAdmCloud();

                console.log("");

                console.log(
                    "✅ Cron Adm Cloud terminado correctamente"
                );

                console.log(
                    "📊 Resultado general:",
                    result
                );

            } catch (error) {

                console.error("");

                console.error(
                    "❌ Error en cron Adm Cloud:",
                    error
                );

            } finally {

                isSyncRunning = false;

            }

        }
    );


    // ========================================================
    // CRON 2 - SALES ORDERS ADM CLOUD
    // CADA 30 SEGUNDOS
    // ========================================================

    console.log(
        "⏰ Sales Orders cron iniciado - cada 30 segundos"
    );

    cron.schedule(
        "*/30 * * * * *",
        async () => {

            if (salesOrdersSyncRunning) {

                console.log(
                    "⏭️ Sales Orders Sync omitido: sincronización anterior en ejecución."
                );

                return;
            }

            salesOrdersSyncRunning = true;

            console.log("");

            console.log(
                "=============================================="
            );

            console.log(
                "🚚 CRON ADM CLOUD: SALES ORDERS"
            );

            console.log(
                "🕒 Fecha:",
                new Date().toISOString()
            );

            console.log(
                "=============================================="
            );

            try {

                const result =
                    await runAdmCloudSalesOrdersSync();

                console.log("");

                console.log(
                    "✅ SALES ORDERS SYNC FINALIZADO"
                );

                console.log(
                    "📊 RESUMEN:",
                    {
                        success: result.success,
                        totalReceived: result.totalReceived,
                        totalUnique: result.totalUnique,
                        inserted: result.inserted,
                        updated: result.updated,
                        done: result.done,
                        draft: result.draft,
                        failed: result.failed
                    }
                );

            } catch (error) {

                console.error(
                    "❌ ERROR CRON SALES ORDERS:",
                    {
                        message: error.message,
                        code: error.code,
                        status: error.response?.status,
                        data: error.response?.data,
                        stack: error.stack
                    }
                );

            } finally {

                salesOrdersSyncRunning = false;

            }

        }
    );


    // ========================================================
    // CRON 3 - CONDUCES MENSUALES
    //
    // CADA 1 MINUTO
    //
    // EXCEPTO:
    // 2:00 / 2:20 / 2:40 AM
    // ========================================================

    purpleLog("");

    purpleLog(
        "🟪 CRON CONDUCES MENSUAL REGISTRADO"
    );

    purpleLog(
        "⏰ CADA 1 MINUTO"
    );

    cron.schedule(
        "* * * * *",
        async () => {

            // =================================================
            // VERIFICAR MINUTOS RESERVADOS AL ANUAL
            // =================================================

            if (
                isAnnualInspectionTime(
                    inspectionGroups.dispatches
                )
            ) {

                purpleLog(
                    "⏭️ CONDUCES MENSUAL OMITIDO:",
                    "minuto reservado para el anual."
                );

                return;
            }


            // =================================================
            // EJECUTAR MENSUAL
            // =================================================

            await executeInspectionSync(
                inspectionGroups.dispatches,
                "MENSUAL"
            );

        },
        {
            timezone: TIME_ZONE
        }
    );


    // ========================================================
    // CRON 4 - CONDUCES ANUALES
    //
    // TODOS LOS DÍAS:
    //
    // 2:00 AM
    // 2:20 AM
    // 2:40 AM
    // ========================================================

    purpleLog("");

    purpleLog(
        "🟪 CRON CONDUCES ANUAL REGISTRADO"
    );

    purpleLog(
        "⏰ 2:00 / 2:20 / 2:40 AM"
    );

    cron.schedule(
        inspectionGroups.dispatches.annualCron,
        async () => {

            await executeInspectionSync(
                inspectionGroups.dispatches,
                "ANUAL"
            );

        },
        {
            timezone: TIME_ZONE
        }
    );


    // ========================================================
    // CRON 5 - FACTURAS A CRÉDITO MENSUALES
    //
    // CADA 1 MINUTO
    //
    // EXCEPTO:
    // 2:10 / 2:30 / 2:50 AM
    // ========================================================

    purpleLog("");

    purpleLog(
        "🟪 CRON FACTURAS A CRÉDITO MENSUAL REGISTRADO"
    );

    purpleLog(
        "⏰ CADA 1 MINUTO"
    );

    cron.schedule(
        "* * * * *",
        async () => {

            // =================================================
            // VERIFICAR MINUTOS RESERVADOS AL ANUAL
            // =================================================

            if (
                isAnnualInspectionTime(
                    inspectionGroups.invoices
                )
            ) {

                purpleLog(
                    "⏭️ FACTURAS A CRÉDITO MENSUAL OMITIDO:",
                    "minuto reservado para el anual."
                );

                return;
            }


            // =================================================
            // EJECUTAR MENSUAL
            // =================================================

            await executeInspectionSync(
                inspectionGroups.invoices,
                "MENSUAL"
            );

        },
        {
            timezone: TIME_ZONE
        }
    );


    // ========================================================
    // CRON 6 - FACTURAS A CRÉDITO ANUALES
    //
    // TODOS LOS DÍAS:
    //
    // 2:10 AM
    // 2:30 AM
    // 2:50 AM
    // ========================================================

    purpleLog("");

    purpleLog(
        "🟪 CRON FACTURAS A CRÉDITO ANUAL REGISTRADO"
    );

    purpleLog(
        "⏰ 2:10 / 2:30 / 2:50 AM"
    );

    cron.schedule(
        inspectionGroups.invoices.annualCron,
        async () => {

            await executeInspectionSync(
                inspectionGroups.invoices,
                "ANUAL"
            );

        },
        {
            timezone: TIME_ZONE
        }
    );


    // ========================================================
    // FINAL - RESUMEN DE CRONS REGISTRADOS
    // ========================================================

    console.log("");

    console.log(
        "✅ ========================================"
    );

    console.log(
        "✅ TODOS LOS CRONS ADM CLOUD INICIADOS"
    );

    console.log(
        "✅ ========================================"
    );

    console.log(
        "✅ GENERAL: CADA 2 MINUTOS"
    );

    console.log(
        "✅ SALES ORDERS: CADA 30 SEGUNDOS"
    );

    console.log(
        "✅ CONDUCES MENSUAL: CADA 1 MINUTO"
    );

    console.log(
        "✅ CONDUCES ANUAL: 2:00, 2:20 Y 2:40 AM"
    );

    console.log(
        "✅ FACTURAS MENSUAL: CADA 1 MINUTO"
    );

    console.log(
        "✅ FACTURAS ANUAL: 2:10, 2:30 Y 2:50 AM"
    );

    console.log(
        "✅ TIMEZONE INSPECCIÓN:",
        TIME_ZONE
    );

    console.log(
        "✅ ========================================"
    );

}
