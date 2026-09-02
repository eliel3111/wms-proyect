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



// Save received quantities in the data base
export async function savingReception(req, res) {

  console.log("");
  console.log("🚀 ========================================");
  console.log("🚀 HIT /receiving/save");
  console.log("🚀 ========================================");

  console.log(
    "BODY:",
    req.body
  );


  // ============================================================
  // RECIBIR DATA
  // ============================================================

  const {
    purchase_order_ids,
    purchase_order_numbers,
    reception_status,
    lines,
  } = req.body;


  // ============================================================
  // NORMALIZAR IDS
  //
  // ["35", 39]
  //
  // ↓
  //
  // [35, 39]
  // ============================================================

  const purchaseOrderIds =
    Array.isArray(purchase_order_ids)
      ? [
          ...new Set(
            purchase_order_ids.map(
              (id) => Number(id)
            )
          ),
        ]
      : [];


  console.log(
    "📦 PURCHASE ORDER IDS:",
    purchaseOrderIds
  );


  console.log(
    "📦 PURCHASE ORDER NUMBERS:",
    purchase_order_numbers
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
  // VALIDACIONES BÁSICAS
  // ============================================================

  if (
    purchaseOrderIds.length === 0 ||
    !Array.isArray(lines)
  ) {

    return res.status(400).json({

      success: false,

      title:
        "Datos incompletos",

      message:
        "Debe enviar al menos una orden de compra y sus líneas.",

    });

  }


  // ============================================================
  // VALIDAR IDS
  // ============================================================

  const invalidPurchaseOrderId =
    purchaseOrderIds.some(
      (id) =>
        !Number.isInteger(id) ||
        id <= 0
    );


  if (invalidPurchaseOrderId) {

    return res.status(400).json({

      success: false,

      title:
        "Orden de Compra inválida",

      message:
        "Una o más órdenes tienen un ID inválido.",

    });

  }


  // ============================================================
  // VALIDAR LÍNEAS
  // ============================================================

  if (lines.length === 0) {

    return res.status(400).json({

      success: false,

      title:
        "Recepción sin líneas",

      message:
        "No hay líneas para actualizar.",

    });

  }


  for (const line of lines) {

    if (
      typeof line.id !== "number" ||
      typeof line.received_qty !== "number" ||
      !Number.isFinite(line.received_qty) ||
      line.received_qty < 0
    ) {

      return res.status(400).json({

        success: false,

        title:
          "Línea inválida",

        message:
          "Una o más líneas tienen un formato inválido.",

      });

    }

  }


  // ============================================================
  // CONEXIÓN
  // ============================================================

  const client =
    await db.connect();


  try {

    // ============================================================
    // INICIAR TRANSACCIÓN
    // ============================================================

    await client.query(
      "BEGIN"
    );


    // ============================================================
    // 1. BUSCAR Y BLOQUEAR TODAS LAS PURCHASE ORDERS
    // ============================================================

    const poResult =
      await client.query(
        `
        SELECT
          id,
          purchase_order_number,
          status

        FROM purchase_orders

        WHERE id =
          ANY($1::bigint[])

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


      await client.query(
        "ROLLBACK"
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


    console.log(
      "✅ TODAS LAS PURCHASE ORDERS EXISTEN"
    );


    // ============================================================
    // 3. PONER TODAS LAS POs EN PARTIAL
    //
    // Solo modifica las que todavía no están partial.
    // ============================================================

    const updatePoStatusResult =
      await client.query(
        `
        UPDATE purchase_orders

        SET status = 'partial'

        WHERE id =
          ANY($1::bigint[])

          AND status IS DISTINCT FROM 'partial'

        RETURNING
          id,
          purchase_order_number,
          status
        `,
        [
          purchaseOrderIds
        ]
      );


    console.log(
      "📌 POs CAMBIADAS A PARTIAL:",
      updatePoStatusResult.rows
    );


    // ============================================================
    // 4. SI LA RECEPCIÓN SE ESTÁ PAUSANDO
    // ============================================================

    let receiptId = null;


    if (
      reception_status === "paused"
    ) {

      console.log("");
      console.log(
        "⏸ BUSCANDO RECEPCIÓN PARA PAUSAR..."
      );


      // ==========================================================
      // BUSCAR RECEIPT ACTIVO QUE PERTENEZCA EXACTAMENTE
      // A ESTE CONJUNTO DE PURCHASE ORDERS
      //
      // Ejemplo:
      //
      // request:
      // [35,39]
      //
      // Receipt:
      // 35,39
      //
      // ✅ match
      //
      // Receipt:
      // 35,39,42
      //
      // ❌ no es el mismo conjunto
      // ==========================================================

      const receiptResult =
        await client.query(
          `
          SELECT
            r.id,
            r.receipt_code,
            r.status

          FROM receipts r

          WHERE
            r.status NOT IN (
              'completed',
              'abandoned'
            )

            AND r.id IN (

              SELECT
                rpo.receipt_id

              FROM receipt_purchase_orders rpo

              GROUP BY
                rpo.receipt_id

              HAVING

                COUNT(
                  DISTINCT rpo.purchase_order_id
                ) = $2

                AND

                COUNT(
                  DISTINCT rpo.purchase_order_id
                ) FILTER (

                  WHERE
                    rpo.purchase_order_id =
                    ANY($1::bigint[])

                ) = $2
            )

          FOR UPDATE

          LIMIT 1
          `,
          [
            purchaseOrderIds,
            purchaseOrderIds.length
          ]
        );


      // ==========================================================
      // NO EXISTE RECEIPT RELACIONADO
      // ==========================================================

      if (
        receiptResult.rowCount === 0
      ) {

        console.log(
          "❌ NO EXISTE RECEPCIÓN ACTIVA PARA:",
          purchaseOrderIds
        );


        await client.query(
          "ROLLBACK"
        );


        return res.status(404).json({

          success: false,

          title:
            "Recepción no encontrada",

          message:
            "No existe una recepción activa relacionada con estas órdenes de compra.",

        });

      }


      receiptId =
        Number(
          receiptResult.rows[0].id
        );


      console.log(
        "📥 RECEIPT ENCONTRADO:",
        receiptResult.rows[0]
      );


      // ==========================================================
      // MARCAR RECEPCIÓN COMO PAUSED
      // ==========================================================

      const pauseReceiptResult =
        await client.query(
          `
          UPDATE receipts

          SET status = 'paused'

          WHERE id = $1

          RETURNING
            id,
            receipt_code,
            status
          `,
          [
            receiptId
          ]
        );


      console.log(
        "⏸ RECEPCIÓN PAUSADA:",
        pauseReceiptResult.rows[0]
      );

    }


    // ============================================================
    // 5. PREPARAR UPDATE MASIVO DE LAS LÍNEAS
    // ============================================================

    const lineIds =
      lines.map(
        (line) =>
          Number(line.id)
      );


    const receivedQtys =
      lines.map(
        (line) =>
          Number(
            line.received_qty
          )
      );


    console.log("");
    console.log(
      "📦 LINE IDS:",
      lineIds
    );


    console.log(
      "📦 RECEIVED QTYS:",
      receivedQtys
    );


    // ============================================================
    // 6. ACTUALIZAR LÍNEAS DE TODAS LAS PURCHASE ORDERS
    // ============================================================

    const updateLinesResult =
      await client.query(
        `
        UPDATE purchase_order_lines pol

        SET
          received_qty =
            data.received_qty

        FROM (

          SELECT
            UNNEST(
              $1::BIGINT[]
            ) AS id,

            UNNEST(
              $2::NUMERIC[]
            ) AS received_qty

        ) AS data

        WHERE
          pol.id = data.id

          AND pol.purchase_order_id =
            ANY($3::bigint[])

        RETURNING
          pol.id,
          pol.purchase_order_id,
          pol.sku,
          pol.received_qty
        `,
        [
          lineIds,
          receivedQtys,
          purchaseOrderIds
        ]
      );


    console.log("");
    console.log(
      "✅ LÍNEAS ACTUALIZADAS:"
    );


    console.log(
      updateLinesResult.rows
    );


    // ============================================================
    // 7. VERIFICAR QUE TODAS LAS LÍNEAS FUERON ACTUALIZADAS
    // ============================================================

    if (
      updateLinesResult.rowCount !==
      lineIds.length
    ) {

      const updatedLineIds =
        updateLinesResult.rows.map(
          (line) =>
            Number(line.id)
        );


      const missingLineIds =
        lineIds.filter(
          (id) =>
            !updatedLineIds.includes(id)
        );


      console.log(
        "❌ LÍNEAS NO ACTUALIZADAS:",
        missingLineIds
      );


      throw new Error(
        `LINES_NOT_FOUND_OR_NOT_IN_SELECTED_PURCHASE_ORDERS: ${missingLineIds.join(",")}`
      );

    }


    // ============================================================
    // 8. COMMIT
    // ============================================================

    await client.query(
      "COMMIT"
    );


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
      "📥 RECEIPT ID:",
      receiptId
    );

    console.log(
      "📌 STATUS:",
      reception_status
    );

    console.log(
      "✅ ========================================"
    );


    // ============================================================
    // RESPUESTA
    // ============================================================

    return res.status(200).json({

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

        reception_status,

        updated_lines:
          updateLinesResult.rowCount,

      },

    });


  } catch (error) {

    // ============================================================
    // ROLLBACK
    // ============================================================

    try {

      await client.query(
        "ROLLBACK"
      );

    } catch (rollbackError) {

      console.error(
        "❌ Error ejecutando ROLLBACK:",
        rollbackError
      );

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


    return res.status(500).json({

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

