import { db } from "../db.js";


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
  const { poId } = req.params;

  if (!poId) {
    return res.status(400).json({
      success: false,
      message: "PURCHASE_ORDER_ID_REQUIRED",
    });
  }

  const purchaseOrderId = Number(poId);

  if (isNaN(purchaseOrderId)) {
    return res.status(400).json({
      success: false,
      message: "INVALID_PURCHASE_ORDER_ID",
    });
  }

  try {
    /* 1️⃣ Validar orden de compra */
    const poResult = await db.query(
      `
            SELECT id, purchase_order_number, status
            FROM purchase_orders
            WHERE id = $1
            LIMIT 1
            `,
      [purchaseOrderId]
    );

    if (poResult.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "PURCHASE_ORDER_NOT_FOUND",
      });
    }

    const purchaseOrder = poResult.rows[0];

    /* 2️⃣ Validar status = 'partial' */
    if (purchaseOrder.status !== "partial") {
      return res.status(409).json({
        success: false,
        message: "PURCHASE_ORDER_NOT_PARTIAL",
      });
    }

    /* 3️⃣ Buscar líneas con diferencias */
    const linesResult = await db.query(
      `
            SELECT
                id,
                sku,
                description,
                ordered_qty,
                received_qty,
                difference_qty,
                product_exists
            FROM purchase_order_lines
            WHERE purchase_order_id = $1
              AND ordered_qty <> received_qty
            ORDER BY id ASC
            `,
      [purchaseOrderId]
    );

    /* 5️⃣ Enriquecer líneas */
    const enrichedLines = linesResult.rows.map(line => ({
      ...line,
      barcodes: "NO-NEEDED"
    }));

    /* 4️⃣ Respuesta */
    return res.status(200).json({
      success: true,
      data: {
        purchase_order_id: purchaseOrder.id,
        purchase_order_number: purchaseOrder.purchase_order_number,
        lines: enrichedLines,
      },
    });

  } catch (error) {
    console.error("Error validating receiving:", error);

    return res.status(500).json({
      success: false,
      message: "ERROR_VALIDATING_RECEIVING",
    });
  }
}



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
      reception_status,
      lines,
    } = req.body;

    /* ---------------- VALIDACIONES ---------------- */

    if (!purchase_order_id || !purchase_order_number || !Array.isArray(lines)) {
      return res.status(400).json({
        success: false,
        message: "Datos incompletos",
      });
    }

    console.log(reception_status);

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

    if (reception_status === "paused") {
      await db.query(
        `
        UPDATE receipts
        SET status = 'paused'
        WHERE purchase_order_id = $1
          AND status = 'in_progress'
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
};


// Get all purchase order data using its id:
export async function getReceivingByPoId(req, res) {
  const { poId } = req.params;
  const operatorId = req.user?.id; // asumiendo auth middleware
  console.log(operatorId);
  console.log(req.user);

  if (!poId) {
    return res.status(400).json({
      success: false,
      message: "PO_ID_REQUIRED",
    });
  };

  try {
    /* 1️⃣ Buscar la orden de compra */
    const poResult = await db.query(
      `
      SELECT id, purchase_order_number, status
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

    /* ⛔ PO cancelada → no permitir recepción */
    if (purchaseOrder.status === "cancelled") {
      return res.status(409).json({
        success: false,
        message: "PURCHASE_ORDER_CANCELLED",
      });
    }

    /* 2️⃣ Buscar recepción activa */
    let receiptResult = await db.query(
      `
      SELECT id, status
      FROM receipts
      WHERE purchase_order_id = $1
        AND status NOT IN ('completed', 'abandoned')
      LIMIT 1
      `,
      [purchaseOrder.id]
    );

    let receiptId;

    /* 3️⃣ Si NO existe recepción → crearla */
    if (receiptResult.rowCount === 0) {
      const createReceipt = await db.query(
        `
        INSERT INTO receipts (
          purchase_order_id,
          operator_id,
          status,
          started_at
        )
        VALUES ($1, $2, 'in_progress', NOW())
        RETURNING id
        `,
        [purchaseOrder.id, operatorId]
      );

      receiptId = createReceipt.rows[0].id;
    } else {
      receiptId = receiptResult.rows[0].id;
    }



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
};


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