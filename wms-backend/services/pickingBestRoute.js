


//
export async function getPickingProductsWithLocationsService(client, pickingId) {
  console.log("🧠 [SERVICE] Procesando picking:", pickingId);

  // ==============================
  // 1️⃣ TRAER MOVES, se buscan todos los lines de la orden de venta, de obtiene el produc id y la cantidad pedida.
  // ==============================
const movesResult = await client.query(
  `
    SELECT id, product_id, product_qty, product_uom_id
    FROM stock_move
    WHERE picking_id = $1
    ORDER BY id ASC
  `,
  [pickingId]
);
  if (!movesResult.rows.length) {
    return {
      data: [],
      message: "No hay productos en este picking",
    };
  }

  const moves = movesResult.rows;
  //console.log("PRODUCTOS DEL PEDIDO: ", moves);

  // ==============================
  // 2️⃣ PRODUCT IDS, Se filtran los ids para que no se repitan.
  // ==============================
  const productIds = [...new Set(moves.map(m => m.product_id))];

  // ==============================
  // 3️⃣ SKUs
  // ==============================
  const productsResult = await client.query(`
    SELECT id, sku
    FROM products
    WHERE id = ANY($1::int[])
  `, [productIds]);

  //// Relaciona product_id → SKU
  const skuMap = new Map();
  // Lista de SKU para consultar el inventario
  const skuList = [];

  for (const p of productsResult.rows) {
    skuMap.set(p.id, p.sku);
    skuList.push(p.sku);
  }
  console.log("TODOS LOS SKUS: ", skuList);
  // ==============================
  // 4️⃣ INVENTARIO + LOCATIONS, por cada sku, se busca la ubicacion, almacen, cantidad disponible.
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
    AND l.location_type IS DISTINCT FROM 'SHIPPING'
  `,
  [skuList]
);

  console.log("📦 INVENTORY RESULT:", inventoryResult.rows);

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

//Aqui utilizando el almacen de la orden de venta se busca el almacen o id de almacen interno del wms
  const warehouseResult = await client.query(
  `
    SELECT
      w.id,
      w.code,
      w.name,
      w.erp_warehouse_id,
      sp.erp_location_id
    FROM public.stock_picking AS sp
    JOIN public.warehouses AS w
      ON w.erp_warehouse_id = sp.erp_location_id
    WHERE sp.id = $1
      AND w.status = 'ACTIVE'
  `,
  [pickingId]
);



  if (warehouseResult.rowCount === 0) {
    throw new Error("No existe warehouse por defecto");
  }

  const warehouseId = warehouseResult.rows[0].id;

  // ==============================
  // 6️⃣ CONFIG + FALLBACK
  // ==============================
  const config = await getPickingConfig(client);

  let defaultLocation = null;

  if (config.allow_picking_without_locations) {

    defaultLocation = await getOrCreateDefaultLocation(client, warehouseId);
  }

  // ==============================
  // 7️⃣ RESULT FINAL
  // ==============================
  const resultMap = new Map();
  let hasAtLeastOneLocation = false;

  for (const move of moves) {
    const sku = skuMap.get(move.product_id);

    // 🔴 VALIDACIÓN SKU
    if (!sku) {
      const error = new Error(`Producto ${move.product_id} no tiene SKU`);
      error.code = "NO_SKU";
      throw error;
    }

    const productLocations = inventoryMap.get(sku);

    //console.log("UBICACIONES DEL PRODUCTO: ", sku, "ES: ", productLocations);

    let finalLocations = [];

    if (productLocations?.length) {
      // 🟢 Tiene ubicaciones reales
      hasAtLeastOneLocation = true;
      finalLocations = productLocations;

    } else if (config.allow_picking_without_locations && defaultLocation) {
      // 🟡 Fallback GENERAL
      finalLocations = [{
        location_id: defaultLocation.id,
        quantity: 0,
        tramo: defaultLocation.tramo,
        nivel: defaultLocation.nivel,
        almacen: defaultLocation.warehouse_id,
        code: defaultLocation.code,
        is_fallback: true
      }];

    } else {
      continue;
    }
    if (!resultMap.has(move.product_id)) {
      resultMap.set(move.product_id, {
        product_id: move.product_id,
        sku,
        picking_id: Number(pickingId),
        moves: [],
        locations: finalLocations,
      });
    }

    resultMap.get(move.product_id).moves.push({
      move_id: move.id,
      product_qty: Math.floor(Number(move.product_qty)) || 0,
      move_product_uom_id: move.product_uom_id,
    });
  }

  if (
    !hasAtLeastOneLocation &&
    !config.allow_picking_without_locations
  ) {
    return {
      data: [],
      message: "Ningún producto tiene inventario en ubicaciones",
    };
  }

  return {
    data: Array.from(resultMap.values()),
  };
}

//CASO 1: Buscar 1 ubicacion ideal
export function selectBestLocation(product) {

  //suma las cantidades solicitadas y se unifica por producto, ya que un producto pudiera tener mas de un move.
  const requiredQty = product.moves.reduce(
    (sum, m) => sum + Number(m.product_qty),
    0
  );

  //Se obtiene sus ubicaciones
  const locations = product.locations || [];

  if (!locations.length) return null;

  // ==============================
  // 🔹 CASO 1: UNA SOLA UBICACIÓN, se intenta buscar una ubicacion con toda la cantidad solicitada de ese producto
  // ==============================
  const validLocations = locations.filter(
    loc => Number(loc.quantity) >= requiredQty
  );

  //Si hay una ubicacion que satisface todo
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






// =====================================================
// SERVICIO DE RESERVA DE INVENTARIO
// config.allow_picking_without_locations === false
// Se asume que todavía NO existen reservas para estos moves
// =====================================================
export async function reserveInventoryForMove(client, move) {

  console.log("");
  console.log("=======================================");
  console.log("🟦 reserveInventoryForMove");
  console.log("=======================================");

  // ==========================================
  // 1️⃣ DATOS DEL PRODUCTO
  // ==========================================

  const productSku =
    move.sku;

  const stockMoves =
    Array.isArray(move.moves)
      ? move.moves
      : [];


  // ==========================================
  // 2️⃣ OBTENER UBICACIONES SELECCIONADAS
  // ==========================================

  const rawMoveLines =
    Array.isArray(move.selected_location)
      ? move.selected_location
      : move.selected_location?.sugerido || [];


  // ==========================================
  // 3️⃣ AGREGAR "restante"
  // ==========================================

  const moveLines =
    rawMoveLines.map(row => ({
      ...row,

      quantity_taken:
        Number(row.quantity_taken || 0),

      restante:
        Number(row.quantity_taken || 0)
    }));


  console.log(
    "📦 SKU:",
    productSku
  );

  console.log(
    "🚚 STOCK MOVES:",
    stockMoves
  );

  console.log(
    "📍 MOVE LINES CON RESTANTE:",
    moveLines
  );


  // ==========================================
  // 4️⃣ VALIDAR CONFIG
  // ==========================================

  const config =
    await getPickingConfig(client);


  if (
    config.allow_picking_without_locations
  ) {

    throw new Error(
      "reserveInventoryForMove fue llamado con allow_picking_without_locations=true. Esta lógica es para picking con ubicaciones."
    );
  }


  // ==========================================
  // 5️⃣ VALIDAR STOCK MOVES
  // ==========================================

  if (
    stockMoves.length === 0
  ) {

    console.log(
      "⚠️ No hay stock moves"
    );

    return {
      reserved: 0,
      note: "Sin stock moves",
      moves: [],
      remaining_locations: moveLines
    };
  }


  // ==========================================
  // 6️⃣ VALIDAR UBICACIONES
  // ==========================================

  if (
    moveLines.length === 0
  ) {

    console.log(
      "⚠️ No hay ubicaciones para reservar"
    );


    // Marcar cada move sin reserva
    for (
      const stockMove of stockMoves
    ) {

      await client.query(
        `
        UPDATE stock_move
        SET
          reserved_qty = 0,
          note = $1,
          state = $2
        WHERE id = $3
        `,
        [
          "Cantidad no reservada",
          "confirmed",
          Number(stockMove.move_id)
        ]
      );
    }


    return {
      reserved: 0,
      note: "Sin ubicaciones disponibles",
      moves: [],
      remaining_locations: []
    };
  }


  // ==========================================
  // 7️⃣ VARIABLES GENERALES
  // ==========================================

  let cantidadReservada = 0;

  const moveResults = [];


  // ==========================================
  // FUNCIÓN INTERNA:
  // CREAR STOCK_MOVE_LINE
  // ==========================================

  const createStockMoveLine =
    async (
      stockMove,
      location,
      qty
    ) => {

      await client.query(
        `
        INSERT INTO stock_move_line
        (
          move_id,
          picking_id,
          product_id,
          product_uom_id,
          warehouse_id,
          location_id,
          product_uom_qty,
          state
        )
        VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8)
        `,
        [
          Number(
            stockMove.move_id
          ),

          Number(
            move.picking_id
          ),

          Number(
            move.product_id
          ),

          Number(
            stockMove.move_product_uom_id
          ),

          Number(
            location.almacen
          ),

          Number(
            location.location_id
          ),

          Number(
            qty
          ),

          "assigned"
        ]
      );


      console.log(
        `✅ stock_move_line creado | move=${stockMove.move_id} | location=${location.location_id} | qty=${qty}`
      );
    };


  // ==========================================
  // 8️⃣ RECORRER CADA STOCK MOVE
  // ==========================================

  for (
    const stockMove of stockMoves
  ) {

    console.log("");
    console.log("---------------------------------------");
    console.log(
      "🚚 PROCESANDO STOCK MOVE:",
      stockMove.move_id
    );
    console.log("---------------------------------------");


    const requiredQty =
      Number(
        stockMove.product_qty || 0
      );


    let reservedForMove = 0;


    console.log(
      "📌 Cantidad requerida:",
      requiredQty
    );


    if (
      requiredQty <= 0
    ) {

      console.log(
        "⚠️ Stock move sin cantidad requerida"
      );

      continue;
    }


    // ========================================
    // 9️⃣ BUSCAR UNA UBICACIÓN QUE PUEDA
    // CUBRIR TODO EL STOCK MOVE
    // ========================================

    const fullLocation =
      moveLines.find(
        location =>
          Number(location.restante) > 0 &&
          Number(location.restante) >= requiredQty
      );


    // ========================================
    // CASO 1:
    // UNA SOLA UBICACIÓN CUBRE TODO
    // ========================================

    if (fullLocation) {

      console.log(
        "🟢 Una ubicación cubre todo:",
        {
          location_id:
            fullLocation.location_id,

          disponible:
            fullLocation.restante,

          requerido:
            requiredQty
        }
      );


      const qtyToReserve =
        requiredQty;


      await createStockMoveLine(
        stockMove,
        fullLocation,
        qtyToReserve
      );


      // Restar de la ubicación
      fullLocation.restante -=
        qtyToReserve;


      // Reserva del move
      reservedForMove +=
        qtyToReserve;


      // Reserva total del producto
      cantidadReservada +=
        qtyToReserve;


      console.log(
        "📉 Restante ubicación:",
        fullLocation.restante
      );

    } else {

      // ======================================
      // CASO 2:
      // NINGUNA UBICACIÓN SOLA CUBRE TODO
      //
      // DIVIDIR ENTRE VARIAS UBICACIONES
      // ======================================

      console.log(
        "🟡 Ninguna ubicación cubre todo."
      );

      console.log(
        "🟡 Dividiendo reserva entre ubicaciones..."
      );


      for (
        const location of moveLines
      ) {

        // ====================================
        // IGNORAR UBICACIONES AGOTADAS
        // ====================================

        if (
          Number(location.restante) <= 0
        ) {

          console.log(
            `⏭️ Location ${location.location_id} restante=0`
          );

          continue;
        }


        // ====================================
        // CUÁNTO LE FALTA AL STOCK MOVE
        // ====================================

        const qtyMissing =
          requiredQty -
          reservedForMove;


        if (
          qtyMissing <= 0
        ) {

          break;
        }


        // ====================================
        // TOMAR EL MENOR VALOR
        //
        // restante ubicación
        // VS
        // cantidad faltante del move
        // ====================================

        const qtyToReserve =
          Math.min(
            Number(
              location.restante
            ),

            qtyMissing
          );


        if (
          qtyToReserve <= 0
        ) {

          continue;
        }


        console.log(
          "📦 Usando ubicación:",
          {
            location_id:
              location.location_id,

            restanteAntes:
              location.restante,

            faltanteMove:
              qtyMissing,

            qtyToReserve
          }
        );


        // ====================================
        // CREAR STOCK_MOVE_LINE
        // ====================================

        await createStockMoveLine(
          stockMove,
          location,
          qtyToReserve
        );


        // ====================================
        // RESTAR DE UBICACIÓN
        // ====================================

        location.restante -=
          qtyToReserve;


        // ====================================
        // SUMAR RESERVA DEL MOVE
        // ====================================

        reservedForMove +=
          qtyToReserve;


        // ====================================
        // SUMAR RESERVA TOTAL
        // ====================================

        cantidadReservada +=
          qtyToReserve;


        console.log(
          "📊 Después de reservar:",
          {
            move_id:
              stockMove.move_id,

            reservedForMove,

            requiredQty,

            location_id:
              location.location_id,

            restanteLocation:
              location.restante
          }
        );


        // ====================================
        // SI YA COMPLETAMOS EL MOVE
        // SALIMOS DEL LOOP DE LOCATIONS
        // ====================================

        if (
          reservedForMove >=
          requiredQty
        ) {

          console.log(
            "✅ Stock move completamente reservado"
          );

          break;
        }
      }
    }


    // ========================================
    // 🔟 DETERMINAR ESTADO DE ESTE STOCK MOVE
    // ========================================

    let note =
      "Cantidad no reservada";

    let state =
      "confirmed";


    if (
      reservedForMove ===
      requiredQty
    ) {

      note =
        "Cantidad completa reservada";

      state =
        "assigned";

    } else if (
      reservedForMove > 0
    ) {

      note =
        "Cantidad parcialmente reservada";

      state =
        "partially_available";
    }


    // ========================================
    // 1️⃣1️⃣ ACTUALIZAR ESTE STOCK MOVE
    // ========================================

    await client.query(
      `
      UPDATE stock_move
      SET
        reserved_qty = $1,
        note = $2,
        state = $3
      WHERE id = $4
      `,
      [
        reservedForMove,
        note,
        state,
        Number(
          stockMove.move_id
        )
      ]
    );


    console.log(
      "✅ STOCK MOVE ACTUALIZADO:",
      {
        move_id:
          stockMove.move_id,

        requiredQty,

        reservedForMove,

        state,

        note
      }
    );


    moveResults.push({
      move_id:
        Number(
          stockMove.move_id
        ),

      required:
        requiredQty,

      reserved:
        reservedForMove,

      missing:
        Math.max(
          requiredQty -
          reservedForMove,
          0
        ),

      state,

      note
    });
  }


  // ==========================================
  // 1️⃣2️⃣ RESULTADO GENERAL
  // ==========================================

  const totalRequired =
    stockMoves.reduce(
      (
        total,
        stockMove
      ) =>
        total +
        Number(
          stockMove.product_qty || 0
        ),
      0
    );


  let generalNote =
    "Cantidad no reservada";


  if (
    cantidadReservada ===
    totalRequired
  ) {

    generalNote =
      "Cantidad completa reservada";

  } else if (
    cantidadReservada > 0
  ) {

    generalNote =
      "Cantidad parcialmente reservada";
  }


  console.log("");
  console.log("=======================================");
  console.log("✅ RESERVA FINAL");
  console.log("=======================================");

  console.log({
    sku:
      productSku,

    totalRequired,

    cantidadReservada,

    locations:
      moveLines,

    moves:
      moveResults
  });


  return {
    reserved:
      cantidadReservada,

    required:
      totalRequired,

    missing:
      Math.max(
        totalRequired -
        cantidadReservada,
        0
      ),

    note:
      generalNote,

    moves:
      moveResults,

    remaining_locations:
      moveLines
  };
}








//Sevicio de reserva de inventario
/*export async function reserveInventoryForMove(client, move) {

  const productSku = move.sku;
  const stockMove = move.moves[0];
  const moveLines = Array.isArray(move.selected_location)
    ? move.selected_location
    : move.selected_location?.sugerido || [];
  let cantidadReservada = 0;


  
  //3️⃣ ACTUALIZAR RESERVA
  
  const values = [];
  const updates = [];
  const config = await getPickingConfig(client);


  let resultQuery = null; // ✅ AQUÍ
  console.log("🟨🟨 MOVE DE reserveInventoryForMove: ", move);
  console.log("🟨🟨 stockMove DE reserveInventoryForMove: ", stockMove);

  if (!moveLines || moveLines.length === 0) {
    console.log("⚠️ No hay líneas para reservar");

    // ==============================
    // 6️⃣ CONFIG + FALLBACK
    // ==============================


    //let defaultLocation = null;

    if (config.allow_picking_without_locations) {
      //const warehouseId = inventoryResult.rows[0]?.warehouse_id || 1;
      //defaultLocation = await getOrCreateDefaultLocation(client, warehouseId);
      console.log("🟥🟨 CONTINUAMOS");
    } else {
      console.log("🟥🟨 DEVUELVES");
      return { reserved: 0, note: "Sin líneas" };
    }
  }


  if (1 == 1) {
    console.log("🟥🟨 CONTINUAMOS");
  } else {
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

    console.log("🟥🟥VALUES DE reserveInventoryForMove: ", values);



    resultQuery = await client.query(
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

  }




  console.log("🟥🟥RESULT DE VALUES DE reserveInventoryForMove: ", resultQuery);

  //2️⃣ RECORRER INVENTARIO

  console.log("🟨🟨 MOVE LINES DE reserveInventoryForMove: ", moveLines);
  // ===============================
  // PICKING SIN UBICACIONES
  // ===============================
  if (config.allow_picking_without_locations) {

    console.log("⚠️ Picking sin ubicaciones habilitado");


    // ===============================
    // VALIDAR SI YA EXISTE MOVE LINE
    // ===============================
    const existingMoveLine = await client.query(`
  SELECT id
  FROM stock_move_line
  WHERE move_id = $1
  AND picking_id = $2
