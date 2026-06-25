import { getPickingConfig } from "../services/pickingBestRoute.js";

export async function reserveMissingQtyForExistingMoveLines(client, move) {
  const stockMove = move.moves?.[0];

  if (!stockMove) {
    throw new Error("El producto no tiene stock_move asociado");
  }

  const moveId = stockMove.move_id;
  const pickingId = move.picking_id;
  const productId = move.product_id;
  const sku = move.sku;
  const requiredQty = Number(stockMove.product_qty || 0);

  console.log("🟣 ---- reserveMissingQtyForExistingMoveLines ----");
  console.log("🆔 moveId:", moveId);
  console.log("📦 productId:", productId);
  console.log("🏷️ sku:", sku);
  console.log("📌 requiredQty:", requiredQty);

  const config = await getPickingConfig(client);

  const moveLines = await getStockMoveLinesByMoveId(client, moveId);

  const processedLines = moveLines.filter(
    line => Number(line.qty_done || 0) > 0
  );

  const openReservedLines = moveLines.filter(
    line => Number(line.qty_done || 0) === 0
  );

  const processedQty = sumQty(processedLines, "qty_done");
  const openReservedQty = sumQty(openReservedLines, "product_uom_qty");

  const coveredQty = processedQty + openReservedQty;
  const diffQty = requiredQty - coveredQty;

  console.log("🧮 RESUMEN DE RESERVA:", {
    requiredQty,
    processedQty,
    openReservedQty,
    coveredQty,
    diffQty,
    allow_picking_without_locations: config.allow_picking_without_locations
  });

  // =====================================================
  // CASO 1: LA ORDEN AUMENTÓ
  // =====================================================
  if (diffQty > 0) {
    console.log("🟢 CASO 1: La orden aumentó");
    console.log("🟢 Cantidad adicional a reservar:", diffQty);

    if (config.allow_picking_without_locations) {
      const result = await increaseExistingMoveLineWithoutLocations(client, {
        move,
        stockMove,
        moveLines,
        openReservedLines,
        diffQty,
      });

      await updateStockMoveReservedQtyAndState(client, moveId, requiredQty);

      return {
        ...result,
        case: "ORDER_INCREASED",
      };
    }

    const potentialResult = buildPotentialMoveLinesFromLocations(
      move.locations || [],
      diffQty
    );

    console.log("📍 POTENCIALES PARA RESERVA ADICIONAL:", potentialResult.lines);
    console.log("📍 Cantidad potencial:", potentialResult.totalPotentialQty);
    console.log("📍 Faltante:", potentialResult.remainingQty);

    if (potentialResult.lines.length === 0) {
      await updateStockMoveReservedQtyAndState(client, moveId, requiredQty);

      return {
        reserved: 0,
        skipped: true,
        case: "ORDER_INCREASED_NO_STOCK",
        message: "La orden aumentó, pero no hay inventario disponible para reservar la diferencia.",
      };
    }

    const reservedQty = await createAndReservePotentialMoveLines(client, {
      move,
      stockMove,
      sku,
      potentialLines: potentialResult.lines,
    });

    await updateStockMoveReservedQtyAndState(client, moveId, requiredQty);

    return {
      reserved: reservedQty,
      skipped: false,
      case: "ORDER_INCREASED",
      missingQty: potentialResult.remainingQty,
      message:
        potentialResult.remainingQty > 0
          ? "La orden aumentó. Se creó reserva adicional parcial."
          : "La orden aumentó. Se reservó la diferencia correctamente.",
    };
  }

  // =====================================================
  // CASO 2: LA ORDEN QUEDÓ IGUAL
  // =====================================================
  if (diffQty === 0) {
    console.log("✅ CASO 2: La orden está exacta. No falta ni sobra reserva.");

    await updateStockMoveReservedQtyAndState(client, moveId, requiredQty);

    return {
      reserved: 0,
      skipped: true,
      case: "ORDER_EXACT",
      message: "El move ya está cubierto exactamente. No se hace ningún cambio.",
    };
  }

  // =====================================================
  // CASO 3: LA ORDEN BAJÓ
  // =====================================================
  if (diffQty < 0) {
    const qtyToRelease = Math.abs(diffQty);

    console.log("🟠 CASO 3: La orden bajó");
    console.log("🟠 Cantidad a liberar:", qtyToRelease);

    const releaseResult = await releaseExtraReservedQty(client, {
      openReservedLines,
      qtyToRelease,
      updateInventory: !config.allow_picking_without_locations,
    });

    await updateStockMoveReservedQtyAndState(client, moveId, requiredQty);

    return {
      released: releaseResult.releasedQty,
      skipped: false,
      case: "ORDER_DECREASED",
      message: "La orden bajó. Se liberó la reserva sobrante.",
    };
  }
}

