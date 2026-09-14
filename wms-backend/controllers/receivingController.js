import { db } from "../db.js";
import { buildReceiptHtml } from "../templates/build-nota-recepcion.js";
import { generatePdf } from "../templates/generate-nota-recepcion.js";
import { randomUUID } from "crypto";
import { uploadPdfToS3 } from "../services/s3UploadPdf.js";
import { sendReceiptEmail } from "../services/sendReceiptEmail.js";
import { runFullSync } from "../cron/cronJobs.js";
import { buildWarehouseEntry, createWarehouseEntry } from "../integrations/citrus/citrus.warehouseEntry.js"
import { syncAllItems, syncAllPurchaseOrders } from "../integrations/citrus/citrus.sync.js";
import {
  alegraPurchaseOrdersService
} from "../integrations/alegra/alegraItemService.js";
import { syncAlegraPurchaseOrderLines } from "../integrations/alegra/alegra.purcharseOrderLines.js"
import {
  syncAdmCloudPurchaseOrderLinesByIds
} from "../integrations/admcloud/admcloud.purchaseOrderDetail.js";
import {
  liquidateAdmCloudReceptions
} from "../integrations/admcloud/liquidateAdmCloudReceptions.js";


/*
function normalizeTaxes(value) {
  if (Array.isArray(value)) {
    return value;
  }

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

  return [];
}*/

