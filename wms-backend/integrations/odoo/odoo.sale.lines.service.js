import { getOdooClient } from "./odoo.client.js";
import { getOdooUid } from "./odoo.session.js";
import { db } from "../../db.js";
import { upsertPurchaseOrder } from "../purchaseOrder.upsert.js";
import { lockSyncControl } from "./odoo.purchase.service.js";

const OLD_DATE = "2000-01-01 00:00:00";


export async function getActiveSaleMoves(pickingIds) {
  //Se define el modelo
  const model = "sale.order.line";
  let lock = null;
  let maxWriteDate = null;

  try {
    //Autentificacion
    const uid = await getOdooUid();
    const client = getOdooClient("object");

    // 🔒 Lock global
    lock = await lockSyncControl(model);

    if (!lock) {
      console.log(`[SYNC] ${model} ya está corriendo, se omite este ciclo`);
      return;
    }

    maxWriteDate = lock.lastWriteDate || OLD_DATE;

    /* ==========================
       1️⃣ TRAER SALES ORDERS
    ========================== */
    const moveDomain = [
  ["picking_id", "in", pickingIds]
];

const moveFields = [
  "id",
  "picking_id",
  "product_id",
  "product_uom_qty",
  "location_id",
  "location_dest_id",
  "state"
];

const stockMoves = await new Promise((resolve, reject) => {
  client.methodCall(
    "execute_kw",
    [
      process.env.ODOO_DB,
      uid,
      process.env.ODOO_API_KEY,
      "stock.move",
      "search_read",
      [moveDomain],
      { fields: moveFields }
    ],
    (err, res) => (err ? reject(err) : resolve(res))
  );
});

    console.log("stock move DE ODOO OBTENIDA", stockMoves);

    await processStockMoves(stockMoves);

    



    /* ==========================
       ✅ MARCAR SUCCESS
    ========================== */
    await db.query(
      `
      UPDATE sync_control
      SET
        last_write_date = $1,
        status = 'success',
        updated_at = now(),
        error_message = NULL
      WHERE model = $2
      `,
      [maxWriteDate, model]
    );

    return stockMoves;

  } catch (error) {
    console.error(`[SYNC ERROR x] ${model}`, error.message);

    // 🟥 SI YA HABÍA LOCK → marcar failed
    if (lock?.id) {
      await db.query(
        `
        UPDATE sync_control
        SET
          status = 'failed',
          updated_at = now(),
          error_message = $1
        WHERE model = $2
        `,
        [error.message, model]
      );
    }

    throw error;
  }
}



