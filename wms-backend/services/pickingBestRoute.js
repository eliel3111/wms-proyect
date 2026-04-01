

export async function getPickingProductsWithLocationsService(client, pickingId) {
  console.log("🧠 [SERVICE] Procesando picking:", pickingId);

  // ==============================
  // 1️⃣ TRAER MOVES
  // ==============================
  const movesResult = await client.query(
    `
    SELECT id, product_id, product_qty, product_uom_id
    FROM stock_move
    WHERE picking_id = $1
    `,
    [pickingId]
  );

  console.log("🚨🚨🚨", movesResult.rows);

  if (!movesResult.rows.length) {
    return {
      data: [],
      message: "No hay productos en este picking",
    };
  }

  const moves = movesResult.rows;



  // ==============================
  // 2️⃣ PRODUCT IDS
  // ==============================
  const productIds = [...new Set(moves.map(m => m.product_id))];

  // ==============================
  // 3️⃣ SKUs
  // ==============================
  const productsResult = await client.query(
    `
    SELECT id, sku
    FROM products
    WHERE id = ANY($1::int[])
    `,
    [productIds]
  );

  const skuMap = new Map();
  const skuList = [];

  productsResult.rows.forEach(p => {
    skuMap.set(p.id, p.sku);
    skuList.push(p.sku);
  });

  // ==============================
  // 4️⃣ INVENTARIO + LOCATIONS
  // ==============================
  const inventoryResult = await client.query(
  `
  SELECT
    ibl.product_sku,
    ibl.location_id,
    ibl.warehouse_id,
    ibl.qty_available,
    l.tramo,
    l.nivel
  FROM inventory_by_location ibl
  JOIN locations l 
    ON l.id = ibl.location_id
  WHERE ibl.product_sku = ANY($1::text[])
    AND l.location_type = 'STORAGE'
  `,
  [skuList]
);

  // ==============================
  // 5️⃣ MAP INVENTORY
  // ==============================
  const inventoryMap = new Map();

  for (const row of inventoryResult.rows) {
    if (!inventoryMap.has(row.product_sku)) {
      inventoryMap.set(row.product_sku, []);
    }

    inventoryMap.get(row.product_sku).push({
      location_id: row.location_id,
      quantity: Math.floor(Number(row.qty_available)) || 0,
      tramo: row.tramo,
      nivel: row.nivel,
      almacen: row.warehouse_id,
    });
  }

  // ==============================
  // 6️⃣ RESULT FINAL
  // ==============================
  const resultMap = new Map();

  for (const move of moves) {
    const sku = skuMap.get(move.product_id);

    if (!resultMap.has(move.product_id)) {
      resultMap.set(move.product_id, {
        product_id: move.product_id,
        sku,
        picking_id: Number(pickingId),
        moves: [],
        locations: inventoryMap.get(sku) || [],
      });
    }

    resultMap.get(move.product_id).moves.push({
      move_id: move.id,
      product_qty: Math.floor(Number(move.product_qty)) || 0,
      move_product_uom_id: move.product_uom_id,
    });
  }

  return {
    data: Array.from(resultMap.values()),
  };
}

//CASO 1: Buscar 1 ubicacion ideal
export function selectBestLocation(product) {
  const requiredQty = product.moves.reduce(
    (sum, m) => sum + Number(m.product_qty),
    0
  );

  const locations = product.locations || [];

  if (!locations.length) return null;

  // ==============================
  // 🔹 CASO 1: UNA SOLA UBICACIÓN
  // ==============================
  const validLocations = locations.filter(
    loc => Number(loc.quantity) >= requiredQty
  );

 if (validLocations.length > 0) {
  validLocations.sort((a, b) => {
    if (a.tramo !== b.tramo) return a.tramo - b.tramo;
    return a.nivel - b.nivel;
  });

  return {
    sugerido: [
      {
        location_id: validLocations[0].location_id,
        quantity_taken: requiredQty,
        tramo: validLocations[0].tramo,
        nivel: validLocations[0].nivel,
        almacen: validLocations[0].almacen
      }
    ]
  };
}

  // ==============================
  // 🔥 CASO 2: SPLIT ENTRE UBICACIONES
  // ==============================
  return splitAcrossLocations(locations, requiredQty);
}


//CASO 2: Dividir en varias ubicaciones
function splitAcrossLocations(locations, requiredQty) {
  let remaining = requiredQty;

  // ==============================
  // 1️⃣ ORDENAR (mayor cantidad primero)
  // ==============================
  const sorted = [...locations].sort((a, b) => {
    if (b.quantity !== a.quantity) return b.quantity - a.quantity;

    // desempate: menor tramo → menor nivel
    if (a.tramo !== b.tramo) return a.tramo - b.tramo;
    return a.nivel - b.nivel;
  });

  const result = [];

  // ==============================
  // 2️⃣ ITERAR HASTA COMPLETAR
  // ==============================
  for (const loc of sorted) {
    if (remaining <= 0) break;

    const available = Number(loc.quantity);

    if (available <= 0) continue;

    const taken = Math.min(available, remaining);

    result.push({
      location_id: loc.location_id,
      quantity_taken: taken,
      tramo: loc.tramo,
      nivel: loc.nivel,
      almacen: loc.almacen,
    });

    remaining -= taken;
  }

  // ==============================
  // 3️⃣ VALIDACIÓN FINAL
  // ==============================
  if (remaining > 0) {
    return {
      error: "Inventario insuficiente",
      faltante: remaining,
      sugerido: result,
    };
  }

  return result;
}

