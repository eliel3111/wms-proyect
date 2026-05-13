import { db } from "../db.js";
import { updateInventoryByCount } from "../services/inventoryService.js";
import { emitInventorySummary } from "../services/inventory.count.js";

export async function inventoryScan(req, res) {
  try {
    const { productScanned, locationScanned } = req.body;

    // 1️⃣ Si NO hay nada
    if (!productScanned && !locationScanned) {
      return res.json({
        success: false,
        title: "Escaneo requerido",
        message: "Debe escanear una ubicación o un producto."
      });
    }

    // 2️⃣ Si viene SOLO ubicación
    if (locationScanned && !productScanned || locationScanned === productScanned) {
      const location = await db.query(`
        SELECT id, code
        FROM locations
        WHERE code = $1
          AND is_active = true
        LIMIT 1
      `, [locationScanned]);

      if (location.rows.length === 0) {
        return res.json({
          success: false,
          title: "Ubicación inválida",
          message: "La ubicación escaneada no existe o no está activa."
        });
      }

      return res.json({
        success: true,
        type: "location",
        data: location.rows[0]
      });
    }

    // 3️⃣ Si viene producto SIN ubicación → ERROR
    if (productScanned && !locationScanned) {
      return res.json({
        success: false,
        title: "Falta ubicación",
        message: "Debe escanear una ubicación antes de escanear un producto."
      });
    }

    // 4️⃣ Validar ubicación
    const location = await db.query(`
      SELECT id, code
      FROM locations
      WHERE code = $1
        AND is_active = true
      LIMIT 1
    `, [locationScanned]);

    if (location.rows.length === 0) {
      return res.json({
        success: false,
        title: "Ubicación inválida",
        message: "La ubicación escaneada no existe o no está activa."
      });
    }

    const locationId = location.rows[0].id;

    // 5️⃣ Buscar producto
   const productResult = await db.query(`
  SELECT 
    p.id,
    p.erp_id,
    p.sku,
    p.description
  FROM products p
  LEFT JOIN product_barcodes bp 
    ON p.sku = bp.product_sku
  WHERE 
        bp.product_sku = $1
     OR bp.barcode = $1
     OR p.sku = $1
     OR p.erp_sku = $1
  LIMIT 1
`, [productScanned]);

    if (productResult.rows.length === 0) {
      return res.json({
        success: false,
        title: "Producto no encontrado",
        message: "El código escaneado no corresponde a ningún producto."
      });
    }

    const product = productResult.rows[0];

    // 6️⃣ Buscar inventario en esa ubicación
    let qty = 0;

    const inventoryResult = await db.query(`
      SELECT inventory_quantity
      FROM inventory_by_location
      WHERE product_sku = $1
        AND location_id = $2
      LIMIT 1
    `, [product.sku, locationId]);

    if (inventoryResult.rows.length > 0) {
      const inventoryQty = Number(inventoryResult.rows[0].inventory_quantity);

      if (inventoryQty > 0) {
        qty = inventoryQty;
      }
    }

    // 7️⃣ Respuesta final
    return res.json({
      success: true,
      type: "product",
      data: product,
      location: location.rows[0], // 👈 opcional pero útil
      qty
    });

  } catch (error) {
    console.error("❌ Error en inventoryScan:", error);
    return res.status(500).json({
      success: false,
      message: "Error interno"
    });
  }
}




export async function applyInventoryCount(req, res) {
  const client = await db.connect();

  try {
    const { locationSelected, productSelected, qty } = req.body;
    const userId = req.user?.id ?? 1; //🟥🟥 quitar en produccion #QUITARPRODUCCION

    await client.query("BEGIN");

    const result = await updateInventoryByCount(client, {
      locationSelected,
      productSelected,
      qty,
      userId,
      referenceId: null,
      note: "Ajuste por conteo físico"
    });

    if (!result.success) {
      await client.query("ROLLBACK");
      return res.json(result);
    }

    const summary = await emitInventorySummary(client);
console.log("Resumen 🟥🟩🟨🟪", summary);

    await client.query("COMMIT");
    return res.json(result);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("❌ Error applyInventoryCount:", error);

    return res.status(500).json({
      success: false,
      title: "No se pudo guardar conteo",
      message: "Ocurrió un error interno."
    });
  } finally {
    client.release();
  }
}