import { db } from "../db.js";



export async function createPurchaseOrder(req, res) {
  try {
    // 🔹 Payload del ERP
    const erpPayload = req.body;

    // 🔹 MAPEO ERP → WMS (solo aquí dependes del ERP)
    const poNumber = typeof erpPayload.purchase_order_number === "string"
  ? erpPayload.purchase_order_number.trim().toUpperCase()
  : null;

    const supplierName = erpPayload.supplier_name ?? null;
    const expectedDate = erpPayload.expected_date ?? null;
    const notes = erpPayload.notes ?? null;
    const warehouseCode = erpPayload.erp_warehouse_value ?? null;
    const status = erpPayload.status;
    const lines = erpPayload.lines;
    
    // 🔹 VALIDACIÓN (usa variables internas, no req.body)
    if (!poNumber || !status || !Array.isArray(lines) || lines.length === 0) {
        return res.status(400).json({
            error: {
            code: "INVALID_REQUEST",
            message: "Missing or invalid required fields"
            }
        });
    }

    const allowedStatus = new Set(["open", "partial", "closed", "cancelled"]);
        if (!allowedStatus.has(String(status).toLowerCase())) {
        return res.status(400).json({
            error: { code: "INVALID_STATUS", message: "Invalid status value" },
        });
    }
    const normalizedStatus = String(status).toLowerCase();

    

    // 🔹 FORMATO INTERNO WMS (UNA SOLA VEZ)
    const wmsPurchaseOrder = {
        poNumber,
        supplierName,
        expectedDate,
        notes,
        warehouseCode,
        normalizedStatus,
        lines
    };

    const existingPO = await db.query(
        `SELECT id FROM purchase_orders
        WHERE UPPER(TRIM(purchase_order_number)) = $1`,
        [poNumber]
    );

    if (existingPO.rows.length > 0) {
        return res.status(409).json({
            error: {
            code: "PO_ALREADY_EXISTS",
            message: "Purchase order already exists"
            }
        });
    }


      // 🔹 INSERT DE LA CABECERA (HEADER)
        const poResult = await db.query(
            `
            INSERT INTO purchase_orders (
            purchase_order_number,
            supplier_name,
            expected_date,
            notes,
            erp_warehouse_value,
            status
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id
            `,
            [
            wmsPurchaseOrder.poNumber,
            wmsPurchaseOrder.supplierName?.trim() || null,
            wmsPurchaseOrder.expectedDate || null,
            wmsPurchaseOrder.notes?.trim() || null,
            wmsPurchaseOrder.warehouseCode || null,
            wmsPurchaseOrder.normalizedStatus
            ]
        );

        //id de la orden de compra recien creada
        const purchaseOrderId = poResult.rows[0].id;


        //Verificar productos

        const skus = lines.map(l => String(l.sku || "").trim()).filter(Boolean);

        const productsFound = await db.query(
        `SELECT sku FROM products WHERE sku = ANY($1)`,
        [skus]
        );

        const productMap = new Set(productsFound.rows.map(r => r.sku));

        console.log("SKUS:", skus);
        console.log("FOUND:", [...productMap]);

        
        // Arrays para poner los valores y posicion de cada valor de todas las lineas
        const values = [];
        const placeholders = [];

        // Valida los valores de la linea
        lines.forEach((line, index) => {
        const line_number = line.line_number ? String(line.line_number).trim() : null;
        const sku = String(line.sku || "").trim().toUpperCase();
        const description = String(line.description || "").trim();
        const ordered_qty = Number(line.ordered_qty);

        if (!sku || !description || !Number.isFinite(ordered_qty) || ordered_qty <= 0) {
            throw new Error("INVALID_LINE");
        }

        //Chequear si EXISTE el producto o no
        const product_exists = productMap.has(sku);

        const baseIndex = index * 6;

        placeholders.push(
            `($${baseIndex + 1}, $${baseIndex + 2}, $${baseIndex + 3}, $${baseIndex + 4}, $${baseIndex + 5}, $${baseIndex + 6})`
        );

        values.push(
            purchaseOrderId,
            line_number,
            sku,
            description,
            ordered_qty,
            product_exists
        );
        });

        await db.query(
        `
        INSERT INTO purchase_order_lines (
            purchase_order_id,
            line_number,
            sku,
            description,
            ordered_qty,
            product_exists
        )
        VALUES ${placeholders.join(", ")}
        `,
        values
        );


        return res.status(201).json({
            message: "Purchase order created",
            purchase_order_id: purchaseOrderId,
            lines_received: lines.length,
            products_found: productMap.size
        });

    } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: { code: "INTERNAL_ERROR", message: "Internal Server Error" }
    });
  }
        
}
