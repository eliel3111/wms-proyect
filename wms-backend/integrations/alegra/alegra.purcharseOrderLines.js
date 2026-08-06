// FILE: wms-backend/integrations/alegra/alegra.purchaseOrderLines.js




/**
 * Convierte cualquier valor a número.
 */
function toNumber(value, fallback = 0) {
    const parsed = Number(value);

    return Number.isFinite(parsed)
        ? parsed
        : fallback;
}

/**
 * Normaliza los impuestos recibidos desde Alegra
 * o recuperados desde PostgreSQL.
 */
function normalizeTaxes(value) {
  /*
   * Cuando PostgreSQL devuelve una columna JSONB,
   * node-postgres normalmente ya entrega un arreglo.
   */
  if (Array.isArray(value)) {
    return value;
  }

  /*
   * Si por alguna razón viene como texto JSON,
   * intentamos convertirlo.
   */
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);

      return Array.isArray(parsed)
        ? parsed
        : [];
    } catch (error) {
      console.warn(
        "⚠️ No se pudieron interpretar los impuestos:",
        value
      );

      return [];
    }
  }

  /*
   * null, undefined u otro tipo.
   */
  return [];
}


function normalizeTaxesForComparison(value) {
    return JSON.stringify(
        normalizeTaxes(value)
            .map((tax) => ({
                id:
                    tax?.id
                        ? String(tax.id)
                        : null,

                name:
                    tax?.name || null,

                percentage:
                    tax?.percentage !== undefined
                        ? String(tax.percentage)
                        : null,

                type:
                    tax?.type || null
            }))
            .sort((a, b) =>
                String(a.id).localeCompare(
                    String(b.id)
                )
            )
    );
}


function normalizeAlegraTaxes(value) {
    if (!Array.isArray(value)) {
        return [];
    }

    return value.map((tax) => ({
        id:
            tax?.id
                ? String(tax.id)
                : null,

        name:
            tax?.name || null,

        percentage:
            tax?.percentage !== undefined
                ? String(tax.percentage)
                : null,

        type:
            tax?.type || null
    }));
}

/**
 * Normaliza números decimales para construir claves estables.
 *
 * Ejemplo:
 * 150          -> "150.000000"
 * "150.0000"   -> "150.000000"
 */
function normalizeDecimal(
    value,
    decimals
) {
    return toNumber(value).toFixed(decimals);
}

/**
 * Clave exacta base:
 *
 * producto + precio + cantidad
 *
 * Todavía no contiene la ocurrencia.
 */
function createExactBaseKey({
    erpProductId,
    unitPrice,
    quantity
}) {
    return [
        String(erpProductId),
        normalizeDecimal(unitPrice, 6),
        normalizeDecimal(quantity, 4)
    ].join("|");
}

/**
 * Clave secundaria:
 *
 * producto + precio
 *
 * Se utiliza para reconocer una línea cuando
 * solamente cambió su cantidad.
 */
function createProductPriceKey({
    erpProductId,
    unitPrice
}) {
    return [
        String(erpProductId),
        normalizeDecimal(unitPrice, 6)
    ].join("|");
}

/**
 * Sincroniza las líneas de una orden de compra de Alegra.
 *
 * Alegra no devuelve un ID único para cada línea.
 *
 * Por eso:
 *
 * - erp_line_id queda NULL.
 * - erp_product_id recibe purchases.items[].id.
 * - erp_line_key identifica sintéticamente la línea.
 *
 * Formato de erp_line_key:
 *
 * producto|precio|cantidad|ocurrencia
 *
 * Ejemplos:
 *
 * 1568|150.000000|20.0000|1
 * 1568|120.000000|5.0000|1
 * 1568|150.000000|20.0000|2
 *
 * Reglas:
 *
 * 1. Coincidencia exacta:
 *    producto + precio + cantidad + ocurrencia.
 *
 * 2. Si cambió la cantidad:
 *    producto + precio + posición.
 *
 * 3. Si cambió de posición:
 *    producto + precio, únicamente cuando no es ambiguo.
 *
 * 4. Línea eliminada en Alegra:
 *    - Sin recepción: se elimina.
 *    - Con recepción: se archiva.
 *
 * 5. Línea nueva:
 *    - Se inserta.
 *
 * 6. ordered_qty nunca baja de received_qty.
 *
 * IMPORTANTE:
 *
 * Esta función administra BEGIN, COMMIT y ROLLBACK.
 * clientDb debe ser una conexión obtenida con db.connect().
 */
