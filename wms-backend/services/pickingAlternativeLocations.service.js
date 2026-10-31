// =====================================================
// ADM CLOUD - PICKING CON UBICACIONES ALTERNATIVAS
// =====================================================

const EPS = 0.000001;

function serviceError(statusCode, title, message, code) {
  return Object.assign(new Error(message), {
    statusCode,
    title,
    code,
  });
}

function toQty(value) {
  const result = Number(value);

  if (
    !Number.isFinite(result) ||
    result < 0 ||
    Math.round(result * 10000) / 10000 !== result
  ) {
    throw serviceError(
      400,
      "Cantidad inválida",
      "La cantidad debe ser positiva o cero y tener máximo cuatro decimales.",
      "INVALID_QTY"
    );
  }

  return result;
}

// =====================================================
// ACTUALIZAR UBICACIONES Y MÁXIMOS DEL PRODUCTO
// =====================================================

export async function refreshPickingLocationSnapshots(
  client,
  pickingId
) {
  await client.query(
    `
    UPDATE stock_move_line AS sml
    SET
      available_locations = COALESCE(
        (
          SELECT jsonb_agg(
            jsonb_build_object(
              'location_id', ibl.location_id,
              'warehouse_id', ibl.warehouse_id,
              'code', l.code,
              'qty_on_hand', ibl.qty_on_hand,
              'qty_available', ibl.qty_available
            )
            ORDER BY ibl.qty_on_hand DESC, l.code
          )
          FROM products AS p
          JOIN inventory_by_location AS ibl
            ON ibl.product_sku = p.sku
          JOIN locations AS l
            ON l.id = ibl.location_id
           AND l.warehouse_id = ibl.warehouse_id
          WHERE p.id = sml.product_id
            AND ibl.qty_on_hand > 0
            AND l.is_active = TRUE
            AND l.location_type IN ('STORAGE', 'RECEIVING')
            AND UPPER(l.code) NOT LIKE 'GENERAL-%'
        ),
        '[]'::jsonb
      ),

      max_product_qty = (
        SELECT COALESCE(
          SUM(GREATEST(COALESCE(dsm.pending_qty, 0), 0)),
          0
        )
        FROM despacho_stock_move AS dsm
        WHERE dsm.picking_id = sml.picking_id
          AND dsm.product_id = sml.product_id
          AND COALESCE(dsm.state, '') NOT IN ('done', 'cancel')
      )

    WHERE sml.picking_id = $1
      AND COALESCE(sml.state, '') NOT IN ('done', 'cancel')
    `,
    [pickingId]
  );
}

// =====================================================
// REDUCIR CANTIDADES PENDIENTES DE LA RUTA
// =====================================================

async function consumeRouteCapacity(
  client,
  { pickingId, moveId, productId, preferredLineId, qty }
) {
  let remaining = qty;

  const result = await client.query(
    `
    SELECT
      id,
      product_uom_qty,
      qty_done
    FROM stock_move_line
    WHERE picking_id = $1
      AND move_id = $2
      AND product_id = $3
      AND is_general = FALSE
      AND state NOT IN ('done', 'cancel')
    ORDER BY
      CASE WHEN id = $4 THEN 0 ELSE 1 END,
      id ASC
    FOR UPDATE
    `,
    [
      pickingId,
      moveId,
      productId,
      preferredLineId || 0,
    ]
  );

  for (const line of result.rows) {
    if (remaining <= EPS) break;

    const available = Math.max(
      Number(line.product_uom_qty) -
        Number(line.qty_done),
      0
    );

    const taken = Math.min(available, remaining);

    if (taken <= EPS) continue;

    await client.query(
      `
      UPDATE stock_move_line
      SET
        product_uom_qty = product_uom_qty - $1,
        write_date = NOW()
      WHERE id = $2
      `,
      [taken, line.id]
    );

    remaining -= taken;
  }

  if (remaining > EPS) {
    throw serviceError(
      409,
      "Cantidad pendiente insuficiente",
      `No hay suficiente cantidad pendiente en las líneas de la ruta. Faltan ${remaining.toFixed(4)} unidades.`,
      "INSUFFICIENT_ROUTE_QTY"
    );
  }
}

