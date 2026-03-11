import { db } from "../db.js";

export async function upsertPurchaseOrder(client, po) {
  try {
    console.log("🟢 UPSERT PO:", po.id, po.name);
    console.log("ESTE ES EL NOMBRE", po.name)
    const erpOrderId = po.id;
    const poNumber = po.name;
    const supplierName = po.partner_id?.[1] ?? null;
    const expectedDate = po.date_planned
      ? po.date_planned.split(" ")[0]
      : null;

    const statusMap = {
      purchase: "open",
      done: "cancelled",
      cancel: "cancelled"
    };

    const status = statusMap[po.state] || "open";
    console.log("ORDEN ESTATUS ESTATUS", po);
    const erpWriteDate = po.write_date;

    const result = await client.query(
      `
      INSERT INTO purchase_orders (
        erp_order_id,
        purchase_order_number,
        supplier_name,
        expected_date,
        status,
        erp_write_date
      )
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (erp_order_id)
      DO UPDATE SET
        purchase_order_number = EXCLUDED.purchase_order_number,
        supplier_name = EXCLUDED.supplier_name,
        expected_date = EXCLUDED.expected_date,
        status = EXCLUDED.status,
        erp_write_date = EXCLUDED.erp_write_date,
        updated_at = now()
      RETURNING id
      `,
      [
        erpOrderId,
        poNumber,
        supplierName,
        expectedDate,
        status,
        erpWriteDate
      ]
    );

    console.log("✅ UPSERT OK, WMS ID:", result.rows[0].id);

  } catch (error) {
    console.error("❌ ERROR UPSERT PURCHASE ORDER:", error);
    throw error;
  }
}