export async function CloseReception(req, res) {

  const client =
    await db.connect();


  let transactionStarted =
    false;


  try {

    // =========================================================
    // 1. RECIBIR DATOS
    // =========================================================

    const {
      purchaseOrderIds,
      receiptId,
      receivingLocationId
    } = req.body;


    console.log("");
    console.log("========================================");
    console.log("📦 CLOSE RECEPTION");
    console.log("========================================");

    console.log(
      "📥 BODY:",
      req.body
    );


    // =========================================================
    // 2. NORMALIZAR PURCHASE ORDER IDS
    // =========================================================

    const normalizedPurchaseOrderIds =
      Array.isArray(
        purchaseOrderIds
      )
        ? [
            ...new Set(
              purchaseOrderIds
                .map(
                  id =>
                    Number(id)
                )
                .filter(
                  id =>
                    Number.isInteger(id) &&
                    id > 0
                )
            )
          ]
        : [];


    // =========================================================
    // 3. NORMALIZAR RECEIPT ID
    // =========================================================

    const normalizedReceiptId =
      Number(
        receiptId
      );


    // =========================================================
    // 4. NORMALIZAR LOCATION ID
    // =========================================================

    const normalizedReceivingLocationId =
      Number(
        receivingLocationId
      );


    console.log(
      "📋 Purchase Order IDs:",
      normalizedPurchaseOrderIds
    );


    console.log(
      "🧾 Receipt ID:",
      normalizedReceiptId
    );


    console.log(
      "📍 Receiving Location ID:",
      normalizedReceivingLocationId
    );


    // =========================================================
    // 5. VALIDAR PURCHASE ORDER IDS
    // =========================================================

    if (
      normalizedPurchaseOrderIds.length ===
      0
    ) {

      return res
        .status(400)
        .json({

          success: false,

          title:
            "Orden de Compra requerida",

          code:
            "PURCHASE_ORDER_IDS_REQUIRED",

          message:
            "Debe enviar al menos una orden de compra."

        });

    }


    // =========================================================
    // 6. VALIDAR RECEIPT ID
    // =========================================================

    if (
      !Number.isInteger(
        normalizedReceiptId
      ) ||
      normalizedReceiptId <= 0
    ) {

      return res
        .status(400)
        .json({

          success: false,

          title:
            "Recepción inválida",

          code:
            "RECEIPT_ID_REQUIRED",

          message:
            "El receiptId es requerido y debe ser válido."

        });

    }


    // =========================================================
    // 7. VALIDAR LOCATION ID
    // =========================================================

    if (
      !Number.isInteger(
        normalizedReceivingLocationId
      ) ||
      normalizedReceivingLocationId <= 0
    ) {

      return res
        .status(400)
        .json({

          success: false,

          title:
            "Ubicación inválida",

          code:
            "RECEIVING_LOCATION_REQUIRED",

          message:
            "La ubicación de recepción es requerida."

        });

    }


    // =========================================================
    // 8. BEGIN
    // =========================================================

    await client.query(
      "BEGIN"
    );


    transactionStarted =
      true;


    // =========================================================
    // 9. BUSCAR Y BLOQUEAR TODAS LAS PURCHASE ORDERS
    // =========================================================

    const poResult =
      await client.query(
        `
        SELECT
          id,
          purchase_order_number,
          status,
          supplier_name

        FROM purchase_orders

        WHERE
          id = ANY(
            $1::bigint[]
          )

        ORDER BY
          id

        FOR UPDATE
        `,
        [
          normalizedPurchaseOrderIds
        ]
      );


    console.log("");
    console.log(
      "🔒 PURCHASE ORDERS:"
    );

    console.table(
      poResult.rows
    );


    // =========================================================
    // 10. VALIDAR QUE EXISTAN TODAS LAS PURCHASE ORDERS
    // =========================================================

    const foundPurchaseOrderIds =
      new Set(
        poResult.rows.map(
          po =>
            Number(
              po.id
            )
        )
      );


    const missingPurchaseOrderIds =
      normalizedPurchaseOrderIds.filter(
        id =>
          !foundPurchaseOrderIds.has(
            id
          )
      );


    if (
      missingPurchaseOrderIds.length >
      0
    ) {

      throw new Error(
        `PO_NOT_FOUND_${missingPurchaseOrderIds.join("_")}`
      );

    }


    const purchaseOrders =
      poResult.rows;


    // =========================================================
    // 11. VALIDAR ESTADO DE LAS PURCHASE ORDERS
    // =========================================================

    const invalidPo =
      purchaseOrders.find(
        po => {

          const status =
            String(
              po.status || ""
            )
              .trim()
              .toLowerCase();


          return [
            "cancel",
            "cancelled",
            "canceled",
            "abandoned",
            "closed",
            "completed"
          ].includes(
            status
          );

        }
      );


    if (
      invalidPo
    ) {

      throw new Error(
        `PO_NOT_AVAILABLE_${invalidPo.purchase_order_number}_${invalidPo.status}`
      );

    }


    // =========================================================
    // 12. BUSCAR Y BLOQUEAR EL RECEIPT EXACTO
    // =========================================================

    const receiptResult =
      await client.query(
        `
        SELECT
          id,
          receipt_code,
          status,
          started_at,
          finished_at,
          invoice,
          operator_id

        FROM receipts

        WHERE
          id = $1

        FOR UPDATE
        `,
        [
          normalizedReceiptId
        ]
      );


    if (
      receiptResult.rowCount ===
      0
    ) {

      throw new Error(
        "RECEIPT_NOT_FOUND"
      );

    }


    const receipt =
      receiptResult.rows[0];


    console.log("");
    console.log(
      "🧾 RECEIPT:"
    );

    console.log(
      receipt
    );


    // =========================================================
    // 13. VALIDAR ESTADO DEL RECEIPT
    // =========================================================

    const currentReceiptStatus =
      String(
        receipt.status || ""
      )
        .trim()
        .toLowerCase();


    if (
  [
    "completed",
    "abandoned"
  ].includes(
    currentReceiptStatus
  )
) {
  throw new Error(
    `RECEIPT_NOT_AVAILABLE_${receipt.status}`
  );
}

    // =========================================================
    // 14. VALIDAR RECEIPT ↔ PURCHASE ORDERS
    // =========================================================

    const receiptPoResult =
      await client.query(
        `
        SELECT
          purchase_order_id

        FROM receipt_purchase_orders

        WHERE
          receipt_id = $1

        ORDER BY
          purchase_order_id
        `,
        [
          normalizedReceiptId
        ]
      );


    const receiptPurchaseOrderIds =
      receiptPoResult.rows.map(
        row =>
          Number(
            row.purchase_order_id
          )
      );


    console.log(
      "🔗 POs DEL RECEIPT:",
      receiptPurchaseOrderIds
    );


    const samePurchaseOrderSet =

      receiptPurchaseOrderIds.length ===
        normalizedPurchaseOrderIds.length

      &&

      normalizedPurchaseOrderIds.every(
        id =>
          receiptPurchaseOrderIds.includes(
            id
          )
      );


    if (
      !samePurchaseOrderSet
    ) {

      throw new Error(
        "RECEIPT_DOES_NOT_MATCH_PURCHASE_ORDERS"
      );

    }


    // =========================================================
    // 15. BUSCAR RECEIPT_LINES
    //
    // IMPORTANTE:
    //
    // Estas líneas YA fueron creadas por savingReception().
    //
    // NO insertamos receipt_lines aquí.
    //
    // received_qty =
    // cantidad recibida solamente en ESTE receipt.
    // =========================================================

    const receiptLinesResult =
      await client.query(
        `
        SELECT
          rl.id
            AS receipt_line_id,

          rl.receipt_id,

          rl.purchase_order_line_id,

          rl.sku,

          rl.ordered_qty
            AS receipt_ordered_qty,

          rl.received_qty,

          pol.purchase_order_id,

          pol.ordered_qty
            AS po_ordered_qty

        FROM receipt_lines rl

        INNER JOIN purchase_order_lines pol
          ON pol.id =
             rl.purchase_order_line_id

        WHERE
          rl.receipt_id = $1

        ORDER BY
          pol.purchase_order_id,
          pol.id

        FOR UPDATE OF
          rl,
          pol
        `,
        [
          normalizedReceiptId
        ]
      );


    if (
      receiptLinesResult.rowCount ===
      0
    ) {

      throw new Error(
        "RECEIPT_LINES_NOT_FOUND"
      );

    }


    const receiptLines =
      receiptLinesResult.rows;


    console.log("");
    console.log(
      "📦 RECEIPT LINES:"
    );

    console.table(
      receiptLines
    );


    // =========================================================
    // 16. VALIDAR QUE TODAS LAS RECEIPT LINES
    //     PERTENEZCAN A LAS POs DEL REQUEST
    // =========================================================

    const validPoIds =
      new Set(
        normalizedPurchaseOrderIds
      );


    const invalidReceiptLine =
      receiptLines.find(
        line =>
          !validPoIds.has(
            Number(
              line.purchase_order_id
            )
          )
      );


    if (
      invalidReceiptLine
    ) {

      throw new Error(
        `RECEIPT_LINE_INVALID_PO_${invalidReceiptLine.receipt_line_id}`
      );

    }


    // =========================================================
    // 17. PREPARAR TODAS LAS LÍNEAS DEL RECEIPT
    // =========================================================

    const allReceiptLines =
      [];


    for (
      const line
      of receiptLines
    ) {

      const sku =
        String(
          line.sku || ""
        ).trim();


      const receivedQty =
        Number(
          line.received_qty
        );


      const orderedQty =
        Number(
          line.po_ordered_qty ??
          line.receipt_ordered_qty ??
          0
        );


      if (
        !sku
      ) {

        throw new Error(
          `SKU_MISSING_FOR_RECEIPT_LINE_${line.receipt_line_id}`
        );

      }


      if (
        !Number.isFinite(
          receivedQty
        )
      ) {

        throw new Error(
          `INVALID_RECEIVED_QTY_FOR_RECEIPT_LINE_${line.receipt_line_id}`
        );

      }


      if (
        receivedQty < 0
      ) {

        throw new Error(
          `NEGATIVE_RECEIVED_QTY_FOR_RECEIPT_LINE_${line.receipt_line_id}`
        );

      }


      if (
        !Number.isFinite(
          orderedQty
        )
      ) {

        throw new Error(
          `INVALID_ORDERED_QTY_FOR_RECEIPT_LINE_${line.receipt_line_id}`
        );

      }


      allReceiptLines.push({

        receipt_line_id:
          Number(
            line.receipt_line_id
          ),

        receipt_id:
          Number(
            line.receipt_id
          ),

        purchase_order_line_id:
          Number(
            line.purchase_order_line_id
          ),

        purchase_order_id:
          Number(
            line.purchase_order_id
          ),

        sku,

        ordered_qty:
          orderedQty,

        received_qty:
          receivedQty,

        qtyThisReceipt:
          receivedQty

      });

    }


    // =========================================================
    // 18. SOLO LÍNEAS POSITIVAS PARA INVENTARIO
    // =========================================================

    const stockLines =
      allReceiptLines.filter(
        line =>
          line.qtyThisReceipt > 0
      );


    if (
      stockLines.length ===
      0
    ) {

      throw new Error(
        "RECEIPT_HAS_NO_POSITIVE_QUANTITIES"
      );

    }


    console.log("");
    console.log(
      "📦 LÍNEAS CON INVENTARIO:"
    );

    console.table(
      stockLines
    );


    // =========================================================
    // 19. BUSCAR PRODUCTOS
    // =========================================================

    const skus = [
      ...new Set(
        allReceiptLines.map(
          line =>
            line.sku
        )
      )
    ];


    const productsResult =
      await client.query(
        `
        SELECT
          sku,
          description,
          erp_name,
          erp_sku,
          erp_id

        FROM products

        WHERE
          sku = ANY(
            $1::text[]
          )
        `,
        [
          skus
        ]
      );


    const productMap =
      new Map();


    for (
      const product
      of productsResult.rows
    ) {

      productMap.set(
        String(
          product.sku
        ),
        product
      );

    }


    // =========================================================
    // 20. ENRIQUECER TODAS LAS LÍNEAS
    // =========================================================

    const enrichedLines =
      allReceiptLines.map(
        (
          line,
          index
        ) => {

          const productInfo =
            productMap.get(
              line.sku
            ) || {};


          return {

            line_no:
              index + 1,

            receipt_line_id:
              line.receipt_line_id,

            purchase_order_line_id:
              line.purchase_order_line_id,

            purchase_order_id:
              line.purchase_order_id,

            sku:
              line.sku,

            description:
              productInfo.description ||
              "SIN DESCRIPCIÓN",

            erp_name:
              productInfo.erp_name ||
              null,

            erp_sku:
              productInfo.erp_sku ||
              null,

            erp_id:
              productInfo.erp_id ||
              null,

            ordered_qty:
              line.ordered_qty,

            received_qty:
              line.received_qty,

            qtyThisReceipt:
              line.qtyThisReceipt

          };

        }
      );


    // =========================================================
    // 21. BUSCAR LOCATION DE RECEPCIÓN
    // =========================================================

    const locationResult =
      await client.query(
        `
        SELECT
          id,
          warehouse_id,
          code,
          location_type

        FROM locations

        WHERE
          id = $1

          AND is_active = TRUE

          AND location_type =
            'RECEIVING'

        LIMIT 1
        `,
        [
          normalizedReceivingLocationId
        ]
      );


    if (
      locationResult.rowCount ===
      0
    ) {

      throw new Error(
        "RECEIVING_LOCATION_NOT_FOUND"
      );

    }


    const receivingLocation =
      locationResult.rows[0];


    const locationId =
      Number(
        receivingLocation.id
      );


    const warehouseId =
      Number(
        receivingLocation.warehouse_id
      );


    if (
      !Number.isInteger(
        warehouseId
      ) ||
      warehouseId <= 0
    ) {

      throw new Error(
        "RECEIVING_WAREHOUSE_NOT_FOUND"
      );

    }


    console.log("");
    console.log(
      "📍 LOCATION:",
      receivingLocation.code
    );


    console.log(
      "🏬 WAREHOUSE ID:",
      warehouseId
    );


    // =========================================================
    // TODO
    // VALIDAR FACTURA
    // =========================================================
    //
    // FUTURO:
    //
    // Por cada Purchase Order:
    //
    // - validar factura
    // - validar relación con ADM Cloud
    //
    // =========================================================


    // =========================================================
    // 22. HEADER DEL RECEIPT
    // =========================================================

    const headerResult =
      await client.query(
        `
        SELECT
          r.id
            AS receipt_id,

          r.receipt_code,

          r.started_at,

          r.finished_at,

          r.invoice,

          r.status,

          u.id
            AS user_id,

          u.full_name
            AS user_name,

          c.slug
            AS company_slug,

          c.receipt_email
            AS company_receipt_email

        FROM receipts r

        INNER JOIN users u
          ON u.id =
             r.operator_id

        INNER JOIN companies c
          ON c.id = 1

        WHERE
          r.id = $1

        LIMIT 1
        `,
        [
          normalizedReceiptId
        ]
      );


    if (
      headerResult.rowCount ===
      0
    ) {

      throw new Error(
        "RECEIPT_HEADER_NOT_FOUND"
      );

    }


    const header =
      headerResult.rows[0];


    if (
      !header.receipt_code
    ) {

      throw new Error(
        "RECEIPT_CODE_MISSING"
      );

    }


    if (
      !header.user_name
    ) {

      throw new Error(
        "USER_NAME_MISSING"
      );

    }


    // =========================================================
    // 23. DATOS MULTI PO
    // =========================================================

    const purchaseOrderNumbers =
      purchaseOrders.map(
        po =>
          po.purchase_order_number
      );


    const supplierNames = [
      ...new Set(
        purchaseOrders
          .map(
            po =>
              po.supplier_name
          )
          .filter(
            Boolean
          )
      )
    ];


    // =========================================================
    // 24. AGRUPAR LÍNEAS POR SKU
    //
    // SOLO PARA INVENTARIO.
    //
    // Si el mismo SKU aparece varias veces:
    //
    // SKU-A 10
    // SKU-A 5
    //
    // inventario += 15
    // =========================================================

    const inventoryBySkuMap =
      new Map();


    for (
      const line
      of enrichedLines
    ) {

      const qty =
        Number(
          line.qtyThisReceipt
        );


      if (
        qty <= 0
      ) {
        continue;
      }


      if (
        !inventoryBySkuMap.has(
          line.sku
        )
      ) {

        inventoryBySkuMap.set(
          line.sku,
          {

            sku:
              line.sku,

            qty:
              0,

            receipt_line_ids:
              [],

            purchase_order_line_ids:
              []

          }
        );

      }


      const groupedLine =
        inventoryBySkuMap.get(
          line.sku
        );


      groupedLine.qty +=
        qty;


      groupedLine
        .receipt_line_ids
        .push(
          line.receipt_line_id
        );


      groupedLine
        .purchase_order_line_ids
        .push(
          line.purchase_order_line_id
        );

    }


    const inventoryLinesGrouped = [
      ...inventoryBySkuMap.values()
    ];


    if (
      inventoryLinesGrouped.length ===
      0
    ) {

      throw new Error(
        "NO_INVENTORY_LINES_TO_PROCESS"
      );

    }


    console.log("");
    console.log(
      "📦 INVENTARIO AGRUPADO:"
    );

    console.table(
      inventoryLinesGrouped
    );


    // =========================================================
    // 25. ACTUALIZAR INVENTORY_BY_LOCATION
    // =========================================================

    const inventoryValues =
      [];


    const inventoryParams =
      [];


    inventoryLinesGrouped.forEach(
      (
        line,
        index
      ) => {

        const base =
          index * 4;


        inventoryValues.push(
          `
          (
            $${base + 1},
            $${base + 2},
            $${base + 3},
            $${base + 4}
          )
          `
        );


        inventoryParams.push(

          warehouseId,

          locationId,

          line.sku,

          line.qty

        );

      }
    );


    await client.query(
      `
      INSERT INTO inventory_by_location
      (
        warehouse_id,
        location_id,
        product_sku,
        qty_on_hand
      )

      VALUES

      ${inventoryValues.join(",")}

      ON CONFLICT
      (
        warehouse_id,
        location_id,
        product_sku
      )

      DO UPDATE SET

        qty_on_hand =
          inventory_by_location.qty_on_hand
          +
          EXCLUDED.qty_on_hand
      `,
      inventoryParams
    );


    console.log(
      "✅ INVENTARIO ACTUALIZADO"
    );


    // =========================================================
    // 26. CREAR INVENTORY MOVEMENTS
    // =========================================================

    const movementValues =
      [];


    const movementParams =
      [];


    inventoryLinesGrouped.forEach(
      (
        line,
        index
      ) => {

        const base =
          index * 7;


        movementValues.push(
          `
          (
            $${base + 1},
            $${base + 2},
            $${base + 3},
            $${base + 4},
            $${base + 5},
            $${base + 6},
            $${base + 7}
          )
          `
        );


        movementParams.push(

          line.sku,

          null,

          locationId,

          line.qty,

          "RECEIPT",

          "RECEPTION",

          String(
            normalizedReceiptId
          )

        );

      }
    );


    await client.query(
      `
      INSERT INTO inventory_movements
      (
        product_sku,
        from_location_id,
        to_location_id,
        qty,
        movement_type,
        reference_type,
        reference_id
      )

      VALUES

      ${movementValues.join(",")}
      `,
      movementParams
    );


    console.log(
      "✅ INVENTORY MOVEMENTS CREADOS"
    );


    // =========================================================
    // TODO
    // CREAR RECEPTION EN ADM CLOUD
    // =========================================================
    //
    // AQUÍ IRÁ LA LIQUIDACIÓN.
    //
    // IMPORTANTE:
    //
    // Todavía estamos dentro del BEGIN.
    //
    // Si ADM Cloud falla:
    //
    // throw error
    //
    // ↓
    //
    // ROLLBACK WMS
    //
    // Y si previamente se crearon documentos ADM:
    //
    // ejecutar compensación/cancelación.
    //
    // =========================================================


    // =========================================================
    // 27. MARCAR RECEIPT COMPLETED
    // =========================================================

    const completedReceiptResult =
  await client.query(
    `
    UPDATE receipts

    SET
      status = 'completed',
      finished_at = NOW()

    WHERE
      id = $1

      AND status IN
      (
        'created',
        'in_progress',
        'paused'
      )

    RETURNING
      id,
      receipt_code,
      status,
      finished_at
    `,
    [
      normalizedReceiptId
    ]
  );


    if (
      completedReceiptResult.rowCount !==
      1
    ) {

      throw new Error(
        "RECEIPT_COULD_NOT_BE_COMPLETED"
      );

    }


    const completedReceipt =
      completedReceiptResult.rows[0];


    // =========================================================
    // 28. RECALCULAR PURCHASE_ORDER_LINES.RECEIVED_QTY
    //
    // IMPORTANTE:
    //
    // purchase_order_lines.received_qty
    //
    // =
    //
    // SUM(receipt_lines.received_qty)
    //
    // solamente receipts completed.
    // =========================================================

    const purchaseOrderLineIds = [
      ...new Set(
        allReceiptLines.map(
          line =>
            Number(
              line.purchase_order_line_id
            )
        )
      )
    ];


    await client.query(
      `
      UPDATE purchase_order_lines pol

      SET
        received_qty =
        (
          SELECT
            COALESCE(
              SUM(
                rl.received_qty
              ),
              0
            )

          FROM receipt_lines rl

          INNER JOIN receipts r
            ON r.id =
               rl.receipt_id

          WHERE
            rl.purchase_order_line_id =
              pol.id

            AND r.status =
              'completed'
        )

      WHERE
        pol.id = ANY(
          $1::bigint[]
        )
      `,
      [
        purchaseOrderLineIds
      ]
    );


    console.log(
      "✅ PURCHASE_ORDER_LINES.RECEIVED_QTY RECALCULADO"
    );


    // =========================================================
    // 29. RECALCULAR ESTADO DE CADA PURCHASE ORDER
    // =========================================================

    for (
      const purchaseOrder
      of purchaseOrders
    ) {

      const statusResult =
        await client.query(
          `
          SELECT

            COUNT(*)::int
              AS total_lines,

            COUNT(*) FILTER
            (
              WHERE
                COALESCE(
                  received_qty,
                  0
                )
                >=
                COALESCE(
                  ordered_qty,
                  0
                )
            )::int
              AS completed_lines,

            COUNT(*) FILTER
            (
              WHERE
                COALESCE(
                  received_qty,
                  0
                ) > 0
            )::int
              AS received_lines

          FROM purchase_order_lines

          WHERE
            purchase_order_id =
              $1

            AND COALESCE(
              deleted_erp,
              FALSE
            ) =
              FALSE
          `,
          [
            purchaseOrder.id
          ]
        );


      const totals =
        statusResult.rows[0];


      const totalLines =
        Number(
          totals.total_lines ||
          0
        );


      const completedLines =
        Number(
          totals.completed_lines ||
          0
        );


      const receivedLines =
        Number(
          totals.received_lines ||
          0
        );


      let newStatus =
  purchaseOrder.status;


if (
  totalLines > 0 &&
  completedLines === totalLines
) {

  newStatus =
    "closed";

} else if (
  receivedLines > 0
) {

  newStatus =
    "partial";

}


      await client.query(
        `
        UPDATE purchase_orders

        SET
          status = $1

        WHERE
          id = $2
        `,
        [
          newStatus,
          purchaseOrder.id
        ]
      );


      console.log(
        `📋 ${purchaseOrder.purchase_order_number} → ${newStatus}`
      );

    }


    // =========================================================
    // 30. BUSCAR TOTALES ACTUALIZADOS
    // =========================================================

    const updatedPoLinesResult =
      await client.query(
        `
        SELECT
          id,
          ordered_qty,
          received_qty

        FROM purchase_order_lines

        WHERE
          id = ANY(
            $1::bigint[]
          )
        `,
        [
          purchaseOrderLineIds
        ]
      );


    const updatedTotalsMap =
      new Map();


    for (
      const line
      of updatedPoLinesResult.rows
    ) {

      updatedTotalsMap.set(
        Number(
          line.id
        ),
        {

          ordered_qty:
            Number(
              line.ordered_qty ||
              0
            ),

          total_received_qty:
            Number(
              line.received_qty ||
              0
            )

        }
      );

    }


    // =========================================================
    // 31. PREPARAR LÍNEAS DEL PDF
    // =========================================================

    const receiptPdfLines =
  enrichedLines
    .filter(
      line =>
        Number(line.qtyThisReceipt) > 0
    )
    .map(
      (line, index) => {

          const totals =
            updatedTotalsMap.get(
              Number(
                line.purchase_order_line_id
              )
            ) || {};


          const orderedQty =
            Number(
              totals.ordered_qty ??
              line.ordered_qty ??
              0
            );


          const totalReceivedQty =
            Number(
              totals.total_received_qty ??
              0
            );


          return {

            line_no:
              index + 1,

            id:
              line.receipt_line_id,

            receipt_line_id:
              line.receipt_line_id,

            purchase_order_line_id:
              line.purchase_order_line_id,

            purchase_order_id:
              line.purchase_order_id,

            sku:
              line.sku,

            description:
              line.description,

            erp_name:
              line.erp_name,

            erp_sku:
              line.erp_sku,

            erp_id:
              line.erp_id,

            ordered_qty:
              orderedQty,


            // ================================================
            // CANTIDAD DE ESTE RECEIPT
            // ================================================

            received_qty:
              Number(
                line.qtyThisReceipt
              ),


            // ================================================
            // TOTAL HISTÓRICO
            // ================================================

            total_received_qty:
              totalReceivedQty,


            // ================================================
            // DIFERENCIA TOTAL DE LA PO LINE
            //
            // negativo = falta
            // 0 = completa
            // positivo = exceso
            // ================================================

            difference_qty:
              totalReceivedQty -
              orderedQty

          };

        }
      );


    // =========================================================
    // 32. HEADER PDF
    // =========================================================

    const headerPDF = {

      receiptId:
        normalizedReceiptId,

      receiptCode:
        completedReceipt.receipt_code,

      startedAt:
        header.started_at,

      finishedAt:
        completedReceipt.finished_at,

      invoice:
        header.invoice,

      status:
        completedReceipt.status,


      // ======================================================
      // MULTI PO
      // ======================================================

      purchaseOrderIds:
        normalizedPurchaseOrderIds,

      purchaseOrderNumbers,

      supplierNames,


      // ======================================================
      // COMPATIBILIDAD TEMPLATE VIEJO
      // ======================================================

      purchaseOrderId:
        normalizedPurchaseOrderIds[0] ??
        null,

      poNumber:
        purchaseOrderNumbers.join(
          ", "
        ),

      supplierName:
        supplierNames.join(
          ", "
        ),


      // ======================================================
      // USER / COMPANY
      // ======================================================

      userId:
        header.user_id,

      userName:
        header.user_name,

      company_receipt_email:
        header.company_receipt_email,

      company_slug:
        header.company_slug

    };


    console.log("");
    console.log(
      "📄 HEADER PDF:"
    );

    console.dir(
      headerPDF,
      {
        depth: null
      }
    );


    console.log("");
    console.log(
      "📄 PDF LINES:"
    );

    console.dir(
      receiptPdfLines,
      {
        depth: null
      }
    );



    const liquidationResult =
  await liquidateAdmCloudReceptions({

    client,

    purchaseOrderIds:
      normalizedPurchaseOrderIds,

    receiptId:
      normalizedReceiptId,

    admLocationId:
      process.env.ADM_MAIN_LOCATION_ID

  });


console.log(
  "✅ ADM LIQUIDATION RESULT:"
);

console.dir(
  liquidationResult,
  {
    depth: null
  }
);


    // =========================================================
    // 33. COMMIT
    // =========================================================

    await client.query(
      "COMMIT"
    );


    transactionStarted =
      false;


    console.log("");
    console.log(
      "✅ ========================================"
    );

    console.log(
      "✅ RECEPCIÓN CERRADA CORRECTAMENTE"
    );

    console.log(
      "🧾 RECEIPT:",
      normalizedReceiptId
    );

    console.log(
      "📋 POs:",
      normalizedPurchaseOrderIds
    );

    console.log(
      "📍 LOCATION:",
      locationId
    );

    console.log(
      "✅ ========================================"
    );


    // =========================================================
    // 34. RESPONDER AL FRONTEND
    // =========================================================

    res
      .status(200)
      .json({

        success: true,

        message:
          "Recepción cerrada correctamente",

        receiptId:
          normalizedReceiptId,

        receiptCode:
          completedReceipt.receipt_code,

        purchaseOrderIds:
          normalizedPurchaseOrderIds,

        receivingLocationId:
          locationId

      });


    // =========================================================
    // 35. PDF / S3 / EMAIL BACKGROUND
    //
    // Esto ocurre DESPUÉS del COMMIT.
    //
    // Si falla PDF/email NO hacemos rollback
    // de inventario.
    // =========================================================

    setImmediate(
      async () => {

        try {

          // ===================================================
          // HTML
          // ===================================================

          const html =
            buildReceiptHtml(
              headerPDF,
              receiptPdfLines
            );


          // ===================================================
          // PDF
          // ===================================================

          const pdf =
            await generatePdf(
              html
            );


          // ===================================================
          // TENANT
          // ===================================================

          const tenantSlug =
            header.company_slug ||
            "company";


          const year =
            new Date()
              .getFullYear();


          const uuid =
            randomUUID();


          const fileName =
            `receipt_${year}_${normalizedReceiptId}_${uuid}.pdf`;


          const s3Key =
            `${tenantSlug}/receipts/${fileName}`;


          // ===================================================
          // S3
          // ===================================================

          await uploadPdfToS3({

            buffer:
              pdf,

            key:
              s3Key

          });


          // ===================================================
          // GUARDAR S3 KEY
          // ===================================================

          await db.query(
            `
            UPDATE receipts

            SET
              pdf_s3_key = $1

            WHERE
              id = $2
            `,
            [
              s3Key,
              normalizedReceiptId
            ]
          );


          console.log(
            "✅ PDF SUBIDO:",
            s3Key
          );


          // ===================================================
          // EMAIL DESTINATARIOS
          // ===================================================

          const recipients =
            String(
              header.company_receipt_email ||
              ""
            )
              .split(
                /[,;]/
              )
              .map(
                email =>
                  email.trim()
              )
              .filter(
                Boolean
              );


          // ===================================================
          // ENVIAR EMAIL
          // ===================================================

          if (
            recipients.length >
            0
          ) {

            try {

              await sendReceiptEmail({

                to:
                  recipients,

                pdfBuffer:
                  pdf,

                receiptCode:
                  completedReceipt.receipt_code,

                companyName:
                  tenantSlug

              });


              console.log(
                "✅ EMAIL ENVIADO"
              );


            } catch (
              emailError
            ) {

              console.error(
                "⚠️ EMAIL NO ENVIADO:",
                emailError.message
              );

            }

          } else {

            console.log(
              "ℹ️ NO HAY EMAIL CONFIGURADO PARA RECEPCIÓN"
            );

          }


          console.log(
            "✅ PDF / S3 / EMAIL TERMINADO"
          );


        } catch (
          backgroundError
        ) {

          console.error(
            "⚠️ ERROR POST-CIERRE:",
            backgroundError.message
          );

        }

      }
    );


  } catch (error) {

  try {

    await client.query(
      "ROLLBACK"
    );

  } catch (
    rollbackError
  ) {

    console.error(
      "❌ ERROR DURANTE ROLLBACK:",
      rollbackError
    );

  }


  console.error("");
  console.error(
    "❌ ========================================"
  );

  console.error(
    "❌ ERROR CERRANDO RECEPCIÓN"
  );

  console.error(
    error
  );

  console.error(
    "❌ ========================================"
  );


  return res
    .status(400)
    .json({

      success:
        false,

      title:
        error?.title ||
        "Error cerrando recepción",

      message:
        error?.message ||
        "No se pudo completar la recepción.",

      code:
        error?.code ||
        "CLOSE_RECEPTION_ERROR"

    });

} finally {

    client.release();

  }

}


