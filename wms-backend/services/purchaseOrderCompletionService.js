export async function completePurchaseOrderIfFullyReceived(
    client,
    purchaseOrderId
) {

    console.log("");
    console.log("========================================");
    console.log("📋 VALIDANDO PURCHASE ORDER COMPLETA");
    console.log("========================================");
    console.log(
        "Purchase Order ID:",
        purchaseOrderId
    );


    const parsedPurchaseOrderId =
        Number(
            purchaseOrderId
        );


    // ==========================================================
    // 1. VALIDAR ID
    // ==========================================================

    if (
        !Number.isInteger(
            parsedPurchaseOrderId
        ) ||
        parsedPurchaseOrderId <= 0
    ) {

        return {

            success:
                false,

            completed:
                false,

            code:
                "INVALID_PURCHASE_ORDER_ID",

            message:
                "El purchaseOrderId no es válido."

        };

    }


    // ==========================================================
    // 2. BUSCAR LÍNEAS ACTIVAS
    //
    // IMPORTANTE:
    //
    // purchase_order_lines.received_qty
    // ya contiene el TOTAL ACUMULADO,
    // porque CloseReception lo recalculó antes
    // de llamar este servicio.
    // ==========================================================

    const linesResult =
        await client.query(
            `
            SELECT

                id
                    AS purchase_order_line_id,

                sku,

                ordered_qty,

                received_qty

            FROM purchase_order_lines

            WHERE
                purchase_order_id = $1

                AND COALESCE(
                    deleted_erp,
                    FALSE
                ) = FALSE

            ORDER BY
                id
            `,
            [
                parsedPurchaseOrderId
            ]
        );


    // ==========================================================
    // 3. VALIDAR QUE EXISTAN LÍNEAS
    // ==========================================================

    if (
        linesResult.rowCount ===
        0
    ) {

        return {

            success:
                true,

            completed:
                false,

            code:
                "NO_PURCHASE_ORDER_LINES",

            message:
                "La orden de compra no tiene líneas activas."

        };

    }


    const lines =
        linesResult.rows;


    // ==========================================================
    // 4. VALIDAR CADA LÍNEA
    // ==========================================================

    const validation =
        lines.map(
            line => {

                const orderedQty =
                    Number(
                        line.ordered_qty ||
                        0
                    );


                const receivedQty =
                    Number(
                        line.received_qty ||
                        0
                    );


                // ==================================================
                // >=
                //
                // Si ordenó 10 y recibió 10 = completa
                // Si ordenó 10 y recibió 11 = también completa
                // ==================================================

                const completed =
                    receivedQty >=
                    orderedQty;


                return {

                    purchaseOrderLineId:
                        Number(
                            line.purchase_order_line_id
                        ),

                    sku:
                        line.sku,

                    orderedQty,

                    receivedQty,

                    completed

                };

            }
        );


    console.log("");
    console.log(
        "📋 RESULTADO VALIDACIÓN:"
    );

    console.table(
        validation
    );


    // ==========================================================
    // 5. BUSCAR LÍNEAS INCOMPLETAS
    // ==========================================================

    const incompleteLines =
        validation.filter(
            line =>
                !line.completed
        );


    // ==========================================================
    // 6. SI TODAVÍA ESTÁ INCOMPLETA
    // ==========================================================

    if (
        incompleteLines.length >
        0
    ) {

        console.log("");
        console.log(
            "🟡 PURCHASE ORDER TODAVÍA INCOMPLETA"
        );


        // ========================================================
        // SI YA RECIBIÓ ALGO,
        // LA MARCAMOS PARTIAL
        // ========================================================

        const hasReceivedAnything =
            validation.some(
                line =>
                    line.receivedQty >
                    0
            );


        if (
            hasReceivedAnything
        ) {

            await client.query(
                `
                UPDATE purchase_orders

                SET
                    status = 'partial',
                    updated_at = NOW()

                WHERE
                    id = $1
                `,
                [
                    parsedPurchaseOrderId
                ]
            );

        }


        return {

            success:
                true,

            completed:
                false,

            code:
                "PURCHASE_ORDER_NOT_FULLY_RECEIVED",

            message:
                "La orden de compra todavía tiene líneas pendientes.",

            incompleteLines

        };

    }


    // ==========================================================
    // 7. TODAS COMPLETAS
    // ==========================================================

    console.log("");
    console.log(
        "✅ TODAS LAS LÍNEAS FUERON RECIBIDAS"
    );


    // ==========================================================
    // 8. MARCAR PURCHASE ORDER CLOSED
    // ==========================================================

    const updateResult =
        await client.query(
            `
            UPDATE purchase_orders

            SET
                status = 'closed',
                updated_at = NOW()

            WHERE
                id = $1

            RETURNING
                id,
                purchase_order_number,
                status
            `,
            [
                parsedPurchaseOrderId
            ]
        );


    if (
        updateResult.rowCount ===
        0
    ) {

        return {

            success:
                false,

            completed:
                false,

            code:
                "PURCHASE_ORDER_NOT_FOUND",

            message:
                "La orden de compra no fue encontrada."

        };

    }


    const purchaseOrder =
        updateResult.rows[0];


    console.log("");
    console.log(
        "✅ PURCHASE ORDER COMPLETADA:"
    );

    console.log(
        purchaseOrder
    );


    return {

        success:
            true,

        completed:
            true,

        code:
            "PURCHASE_ORDER_COMPLETED",

        message:
            "La orden de compra fue completada porque todas sus líneas fueron recibidas.",

        purchaseOrder,

        lines:
            validation

    };

}