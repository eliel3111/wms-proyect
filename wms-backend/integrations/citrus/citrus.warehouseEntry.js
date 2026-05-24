import { callERP, callERPPurchase } from "./erpClient.js";
import { db } from "../../db.js";

export async function buildWarehouseEntry(client, lines, purchaseOrderId) {
  try {
    // 🔹 1. Buscar ERP Order ID
    const poRes = await client.query(`
      SELECT erp_order_id
      FROM purchase_orders
      WHERE id = $1
    `, [purchaseOrderId]);

    if (poRes.rowCount === 0) {
      console.log("🟥 ERROR NO ENCONTRO ID DE LA ORDEN DE COMPRA DE CITRUS")
      throw new Error("Purchase Order no encontrada");
    }

    const erpOrderId = poRes.rows[0].erp_order_id;
      console.log("✅ ID DE LA ORDEN DE COMPRA DE CITRUS: ", erpOrderId);

    // 🔹 2. Validaciones básicas
    if (!erpOrderId) {
      console.log("🟥 ERROR NO ENCONTRO ID DE LA ORDEN DE COMPRA DE CITRUS")
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
      console.log("✅ ID DEL PRODUCTO EN CITRUS: ", erpItemId);

      if (restante <= 0) {
  console.log(`⚠️ Cantidad inválida (${restante}) para SKU: ${line.sku}`);
  continue; // 🔥 salta a la siguiente línea
}

payload.Detalles.push({
  ItemId: erpItemId,
  Cantidad: restante
});
    }


    if (payload.Detalles.length === 0) {
  console.log("🟪🟪🟪🟪🟪 No hay detalles válidos para enviar al ERP");
  return null;
}

    // 🔹 5. Log final
    console.log("✅📦 Payload Entrada Almacén:", JSON.stringify(payload, null, 2));

    return payload;

  } catch (error) {
    console.error("❌ Error construyendo entrada de almacén:", error.message);
    throw error;
  }
}


export async function createWarehouseEntry(payloadERP) {
  try {

    // 🔹 1. Formatear fecha (igual que hiciste antes)
    const fechaEntrada = new Date(payloadERP.FechaEntrada)
      .toISOString()
      .slice(0, 19);

    // 🔹 2. Construir detalles dinámicamente
    const detallesXML = payloadERP.Detalles.map(det => `
      <tem:EntradaAlmacenDetalle>
        <tem:ItemId>${det.ItemId}</tem:ItemId>
        <tem:Cantidad>${det.Cantidad}</tem:Cantidad>
      </tem:EntradaAlmacenDetalle>
    `).join("");

    // 🔹 3. Construir XML completo
    const xml = `
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">
  <soapenv:Header/>
  <soapenv:Body>
    <tem:CrearEntradaAlmacen>
      <tem:entradaAlmacen>

        <tem:AlmacenId>${payloadERP.AlmacenId}</tem:AlmacenId>
        <tem:OrdenCompraId>${payloadERP.OrdenCompraId}</tem:OrdenCompraId>
        <tem:FechaEntrada>${fechaEntrada}</tem:FechaEntrada>
        <tem:Estatus>${payloadERP.Estatus}</tem:Estatus>
        <tem:MonedaId>${payloadERP.MonedaId}</tem:MonedaId>

        <tem:EntradaAlmacenDetalles>
          ${detallesXML}
        </tem:EntradaAlmacenDetalles>

      </tem:entradaAlmacen>
    </tem:CrearEntradaAlmacen>
  </soapenv:Body>
</soapenv:Envelope>
`;

    console.log("🟨 XML ENVIADO:", xml);

    // 🔹 4. Llamar al ERP (igual que tu otra función)
    const data = await callERP(
      "Inventario/EntradaAlmacenService.asmx",
      "http://tempuri.org/CrearEntradaAlmacen",
      xml
    );

    // 🔹 5. Validar respuesta
    if (!data || data.Success === 0) {
      console.log("🟨🟥🟥 ERP respondió error:", data?.Mensaje);
      return null;
    }

    console.log("🟨🟩🟩 Entrada creada:", data);
    return data;

  } catch (error) {
    console.error("🟨🟥🟥 createWarehouseEntry error:", error.message);
    return null;
  }
}