// =====================================================
// DEVOLVER CANTIDAD A LA RUTA AL REDUCIR UNA LÍNEA GENERAL
// =====================================================

async function restoreRouteCapacity(
  client,
  { pickingId, moveId, productId, sourceLineId, qty }
) {
  if (!sourceLineId || qty <= EPS) return;

  const result = await client.query(
    `
    SELECT id
    FROM stock_move_line
    WHERE id = $1
      AND picking_id = $2
      AND move_id = $3
      AND product_id = $4
      AND is_general = FALSE
      AND state NOT IN ('done', 'cancel')
    FOR UPDATE
    `,
    [sourceLineId, pickingId, moveId, productId]
  );

  if (!result.rowCount) {
    throw serviceError(
      409,
      "Línea de origen no disponible",
      "No se puede devolver la cantidad porque la línea de origen ya no está activa.",
      "SOURCE_LINE_NOT_AVAILABLE"
    );
  }

  await client.query(
    `
    UPDATE stock_move_line
    SET
      product_uom_qty = product_uom_qty + $1,
      write_date = NOW()
    WHERE id = $2
    `,
    [qty, sourceLineId]
  );
}

// =====================================================
// VALIDAR INVENTARIO FÍSICO
// =====================================================

async function validatePhysicalInventory(
  client,
  {
    location,
    productSku,
    additionalQty,
    allowVirtualGeneral = false,
  }
) {
  if (additionalQty <= EPS) return;

  if (
    allowVirtualGeneral &&
    String(location.code || "")
      .toUpperCase()
      .startsWith("GENERAL-")
  ) {
    return;
  }

  const inventoryResult = await client.query(
    `
    SELECT qty_on_hand
    FROM inventory_by_location
    WHERE warehouse_id = $1
      AND location_id = $2
      AND product_sku = $3
    FOR UPDATE
    `,
    [
      location.warehouse_id,
      location.id,
      productSku,
    ]
  );

  const qtyOnHand = Number(
    inventoryResult.rows[0]?.qty_on_hand || 0
  );

  if (qtyOnHand <= 0) {
    throw serviceError(
      409,
      "Ubicación sin inventario",
      `La ubicación ${location.code} no tiene inventario del producto ${productSku}.`,
      "LOCATION_WITHOUT_INVENTORY"
    );
  }

  // Otras cantidades ya confirmadas, pero todavía
  // no descontadas por el cierre del picking.
  const pickedResult = await client.query(
    `
    SELECT COALESCE(SUM(sml.qty_done), 0) AS qty
    FROM stock_move_line AS sml
    JOIN products AS p
      ON p.id = sml.product_id
    WHERE sml.location_id = $1
      AND sml.warehouse_id = $2
      AND p.sku = $3
      AND sml.state NOT IN ('done', 'cancel')
    `,
    [
      location.id,
      location.warehouse_id,
      productSku,
    ]
  );

  const alreadyPicked = Number(
    pickedResult.rows[0].qty
  );

  if (alreadyPicked + additionalQty > qtyOnHand + EPS) {
    throw serviceError(
      409,
      "Inventario insuficiente",
      `En ${location.code} hay ${qtyOnHand} unidades físicas y ${alreadyPicked} ya están confirmadas en pickings activos. No puedes agregar ${additionalQty}.`,
      "INSUFFICIENT_LOCATION_STOCK"
    );
  }
}

// =====================================================
// ACTUALIZAR O CREAR LÍNEA GENERAL
// =====================================================

