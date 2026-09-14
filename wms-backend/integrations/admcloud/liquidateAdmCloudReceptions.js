// wms-backend/integrations/admcloud/liquidateAdmCloudReceptions.js
import {
    createAdmCloudReception,
    confirmAdmCloudReceptionById,
    updateAdmCloudReception,
    deleteAdmCloudReception
} from "./admcloud.reception.js";


// COLORS
const C = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",

    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    cyan: "\x1b[36m",
    magenta: "\x1b[35m",

    bgRed: "\x1b[41m",
    bgGreen: "\x1b[42m",
    bgYellow: "\x1b[43m",
};



// ERROR PERSONALIZADO
class AdmLiquidationError
    extends Error {

    constructor(
        title,
        code,
        message
    ) {

        super(message);

        this.name =
            "AdmLiquidationError";

        this.title =
            title;

        this.code =
            code;
    }
}




function buildAdmReceptionRestorePayload(
    reception
) {

    if (
        !reception
    ) {

        throw new Error(
            "No existe snapshot de la recepción ADM para restaurar."
        );

    }


    return {

        // ==========================================
        // NÚMERO ORIGINAL
        // ==========================================

        DocID:
            reception.DocID,


        // ==========================================
        // FECHA ORIGINAL
        // ==========================================

        DocDate:
            reception.DocDate
                ? String(
                    reception.DocDate
                ).slice(
                    0,
                    10
                )
                : null,


        // ==========================================
        // REFERENCIA ORIGINAL
        // ==========================================

        Reference:
            reception.Reference ??
            null,


        // ==========================================
        // PROVEEDOR ORIGINAL
        // ==========================================

        RelationshipID:
            reception.RelationshipID ??
            null,


        // ==========================================
        // ALMACÉN ORIGINAL
        // ==========================================

        LocationID:
            reception.LocationID ??
            null,


        // ==========================================
        // NOTAS ORIGINALES
        // ==========================================

        Notes:
            reception.Notes ??
            null,


        // ==========================================
        // LÍNEAS ORIGINALES
        // ==========================================

        Items:
            Array.isArray(
                reception.Items
            )
                ? reception.Items.map(
                    (
                        item,
                        index
                    ) => ({

                        RowOrder:
                            Number(
                                item.RowOrder ??
                                index + 1
                            ),

                        ItemID:
                            item.ItemID,

                        Cost:
                            Number(
                                item.Cost ??
                                0
                            ),

                        Price:
                            Number(
                                item.Price ??
                                0
                            ),

                        Quantity:
                            Number(
                                item.Quantity ??
                                0
                            ),

                        UOMID:
                            item.UOMID ??
                            null,

                        RowType:
                            Number(
                                item.RowType ??
                                0
                            ),

                        EstimatedDeliveryDate:
                            item.EstimatedDeliveryDate
                                ? String(
                                    item.EstimatedDeliveryDate
                                )
                                : "0001-01-01T00:00:00",

                        ExchangeRate:
                            Number(
                                item.ExchangeRate ??
                                0
                            ),

                        WarrantyDays:
                            Number(
                                item.WarrantyDays ??
                                0
                            ),

                        WarrantyUnits:
                            Number(
                                item.WarrantyUnits ??
                                0
                            )

                    })
                )
                : []

    };

}


async function restoreAdmCloudReception({

    receptionId,

    before

}) {

    console.log("");
    console.log(
        "♻️ ========================================"
    );

    console.log(
        "♻️ RESTAURANDO RECEPCIÓN ADM CLOUD"
    );

    console.log(
        "🆔 Reception ID:",
        receptionId
    );

    console.log(
        "♻️ ========================================"
    );


    // ==========================================================
    // CONFIRMAR QUE SIGUE EXISTIENDO
    // ==========================================================

    const confirmation =
        await confirmAdmCloudReceptionById(
            receptionId
        );


    if (
        !confirmation?.exists ||
        !confirmation?.reception
    ) {

        throw new Error(
            `No se puede restaurar la recepción ${receptionId} porque ya no existe en ADM Cloud.`
        );

    }


    // ==========================================================
    // CONSTRUIR DATOS ANTERIORES
    // ==========================================================

    const restorePayload =
        buildAdmReceptionRestorePayload(
            before
        );


    console.log("");
    console.log(
        "📤 PAYLOAD RESTORE ADM:"
    );

    console.dir(
        restorePayload,
        {
            depth: null
        }
    );


    // ==========================================================
    // PUT PARA VOLVER AL ESTADO ANTERIOR
    // ==========================================================

    const result =
        await updateAdmCloudReception({

            receptionId,

            // Estado que tiene ADM AHORA
            currentReception:
                confirmation.reception,

            // Estado que queremos recuperar
            data:
                restorePayload

        });


    if (
        !result?.success
    ) {

        throw new Error(
            `ADM Cloud no confirmó la restauración de ${receptionId}.`
        );

    }


    console.log(
        `✅ Recepción ADM restaurada: ${receptionId}`
    );


    return result;

}


