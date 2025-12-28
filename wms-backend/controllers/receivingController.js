import { db } from "../db.js";

// Save received quantities in the data base


export async function savingReception(req, res) {
 
console.log("🚀 HIT /receiving/save");
console.log("HEADERS:", req.headers);
console.log("BODY:", req.body);

  const client = await db.connect();

  try {
    const {
      purchase_order_id,
      purchase_order_number,
      lines,
    } = req.body;

    /* ---------------- VALIDACIONES ---------------- */

    if (!purchase_order_id || !purchase_order_number || !Array.isArray(lines)) {
      return res.status(400).json({
        success: false,
        message: "Datos incompletos",
      });
    }

    if (lines.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No hay líneas para actualizar",
      });
    }

    for (const line of lines) {
      if (
        typeof line.id !== "number" ||
        typeof line.received_qty !== "number" ||
        line.received_qty < 0
      ) {
        return res.status(400).json({
          success: false,
          message: "Formato inválido en líneas",
        });
      }
    }

    /* ---------------- INICIO TRANSACCIÓN ---------------- */

    await client.query("BEGIN");

    /* ---------------- VALIDAR ORDEN ---------------- */

    const poResult = await client.query(
      `
      SELECT id, status
      FROM purchase_orders
      WHERE id = $1 AND purchase_order_number = $2
      FOR UPDATE
      `,
      [purchase_order_id, purchase_order_number]
    );

    if (poResult.rowCount === 0) {
      throw new Error("Orden de compra no encontrada");
    }

    /* ---------------- ACTUALIZAR STATUS ---------------- */
    if (poResult.rows[0].status !== "partial") {
      await client.query(
        `
      UPDATE purchase_orders
      SET status = 'partial'
      WHERE id = $1
      `,
        [purchase_order_id]
      );
    }
    /* ---------------- UPDATE MASIVO DE LÍNEAS ---------------- */

    /**
     * Construimos arrays para un solo UPDATE usando UNNEST
     */
    const lineIds = lines.map(l => l.id);
    const receivedQtys = lines.map(l => l.received_qty);

    await client.query(
      `
      UPDATE purchase_order_lines pol
      SET received_qty = data.received_qty
      FROM (
        SELECT
          UNNEST($1::BIGINT[]) AS id,
          UNNEST($2::NUMERIC[]) AS received_qty
      ) AS data
      WHERE pol.id = data.id
        AND pol.purchase_order_id = $3
      `,
      [lineIds, receivedQtys, purchase_order_id]
    );

    /* ---------------- COMMIT ---------------- */

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "Recepción guardada correctamente",
    });

  } catch (error) {
    await client.query("ROLLBACK");

    console.error("❌ Error confirmando recepción:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Error interno del servidor",
    });
  } finally {
    client.release();
  }
}



// Get all purchase order data using its id:

export async function getReceivingByPoId(req, res) {
  const { poId } = req.params;

  if (!poId) {
    return res.status(400).json({
      success: false,
      message: "PO_ID_REQUIRED",
    });
  }

  try {
    /* 1️⃣ Buscar la orden de compra */
    const poResult = await db.query(
      `
      SELECT id, purchase_order_number
      FROM purchase_orders
      WHERE id = $1
      LIMIT 1
      `,
      [poId]
    );

    if (poResult.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "PURCHASE_ORDER_NOT_FOUND",
      });
    }

    const purchaseOrder = poResult.rows[0];

    /* 2️⃣ Buscar las líneas */
    const linesResult = await db.query(
      `
      SELECT
        id,
        sku,
        description,
        ordered_qty,
        received_qty,
        product_exists
      FROM purchase_order_lines
      WHERE purchase_order_id = $1
      ORDER BY id ASC
      `,
      [purchaseOrder.id]
    );

    console.log(linesResult.rows);

    /* 3️⃣ Obtener SKUs válidos */
    const validSkus = linesResult.rows
      .filter(line => line.product_exists)
      .map(line => line.sku);

    /* 4️⃣ Buscar barcodes */
    let barcodeMap = new Map();

    if (validSkus.length > 0) {
      const barcodeResult = await db.query(
        `
        SELECT product_sku, barcode
        FROM product_barcodes
        WHERE product_sku = ANY($1)
        `,
        [validSkus]
      );

      barcodeResult.rows.forEach(row => {
        if (!barcodeMap.has(row.product_sku)) {
          barcodeMap.set(row.product_sku, []);
        }
        barcodeMap.get(row.product_sku).push(row.barcode);
      });
    }

    /* 5️⃣ Enriquecer líneas */
    const enrichedLines = linesResult.rows.map(line => ({
      ...line,
      barcodes: line.product_exists
        ? barcodeMap.get(line.sku) || []
        : []
    }));



    /* 6️⃣ Responder */
    return res.status(200).json({
      success: true,
      data: {
        id: purchaseOrder.id,
        purchase_order_number: purchaseOrder.purchase_order_number,
        lines: enrichedLines,
      },
    });
  } catch (error) {
    console.error("Error fetching receiving by PO ID:", error);

    return res.status(500).json({
      success: false,
      message: "ERROR_FETCHING_RECEIVING",
    });
  }
}


// Confirm than especific id exist
export async function confirmingIdOrder(req, res) {
  const { poNumber, invoiceNo, supplier } = req.body;
  // 1️⃣ Validación mínima
  if (!poNumber) {
    return res.status(400).json({
      success: false,
      message: "PO_NUMBER_REQUIRED",
    });
  }

  try {
    // 2️⃣ Construcción dinámica del UPDATE
    const fields = [];
    const values = [];
    let idx = 1;

    // supplier (opcional)
    if (supplier) {
      fields.push(`supplier_name = TRIM(UPPER($${idx}))`);
      values.push(supplier);
      idx++;
    }

    // invoiceNo (opcional)
    if (invoiceNo) {
      fields.push(`
        invoice_numbers =
          CASE
            WHEN invoice_numbers IS NULL THEN ARRAY[TRIM($${idx})]
            ELSE array_append(invoice_numbers, TRIM($${idx}))
          END
      `);
      values.push(invoiceNo);
      idx++;
    }

    if (fields.length === 0) {
      const selectResult = await db.query(
        `
    SELECT id, purchase_order_number
    FROM purchase_orders
    WHERE purchase_order_number = TRIM($1)
    `,
        [poNumber]
      );

      if (selectResult.rowCount === 0) {
        return res.status(404).json({
          success: false,
          message: "PURCHASE_ORDER_NOT_FOUND",
        });
      }

      return res.status(200).json({
        success: true,
        data: selectResult.rows[0],
      });
    }

    // 3️⃣ Query final
    const query = `
      UPDATE purchase_orders
      SET ${fields.join(", ")}
      WHERE purchase_order_number = TRIM($${idx})
      RETURNING id, purchase_order_number
    `;

    values.push(poNumber);

    const result = await db.query(query, values);

    // PO no encontrada
    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "PURCHASE_ORDER_NOT_FOUND",
      });
    }

    return res.status(200).json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    console.error("Error confirming order:", error);
    return res.status(500).json({
      success: false,
      message: "ERROR_CONFIRMING_ORDER",
    });
  }
};



// Search ALL open or patial purchase orders
export async function gettingOpenOrders(req, res) {
  try {
    const result = await db.query(`
      SELECT id, purchase_order_number
      FROM purchase_orders
      WHERE status IN ('open', 'partial')
      ORDER BY created_at ASC
    `);

    res.status(200).json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error("Error fetching purchase orders", error);
    res.status(500).json({
      success: false,
      message: "ERROR_FETCHING_PURCHASE_ORDERS",
    });
  }
}