// Search all the reception information for reception
export async function gettingReceptionLocation(req, res) {
  console.log("ENTRÉ AL ENDPOINT /receiving/locations");
  try {
    // 1️⃣ Buscar ubicaciones RECEIVING activas
    const locationsResult = await db.query(
      `
      SELECT id, code
      FROM locations
      WHERE location_type = 'RECEIVING'
        AND is_active = true
      ORDER BY code
      `
    );

    // 2️⃣ Si no existe ninguna → ERROR CONTROLADO
    if (locationsResult.rowCount === 0) {
      return res.status(400).json({
        success: false,
        code: "UBICACION_NO_EXISTE",
        message: "Ubicación de recepción no existe",
      });
    }

    console.log("RESULTADO:", locationsResult.rows);


    // 3️⃣ Respuesta OK
    return res.json({
      success: true,
      data: locationsResult.rows,
    });

  } catch (error) {
    console.error("Error buscando ubicaciones RECEIVING", error);
    return res.status(500).json({
      success: false,
      code: "INTERNAL_ERROR",
      message: "Error interno del servidor",
    });
  }
};


// Get all purchase order lines with differences in an order
export async function getReceivingDifferences(req, res) {

  const { poIds } = req.query;


  // ============================================================
  // VALIDAR QUERY PARAM
  // ============================================================

  if (!poIds) {

    return res.status(400).json({

      success: false,

      title:
        "Orden de Compra requerida",

      message:
        "Debe enviar al menos una orden de compra.",

    });

  }


  // ============================================================
  // CONVERTIR:
  //
  // "38,36"
  //
  // ↓
  //
  // [38, 36]
  // ============================================================

  const purchaseOrderIds =
    String(poIds)
      .split(",")
      .map(Number)
      .filter(
        (id) =>
          Number.isInteger(id) &&
          id > 0
      );


  console.log("");
  console.log(
    "📦 ========================================"
  );

  console.log(
    "📦 GET RECEIVING DIFFERENCES"
  );

  console.log(
    "📦 PURCHASE ORDER IDS:",
    purchaseOrderIds
  );

  console.log(
    "📦 ========================================"
  );


  // ============================================================
  // VALIDAR IDS
  // ============================================================

  if (
    purchaseOrderIds.length === 0
  ) {

    return res.status(400).json({

      success: false,

      title:
        "Orden de Compra inválida",

      message:
        "No se recibieron IDs válidos.",

    });

  }


  try {

    // ============================================================
    // 1. BUSCAR TODAS LAS PURCHASE ORDERS
    // ============================================================

    const poResult =
      await db.query(
        `
        SELECT
          id,
          purchase_order_number,
          status

        FROM purchase_orders

        WHERE id =
          ANY($1::bigint[])

        ORDER BY id
        `,
        [
          purchaseOrderIds
        ]
      );


    console.log(
      "📦 PURCHASE ORDERS ENCONTRADAS:",
      poResult.rows
    );


    // ============================================================
    // 2. VALIDAR QUE EXISTAN TODAS
    // ============================================================

    if (
      poResult.rowCount !==
      purchaseOrderIds.length
    ) {

      const foundIds =
        poResult.rows.map(
          (order) =>
            Number(order.id)
        );


      const missingIds =
        purchaseOrderIds.filter(
          (id) =>
            !foundIds.includes(id)
        );


      console.log(
        "❌ PURCHASE ORDERS NO ENCONTRADAS:",
        missingIds
      );


      return res.status(404).json({

        success: false,

        title:
          "Orden de Compra no disponible",

        message:
          missingIds.length === 1
            ? `La orden de compra con ID ${missingIds[0]} no existe.`
            : `Las órdenes de compra ${missingIds.join(", ")} no existen.`,

        missingIds,

      });

    }


    // ============================================================
    // 3. VALIDAR QUE TODAS ESTÉN PARTIAL
    // ============================================================

    const notPartialOrder =
      poResult.rows.find(
        (order) =>
          String(order.status)
            .trim()
            .toLowerCase()
          !== "partial"
      );


    if (notPartialOrder) {

      console.log(
        "❌ PURCHASE ORDER NO ESTÁ PARTIAL:",
        notPartialOrder
      );


      return res.status(409).json({

        success: false,

        title:
          "Orden de Compra no disponible",

        message:
          `La orden ${notPartialOrder.purchase_order_number} no está en estado partial.`,

        data: {

          id:
            Number(
              notPartialOrder.id
            ),

          purchase_order_number:
            notPartialOrder.purchase_order_number,

          status:
            notPartialOrder.status,

        },

      });

    }


    // ============================================================
    // 4. BUSCAR LÍNEAS CON DIFERENCIAS
    // ============================================================

    const linesResult =
      await db.query(
        `
        SELECT

          pol.id,

          -- PO A LA QUE PERTENECE LA LÍNEA
          pol.purchase_order_id,
          po.purchase_order_number,

          pol.sku,
          pol.description,
          pol.ordered_qty,
          pol.received_qty,
          pol.difference_qty,
          pol.product_exists,

          p.erp_name,
          p.erp_sku,
          p.erp_id

        FROM purchase_order_lines pol

        JOIN purchase_orders po
          ON po.id =
             pol.purchase_order_id

        LEFT JOIN products p
          ON p.sku =
             pol.sku

        WHERE
          pol.purchase_order_id =
            ANY($1::bigint[])

          AND
          pol.ordered_qty <>
          pol.received_qty

        ORDER BY
          pol.purchase_order_id,
          pol.id
        `,
        [
          purchaseOrderIds
        ]
      );


    console.log(
      "📦 LÍNEAS CON DIFERENCIAS:",
      linesResult.rows
    );


    // ============================================================
    // 5. ENRIQUECER LÍNEAS
    // ============================================================

    const enrichedLines =
      linesResult.rows.map(
        (line) => ({

          id:
            Number(line.id),

          purchase_order_id:
            Number(
              line.purchase_order_id
            ),

          purchase_order_number:
            line.purchase_order_number,

          sku:
            line.sku,

          description:
            line.description,

          ordered_qty:
            Number(
              line.ordered_qty ?? 0
            ),

          received_qty:
            Number(
              line.received_qty ?? 0
            ),

          difference_qty:
            Number(
              line.difference_qty ?? 0
            ),

          product_exists:
            line.product_exists,

          barcodes:
            [],

          erp_name:
            line.erp_name || null,

          erp_sku:
            line.erp_sku || null,

          erp_id:
            line.erp_id
              ? Number(line.erp_id)
              : null,

        })
      );


    // ============================================================
    // 6. OBTENER NÚMEROS DE LAS PURCHASE ORDERS
    // ============================================================

    const purchaseOrderNumbers =
      poResult.rows.map(
        (order) =>
          order.purchase_order_number
      );


    console.log(
      "✅ DIFERENCIAS FINALES:",
      enrichedLines
    );


    // ============================================================
    // 7. RESPONDER
    // ============================================================

    return res.status(200).json({

      success: true,

      data: {

        purchase_order_ids:
          purchaseOrderIds,

        purchase_order_numbers:
          purchaseOrderNumbers,

        lines:
          enrichedLines,

      },

    });


  } catch (error) {

    console.error(
      "❌ Error validating receiving:",
      error
    );


    return res.status(500).json({

      success: false,

      title:
        "Error obteniendo diferencias",

      message:
        "ERROR_VALIDATING_RECEIVING",

    });

  }

}