async function releaseExtraReservedQty(client, {
  openReservedLines,
  qtyToRelease,
  updateInventory = true,
}) {
  let remainingToRelease = Number(qtyToRelease || 0);
  let releasedQty = 0;

  console.log("🟠 ---- releaseExtraReservedQty ----");
  console.log("🟠 qtyToRelease:", qtyToRelease);
  console.log("🟠 updateInventory:", updateInventory);

  if (remainingToRelease <= 0) {
    return {
      releasedQty: 0,
      message: "No hay cantidad para liberar.",
    };
  }

  // Recomendación: liberar primero las líneas más nuevas.
  const sortedLines = [...openReservedLines].sort(
    (a, b) => Number(b.id) - Number(a.id)
  );

  for (const line of sortedLines) {
    if (remainingToRelease <= 0) break;

    const lineQty = Number(line.product_uom_qty || 0);

    if (lineQty <= 0) continue;

    const qtyFromThisLine = Math.min(lineQty, remainingToRelease);

    console.log("🟠 Liberando de stock_move_line:", {
      lineId: line.id,
      lineQty,
      qtyFromThisLine,
      locationId: line.location_id,
    });

    // 1️⃣ Liberar en inventory_by_location si aplica
    if (updateInventory) {
      await releaseReservationFromInventory(client, line, qtyFromThisLine);
    }

    // 2️⃣ Si se libera toda la línea, cancelarla
    if (qtyFromThisLine === lineQty) {
      await cancelStockMoveLine(client, line.id);

      console.log("✅ stock_move_line cancelada completa:", line.id);
    }

    // 3️⃣ Si solo se libera parte, reducir product_uom_qty
    else {
      await client.query(
        `
        UPDATE stock_move_line
        SET product_uom_qty = product_uom_qty - $1,
            state = 'assigned'
        WHERE id = $2
        `,
        [qtyFromThisLine, line.id]
      );

      console.log("✅ stock_move_line reducida parcialmente:", {
        lineId: line.id,
        reducedBy: qtyFromThisLine,
      });
    }

    releasedQty += qtyFromThisLine;
    remainingToRelease -= qtyFromThisLine;
  }

  if (remainingToRelease > 0) {
    console.log("⚠️ No se pudo liberar toda la cantidad solicitada:", {
      qtyToRelease,
      releasedQty,
      remainingToRelease,
    });
  }

  return {
    releasedQty,
    remainingToRelease,
  };
}


async function releaseReservationFromInventory(client, stockMoveLine, qtyToRelease) {
  console.log("🟠 Liberando inventory_by_location:", {
    stockMoveLineId: stockMoveLine.id,
    productId: stockMoveLine.product_id,
    locationId: stockMoveLine.location_id,
    qtyToRelease,
  });


  

  const product = await getProductSkuByProductId(
    client,
    stockMoveLine.product_id
  );

  if (!product?.sku) {
    throw new Error(
      `No se encontró SKU para product_id ${stockMoveLine.product_id}`
    );
  }
 console.log("🟨🟨🟨🟨🟨 location id: ", product.sku );
 console.log("🟨🟨🟨🟨🟨 product sku: ", stockMoveLine.location_id );
  const inventoryResult = await client.query(
    `
    SELECT id, qty_reserved
    FROM inventory_by_location
    WHERE product_sku = $1
      AND location_id = $2
    FOR UPDATE
    `,
    [
      product.sku,
      stockMoveLine.location_id,
    ]
  );

  if (inventoryResult.rows.length === 0) {
    throw new Error(
      `No existe inventory_by_location para SKU ${product.sku} en location_id ${stockMoveLine.location_id}`
    );
  }

  const inventoryLine = inventoryResult.rows[0];
  const currentReserved = Number(inventoryLine.qty_reserved || 0);

  if (currentReserved < qtyToRelease) {
    throw new Error(
      `No hay reserva suficiente para liberar. SKU ${product.sku}, location_id ${stockMoveLine.location_id}. Reservado actual: ${currentReserved}, se intenta liberar: ${qtyToRelease}`
    );
  }

  await client.query(
    `
    UPDATE inventory_by_location
    SET qty_reserved = qty_reserved - $1,
        updated_at = NOW()
    WHERE id = $2
    `,
    [
      qtyToRelease,
      inventoryLine.id,
    ]
  );

  console.log("✅ inventory_by_location liberado:", {
    sku: product.sku,
    locationId: stockMoveLine.location_id,
    qtyToRelease,
  });
}


async function getStockMoveLinesByMoveId(client, moveId) {
  const query = `
    SELECT *
    FROM stock_move_line
    WHERE move_id = $1
      AND COALESCE(state, '') != 'cancel'
    ORDER BY id ASC
  `;

  const { rows } = await client.query(query, [moveId]);
  return rows;
}

