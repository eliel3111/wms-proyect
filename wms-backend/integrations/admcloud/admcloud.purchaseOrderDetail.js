import db from "../../db.js";
import admcloudClient from "./admcloudClient.js";


// ============================================================
// HELPERS
// ============================================================

function toNumber(value, fallback = 0) {

  const parsed = Number(value);

  return Number.isFinite(parsed)
    ? parsed
    : fallback;
}


function toTextId(value) {

  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }

  const normalized =
    String(value).trim();

  return normalized || null;
}


function normalizePurchaseOrderIds(
  purchaseOrderIds
) {

  if (!Array.isArray(purchaseOrderIds)) {

    throw new Error(
      "purchaseOrderIds debe ser un arreglo"
    );

  }


  const normalized = [
    ...new Set(

      purchaseOrderIds

        .map(
          (id) =>
            String(id ?? "").trim()
        )

        .filter(Boolean)

    )
  ];


  if (normalized.length === 0) {

    throw new Error(
      "purchaseOrderIds no puede estar vacío"
    );

  }


  /*
   * Estos son IDs internos de PostgreSQL/WMS,
   * no los GUID de Adm Cloud.
   */
  for (const id of normalized) {

    if (!/^\d+$/.test(id)) {

      throw new Error(
        `purchase_order.id inválido: ${id}`
      );

    }

  }


  return normalized;
}



// ============================================================
// 1. BUSCAR DETALLE COMPLETO EN ADM CLOUD
// ============================================================

export async function getAdmCloudPurchaseOrderDetail(
  purchaseOrderId
) {

  const id =
    toTextId(
      purchaseOrderId
    );


  if (!id) {

    throw new Error(
      "purchaseOrderId es requerido"
    );

  }


  console.log("");
  console.log("🧾 ========================================");
  console.log("🧾 BUSCANDO DETALLE PURCHASE ORDER");
  console.log("🆔 ERP ORDER ID:", id);
  console.log("🧾 ========================================");


  const response =
    await admcloudClient.get(
      `/PurchaseOrders/${id}`
    );


  const purchaseOrder =
    response.data?.data ??
    response.data;


  if (
    !purchaseOrder ||
    typeof purchaseOrder !== "object"
  ) {

    throw new Error(
      `Adm Cloud no devolvió detalle válido para ${id}`
    );

  }


  if (!purchaseOrder.ID) {

    throw new Error(
      `Adm Cloud devolvió una OC sin ID para ${id}`
    );

  }


  console.log(
    "📄 DocID:",
    purchaseOrder.DocID
  );


  console.log(
    "📦 Items:",
    Array.isArray(
      purchaseOrder.Items
    )
      ? purchaseOrder.Items.length
      : 0
  );


  return purchaseOrder;
}



// ============================================================
// 2. RECIBIR GRUPO DE IDs INTERNOS DEL WMS
// ============================================================
//
// Ejemplo:
//
// [594, 595, 600]
//
// Busca:
// purchase_orders.id = 594
//
// obtiene:
// purchase_orders.erp_order_id
//
// llama:
// getAdmCloudPurchaseOrderDetail(erp_order_id)
//
// y finalmente:
// syncAdmCloudPurchaseOrderLines(...)
//
// ============================================================