export async function savingReception(req, res) {

  console.log("");
  console.log("🚀 ========================================");
  console.log("🚀 HIT /receiving/save");
  console.log("🚀 ========================================");


  // ============================================================
  // 1. RECIBIR DATA
  // ============================================================

  const {
    purchase_order_ids,
    purchase_order_numbers,
    receipt_id,
    reception_status,
    lines,
  } = req.body;


  // ============================================================
  // 2. NORMALIZAR PURCHASE ORDER IDS
  //
  // ["2", 3, "4"]
  //
  // ↓
  //
  // [2, 3, 4]
  // ============================================================

  const purchaseOrderIds =
    Array.isArray(
      purchase_order_ids
    )
      ? [
          ...new Set(
            purchase_order_ids.map(
              (id) =>
                Number(id)
            )
          )
        ]
      : [];


  const receiptId =
    Number(
      receipt_id
    );


  // ============================================================
  // LOGS
  // ============================================================

  console.log(
    "📦 PURCHASE ORDER IDS:",
    purchaseOrderIds
  );


  console.log(
    "📦 PURCHASE ORDER NUMBERS:",
    purchase_order_numbers
  );


  console.log(
    "🧾 RECEIPT ID:",
    receiptId
  );


  console.log(
    "📌 RECEPTION STATUS:",
    reception_status
  );


  console.log(
    "📦 LINES:",
    lines
  );


  // ============================================================
  // 3. VALIDAR PURCHASE ORDER IDS
  // ============================================================

  if (
    purchaseOrderIds.length === 0
  ) {

    return res
      .status(400)
      .json({

        success: false,

        title:
          "Orden de Compra requerida",

        message:
          "Debe enviar al menos una orden de compra.",

      });

  }


  const invalidPurchaseOrderId =
    purchaseOrderIds.some(
      (id) =>
        !Number.isInteger(id) ||
        id <= 0
    );


  if (
    invalidPurchaseOrderId
  ) {

    return res
      .status(400)
      .json({

        success: false,

        title:
          "Orden de Compra inválida",

        message:
          "Una o más órdenes de compra tienen un ID inválido.",

      });

  }


  // ============================================================
  // 4. VALIDAR RECEIPT ID
  // ============================================================

  if (
    !Number.isInteger(
      receiptId
    ) ||
    receiptId <= 0
  ) {

    return res
      .status(400)
      .json({

        success: false,

        title:
          "Recepción inválida",

        message:
          "El receipt_id recibido no es válido.",

      });

  }


  // ============================================================
  // 5. VALIDAR RECEPTION STATUS
  // ============================================================

  const allowedReceptionStatuses =
    [
      "in_progress",
      "paused"
    ];


  if (
    !allowedReceptionStatuses.includes(
      reception_status
    )
  ) {

    return res
      .status(400)
      .json({

        success: false,

        title:
          "Estado de recepción inválido",

        message:
          `El estado ${reception_status} no está permitido.`,

      });

  }


  // ============================================================
  // 6. VALIDAR LINES
  // ============================================================

  if (
    !Array.isArray(lines) ||
    lines.length === 0
  ) {

    return res
      .status(400)
      .json({

        success: false,

        title:
          "Recepción sin líneas",

        message:
          "No hay líneas para guardar.",

      });

  }


  // ============================================================
  // 7. VALIDAR FORMATO DE CADA LINE
  // ============================================================

  for (
    const line
    of lines
  ) {

    if (
      typeof line.id !== "number" ||

      !Number.isInteger(
        line.id
      ) ||

      line.id <= 0 ||

      typeof line.received_qty !==
        "number" ||

      !Number.isFinite(
        line.received_qty
      ) ||

      line.received_qty < 0
    ) {

      console.log(
        "❌ LÍNEA INVÁLIDA:",
        line
      );


      return res
        .status(400)
        .json({

          success: false,

          title:
            "Línea inválida",

          message:
            "Una o más líneas tienen un formato inválido.",

        });

    }

  }


  // ============================================================
  // 8. EVITAR LINE IDS DUPLICADOS
  // ============================================================

  const lineIds =
    lines.map(
      (line) =>
        Number(line.id)
    );


  const uniqueLineIds =
    [
      ...new Set(
        lineIds
      )
    ];


  if (
    uniqueLineIds.length !==
    lineIds.length
  ) {

    return res
      .status(400)
      .json({

        success: false,

        title:
          "Líneas duplicadas",

        message:
          "La misma línea de orden de compra aparece más de una vez.",

      });

  }


  // ============================================================
  // 9. CONEXIÓN DB
  // ============================================================

  const client =
    await db.connect();


  let transactionStarted =
    false;


  try {

    // ==========================================================
    // BEGIN
    // ==========================================================

    await client.query(
      "BEGIN"
    );


    transactionStarted =
      true;


    // ============================================================
    // 10. BUSCAR Y BLOQUEAR TODAS LAS PURCHASE ORDERS
    // ============================================================

    const poResult =
      await client.query(
        `
        SELECT
          id,
          purchase_order_number,
          status

        FROM purchase_orders

        WHERE
          id = ANY(
            $1::bigint[]
          )

        ORDER BY id

        FOR UPDATE
        `,
        [
          purchaseOrderIds
        ]
      );


    console.log("");
    console.log(
      "🔒 PURCHASE ORDERS BLOQUEADAS:"
    );


    console.log(
      poResult.rows
    );


    // ============================================================
    // 11. VALIDAR QUE EXISTAN TODAS LAS PURCHASE ORDERS
    // ============================================================

    if (
      poResult.rowCount !==
      purchaseOrderIds.length
    ) {

      const foundIds =
        poResult.rows.map(
          (order) =>
            Number(order.id)
        );


      const missingIds =
        purchaseOrderIds.filter(
          (id) =>
            !foundIds.includes(
              id
            )
        );


      console.log(
        "❌ PURCHASE ORDERS NO ENCONTRADAS:",
        missingIds
      );


      await client.query(
        "ROLLBACK"
      );


      transactionStarted =
        false;


      return res
        .status(404)
        .json({

          success: false,

          title:
            "Orden de Compra no disponible",

          message:
            missingIds.length === 1

              ? `La orden de compra con ID ${missingIds[0]} no existe.`

              : `Las órdenes de compra ${missingIds.join(", ")} no existen.`,

          missingIds,

        });

    }


    console.log(
      "✅ TODAS LAS PURCHASE ORDERS EXISTEN"
    );


    // ============================================================
    // 12. VALIDAR RECEIPT
    //
    // Ahora NO buscamos receipt por POs.
    //
    // Ya tenemos:
    //
    // receipt_id = 13
    //
    // Verificamos:
    //
    // - que exista
    // - que esté activo
    // ============================================================

    const receiptResult =
      await client.query(
        `
        SELECT
          id,
          receipt_code,
          status

        FROM receipts

        WHERE id = $1

        FOR UPDATE
        `,
        [
          receiptId
        ]
      );


    if (
      receiptResult.rowCount === 0
    ) {

      await client.query(
        "ROLLBACK"
      );


      transactionStarted =
        false;


      return res
        .status(404)
        .json({

          success: false,

          title:
            "Recepción no encontrada",

          message:
            `No existe la recepción con ID ${receiptId}.`,

        });

    }


    const receipt =
      receiptResult.rows[0];


    console.log(
      "🧾 RECEIPT ENCONTRADO:",
      receipt
    );


    // ============================================================
    // 13. NO PERMITIR MODIFICAR RECEIPT TERMINADO
    // ============================================================

    const receiptStatus =
      String(
        receipt.status || ""
      )
        .trim()
        .toLowerCase();


    if (
      [
        "completed",
        "abandoned",
        "cancelled",
        "cancel"
      ].includes(
        receiptStatus
      )
    ) {

      await client.query(
        "ROLLBACK"
      );


      transactionStarted =
        false;


      return res
        .status(400)
        .json({

          success: false,

          title:
            "Recepción no disponible",

          message:
            `La recepción ${receipt.receipt_code} está en estado ${receipt.status}.`,

        });

    }


    // ============================================================
    // 14. VALIDAR QUE EL RECEIPT PERTENEZCA EXACTAMENTE
    //     A LAS PURCHASE ORDERS RECIBIDAS
    // ============================================================

    const receiptPoResult =
      await client.query(
        `
        SELECT
          purchase_order_id

        FROM receipt_purchase_orders

        WHERE
          receipt_id = $1

        ORDER BY
          purchase_order_id
        `,
        [
          receiptId
        ]
      );


    const receiptPurchaseOrderIds =
      receiptPoResult.rows.map(
        (row) =>
          Number(
            row.purchase_order_id
          )
      );


    console.log(
      "🔗 POs DEL RECEIPT:",
      receiptPurchaseOrderIds
    );


    const samePurchaseOrders =

      receiptPurchaseOrderIds.length ===
        purchaseOrderIds.length

      &&

      purchaseOrderIds.every(
        (id) =>
          receiptPurchaseOrderIds.includes(
            id
          )
      );


    if (
      !samePurchaseOrders
    ) {

      await client.query(
        "ROLLBACK"
      );


      transactionStarted =
        false;


      return res
        .status(400)
        .json({

          success: false,

          title:
            "Recepción incorrecta",

          message:
            "El receipt_id no corresponde exactamente a las órdenes de compra recibidas.",

          receipt_purchase_order_ids:
            receiptPurchaseOrderIds,

          request_purchase_order_ids:
            purchaseOrderIds,

        });

    }


    // ============================================================
    // 15. PONER TODAS LAS PURCHASE ORDERS EN PARTIAL
    // ============================================================

    await client.query(
      `
      UPDATE purchase_orders

      SET
        status = 'partial'

      WHERE
        id = ANY(
          $1::bigint[]
        )
      `,
      [
        purchaseOrderIds
      ]
    );


    console.log("");
    console.log(
      "📌 SE PUSIERON EN PARTIAL LAS ÓRDENES:"
    );


    console.log(
      poResult.rows.map(
        (order) =>
          order.purchase_order_number
      )
    );


    // ============================================================
    // 16. BUSCAR TODAS LAS PURCHASE ORDER LINES
    //
    // Entraron:
    //
    // [
    //   { id: 27, received_qty: 240 },
    //   { id: 28, received_qty: 200 }
    // ]
    //
    // Vamos a obtener:
    //
    // id
    // purchase_order_id
    // sku
    // ordered_qty
    // ============================================================

    const poLinesResult =
      await client.query(
        `
        SELECT
          id,
          purchase_order_id,
          sku,
          ordered_qty

        FROM purchase_order_lines

        WHERE
          id = ANY(
            $1::bigint[]
          )

          AND purchase_order_id =
            ANY(
              $2::bigint[]
            )

        ORDER BY id

        FOR UPDATE
        `,
        [
          lineIds,
          purchaseOrderIds
        ]
      );


    // ============================================================
    // 17. VALIDAR QUE TODAS LAS LINEAS EXISTAN
    // ============================================================

    if (
      poLinesResult.rowCount !==
      lineIds.length
    ) {

      const foundLineIds =
        poLinesResult.rows.map(
          (line) =>
            Number(line.id)
        );


      const missingLineIds =
        lineIds.filter(
          (id) =>
            !foundLineIds.includes(
              id
            )
        );


      console.log(
        "❌ PURCHASE ORDER LINES NO ENCONTRADAS:",
        missingLineIds
      );


      await client.query(
        "ROLLBACK"
      );


      transactionStarted =
        false;


      return res
        .status(404)
        .json({

          success: false,

          title:
            "Línea no disponible",

          message:
            missingLineIds.length === 1

              ? `La línea ${missingLineIds[0]} no existe o no pertenece a las órdenes seleccionadas.`

              : `Las líneas ${missingLineIds.join(", ")} no existen o no pertenecen a las órdenes seleccionadas.`,

          missingLineIds,

        });

    }


    // ============================================================
    // 18. CREAR MAP CON RECEIVED_QTY DEL FRONTEND
    // ============================================================

    const frontendQtyMap =
      new Map(
        lines.map(
          (line) => [
            Number(line.id),
            Number(
              line.received_qty
            )
          ]
        )
      );


    // ============================================================
    // 19. CREAR LÍNEAS ENRIQUECIDAS
    // ============================================================

    const enrichedLines =
      poLinesResult.rows.map(
        (line) => ({

          id:
            Number(
              line.id
            ),

          purchase_order_id:
            Number(
              line.purchase_order_id
            ),

          sku:
            line.sku,

          ordered_qty:
            Number(
              line.ordered_qty || 0
            ),

          received_qty:
            Number(
              frontendQtyMap.get(
                Number(
                  line.id
                )
              ) || 0
            ),

        })
      );


    console.log("");
    console.log(
      "📦 LÍNEAS ENRIQUECIDAS:"
    );


    console.dir(
      enrichedLines,
      {
        depth: null
      }
    );


    // ============================================================
    // 20. VALIDAR SKU
    // ============================================================

    const lineWithoutSku =
      enrichedLines.find(
        (line) =>
          !line.sku ||
          !String(
            line.sku
          ).trim()
      );


    if (
      lineWithoutSku
    ) {

      throw new Error(
        `SKU_MISSING_FOR_PURCHASE_ORDER_LINE_${lineWithoutSku.id}`
      );

    }






    // ============================================================
    // 21. GUARDAR RECEIPT_LINES
    //
    // MUY IMPORTANTE:
    //
    // receipt_lines.received_qty
    // =
    // cantidad perteneciente a ESTE receipt.
    //
    //
    // Usamos UPSERT porque:
    //
    // usuario guarda
    // usuario pausa
    // usuario vuelve
    // usuario vuelve a guardar
    //
    // No queremos:
    //
    // receipt 13 / line 27 / 240
    // receipt 13 / line 27 / 240
    // receipt 13 / line 27 / 240
    //
    // Queremos:
    //
    // receipt 13 / line 27 / 240
    // ============================================================

    const receiptLineValues = [];

    const receiptLineParams = [];


    enrichedLines.forEach(
      (
        line,
        index
      ) => {

        const base =
          index * 5;


        receiptLineValues.push(
          `
          (
            $${base + 1},
            $${base + 2},
            $${base + 3},
            $${base + 4},
            $${base + 5},
            NOW()
          )
          `
        );


        receiptLineParams.push(

          // receipt_id
          receiptId,

          // purchase_order_line_id
          line.id,

          // sku
          line.sku,

          // ordered_qty
          line.ordered_qty,

          // received_qty
          line.received_qty

        );

      }
    );


    const receiptLinesResult =
  await client.query(
    `
    INSERT INTO receipt_lines
    (
      receipt_id,
      purchase_order_line_id,
      sku,
      ordered_qty,
      received_qty,
      created_at
    )

    VALUES

    ${receiptLineValues.join(",")}

    ON CONFLICT
    (
      receipt_id,
      purchase_order_line_id
    )

    DO UPDATE SET

      sku =
        EXCLUDED.sku,

      ordered_qty =
        EXCLUDED.ordered_qty,

      received_qty =
        EXCLUDED.received_qty

    RETURNING
      id,
      receipt_id,
      purchase_order_line_id,
      sku,
      ordered_qty,
      received_qty,
      difference_qty,
      created_at
    `,
    receiptLineParams
  );


    console.log("");
    console.log(
      "✅ RECEIPT LINES GUARDADAS:"
    );


    console.table(
      receiptLinesResult.rows
    );

// ============================================================
// 22. RECALCULAR PURCHASE_ORDER_LINES.RECEIVED_QTY
//
// receipt_lines.received_qty
// = cantidad recibida en CADA receipt
//
// purchase_order_lines.received_qty
// = TOTAL acumulado entre todos los receipts válidos
// ============================================================

const purchaseOrderLineIds =
  enrichedLines.map(
    (line) =>
      Number(line.id)
  );


// ------------------------------------------------------------
// 22.1 CALCULAR TOTAL RECIBIDO POR CADA PO LINE
// ------------------------------------------------------------

const accumulatedResult =
  await client.query(
    `
    SELECT
      pol.id,
      pol.sku,
      pol.ordered_qty,

      COALESCE(
        SUM(rl.received_qty)
        FILTER (
          WHERE
            r.status <> 'abandoned'
        ),
        0
      ) AS total_received_qty

    FROM purchase_order_lines pol

    LEFT JOIN receipt_lines rl
      ON rl.purchase_order_line_id =
         pol.id

    LEFT JOIN receipts r
      ON r.id =
         rl.receipt_id

    WHERE
      pol.id =
        ANY($1::bigint[])

    GROUP BY
      pol.id,
      pol.sku,
      pol.ordered_qty

    ORDER BY
      pol.id
    `,
    [
      purchaseOrderLineIds
    ]
  );


console.log("");
console.log(
  "📊 TOTAL RECIBIDO ACUMULADO:"
);

console.table(
  accumulatedResult.rows
);


// ------------------------------------------------------------
// 22.2 VALIDAR QUE NO SE RECIBA MÁS DE LO ORDENADO
// ------------------------------------------------------------

const overReceivedLine =
  accumulatedResult.rows.find(
    (line) =>
      Number(
        line.total_received_qty
      ) >
      Number(
        line.ordered_qty
      )
  );


if (
  overReceivedLine
) {

  throw new Error(
    `La línea ${overReceivedLine.id} ` +
    `(${overReceivedLine.sku}) tiene ` +
    `${overReceivedLine.total_received_qty} recibidos ` +
    `pero solamente ${overReceivedLine.ordered_qty} ordenados.`
  );

}


// ------------------------------------------------------------
// 22.3 ACTUALIZAR EL ACUMULADO EN PURCHASE_ORDER_LINES
// ------------------------------------------------------------

const updatePurchaseOrderLinesResult =
  await client.query(
    `
    UPDATE purchase_order_lines pol

    SET
      received_qty =
        totals.total_received_qty

    FROM
    (
      SELECT
        rl.purchase_order_line_id,

        COALESCE(
          SUM(rl.received_qty)
          FILTER (
            WHERE
              r.status <> 'abandoned'
          ),
          0
        ) AS total_received_qty

      FROM receipt_lines rl

      INNER JOIN receipts r
        ON r.id =
           rl.receipt_id

      WHERE
        rl.purchase_order_line_id =
          ANY($1::bigint[])

      GROUP BY
        rl.purchase_order_line_id

    ) AS totals

    WHERE
      pol.id =
        totals.purchase_order_line_id

    RETURNING
      pol.id,
      pol.purchase_order_id,
      pol.sku,
      pol.ordered_qty,
      pol.received_qty
    `,
    [
      purchaseOrderLineIds
    ]
  );


console.log("");
console.log(
  "✅ PURCHASE ORDER LINES ACTUALIZADAS:"
);

console.table(
  updatePurchaseOrderLinesResult.rows
);

    // ============================================================
// 23. ACTUALIZAR STATUS DEL RECEIPT
// ============================================================

    const updateReceiptResult =
      await client.query(
        `
        UPDATE receipts

        SET
          status = $2

        WHERE
          id = $1

        RETURNING
          id,
          receipt_code,
          status
        `,
        [
          receiptId,
          reception_status
        ]
      );


    if (
      updateReceiptResult.rowCount !== 1
    ) {

      throw new Error(
        "RECEIPT_STATUS_UPDATE_FAILED"
      );

    }


    console.log(
      "📌 RECEIPT ACTUALIZADO:",
      updateReceiptResult.rows[0]
    );


    // ============================================================
    // 23. COMMIT
    // ============================================================

    await client.query(
      "COMMIT"
    );


    transactionStarted =
      false;


    console.log("");
    console.log(
      "✅ ========================================"
    );

    console.log(
      "✅ RECEPCIÓN GUARDADA"
    );


    console.log(
      "📦 PURCHASE ORDERS:",
      purchaseOrderIds
    );


    console.log(
      "📦 PURCHASE ORDER NUMBERS:",
      poResult.rows.map(
        (order) =>
          order.purchase_order_number
      )
    );


    console.log(
      "📥 RECEIPT ID:",
      receiptId
    );


    console.log(
      "📌 STATUS:",
      reception_status
    );


    console.log(
      "📦 RECEIPT LINES:",
      receiptLinesResult.rowCount
    );


    console.log(
      "✅ ========================================"
    );


    // ============================================================
    // 24. RESPONSE
    // ============================================================

    return res
      .status(200)
      .json({

        success: true,

        message:
          "Recepción guardada correctamente",

        data: {

          purchase_order_ids:
            purchaseOrderIds,

          purchase_order_numbers:
            poResult.rows.map(
              (order) =>
                order.purchase_order_number
            ),

          receipt_id:
            receiptId,

          receipt_code:
            updateReceiptResult
              .rows[0]
              .receipt_code,

          reception_status:
            updateReceiptResult
              .rows[0]
              .status,

          saved_lines:
            receiptLinesResult.rowCount,

          lines:
            receiptLinesResult.rows,

        },

      });


  } catch (error) {

    // ============================================================
    // ROLLBACK
    // ============================================================

    if (
      transactionStarted
    ) {

      try {

        await client.query(
          "ROLLBACK"
        );

      } catch (
        rollbackError
      ) {

        console.error(
          "❌ ERROR EJECUTANDO ROLLBACK:",
          rollbackError
        );

      }

    }


    console.error("");
    console.error(
      "❌ ========================================"
    );

    console.error(
      "❌ ERROR GUARDANDO RECEPCIÓN"
    );

    console.error(
      error
    );

    console.error(
      "❌ ========================================"
    );


    return res
      .status(500)
      .json({

        success: false,

        title:
          "Error guardando recepción",

        message:
          error.message ||
          "Error interno del servidor",

      });


  } finally {

    client.release();

  }

}