export async function syncAlegraPurchaseOrderLines(
    clientDb,
    order,
    purchaseOrderId
) {
    let transactionStarted = false;

    const summary = {
        inserted: 0,
        updated: 0,
        deleted: 0,
        archived: 0,
        unchanged: 0
    };

    try {
        console.log("");
        console.log(
            "🟥🟥🟥 ========================================"
        );
        console.log(
            "📦 INICIANDO SYNC DE LÍNEAS DE ALEGRA"
        );
        console.log(
            "🟥🟥🟥 ========================================"
        );

        // =========================================================
        // 1. VALIDACIONES
        // =========================================================

        if (!clientDb) {
            throw new Error(
                "No se recibió una conexión válida de PostgreSQL"
            );
        }

        if (!order?.id) {
            throw new Error(
                "La orden de Alegra no contiene order.id"
            );
        }

        if (!purchaseOrderId) {
            throw new Error(
                "No se recibió el purchaseOrderId interno del WMS"
            );
        }

        const alegraOrderId =
            Number(order.id);

        if (!Number.isFinite(alegraOrderId)) {
            throw new Error(
                `ID de orden de Alegra inválido: ${order.id}`
            );
        }

        const rawLines =
            Array.isArray(
                order.purchases?.items
            )
                ? order.purchases.items
                : [];

        console.log(
            "📌 Alegra order ID:",
            alegraOrderId
        );

        console.log(
            "📌 WMS purchase order ID:",
            purchaseOrderId
        );

        console.log(
            "📌 Líneas recibidas:",
            rawLines.length
        );

        /*
         * Protección contra respuestas incompletas.
         *
         * Si Alegra no devuelve absolutamente ninguna línea,
         * no eliminamos las líneas locales.
         */
        if (rawLines.length === 0) {
            console.warn(
                "⚠️ Alegra no devolvió líneas. Se omite la sincronización."
            );

            return {
                success: true,
                skipped: true,
                reason: "ALEGRA_WITHOUT_LINES",
                summary
            };
        }

        // =========================================================
        // 2. NORMALIZAR LAS LÍNEAS DE ALEGRA
        // =========================================================

        const exactKeyOccurrences =
            new Map();

        const values = rawLines
            .map((item, index) => {
                const erpProductId =
                    Number(item?.id);

                const quantity =
                    toNumber(item?.quantity);

                const unitPrice =
                    toNumber(item?.price);

                const discount =
                    toNumber(item?.discount);

                const taxes =
                    normalizeAlegraTaxes(
                        item?.tax
                    );

                const exactBaseKey =
                    createExactBaseKey({
                        erpProductId,
                        unitPrice,
                        quantity
                    });

                /*
                 * Permite diferenciar líneas completamente
                 * idénticas.
                 *
                 * Primera:
                 * 1568|150.000000|20.0000|1
                 *
                 * Segunda:
                 * 1568|150.000000|20.0000|2
                 */
                const occurrence =
                    (
                        exactKeyOccurrences.get(
                            exactBaseKey
                        ) || 0
                    ) + 1;

                exactKeyOccurrences.set(
                    exactBaseKey,
                    occurrence
                );

                const erpLineKey =
                    `${exactBaseKey}|${occurrence}`;

                const productPriceKey =
                    createProductPriceKey({
                        erpProductId,
                        unitPrice
                    });

                return {
                    erp_line_id: null,

                    erp_line_key:
                        erpLineKey,

                    exact_base_key:
                        exactBaseKey,

                    product_price_key:
                        productPriceKey,

                    occurrence,

                    erp_order_id:
                        alegraOrderId,

                    erp_product_id:
                        Number.isFinite(erpProductId)
                            ? erpProductId
                            : null,

                    qty:
                        Number.isFinite(quantity)
                            ? quantity
                            : 0,

                    unit_price:
                        Number.isFinite(unitPrice)
                            ? unitPrice
                            : 0,

                    discount:
                        Number.isFinite(discount)
                            ? discount
                            : 0,

                    taxes,

                    original_line_number:
                        index + 1,

                    reference:
                        item?.reference
                            ? String(item.reference).trim()
                            : null,

                    description:
                        item?.description ||
                        item?.name ||
                        null,

                    name:
                        item?.name || null
                };
            })

            /*
             * Una línea con cantidad 0 deja de considerarse activa.
             * Si existía localmente, será eliminada o archivada.
             */
            .filter(
                (line) => line.qty > 0
            );

        console.log("");
        console.log(
            "📨 LÍNEAS NORMALIZADAS DE ALEGRA:"
        );

        console.dir(values, {
            depth: null
        });

        // =========================================================
        // 3. VALIDAR PRODUCTOS
        // =========================================================

        for (const line of values) {
            if (!line.erp_product_id) {
                throw new Error(
                    `Alegra devolvió una línea sin ID de producto válido. ` +
                    `Posición: ${line.original_line_number}`
                );
            }

            if (!line.erp_line_key) {
                throw new Error(
                    `No fue posible generar erp_line_key. ` +
                    `Posición: ${line.original_line_number}`
                );
            }
        }

        // =========================================================
        // 4. INICIAR TRANSACCIÓN
        // =========================================================

        await clientDb.query(
            "BEGIN"
        );

        transactionStarted = true;

        // =========================================================
        // 5. BLOQUEAR LA ORDEN DE COMPRA
        // =========================================================

        const purchaseOrderLockResult =
            await clientDb.query(
                `
        SELECT
          id,
          erp_order_id
        FROM purchase_orders
        WHERE id = $1
        FOR UPDATE
        `,
                [purchaseOrderId]
            );

        if (
            purchaseOrderLockResult.rowCount === 0
        ) {
            throw new Error(
                `No existe la orden WMS con ID ${purchaseOrderId}`
            );
        }

        // =========================================================
        // 6. OBTENER LÍNEAS ACTUALES DEL WMS
        // =========================================================

        const wmsResult =
            await clientDb.query(
                `
        SELECT
          pol.id,
          pol.purchase_order_id,
          pol.erp_order_id,
          pol.erp_line_id,
          pol.erp_line_key,
          pol.erp_product_id,
          pol.line_number,
          pol.description,
          pol.ordered_qty,
          pol.received_qty,
          pol.unit_price,
          pol.sku,
          pol.discount,
pol.taxes,
          pol.product_exists,
          pol.deleted_erp,

          GREATEST(
            COALESCE(
              pol.received_qty,
              0
            ),
            COALESCE(
              receipts.total_received,
              0
            )
          )::numeric AS total_received

        FROM purchase_order_lines pol

        LEFT JOIN LATERAL (
          SELECT
            COALESCE(
              SUM(
                rl.received_qty
              ),
              0
            )::numeric AS total_received
          FROM receipt_lines rl
          WHERE
            rl.purchase_order_line_id =
            pol.id
        ) receipts
          ON TRUE

        WHERE pol.purchase_order_id = $1
          AND pol.erp_order_id = $2

        ORDER BY
          CASE
            WHEN pol.line_number
              ~ '^[0-9]+$'
            THEN
              pol.line_number::integer
            ELSE
              999999999
          END,
          pol.id

        FOR UPDATE OF pol
        `,
                [
                    purchaseOrderId,
                    alegraOrderId
                ]
            );

        const wmsValues =
            wmsResult.rows.map(
                (line) => ({
                    ...line,

                    id:
                        Number(line.id),

                    purchase_order_id:
                        Number(
                            line.purchase_order_id
                        ),

                    erp_order_id:
                        line.erp_order_id !== null
                            ? Number(
                                line.erp_order_id
                            )
                            : null,

                    erp_line_id:
                        line.erp_line_id !== null
                            ? Number(
                                line.erp_line_id
                            )
                            : null,

                    erp_line_key:
                        line.erp_line_key ||
                        null,

                    erp_product_id:
                        line.erp_product_id !== null
                            ? Number(
                                line.erp_product_id
                            )
                            : null,

                    ordered_qty:
                        toNumber(
                            line.ordered_qty
                        ),

                    received_qty:
                        toNumber(
                            line.received_qty
                        ),

                    total_received:
                        toNumber(
                            line.total_received
                        ),

                    unit_price:
                        toNumber(
                            line.unit_price
                        ),

                    discount:
                        toNumber(
                            line.discount
                        ),

                    taxes:
                        normalizeTaxes(
                            line.taxes
                        ),

                    product_price_key:
                        createProductPriceKey({
                            erpProductId:
                                Number(
                                    line.erp_product_id
                                ),

                            unitPrice:
                                toNumber(
                                    line.unit_price
                                )
                        }),

                    product_exists:
                        line.product_exists === true,

                    deleted_erp:
                        line.deleted_erp === true
                })
            );

        console.log("");
        console.log(
            "📦 LÍNEAS ACTUALES DEL WMS:"
        );

        console.dir(wmsValues, {
            depth: null
        });

        // =========================================================
        // 7. INFORMACIÓN LOCAL DE PRODUCTOS
        // =========================================================

        const erpProductIds = [
            ...new Set(
                values
                    .map(
                        (line) =>
                            line.erp_product_id
                    )
                    .filter(
                        (id) => id !== null
                    )
            )
        ];

        const productMap =
            new Map();

        if (erpProductIds.length > 0) {
            const productsResult =
                await clientDb.query(
                    `
          SELECT
            p.erp_id,
            p.sku,
            p.description,

            COALESCE(
              p.deleted_erp,
              false
            ) AS product_deleted_erp,

            EXISTS (
              SELECT 1
              FROM product_barcodes pb
              WHERE
                pb.product_sku =
                p.sku
            ) AS has_barcode

          FROM products p
          WHERE
            p.erp_id =
            ANY($1::bigint[])
          `,
                    [erpProductIds]
                );

            for (
                const product
                of productsResult.rows
            ) {
                productMap.set(
                    String(product.erp_id),
                    {
                        erp_id:
                            Number(
                                product.erp_id
                            ),

                        sku:
                            product.sku ||
                            null,

                        description:
                            product.description ||
                            null,

                        deleted_erp:
                            product
                                .product_deleted_erp ===
                            true,

                        /*
                         * Mantiene tu lógica actual:
                         *
                         * product_exists significa que
                         * el producto tiene barcode.
                         */
                        product_exists:
                            product.has_barcode ===
                            true
                    }
                );
            }
        }

        // =========================================================
        // 8. OBTENER LÍNEAS ACTIVAS
        // =========================================================

        /*
         * En Alegra todas las líneas utilizan:
         *
         * erp_line_id = NULL
         *
         * Por eso una línea activa se identifica con:
         *
         * deleted_erp = false
         */
        const activeWmsValues =
            wmsValues.filter(
                (line) =>
                    line.deleted_erp !== true
            );

        /*
         * Para líneas antiguas que todavía no tienen
         * erp_line_key, generamos temporalmente una clave
         * utilizando sus valores actuales.
         */
        const wmsExactOccurrences =
            new Map();

        for (
            const wmsLine
            of activeWmsValues
        ) {
            const exactBaseKey =
                createExactBaseKey({
                    erpProductId:
                        wmsLine.erp_product_id,

                    unitPrice:
                        wmsLine.unit_price,

                    quantity:
                        wmsLine.ordered_qty
                });

            const occurrence =
                (
                    wmsExactOccurrences.get(
                        exactBaseKey
                    ) || 0
                ) + 1;

            wmsExactOccurrences.set(
                exactBaseKey,
                occurrence
            );

            wmsLine.comparison_line_key =
                wmsLine.erp_line_key ||
                `${exactBaseKey}|${occurrence}`;
        }

        // =========================================================
        // 9. PREPARAR CLASIFICACIÓN
        // =========================================================

        const linesToRemoveMap =
            new Map();

        const linesToInsertMap =
            new Map();

        const linesToUpdateMap =
            new Map();

        const matchedWmsIds =
            new Set();

        const matchedAlegraKeys =
            new Set();

        // =========================================================
        // PASO 1:
        // COINCIDENCIA EXACTA
        //
        // producto + precio + cantidad + ocurrencia
        // =========================================================

        const alegraByExactKey =
            new Map(
                values.map(
                    (line) => [
                        line.erp_line_key,
                        line
                    ]
                )
            );

        for (
            const wmsLine
            of activeWmsValues
        ) {
            const alegraLine =
                alegraByExactKey.get(
                    wmsLine.comparison_line_key
                );

            if (!alegraLine) {
                continue;
            }

            linesToUpdateMap.set(
                String(wmsLine.id),
                {
                    wmsLine,
                    erpLine:
                        alegraLine,
                    reason:
                        "EXACT_PRODUCT_PRICE_QUANTITY_MATCH"
                }
            );

            matchedWmsIds.add(
                String(wmsLine.id)
            );

            matchedAlegraKeys.add(
                alegraLine.erp_line_key
            );

            console.log(
                "✅ MATCH EXACTO:",
                {
                    purchase_order_line_id:
                        wmsLine.id,

                    erp_line_key:
                        alegraLine.erp_line_key,

                    erp_product_id:
                        alegraLine.erp_product_id,

                    unit_price:
                        alegraLine.unit_price,

                    quantity:
                        alegraLine.qty
                }
            );
        }

        // =========================================================
        // PASO 2:
        // MISMA POSICIÓN + PRODUCTO + PRECIO
        //
        // Permite detectar cambios de cantidad.
        // =========================================================

        for (
            const alegraLine
            of values
        ) {
            if (
                matchedAlegraKeys.has(
                    alegraLine.erp_line_key
                )
            ) {
                continue;
            }

            const wmsCandidate =
                activeWmsValues.find(
                    (wmsLine) => {
                        if (
                            matchedWmsIds.has(
                                String(wmsLine.id)
                            )
                        ) {
                            return false;
                        }

                        const samePosition =
                            String(
                                wmsLine.line_number
                            ) ===
                            String(
                                alegraLine
                                    .original_line_number
                            );

                        const sameProduct =
                            Number(
                                wmsLine.erp_product_id
                            ) ===
                            Number(
                                alegraLine.erp_product_id
                            );

                        const samePrice =
                            normalizeDecimal(
                                wmsLine.unit_price,
                                6
                            ) ===
                            normalizeDecimal(
                                alegraLine.unit_price,
                                6
                            );

                        return (
                            samePosition &&
                            sameProduct &&
                            samePrice
                        );
                    }
                );

            if (!wmsCandidate) {
                continue;
            }

            linesToUpdateMap.set(
                String(
                    wmsCandidate.id
                ),
                {
                    wmsLine:
                        wmsCandidate,

                    erpLine:
                        alegraLine,

                    reason:
                        "POSITION_PRODUCT_PRICE_MATCH"
                }
            );

            matchedWmsIds.add(
                String(
                    wmsCandidate.id
                )
            );

            matchedAlegraKeys.add(
                alegraLine.erp_line_key
            );

            console.log(
                "🔄 MATCH POR POSICIÓN, PRODUCTO Y PRECIO:",
                {
                    purchase_order_line_id:
                        wmsCandidate.id,

                    line_number:
                        alegraLine
                            .original_line_number,

                    previous_quantity:
                        wmsCandidate.ordered_qty,

                    new_quantity:
                        alegraLine.qty,

                    price:
                        alegraLine.unit_price
                }
            );
        }

        // =========================================================
        // PASO 3:
        // PRODUCTO + PRECIO ÚNICOS
        //
        // Permite reconocer una línea que cambió de posición.
        // =========================================================

        const unmatchedWmsLines =
            activeWmsValues.filter(
                (wmsLine) =>
                    !matchedWmsIds.has(
                        String(wmsLine.id)
                    )
            );

        const unmatchedAlegraLines =
            values.filter(
                (alegraLine) =>
                    !matchedAlegraKeys.has(
                        alegraLine.erp_line_key
                    )
            );

        for (
            const alegraLine
            of unmatchedAlegraLines
        ) {
            if (
                matchedAlegraKeys.has(
                    alegraLine.erp_line_key
                )
            ) {
                continue;
            }

            const wmsCandidates =
                unmatchedWmsLines.filter(
                    (wmsLine) => {
                        if (
                            matchedWmsIds.has(
                                String(wmsLine.id)
                            )
                        ) {
                            return false;
                        }

                        return (
                            wmsLine
                                .product_price_key ===
                            alegraLine
                                .product_price_key
                        );
                    }
                );

            const alegraCandidates =
                unmatchedAlegraLines.filter(
                    (candidate) => {
                        if (
                            matchedAlegraKeys.has(
                                candidate.erp_line_key
                            )
                        ) {
                            return false;
                        }

                        return (
                            candidate
                                .product_price_key ===
                            alegraLine
                                .product_price_key
                        );
                    }
                );

            /*
             * Solamente hacemos este match cuando
             * existe una sola candidata en cada lado.
             *
             * Así evitamos emparejamientos ambiguos.
             */
            if (
                wmsCandidates.length !== 1 ||
                alegraCandidates.length !== 1
            ) {
                continue;
            }

            const wmsLine =
                wmsCandidates[0];

            linesToUpdateMap.set(
                String(wmsLine.id),
                {
                    wmsLine,
                    erpLine:
                        alegraLine,
                    reason:
                        "UNIQUE_PRODUCT_PRICE_MATCH"
                }
            );

            matchedWmsIds.add(
                String(wmsLine.id)
            );

            matchedAlegraKeys.add(
                alegraLine.erp_line_key
            );

            console.log(
                "🔄 MATCH POR PRODUCTO Y PRECIO ÚNICOS:",
                {
                    purchase_order_line_id:
                        wmsLine.id,

                    previous_line_number:
                        wmsLine.line_number,

                    new_line_number:
                        alegraLine
                            .original_line_number,

                    erp_product_id:
                        alegraLine.erp_product_id,

                    unit_price:
                        alegraLine.unit_price
                }
            );
        }

        // =========================================================
        // PASO 4:
        // LÍNEAS LOCALES ELIMINADAS DE ALEGRA
        // =========================================================

        for (
            const wmsLine
            of activeWmsValues
        ) {
            if (
                matchedWmsIds.has(
                    String(wmsLine.id)
                )
            ) {
                continue;
            }

            linesToRemoveMap.set(
                String(wmsLine.id),
                {
                    wmsLine,
                    reason:
                        "REMOVED_FROM_ALEGRA"
                }
            );
        }

        // =========================================================
        // PASO 5:
        // LÍNEAS NUEVAS EN ALEGRA
        // =========================================================

        for (
            const alegraLine
            of values
        ) {
            if (
                matchedAlegraKeys.has(
                    alegraLine.erp_line_key
                )
            ) {
                continue;
            }

            linesToInsertMap.set(
                alegraLine.erp_line_key,
                alegraLine
            );
        }

        const linesToRemove = [
            ...linesToRemoveMap.values()
        ];

        const linesToInsert = [
            ...linesToInsertMap.values()
        ];

        const linesToUpdate = [
            ...linesToUpdateMap.values()
        ];

        console.log("");
        console.log(
            "📊 CLASIFICACIÓN:"
        );

        console.log(
            "🗑️ Para eliminar o archivar:",
            linesToRemove.length
        );

        console.log(
            "✏️ Para actualizar:",
            linesToUpdate.length
        );

        console.log(
            "➕ Para insertar:",
            linesToInsert.length
        );

        // =========================================================
        // 10. ELIMINAR O ARCHIVAR
        // =========================================================

        for (
            const item
            of linesToRemove
        ) {
            const {
                wmsLine,
                reason
            } = item;

            const receiptInfoResult =
                await clientDb.query(
                    `
          SELECT
            COUNT(*)::int
              AS receipt_count,

            COALESCE(
              SUM(received_qty),
              0
            )::numeric
              AS total_received,

            COUNT(*) FILTER (
              WHERE COALESCE(
                received_qty,
                0
              ) > 0
            )::int
              AS received_lines_count

          FROM receipt_lines
          WHERE
            purchase_order_line_id =
            $1
          `,
                    [wmsLine.id]
                );

            const receiptCount =
                toNumber(
                    receiptInfoResult
                        .rows[0]
                        .receipt_count
                );

            const receiptTotal =
                toNumber(
                    receiptInfoResult
                        .rows[0]
                        .total_received
                );

            const totalReceived =
                Math.max(
                    receiptTotal,
                    toNumber(
                        wmsLine.received_qty
                    ),
                    toNumber(
                        wmsLine.total_received
                    )
                );

            const receivedLinesCount =
                toNumber(
                    receiptInfoResult
                        .rows[0]
                        .received_lines_count
                );

            const hasReceivedQuantity =
                receivedLinesCount > 0 ||
                totalReceived > 0;

            console.log(
                "🗑️ Procesando línea:",
                {
                    purchase_order_line_id:
                        wmsLine.id,

                    erp_line_key:
                        wmsLine.erp_line_key,

                    erp_product_id:
                        wmsLine.erp_product_id,

                    sku:
                        wmsLine.sku,

                    receiptCount,
                    totalReceived,
                    reason
                }
            );

            // -------------------------------------------------------
            // SIN RECEPCIÓN: ELIMINAR
            // -------------------------------------------------------

            if (!hasReceivedQuantity) {
                const deletedReceiptLines =
                    await clientDb.query(
                        `
            DELETE FROM receipt_lines
            WHERE
              purchase_order_line_id =
              $1
              AND COALESCE(
                received_qty,
                0
              ) <= 0
            RETURNING id
            `,
                        [wmsLine.id]
                    );

                console.log(
                    "🧹 Receipt lines vacías eliminadas:",
                    deletedReceiptLines.rowCount
                );

                const deleteResult =
                    await clientDb.query(
                        `
            DELETE FROM purchase_order_lines
            WHERE id = $1
            RETURNING id
            `,
                        [wmsLine.id]
                    );

                if (
                    deleteResult.rowCount > 0
                ) {
                    summary.deleted += 1;

                    console.log(
                        `✅ Línea ${wmsLine.id} eliminada`
                    );
                }

                continue;
            }

            // -------------------------------------------------------
            // CON RECEPCIÓN: ARCHIVAR
            // -------------------------------------------------------

            const archiveResult =
                await clientDb.query(
                    `
          UPDATE purchase_order_lines
          SET
            ordered_qty = $2,
            received_qty = $2,
            deleted_erp = true,
            erp_line_id = NULL,
            erp_line_key = NULL
          WHERE id = $1
          RETURNING
            id,
            line_number,
            ordered_qty,
            received_qty,
            deleted_erp,
            erp_line_id,
            erp_line_key
          `,
                    [
                        wmsLine.id,
                        totalReceived
                    ]
                );

            if (
                archiveResult.rowCount > 0
            ) {
                summary.archived += 1;

                console.log(
                    `📚 Línea ${wmsLine.id} archivada:`,
                    archiveResult.rows[0]
                );
            }
        }

        // =========================================================
        // 11. LIBERAR TEMPORALMENTE LAS CLAVES A ACTUALIZAR
        // =========================================================

        /*
         * Esto evita errores del índice UNIQUE cuando
         * dos líneas intercambian claves durante el UPDATE.
         */
        const updateIds =
            linesToUpdate.map(
                (item) =>
                    Number(
                        item.wmsLine.id
                    )
            );

        if (updateIds.length > 0) {
            await clientDb.query(
                `
        UPDATE purchase_order_lines
        SET erp_line_key = NULL
        WHERE id =
          ANY($1::bigint[])
        `,
                [updateIds]
            );
        }

        // =========================================================
        // 12. ACTUALIZAR LÍNEAS EXISTENTES
        // =========================================================

        for (
            const item
            of linesToUpdate
        ) {
            const {
                wmsLine,
                erpLine,
                reason
            } = item;

            const product =
                productMap.get(
                    String(
                        erpLine.erp_product_id
                    )
                );

            const erpQty =
                toNumber(
                    erpLine.qty
                );

            const actualReceived =
                Math.max(
                    toNumber(
                        wmsLine.received_qty
                    ),
                    toNumber(
                        wmsLine.total_received
                    )
                );

            /*
             * La cantidad ordenada nunca puede
             * quedar por debajo de lo recibido.
             */
            const newOrderedQty =
                Math.max(
                    erpQty,
                    actualReceived
                );

            const newLineNumber =
                String(
                    erpLine
                        .original_line_number
                );

            const newDescription =
                product?.description ||
                erpLine.description ||
                erpLine.name ||
                wmsLine.description ||
                "UNKNOWN";

            const newSku =
                product?.sku ||
                erpLine.reference ||
                wmsLine.sku ||
                null;

            const newProductExists =
                product
                    ? product
                        .product_exists === true
                    : wmsLine
                        .product_exists === true;

            const newErpOrderId =
                Number(
                    erpLine.erp_order_id
                );

            const newErpProductId =
                Number(
                    erpLine.erp_product_id
                );

            const newUnitPrice =
                toNumber(
                    erpLine.unit_price
                );

            const newDiscount =
                toNumber(
                    erpLine.discount
                );

            const newTaxes =
                normalizeTaxes(
                    erpLine.taxes
                );

            const newErpLineKey =
                erpLine.erp_line_key;

            const changed =
                String(
                    wmsLine.line_number
                ) !==
                newLineNumber ||

                toNumber(
                    wmsLine.ordered_qty
                ) !==
                newOrderedQty ||

                toNumber(
                    wmsLine.received_qty
                ) !==
                actualReceived ||

                normalizeDecimal(
                    wmsLine.unit_price,
                    6
                ) !==
                normalizeDecimal(
                    newUnitPrice,
                    6
                ) ||

                normalizeDecimal(
                    wmsLine.discount,
                    6
                ) !==
                normalizeDecimal(
                    newDiscount,
                    6
                ) ||

                normalizeTaxesForComparison(
                    wmsLine.taxes
                ) !==
                normalizeTaxesForComparison(
                    newTaxes
                ) ||

                wmsLine.erp_line_key !==
                newErpLineKey ||

                Number(
                    wmsLine.erp_order_id
                ) !==
                newErpOrderId ||

                Number(
                    wmsLine.erp_product_id
                ) !==
                newErpProductId ||

                wmsLine.description !==
                newDescription ||

                wmsLine.sku !==
                newSku ||

                wmsLine.product_exists !==
                newProductExists ||

                wmsLine.deleted_erp ===
                true;

            if (!changed) {
                /*
                 * La clave fue temporalmente puesta en NULL,
                 * por eso debemos restaurarla aunque no existan
                 * otros cambios.
                 */
                await clientDb.query(
                    `
          UPDATE purchase_order_lines
          SET erp_line_key = $2
          WHERE id = $1
          `,
                    [
                        wmsLine.id,
                        newErpLineKey
                    ]
                );

                summary.unchanged += 1;

                console.log(
                    `⏭️ Línea ${wmsLine.id} sin cambios`
                );

                continue;
            }

            console.log(
                `✏️ Actualizando línea ${wmsLine.id}:`,
                {
                    reason,

                    previous_erp_line_key:
                        wmsLine.erp_line_key,

                    new_erp_line_key:
                        newErpLineKey,

                    previous_line_number:
                        wmsLine.line_number,

                    new_line_number:
                        newLineNumber,

                    previous_ordered_qty:
                        wmsLine.ordered_qty,

                    alegra_qty:
                        erpQty,

                    actual_received:
                        actualReceived,

                    new_ordered_qty:
                        newOrderedQty,

                    previous_unit_price:
                        wmsLine.unit_price,

                    new_unit_price:
                        newUnitPrice,

                    final_result:
                        `${newOrderedQty}/${actualReceived}`,

                    sku:
                        newSku
                }
            );

            const updateResult =
                await clientDb.query(
                    `
    UPDATE purchase_order_lines
    SET
      line_number = $2,
      description = $3,
      ordered_qty = $4,
      received_qty = $5,
      unit_price = $6,
      discount = $7,
      taxes = $8::jsonb,
      erp_line_id = NULL,
      erp_line_key = $9,
      erp_order_id = $10,
      erp_product_id = $11,
      sku = $12,
      product_exists = $13,
      deleted_erp = false
    WHERE id = $1
    RETURNING
      id,
      line_number,
      erp_line_id,
      erp_line_key,
      erp_order_id,
      erp_product_id,
      sku,
      unit_price,
      discount,
      taxes,
      ordered_qty,
      received_qty,
      deleted_erp
    `,
                    [
                        wmsLine.id,                    // $1
                        newLineNumber,                 // $2
                        newDescription,                // $3
                        newOrderedQty,                 // $4
                        actualReceived,                // $5
                        newUnitPrice,                  // $6
                        newDiscount,                   // $7
                        JSON.stringify(newTaxes),      // $8
                        newErpLineKey,                 // $9
                        newErpOrderId,                 // $10
                        newErpProductId,               // $11
                        newSku,                        // $12
                        newProductExists               // $13
                    ]
                );

            if (
                updateResult.rowCount > 0
            ) {
                summary.updated += 1;

                console.log(
                    "✅ Línea actualizada:",
                    updateResult.rows[0]
                );
            }
        }

        // =========================================================
        // 13. INSERTAR LÍNEAS NUEVAS
        // =========================================================

        for (
            const erpLine
            of linesToInsert
        ) {
            const existingLineResult =
                await clientDb.query(
                    `
          SELECT
            id,
            erp_line_key,
            erp_product_id,
            unit_price,
            ordered_qty,
            received_qty
          FROM purchase_order_lines
          WHERE purchase_order_id = $1
            AND erp_line_key = $2
            AND COALESCE(
              deleted_erp,
              false
            ) = false
          FOR UPDATE
          `,
                    [
                        purchaseOrderId,
                        erpLine.erp_line_key
                    ]
                );

            if (
                existingLineResult.rowCount > 0
            ) {
                console.warn(
                    "⚠️ INSERT OMITIDO: la clave ya existe:",
                    existingLineResult.rows[0]
                );

                continue;
            }

            const product =
                productMap.get(
                    String(
                        erpLine.erp_product_id
                    )
                );

            const sku =
                product?.sku ||
                erpLine.reference ||
                null;

            const description =
                product?.description ||
                erpLine.description ||
                erpLine.name ||
                "UNKNOWN";

            const productExists =
                product?.product_exists ===
                true;

            const lineNumber =
                String(
                    erpLine
                        .original_line_number
                );

            console.log(
                "➕ Insertando línea:",
                {
                    purchase_order_id:
                        purchaseOrderId,

                    line_number:
                        lineNumber,

                    erp_line_id:
                        null,

                    erp_line_key:
                        erpLine.erp_line_key,

                    erp_order_id:
                        erpLine.erp_order_id,

                    erp_product_id:
                        erpLine.erp_product_id,

                    sku,

                    unit_price:
                        erpLine.unit_price,

                    ordered_qty:
                        erpLine.qty,

                    product_exists:
                        productExists
                }
            );

            const insertResult =
  await clientDb.query(
    `
    INSERT INTO purchase_order_lines (
      purchase_order_id,
      line_number,
      description,
      ordered_qty,
      received_qty,
      unit_price,
      discount,
      taxes,
      deleted_erp,
      erp_line_id,
      erp_line_key,
      erp_order_id,
      erp_product_id,
      sku,
      product_exists
    )
    VALUES (
      $1,
      $2,
      $3,
      $4,
      0,
      $5,
      $6,
      $7::jsonb,
      false,
      NULL,
      $8,
      $9,
      $10,
      $11,
      $12
    )
    RETURNING
      id,
      line_number,
      erp_line_id,
      erp_line_key,
      erp_order_id,
      erp_product_id,
      sku,
      unit_price,
      discount,
      taxes,
      ordered_qty,
      received_qty,
      deleted_erp
    `,
    [
      purchaseOrderId,              // $1
      lineNumber,                   // $2
      description,                  // $3
      erpLine.qty,                  // $4
      erpLine.unit_price,           // $5
      erpLine.discount,             // $6
      JSON.stringify(
        normalizeTaxes(
          erpLine.taxes
        )
      ),                            // $7
      erpLine.erp_line_key,         // $8
      erpLine.erp_order_id,         // $9
      erpLine.erp_product_id,       // $10
      sku,                          // $11
      productExists                 // $12
    ]
  );

            if (
                insertResult.rowCount > 0
            ) {
                summary.inserted += 1;

                console.log(
                    "✅ Línea insertada:",
                    insertResult.rows[0]
                );
            }
        }

        // =========================================================
        // 14. CONSULTAR RESULTADO FINAL
        // =========================================================

        const finalLinesResult =
            await clientDb.query(
                `
        SELECT
          pol.id,
          pol.line_number,
          pol.erp_line_id,
          pol.erp_line_key,
          pol.erp_order_id,
          pol.erp_product_id,
          pol.sku,
          pol.description,
          pol.unit_price,
          pol.discount,
pol.taxes,
          pol.ordered_qty,
          pol.received_qty,
          pol.product_exists,
          pol.deleted_erp

        FROM purchase_order_lines pol

        WHERE
          pol.purchase_order_id =
          $1

        ORDER BY
          CASE
            WHEN pol.line_number
              ~ '^[0-9]+$'
            THEN
              pol.line_number::integer
            ELSE
              999999999
          END,
          pol.id
        `,
                [purchaseOrderId]
            );

        // =========================================================
        // 15. COMMIT
        // =========================================================

        await clientDb.query(
            "COMMIT"
        );

        transactionStarted = false;

        console.log("");
        console.log(
            "🟩🟩🟩 ========================================"
        );
        console.log(
            "✅ SYNC DE LÍNEAS ALEGRA TERMINADO"
        );
        console.log(
            "🟩🟩🟩 ========================================"
        );

        console.log(
            "📊 RESUMEN:",
            summary
        );

        console.log(
            "📦 LÍNEAS FINALES:"
        );

        console.dir(
            finalLinesResult.rows,
            {
                depth: null
            }
        );

        return {
            success: true,
            purchaseOrderId,
            alegraOrderId,
            summary,
            lines:
                finalLinesResult.rows
        };
    } catch (error) {
        if (transactionStarted) {
            try {
                await clientDb.query(
                    "ROLLBACK"
                );

                console.log(
                    "↩️ ROLLBACK ejecutado correctamente"
                );
            } catch (rollbackError) {
                console.error(
                    "❌ Error ejecutando ROLLBACK:",
                    rollbackError
                );
            }
        }

        console.error("");
        console.error(
            "🟥🟥🟥 ========================================"
        );
        console.error(
            "❌ ERROR SINCRONIZANDO LÍNEAS DE ALEGRA"
        );
        console.error(
            "🟥🟥🟥 ========================================"
        );

        console.error(
            "Mensaje:",
            error.message
        );

        console.error(
            "Stack:",
            error.stack
        );

        throw error;
    }
}