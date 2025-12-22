import { db } from "../db.js";

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

    /* 3️⃣ Responder */
    return res.status(200).json({
      success: true,
      data: {
        id: purchaseOrder.id,
        purchase_order_number: purchaseOrder.purchase_order_number,
        lines: linesResult.rows,
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