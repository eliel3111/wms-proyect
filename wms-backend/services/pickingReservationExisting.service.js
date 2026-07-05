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

console.log("🟨🟨🟨 LINEAS CON CANTIDAD PICKICHEADA:", processedLines);

  const openReservedLines = moveLines.filter(
    line => Number(line.qty_done || 0) === 0
  );

  //const processedQty = sumQty(processedLines, "qty_done");
  const processedQty = sumQty(processedLines, "product_uom_qty");
console.log("🟨🟨🟨 CANTIDAD DE LAS LINEAS PICHEADAS YA HECHA:", processedQty);
//console.log("🟨🟨🟨 CANTIDAD DE LAS LINEAS PICHEADAS TOTAL:", processedQty2);
  const openReservedQty = sumQty(openReservedLines, "product_uom_qty");
console.log("🟨🟨🟨 CANTIDAD DE LINEAS NO TOCADAS:", openReservedQty);
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

  // 🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩
// CASO 1: LA ORDEN AUMENTÓ
// =====================================================
if (diffQty > 0) {
  console.log("🟢 CASO 1: La orden aumentó");
  console.log("🟢 Cantidad adicional a agregar en stock_move_line:", diffQty);

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

  // =====================================================
  // NUEVA LÓGICA:
  // Buscar disponibilidad real por moveId
  // =====================================================
  const availableResult = await availableLocationsForMoveId(
    client,
    moveId,
    moveLines
  );

  console.log("📍 REAL AVAILABLE LINES:", availableResult.lines);
  console.log("📍 Total real disponible:", availableResult.totalPotentialQty);

  if (availableResult.lines.length === 0) {
    await updateStockMoveReservedQtyAndState(client, moveId, coveredQty);

    return {
      reserved: 0,
      createdQty: 0,
      skipped: true,
      case: "ORDER_INCREASED_NO_STOCK",
      missingQty: diffQty,
      message:
        "La orden aumentó, pero no hay inventario disponible para reservar la diferencia.",
    };
  }

  // =====================================================
  // Elegir una ubicación si puede cubrir todo.
  // Si no, acumular varias.
  // =====================================================
  const potentialResult = buildLinesToAddFromRealAvailableLines(
    availableResult.lines,
    diffQty
  );

  console.log("📍 POTENCIALES PARA AGREGAR:", potentialResult.lines);
  console.log("📍 Cantidad seleccionada:", potentialResult.totalSelectedQty);
  console.log("📍 Faltante:", potentialResult.remainingQty);

  if (potentialResult.lines.length === 0) {
    await updateStockMoveReservedQtyAndState(client, moveId, coveredQty);

    return {
      reserved: 0,
      createdQty: 0,
      skipped: true,
      case: "ORDER_INCREASED_NO_STOCK",
      missingQty: diffQty,
      message:
        "La orden aumentó, pero no hay inventario disponible para reservar la diferencia.",
    };
  }

  // =====================================================
  // Crear o aumentar stock_move_line
  // SIN tocar inventory_by_location.qty_reserved
  // =====================================================

  const addedQty = await createOrIncreaseMoveLinesWithoutInventoryReservation(
    client,
    {
      move,
      stockMove,
      potentialLines: potentialResult.lines,
      openReservedLines,
    }
  );

  const finalCoveredQty = coveredQty + addedQty;

  await updateStockMoveReservedQtyAndState(client, moveId, finalCoveredQty);

  return {
    reserved: 0,
    createdQty: addedQty,
    skipped: false,
    case:
      potentialResult.remainingQty > 0
        ? "ORDER_INCREASED_PARTIAL"
        : "ORDER_INCREASED",
    missingQty: potentialResult.remainingQty,
    message:
      potentialResult.remainingQty > 0
        ? "La orden aumentó. Se agregaron líneas parciales sin tocar qty_reserved."
        : "La orden aumentó. Se agregaron líneas adicionales sin tocar qty_reserved.",
  };
}
// 🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩

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






console.log("OPEN RESERVED LINES:", openReservedLines);
console.log("requiredQty:", requiredQty);
console.log("qtyToRelease:", qtyToRelease);

const required = Number(requiredQty);

// Ordenar de mayor a menor para intentar encontrar una sola línea primero
const sortedLines = [...openReservedLines].sort(
  (a, b) => Number(b.product_uom_qty) - Number(a.product_uom_qty)
);

let selectedLines = [];

// ----------------------------------------------------
// 1. Buscar una línea que cubra toda la cantidad
// ----------------------------------------------------
const singleLine = sortedLines.find(
  line => Number(line.product_uom_qty) >= required
);