export async function syncAdmCloudPurchaseOrderLinesByIds(
  purchaseOrderIds
) {

  const ids =
    normalizePurchaseOrderIds(
      purchaseOrderIds
    );


  console.log("");
  console.log("🟦🟦🟦 ========================================");
  console.log("🟦 SYNC DETALLE ADM CLOUD POR IDS WMS");
  console.log("📥 IDs recibidos:", ids);
  console.log("🟦🟦🟦 ========================================");



  // ==========================================================
  // BUSCAR TODAS LAS OC LOCALES EN UNA SOLA QUERY
  // ==========================================================

  const purchaseOrdersResult =
    await db.query(
      `
      SELECT
        id,
        purchase_order_number,
        erp_order_id,
        status,
        deleted_erp

      FROM purchase_orders

      WHERE id =
        ANY($1::BIGINT[])
      `,
      [ids]
    );


  const orderMap =
    new Map(

      purchaseOrdersResult.rows.map(
        (row) => [
          String(row.id),
          row
        ]
      )

    );


  const summary = {

    requested:
      ids.length,

    found:
      purchaseOrdersResult.rowCount,

    synced: 0,

    skipped: 0,

    failed: 0,

    missing: 0

  };


  const results = [];


  // ==========================================================
  // UNA CONEXIÓN DB PARA PROCESAR EL GRUPO
  // ==========================================================

  const clientDb =
    await db.connect();


  try {

    // ========================================================
    // PROCESAR CADA ID SOLICITADO
    // ========================================================

    for (const wmsId of ids) {

      const localOrder =
        orderMap.get(
          wmsId
        );


      // ------------------------------------------------------
      // NO EXISTE EN purchase_orders
      // ------------------------------------------------------

      if (!localOrder) {

        summary.missing += 1;


        results.push({

          purchaseOrderId:
            wmsId,

          success:
            false,

          reason:
            "PURCHASE_ORDER_NOT_FOUND"

        });


        continue;
      }


      // ------------------------------------------------------
      // OBTENER erp_order_id
      // ------------------------------------------------------

      const erpOrderId =
        toTextId(
          localOrder.erp_order_id
        );


      if (!erpOrderId) {

        summary.skipped += 1;


        results.push({

          purchaseOrderId:
            wmsId,

          purchaseOrderNumber:
            localOrder.purchase_order_number,

          success:
            false,

          skipped:
            true,

          reason:
            "ERP_ORDER_ID_MISSING"

        });


        continue;
      }


      console.log("");
      console.log("🔵 ========================================");
      console.log(
        "🔵 PROCESANDO WMS PO:",
        wmsId
      );
      console.log(
        "📄 Número:",
        localOrder.purchase_order_number
      );
      console.log(
        "🆔 ERP ID:",
        erpOrderId
      );
      console.log("🔵 ========================================");


      try {

        // ====================================================
        // LLAMAR ADM CLOUD
        // ====================================================

        const detailResult =
          await getAdmCloudPurchaseOrderDetail(
            erpOrderId
          );


        /*
         * Compatible si getAdmCloudPurchaseOrderDetail
         * devuelve directamente la OC o un objeto { data }.
         */
        const admOrder =
          detailResult?.data?.ID
            ? detailResult.data
            : detailResult;


        // ====================================================
        // VALIDAR QUE ADM CLOUD DEVOLVIÓ LA MISMA OC
        // ====================================================

        const returnedErpOrderId =
          toTextId(
            admOrder.ID
          );


        if (
          returnedErpOrderId !==
          erpOrderId
        ) {

          throw new Error(
            `Adm Cloud devolvió ID ${returnedErpOrderId}, ` +
            `pero esperábamos ${erpOrderId}`
          );

        }


        // ====================================================
        // SINCRONIZAR SUS ITEMS
        // ====================================================

        const lineResult =
          await syncAdmCloudPurchaseOrderLines(
            clientDb,
            admOrder,
            wmsId
          );


        if (
          lineResult?.skipped
        ) {

          summary.skipped += 1;

        } else {

          summary.synced += 1;

        }


        results.push({

          purchaseOrderId:
            wmsId,

          purchaseOrderNumber:
            localOrder.purchase_order_number,

          erpOrderId,

          docId:
            admOrder.DocID ??
            null,

          success:
            true,

          ...lineResult

        });


      } catch (error) {

        summary.failed += 1;


        console.error(
          `❌ Error sincronizando WMS PO ${wmsId}`,
          error
        );


        results.push({

          purchaseOrderId:
            wmsId,

          purchaseOrderNumber:
            localOrder.purchase_order_number,

          erpOrderId,

          success:
            false,

          error:
            error.message

        });

      }

    }


  } finally {

    clientDb.release();

  }


  // ==========================================================
  // RESULTADO GENERAL
  // ==========================================================

  return {

    success:
      summary.failed === 0 &&
      summary.missing === 0,

    summary,

    results

  };
}



