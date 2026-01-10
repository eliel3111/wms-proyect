import db from "../db.js";

/* ---------- PURCHASE ORDER ---------- */

export async function validatePurchaseOrder(db, purchaseOrderId) {
  const result = await db.query(
    `SELECT id FROM purchase_orders WHERE id = $1 FOR UPDATE`,
    [purchaseOrderId]
  );

  if (result.rowCount === 0) throw new Error("PO_NO_EXISTE");

  return result.rows[0].id;
}

/* ---------- RECEIPTS ---------- */

export async function getActiveReceipt(db, poId) {
  const result = await db.query(
    `
    SELECT id, receipt_code
    FROM receipts
    WHERE purchase_order_id = $1
      AND status NOT IN ('completed', 'abandoned')
    FOR UPDATE
    `,
    [poId]
  );

  if (result.rowCount === 0) throw new Error("RECEIPT_NO_EXISTE");

  return result.rows[0];
}

export async function closeReceipt(db, receiptId) {
  await db.query(
    `
    UPDATE receipts
    SET status = 'completed',
        finished_at = NOW()
    WHERE id = $1
    `,
    [receiptId]
  );
}

/* ---------- PO LINES ---------- */

export async function getPurchaseOrderLines(db, poId) {
  const result = await db.query(
    `
    SELECT id, sku, ordered_qty, received_qty
    FROM purchase_order_lines
    WHERE purchase_order_id = $1
    `,
    [poId]
  );

  if (result.rowCount === 0) throw new Error("PO_LINES_NO_EXISTE");

  return result.rows;
}

/* ---------- PRODUCTS ---------- */

export async function getProductsMap(db, lines) {
  const skus = lines.map(l => l.sku);

  const result = await db.query(
    `SELECT sku, description FROM products WHERE sku = ANY($1)`,
    [skus]
  );

  const map = {};
  for (const p of result.rows) {
    map[p.sku] = p.description;
  }

  return map;
}

/* ---------- RECEIPT HEADER ---------- */

export async function getReceiptHeader(db, receiptId) {
  const result = await db.query(
    `
    SELECT
      r.id AS receipt_id,
      r.receipt_code,
      r.started_at,
      r.finished_at,
      r.invoice,
      r.status,
      po.purchase_order_number,
      po.supplier_name,
      u.full_name AS user_name,
      u.email AS user_email
    FROM receipts r
    JOIN purchase_orders po ON po.id = r.purchase_order_id
    JOIN users u ON u.id = r.operator_id
    WHERE r.id = $1
    `,
    [receiptId]
  );

  if (result.rowCount === 0) throw new Error("RECEIPT_HEADER_NOT_FOUND");

  return result.rows[0];
}

/* ---------- RECEIPT LINES ---------- */

export async function insertReceiptLines(db, receiptId, lines) {
  for (const line of lines) {
    await db.query(
      `
      INSERT INTO receipt_lines
      (receipt_id, purchase_order_line_id, sku, ordered_qty, received_qty)
      VALUES ($1, $2, $3, $4, $5)
      `,
      [receiptId, line.id, line.sku, line.ordered_qty, line.received_qty]
    );
  }
}