async function saveGeneralLine(
  client,
  {
    source,
    pickingId,
    move,
    productId,
    location,
    qty,
    originLineId,
  }
) {
  const existing = await client.query(
    `
    SELECT id
    FROM stock_move_line
    WHERE picking_id = $1
      AND move_id = $2
      AND product_id = $3
      AND location_id = $4
      AND warehouse_id = $5
      AND is_general = TRUE
      AND state NOT IN ('done', 'cancel')
      AND id <> $6
    ORDER BY id ASC
    LIMIT 1
    FOR UPDATE
    `,
    [
      pickingId,
      move.id,
      productId,
      location.id,
      location.warehouse_id,
      source?.id || 0,
    ]
  );

  if (existing.rowCount) {
    const updated = await client.query(
      `
      UPDATE stock_move_line
      SET
        product_uom_qty = product_uom_qty + $1,
        qty_done = qty_done + $1,
        write_date = NOW()
      WHERE id = $2
      RETURNING *
      `,
      [qty, existing.rows[0].id]
    );

    return updated.rows[0];
  }

  const inserted = await client.query(
    `
    INSERT INTO stock_move_line (
      move_id,
      picking_id,
      product_id,
      product_uom_id,
      product_uom_qty,
      qty_done,
      location_id,
      warehouse_id,
      location_dest_id,
      state,
      user_id,
      is_general,
      source_move_line_id
    )
    VALUES (
      $1, $2, $3, $4, $5, $5,
      $6, $7, $8, 'assigned',
      $9, TRUE, $10
    )
    RETURNING *
    `,
    [
      move.id,
      pickingId,
      productId,
      source?.product_uom_id || move.product_uom_id,
      qty,
      location.id,
      location.warehouse_id,
      source?.location_dest_id || null,
      source?.user_id || null,
      originLineId || null,
    ]
  );

  return inserted.rows[0];
}

// =====================================================
// CONFIRMAR RECOGIDA
// =====================================================