function sumQty(lines, field) {
  return lines.reduce((total, line) => {
    return total + Number(line[field] || 0);
  }, 0);
}

async function increaseExistingMoveLineWithoutLocations(client, {
  move,
  stockMove,
  moveLines,
  openReservedLines,
  diffQty,
}) {
  const pickingId = move.picking_id;
  const productId = move.product_id;

  /**
   * Preferencia:
   * 1. Usar una línea abierta qty_done = 0 si existe.
   * 2. Si no existe, usar la location_id de cualquier línea existente.
   * 3. Si tampoco existe, usar la primera location sugerida.
   */
  const targetOpenLine = openReservedLines[0];

  const locationId =
    targetOpenLine?.location_id ||
    moveLines[0]?.location_id ||
    move.selected_location?.sugerido?.[0]?.location_id ||
    move.locations?.[0]?.location_id;

  if (!locationId) {
    throw new Error("No se pudo determinar location_id para aumentar la reserva");
  }

  if (targetOpenLine) {
    console.log("🟢 Aumentando stock_move_line existente:", targetOpenLine.id);

    await client.query(
      `
      UPDATE stock_move_line
      SET product_uom_qty = product_uom_qty + $1,
          state = 'assigned'
      WHERE id = $2
      `,
      [diffQty, targetOpenLine.id]
    );

    return {
      reserved: diffQty,
      skipped: false,
      message: "Se aumentó la stock_move_line existente con la diferencia.",
    };
  }

  console.log("🟢 No había línea abierta. Creando nueva línea con misma ubicación:", locationId);

  await client.query(
    `
    INSERT INTO stock_move_line (
      move_id,
      picking_id,
      product_id,
      product_uom_qty,
      qty_done,
      location_id,
      product_uom_id,
      warehouse_id,
      state
    )
    VALUES ($1, $2, $3, $4, 0, $5, $6, $7, 'assigned')
    `,
    [
      stockMove.move_id,
      pickingId,
      productId,
      diffQty,
      locationId,
      stockMove.move_product_uom_id,
      move.locations?.[0]?.almacen || 1,
    ]
  );

  return {
    reserved: diffQty,
    skipped: false,
    message: "Se creó nueva stock_move_line por la diferencia faltante.",
  };
}


async function cancelReservationForStockMoveLine(client, stockMoveLine) {
  console.log("🟠 Cancelando reserva de stock_move_line:", stockMoveLine.id);

  const product = await getProductSkuByProductId(
    client,
    stockMoveLine.product_id
  );

  if (!product?.sku) {
    throw new Error(
      `No se encontró SKU para product_id ${stockMoveLine.product_id}`
    );
  }

  const qtyToCancel = Number(stockMoveLine.product_uom_qty || 0);

  if (qtyToCancel <= 0) {
    return;
  }

  const query = `
    SELECT id, qty_reserved
    FROM inventory_by_location
    WHERE product_sku = $1
      AND location_id = $2
    FOR UPDATE
  `;

  const { rows } = await client.query(query, [
    product.sku,
    stockMoveLine.location_id,
  ]);

  if (rows.length === 0) {
    throw new Error(
      `No existe inventory_by_location para SKU ${product.sku} en location_id ${stockMoveLine.location_id}`
    );
  }

  const inventoryLine = rows[0];
  const currentReserved = Number(inventoryLine.qty_reserved || 0);

  if (currentReserved < qtyToCancel) {
    throw new Error(
      `No hay cantidad reservada suficiente. SKU ${product.sku}, location_id ${stockMoveLine.location_id}. Reservado actual: ${currentReserved}, se intenta cancelar: ${qtyToCancel}`
    );
  }

  await client.query(
    `
    UPDATE inventory_by_location
    SET qty_reserved = qty_reserved - $1,
        updated_at = NOW()
    WHERE id = $2
    `,
    [qtyToCancel, inventoryLine.id]
  );

  console.log("✅ Reserva cancelada en inventory_by_location:", {
    sku: product.sku,
    location_id: stockMoveLine.location_id,
    qtyToCancel,
  });
}

async function getProductSkuByProductId(client, productId) {
  const query = `
    SELECT sku
    FROM products
    WHERE id::text = $1::text
       OR sku::text = $1::text
    LIMIT 1
  `;

  const { rows } = await client.query(query, [productId]);

  return rows[0];
}

async function cancelStockMoveLine(client, stockMoveLineId) {
  await client.query(
    `
    UPDATE stock_move_line
    SET state = 'cancel'
    WHERE id = $1
    `,
    [stockMoveLineId]
  );

  console.log("✅ stock_move_line cancelada:", stockMoveLineId);
}