if (singleLine) {
  selectedLines.push({
    id: singleLine.id,
    qty: required
  });
} else {

  // ----------------------------------------------------
  // 2. Acumular líneas hasta completar requiredQty
  // ----------------------------------------------------
  let accumulated = 0;

  for (const line of sortedLines) {

    if (accumulated >= required) break;

    const available = Number(line.product_uom_qty);

    const qtyForThisLine = Math.min(
      available,
      required - accumulated
    );

    selectedLines.push({
      id: line.id,
      qty: qtyForThisLine
    });

    accumulated += qtyForThisLine;
  }
}

console.log("SELECTED LINES:", selectedLines);

// ----------------------------------------------------
// 3. Actualizar líneas elegidas
// ----------------------------------------------------
for (const selected of selectedLines) {
console.log("🟩🟩 SELECTED ID AND QTY", selected.id, selected.qty);
  const result = await client.query(`
    UPDATE stock_move_line
    SET product_uom_qty = $1
    WHERE id = $2
    RETURNING id, product_uom_qty
`, [
    selected.qty,
    selected.id
]);

console.log("UPDATE RESULT:", result.rows);
}

const verify = await client.query(`
SELECT id, product_uom_qty
FROM stock_move_line
WHERE move_id = $1
ORDER BY id
`, [moveId]);

console.log("AFTER UPDATE:", verify.rows);


// ----------------------------------------------------
// 4. Cancelar líneas no elegidas
// ----------------------------------------------------
const selectedIds = selectedLines.map(l => l.id);

const linesToCancel = openReservedLines.filter(
    line => !selectedIds.includes(line.id)
);

console.log("LINES TO CANCEL:", linesToCancel);

for (const line of linesToCancel) {

    console.log("❌❌❌❌ LINEAS QUE SE VAN A CANCELAR: ", line);
await client.query(`
    UPDATE stock_move_line
    SET
        state = 'cancel'
    WHERE id = $1
`, [line.id]);
}











    return {
      released: qtyToRelease,
      skipped: false,
      case: "ORDER_DECREASED",
      message: "La orden bajó. Se liberó la reserva sobrante.",
    };
  }
}

//🟩🟩 CASO 1: Servicio para buscar ubicaciones reales disponibles
export async function availableLocationsForMoveId(
  client,
  moveId,
  existingMoveLines = []
) {
  if (!moveId) {
    throw new Error("Debe enviar moveId para buscar ubicaciones disponibles");
  }

  console.log("🔎 Buscando ubicaciones disponibles para moveId:", moveId);

  // =====================================================
  // 1. Buscar stock_move
  // =====================================================
  const moveResult = await client.query(
    `
    SELECT
      sm.id AS move_id,
      sm.product_id,
      sm.product_qty,
      sm.product_uom_id,
      sm.picking_id,
      p.sku
    FROM stock_move sm
    JOIN products p ON p.id = sm.product_id
    WHERE sm.id = $1
    LIMIT 1
    `,
    [moveId]
  );

  if (moveResult.rows.length === 0) {
    throw new Error(`No se encontró stock_move con id ${moveId}`);
  }

  const stockMove = moveResult.rows[0];

  if (!stockMove.sku) {
    throw new Error(
      `El producto ${stockMove.product_id} no tiene SKU asociado`
    );
  }

  console.log("📦 Producto del move:", {
    moveId,
    productId: stockMove.product_id,
    sku: stockMove.sku,
  });

  // =====================================================
  // 2. Buscar inventario en ubicaciones STORABLE
  // =====================================================
  const inventoryResult = await client.query(
    `
    SELECT
      ibl.location_id,
      ibl.warehouse_id,
      ibl.qty_on_hand,
      ibl.qty_reserved,
      ibl.qty_available,
      l.code AS location_code,
      l.location_type
    FROM inventory_by_location ibl
    JOIN locations l ON l.id = ibl.location_id
    WHERE ibl.product_sku = $1
      AND l.location_type = 'STORAGE'
      AND l.is_active = true
      AND COALESCE(ibl.qty_available, 0) > 0
    ORDER BY
      COALESCE(l.tramo, 0) DESC,
      COALESCE(l.nivel, 0) ASC,
      ibl.location_id ASC
    `,
    [stockMove.sku]
  );

  const inventoryLines = inventoryResult.rows;

  console.log("📍 Inventario STORABLE encontrado:", inventoryLines);

  if (inventoryLines.length === 0) {
    return {
      move: stockMove,
      lines: [],
      totalPotentialQty: 0,
    };
  }

  // =====================================================
  // 3. Calcular cuánto ya consume este move por ubicación
  // =====================================================
  const usedByLocation = new Map();

  for (const line of existingMoveLines) {
    if (line.state === "cancel") continue;
    if (!line.location_id) continue;

    const locationId = Number(line.location_id);

    const qtyDone = Number(line.qty_done || 0);
    const productUomQty = Number(line.product_uom_qty || 0);

    const usedQty = qtyDone > 0 ? qtyDone : productUomQty;

    if (usedQty <= 0) continue;

    const previous = usedByLocation.get(locationId) || 0;
    usedByLocation.set(locationId, previous + usedQty);
  }

  console.log(
    "🧮 Cantidad ya usada por este move en stock_move_line:",
    Object.fromEntries(usedByLocation)
  );

  // =====================================================
  // 4. Restar lo ya usado a la disponibilidad de inventario
  // =====================================================
  const realAvailableLines = inventoryLines
    .map(line => {
      const locationId = Number(line.location_id);

      const inventoryQty = Number(line.qty_available || 0);
      const alreadyUsedInMove = Number(usedByLocation.get(locationId) || 0);

      const realAvailableQty = inventoryQty - alreadyUsedInMove;

      return {
        location_id: locationId,
        warehouse_id: Number(line.warehouse_id || 1),
        location_code: line.location_code,
        quantity: realAvailableQty > 0 ? realAvailableQty : 0,
        inventory_qty_available: inventoryQty,
        already_used_in_move: alreadyUsedInMove,
      };
    })
    .filter(line => Number(line.quantity) > 0);

  const totalPotentialQty = realAvailableLines.reduce(
    (sum, line) => sum + Number(line.quantity || 0),
    0
  );

  console.log("✅ RealAvailableLines:", realAvailableLines);
  console.log("✅ Total real disponible:", totalPotentialQty);

  return {
    move: stockMove,
    lines: realAvailableLines,
    totalPotentialQty,
  };
}