export async function processStockMoves(stockMoves) {

  const maxRetries = 3;
  let attempt = 0;

  while (attempt < maxRetries) {

    const client = await db.connect();

    try {

      console.log(`🚀 processStockMoves intento ${attempt + 1}`);

      await client.query("BEGIN");

      console.log("📦 TOTAL MOVES:", stockMoves.length);

      /* =====================================
         1️⃣ EXTRAER IDS
      ===================================== */

      const pickingIds = [
        ...new Set(stockMoves.map(m => m.picking_id?.[0]).filter(Boolean))
      ];

      const productIds = [
        ...new Set(stockMoves.map(m => m.product_id?.[0]).filter(Boolean))
      ];

      console.log("TOTAL PICKINGS:", pickingIds.length);
      console.log("TOTAL PRODUCTS:", productIds.length);

      /* =====================================
         2️⃣ TRAER PICKINGS
      ===================================== */

      const pickingResult = await client.query(
        `
        SELECT id, erp_id, name, state
        FROM stock_picking
        WHERE erp_id = ANY($1)
        `,
        [pickingIds]
      );

      const pickingMap = new Map();

      for (const p of pickingResult.rows) {
        pickingMap.set(p.erp_id, p);
      }

      console.log("PICKINGS ENCONTRADOS:", pickingMap.size);

      /* =====================================
         3️⃣ TRAER PRODUCTOS
      ===================================== */

      const productResult = await client.query(
        `
        SELECT id, erp_id, uom_id
        FROM products
        WHERE erp_id = ANY($1)
        `,
        [productIds]
      );

      const productMap = new Map();

      for (const p of productResult.rows) {
        productMap.set(p.erp_id, p);
      }

      console.log("PRODUCTOS ENCONTRADOS:", productMap.size);

      /* =====================================
         4️⃣ PREPARAR MOVES
      ===================================== */

      const movesToInsert = [];

      for (const record of stockMoves) {

        const pickingId = record.picking_id?.[0];
        const productId = record.product_id?.[0];

        const picking = pickingMap.get(pickingId);
        console.log("ALERTA 4️⃣3️⃣🚨🚨🚨", picking.id);
        console.log("ALERTA 4️⃣3️⃣🚨🚨🚨", picking);
        if (!picking) {
          console.warn("❌ No existe picking:", pickingId);
          continue;
        }

        if (picking.state === "done" || picking.state === "cancel") {
          console.warn("⚠️ Picking cerrado:", picking.name);
          continue;
        }

        const product = productMap.get(productId);

        if (!product) {
          console.warn("❌ Producto no existe:", productId);
          continue;
        }

        let state = "draft";

        if (record.state === "confirmed" || record.state === "assigned") {
          state = "confirmed";
        }
        else if (record.state === "cancel") {
          state = "cancel";
        }
        else if (record.state === "done") {
          state = "done";
        }

        const name = `MOVE-${record.id}`;
        const qty = record.product_uom_qty || 0;

        movesToInsert.push({
  name,
  picking_id: picking.id,
  product_id: product.id,
  product_uom_id: product.uom_id,
  product_qty: qty,
  state,
  erp_move_id: record.id,
  reference: picking.name // ✅ NUEVO
});
      }

      if (movesToInsert.length === 0) {

        console.log("⚠️ No hay moves para insertar");

        await client.query("COMMIT");
        client.release();

        return;

      }

      console.log("MOVES PREPARADOS:", movesToInsert.length);

      /* =====================================
         5️⃣ UPSERT MASIVO EN CHUNKS
      ===================================== */

      const chunkSize = 500;

      for (let i = 0; i < movesToInsert.length; i += chunkSize) {

        const chunk = movesToInsert.slice(i, i + chunkSize);

        const values = [];
        const params = [];

        chunk.forEach((m, index) => {

          const base = index * 8;

          values.push(`
  ($${base+1},$${base+2},$${base+3},$${base+4},
   $${base+5},$${base+6},$${base+7},$${base+8})
`);

          params.push(
  m.name,
  m.picking_id,
  m.product_id,
  m.product_uom_id,
  m.product_qty,
  m.state,
  m.erp_move_id,
  m.reference // ✅ NUEVO
);

        });

       const query = `
INSERT INTO stock_move (
  name,
  picking_id,
  product_id,
  product_uom_id,
  product_qty,
  state,
  erp_move_id,
  reference
)
VALUES ${values.join(",")}

ON CONFLICT (picking_id, erp_move_id)
DO UPDATE SET
  product_id = EXCLUDED.product_id,
  product_uom_id = EXCLUDED.product_uom_id,
  product_qty = EXCLUDED.product_qty,
  state = EXCLUDED.state,
  reference = EXCLUDED.reference, -- ✅ NUEVO
  write_date = now()
`;

        await client.query(query, params);

        console.log(`✅ Chunk procesado: ${chunk.length}`);

      }

      await client.query("COMMIT");

      client.release();

      console.log("🏁 PROCESO TERMINADO");

      return;

    } catch (error) {

      await client.query("ROLLBACK");
      client.release();

      attempt++;

      console.error(`❌ Error intento ${attempt}:`, error.message);

      if (attempt >= maxRetries) {

        console.error("🔥 Se alcanzó el máximo de reintentos");

        throw error;

      }

      const wait = 2000 * attempt;

      console.log(`⏳ Reintentando en ${wait/1000}s...`);

      await new Promise(resolve => setTimeout(resolve, wait));

    }

  }

}