// Get all purchase order data using its id:
export async function getReceivingByPoId(req, res) {

  const { poIds } = req.query;

  const operatorId =
    req.user?.id;


  console.log("");
  console.log("🚨 ========================================");
  console.log("🚨 IDS RECIBIDOS DESDE FRONTEND");
  console.log("🚨 ========================================");


  // ============================================================
  // VALOR EXACTO QUE VIENE EN QUERY PARAM
  // ============================================================

  console.log(
    "📥 poIds RAW:",
    poIds
  );


  // ============================================================
  // CONVERTIR:
  //
  // "35,39,37"
  //
  // ↓
  //
  // [35, 39, 37]
  // ============================================================

  const purchaseOrderIds = String(
    poIds || ""
  )
    .split(",")
    .map((id) => Number(id))
    .filter(
      (id) =>
        Number.isInteger(id) &&
        id > 0
    );


  console.log(
    "📦 PURCHASE ORDER IDS:",
    purchaseOrderIds
  );


  console.log(
    "📊 TOTAL IDS:",
    purchaseOrderIds.length
  );


  // ============================================================
  // IMPRIMIR CADA ID INDIVIDUALMENTE
  // ============================================================

  purchaseOrderIds.forEach(
    (id, index) => {

      console.log(
        `📦 PO ${index + 1}:`,
        id
      );

    }
  );


  console.log(
    "👤 OPERATOR ID:",
    operatorId
  );


  console.log(
    "🚨 ========================================"
  );

  try {
   // ============================================================
// 1️⃣ BUSCAR TODAS LAS ÓRDENES DE COMPRA
// ============================================================

const poResult = await db.query(
  `
  SELECT
    id,
    purchase_order_number,
    status
  FROM purchase_orders
  WHERE id = ANY($1::bigint[])
  ORDER BY id
  `,
  [purchaseOrderIds]
);


console.log(
  "📦 ÓRDENES ENCONTRADAS:",
  poResult.rows
);


// ============================================================
// 2️⃣ VALIDAR QUE SE ENCONTRÓ AL MENOS UNA
// ============================================================

if (poResult.rowCount === 0) {

  return res.status(404).json({
    success: false,
    message: "PURCHASE_ORDER_NOT_FOUND",
  });

}


// ============================================================
// 3️⃣ VALIDAR QUE TODAS LAS IDS EXISTAN
// ============================================================

if (poResult.rowCount !== purchaseOrderIds.length) {

  const foundIds = poResult.rows.map(
    (order) => Number(order.id)
  );


  const missingIds = purchaseOrderIds.filter(
    (id) => !foundIds.includes(Number(id))
  );


  console.log(
    "❌ IDS NO ENCONTRADOS:",
    missingIds
  );


  return res.status(404).json({

    success: false,

    title:
      "Orden de Compra no disponible",

    message:
      "Una o más órdenes de compra no existen.",

    missingIds,

  });

}


// ============================================================
// 4️⃣ VALIDAR SI ALGUNA ESTÁ CANCELADA
// ============================================================

const cancelledOrder = poResult.rows.find(
  (order) =>
    String(order.status)
      .trim()
      .toLowerCase() === "cancelled"
);


if (cancelledOrder) {

  console.log(
    "❌ ORDEN CANCELADA:",
    cancelledOrder
  );


  return res.status(409).json({

    success: false,

    title:
      "Orden de Compra no disponible",

    message:
      `La orden ${cancelledOrder.purchase_order_number} está cancelada.`,

    data: {
      id:
        cancelledOrder.id,

      purchase_order_number:
        cancelledOrder.purchase_order_number,

      status:
        cancelledOrder.status,
    },

  });

}


// ============================================================
// 5️⃣ TODAS LAS ÓRDENES SON VÁLIDAS
// ============================================================

const purchaseOrders =
  poResult.rows;


console.log(
  "✅ TODAS LAS ÓRDENES SON VÁLIDAS:",
  purchaseOrders
);

  // ============================================================
// 2️⃣ BUSCAR RECEPCIÓN ACTIVA PARA ESTE CONJUNTO EXACTO DE POs
// ============================================================

const receiptResult = await db.query(
  `
  SELECT
    r.id,
    r.receipt_code,
    r.status

  FROM receipts r

  JOIN receipt_purchase_orders rpo
    ON rpo.receipt_id = r.id

  WHERE
    r.status NOT IN (
      'completed',
      'abandoned'
    )

  GROUP BY
    r.id,
    r.receipt_code,
    r.status

  HAVING
    COUNT(*) = $2

    AND COUNT(*) FILTER (
      WHERE rpo.purchase_order_id =
        ANY($1::bigint[])
    ) = $2

  LIMIT 1
  `,
  [
    purchaseOrderIds,
    purchaseOrderIds.length
  ]
);


let receiptId;


// ============================================================
// 3️⃣ SI NO EXISTE → CREAR UNA SOLA RECEPCIÓN
// ============================================================

if (receiptResult.rowCount === 0) {

  console.log(
    "➕ No existe recepción activa para:",
    purchaseOrderIds
  );


  // ==========================================================
  // GENERAR CÓDIGO
  // ==========================================================

  const seqResult = await db.query(
    `
    SELECT
      nextval('receipt_code_seq') AS seq
    `
  );


  const nextNumber =
    seqResult.rows[0].seq;


  const yearReceipt =
    new Date().getFullYear();


  const receiptCodeGenerated =
    `${yearReceipt}-${nextNumber}`;


  console.log(
    "📄 Nuevo receipt code:",
    receiptCodeGenerated
  );


  // ==========================================================
  // CREAR UNA SOLA RECEPCIÓN
  // ==========================================================

  const createReceipt =
    await db.query(
      `
      INSERT INTO receipts (
        receipt_code,
        operator_id,
        status,
        started_at
      )

      VALUES (
        $1,
        $2,
        'in_progress',
        NOW()
      )

      RETURNING
        id,
        receipt_code
      `,
      [
        receiptCodeGenerated,
        operatorId
      ]
    );


  receiptId =
    createReceipt.rows[0].id;


  console.log(
    "✅ RECEIPT CREADO:",
    receiptId
  );


  // ==========================================================
  // RELACIONAR TODAS LAS POs CON EL MISMO RECEIPT
  // ==========================================================

  await db.query(
    `
    INSERT INTO receipt_purchase_orders (
      receipt_id,
      purchase_order_id
    )

    SELECT
      $1,
      unnest($2::bigint[])
    `,
    [
      receiptId,
      purchaseOrderIds
    ]
  );


  console.log(
    "✅ POs vinculadas al receipt:",
    purchaseOrderIds
  );

}


// ============================================================
// SI YA EXISTE → UTILIZAR LA MISMA RECEPCIÓN
// ============================================================

else {

  receiptId =
    receiptResult.rows[0].id;


  console.log(
    "♻️ RECEPCIÓN ACTIVA ENCONTRADA:",
    receiptId
  );

}


   // ============================================================
// BUSCAR RECEPCIONES COMPLETADAS DE TODAS LAS POs
// ============================================================

const completedReceiptsResult = await db.query(
  `
  SELECT DISTINCT
    r.id
  FROM receipts r

  JOIN receipt_purchase_orders rpo
    ON rpo.receipt_id = r.id

  WHERE rpo.purchase_order_id = ANY($1::bigint[])
    AND r.status = 'completed'
  `,
  [purchaseOrderIds]
);


const completedReceiptIds =
  completedReceiptsResult.rows.map(
    (row) => Number(row.id)
  );


console.log(
  "✅ RECEPCIONES COMPLETADAS:",
  completedReceiptIds
);


// ============================================================
// TOTAL RECIBIDO EN RECEPCIONES COMPLETADAS ANTERIORES
//
// IMPORTANTE:
//
// NO usamos MAX.
//
// Una PO puede tener múltiples receipts:
//
// Receipt 23 = 400
// Receipt 24 = 50
//
// Total anterior = 450
// ============================================================

const previousReceivedMap =
  new Map();


if (
  completedReceiptIds.length > 0
) {

  const receiptLinesResult =
    await db.query(
      `
      SELECT
        purchase_order_line_id,

        COALESCE(
          SUM(
            received_qty
          ),
          0
        ) AS total_received_qty

      FROM receipt_lines

      WHERE
        receipt_id =
          ANY($1::bigint[])

      GROUP BY
        purchase_order_line_id
      `,
      [
        completedReceiptIds
      ]
    );


  receiptLinesResult.rows.forEach(
    (row) => {

      previousReceivedMap.set(
        Number(
          row.purchase_order_line_id
        ),

        Number(
          row.total_received_qty
        )
      );

    }
  );

}


console.log(
  "📊 TOTAL RECIBIDO ANTERIORMENTE:",
  previousReceivedMap
);


// ============================================================
// BUSCAR TODAS LAS LÍNEAS DE TODAS LAS POs
// ============================================================

const linesResult = await db.query(
  `
  SELECT
    pol.id,

    -- PO A LA QUE PERTENECE LA LÍNEA
    pol.purchase_order_id,
    po.purchase_order_number,

    pol.sku,
    pol.description,
    pol.ordered_qty,
    pol.received_qty,
    pol.product_exists

  FROM purchase_order_lines pol

  JOIN purchase_orders po
    ON po.id = pol.purchase_order_id

  WHERE pol.purchase_order_id =
    ANY($1::bigint[])

  ORDER BY
    pol.purchase_order_id,
    pol.id
  `,
  [purchaseOrderIds]
);


console.log(
  "📦 PURCHASE ORDER LINES:",
  linesResult.rows
);


// ============================================================
// OBTENER TODOS LOS SKUs SIN DUPLICADOS
// ============================================================

const skus = [
  ...new Set(
    linesResult.rows
      .map((line) => line.sku)
      .filter(Boolean)
  ),
];


console.log(
  "📦 SKUS:",
  skus
);


// ============================================================
// MAPAS DE PRODUCTOS
// ============================================================

const barcodeMap = new Map();

const erpNameMap = new Map();

const erpSkuMap = new Map();

const erpIdMap = new Map();


// ============================================================
// BUSCAR DATOS ERP DE LOS PRODUCTOS
// ============================================================

if (skus.length > 0) {

  const productResult = await db.query(
    `
    SELECT
      sku,
      erp_name,
      erp_sku,
      erp_id

    FROM products

    WHERE sku =
      ANY($1::text[])
    `,
    [skus]
  );


  productResult.rows.forEach(
    (row) => {

      erpNameMap.set(
        row.sku,
        row.erp_name
      );

      erpSkuMap.set(
        row.sku,
        row.erp_sku
      );

      erpIdMap.set(
        row.sku,
        row.erp_id
      );

    }
  );
}


// ============================================================
// BUSCAR BARCODES
// ============================================================

if (skus.length > 0) {

  const barcodeResult = await db.query(
    `
    SELECT
      product_sku,
      barcode

    FROM product_barcodes

    WHERE product_sku =
      ANY($1::text[])
    `,
    [skus]
  );


  console.log(
    "📊 BARCODES:",
    barcodeResult.rows
  );


  barcodeResult.rows.forEach(
    (row) => {

      if (
        !barcodeMap.has(
          row.product_sku
        )
      ) {

        barcodeMap.set(
          row.product_sku,
          []
        );
      }


      barcodeMap
        .get(row.product_sku)
        .push(row.barcode);

    }
  );
}


// ============================================================
// ENRIQUECER TODAS LAS LÍNEAS
// ============================================================

const enrichedLines =
  linesResult.rows.map(
    (line) => {

      const dbQty =
        Number(
          line.received_qty ?? 0
        );


      const previousReceiptQty =
  Number(
    previousReceivedMap.get(
      Number(line.id)
    ) ?? 0
  );


      const barcodes =
        barcodeMap.get(
          line.sku
        ) || [];


      return {

        // ======================================================
        // ID DE PURCHASE_ORDER_LINE
        // ======================================================

        id:
          Number(line.id),


        // ======================================================
        // PO A LA QUE PERTENECE ESTA LÍNEA
        // ======================================================

        purchase_order_id:
          Number(
            line.purchase_order_id
          ),

        purchase_order_number:
          line.purchase_order_number,


        // ======================================================
        // PRODUCTO
        // ======================================================

        sku:
          line.sku,

        description:
          line.description,

        ordered_qty:
          Number(
            line.ordered_qty ?? 0
          ),


        // ======================================================
        // RECEPCIÓN
        // ======================================================

        received_qty:
          dbQty,

        min_received_qty:
          previousReceiptQty,


        // ======================================================
        // BARCODES / ERP
        // ======================================================

        barcodes,

        product_exists:
          barcodes.length > 0,

        erp_name:
          erpNameMap.get(
            line.sku
          ) || null,

        erp_sku:
          erpSkuMap.get(
            line.sku
          ) || null,

        erp_id:
          erpIdMap.get(
            line.sku
          ) || null,

      };

    }
  );


console.log("");
console.log(
  "✅ ========================================"
);
console.log(
  "✅ ENRICHED LINES"
);
console.log(
  "✅ ========================================"
);

console.log(
  enrichedLines
);


// ============================================================
// OBTENER LOS NÚMEROS DE LAS POs
// ============================================================

const purchaseOrderNumbers =
  purchaseOrders.map(
    (order) =>
      order.purchase_order_number
  );


console.log(
  "📦 PURCHASE ORDER NUMBERS:",
  purchaseOrderNumbers
);


// ============================================================
// RESPONDER
// ============================================================

return res.status(200).json({

  success: true,

  data: {

    // IDs de todas las POs
    purchase_order_ids:
      purchaseOrderIds,

    // Labels / números de todas las POs
    purchase_order_numbers:
      purchaseOrderNumbers,

    // Una sola recepción
    receipt_id:
      receiptId,

    // Todas las líneas combinadas
    lines:
      enrichedLines,

  },

});

  } catch (error) {
    console.error("Error fetching receiving by PO ID:", error);

    return res.status(500).json({
      success: false,
      message: "ERROR_FETCHING_RECEIVING",
    });
  }
};