//🟩🟩 CASO 1: 2. Servicio para elegir líneas hasta cubrir diffQty
 export function buildLinesToAddFromRealAvailableLines(
  realAvailableLines,
  diffQty
) {
  const requiredToAdd = Number(diffQty || 0);

  if (requiredToAdd <= 0) {
    return {
      lines: [],
      totalSelectedQty: 0,
      remainingQty: 0,
    };
  }

  const cleanLines = (realAvailableLines || [])
    .map(line => ({
      ...line,
      quantity: Number(line.quantity || 0),
    }))
    .filter(line => line.quantity > 0);

  if (cleanLines.length === 0) {
    return {
      lines: [],
      totalSelectedQty: 0,
      remainingQty: requiredToAdd,
    };
  }

  // =====================================================
  // 1. Intentar cubrir todo con una sola ubicación
  // =====================================================
  const singleLine = cleanLines.find(
    line => Number(line.quantity) >= requiredToAdd
  );

  if (singleLine) {
    return {
      lines: [
        {
          location_id: Number(singleLine.location_id),
          warehouse_id: Number(singleLine.warehouse_id || 1),
          quantity: requiredToAdd,
        },
      ],
      totalSelectedQty: requiredToAdd,
      remainingQty: 0,
    };
  }

  // =====================================================
  // 2. Si ninguna sola cubre, acumular varias
  // =====================================================
  const selectedLines = [];
  let accumulated = 0;

  for (const line of cleanLines) {
    if (accumulated >= requiredToAdd) break;

    const available = Number(line.quantity || 0);
    const qtyToTake = Math.min(available, requiredToAdd - accumulated);

    if (qtyToTake <= 0) continue;

    selectedLines.push({
      location_id: Number(line.location_id),
      warehouse_id: Number(line.warehouse_id || 1),
      quantity: qtyToTake,
    });

    accumulated += qtyToTake;
  }

  return {
    lines: selectedLines,
    totalSelectedQty: accumulated,
    remainingQty: requiredToAdd - accumulated,
  };
}