// ============================================================
// 3. SINCRONIZAR ITEMS DE UNA OC ADM CLOUD
// ============================================================

export async function syncAdmCloudPurchaseOrderLines(
  clientDb,
  order,
  purchaseOrderId
) {

  let transactionStarted =
    false;


  const summary = {

    inserted: 0,

    updated: 0,

    deleted: 0,

    archived: 0,

    unchanged: 0

  };


  try {

    // ========================================================
    // VALIDACIONES
    // ========================================================

    if (!clientDb) {

      throw new Error(
        "No se recibió una conexión válida de PostgreSQL"
      );

    }


    if (!order?.ID) {

      throw new Error(
        "La orden de Adm Cloud no tiene order.ID"
      );

    }


    if (!purchaseOrderId) {

      throw new Error(
        "No se recibió purchaseOrderId interno del WMS"
      );

    }


    const admCloudOrderId =
      toTextId(
        order.ID
      );


    const rawLines =
      Array.isArray(order.Items)
        ? order.Items
        : [];


    console.log("");
    console.log("🟥🟥🟥 ========================================");
    console.log("📦 SYNC LÍNEAS OC ADM CLOUD");
    console.log(
      "📌 ERP order ID:",
      admCloudOrderId
    );
    console.log(
      "📌 WMS purchase order ID:",
      purchaseOrderId
    );
    console.log(
      "📌 Items recibidos:",
      rawLines.length
    );
    console.log("🟥🟥🟥 ========================================");



    // ========================================================
    // PROTECCIÓN CONTRA RESPUESTA VACÍA
    // ========================================================

    if (rawLines.length === 0) {

      console.log(
        "⚠️ Adm Cloud no devolvió Items. No se eliminarán líneas."
      );


      return {

        success: true,

        skipped: true,

        reason:
          "ERP_WITHOUT_LINES",

        summary

      };
    }



    // ========================================================
    // ADM CLOUD ITEMS → FORMATO INTERNO
    // ========================================================

    const values =
      rawLines

        .map(
          (line, index) => {

            const erpLineId =
              toTextId(
                line?.ID
              );


            const transId =
              toTextId(
                line?.TransID
              );


            const erpProductId =
              toTextId(
                line?.ItemID
              );


            /*
             * Seguridad:
             * un Item no debería pertenecer a otra OC.
             */
            if (
              transId &&
              transId !== admCloudOrderId
            ) {

              throw new Error(
                `Item ${erpLineId ?? index + 1} pertenece a ` +
                `TransID ${transId}, pero la OC actual es ` +
                `${admCloudOrderId}`
              );

            }


            return {

              erp_line_id:
                erpLineId,

              erp_order_id:
                admCloudOrderId,

              erp_product_id:
                erpProductId,

              qty:
                toNumber(
                  line?.Quantity,
                  0
                ),

              original_line_number:
                toNumber(
                  line?.RowOrder,
                  index + 1
                ) ||
                index + 1,

              description:
                line?.Name
                  ? String(
                      line.Name
                    ).trim()
                  : null,

              sku:
                line?.ItemSKU
                  ? String(
                      line.ItemSKU
                    ).trim()
                  : null,

              uom_id:
                toTextId(
                  line?.UOMID
                ),

              uom_name:
                line?.UOMName
                  ? String(
                      line.UOMName
                    ).trim()
                  : null,

              completed_qty:
                toNumber(
                  line?.CompletedQuantity,
                  0
                ),

              pending_qty:
                toNumber(
                  line?.PendingCompletedQuantity,
                  0
                ),

              closed:
                line?.Closed === true

            };

          }
        )

        /*
         * Igual que tu lógica Citrus:
         * qty 0 deja de ser una línea activa.
         */
        .filter(
          (line) =>
            line.qty > 0
        );


    console.log(
      "📨 ADM CLOUD VALUES:"
    );

    console.dir(
      values,
      {
        depth: null
      }
    );



    // ========================================================
    // VALIDAR ERP_LINE_ID DUPLICADOS
    // ========================================================

    const duplicatedErpLineIds =
      [];


    const seenErpLineIds =
      new Set();


    for (const line of values) {

      if (!line.erp_line_id) {

        throw new Error(
          `Adm Cloud devolvió línea sin ID válido. ` +
          `Posición: ${line.original_line_number}`
        );

      }


      if (
        seenErpLineIds.has(
          line.erp_line_id
        )
      ) {

        duplicatedErpLineIds.push(
          line.erp_line_id
        );

      }


      seenErpLineIds.add(
        line.erp_line_id
      );

    }


    if (
      duplicatedErpLineIds.length >
      0
    ) {

      throw new Error(
        `Adm Cloud devolvió erp_line_id duplicados: ` +
        duplicatedErpLineIds.join(", ")
      );

    }



    // ========================================================
    // TRANSACTION
    // ========================================================

    await clientDb.query(
      "BEGIN"
    );


    transactionStarted =
      true;



    // ========================================================
    // BLOQUEAR purchase_order
    // ========================================================

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
      purchaseOrderLockResult.rows.length ===
      0
    ) {

      throw new Error(
        `No existe purchase_order WMS ID ${purchaseOrderId}`
      );

    }


    const lockedOrder =
      purchaseOrderLockResult.rows[0];


    const localErpOrderId =
      toTextId(
        lockedOrder.erp_order_id
      );


    /*
     * Segunda protección:
     * no permitir actualizar las líneas de otra OC.
     */
    if (
      localErpOrderId &&
      localErpOrderId !==
        admCloudOrderId
    ) {

      throw new Error(
        `La OC WMS ${purchaseOrderId} pertenece al ERP ID ` +
        `${localErpOrderId}, pero recibimos ${admCloudOrderId}`
      );

    }



    // ========================================================
    // OBTENER LÍNEAS EXISTENTES WMS
    // ========================================================

    const wmsResult =
      await clientDb.query(
        `
        SELECT
          pol.id,
          pol.purchase_order_id,
          pol.erp_order_id,
          pol.erp_line_id,
          pol.erp_product_id,
          pol.line_number,
          pol.description,
          pol.ordered_qty,
          pol.received_qty,
          pol.sku,
          pol.product_exists,
          pol.deleted_erp,

          GREATEST(
            COALESCE(
              pol.received_qty,
              0
            ),

            COALESCE(
              receipts.total_received_qty,
              0
            )
          )::numeric
            AS total_received

        FROM purchase_order_lines pol

        LEFT JOIN LATERAL (

          SELECT
            COALESCE(
              SUM(rl.received_qty),
              0
            )::numeric
              AS total_received_qty

          FROM receipt_lines rl

          WHERE
            rl.purchase_order_line_id =
            pol.id

        ) receipts
          ON TRUE

        WHERE
          pol.purchase_order_id = $1

          AND pol.erp_order_id =
            $2::TEXT

        ORDER BY
          CASE
            WHEN pol.line_number ~ '^[0-9]+$'
            THEN pol.line_number::integer
            ELSE 999999999
          END,

          pol.id

        FOR UPDATE OF pol
        `,
        [
          purchaseOrderId,
          admCloudOrderId
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
            toTextId(
              line.erp_order_id
            ),

          erp_line_id:
            toTextId(
              line.erp_line_id
            ),

          erp_product_id:
            toTextId(
              line.erp_product_id
            ),

          ordered_qty:
            toNumber(
              line.ordered_qty,
              0
            ),

          received_qty:
            toNumber(
              line.received_qty,
              0
            ),

          total_received:
            toNumber(
              line.total_received,
              0
            )

        })
      );



    // ========================================================
    // PRODUCTOS
    // ========================================================

    const erpProductIds = [

      ...new Set(

        values

          .map(
            (line) =>
              line.erp_product_id
          )

          .filter(Boolean)

      )

    ];


    const productMap =
      new Map();


    if (
      erpProductIds.length >
      0
    ) {

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
            )
              AS product_deleted_erp,

            EXISTS (

              SELECT 1

              FROM product_barcodes pb

              WHERE
                pb.product_sku =
                p.sku

            ) AS has_barcode

          FROM products p

          WHERE p.erp_id =
            ANY($1::TEXT[])
          `,
          [erpProductIds]
        );


      for (
        const product
        of productsResult.rows
      ) {

        productMap.set(

          String(
            product.erp_id
          ),

          {

            erp_id:
              String(
                product.erp_id
              ),

            sku:
              product.sku ||
              null,

            description:
              product.description ||
              null,

            deleted_erp:
              product.product_deleted_erp ===
              true,

            /*
             * Mantengo exactamente la semántica
             * que usabas en Citrus.
             */
            product_exists:
              product.has_barcode ===
              true

          }

        );

      }

    }



    // ========================================================
    // MAPAS
    // ========================================================

    const activeWmsValues =
      wmsValues.filter(
        (line) =>
          line.erp_line_id !==
          null
      );


    const erpByErpLineId =
      new Map(

        values.map(
          (line) => [

            line.erp_line_id,

            line

          ]
        )

      );


    const linesToRemoveMap =
      new Map();

    const linesToInsertMap =
      new Map();

    const linesToUpdateMap =
      new Map();


    const matchedWmsIds =
      new Set();

    const matchedErpLineIds =
      new Set();



    // ========================================================
    // PASO 1:
    // MISMO ERP_LINE_ID
    // ========================================================

    for (
      const wmsLine
      of activeWmsValues
    ) {

      const erpLine =
        erpByErpLineId.get(
          wmsLine.erp_line_id
        );


      if (!erpLine) {
        continue;
      }


      const wmsProductId =
        wmsLine.erp_product_id;


      const erpProductId =
        erpLine.erp_product_id;


      const productChanged =

        wmsProductId !== null &&

        erpProductId !== null &&

        wmsProductId !==
          erpProductId;


      matchedWmsIds.add(
        String(
          wmsLine.id
        )
      );


      matchedErpLineIds.add(
        erpLine.erp_line_id
      );


      // ------------------------------------------------------
      // ERP LINE SAME, PRODUCT DIFFERENT
      // ------------------------------------------------------

      if (productChanged) {

        linesToRemoveMap.set(

          String(
            wmsLine.id
          ),

          {

            wmsLine,

            reason:
              "PRODUCT_REPLACED"

          }

        );


        linesToInsertMap.set(

          erpLine.erp_line_id,

          erpLine

        );


        continue;
      }


      // ------------------------------------------------------
      // SAME LINE / SAME PRODUCT
      // ------------------------------------------------------

      linesToUpdateMap.set(

        String(
          wmsLine.id
        ),

        {

          wmsLine,

          erpLine,

          reason:
            "ERP_LINE_ID_MATCH"

        }

      );

    }



    // ========================================================
    // PASO 2:
    // MISMO PRODUCTO, NUEVO ERP_LINE_ID
    // ========================================================

    const unmatchedWmsLines =
      activeWmsValues.filter(

        (wmsLine) =>

          !matchedWmsIds.has(
            String(
              wmsLine.id
            )
          )

      );


    const unmatchedErpLines =
      values.filter(

        (erpLine) =>

          !matchedErpLineIds.has(
            erpLine.erp_line_id
          )

      );


    for (
      const erpLine
      of unmatchedErpLines
    ) {

      if (
        matchedErpLineIds.has(
          erpLine.erp_line_id
        )
      ) {
        continue;
      }


      const erpProductId =
        erpLine.erp_product_id;


      if (
        erpProductId === null
      ) {
        continue;
      }


      const wmsCandidates =
        unmatchedWmsLines.filter(
          (wmsLine) => {

            if (
              matchedWmsIds.has(
                String(
                  wmsLine.id
                )
              )
            ) {
              return false;
            }


            return (
              wmsLine.erp_product_id ===
              erpProductId
            );

          }
        );


      const erpCandidates =
        unmatchedErpLines.filter(
          (candidate) => {

            if (
              matchedErpLineIds.has(
                candidate.erp_line_id
              )
            ) {
              return false;
            }


            return (
              candidate.erp_product_id ===
              erpProductId
            );

          }
        );


      if (
        wmsCandidates.length === 1 &&
        erpCandidates.length === 1
      ) {

        const wmsLine =
          wmsCandidates[0];


        console.log(
          "🔄 MISMO PRODUCTO CON NUEVO ERP_LINE_ID:",
          {
            purchase_order_line_id:
              wmsLine.id,

            previous_erp_line_id:
              wmsLine.erp_line_id,

            new_erp_line_id:
              erpLine.erp_line_id,

            erp_product_id:
              erpProductId
          }
        );


        linesToUpdateMap.set(

          String(
            wmsLine.id
          ),

          {

            wmsLine,

            erpLine,

            reason:
              "ERP_LINE_ID_CHANGED"

          }

        );


        matchedWmsIds.add(
          String(
            wmsLine.id
          )
        );


        matchedErpLineIds.add(
          erpLine.erp_line_id
        );

      }

    }



    // ========================================================
    // PASO 3:
    // WMS LINE REMOVED FROM ADM CLOUD
    // ========================================================

    for (
      const wmsLine
      of activeWmsValues
    ) {

      if (
        matchedWmsIds.has(
          String(
            wmsLine.id
          )
        )
      ) {
        continue;
      }


      linesToRemoveMap.set(

        String(
          wmsLine.id
        ),

        {

          wmsLine,

          reason:
            "REMOVED_FROM_ERP"

        }

      );

    }



    // ========================================================
    // PASO 4:
    // NEW ADM CLOUD LINES
    // ========================================================

    for (
      const erpLine
      of values
    ) {

      if (
        matchedErpLineIds.has(
          erpLine.erp_line_id
        )
      ) {
        continue;
      }


      linesToInsertMap.set(

        erpLine.erp_line_id,

        erpLine

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


    console.log(
      "📊 CLASIFICACIÓN:",
      {
        remove:
          linesToRemove.length,

        insert:
          linesToInsert.length,

        update:
          linesToUpdate.length
      }
    );



    // ========================================================
    // REMOVER / ARCHIVAR
    // ========================================================

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
              WHERE
                COALESCE(
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


      const totalReceived =
        toNumber(
          receiptInfoResult
            .rows[0]
            .total_received,
          0
        );


      const receivedLinesCount =
        Number(
          receiptInfoResult
            .rows[0]
            .received_lines_count ||
          0
        );


      console.log(
        "🗑️ Procesando línea removida:",
        {
          purchase_order_line_id:
            wmsLine.id,

          erp_line_id:
            wmsLine.erp_line_id,

          reason,

          totalReceived
        }
      );


      // ------------------------------------------------------
      // SIN RECEPCIÓN REAL → DELETE
      // ------------------------------------------------------

      if (
        receivedLinesCount ===
        0
      ) {

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
          `,
          [wmsLine.id]
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
          deleteResult.rowCount >
          0
        ) {

          summary.deleted +=
            1;

        }


        continue;
      }


      // ------------------------------------------------------
      // YA RECIBIDA → ARCHIVE
      // ------------------------------------------------------

      const archiveResult =
        await clientDb.query(
          `
          UPDATE purchase_order_lines

          SET
            ordered_qty = $2,

            received_qty = $2,

            deleted_erp = TRUE,

            erp_line_id = NULL

          WHERE id = $1

          RETURNING id
          `,
          [
            wmsLine.id,
            totalReceived
          ]
        );


      if (
        archiveResult.rowCount >
        0
      ) {

        summary.archived +=
          1;

      }

    }



    // ========================================================
    // NEXT LINE NUMBER
    // ========================================================

    let maxLineNumber =
      wmsValues.reduce(

        (
          currentMax,
          line
        ) => {

          const parsed =
            Number(
              line.line_number
            );


          if (
            !Number.isFinite(
              parsed
            )
          ) {

            return currentMax;

          }


          return Math.max(
            currentMax,
            parsed
          );

        },

        0
      );



    // ========================================================
    // INSERT
    // ========================================================

    for (
      const erpLine
      of linesToInsert
    ) {

      const existingLineResult =
        await clientDb.query(
          `
          SELECT id

          FROM purchase_order_lines

          WHERE
            purchase_order_id = $1

            AND erp_order_id =
              $2::TEXT

            AND erp_line_id =
              $3::TEXT

          FOR UPDATE
          `,
          [
            purchaseOrderId,
            erpLine.erp_order_id,
            erpLine.erp_line_id
          ]
        );


      if (
        existingLineResult.rowCount >
        0
      ) {

        console.log(
          "⚠️ INSERT OMITIDO: línea ERP ya existe",
          existingLineResult.rows[0]
        );


        continue;
      }


      maxLineNumber += 1;


      const product =

        erpLine.erp_product_id !==
        null

          ? productMap.get(
              erpLine.erp_product_id
            )

          : null;


      /*
       * Si product sync todavía no ocurrió,
       * Adm Cloud ItemSKU sirve como fallback.
       */
      const sku =

        product?.sku ||

        erpLine.sku ||

        null;


      const description =

        product?.description ||

        erpLine.description ||

        "UNKNOWN";


      const productExists =
        product?.product_exists ===
        true;


      const insertResult =
        await clientDb.query(
          `
          INSERT INTO purchase_order_lines
          (
            purchase_order_id,
            line_number,
            description,
            ordered_qty,
            received_qty,
            deleted_erp,
            erp_line_id,
            erp_order_id,
            erp_product_id,
            sku,
            product_exists
          )

          VALUES
          (
            $1,
            $2,
            $3,
            $4,
            0,
            FALSE,
            $5,
            $6,
            $7,
            $8,
            $9
          )

          RETURNING
            id,
            erp_line_id,
            erp_product_id,
            sku,
            ordered_qty
          `,
          [
            purchaseOrderId,
            String(
              maxLineNumber
            ),
            description,
            erpLine.qty,
            erpLine.erp_line_id,
            erpLine.erp_order_id,
            erpLine.erp_product_id,
            sku,
            productExists
          ]
        );


      if (
        insertResult.rowCount >
        0
      ) {

        summary.inserted +=
          1;

      }

    }



    // ========================================================
    // UPDATE
    // ========================================================

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

        erpLine.erp_product_id !==
        null

          ? productMap.get(
              erpLine.erp_product_id
            )

          : null;


      const erpQty =
        toNumber(
          erpLine.qty,
          0
        );


      /*
       * Muy importante:
       *
       * ordered_qty jamás puede quedar por
       * debajo de lo realmente recibido.
       */
      const actualReceived =
        Math.max(

          toNumber(
            wmsLine.received_qty,
            0
          ),

          toNumber(
            wmsLine.total_received,
            0
          )

        );


      const newOrderedQty =
        Math.max(
          erpQty,
          actualReceived
        );


      const newDescription =

        product?.description ||

        erpLine.description ||

        wmsLine.description ||

        "UNKNOWN";


      const newSku =

        product?.sku ||

        erpLine.sku ||

        wmsLine.sku ||

        null;


      const newProductExists =
        product

          ? product
              .product_exists ===
            true

          : wmsLine
              .product_exists ===
            true;


      const newErpLineId =
        erpLine.erp_line_id;


      const newErpOrderId =
        erpLine.erp_order_id;


      const newErpProductId =
        erpLine.erp_product_id;



      // ======================================================
      // DETECTAR CAMBIOS
      // ======================================================

      const changed =

        toNumber(
          wmsLine.ordered_qty,
          0
        ) !==
          newOrderedQty ||

        toNumber(
          wmsLine.received_qty,
          0
        ) !==
          actualReceived ||

        toTextId(
          wmsLine.erp_line_id
        ) !==
          newErpLineId ||

        toTextId(
          wmsLine.erp_order_id
        ) !==
          newErpOrderId ||

        toTextId(
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

        summary.unchanged +=
          1;


        continue;
      }


      console.log(
        `✏️ Actualizando línea ${wmsLine.id}:`,
        {
          reason,

          previous_erp_line_id:
            wmsLine.erp_line_id,

          new_erp_line_id:
            newErpLineId,

          previous_ordered_qty:
            wmsLine.ordered_qty,

          admcloud_qty:
            erpQty,

          actual_received:
            actualReceived,

          new_ordered_qty:
            newOrderedQty,

          sku:
            newSku
        }
      );


      const updateResult =
        await clientDb.query(
          `
          UPDATE purchase_order_lines

          SET
            description = $2,

            ordered_qty = $3,

            received_qty = $4,

            erp_line_id = $5,

            erp_order_id = $6,

            erp_product_id = $7,

            sku = $8,

            product_exists = $9,

            deleted_erp = FALSE

          WHERE id = $1

          RETURNING
            id,
            line_number,
            erp_line_id,
            erp_order_id,
            erp_product_id,
            sku,
            ordered_qty,
            received_qty,
            deleted_erp
          `,
          [
            wmsLine.id,
            newDescription,
            newOrderedQty,
            actualReceived,
            newErpLineId,
            newErpOrderId,
            newErpProductId,
            newSku,
            newProductExists
          ]
        );


      if (
        updateResult.rowCount >
        0
      ) {

        summary.updated +=
          1;

      }

    }



    // ========================================================
    // FINAL STATE
    // ========================================================

    const finalLinesResult =
      await clientDb.query(
        `
        SELECT
          pol.id,
          pol.line_number,
          pol.erp_line_id,
          pol.erp_order_id,
          pol.erp_product_id,
          pol.sku,
          pol.ordered_qty,
          pol.received_qty,
          pol.deleted_erp

        FROM purchase_order_lines pol

        WHERE
          pol.purchase_order_id =
          $1

        ORDER BY
          CASE
            WHEN
              pol.line_number ~
              '^[0-9]+$'

            THEN
              pol.line_number::integer

            ELSE
              999999999
          END,

          pol.id
        `,
        [purchaseOrderId]
      );



    // ========================================================
    // COMMIT
    // ========================================================

    await clientDb.query(
      "COMMIT"
    );


    transactionStarted =
      false;


    console.log("");
    console.log("🟩🟩🟩 ========================================");
    console.log("✅ SYNC ADM CLOUD LINES COMPLETADO");
    console.log("📊", summary);
    console.log("🟩🟩🟩 ========================================");


    return {

      success: true,

      purchaseOrderId,

      admCloudOrderId,

      docId:
        order.DocID ??
        null,

      summary,

      lines:
        finalLinesResult.rows

    };


  } catch (error) {

    if (
      transactionStarted
    ) {

      try {

        await clientDb.query(
          "ROLLBACK"
        );

      } catch (
        rollbackError
      ) {

        console.error(
          "❌ Error ejecutando ROLLBACK:",
          rollbackError
        );

      }

    }


    console.error(
      "❌ ERROR SINCRONIZANDO LÍNEAS ADM CLOUD:",
      error
    );


    throw error;

  }
}