import db from "../config/db.js";

export async function findWarehouseByErpId(erpId) {
  const result = await db.query(
    `SELECT * FROM warehouses WHERE erp_id = $1 LIMIT 1`,
    [erpId]
  );
  return result.rows[0];
}

export async function insertWarehouse(data) {
  return db.query(`
    INSERT INTO warehouses
    (erp_id, name, code, status, erp_location_id)
    VALUES ($1,$2,$3,$4,$5)
  `, [
    data.erp_id,
    data.name,
    data.code,
    data.status,
    data.erp_location_id
  ]);
}

export async function updateWarehouse(data) {
  return db.query(`
    UPDATE warehouses
    SET name=$2,
        code=$3,
        status=$4,
        erp_location_id=$5,
        updated_at=NOW()
    WHERE erp_id=$1
  `, [
    data.erp_id,
    data.name,
    data.code,
    data.status,
    data.erp_location_id
  ]);
}