function buildPotentialMoveLinesFromLocations(locations, requiredQty) {
  const cleanLocations = (locations || [])
    .map(location => ({
      ...location,
      quantity: Number(location.quantity || 0),
      tramo: Number(location.tramo || 0),
    }))
    .filter(location => location.quantity > 0);

  /**
   * 1. Buscar ubicaciones con cantidad exacta.
   */
  const exactMatches = cleanLocations.filter(
    location => location.quantity === requiredQty
  );

  if (exactMatches.length > 0) {
    const bestExactMatch = exactMatches.sort((a, b) => b.tramo - a.tramo)[0];

    return {
      lines: [
        {
          location_id: bestExactMatch.location_id,
          quantity: requiredQty,
          tramo: bestExactMatch.tramo,
          almacen: bestExactMatch.almacen,
        },
      ],
      totalPotentialQty: requiredQty,
      remainingQty: 0,
    };
  }

  /**
   * 2. Si no hay cantidad exacta, ordenar por tramo mayor a menor.
   */
  const sortedLocations = cleanLocations.sort((a, b) => b.tramo - a.tramo);

  let remainingQty = requiredQty;
  const lines = [];

  for (const location of sortedLocations) {
    if (remainingQty <= 0) break;

    const qtyToTake = Math.min(location.quantity, remainingQty);

    lines.push({
      location_id: location.location_id,
      quantity: qtyToTake,
      tramo: location.tramo,
      almacen: location.almacen,
    });

    remainingQty -= qtyToTake;
  }

  const totalPotentialQty = lines.reduce(
    (total, line) => total + Number(line.quantity || 0),
    0
  );

  return {
    lines,
    totalPotentialQty,
    remainingQty,
  };
}

async function createAndReservePotentialMoveLines(client, {
  move,
  stockMove,
  sku,
  potentialLines,
}) {
  let totalReserved = 0;

  for (const line of potentialLines) {
    const qtyToReserve = Number(line.quantity || 0);

    if (qtyToReserve <= 0) continue;

    /**
     * 1. Reservar en inventory_by_location.
     */
    const inventoryResult = await client.query(
      `
      UPDATE inventory_by_location
      SET qty_reserved = qty_reserved + $1,
          updated_at = NOW()
      WHERE product_sku = $2
        AND location_id = $3
        AND qty_available >= $1
      RETURNING id, qty_reserved, qty_available
      `,
      [qtyToReserve, sku, line.location_id]
    );

    if (inventoryResult.rows.length === 0) {
      throw new Error(
        `No se pudo reservar SKU ${sku} en location_id ${line.location_id}. No hay qty_available suficiente.`
      );
    }

    /**
     * 2. Crear stock_move_line.
     */
    await client.query(
      `
      INSERT INTO stock_move_line (
        move_id,
        picking_id,
        product_id,
        product_uom_qty,
        qty_done,
        location_id,
        product_uom_id,
        warehouse_id,
        state
      )
      VALUES ($1, $2, $3, $4, 0, $5, $6, $7, 'assigned')
      `,
      [
        stockMove.move_id,
        move.picking_id,
        move.product_id,
        qtyToReserve,
        line.location_id,
        stockMove.move_product_uom_id,
        line.almacen || 1,
      ]
    );

    totalReserved += qtyToReserve;

    console.log("✅ Nueva stock_move_line creada y reservada:", {
      sku,
      location_id: line.location_id,
      qtyToReserve,
    });
  }

  return totalReserved;
}

async function updateStockMoveReservedQtyAndState(client, moveId, requiredQty) {
  const query = `
    SELECT
      COALESCE(SUM(CASE 
        WHEN COALESCE(qty_done, 0) > 0 
        THEN qty_done 
        ELSE 0 
      END), 0) AS done_qty,

      COALESCE(SUM(CASE 
        WHEN COALESCE(qty_done, 0) = 0 
         AND COALESCE(state, '') != 'cancel'
        THEN product_uom_qty 
        ELSE 0 
      END), 0) AS reserved_open_qty
    FROM stock_move_line
    WHERE move_id = $1
      AND COALESCE(state, '') != 'cancel'
  `;

  const { rows } = await client.query(query, [moveId]);

  const doneQty = Number(rows[0].done_qty || 0);
  const reservedOpenQty = Number(rows[0].reserved_open_qty || 0);

  const coveredQty = doneQty + reservedOpenQty;

  let state = "confirmed";

  if (coveredQty >= requiredQty) {
    state = "assigned";
  } else if (coveredQty > 0) {
    state = "partially_available";
  }

  await client.query(
    `
    UPDATE stock_move
    SET reserved_qty = $1,
        state = $2
    WHERE id = $3
    `,
    [reservedOpenQty, state, moveId]
  );

  console.log("✅ stock_move actualizado:", {
    moveId,
    requiredQty,
    doneQty,
    reservedOpenQty,
    coveredQty,
    state,
  });

  return {
    doneQty,
    reservedOpenQty,
    coveredQty,
    state,
  };
}