// ============================================================
// LIQUIDAR RECEPCIONES ADM CLOUD
// ============================================================

export async function liquidateAdmCloudReceptions({

    client,

    purchaseOrderIds,

    receiptId

}) {

    // ==========================================================
    // RECEPCIONES CREADAS EN ESTA EJECUCIÓN
    //
    // Si algo falla:
    // se recorren y se cancelan.
    // ==========================================================

    const ReceptionCreatedJustNow =
        [];

        // RECEPCIONES ADM QUE FUERON ACTUALIZADAS, Guardamos cómo estaban ANTES del UPDATE. Si algo falla posteriormente,hacemos otro PUT para restaurarlas.
    const ReceptionUpdatedJustNow =
    [];

    // IDS QUE GUARDAREMOS EN DB, SOLAMENTE SI TODAS LAS PO TERMINAN BIEN
    const receptionsToSave =
        [];


    try {

        console.log("");
        console.log(
            `${C.cyan}${C.bold}` +
            "=============================================" +
            `${C.reset}`
        );

        console.log(
            `${C.cyan}${C.bold}` +
            "🚚 INICIANDO LIQUIDACIÓN ADM CLOUD" +
            `${C.reset}`
        );

        console.log(
            `${C.cyan}${C.bold}` +
            "=============================================" +
            `${C.reset}`
        );


        // ========================================================
        // 1. VALIDACIONES GENERALES
        // ========================================================

        if (!client) {

            throw new AdmLiquidationError(
                "Error de liquidación",
                "DATABASE_CLIENT_REQUIRED",
                "El cliente de base de datos es requerido."
            );
        }


        if (
            !Array.isArray(
                purchaseOrderIds
            ) ||
            purchaseOrderIds.length === 0
        ) {

            throw new AdmLiquidationError(
                "Orden de compra requerida",
                "PURCHASE_ORDER_REQUIRED",
                "No hay órdenes de compra para procesar."
            );
        }


        if (!receiptId) {

            throw new AdmLiquidationError(
                "Recepción requerida",
                "RECEIPT_REQUIRED",
                "receiptId es requerido."
            );
        }





        // ========================================================
        // 2. BUSCAR RECEIPT
        // ========================================================

        const receiptResult =
            await client.query(
                `
        SELECT
          id,
          receipt_code,
          status,
          finished_at

        FROM receipts

        WHERE id = $1

        LIMIT 1
        `,
                [
                    receiptId
                ]
            );


        if (
            receiptResult.rowCount === 0
        ) {

            throw new AdmLiquidationError(
                "Recepción no encontrada",
                "RECEIPT_NOT_FOUND",
                `No existe el receipt ${receiptId}.`
            );
        }


        const receipt =
            receiptResult.rows[0];


        // ========================================================
        // IMPORTANTE
        //
        // Este servicio espera que el receipt actual
        // YA esté completed.
        //
        // Sigue dentro de la transacción.
        // Si algo falla luego, ROLLBACK lo deshace.
        // ========================================================

        if (
            receipt.status !==
            "completed"
        ) {

            throw new AdmLiquidationError(
                "Recepción no completada",
                "RECEIPT_NOT_COMPLETED",
                `El receipt ${receiptId} todavía no está completed.`
            );
        }


        if (
            !receipt.receipt_code
        ) {

            throw new AdmLiquidationError(
                "Código faltante",
                "RECEIPT_CODE_REQUIRED",
                "El receipt no tiene receipt_code."
            );
        }


        // ========================================================
        // FECHA PARA ADM CLOUD
        // ========================================================

        const docDate =
            receipt.finished_at
                ? new Date(
                    receipt.finished_at
                )
                    .toISOString()
                    .slice(
                        0,
                        10
                    )
                : new Date()
                    .toISOString()
                    .slice(
                        0,
                        10
                    );


        // ========================================================
        // 3. PROCESAR CADA PURCHASE ORDER
        // ========================================================

        for (
            const purchaseOrderIdRaw
            of purchaseOrderIds
        ) {

            const purchaseOrderId =
                Number(
                    purchaseOrderIdRaw
                );


            console.log("");
            console.log(
                `${C.magenta}${C.bold}` +
                "=============================================" +
                `${C.reset}`
            );

            console.log(
                `${C.magenta}${C.bold}` +
                `📦 PROCESANDO PO ID: ${purchaseOrderId}` +
                `${C.reset}`
            );

            console.log(
                `${C.magenta}${C.bold}` +
                "=============================================" +
                `${C.reset}`
            );


            // ======================================================
            // 4. BUSCAR PURCHASE ORDER
            //
            // adm_relationship_id:
            // GUID DEL PROVEEDOR EN ADM CLOUD
            //
            // AJUSTA EL NOMBRE SI TU COLUMNA
            // SE LLAMA DIFERENTE.
            // ======================================================

            const poResult =
                await client.query(
                    `
    SELECT
      id,
      purchase_order_number,
      supplier_name,
      erp_provider_id,
      erp_warehouse_id

    FROM purchase_orders

    WHERE id = $1

    LIMIT 1
    `,
                    [
                        purchaseOrderId
                    ]
                );

            if (
                poResult.rowCount === 0
            ) {

                throw new AdmLiquidationError(
                    "Orden de compra no encontrada",
                    "PURCHASE_ORDER_NOT_FOUND",
                    `No existe la orden ${purchaseOrderId}.`
                );
            }


            const purchaseOrder =
                poResult.rows[0];


            if (
                !purchaseOrder.erp_warehouse_id
            ) {

                throw new AdmLiquidationError(

                    "Almacén ADM no configurado",

                    "ERP_WAREHOUSE_ID_REQUIRED",

                    `La orden de compra ${purchaseOrder.purchase_order_number ||
                    purchaseOrderId
                    } no tiene erp_warehouse_id configurado.`

                );

            }

            if (
                !purchaseOrder.erp_provider_id
            ) {

                throw new AdmLiquidationError(

                    "Proveedor ADM no configurado",

                    "ERP_PROVIDER_ID_REQUIRED",

                    `La orden de compra ${purchaseOrder.purchase_order_number ||
                    purchaseOrderId
                    } no tiene erp_provider_id configurado.`

                );

            }


            // ======================================================
            // 5. BUSCAR SI YA TENEMOS RECEPCIÓN ADM
            // PARA ESTA PO
            // ======================================================

            const existingResult =
                await client.query(
                    `
          SELECT
            id,
            purchase_order_id,
            adm_reception_id,
            created_from_receipt_id

          FROM adm_receptions

          WHERE purchase_order_id = $1

          LIMIT 1

          FOR UPDATE
          `,
                    [
                        purchaseOrderId
                    ]
                );


            let receptionCreated =
    false;


// Recepción completa obtenida desde ADM Cloud
let existingAdmReception =
    null;


// GUID de la recepción existente
let existingAdmReceptionId =
    null;


            // ======================================================
            // 6. WMS DICE QUE YA EXISTE
            // ======================================================

            if (
                existingResult.rowCount >
                0
            ) {

                const existingReception =
                    existingResult.rows[0];


                console.log(
                    `${C.yellow}` +
                    "🔎 WMS encontró una recepción ADM existente." +
                    `${C.reset}`
                );

                console.log(
                    "ADM Reception ID:",
                    existingReception.adm_reception_id
                );


                // ====================================================
                // FUTURO SERVICIO REAL:
                //
                // GET /Receptions/{id}
                // ====================================================

                // ====================================================
                // CONFIRMAR QUE LA RECEPCIÓN EXISTE REALMENTE
                // EN ADM CLOUD
                // ====================================================

                let confirmation;


                try {

                    confirmation =
                        await confirmAdmCloudReceptionById(
                            existingReception.adm_reception_id
                        );


                    console.log("");
                    /* console.log(
                         "☁️ RESULTADO CONFIRMACIÓN ADM:"
                     );
                 
                     console.dir(
                         confirmation,
                         {
                             depth: null
                         }
                     );*/


                } catch (
                error
                ) {

                    console.error("");
                    console.error(
                        "❌ ERROR CONFIRMANDO RECEPCIÓN EN ADM CLOUD:"
                    );

                    console.error(
                        error
                    );


                    throw new AdmLiquidationError(

                        "Error verificando recepción",

                        error?.code ||
                        "ADM_RECEPTION_CHECK_FAILED",

                        error?.message ||
                        `No se pudo confirmar la recepción ${existingReception.adm_reception_id} en ADM Cloud.`

                    );

                }


                // ====================================================
                // ADM CONFIRMA QUE SÍ EXISTE
                // ====================================================
                if (
                    confirmation?.exists ===
                    true
                ) {

                    receptionCreated =
                        true;


                    existingAdmReception =
                        confirmation.reception;


                    existingAdmReceptionId =
                        confirmation.receptionId;


                    console.log("");
                    console.log(
                        `${C.bgYellow}${C.bold}` +
                        "                                                  " +
                        `${C.reset}`
                    );

                    console.log(
                        `${C.bgYellow}${C.bold}` +
                        " ⚠️ RECEPCIÓN YA EXISTE EN ADM CLOUD              " +
                        `${C.reset}`
                    );

                    console.log(
                        `${C.yellow}` +
                        ` PO ID: ${purchaseOrderId}` +
                        `${C.reset}`
                    );

                    console.log(
                        `${C.yellow}` +
                        ` PO: ${purchaseOrder.purchase_order_number || "N/A"}` +
                        `${C.reset}`
                    );

                    console.log(
                        `${C.yellow}` +
                        ` ADM ID: ${existingAdmReceptionId}` +
                        `${C.reset}`
                    );

                    console.log(
                        `${C.yellow}` +
                        ` ADM DOC ID: ${existingAdmReception?.DocID || "N/A"}` +
                        `${C.reset}`
                    );

                    console.log(
                        `${C.yellow}` +
                        ` ADM REFERENCE: ${existingAdmReception?.Reference || "N/A"}` +
                        `${C.reset}`
                    );

                    console.log(
                        `${C.bgYellow}${C.bold}` +
                        " SE ACTUALIZARÁ CON LOS NUEVOS TOTALES.            " +
                        `${C.reset}`
                    );


                    // ==================================================
                    // IMPORTANTE:
                    //
                    // NO HACER continue.
                    //
                    // Ahora debemos seguir y calcular
                    // nuevamente las cantidades acumuladas.
                    // ==================================================
                }


                // ====================================================
                // WMS TIENE ID
                // PERO ADM DICE QUE NO EXISTE
                // ====================================================

                if (
                    confirmation?.exists ===
                    false
                ) {

                    console.log(
                        `${C.yellow}` +
                        "⚠️ La recepción está registrada en WMS, " +
                        "pero ya no existe en ADM Cloud." +
                        `${C.reset}`
                    );


                    receptionCreated =
                        false;


                    // ==================================================
                    // BORRAMOS EL MAPPING VIEJO
                    //
                    // Sigue dentro de transacción.
                    // ==================================================

                    await client.query(
                        `
            DELETE FROM adm_receptions

            WHERE id = $1
            `,
                        [
                            existingReception.id
                        ]
                    );
                }
            }


            // ======================================================
            // 7. SI NO EXISTE, PREPARAR RECEPCIÓN
            // ======================================================

         

                // ====================================================
                // AQUÍ ESTÁ LA PARTE IMPORTANTE:
                //
                // Por cada purchase_order_line
                // buscamos TODAS sus receipt_lines.
                //
                // Solo receipts COMPLETED.
                //
                // Sumamos received_qty.
                // ====================================================

                const linesResult =
                    await client.query(
                        `
    SELECT

      pol.id
        AS purchase_order_line_id,

      pol.purchase_order_id,

      pol.sku,

      pol.description,


      -- ============================================
      -- DATOS ADM CLOUD
      -- ============================================

      pol.erp_product_id,
pol.erp_row_order,
pol.erp_cost,
pol.erp_price,

      pol.erp_uom_id,

      pol.erp_row_type,

      pol.erp_estimated_delivery_date,

      pol.erp_exchange_rate,

      pol.erp_warranty_days,

      pol.erp_warranty_units,


      -- ============================================
      -- TOTAL RECIBIDO HISTÓRICO
      -- SOLO RECEIPTS COMPLETED
      -- ============================================

      COALESCE(
        SUM(
          CASE

            WHEN
              r.status = 'completed'

            THEN
              COALESCE(
                rl.received_qty,
                0
              )

            ELSE
              0

          END
        ),
        0
      )
        AS total_received_qty


    FROM purchase_order_lines pol


    LEFT JOIN receipt_lines rl
      ON rl.purchase_order_line_id =
         pol.id


    LEFT JOIN receipts r
      ON r.id =
         rl.receipt_id


    WHERE
      pol.purchase_order_id = $1

      AND COALESCE(
        pol.deleted_erp,
        FALSE
      ) = FALSE


    GROUP BY

      pol.id,
      pol.purchase_order_id,
      pol.sku,
      pol.description,

      pol.erp_product_id,
pol.erp_row_order,
pol.erp_cost,
pol.erp_price,
      pol.erp_uom_id,
      pol.erp_row_type,
      pol.erp_estimated_delivery_date,
      pol.erp_exchange_rate,
      pol.erp_warranty_days,
      pol.erp_warranty_units


    ORDER BY
      pol.id
    `,
                        [
                            purchaseOrderId
                        ]
                    );


                if (
                    linesResult.rowCount ===
                    0
                ) {

                    throw new AdmLiquidationError(
                        "Orden sin líneas",
                        "PURCHASE_ORDER_LINES_NOT_FOUND",
                        `La orden ${purchaseOrderId} no tiene purchase_order_lines.`
                    );
                }


                // ====================================================
                // SOLO ITEMS QUE SE HAN RECIBIDO
                // ====================================================

                const receivedLines =
                    linesResult.rows.filter(
                        line =>
                            Number(
                                line.total_received_qty
                            ) > 0
                    );


                if (
                    receivedLines.length ===
                    0
                ) {

                    throw new AdmLiquidationError(
                        "No hay productos recibidos",
                        "NO_RECEIVED_PRODUCTS",
                        `La orden ${purchaseOrder.purchase_order_number || purchaseOrderId} no tiene productos recibidos en receipts completed.`
                    );
                }


                // ====================================================
                // DEBUG
                // ====================================================

                console.log("");
                console.log(
                    `${C.cyan}${C.bold}` +
                    "📊 TOTAL RECIBIDO POR PURCHASE ORDER LINE" +
                    `${C.reset}`
                );


                console.table(
                    receivedLines.map(
                        line => ({

                            purchase_order_line_id:
                                line.purchase_order_line_id,

                            sku:
                                line.sku,

                            total_received:
                                Number(
                                    line.total_received_qty
                                )

                        })
                    )
                );


                // ====================================================
                // 8. CONSTRUIR ITEMS
                //
                // NO NECESITAS VALIDAR GUID AQUÍ.
                //
                // createAdmCloudReception()
                // ya se encargará de:
                //
                // - ItemID
                // - UOMID
                // - Quantity
                // - Cost
                // - Price
                // etc.
                // ====================================================

                const items =
                    receivedLines.map(
                        (
                            line,
                            index
                        ) => ({

                            RowOrder:
                                line.erp_row_order ??
                                index + 1,

                            ItemID:
                                line.erp_product_id,

                            Cost:
                                Number(
                                    line.erp_cost ??
                                    0
                                ),

                            Price:
                                Number(
                                    line.erp_price ??
                                    0
                                ),

                            Quantity:
                                Number(
                                    line.total_received_qty
                                ),

                            UOMID:
                                line.erp_uom_id,

                            RowType:
                                Number(
                                    line.erp_row_type ??
                                    0
                                ),

                            EstimatedDeliveryDate:
                                line.erp_estimated_delivery_date
                                    ? new Date(
                                        line.erp_estimated_delivery_date
                                    ).toISOString()
                                    : "0001-01-01T00:00:00",

                            ExchangeRate:
                                Number(
                                    line.erp_exchange_rate ??
                                    0
                                ),

                            WarrantyDays:
                                Number(
                                    line.erp_warranty_days ??
                                    0
                                ),

                            WarrantyUnits:
                                Number(
                                    line.erp_warranty_units ??
                                    0
                                )

                        })
                    );

                // ====================================================
                // 9. PAYLOAD
                //
                // IMPORTANTE:
                //
                // Reference:
                // EXACTAMENTE receipt_code.
                //
                // NO agregamos WMS-
                // NO agregamos PO-
                // NO fabricamos nada.
                // ====================================================

                const payload =
                {

                    DocDate:
                        docDate,

                    Reference:
                        receipt.receipt_code,

                    RelationshipID:
                        purchaseOrder.erp_provider_id ||
                        null,

                    LocationID:
                        purchaseOrder.erp_warehouse_id,

                    Notes:
                        `Recepción ${receipt.receipt_code}`,

                    Items:
                        items,

                    Documents:
                        [],

                    Files:
                        [],

                    CustomFields:
                        []

                };


                console.log("");
                console.log(
                    `${C.cyan}${C.bold}` +
                    "📤 PAYLOAD QUE SE ENVIARÁ AL SERVICIO:" +
                    `${C.reset}`
                );

                console.dir(
                    payload,
                    {
                        depth: null
                    }
                );

// ============================================================
// 10. SI LA RECEPCIÓN YA EXISTE EN ADM CLOUD
// ACTUALIZARLA
// ============================================================

if (
    receptionCreated ===
    true
) {

    console.log("");
    console.log(
        `${C.cyan}${C.bold}` +
        "=============================================" +
        `${C.reset}`
    );

    console.log(
        `${C.cyan}${C.bold}` +
        "🔄 ACTUALIZANDO RECEPCIÓN ADM CLOUD" +
        `${C.reset}`
    );

    console.log(
        "ADM Reception ID:",
        existingAdmReceptionId
    );


    // ========================================================
    // CONSERVAR DATOS DEL DOCUMENTO ORIGINAL
    //
    // Ejemplo:
    //
    // Primera recepción WMS:
    // 2026-23
    //
    // Segunda recepción WMS:
    // 2026-24
    //
    // La recepción ADM sigue siendo la creada originalmente,
    // por lo tanto conservamos Reference = 2026-23.
    // ========================================================

    const updatePayload = {

    // ==========================================
    // NÚMERO ORIGINAL DEL DOCUMENTO ADM
    // ==========================================

    DocID:
        existingAdmReception?.DocID,


    // ==========================================
    // MANTENER FECHA ORIGINAL
    // ==========================================

    DocDate:
        existingAdmReception?.DocDate
            ? String(
                existingAdmReception.DocDate
              ).slice(
                0,
                10
              )
            : payload.DocDate,


    // ==========================================
    // MANTENER REFERENCIA ORIGINAL
    // ==========================================

    Reference:
        existingAdmReception?.Reference ||
        payload.Reference,


    // ==========================================
    // PROVEEDOR
    // ==========================================

    RelationshipID:
        existingAdmReception?.RelationshipID ||
        payload.RelationshipID,


    // ==========================================
    // ALMACÉN
    // ==========================================

    LocationID:
        existingAdmReception?.LocationID ||
        payload.LocationID,


    // ==========================================
    // NOTAS
    // ==========================================

    Notes:
        existingAdmReception?.Notes ||
        payload.Notes,


    // ==========================================
    // CANTIDADES ACTUALIZADAS
    // ==========================================

    Items:
        items

};

    console.log("");
    console.log(
        "📤 PAYLOAD PARA UPDATE:"
    );

    console.dir(
        updatePayload,
        {
            depth: null
        }
    );

    // ========================================================
// GUARDAR SNAPSHOT ANTES DEL PUT
// ========================================================

const beforeUpdateSnapshot =
    structuredClone(
        existingAdmReception
    );


ReceptionUpdatedJustNow.push({

    receptionId:
        existingAdmReceptionId,

    purchaseOrderId,

    before:
        beforeUpdateSnapshot

});



    let updateResult;


    try {

        updateResult =
            await updateAdmCloudReception({

                receptionId:
                    existingAdmReceptionId,

                currentReception:
                    existingAdmReception,

                data:
                    updatePayload

            });


    } catch (
        error
    ) {

        console.error("");
        console.error(
            "❌ updateAdmCloudReception falló:"
        );

        console.error(
            error
        );


        throw new AdmLiquidationError(

            "Error actualizando recepción en ADM Cloud",

            "ADM_RECEPTION_UPDATE_FAILED",

            error?.message ||
            `No se pudo actualizar la recepción ADM para la PO ${purchaseOrderId}.`

        );

    }


    // ========================================================
    // VALIDAR RESULTADO
    // ========================================================

    if (
        !updateResult?.success
    ) {

        throw new AdmLiquidationError(

            "ADM Cloud no actualizó la recepción",

            "ADM_RECEPTION_UPDATE_FAILED",

            `ADM Cloud no confirmó la actualización para la PO ${purchaseOrderId}.`

        );

    }


    console.log("");
    console.log(
        `${C.bgGreen}${C.bold}` +
        "                                          " +
        `${C.reset}`
    );

    console.log(
        `${C.bgGreen}${C.bold}` +
        " ✅ RECEPTION ACTUALIZADA EN ADM CLOUD     " +
        `${C.reset}`
    );

    console.log(
        `${C.green}` +
        `PO: ${purchaseOrder.purchase_order_number || purchaseOrderId}` +
        `${C.reset}`
    );

    console.log(
        `${C.green}` +
        `ADM ID: ${existingAdmReceptionId}` +
        `${C.reset}`
    );

    console.log(
        `${C.green}` +
        `TOTAL ITEMS: ${items.length}` +
        `${C.reset}`
    );

    console.log(
        `${C.bgGreen}${C.bold}` +
        "                                          " +
        `${C.reset}`
    );


    // ========================================================
    // MUY IMPORTANTE
    //
    // Esta PO ya fue procesada mediante UPDATE.
    //
    // No debemos continuar hacia CREATE.
    // ========================================================

    continue;
}


                // ====================================================
                // 10. USAR TU SERVICIO REAL
                //
                // ESTE ES EL SERVICIO QUE ME ACABAS DE DAR.
                // ====================================================

                let creationResult;


                try {

                    creationResult =
                        await createAdmCloudReception(
                            payload
                        );

                } catch (
                error
                ) {

                    console.error(
                        "❌ createAdmCloudReception falló:",
                        error.message
                    );


                    throw new AdmLiquidationError(
                        "Error creando recepción en ADM Cloud",
                        "ADM_RECEPTION_CREATE_FAILED",
                        error.message ||
                        `No se pudo crear la recepción para la PO ${purchaseOrderId}.`
                    );
                }


                // ====================================================
                // 11. TU SERVICIO DEVUELVE:
                //
                // {
                //   success: true,
                //   receptionId,
                //   payload,
                //   response
                // }
                //
                // POR ESO NO NECESITAMOS extractAdmReceptionId()
                // ====================================================

                const admReceptionId =
                    creationResult?.receptionId;


                if (
                    !creationResult?.success ||
                    !admReceptionId
                ) {

                    throw new AdmLiquidationError(
                        "ADM Cloud no devolvió recepción",
                        "ADM_RECEPTION_ID_REQUIRED",
                        `ADM Cloud no devolvió un receptionId para la PO ${purchaseOrderId}.`
                    );
                }


                // ====================================================
                // 12. AGREGAR INMEDIATAMENTE
                // A ReceptionCreatedJustNow
                //
                // IMPORTANTE:
                //
                // En cuanto ADM devuelve un ID,
                // lo ponemos aquí.
                //
                // Así cualquier error posterior puede compensarlo.
                // ====================================================

                ReceptionCreatedJustNow.push(
                    admReceptionId
                );


                // ====================================================
                // TODAVÍA NO INSERTAMOS EN DB.
                //
                // ESPERAMOS QUE TODAS LAS PO TERMINEN.
                // ====================================================

                receptionsToSave.push({

                    purchaseOrderId,

                    receiptId,

                    admReceptionId

                });


                console.log("");
                console.log(
                    `${C.bgGreen}${C.bold}` +
                    "                                      " +
                    `${C.reset}`
                );

                console.log(
                    `${C.bgGreen}${C.bold}` +
                    " ✅ RECEPTION CREADA EN ADM CLOUD      " +
                    `${C.reset}`
                );

                console.log(
                    `${C.green}` +
                    `PO: ${purchaseOrder.purchase_order_number || purchaseOrderId}` +
                    `${C.reset}`
                );

                console.log(
                    `${C.green}` +
                    `ADM ID: ${admReceptionId}` +
                    `${C.reset}`
                );

                console.log(
    `${C.bgGreen}${C.bold}` +
    "                                      " +
    `${C.reset}`
);


// ========================================================
// CERRAR FOR DE PURCHASE ORDERS
// ========================================================

        }


// ========================================================
// 13. TODAS LAS PO TERMINARON CORRECTAMENTE
//
// AHORA SÍ GUARDAMOS LOS IDS EN WMS.
// ========================================================

for (
    const reception
    of receptionsToSave
) {

            await client.query(
                `
        INSERT INTO adm_receptions
        (
          purchase_order_id,
          created_from_receipt_id,
          adm_reception_id
        )

        VALUES
        (
          $1,
          $2,
          $3
        )
        `,
                [
                    reception.purchaseOrderId,
                    reception.receiptId,
                    reception.admReceptionId
                ]
            );
        }


        console.log("");
        console.log(
            `${C.green}${C.bold}` +
            "=============================================" +
            `${C.reset}`
        );

        console.log(
            `${C.green}${C.bold}` +
            "✅ LIQUIDACIÓN ADM TERMINADA CORRECTAMENTE" +
            `${C.reset}`
        );

        console.log(
            `${C.green}${C.bold}` +
            "=============================================" +
            `${C.reset}`
        );


        return {

            success:
                true,

            ReceptionCreatedJustNow,

            receptions:
                receptionsToSave

        };

    } catch (error) {

        console.error("");
        console.error(
            `${C.bgRed}${C.bold}` +
            "                                              " +
            `${C.reset}`
        );

        console.error(
            `${C.bgRed}${C.bold}` +
            " ❌ ERROR DURANTE LIQUIDACIÓN ADM CLOUD       " +
            `${C.reset}`
        );

        console.error(
            `${C.bgRed}${C.bold}` +
            "                                              " +
            `${C.reset}`
        );

        console.error(
            error
        );


        // ========================================================
// RESTAURAR RECEPCIONES ADM ACTUALIZADAS
//
// Se hace en orden inverso.
//
// Si modificamos:
// A
// B
// C
//
// restauramos:
// C
// B
// A
// ========================================================

if (
    ReceptionUpdatedJustNow.length >
    0
) {

    console.log("");
    console.log(
        `${C.yellow}` +
        `⚠️ Se intentarán restaurar ${ReceptionUpdatedJustNow.length} recepción(es) ADM actualizadas.` +
        `${C.reset}`
    );


    for (
        const updatedReception
        of [...ReceptionUpdatedJustNow].reverse()
    ) {

        try {

            await restoreAdmCloudReception({

                receptionId:
                    updatedReception.receptionId,

                before:
                    updatedReception.before

            });


            console.log(
                `${C.green}` +
                `✅ Recepción restaurada: ${updatedReception.receptionId}` +
                `${C.reset}`
            );


        } catch (
            restoreError
        ) {

            // ==================================================
            // MUY IMPORTANTE
            //
            // Si esto falla, ya estamos en un escenario donde
            // WMS hizo rollback pero ADM podría quedar diferente.
            //
            // Debe quedar claramente registrado.
            // ==================================================

            console.error("");
            console.error(
                `${C.red}${C.bold}` +
                "🚨 ERROR CRÍTICO RESTAURANDO ADM CLOUD" +
                `${C.reset}`
            );

            console.error(
                "Reception ID:",
                updatedReception.receptionId
            );

            console.error(
                "PO ID:",
                updatedReception.purchaseOrderId
            );

            console.error(
                restoreError
            );

        }

    }

}


        // ========================================================
        // CANCELAR RECEPCIONES CREADAS EN ESTA EJECUCIÓN
        // ========================================================

        // ========================================================


if (
    ReceptionCreatedJustNow.length >
    0
) {

    console.log("");
    console.log(
        `${C.yellow}` +
        `⚠️ Se intentarán eliminar ${ReceptionCreatedJustNow.length} recepción(es) ADM creadas durante esta ejecución.` +
        `${C.reset}`
    );


    for (
        const admReceptionId
        of [...ReceptionCreatedJustNow].reverse()
    ) {

        try {

            const deleteResult =
                await deleteAdmCloudReception(
                    admReceptionId
                );


            console.log(
                `${C.green}` +
                `✅ Recepción ADM eliminada: ${admReceptionId}` +
                `${C.reset}`
            );


            if (
                deleteResult?.alreadyDeleted
            ) {

                console.log(
                    `${C.yellow}` +
                    `⚠️ La recepción ${admReceptionId} ya estaba eliminada.` +
                    `${C.reset}`
                );
            }


        } catch (
            deleteError
        ) {

            console.error(
                `${C.red}` +
                `❌ No se pudo eliminar la recepción ADM ${admReceptionId}` +
                `${C.reset}`
            );

            console.error(
                deleteError
            );

        }

    }

}


        // ========================================================
        // SI YA ES UN ERROR DE LIQUIDACIÓN
        // MANTENER TITLE / CODE / MESSAGE
        // ========================================================

        if (
            error instanceof AdmLiquidationError
        ) {

            throw error;

        }


        // ========================================================
        // SI VIENE DE OTRO SERVICIO
        // CONVERTIRLO A ERROR ENTENDIBLE PARA FRONTEND
        // ========================================================

        throw new AdmLiquidationError(

            "Error durante la liquidación",

            "ADM_LIQUIDATION_ERROR",

            error?.message ||
            "Ocurrió un error mientras se procesaba la recepción en ADM Cloud."

        );

    }
}