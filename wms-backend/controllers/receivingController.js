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
  //console.log("END END END END POINT POINT");
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
  SELECT
    sku,
    description,
    erp_name,
    erp_sku,
    erp_id
  FROM products
  WHERE sku = ANY($1)
  `,
      [skus]
    );
    const productMap = {};

    for (const p of productsResult.rows) {
      productMap[p.sku] = {
        description: p.description,
        erp_name: p.erp_name,
        erp_sku: p.erp_sku,
        erp_id: p.erp_id,
      };
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
    //console.log(header);
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
      const productInfo = productMap[line.sku] || {};

      return {
        line_no: index + 1,
        id: line.id,                // 🔢 1,2,3...
        sku: line.sku,
        description: productMap[line.sku] || "SIN DESCRIPCIÓN",
        erp_name:
          productInfo.erp_name || null,

        erp_sku:
          productInfo.erp_sku || null,

        erp_id:
          productInfo.erp_id || null,

        ordered_qty: line.ordered_qty,
        ordered_qty: line.ordered_qty,
        received_qty: line.received_qty,
        difference_qty,                    // ➖ calculado
      };
    });

    //console.log("LINES FINAL", enrichedLines);

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

    // console.log("📄 HEADER PDF:", headerPDF);
    //console.log("📄 HEADER PDF:", headerPDF);

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

    //------------------------------------------------------
    // CALCULAR CANTIDAD REAL QUE DEBE ENTRAR

    const stockLinesAdjusted = [];

    for (const line of stockLines) {

      const receiptRes = await client.query(`
    SELECT received_qty
    FROM receipt_lines
    WHERE purchase_order_line_id = $1
    ORDER BY id DESC
    LIMIT 2
  `, [line.id]);

      let restante = 0;

      if (receiptRes.rowCount >= 2) {

        const ultima = Number(receiptRes.rows[0].received_qty);
        const penultima = Number(receiptRes.rows[1].received_qty);

        restante = ultima - penultima;

      } else if (receiptRes.rowCount === 1) {

        restante = Number(receiptRes.rows[0].received_qty);

      }

      if (restante <= 0) {
        console.log(`⚠️ Cantidad inválida (${restante}) para SKU: ${line.sku}`);
        continue;
      }

      stockLinesAdjusted.push({
        ...line,
        restante
      });
    }



    // ==========================================================
    // AGRUPAR CANTIDADES POR SKU
    // SOLO PARA INVENTARIO Y MOVIMIENTOS
    // ==========================================================

    const inventoryBySkuMap = new Map();

    for (const line of stockLinesAdjusted) {

      const sku = String(
        line.sku || ""
      ).trim();

      const qty = Number(
        line.restante || 0
      );


      // ==========================================
      // VALIDAR SKU
      // ==========================================

      if (!sku) {

        throw new Error(
          `SKU_MISSING_FOR_PURCHASE_ORDER_LINE_${line.id}`
        );
      }


      // ==========================================
      // VALIDAR CANTIDAD
      // ==========================================

      if (!Number.isFinite(qty)) {

        throw new Error(
          `INVALID_RECEIVED_QTY_FOR_SKU_${sku}`
        );
      }


      // No agregar cantidades cero o negativas
      if (qty <= 0) {

        console.log(
          `⚠️ SKU ${sku} omitido porque la cantidad es ${qty}`
        );

        continue;
      }


      // ==========================================
      // CREAR SKU EN EL MAPA
      // ==========================================

      if (!inventoryBySkuMap.has(sku)) {

        inventoryBySkuMap.set(
          sku,
          {
            sku,

            restante: 0,

            // Solo auditoría / logs
            purchase_order_line_ids: []
          }
        );
      }


      const groupedLine =
        inventoryBySkuMap.get(sku);


      // ==========================================
      // SUMAR CANTIDAD
      // ==========================================

      groupedLine.restante += qty;


      // Guardamos las líneas que formaron
      // esta cantidad agrupada
      groupedLine.purchase_order_line_ids.push(
        line.id
      );
    }


    // Convertir Map → Array
    const inventoryLinesGrouped = [
      ...inventoryBySkuMap.values()
    ];


    console.log("");
    console.log(
      "📦 LÍNEAS INDIVIDUALES DE LA RECEPCIÓN:"
    );

    console.dir(
      stockLinesAdjusted,
      {
        depth: null
      }
    );


    console.log("");
    console.log(
      "📦 INVENTARIO AGRUPADO POR SKU:"
    );

    console.dir(
      inventoryLinesGrouped,
      {
        depth: null
      }
    );




    //------------------------------------------------------
    // CREAR LÍNEAS DEL PDF SOLO CON LO RECIBIDO
    // EN ESTA RECEPCIÓN
    //------------------------------------------------------

    const receiptPdfLines = stockLinesAdjusted.map(
      (line, index) => ({
        line_no: index + 1,

        id: line.id,
        sku: line.sku,

        description:
          line.description || "SIN DESCRIPCIÓN",

        erp_name:
          line.erp_name || null,

        erp_sku:
          line.erp_sku || null,

        erp_id:
          line.erp_id || null,

        // Cantidad total ordenada en la PO
        ordered_qty:
          Number(line.ordered_qty || 0),

        // Cantidad recibida SOLAMENTE en esta recepción
        received_qty:
          Number(line.restante || 0),

        // Diferencia de esta recepción contra lo ordenado
        difference_qty:
          Number(line.restante || 0) -
          Number(line.ordered_qty || 0),
      })
    );

    console.log("====================================");
    console.log("📄 LÍNEAS DE ESTA RECEPCIÓN PARA PDF");
    console.log("====================================");
    console.log(
      JSON.stringify(receiptPdfLines, null, 2)
    );







//----------------------------------------------------
// ACTUALIZAR INVENTARIO POR SKU AGRUPADO
//----------------------------------------------------

console.log(
  "===================================="
);

console.log(
  "📦 INVENTORY UPSERT AGRUPADO"
);

console.log(
  "===================================="
);

console.log(
  "🏬 WAREHOUSE ID:",
  warehouseId
);

console.log(
  "📍 LOCATION ID:",
  locationId
);

console.log(
  "📦 INVENTORY GROUPED:",
  JSON.stringify(
    inventoryLinesGrouped,
    null,
    2
  )
);


if (
  inventoryLinesGrouped.length > 0
) {

  const values = [];

  const params = [];


  inventoryLinesGrouped.forEach(
    (line, i) => {

      console.log(
        `📦 SKU AGRUPADO ${i + 1}`
      );

      console.log({
        sku:
          line.sku,

        qty:
          line.restante,

        warehouseId,

        locationId,

        purchase_order_line_ids:
          line.purchase_order_line_ids
      });


      /*
       * Cada fila tiene:
       *
       * warehouse_id
       * location_id
       * product_sku
       * qty_on_hand
       */
      const base =
        i * 4;


      values.push(`
        (
          $${base + 1},
          $${base + 2},
          $${base + 3},
          $${base + 4}
        )
      `);


      params.push(

        // warehouse_id
        warehouseId,

        // location_id
        locationId,

        // product_sku
        line.sku,

        // cantidad TOTAL de ese SKU
        line.restante
      );
    }
  );


  console.log(
    "📋 VALUES SQL:",
    values
  );

  console.log(
    "📋 PARAMS SQL:",
    params
  );


  const upsertInventorySQL = `
    INSERT INTO inventory_by_location
    (
      warehouse_id,
      location_id,
      product_sku,
      qty_on_hand
    )

    VALUES

      ${values.join(",")}

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
  `;


  await client.query(
    upsertInventorySQL,
    params
  );
}


console.log(
  "✅ UPSERT INVENTARIO COMPLETADO"
);


    //------------------------------------------------
// REGISTRAR MOVIMIENTOS DE INVENTARIO
// AGRUPADOS POR SKU
//------------------------------------------------

if (
  inventoryLinesGrouped.length > 0
) {

  const moveValues = [];

  const moveParams = [];


  inventoryLinesGrouped.forEach(
    (line, i) => {

      const base =
        i * 7;


      moveValues.push(`
        (
          $${base + 1},
          $${base + 2},
          $${base + 3},
          $${base + 4},
          $${base + 5},
          $${base + 6},
          $${base + 7}
        )
      `);


      moveParams.push(

        // product_sku
        line.sku,

        // from_location_id
        // null porque está entrando
        null,

        // to_location_id
        locationId,

        // cantidad TOTAL agrupada
        line.restante,

        // movement_type
        "RECEIPT",

        // reference_type
        "RECEPTION",

        // reference_id
        receiptId.toString()
      );


      console.log(
        "📦 MOVIMIENTO AGRUPADO:",
        {
          sku:
            line.sku,

          qty:
            line.restante,

          receiptId,

          purchase_order_line_ids:
            line.purchase_order_line_ids
        }
      );
    }
  );


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


  await client.query(
    insertMovementsSQL,
    moveParams
  );
}


    /*//INTEGRACION 🟨🟨🟨🟨🟨🟨🟨
    const payloadERP = await buildWarehouseEntry(
      client,
      stockLines,
      purchaseOrderId
    );

    if (payloadERP) {
      const response = await createWarehouseEntry(payloadERP);

      console.log("🟨🟨", response);

    }*/



    //--------------------------------------------------
    // CREAR EL PDF CON LA INFORMACION

    /*  const html = buildReceiptHtml(headerPDF, enrichedLines);
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
  */

    // Guardar en la base de datos el s3Key
    /* await client.query(
       `
       UPDATE receipts
       SET pdf_s3_key = $1
       WHERE id = $2
       `,
       [s3Key, headerPDF.receiptId]
     );
 */
    //------------------------------------------------
    //MANDAR PDF POR CORREO

    // después de generar el PDF
    /*try {
    await sendReceiptEmail({
      to: [
        "Cmerino@garlascontrol.com",
        "Jdaniel@garlascontrol.com",
        "Bdeaza@garlascontrol.com",
        "eliel3111@gmail.com"
      ],
      pdfBuffer: pdf,
      receiptCode: header.receipt_code,
      companyName: header.company_slug,
    });
    } catch (err) {
    
      console.error("⚠️ EMAIL NO ENVIADO");
      console.error(err.message);
    
    }*/

    /*return res.status(200).json({
      success: true,
      message: "Recepción cerrada correctamente",
      receiptId,
      receiptCode: header.receipt_code,
      pdfKey: s3Key
    });*/




    await client.query("COMMIT");

    res.status(200).json({
      success: true,
      message: "Recepción cerrada correctamente",
      receiptId,
      receiptCode: header.receipt_code,
    });












    // ✅ Después de responder al frontend
    setImmediate(async () => {
      try {
        const html = buildReceiptHtml(
          headerPDF,
          receiptPdfLines
        );
        const pdf = await generatePdf(html);

        const tenantSlug = header.company_slug;
        const year = new Date().getFullYear();
        const uuid = randomUUID();

        const fileName = `receipt_${year}_${receiptId}_${uuid}.pdf`;
        const s3Key = `${tenantSlug}/receipts/${fileName}`;

        await uploadPdfToS3({
          buffer: pdf,
          key: s3Key,
        });

        await db.query(
          `
      UPDATE receipts
      SET pdf_s3_key = $1
      WHERE id = $2
      `,
          [s3Key, receiptId]
        );

        try {
          await sendReceiptEmail({
            to: [
              "Cmerino@garlascontrol.com",
              "Jdaniel@garlascontrol.com",
              "Bdeaza@garlascontrol.com",
              "eliel3111@gmail.com",
            ],
            pdfBuffer: pdf,
            receiptCode: header.receipt_code,
            companyName: header.company_slug,
          });
        } catch (err) {
          console.error("⚠️ EMAIL NO ENVIADO:", err.message);
        }

        console.log("✅ PDF/S3/EMAIL background terminado");
      } catch (err) {
        console.error("⚠️ ERROR POST-CIERRE RECEPCIÓN:", err.message);
      }
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
      pol.id,
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

  LEFT JOIN products p
      ON p.sku = pol.sku

  WHERE pol.purchase_order_id = $1
    AND pol.ordered_qty <> pol.received_qty

  ORDER BY pol.id ASC
  `,
      [purchaseOrderId]
    );

    /* 5️⃣ Enriquecer líneas */
    const enrichedLines = linesResult.rows.map(line => ({
      ...line,
      barcodes: "NO-NEEDED"
    }));

    console.log(enrichedLines);

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

    console.log("🚨🚨🚨🚨 ALERTA SAVE SAVE", req.body);

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
// CANTIDADES RECIBIDAS EN RECEPCIONES ANTERIORES
// ============================================================

