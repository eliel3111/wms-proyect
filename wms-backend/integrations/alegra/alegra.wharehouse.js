import { db } from "../../db.js";

export async function upsertWarehouses( warehouses) {
  if (!warehouses || warehouses.length === 0) return;

  let values = [];
  let params = [];
  let paramIndex = 1;

  warehouses.forEach((w) => {
    values.push(`(
      $${paramIndex++}, 
      $${paramIndex++}, 
      $${paramIndex++}, 
      $${paramIndex++}, 
      $${paramIndex++}, 
      $${paramIndex++}, 
      $${paramIndex++}
    )`);

    params.push(
      `WH-${w.id.substring(0, 2)}`,                // code
      (w.name || "").trim(),                      // name
      w.observations || null,                     // description
      w.status === "active" ? "ACTIVE" : "INACTIVE", // is_active
      w.address || null,                          // address_line
      w.isDefault ?? false,                       // is_default
      w.id                             // erp_warehouse_id
    );
  });

  const query = `
    INSERT INTO warehouses (
      code,
      name,
      description,
      status,
      address_line,
      is_default,
      erp_warehouse_id
    )
    VALUES ${values.join(",")}
    ON CONFLICT (erp_warehouse_id)
    DO UPDATE SET
      code = EXCLUDED.code,
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      status = EXCLUDED.status,
      address_line = EXCLUDED.address_line,
      is_default = EXCLUDED.is_default;
  `;
const result = await db.query(query, params);

console.log("✅ Sync warehouses:", warehouses.length);
}