export async function confirmPickingWithAlternateLocation(
  client,
  payload
) {
  const {
    id,
    pickingId: receivedPickingId,
    locationId,
    productId,
  } = payload;

  const qty = toQty(payload.qty);

  if (
    !Number.isSafeInteger(Number(locationId)) ||
    Number(locationId) <= 0 ||
    !Number.isSafeInteger(Number(productId)) ||
    Number(productId) <= 0
  ) {
    throw serviceError(
      400,
      "Datos inválidos",
      "locationId y productId deben ser identificadores válidos.",
      "INVALID_IDS"
    );
  }

  // Obtener el picking antes de bloquearlo.
  const hint = id
    ? await client.query(
        `SELECT picking_id FROM stock_move_line WHERE id = $1`,
        [id]
      )
    : { rows: [] };

  const pickingId =
    hint.rows[0]?.picking_id || receivedPickingId;

  if (!pickingId) {
    throw serviceError(
      400,
      "Picking requerido",
      "Debes enviar pickingId cuando no exista una línea de origen.",
      "MISSING_PICKING_ID"
    );
  }

  // Serializar las confirmaciones del mismo picking.
  const pickingLock = await client.query(
    `
    SELECT id
    FROM stock_picking
    WHERE id = $1
      AND state NOT IN ('done', 'cancel')
    FOR UPDATE
    `,
    [pickingId]
  );

  if (!pickingLock.rowCount) {
    throw serviceError(
      409,
      "Picking no disponible",
      "El picking no existe o ya está cerrado.",
      "PICKING_NOT_ACTIVE"
    );
  }

  // Buscar la línea original, si existe.
  const sourceResult = id
    ? await client.query(
        `
        SELECT sml.*, p.sku
        FROM stock_move_line AS sml
        JOIN products AS p
          ON p.id = sml.product_id
        WHERE sml.id = $1
          AND sml.picking_id = $2
          AND sml.product_id = $3
          AND sml.state NOT IN ('done', 'cancel')
        FOR UPDATE OF sml
        `,
        [id, pickingId, productId]
      )
    : { rows: [] };

  const source = sourceResult.rows[0] || null;

  if (id && !source) {
    throw serviceError(
      404,
      "Línea no encontrada",
      "La línea original no existe o ya no está activa.",
      "SOURCE_NOT_FOUND"
    );
  }

  const locationResult = await client.query(
    `
    SELECT
      id,
      code,
      warehouse_id,
      location_type
    FROM locations
    WHERE id = $1
      AND is_active = TRUE
    FOR SHARE
    `,
    [locationId]
  );

  const location = locationResult.rows[0];

  if (!location) {
    throw serviceError(
      404,
      "Ubicación inválida",
      "La ubicación escaneada no existe o está inactiva.",
      "INVALID_LOCATION"
    );
  }

  const productResult = await client.query(
    `
    SELECT id, sku
    FROM products
    WHERE id = $1
    `,
    [productId]
  );

  const product = productResult.rows[0];

  if (!product) {
    throw serviceError(
      404,
      "Producto no encontrado",
      "El producto seleccionado no existe.",
      "PRODUCT_NOT_FOUND"
    );
  }

  // Movimiento ERP asociado a la línea.
  const movesResult = await client.query(
    `
    SELECT
      dsm.id,
      dsm.product_uom_id,
      dsm.pending_qty,
      COALESCE(
        (
          SELECT SUM(sml.product_uom_qty)
          FROM stock_move_line AS sml
          WHERE sml.move_id = dsm.id
            AND sml.state NOT IN ('done', 'cancel')
        ),
        0
      ) AS planned_qty
    FROM despacho_stock_move AS dsm
    WHERE dsm.picking_id = $1
      AND dsm.product_id = $2
      AND dsm.state NOT IN ('done', 'cancel')
      AND ($3::bigint IS NULL OR dsm.id = $3)
    ORDER BY dsm.id ASC
    FOR UPDATE OF dsm
    `,
    [
      pickingId,
      productId,
      source?.move_id || null,
    ]
  );

  let move;

  if (source) {
    move = movesResult.rows[0];
  } else {
    // Si id es NULL, elegir un movimiento que aún
    // tenga cantidad sin asignar a ninguna línea.
    move = movesResult.rows.find(
      (row) =>
        Number(row.pending_qty) -
          Number(row.planned_qty) >=
        qty - EPS
    );
  }

  if (!move) {
    throw serviceError(
      409,
      "Sin cantidad pendiente",
      "No existe un movimiento de despacho con cantidad disponible para esta recogida.",
      "NO_AVAILABLE_DISPATCH_MOVE"
    );
  }

  const isManual = source?.is_general === true;

  const sameLocation = Boolean(
    source &&
      Number(source.location_id) === Number(location.id) &&
      Number(source.warehouse_id) ===
        Number(location.warehouse_id)
  );

  const oldDone = Number(source?.qty_done || 0);

  // Para líneas normales en otra ubicación: qty
  // representa unidades nuevas recogidas.
  //
  // Para una línea general: qty representa su
  // nueva cantidad TOTAL (modo edición).
  const delta = isManual
    ? qty - oldDone
    : sameLocation
      ? qty - oldDone
      : qty;

  // Cantidad máxima pendiente del producto y move.
  const limits = await client.query(
    `
    SELECT
      COALESCE(
        SUM(GREATEST(COALESCE(pending_qty, 0), 0)),
        0
      ) AS max_qty
    FROM despacho_stock_move
    WHERE picking_id = $1
      AND product_id = $2
      AND state NOT IN ('done', 'cancel')
    `,
    [pickingId, productId]
  );

  const maxProductQty = Number(
    limits.rows[0].max_qty
  );

  const doneResult = await client.query(
    `
    SELECT
      COALESCE(SUM(qty_done), 0) AS total_done,
      COALESCE(
        SUM(qty_done) FILTER (WHERE move_id = $3),
        0
      ) AS move_done
    FROM stock_move_line
    WHERE picking_id = $1
      AND product_id = $2
      AND state NOT IN ('done', 'cancel')
    `,
    [pickingId, productId, move.id]
  );

  const totalDone = Number(
    doneResult.rows[0].total_done
  );

  const moveDone = Number(
    doneResult.rows[0].move_done
  );

  if (totalDone + delta > maxProductQty + EPS) {
    throw serviceError(
      409,
      "Cantidad máxima excedida",
      `El despacho permite ${maxProductQty} unidades del producto ${product.sku}. Ya hay ${totalDone} confirmadas y este cambio agregaría ${delta}.`,
      "PRODUCT_LIMIT_EXCEEDED"
    );
  }

  if (
    moveDone + delta >
    Number(move.pending_qty) + EPS
  ) {
    throw serviceError(
      409,
      "Movimiento excedido",
      "La cantidad supera lo pendiente en este movimiento del ERP.",
      "MOVE_LIMIT_EXCEEDED"
    );
  }

  // -------------------------------------------------
  // A. MISMA UBICACIÓN DE UNA LÍNEA NORMAL
  // -------------------------------------------------

  if (source && !isManual && sameLocation) {
    if (
      qty >
      Number(source.product_uom_qty) + EPS
    ) {
      throw serviceError(
        409,
        "Cantidad excedida",
        "Esta línea no permite más unidades. Utiliza una ubicación alternativa para redistribuir.",
        "LINE_LIMIT_EXCEEDED"
      );
    }

    await validatePhysicalInventory(client, {
      location,
      productSku: product.sku,
      additionalQty: delta,
      allowVirtualGeneral: true,
    });

    const updated = await client.query(
      `
      UPDATE stock_move_line
      SET
        qty_done = $1,
        write_date = NOW()
      WHERE id = $2
      RETURNING *
      `,
      [qty, source.id]
    );

    await refreshPickingLocationSnapshots(
      client,
      pickingId
    );

    return {
      success: true,
      title: "Cantidad registrada",
      message: "La línea de la ruta fue actualizada.",
      line: updated.rows[0],
    };
  }

  // -------------------------------------------------
  // B. RECOGIDA EN UBICACIÓN ALTERNATIVA
  // -------------------------------------------------

  if (
    qty > EPS &&
    !['STORAGE', 'RECEIVING'].includes(
      location.location_type
    )
  ) {
    throw serviceError(
      409,
      "Ubicación no permitida",
      "Las recogidas alternativas solo pueden realizarse desde STORAGE o RECEIVING.",
      "INVALID_ALTERNATIVE_LOCATION"
    );
  }

  // Si es general y está siendo editada en la
  // misma ubicación, solo importa el incremento.
  // Si cambia de ubicación, se valida toda la
  // nueva cantidad en la ubicación destino.
  const additionalPhysicalQty =
    isManual && sameLocation
      ? delta
      : qty;

  await validatePhysicalInventory(client, {
    location,
    productSku: product.sku,
    additionalQty: additionalPhysicalQty,
  });

  if (source && !isManual) {
    // Consumir cantidad pendiente de las líneas
    // normales del mismo movimiento.
    await consumeRouteCapacity(client, {
      pickingId,
      moveId: move.id,
      productId,
      preferredLineId: source.id,
      qty,
    });
  }

  if (isManual && delta > EPS) {
    await consumeRouteCapacity(client, {
      pickingId,
      moveId: move.id,
      productId,
      preferredLineId:
        source.source_move_line_id,
      qty: delta,
    });
  }

  if (isManual && delta < -EPS) {
    await restoreRouteCapacity(client, {
      pickingId,
      moveId: move.id,
      productId,
      sourceLineId:
        source.source_move_line_id,
      qty: Math.abs(delta),
    });
  }

  let savedLine;

  if (isManual && sameLocation) {
    const updated = await client.query(
      `
      UPDATE stock_move_line
      SET
        product_uom_qty = $1,
        qty_done = $1,
        state = CASE
          WHEN $1 = 0 THEN 'cancel'
          ELSE 'assigned'
        END,
        write_date = NOW()
      WHERE id = $2
      RETURNING *
      `,
      [qty, source.id]
    );

    savedLine = updated.rows[0];
  } else {
    // Si movemos una línea general existente,
    // retiramos su cantidad anterior de esa
    // ubicación, conservando el total del move.
    if (isManual) {
      await client.query(
        `
        UPDATE stock_move_line
        SET
          product_uom_qty = 0,
          qty_done = 0,
          state = 'cancel',
          write_date = NOW()
        WHERE id = $1
        `,
        [source.id]
      );
    }

    if (qty > EPS) {
      savedLine = await saveGeneralLine(client, {
        source,
        pickingId,
        move,
        productId,
        location,
        qty,
        originLineId:
          isManual
            ? source.source_move_line_id
            : source?.id || null,
      });
    }
  }

  await refreshPickingLocationSnapshots(
    client,
    pickingId
  );

  return {
    success: true,
    title: "Recogida registrada",
    message:
      "La cantidad fue registrada en la ubicación seleccionada.",
    is_general: true,
    line: savedLine || null,
  };
}