`, [
      stockMove.move_id,
      move.picking_id
    ]);

    if (existingMoveLine.rows.length > 0) {
      console.log("⚠️ Move line ya existe");

      return {
        reserved: 0,
        note: "Move line ya existe"
      };
    }


    // ===============================
    // PICKING SIN UBICACIONES
    // ===============================

    await client.query(`
    INSERT INTO stock_move_line
    (
      move_id,
      picking_id,
      product_id,
      product_uom_id,
      warehouse_id,
      location_id,
      product_uom_qty,
      state
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
  `, [
      Number(stockMove.move_id),
      Number(move.picking_id),
      Number(move.product_id),
      Number(stockMove.move_product_uom_id),

      // fallback location
      Number(move.locations[0].almacen),
      Number(move.locations[0].location_id),

      // cantidad completa del move
      Number(stockMove.product_qty),

      "assigned"
    ]);

    cantidadReservada = Number(stockMove.product_qty);

    console.log(`📦 Reservado SIN LOCATION ${stockMove.product_qty}`);

  } else {

    // ===============================
    // PICKING NORMAL CON UBICACIONES
    // ===============================
    for (const row of moveLines) {

      await client.query(`
      INSERT INTO stock_move_line
      (
        move_id,
        picking_id,
        product_id,
        product_uom_id,
        warehouse_id,
        location_id,
        product_uom_qty,
        state
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `, [
        Number(stockMove.move_id),
        Number(move.picking_id),
        Number(move.product_id),
        Number(stockMove.move_product_uom_id),

        Number(row.almacen),
        Number(row.location_id),
        Number(row.quantity_taken),

        "assigned"
      ]);

      cantidadReservada += Number(row.quantity_taken);

      console.log(
        `📦 Reservado ${row.quantity_taken} en location ${row.location_id}`
      );

      if (cantidadReservada >= Number(stockMove.product_qty)) {
        break;
      }
    }
  }

  //===============================
  //5️⃣ DETERMINAR RESULTADO
  //===============================

  let note = "";

  if (cantidadReservada === parseInt(stockMove.product_qty)) {

    note = "Cantidad completa reservada";

  } else if (cantidadReservada > 0) {

    note = "Cantidad parcialmente reservada";

  } else {

    note = "Cantidad no reservada";
  }

  //===============================
 //6️⃣ ACTUALIZAR STOCK MOVE
 // ===============================
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
}*/


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
        p.description,
        p.erp_name,
        p.erp_sku,
        P.erp_id

      FROM stock_move_line sml

      INNER JOIN locations l 
        ON l.id = sml.location_id
       AND l.warehouse_id = sml.warehouse_id

      INNER JOIN products p
        ON p.id = sml.product_id

      WHERE sml.picking_id = $1
  AND sml.state NOT IN ('done', 'cancel')

      ORDER BY 
        l.tramo DESC,
        l.nivel DESC
    `;

    const { rows } = await client.query(query, [pickingId]);

    //console.log("📦 Líneas ordenadas por ubicación:", rows);

    return rows;

  } catch (error) {
    console.error("❌ Error obteniendo líneas de picking:", error);
    throw error;
  }
}

