import { db } from "../db.js";
import { buildReceiptHtml } from "../templates/build-nota-recepcion.js";
import { generatePdf } from "../templates/generate-nota-recepcion.js";
import { randomUUID } from "crypto";
import { uploadPdfToS3 } from "../services/s3UploadPdf.js";
import { sendReceiptEmail } from "../services/sendReceiptEmail.js";

export async function CloseReception(req, res) {
  console.log("END END END END POINT POINT");
  const { purchaseOrderId, receivingLocationId } = req.body;
  console.log("ID DE LA ORDEN DE COMPRA: ", purchaseOrderId);
  console.log("ID LA UBICACION: ", receivingLocationId);
  const client = await db.connect();

  try {
    await client.query("BEGIN");

    //----------------------------

    // 1️⃣ Verificar que la PO existe
    const poResult = await client.query(
      `
      SELECT id
      FROM purchase_orders
      WHERE id = $1
      FOR UPDATE
      `,
      [purchaseOrderId]
    );

    if (poResult.rowCount === 0) {
      throw new Error("PO_NO_EXISTE");
    }

    //--------------------------------------

    /* 2️⃣ Cerrar la orden de compra
    await client.query(
      `
      UPDATE purchase_orders
      SET status = 'closed'
      WHERE id = $1
      `,
      [purchaseOrderId]
    );*/
    //-----------------------------------------------
    // 3️⃣ Buscar la recepción activa de esa PO
    const receiptResult = await client.query(
      `
      SELECT id, receipt_code
      FROM receipts
      WHERE purchase_order_id = $1
        AND status NOT IN ('completed', 'abandoned')
      FOR UPDATE
      `,
      [purchaseOrderId]
    );

    if (receiptResult.rowCount === 0) {
      throw new Error("RECEIPT_NO_EXISTE");
    }

    const receiptId = receiptResult.rows[0].id;
    const receipt_code = receiptResult.rows[0].receipt_code;

    //------------------------------------------------------
    // 5️⃣ Obtener líneas de la orden de compra
    const poLinesResult = await client.query(
      `
      SELECT
        id,
        sku,
        ordered_qty,
        received_qty
      FROM purchase_order_lines
      WHERE purchase_order_id = $1
      `,
      [purchaseOrderId]
    );

    if (poLinesResult.rowCount === 0) {
      throw new Error("PO_LINES_NO_EXISTE");
    }

    const lines = poLinesResult.rows;
    const skus = lines.map(l => l.sku);
    console.log(lines);
    //-----------------------------------------------------
    // BUSCAR LA DESCRIPCION DE LOS PRODUCTOS DE LA ORDEN
    const productsResult = await client.query(
      `
      SELECT sku, description
      FROM products
      WHERE sku = ANY($1)
      `,
      [skus]
    );
    const productMap = {};
    for (const p of productsResult.rows) {
      productMap[p.sku] = p.description;
    }

    //------------------------------------------------
    // 1️⃣ Traer encabezado completo
    const headerResult = await client.query(
      `
  SELECT
  r.id AS receipt_id,
  r.receipt_code,
  r.started_at,
  r.finished_at,
  r.invoice,
  r.status,

  po.id AS purchase_order_id,
  po.purchase_order_number,
  po.supplier_name,

  u.id AS user_id,
  u.full_name AS user_name,

  c.slug AS company_slug,
  c.receipt_email AS company_receipt_email

FROM receipts r

JOIN purchase_orders po 
  ON po.id = r.purchase_order_id

JOIN users u 
  ON u.id = r.operator_id

JOIN companies c 
  ON c.id = 1

WHERE r.id = $1;

  `,
      [receiptId]
    );

    // 2️⃣ Validar existencia
    if (headerResult.rowCount === 0) {
      throw new Error("RECEIPT_HEADER_NOT_FOUND");
    }

    const header = headerResult.rows[0];
    console.log(header);
    // 3️⃣ Validaciones mínimas
    if (!header.receipt_code) throw new Error("RECEIPT_CODE_MISSING");
    if (!header.purchase_order_number) throw new Error("PO_NUMBER_MISSING");
    if (!header.user_name) throw new Error("USER_NAME_MISSING");

    //----------------------------------------------------
    //BUSCAR LA INFORMACION DE LA UBICACION

    const locationResult = await client.query(
      `
      SELECT id, warehouse_id, code, location_type
      FROM locations
      WHERE id = $1
        AND is_active = true
      LIMIT 1
      `,
      [receivingLocationId]
    );

    if (locationResult.rowCount === 0) {
      throw new Error("RECEIVING_LOCATION_NOT_FOUND");
    }

    const receivingLocation = locationResult.rows[0];

    const locationId = receivingLocation.id;
    const warehouseId = receivingLocation.warehouse_id;

    console.log("📍 Location ID:", locationId);
    console.log("🏬 Warehouse ID:", warehouseId);

    // AGREGAR TODAS LAS DESCRIPCIONES PARA LAS LINES PDF
    const enrichedLines = lines.map((line, index) => {
      const difference_qty = line.received_qty - line.ordered_qty;

      return {
        line_no: index + 1,                // 🔢 1,2,3...
        sku: line.sku,
        description: productMap[line.sku] || "SIN DESCRIPCIÓN",
        ordered_qty: line.ordered_qty,
        received_qty: line.received_qty,
        difference_qty,                    // ➖ calculado
      };
    });

    console.log("LINES FINAL", enrichedLines);

    //CREAR STOCKLINES

    // 🔹 Solo líneas con cantidad > 0
    const stockLines = enrichedLines.filter(l => Number(l.received_qty) > 0);

    //---------------------------------------------------
    // 4️⃣ Preparar objeto limpio para PDF
    const headerPDF = {
      receiptId: header.receipt_id,
      receiptCode: header.receipt_code,
      startedAt: header.started_at,
      finishedAt: header.finished_at,
      invoice: header.invoice,
      status: header.status,

      purchaseOrderId: header.purchase_order_id,
      poNumber: header.purchase_order_number,
      supplierName: header.supplier_name,

      userId: header.user_id,
      userName: header.user_name,
      company_receipt_email: header.company_receipt_email,
      company_slug: header.company_slug,
    };

    console.log("📄 HEADER PDF:", headerPDF);
    console.log("📄 HEADER PDF:", headerPDF);

    //-------------------------------------------------
    // 4️⃣ Marcar la recepción como completed
    await client.query(
      `
      UPDATE receipts
      SET status = 'completed',
          finished_at = NOW()
      WHERE id = $1
      `,
      [receiptId]
    );
    //---------------------------------------------------
    // 6️⃣ Insertar líneas en receipt_lines
    for (const line of poLinesResult.rows) {
      await client.query(
        `
        INSERT INTO receipt_lines
        (
          receipt_id,
          purchase_order_line_id,
          sku,
          ordered_qty,
          received_qty
        )
        VALUES
        ($1, $2, $3, $4, $5)
        `,
        [
          receiptId,
          line.id,
          line.sku,
          line.ordered_qty,
          line.received_qty,
        ]
      );
    }

    //----------------------------------------------------
    //PONER LA CANTIDAD POR UBICACION POR CADA PRODUCTO
    if (stockLines.length > 0) {

      const values = [];
      const params = [];

      stockLines.forEach((line, i) => {
        const base = i * 4; // 👈 ahora son 4 columnas

        values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);

        params.push(
          warehouseId,          // ✅ warehouse_id
          locationId,           // ✅ location_id
          line.sku,             // product_sku
          line.received_qty     // qty
        );
      });

      const upsertInventorySQL = `
    INSERT INTO inventory_by_location
      (warehouse_id, location_id, product_sku, qty_on_hand)
    VALUES
      ${values.join(",")}
    ON CONFLICT (warehouse_id, location_id, product_sku)
    DO UPDATE SET
      qty_on_hand = inventory_by_location.qty_on_hand
                  + EXCLUDED.qty_on_hand
  `;

      await client.query(upsertInventorySQL, params);
    }


    //------------------------------------------------
    // REGISTRAR MOVIMIENTOS DE INVENTARIO (HISTORIAL)

    if (stockLines.length > 0) {

      const moveValues = [];
      const moveParams = [];

      stockLines.forEach((line, i) => {
        const base = i * 7;

        moveValues.push(`
      ($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4},
       $${base + 5}, $${base + 6}, $${base + 7})
    `);

        moveParams.push(
          line.sku,              // ✅ product_sku
          null,                  // from_location_id (entra al almacén)
          locationId,            // to_location_id
          line.received_qty,     // qty
          "RECEIPT",             // movement_type
          "RECEPTION",           // reference_type
          receiptId.toString()   // reference_id
        );
      });

      const insertMovementsSQL = `
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
        ${moveValues.join(",")}
      `;

      await client.query(insertMovementsSQL, moveParams);
    }



    //---------------------------------------------------
    await client.query("COMMIT");

    //--------------------------------------------------
    // CREAR EL PDF CON LA INFORMACION

    const html = buildReceiptHtml(headerPDF, enrichedLines);
    let pdf = null;

    try {
      pdf = await generatePdf(html);

    } catch (err) {
      console.error("⚠️ PDF falló, recepción cerrada igual:", err);
    }


    //--------------------------------------------------
    //GENERAR NOMBRE DEL FILE:
    const tenantSlug = header.company_slug;
    // headerPDF.receiptId
    const year = new Date().getFullYear();  // 2026
    const uuid = randomUUID();

    // 📄 nombre del archivo
    const fileName = `receipt_${year}_${receiptId}_${uuid}.pdf`;

    // 🗂 ruta en S3 (multi-tenant)
    const s3Key = `${tenantSlug}/receipts/${fileName}`;

    // ☁️ subir a S3
    await uploadPdfToS3({
      buffer: pdf,
      key: s3Key,
    });

    console.log("✅ PDF subido a S3:", s3Key);


    // Guardar en la base de datos el s3Key
    await client.query(
      `
      UPDATE receipts
      SET pdf_s3_key = $1
      WHERE id = $2
      `,
      [s3Key, headerPDF.receiptId]
    );

    //------------------------------------------------
    //MANDAR PDF POR CORREO

    // después de generar el PDF
    await sendReceiptEmail({
      to: header.company_receipt_email,
      pdfBuffer: pdf,
      receiptCode: header.receipt_code,
      companyName: header.company_slug,
    });


    return res.status(200).json({
      success: true,
      message: "Recepción cerrada correctamente",
      receiptId,
      receiptCode: header.receipt_code,
      pdfKey: s3Key
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error("Error cerrando recepción:", error.message);

    return res.status(400).json({
      success: false,
      code: error.message,
      message: "Error cerrando la recepción",
    });

  } finally {
    client.release();
  }
};



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
    const seqResult = await db.query(
      `SELECT nextval('receipt_code_seq') AS seq`
    );

    const nextNumber = seqResult.rows[0].seq;
    const yearReceipt = new Date().getFullYear();

    const receiptCodeGenerated = `${yearReceipt}-${nextNumber}`;
    console.log("NEXTNUMBER", nextNumber);
    console.log("YEAR", yearReceipt);

    /* 3️⃣ Si NO existe recepción → crearla */
    if (receiptResult.rowCount === 0) {
      const createReceipt = await db.query(
        `
        INSERT INTO receipts (
          receipt_code,
          purchase_order_id,
          operator_id,
          status,
          started_at
        )
        VALUES ($1, $2, $3, 'in_progress', NOW())
        RETURNING id
        `,
        [receiptCodeGenerated, purchaseOrder.id, operatorId]
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
  const userId = req.user.id;
  let purchaseOrderId;

  console.log("ALERTA ALERTA", poNumber);

  if (!poNumber) {
    return res.status(400).json({
      success: false,
      message: "PO_NUMBER_REQUIRED",
    });
  }

  try {
    const fields = [];
    const values = [];
    let idx = 1;

    if (supplier) {
      fields.push(`supplier_name = TRIM(UPPER($${idx}))`);
      values.push(supplier);
      idx++;
    }

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
        SELECT id, purchase_order_number, supplier_name
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

      purchaseOrderId = selectResult.rows[0].id;

      return res.status(200).json({
        success: true,
        data: selectResult.rows[0],
      });
    }

    const query = `
      UPDATE purchase_orders
      SET ${fields.join(", ")}
      WHERE purchase_order_number = TRIM($${idx})
      RETURNING id, purchase_order_number
    `;

    values.push(poNumber);

    const result = await db.query(query, values);

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "PURCHASE_ORDER_NOT_FOUND",
      });
    }

    purchaseOrderId = result.rows[0].id;

    /* 🔎 Buscar recepción activa */
    let receiptResult = await db.query(
      `
      SELECT id, status
      FROM receipts
      WHERE purchase_order_id = $1
        AND status NOT IN ('completed', 'abandoned')
      LIMIT 1
      `,
      [purchaseOrderId]
    );

    let receiptId;

    /* ✅ SI NO EXISTE → CREARLA CON SEQUENCE */
    if (receiptResult.rowCount === 0) {

      // 👉 AQUÍ ESTABA EL PROBLEMA (se arregla aquí)
      const seqResult = await db.query(
        `SELECT nextval('receipt_code_seq') AS seq`
      );

      const nextNumber = seqResult.rows[0].seq;
      const year = new Date().getFullYear();
      const receiptCode = `${year}-${nextNumber}`;

      const createReceipt = await db.query(
        `
        INSERT INTO receipts (
          receipt_code,
          purchase_order_id,
          operator_id,
          status,
          started_at,
          invoice
        )
        VALUES ($1, $2, $3, 'in_progress', NOW(), $4)
        RETURNING id
        `,
        [receiptCode, purchaseOrderId, userId, invoiceNo]
      );

      receiptId = createReceipt.rows[0].id;

    } else {

      receiptId = receiptResult.rows[0].id;

      if (invoiceNo) {
        await db.query(
          `
          UPDATE receipts
          SET invoice = $1
          WHERE id = $2
          `,
          [invoiceNo, receiptId]
        );
      }
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
}




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