//🟩🟩 CASO 1: 3. Servicio para crear o aumentar stock_move_line
export async function createOrIncreaseMoveLinesWithoutInventoryReservation(
  client,
  {
    move,
    stockMove,
    potentialLines,
    openReservedLines,
  }
) {
  let totalAdded = 0;

  for (const line of potentialLines) {
    const qtyToAdd = Number(line.quantity || 0);

    if (qtyToAdd <= 0) continue;

    const locationId = Number(line.location_id);
    const warehouseId = Number(line.warehouse_id || line.almacen || 1);

    // Buscar si ya existe una línea abierta para esa ubicación
    const existingLine = openReservedLines.find(existing =>
      Number(existing.location_id) === locationId &&
      Number(existing.qty_done || 0) === 0 &&
      existing.state !== "cancel"
    );

    if (existingLine) {
      const result = await client.query(
        `
        UPDATE stock_move_line
        SET product_uom_qty = COALESCE(product_uom_qty, 0) + $1
        WHERE id = $2
        RETURNING id, location_id, product_uom_qty
        `,
        [
          qtyToAdd,
          existingLine.id,
        ]
      );

      console.log("🟢 stock_move_line aumentada SIN tocar inventory_by_location:", {
        id: result.rows[0]?.id,
        location_id: result.rows[0]?.location_id,
        nueva_cantidad: result.rows[0]?.product_uom_qty,
        qty_agregada: qtyToAdd,
      });
    } else {
      const result = await client.query(
        `
        INSERT INTO stock_move_line (
          move_id,
          picking_id,
          product_id,
          product_uom_id,
          warehouse_id,
          location_id,
          product_uom_qty,
          qty_done,
          state
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,0,'assigned')
        RETURNING id, location_id, product_uom_qty
        `,
        [
          Number(stockMove.move_id),
          Number(move.picking_id),
          Number(move.product_id),
          Number(stockMove.move_product_uom_id),
          warehouseId,
          locationId,
          qtyToAdd,
        ]
      );

      console.log("✅ stock_move_line creada SIN tocar inventory_by_location:", {
        id: result.rows[0]?.id,
        move_id: stockMove.move_id,
        product_id: move.product_id,
        location_id: locationId,
        qty: qtyToAdd,
      });
    }

    totalAdded += qtyToAdd;
  }

  return totalAdded;
}

async function releaseExtraReservedQty(client, {
  openReservedLines,
  qtyToRelease,
  updateInventory = false,
}) {
  let remainingToRelease = Number(qtyToRelease || 0);
  let releasedQty = 0;

  console.log("🟠 ---- releaseExtraReservedQty ----");
  console.log("🟠 qtyToRelease:", qtyToRelease);
  console.log("🟠 updateInventory:", updateInventory);

  for (const line of openReservedLines) {
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

    // ✅ NO tocar inventory_by_location si updateInventory viene false
    if (updateInventory === true) {
      await releaseReservationFromInventory(client, line, qtyFromThisLine);
    } else {
      console.log("🟡 Se omite inventory_by_location. No se reduce qty_reserved.");
    }

    // Si se libera toda la línea, cancelar la línea
    if (qtyFromThisLine === lineQty) {
      await client.query(
        `
        UPDATE stock_move_line
        SET state = 'cancel',
            product_uom_qty = 0
        WHERE id = $1
        `,
        [line.id]
      );

      console.log("✅ stock_move_line cancelada:", line.id);
    } else {
      // Si solo se libera parte, reducir product_uom_qty
      await client.query(
        `
        UPDATE stock_move_line
        SET product_uom_qty = product_uom_qty - $1
        WHERE id = $2
        `,
        [qtyFromThisLine, line.id]
      );

      console.log("✅ stock_move_line reducida:", {
        lineId: line.id,
        qtyFromThisLine,
      });
    }

    releasedQty += qtyFromThisLine;
    remainingToRelease -= qtyFromThisLine;
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

async function createPotentialMoveLinesWithoutInventoryReservation(client, {
  move,
  stockMove,
  potentialLines,
}) {
  let totalCreated = 0;

  for (const line of potentialLines) {
    const qtyToCreate = Number(line.quantity || line.quantity_taken || 0);

    if (qtyToCreate <= 0) continue;

    await client.query(
      `
      INSERT INTO stock_move_line (
        move_id,
        picking_id,
        product_id,
        product_uom_id,
        warehouse_id,
        location_id,
        product_uom_qty,
        qty_done,
        state
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,0,'assigned')
      `,
      [
        Number(stockMove.move_id),
        Number(move.picking_id),
        Number(move.product_id),
        Number(stockMove.move_product_uom_id),
        Number(line.almacen || 1),
        Number(line.location_id),
        qtyToCreate,
      ]
    );

    totalCreated += qtyToCreate;

    console.log("✅ stock_move_line creada SIN tocar inventory_by_location:", {
      move_id: stockMove.move_id,
      product_id: move.product_id,
      location_id: line.location_id,
      qty: qtyToCreate,
    });
  }

  return totalCreated;
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




