import { db } from "../db.js";

export async function upsertSupplierBarcode(req, res) {
  console.log("🚀 START → upsertSupplierBarcode");

  try {
    const { id, barcode } = req.body;

    // 🔹 1. VALIDACIONES
    if (!id || !barcode) {
      return res.status(400).json({
        success: false,
        title: "Datos inválidos",
        message: "Debe enviar id y código de barra",
      });
    }



    const cleanBarcode = barcode.trim();


  
    // 🔹 2. BUSCAR PRODUCTO
    const productRes = await db.query(`
      SELECT sku, status, deleted_erp
      FROM products
      WHERE id = $1
      LIMIT 1
    `, [id]);

    if (productRes.rows.length === 0) {
      return res.status(404).json({
        success: false,
        title: "Producto no encontrado",
        message: "El producto no existe",
      });
    }

    const product = productRes.rows[0];

    // 🔥 VALIDACIÓN DE ESTADO
    if (product.status === "INACTIVE" || product.deleted_erp === true) {
      return res.status(400).json({
        success: false,
        title: "Producto no activo",
        message: "El producto está inactivo o eliminado",
      });
    }

    const sku = product.sku;

      // 🔥 1. VALIDAR SI EL BARCODE YA EXISTE
const existingBarcode = await db.query(`
  SELECT product_sku, barcode_type
  FROM product_barcodes
  WHERE barcode = $1
  LIMIT 1
`, [cleanBarcode]);

if (existingBarcode.rows.length > 0) {
  const existing = existingBarcode.rows[0];

  // ❌ si pertenece a OTRO producto → error
  if (existing.product_sku !== sku) {
    return res.status(400).json({
      success: false,
      title: "Código duplicado",
      message: `Este código ya pertenece al producto ${existing.product_sku}`,
    });
  }

  // ⚠️ si es el mismo producto pero otro tipo → opcional bloquear
  if (existing.barcode_type !== "supplier") {
    return res.status(400).json({
      success: false,
      title: "Código ya registrado",
      message: `Este código ya existe como ${existing.barcode_type}`,
    });
  }

  // 🔁 si es el mismo producto y tipo → simplemente actualiza (o ignora)
}

    // 🔹 3. BUSCAR SI YA EXISTE barcode supplier
    const existingRes = await db.query(`
      SELECT id, barcode
      FROM product_barcodes
      WHERE product_sku = $1
        AND barcode_type = 'supplier'
      LIMIT 1
    `, [sku]);

    let action = "";

    // 🔹 4. UPDATE o INSERT
    if (existingRes.rows.length > 0) {
      const existing = existingRes.rows[0];

      await db.query(`
        UPDATE product_barcodes
        SET barcode = $1
        WHERE id = $2
      `, [cleanBarcode, existing.id]);

      action = "updated";
    } else {
      await db.query(`
        INSERT INTO product_barcodes (
          product_sku,
          barcode,
          barcode_type,
          is_primary,
          created_at
        )
        VALUES ($1, $2, 'supplier', false, NOW())
      `, [sku, cleanBarcode]);

      action = "inserted";
    }

    // 🔹 LOG RESUMEN
    console.log("📦 SUMMARY →", {
      id,
      sku,
      barcode: cleanBarcode,
      action,
    });

    // 🔹 RESPONSE
    return res.json({
      success: true,
      message: action === "updated"
        ? "Código de proveedor actualizado"
        : "Código de proveedor creado",
      data: {
        sku,
        barcode: cleanBarcode,
        action,
      },
    });

  } catch (error) {
  console.error("❌ Error guardando:", error);

  if (error.response) {
    console.log("🔥 BACKEND RESPONSE:", error.response.data);

    alert(error.response.data.message); // 👈 clave
  }
} finally {
    console.log("🏁 END → upsertSupplierBarcode");
  }
}


 export async function searchProducts(req, res) {
  try {
    const { text } = req.body;

    console.log("TEXT:", text);

    if (!text) {
      return res.status(400).json({
        success: false,
        message: "Debe enviar texto de búsqueda"
      });
    }

    const cleanText = text.trim();

     // 🔥 NUEVO: dividir palabras
    const words = cleanText
      .split(" ")
      .map(w => w.trim())
      .filter(Boolean);

    // 🔹 1. Buscar en barcode
    const barcodeRes = await db.query(`
      SELECT DISTINCT product_sku
      FROM product_barcodes
      WHERE barcode ILIKE $1
      LIMIT 20
    `, [`%${cleanText}%`]);

    const skusFromBarcode = barcodeRes.rows.map(r => r.product_sku);

    let productsFromBarcode = [];

    if (skusFromBarcode.length > 0) {
      const resProducts = await db.query(`
        SELECT id, sku, description, erp_sku, erp_name
        FROM products
        WHERE sku = ANY($1)
        LIMIT 20
      `, [skusFromBarcode]);

      productsFromBarcode = resProducts.rows;
    } 

     // 🔥 NUEVO: construir búsqueda dinámica
    let conditions = [];
    let values = [];

    words.forEach((word, index) => {
      const paramIndex = index + 1;

      conditions.push(`
        (
          sku ILIKE $${paramIndex} OR
          erp_sku ILIKE $${paramIndex} OR
          REPLACE(description, '^', '') ILIKE $${paramIndex}
        )
      `);

      values.push(`%${word}%`);
    });

    const whereClause = conditions.length
      ? conditions.join(" AND ")
      : "1=1";

    const directRes = await db.query(`
      SELECT id, sku, description, erp_sku, erp_name
      FROM products
      WHERE ${whereClause}
      LIMIT 20
    `, values);

    // 🔹 Merge sin duplicados
    const map = new Map();

    [...productsFromBarcode, ...directRes.rows].forEach(p => {
      map.set(p.sku, p);
    });

    // 🔥 👇 AQUÍ CONVIERTES A ARRAY
const products = Array.from(map.values());

// 🔥 👇 OBTENER SKUS
const skus = products.map(p => p.sku);

// 🔥 👇 NUEVO: buscar supplier barcodes
let supplierMap = new Map();

if (skus.length > 0) {
  const supplierRes = await db.query(`
    SELECT product_sku, barcode
    FROM product_barcodes
    WHERE product_sku = ANY($1)
      AND barcode_type = 'supplier'
  `, [skus]);

  supplierRes.rows.forEach(row => {
    if (!supplierMap.has(row.product_sku)) {
      supplierMap.set(row.product_sku, row.barcode);
    }
  });
}

// 🔥 👇 PEGARLO AL RESULTADO
const finalProducts = products.map(p => ({
  ...p,
  supplier_barcode: supplierMap.get(p.sku) || null
}));

    return res.json({
  success: true,
  data: finalProducts
});

  } catch (error) {
    console.error("🔥 ERROR:", error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
}