// ============================================================
// CONFIRMAR VARIAS ÓRDENES DE COMPRA POR ID
// ============================================================

export async function confirmingIdOrder(req, res) {

  const {
    poIds,
    invoiceNo,
    supplier,
  } = req.body ?? {};

  const userId = req.user.id;


  console.log("");
  console.log("📦 ========================================");
  console.log("📦 CONFIRMANDO ÓRDENES DE COMPRA");
  console.log("📦 PO IDs recibidos:", poIds);
  console.log("📦 ========================================");


  // ============================================================
  // 1. VALIDAR ARRAY
  // ============================================================

  if (
    !Array.isArray(poIds) ||
    poIds.length === 0
  ) {

    return res.status(400).json({
      success: false,
      title: "Orden de Compra requerida",
      message:
        "Debe seleccionar al menos una orden de compra.",
    });
  }


  // ============================================================
  // 2. NORMALIZAR IDs
  // ============================================================

  const normalizedPoIds = [
    ...new Set(
      poIds.map(
        (id) => Number(id)
      )
    ),
  ];


  // ============================================================
  // 3. VALIDAR IDs
  // ============================================================

  const invalidId =
    normalizedPoIds.some(
      (id) =>
        !Number.isInteger(id) ||
        id <= 0
    );


  if (invalidId) {

    return res.status(400).json({
      success: false,
      title:
        "Orden de Compra no disponible",
      message:
        "Una o más órdenes tienen un ID inválido.",
    });
  }


  // ============================================================
  // 4. SINCRONIZAR LÍNEAS DESDE ADM CLOUD
  //
  // MUY IMPORTANTE:
  // HACER ESTO ANTES DEL BEGIN / FOR UPDATE
  // ============================================================

  let admCloudSyncResult;


  try {

    console.log("");
    console.log("☁️ ========================================");
    console.log("☁️ SINCRONIZANDO DETALLES ADM CLOUD");
    console.log(
      "📥 WMS PO IDs:",
      normalizedPoIds
    );
    console.log("☁️ ========================================");


    admCloudSyncResult =
      await syncAdmCloudPurchaseOrderLinesByIds(
        normalizedPoIds
      );


    console.log("");
    console.log(
      "✅ RESULTADO SYNC ADM CLOUD:"
    );

    console.dir(
      admCloudSyncResult,
      {
        depth: null
      }
    );


    // ==========================================================
    // SI ALGUNA OC FALLÓ → NO CONTINUAR RECEPCIÓN
    // ==========================================================

    if (!admCloudSyncResult.success) {

      return res
        .status(409)
        .json({

          success: false,

          title:
            "Error sincronizando órdenes",

          message:
            "Una o más órdenes no pudieron sincronizarse con Adm Cloud.",

          synchronization:
            admCloudSyncResult,

        });
    }


  } catch (error) {

    console.error("");
    console.error(
      "❌ ERROR SINCRONIZANDO ADM CLOUD:"
    );
    console.error(error);


    return res
      .status(
        error.status || 500
      )
      .json({

        success: false,

        title:
          "Error sincronizando órdenes",

        message:
          error.message ||
          "No fue posible sincronizar las órdenes con Adm Cloud.",

      });
  }


  // ============================================================
  // 5. AHORA ABRIR CONEXIÓN DE RECEIVING
  // ============================================================

  const client =
    await db.connect();

  let transactionStarted =
    false;


  try {

    // ==========================================================
    // 6. BEGIN
    // ==========================================================

    await client.query(
      "BEGIN"
    );

    transactionStarted =
      true;


    // ==========================================================
    // 7. BUSCAR Y BLOQUEAR TODAS LAS ÓRDENES
    // ==========================================================

    const ordersResult =
      await client.query(
        `
        SELECT
          id,
          purchase_order_number,
          supplier_name,
          invoice_numbers,
          status

        FROM purchase_orders

        WHERE id =
          ANY($1::bigint[])

        FOR UPDATE
        `,
        [normalizedPoIds]
      );


    console.log(
      "📥 Órdenes encontradas:",
      ordersResult.rowCount
    );


    // ==========================================================
    // 8. VALIDAR QUE TODAS EXISTAN
    // ==========================================================

    if (
      ordersResult.rowCount !==
      normalizedPoIds.length
    ) {

      const foundIds =
        ordersResult.rows.map(
          (order) =>
            Number(order.id)
        );


      const missingIds =
        normalizedPoIds.filter(
          (id) =>
            !foundIds.includes(id)
        );


      console.log(
        "❌ Órdenes no encontradas:",
        missingIds
      );


      await client.query(
        "ROLLBACK"
      );

      transactionStarted =
        false;


      return res
        .status(404)
        .json({

          success: false,

          title:
            "Orden de Compra no disponible",

          message:
            "Una o más órdenes de compra no existen.",

          missingIds,

        });
    }


    // ==========================================================
    // 9. VALIDAR STATUS
    // ==========================================================

    const unavailableOrder =
      ordersResult.rows.find(
        (order) => {

          const status =
            String(
              order.status
            )
              .trim()
              .toLowerCase();


          return (
            status === "completed" ||
            status === "abandoned"
          );

        }
      );


    if (unavailableOrder) {

      console.log("");
      console.log(
        "❌ ORDEN NO DISPONIBLE:"
      );

      console.log(
        "📦 Orden:",
        unavailableOrder.purchase_order_number
      );

      console.log(
        "📌 Status:",
        unavailableOrder.status
      );


      await client.query(
        "ROLLBACK"
      );

      transactionStarted =
        false;


      return res
        .status(409)
        .json({

          success: false,

          title:
            "Orden de Compra no disponible",

          message:
            `La orden ${unavailableOrder.purchase_order_number} no está activa.`,

          data: {

            id:
              unavailableOrder.id,

            label:
              unavailableOrder.purchase_order_number,

            status:
              unavailableOrder.status,

          },

        });
    }


    console.log("");
    console.log(
      "✅ TODAS LAS ÓRDENES ESTÁN ACTIVAS"
    );


    console.log(
      ordersResult.rows.map(
        (order) => ({
          id:
            order.id,

          po:
            order.purchase_order_number,

          status:
            order.status,
        })
      )
    );


    // ==========================================================
    // 10. PREPARAR CAMPOS PARA UPDATE
    // ==========================================================

    const fields = [];
    const values = [];

    let idx = 1;


    // ==========================================================
    // SUPPLIER
    // ==========================================================

    if (supplier) {

      fields.push(
        `supplier_name = TRIM(UPPER($${idx}))`
      );

      values.push(
        supplier
      );

      idx++;
    }


    // ==========================================================
    // INVOICE
    // ==========================================================

    if (invoiceNo) {

      fields.push(`
        invoice_numbers =
          CASE

            WHEN invoice_numbers IS NULL
              THEN ARRAY[TRIM($${idx})]

            ELSE array_append(
              invoice_numbers,
              TRIM($${idx})
            )

          END
      `);


      values.push(
        invoiceNo
      );

      idx++;
    }


    // ==========================================================
    // 11. SI NO HAY CAMPOS PARA MODIFICAR
    // ==========================================================

    if (
      fields.length === 0
    ) {

      await client.query(
        "COMMIT"
      );

      transactionStarted =
        false;


      return res
        .status(200)
        .json({

          success: true,

          data:
            ordersResult.rows,

          admCloudSynchronization:
            admCloudSyncResult,

        });
    }


    // ==========================================================
    // 12. UPDATE PURCHASE ORDERS
    // ==========================================================

    const updateQuery = `
      UPDATE purchase_orders

      SET
        ${fields.join(", ")}

      WHERE id = ANY(
        $${idx}::bigint[]
      )

      RETURNING
        id,
        purchase_order_number,
        supplier_name,
        invoice_numbers,
        status
    `;


    values.push(
      normalizedPoIds
    );


    const updatedOrders =
      await client.query(
        updateQuery,
        values
      );


    console.log("");
    console.log(
      "✅ ÓRDENES ACTUALIZADAS:",
      updatedOrders.rowCount
    );


    // ==========================================================
    // 13. PROCESAR RECEIPTS
    // ==========================================================

    const receipts = [];


    for (
      const order
      of updatedOrders.rows
    ) {

      const purchaseOrderId =
        order.id;


      console.log("");
      console.log(
        "📦 ----------------------------------------"
      );

      console.log(
        "📦 Procesando:",
        order.purchase_order_number
      );

      console.log(
        "🆔 Purchase Order ID:",
        purchaseOrderId
      );


      // ========================================================
      // 14. BUSCAR RECEIPT ACTIVO
      // ========================================================

      const receiptResult =
        await client.query(
          `
          SELECT
            id,
            receipt_code,
            status

          FROM receipts

          WHERE
            purchase_order_id = $1

            AND status NOT IN (
              'completed',
              'abandoned'
            )

          LIMIT 1
          `,
          [purchaseOrderId]
        );


      let receiptId;
      let receiptCode;


      // ========================================================
      // 15. NO EXISTE RECEIPT → CREAR
      // ========================================================

      if (
        receiptResult.rowCount ===
        0
      ) {

        console.log(
          "➕ No existe recepción activa."
        );

        console.log(
          "➕ Creando recepción..."
        );


        // ======================================================
        // SEQUENCE
        // ======================================================

        const seqResult =
          await client.query(
            `
            SELECT
              nextval(
                'receipt_code_seq'
              ) AS seq
            `
          );


        const nextNumber =
          seqResult.rows[0].seq;


        const year =
          new Date().getFullYear();


        receiptCode =
          `${year}-${nextNumber}`;


        // ======================================================
        // INSERT RECEIPT
        // ======================================================

        const createReceipt =
          await client.query(
            `
            INSERT INTO receipts
            (
              receipt_code,
              purchase_order_id,
              operator_id,
              status,
              started_at,
              invoice
            )

            VALUES
            (
              $1,
              $2,
              $3,
              'in_progress',
              NOW(),
              $4
            )

            RETURNING
              id,
              receipt_code,
              status
            `,
            [
              receiptCode,
              purchaseOrderId,
              userId,
              invoiceNo || null,
            ]
          );


        receiptId =
          createReceipt.rows[0].id;


        console.log(
          "✅ Receipt creado:"
        );

        console.log(
          "🆔 Receipt ID:",
          receiptId
        );

        console.log(
          "📄 Receipt Code:",
          receiptCode
        );
      }


      // ========================================================
      // 16. YA EXISTE RECEIPT → REUTILIZAR
      // ========================================================

      else {

        receiptId =
          receiptResult.rows[0].id;


        receiptCode =
          receiptResult
            .rows[0]
            .receipt_code;


        console.log(
          "♻️ Recepción activa existente"
        );

        console.log(
          "🆔 Receipt ID:",
          receiptId
        );


        // ======================================================
        // ACTUALIZAR FACTURA DEL RECEIPT
        // ======================================================

        if (invoiceNo) {

          await client.query(
            `
            UPDATE receipts

            SET
              invoice = $1

            WHERE
              id = $2
            `,
            [
              invoiceNo,
              receiptId,
            ]
          );


          console.log(
            "📄 Factura actualizada:",
            invoiceNo
          );
        }
      }


      // ========================================================
      // GUARDAR RESULTADO
      // ========================================================

      receipts.push({

        purchaseOrderId,

        purchaseOrderNumber:
          order.purchase_order_number,

        receiptId,

        receiptCode,

      });
    }


    // ==========================================================
    // 17. COMMIT
    // ==========================================================

    await client.query(
      "COMMIT"
    );

    transactionStarted =
      false;


    console.log("");
    console.log(
      "✅ ========================================"
    );

    console.log(
      "✅ ÓRDENES CONFIRMADAS CORRECTAMENTE"
    );

    console.log(
      "📦 Total órdenes:",
      updatedOrders.rowCount
    );

    console.log(
      "📥 Total receipts:",
      receipts.length
    );

    console.log(
      "✅ ========================================"
    );


    // ==========================================================
    // 18. RESPONSE
    // ==========================================================

    return res
      .status(200)
      .json({

        success: true,

        message:
          "PURCHASE_ORDERS_CONFIRMED",

        data: {

          orders:
            updatedOrders.rows,

          receipts,

          admCloudSynchronization:
            admCloudSyncResult,

        },

      });


  } catch (error) {

    // ==========================================================
    // ERROR
    // ==========================================================

    if (transactionStarted) {

      try {

        await client.query(
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


    console.error("");
    console.error(
      "❌ ========================================"
    );

    console.error(
      "❌ ERROR CONFIRMANDO ÓRDENES"
    );

    console.error(error);

    console.error(
      "❌ ========================================"
    );


    return res
      .status(500)
      .json({

        success: false,

        title:
          "Error confirmando órdenes",

        message:
          error.message ||
          "ERROR_CONFIRMING_ORDERS",

      });


  } finally {

    // ==========================================================
    // LIBERAR CONEXIÓN
    // ==========================================================

    client.release();
  }
}
























// Search ALL open or patial purchase orders
export async function gettingOpenOrders(req, res) {
  try {

    // 1️⃣ Traer órdenes actualizadas
    const result = await db.query(`
      SELECT id, purchase_order_number
      FROM purchase_orders
      WHERE status IN ('open', 'partial')
      ORDER BY created_at ASC
    `);

    // 2️⃣ RESPONDER AL FRONTEND
    res.status(200).json({
      success: true,
      message: "Orders fetched successfully",
      data: result.rows,
    });

    /*// 3️⃣ Ejecutar sync EN BACKGROUND
    setImmediate(async () => {

      console.time("⏱ Tiempo total sync");

    // 🔹 Sync Items
      try {
        console.log("🔄 Sync Items...");
        await syncAllItems();
      } catch (err) {
        console.error("❌ Error en syncAllItems:", err.message);
      }

    // 🔹 Sync Purchase Orders
      try {
        console.log("🔄 Sync Purchase Orders...");
        await syncAllPurchaseOrders();
      } catch (err) {
        console.error("❌ Error en syncAllPurchaseOrders:", err.message);
      }

      console.timeEnd("⏱ Tiempo total sync");
    });*/

  } catch (error) {

    console.error("Error fetching purchase orders", error);

    return res.status(500).json({
      success: false,
      message: "ERROR_FETCHING_PURCHASE_ORDERS",
    });
  }
}