//Servicio para obtener congifuracion de picking inicial
export async function getPickingConfig(client) {
  try {
    const result = await client.query(`
      SELECT allow_picking_without_locations
      FROM companies
      LIMIT 1
    `);

    // 🔹 Si no hay registro → default
    if (result.rows.length === 0) {
      return {
        allow_picking_without_locations: false
      };
    }

    return {
      allow_picking_without_locations:
        result.rows[0].allow_picking_without_locations ?? false
    };

  } catch (error) {
    console.error("❌ Error getPickingConfig:", error.message);

    return {
      allow_picking_without_locations: false
    };
  }
}

































// SERVICIO PARA LOCATION DEFAULT SI NO HAY OTROS
export async function getOrCreateDefaultLocation(
  client,
  warehouseId
) {
  try {
    console.log(
      "🔎 Buscando ubicación GENERAL para warehouse:",
      warehouseId
    );

    const existingResult = await client.query(
      `
      SELECT
        id,
        code,
        warehouse_id,
        location_type,
        tramo,
        nivel
      FROM locations
      WHERE warehouse_id = $1
        AND location_type = 'STORAGE'
        AND tramo = 999
        AND nivel = 999
      LIMIT 1
      `,
      [warehouseId]
    );

    if (existingResult.rowCount > 0) {
      console.log(
        "✅ Ubicación GENERAL encontrada:",
        existingResult.rows[0]
      );

      return existingResult.rows[0];
    }

    console.log(
      "⚠️ No existe GENERAL para warehouse:",
      warehouseId
    );

    const insertResult = await client.query(
      `
      INSERT INTO locations (
        code,
        warehouse_id,
        location_type,
        tramo,
        nivel
      )
      VALUES (
        $1,
        $2,
        'STORAGE',
        999,
        999
      )
      RETURNING
        id,
        code,
        warehouse_id,
        location_type,
        tramo,
        nivel
      `,
      [
        `GENERAL-${warehouseId}`,
        warehouseId
      ]
    );

    console.log(
      "✅ Ubicación GENERAL creada:",
      insertResult.rows[0]
    );

    return insertResult.rows[0];

  } catch (error) {
    console.error(
      "❌ Error getOrCreateDefaultLocation:",
      error
    );

    throw error;
  }
}
