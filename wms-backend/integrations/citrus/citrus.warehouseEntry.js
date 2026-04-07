export async function buildWarehouseEntry(client, lines, purchaseOrderId) {
  try {
    // 🔹 1. Buscar ERP Order ID
    const poRes = await client.query(`
      SELECT erp_order_id
      FROM purchase_orders
      WHERE id = $1
    `, [purchaseOrderId]);

    if (poRes.rowCount === 0) {
      throw new Error("Purchase Order no encontrada");
    }

    const erpOrderId = poRes.rows[0].erp_order_id;

    // 🔹 2. Validaciones básicas
    if (!erpOrderId) {
      throw new Error("ERP Order ID es requerido");
    }

    // 🔹 3. Campos obligatorios
    const payload = {
      AlmacenId: 1,
      FechaEntrada: new Date().toISOString(),
      Estatus: "A",
      MonedaId: 1,
      OrdenCompraId: erpOrderId,
      Detalles: []
    };

    // 🔹 4. Procesar líneas
    for (const line of lines) {

      // 🔸 Obtener receipt_lines relacionadas
      const receiptRes = await client.query(`
        SELECT product_uom_qty
        FROM receipt_lines
        WHERE purchase_order_line_id = $1
        ORDER BY product_uom_qty DESC
      `, [line.id]);

      let restante = 0;

      if (receiptRes.rowCount > 0) {
        const cantidades = receiptRes.rows.map(r => Number(r.product_uom_qty));

        // Ej: [100, 80]
        const mayor = cantidades[0];
        const menor = cantidades[cantidades.length - 1];

        restante = mayor - menor;
      }

      // 🔸 Obtener ERP Item ID usando SKU
      const productRes = await client.query(`
        SELECT erp_id
        FROM products
        WHERE sku = $1
      `, [line.sku]);

      if (productRes.rowCount === 0) {
        console.log(`⚠️ Producto no encontrado para SKU: ${line.sku}`);
        continue;
      }

      const erpItemId = productRes.rows[0].erp_id;

      // 🔸 Agregar detalle
      payload.Detalles.push({
        ItemId: erpItemId,
        Cantidad: restante
      });
    }

    // 🔹 5. Log final
    console.log("📦 Payload Entrada Almacén:", JSON.stringify(payload, null, 2));

    return payload;

  } catch (error) {
    console.error("❌ Error construyendo entrada de almacén:", error.message);
    throw error;
  }
}