//Sevicio de reserva de inventario
export async function reserveInventoryForMove(client, move) {

    const productSku = move.sku;
    const stockMove = move.moves[0];
    const moveLines = Array.isArray(move.selected_location)
  ? move.selected_location
  : move.selected_location?.sugerido || [];
    let cantidadReservada = 0;

        /* ===============================
           3️⃣ ACTUALIZAR RESERVA
        =============================== */
const values = [];
const updates = [];

if (!moveLines || moveLines.length === 0) {
  console.log("⚠️ No hay líneas para reservar");
  return { reserved: 0, note: "Sin líneas" };
}

moveLines.forEach((row, index) => {
  const i = index * 4;
 console.log("ROW ROW ROW ROW", row);
  values.push(
    Number(row.quantity_taken),
    productSku,
    Number(row.almacen),
    Number(row.location_id)
  );

  updates.push(`
    (product_sku = $${i + 2}
     AND warehouse_id = $${i + 3}
     AND location_id = $${i + 4})
  `);
});

const result = await client.query(
  `
  UPDATE inventory_by_location ibl
  SET 
    qty_reserved = ibl.qty_reserved + LEAST(ibl.qty_available, data.qty)
  FROM (
    VALUES ${moveLines
      .map((_, i) => `($${i * 4 + 1}::int, $${i * 4 + 2}::text, $${i * 4 + 3}::int, $${i * 4 + 4}::int)`)
      .join(",")}
  ) AS data(qty, sku, warehouse_id, location_id)
  WHERE ibl.product_sku = data.sku
    AND ibl.warehouse_id = data.warehouse_id
    AND ibl.location_id = data.location_id
    AND ibl.qty_available > 0
  RETURNING 
    ibl.location_id,
    ibl.qty_reserved,
    ibl.qty_available
  `,
  values
);

    /* ===============================
       2️⃣ RECORRER INVENTARIO
    =============================== */

    for (const row of moveLines) {




     

        /* ===============================
           4️⃣ CREAR STOCK MOVE LINE
        =============================== */

        // crear move line con warehouse y location
        await client.query(`
    INSERT INTO stock_move_line
    (move_id, picking_id, product_id, product_uom_id, warehouse_id, location_id, product_uom_qty, state)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
`, [
            Number(stockMove.move_id),
            Number(move.picking_id),
            Number(move.product_id),
            Number(stockMove.move_product_uom_id),
            row.almacen,
            row.location_id,
            row.quantity_taken,
            "assigned"   // ✅ CORRECTO
        ]);
        cantidadReservada += row.quantity_taken;

        console.log(`📦 Reservado ${row.quantity_taken} en location ${row.location_id}`);

        if (cantidadReservada === stockMove.product_qty) break;
    }

    /* ===============================
       5️⃣ DETERMINAR RESULTADO
    =============================== */

    let note = "";

    if (cantidadReservada === parseInt(stockMove.product_qty)) {

        note = "Cantidad completa reservada";

    } else if (cantidadReservada > 0) {

        note = "Cantidad parcialmente reservada";

    } else {

        note = "Cantidad no reservada";
    }

    /* ===============================
       6️⃣ ACTUALIZAR STOCK MOVE
    =============================== */
    let state = "confirmed";
    if (cantidadReservada === parseInt(stockMove.product_qty)) {
        state = "assigned";
    } else if (cantidadReservada > 0) {
        state = "partially_available";
    }

    await client.query(`
    UPDATE stock_move
    SET 
        reserved_qty = $1,
        note = $2,
        state = $3
    WHERE id = $4
`, [cantidadReservada, note, state, stockMove.move_id]);

    return {
        reserved: cantidadReservada,
        note
    };
}


//Servicio para ordenar los move lines
export async function getMoveLinesOrderedByLocation(client, pickingId) {
  try {
    const query = `
      SELECT 
        sml.id,
        sml.move_id,
        sml.product_id,
        sml.product_uom_qty,
        sml.qty_done,
        sml.location_id,
        sml.warehouse_id,

        l.tramo,
        l.nivel,
        l.code,

        p.sku,
        p.description

      FROM stock_move_line sml

      INNER JOIN locations l 
        ON l.id = sml.location_id
       AND l.warehouse_id = sml.warehouse_id

      INNER JOIN products p
        ON p.id = sml.product_id

      WHERE sml.picking_id = $1

      ORDER BY 
        l.tramo DESC,
        l.nivel DESC
    `;

    const { rows } = await client.query(query, [pickingId]);

    console.log("📦 Líneas ordenadas por ubicación:", rows);

    return rows;

  } catch (error) {
    console.error("❌ Error obteniendo líneas de picking:", error);
    throw error;
  }
}