const maxReceivedMap = new Map();


if (completedReceiptIds.length > 0) {

  const receiptLinesResult = await db.query(
    `
    SELECT
      purchase_order_line_id,
      MAX(received_qty) AS max_received_qty

    FROM receipt_lines

    WHERE receipt_id =
      ANY($1::bigint[])

    GROUP BY purchase_order_line_id
    `,
    [completedReceiptIds]
  );


  receiptLinesResult.rows.forEach(
    (row) => {

      maxReceivedMap.set(
        Number(row.purchase_order_line_id),
        Number(row.max_received_qty)
      );

    }
  );
}


console.log(
  "📊 CANTIDADES ANTERIORES:",
  maxReceivedMap
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
          maxReceivedMap.get(
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
  } = req.body;

  const userId = req.user.id;


  console.log("");
  console.log("📦 ========================================");
  console.log("📦 CONFIRMANDO ÓRDENES DE COMPRA");
  console.log("📦 PO IDs recibidos:", poIds);
  console.log("📦 ========================================");


  // ============================================================
  // 1. VALIDAR QUE LLEGUE UN ARRAY
  // ============================================================

  if (!Array.isArray(poIds) || poIds.length === 0) {

    return res.status(400).json({
      success: false,
      title: "Orden de Compra requerida",
      message: "Debe seleccionar al menos una orden de compra.",
    });

  }


  // ============================================================
  // 2. NORMALIZAR IDS
  //
  // ["35", "39", "37"]
  //
  // ↓
  //
  // [35, 39, 37]
  // ============================================================

  const normalizedPoIds = [
    ...new Set(
      poIds.map((id) => Number(id))
    ),
  ];


  // ============================================================
  // 3. VALIDAR QUE TODOS LOS IDS SEAN VÁLIDOS
  // ============================================================

  const invalidId = normalizedPoIds.some(
    (id) =>
      !Number.isInteger(id) ||
      id <= 0
  );


  if (invalidId) {

    return res.status(400).json({
      success: false,
      title: "Orden de Compra no disponible",
      message: "Una o más órdenes tienen un ID inválido.",
    });

  }


  // ============================================================
  // CONEXIÓN
  // ============================================================

  const client = await db.connect();


  try {

    // ============================================================
    // TRANSACCIÓN
    // ============================================================

    await client.query("BEGIN");


    // ============================================================
    // 4. BUSCAR TODAS LAS ÓRDENES
    // ============================================================

    const ordersResult = await client.query(
      `
      SELECT
        id,
        purchase_order_number,
        supplier_name,
        invoice_numbers,
        status

      FROM purchase_orders

      WHERE id = ANY($1::bigint[])

      FOR UPDATE
      `,
      [normalizedPoIds]
    );


    console.log(
      "📥 Órdenes encontradas:",
      ordersResult.rowCount
    );


    // ============================================================
    // 5. VALIDAR QUE TODAS EXISTAN
    // ============================================================

    if (
      ordersResult.rowCount !==
      normalizedPoIds.length
    ) {

      const foundIds =
        ordersResult.rows.map(
          (order) => Number(order.id)
        );


      const missingIds =
        normalizedPoIds.filter(
          (id) => !foundIds.includes(id)
        );


      console.log(
        "❌ Órdenes no encontradas:",
        missingIds
      );


      await client.query("ROLLBACK");


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
    // 6. VALIDAR QUE TODAS ESTÉN ACTIVAS
    //
    // SI UNA ESTÁ:
    //
    // completed
    // abandoned
    //
    // NO SE PROCESA NINGUNA
    // ============================================================

    const unavailableOrder =
      ordersResult.rows.find(
        (order) => {

          const status =
            String(order.status)
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


      await client.query("ROLLBACK");


      return res.status(409).json({

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
          id: order.id,
          po: order.purchase_order_number,
          status: order.status,
        })
      )
    );


    // ============================================================
    // 7. PREPARAR CAMPOS PARA UPDATE
    // ============================================================

    const fields = [];
    const values = [];

    let idx = 1;


    // ============================================================
    // PROVEEDOR
    // ============================================================

    if (supplier) {

      fields.push(
        `supplier_name = TRIM(UPPER($${idx}))`
      );

      values.push(supplier);

      idx++;

    }


    // ============================================================
    // FACTURA
    // ============================================================

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


      values.push(invoiceNo);

      idx++;

    }


    // ============================================================
    // 8. SI NO HAY SUPPLIER NI INVOICE
    //
    // MISMO COMPORTAMIENTO QUE TU FUNCIÓN ORIGINAL:
    //
    // SOLO CONFIRMAR QUE LAS ÓRDENES EXISTEN Y ESTÁN ACTIVAS
    // ============================================================

    if (fields.length === 0) {

      await client.query("COMMIT");


      return res.status(200).json({

        success: true,

        data:
          ordersResult.rows,

      });

    }


    // ============================================================
    // 9. ACTUALIZAR TODAS LAS ÓRDENES
    // ============================================================

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


    values.push(normalizedPoIds);


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


    // ============================================================
    // 10. PROCESAR RECEIPT PARA CADA ORDEN
    // ============================================================

    const receipts = [];


    for (
      const order of updatedOrders.rows
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


      // ==========================================================
      // 11. BUSCAR RECEPCIÓN ACTIVA
      // ==========================================================

      const receiptResult =
        await client.query(
          `
          SELECT
            id,
            receipt_code,
            status

          FROM receipts

          WHERE purchase_order_id = $1

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


      // ==========================================================
      // 12. SI NO EXISTE RECEPCIÓN → CREAR
      // ==========================================================

      if (
        receiptResult.rowCount === 0
      ) {

        console.log(
          "➕ No existe recepción activa."
        );

        console.log(
          "➕ Creando recepción..."
        );


        // ========================================================
        // OBTENER SEQUENCE
        // ========================================================

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


        // ========================================================
        // CREAR RECEIPT
        // ========================================================

        const createReceipt =
          await client.query(
            `
            INSERT INTO receipts (

              receipt_code,
              purchase_order_id,
              operator_id,
              status,
              started_at,
              invoice

            )

            VALUES (

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


      // ==========================================================
      // 13. SI YA EXISTE → REUTILIZAR
      // ==========================================================

      else {

        receiptId =
          receiptResult.rows[0].id;

        receiptCode =
          receiptResult.rows[0]
            .receipt_code;


        console.log(
          "♻️ Recepción activa existente"
        );

        console.log(
          "🆔 Receipt ID:",
          receiptId
        );


        // ========================================================
        // ACTUALIZAR FACTURA
        // ========================================================

        if (invoiceNo) {

          await client.query(
            `
            UPDATE receipts

            SET invoice = $1

            WHERE id = $2
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


      // ==========================================================
      // 14. GUARDAR RESULTADO
      // ==========================================================

      receipts.push({

        purchaseOrderId,

        purchaseOrderNumber:
          order.purchase_order_number,

        receiptId,

        receiptCode,

      });

    }


    // ============================================================
    // 15. COMMIT
    // ============================================================

    await client.query("COMMIT");


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


    // ============================================================
    // 16. RESPUESTA FINAL
    // ============================================================

    return res.status(200).json({

      success: true,

      message:
        "PURCHASE_ORDERS_CONFIRMED",

      data: {

        orders:
          updatedOrders.rows,

        receipts,

      },

    });


  } catch (error) {

    // ============================================================
    // ERROR → DESHACER TODO
    // ============================================================

    await client.query("ROLLBACK");


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


    return res.status(500).json({

      success: false,

      title:
        "Error confirmando órdenes",

      message:
        "ERROR_CONFIRMING_ORDERS",

    });


  } finally {

    // ============================================================
    // LIBERAR CONEXIÓN
    // ============================================================

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

