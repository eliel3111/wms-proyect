// services/inventoryService.js
import { db } from "../db.js";




export async function moveInventory(req, res) {
  const {
    productSku,
    fromLocation,
    toLocation,
    qty,
    qty_promised
  } = req.body;

  // 🔴 Validación básica
  if (!productSku || !fromLocation || !toLocation || !qty) {
    return res.status(400).json({
      success: false,
      message: "Faltan campos requeridos"
    });
  }

  const client = await db.connect();

  try {
    const result = await moveInventoryBetweenLocationsV2(client, {
      productSku,
      fromLocation,
      toLocation,
      qty,
      qty_promised
    });

    return res.status(200).json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error("ERROR ENDPOINT:", error);

    return res.status(400).json({
      success: false,
      code: error.code || "UNKNOWN_ERROR",
      message: error.message || "Error moviendo inventario"
    });

  } finally {
    client.release();
  }
}



//Esto mueve una cantidad de una ubicacion a otra donde hay reserva, resta canidad y reserva

export async function moveInventoryBetweenLocationsV2(
  client,
  {
    productSku,
    fromLocation,
    toLocation,
    qty,
    qty_promised
  }
) {

  console.log("🚀 MOVE INVENTORY V2:", {
    productSku,
    fromLocation,
    toLocation,
    qty,
    qty_promised
  });

  // 🔴 VALIDACIONES
  if (Number(fromLocation) === Number(toLocation)) {
    throw {
      code: "SAME_LOCATION",
      message: "Origen y destino no pueden ser iguales"
    };
  }

  if (qty < 0) {
    throw {
      code: "INVALID_QTY",
      message: "Cantidad inválida"
    };
  }

  if (qty_promised < 0) {
    throw {
      code: "INVALID_PROMISED_QTY",
      message: "Cantidad comprometida inválida"
    };
  }

  /*if (qty > qty_promised) {
    throw {
      code: "QTY_GT_PROMISED",
      message: "No puedes mover más de lo comprometido"
    };
  }*/

  // 1️⃣ Obtener warehouses
  const locationsResult = await client.query(`
    SELECT id, warehouse_id
    FROM locations
    WHERE id = ANY($1)
  `, [[Number(fromLocation), Number(toLocation)]]);

  if (locationsResult.rowCount < 2) {
    throw {
      code: "LOCATION_NOT_FOUND",
      message: "Una o ambas ubicaciones no existen"
    };
  }

  const fromLoc = locationsResult.rows.find(l => Number(l.id) === Number(fromLocation));
  const toLoc = locationsResult.rows.find(l => Number(l.id) === Number(toLocation));

  const fromWarehouse = fromLoc.warehouse_id;
  const toWarehouse = toLoc.warehouse_id;

  // 2️⃣ Inventario origen
  const fromResult = await client.query(`
    SELECT id, qty_available, qty_on_hand, qty_reserved
    FROM inventory_by_location
    WHERE warehouse_id = $1
      AND product_sku = $2
      AND location_id = $3
    FOR UPDATE
  `, [fromWarehouse, productSku, Number(fromLocation)]);

  if (fromResult.rowCount === 0) {
    throw {
      code: "NO_STOCK_ORIGIN",
      message: "No hay inventario en la ubicación origen"
    };
  }

  const fromInv = fromResult.rows[0];

  if (qty > Number(fromInv.qty_on_hand)) {
    throw {
      code: "QTY_EXCEEDS_STOCK",
      message: "Cantidad mayor al stock físico"
    };
  }

  console.log(qty_promised);
  console.log(Number(fromInv.qty_reserved));

  if (qty_promised > Number(fromInv.qty_reserved)) {
    throw {
      code: "PROMISED_EXCEEDS_RESERVED",
      message: "Cantidad comprometida mayor a la reservada"
    };
  }

  // 3️⃣ Restar origen
  await client.query(`
    UPDATE inventory_by_location
    SET qty_on_hand = qty_on_hand - $1,
        qty_reserved = qty_reserved - $2,
        updated_at = now()
    WHERE id = $3
  `, [qty, qty_promised, fromInv.id]);

  // 4️⃣ Inventario destino
  const toResult = await client.query(`
    SELECT id
    FROM inventory_by_location
    WHERE warehouse_id = $1
      AND product_sku = $2
      AND location_id = $3
    FOR UPDATE
  `, [toWarehouse, productSku, Number(toLocation)]);

  let toInvId;

  if (toResult.rowCount === 0) {
    const insertResult = await client.query(`
      INSERT INTO inventory_by_location
        (warehouse_id, product_sku, location_id, qty_on_hand, qty_reserved)
      VALUES
        ($1, $2, $3, 0, 0)
      RETURNING id
    `, [toWarehouse, productSku, Number(toLocation)]);

    toInvId = insertResult.rows[0].id;
  } else {
    toInvId = toResult.rows[0].id;
  }

  // 5️⃣ Sumar destino
  await client.query(`
    UPDATE inventory_by_location
    SET qty_on_hand = qty_on_hand + $1,
        updated_at = now()
    WHERE id = $2
  `, [qty, toInvId]);

  return { success: true };
}


export async function moveInventoryGeneralLocation(
  client,
  {
    productSku,
    fromLocation,
    toLocation,
    qty,
    qty_promised
  }
) {

  console.log("🚀 MOVE INVENTORY FROM GENERAL LOCATION:", {
    productSku,
    fromLocation,
    toLocation,
    qty,
    qty_promised
  });

  // 🔴 VALIDACIONES
  if (Number(fromLocation) === Number(toLocation)) {
    throw {
      code: "SAME_LOCATION",
      message: "Origen y destino no pueden ser iguales"
    };
  }

  if (qty < 0) {
    throw {
      code: "INVALID_QTY",
      message: "Cantidad inválida"
    };
  }

  if (qty_promised < 0) {
    throw {
      code: "INVALID_PROMISED_QTY",
      message: "Cantidad comprometida inválida"
    };
  }

  // 1️⃣ Obtener warehouses
  const locationsResult = await client.query(`
    SELECT id, warehouse_id
    FROM locations
    WHERE id = ANY($1)
  `, [[Number(fromLocation), Number(toLocation)]]);

  if (locationsResult.rowCount < 2) {
    throw {
      code: "LOCATION_NOT_FOUND",
      message: "Una o ambas ubicaciones no existen"
    };
  }

  const fromLoc = locationsResult.rows.find(
    l => Number(l.id) === Number(fromLocation)
  );

  const toLoc = locationsResult.rows.find(
    l => Number(l.id) === Number(toLocation)
  );

  const fromWarehouse = fromLoc.warehouse_id;
  const toWarehouse = toLoc.warehouse_id;

  // 2️⃣ Inventario origen
  const fromResult = await client.query(`
  SELECT
    id,
    qty_available,
    qty_on_hand,
    qty_reserved
  FROM inventory_by_location
  WHERE warehouse_id = $1
    AND product_sku = $2
    AND location_id = $3
  FOR UPDATE
`, [
    fromWarehouse,
    productSku,
    Number(fromLocation)
  ]);

  // 3️⃣ Descontar origen SOLO SI EXISTE Y TIENE STOCK
  if (fromResult.rowCount > 0) {

    const fromInv = fromResult.rows[0];

    const currentOnHand =
      Number(fromInv.qty_on_hand || 0);

    const currentReserved =
      Number(fromInv.qty_reserved || 0);

    if (currentOnHand > 0) {

      const qtyToSubtract = Math.min(
        Number(qty),
        currentOnHand
      );

      const reservedToSubtract = Math.min(
        Number(qty_promised),
        currentReserved
      );

      await client.query(`
      UPDATE inventory_by_location
      SET
        qty_on_hand = qty_on_hand - $1,
        qty_reserved = qty_reserved - $2,
        updated_at = now()
      WHERE id = $3
    `, [
        qtyToSubtract,
        reservedToSubtract,
        fromInv.id
      ]);

      console.log("✅ INVENTARIO DESCONTADO DEL ORIGEN:", {
        qtyToSubtract,
        reservedToSubtract,
        fromInvId: fromInv.id
      });

    } else {

      console.log(
        "⚠️ El origen existe pero no tiene stock. No se descuenta nada."
      );
    }

  } else {

    console.log(
      "⚠️ No existe inventario en origen. No se descuenta nada."
    );
  }

  // 4️⃣ Buscar inventario destino
  const toResult = await client.query(`
  SELECT id
  FROM inventory_by_location
  WHERE warehouse_id = $1
    AND product_sku = $2
    AND location_id = $3
  FOR UPDATE
`, [
    toWarehouse,
    productSku,
    Number(toLocation)
  ]);

  let toInvId;

  // 5️⃣ Crear destino si no existe
  if (toResult.rowCount === 0) {

    console.log("➕ CREANDO INVENTARIO DESTINO");

    const insertResult = await client.query(`
    INSERT INTO inventory_by_location (
      warehouse_id,
      product_sku,
      location_id,
      qty_on_hand,
      qty_reserved
    )
    VALUES (
      $1,
      $2,
      $3,
      0,
      0
    )
    RETURNING id
  `, [
      toWarehouse,
      productSku,
      Number(toLocation)
    ]);

    toInvId = insertResult.rows[0].id;

  } else {

    toInvId = toResult.rows[0].id;
  }

  // 6️⃣ Siempre sumar destino
  await client.query(`
  UPDATE inventory_by_location
  SET
    qty_on_hand = qty_on_hand + $1,
    updated_at = now()
  WHERE id = $2
`, [
    qty,
    toInvId
  ]);

  console.log("✅ INVENTARIO SUMADO EN DESTINO:", {
    qty,
    toInvId
  });

  return {
    success: true
  };
}


/*export async function moveInventoryBetweenLocations(
  client,
  {
    warehouseId,
    productSku,
    fromLocationId,
    toLocationId,
    qty
  }
) {

  console.log("==================================");
  console.log("🚚 MOVE INVENTORY");
  console.log("==================================");

  console.log("VALORES:", {
    warehouseId,
    productSku,
    fromLocationId,
    toLocationId,
    qty
  });

  // 1️⃣ Buscar inventario origen
  const fromResult = await client.query(`
    SELECT id, qty_on_hand, qty_reserved, qty_available
    FROM inventory_by_location
    WHERE warehouse_id = $1
      AND product_sku = $2
      AND location_id = $3
    FOR UPDATE
  `, [warehouseId, productSku, fromLocationId]);

  console.log("✅ QUERY INVENTARIO ORIGEN COMPLETADO");
  console.log("📦 RESULT:", fromResult.rows);


  if (fromResult.rowCount === 0) {
    throw {
      code: "ORIGIN_NOT_FOUND",
      message: "No existe inventario en la ubicación de origen"
    };
  }

  const fromInv = fromResult.rows[0];

  console.log("📦 INVENTARIO ORIGEN:", fromInv);

  console.log("🔍 VALIDANDO CANTIDAD");
  console.log("REQUESTED:", qty);
  console.log("AVAILABLE:", fromInv.qty_available);

  // 2️⃣ Validar cantidad disponible
  if (qty > Number(fromInv.qty_available)) {
    throw {
      code: "QTY_EXCEEDS_AVAILABLE",
      message: "Cantidad mayor a la disponible en la ubicación de origen"
    };
  }

  const updateOrigin = await client.query(`
        UPDATE inventory_by_location
        SET qty_on_hand = qty_on_hand - $1,
            updated_at = now()
        WHERE id = $2
        RETURNING *
    `, [qty, fromInv.id]);

  console.log("✅ UPDATE ORIGEN COMPLETADO");
  console.log(updateOrigin.rows[0]);



  // 4️⃣ Buscar inventario destino
  console.log(warehouseId);
  console.log(productSku);
  console.log(toLocationId);
  const toResult = await client.query(`
    SELECT id
    FROM inventory_by_location
    WHERE warehouse_id = $1
      AND product_sku = $2
      AND location_id = $3
    FOR UPDATE
  `, [warehouseId, productSku, Number(toLocationId)]);
  console.log("✅ BUSQUEDA DESTINO COMPLETADA");
  console.log(toResult.rows);
  let toInvId;

  try {
    if (toResult.rowCount === 0) {
      const insertResult = await client.query(`
      INSERT INTO inventory_by_location
        (warehouse_id, product_sku, location_id, qty_on_hand, qty_reserved)
      VALUES
        ($1, $2, $3, 0, 0)
      RETURNING id
    `, [warehouseId, productSku, Number(toLocationId)]);

      toInvId = insertResult.rows[0].id;
      console.log("✅ INVENTARIO DESTINO CREADO");
      console.log(insertResult.rows[0]);
      console.log("📦 INVENTARIO DESTINO CREADO:", toInvId);
    } else {
      console.log("✅ INVENTARIO DESTINO EXISTE");
      toInvId = toResult.rows[0].id;

    }
  } catch (err) {
    console.error("🔥 ERROR CREANDO INVENTARIO DESTINO:", err);
    throw err;
  }

  console.log("CANTIDAD", qty)
  console.log("ID", toInvId)
  // 5️⃣ Sumar en destino
  await client.query(`
    UPDATE inventory_by_location
    SET qty_on_hand = qty_on_hand + $1,
        updated_at = now()
    WHERE id = $2
    `, [qty, toInvId]);

  console.log("SE PONE LA CANTIDAD A LA UBICACION DE DESTINO");
  return {
    success: true
  };
}*/


export async function moveInventoryBetweenLocations(
  client,
  {
    warehouseId,
    productSku,
    fromLocationId,
    toLocationId,
    qty
  }
) {

  console.log("====================================");
  console.log("🚚 MOVE INVENTORY BETWEEN LOCATIONS");
  console.log("====================================");

  console.log("📥 PARAMETROS:");
  console.log({
    warehouseId,
    productSku,
    fromLocationId,
    toLocationId,
    qty
  });

  try {

    // =====================================================
    // 1️⃣ BUSCAR INVENTARIO ORIGEN
    // =====================================================

    console.log("🔍 PASO 1 - BUSCANDO INVENTARIO ORIGEN");

    const fromResult = await client.query(`
            SELECT
                id,
                qty_on_hand,
                qty_reserved,
                qty_available
            FROM inventory_by_location
            WHERE warehouse_id = $1
              AND product_sku = $2
              AND location_id = $3
            FOR UPDATE
        `, [warehouseId, productSku, fromLocationId]);

    console.log("✅ PASO 1 COMPLETADO");

    console.log("📦 INVENTARIO ORIGEN ENCONTRADO:");
    console.log(fromResult.rows);

    if (fromResult.rowCount === 0) {
      throw {
        code: "ORIGIN_NOT_FOUND",
        message: "No existe inventario en la ubicación de origen"
      };
    }

    const fromInv = fromResult.rows[0];

    console.log("📦 FROM INVENTORY:");
    console.log(fromInv);

    // =====================================================
    // 2️⃣ VALIDAR DISPONIBLE
    // =====================================================

    console.log("🔍 PASO 2 - VALIDANDO DISPONIBLE");

    console.log("REQUESTED:", qty);
    console.log("AVAILABLE:", fromInv.qty_available);

    if (Number(qty) > Number(fromInv.qty_available)) {
      throw {
        code: "QTY_EXCEEDS_AVAILABLE",
        message: "Cantidad mayor a la disponible en la ubicación de origen"
      };
    }

    console.log("✅ PASO 2 COMPLETADO");

    // =====================================================
    // 3️⃣ RESTAR ORIGEN
    // =====================================================

    console.log("🔍 PASO 3 - UPDATE ORIGEN");

    const updateOriginResult = await client.query(`
            UPDATE inventory_by_location
            SET qty_on_hand = qty_on_hand - $1,
                updated_at = now()
            WHERE id = $2
            RETURNING *
        `, [qty, fromInv.id]);

    console.log("✅ PASO 3 COMPLETADO");

    console.log("📦 INVENTARIO ORIGEN ACTUALIZADO:");
    console.log(updateOriginResult.rows[0]);

    // =====================================================
    // 4️⃣ BUSCAR DESTINO
    // =====================================================

    console.log("🔍 PASO 4 - BUSCANDO DESTINO");

    const toResult = await client.query(`
            SELECT id
            FROM inventory_by_location
            WHERE warehouse_id = $1
              AND product_sku = $2
              AND location_id = $3
            FOR UPDATE
        `, [warehouseId, productSku, Number(toLocationId)]);

    console.log("✅ PASO 4 COMPLETADO");

    console.log("📦 DESTINO:");
    console.log(toResult.rows);

    let toInvId;

    // =====================================================
    // 5️⃣ CREAR DESTINO SI NO EXISTE
    // =====================================================

    if (toResult.rowCount === 0) {

      console.log("🔍 PASO 5 - CREANDO DESTINO");

      const insertResult = await client.query(`
                INSERT INTO inventory_by_location
                (
                    warehouse_id,
                    product_sku,
                    location_id,
                    qty_on_hand,
                    qty_reserved
                )
                VALUES
                (
                    $1,
                    $2,
                    $3,
                    0,
                    0
                )
                RETURNING *
            `, [warehouseId, productSku, Number(toLocationId)]);

      console.log("✅ PASO 5 COMPLETADO");

      console.log("📦 DESTINO CREADO:");
      console.log(insertResult.rows[0]);

      toInvId = insertResult.rows[0].id;

    } else {

      console.log("✅ DESTINO YA EXISTE");

      toInvId = toResult.rows[0].id;
    }

    console.log("📦 DESTINATION ID:", toInvId);

    // =====================================================
    // 6️⃣ SUMAR DESTINO
    // =====================================================

    console.log("🔍 PASO 6 - UPDATE DESTINO");

    const updateDestinationResult = await client.query(`
            UPDATE inventory_by_location
            SET qty_on_hand = qty_on_hand + $1,
                updated_at = now()
            WHERE id = $2
            RETURNING *
        `, [qty, toInvId]);

    console.log("✅ PASO 6 COMPLETADO");

    console.log("📦 DESTINO ACTUALIZADO:");
    console.log(updateDestinationResult.rows[0]);

    console.log("🎉 MOVIMIENTO COMPLETADO");

    return {
      success: true
    };

  } catch (err) {

    console.log("====================================");
    console.log("🔥 ERROR MOVE INVENTORY");
    console.log("====================================");

    console.log("ERROR:");
    console.log(err);

    console.log("MESSAGE:");
    console.log(err.message);

    console.log("CODE:");
    console.log(err.code);

    console.log("DETAIL:");
    console.log(err.detail);

    console.log("HINT:");
    console.log(err.hint);

    console.log("STACK:");
    console.log(err.stack);

    throw err;
  }
}


// SERVICIO: Crea un movimiendo, no afecta inventario, solo dice el movimiento, de donde a donde, y porque

// services/inventoryMovementService.js

export async function createInventoryMovement(client, {
  productSku,
  fromLocationId = null,
  toLocationId = null,
  qty,
  movementType,        // 'MOVE', 'RECEIPT', etc
  referenceType = null, // 'PUTAWAY', 'PICKING', etc
  referenceId = null,   // session id, order id, etc
  createdBy = null,
  note = null
}) {
  return client.query(
    `
    INSERT INTO inventory_movements
      (product_sku, from_location_id, to_location_id, qty, movement_type, reference_type, reference_id, created_by, note)
    VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    RETURNING *
    `,
    [
      productSku,
      fromLocationId,
      toLocationId,
      qty,
      movementType,
      referenceType,
      referenceId,
      createdBy,
      note
    ]
  );
}


export async function saveInventoryByCount(
  client,
  {
    locationSelected,
    productSelected,
    qty,
    userId,
    referenceId = null,
    note = "Ajuste por conteo físico",
  }
) {
  console.log("🟦 saveInventoryByCount INICIADO");

  //PENDIENTE POR ACTUALIZAR 🟧🟧🟧🟧🟧🟧
  // =====================================
  // VALIDAR SESIÓN DE INVENTARIO ACTIVA
  // Solo se puede leer/contar si hay una sola sesión
  // y está en estado in-progress
  // =====================================

  console.log("🔍 VALIDANDO SESIÓN DE INVENTARIO");

  const sessionResult = await client.query(`
  SELECT
    id,
    code,
    status
  FROM inventory_sessions
  WHERE status IN ('draft', 'in-progress')
  ORDER BY created_at ASC
`);

  console.log("📋 SESIONES ABIERTAS ENCONTRADAS:", sessionResult.rows.length);

  if (sessionResult.rows.length === 0) {
    console.log("❌ No hay sesión de inventario abierta");

    return res.status(200).json({
      success: false,
      title: "No hay sesión de inventario",
      message: "Debe crear e iniciar una sesión de inventario antes de leer productos.",
    });
  }

  if (sessionResult.rows.length > 1) {
    console.log("❌ Hay más de una sesión abierta:", sessionResult.rows);

    return res.status(200).json({
      success: false,
      title: "Más de una sesión abierta",
      message: "Solo puede haber una sesión de inventario en draft o in-progress.",
    });
  }

  const activeSession = sessionResult.rows[0];

  console.log("📦 SESIÓN ENCONTRADA:", {
    id: activeSession.id,
    code: activeSession.code,
    status: activeSession.status,
  });

  if (activeSession.status === "draft") {
    console.log("⚠️ La sesión está en draft. Debe iniciarse antes de contar.");

    return res.status(200).json({
      success: false,
      title: "Sesión no iniciada",
      message: "Debe iniciar la sesión de inventario antes de leer productos.",
    });
  }

  if (activeSession.status !== "in-progress") {
    console.log("❌ Estado de sesión inválido:", activeSession.status);

    return res.status(200).json({
      success: false,
      title: "Sesión inválida",
      message: "Solo puede leer productos cuando la sesión está en progreso.",
    });
  }

  console.log("✅ Todo bien. La sesión está en progreso:", activeSession.code);
  //PENDIENTE POR ACTUALIZAR 🟧🟧🟧🟧🟧🟧

  // 1) Validar los 3 datos obligatorios
  if (!locationSelected || !productSelected || qty == null) {
    console.log("❌ Datos incompletos:", {
      locationSelected,
      productSelected,
      qty,
    });

    return {
      success: false,
      title: "Datos incompletos",
      message: "Debe enviar ubicación, producto y cantidad.",
    };
  }

  console.log("1️⃣ UBICACIÓN LEÍDA:", locationSelected);
  console.log("2️⃣ PRODUCTO LEÍDO:", productSelected);
  console.log("3️⃣ CANTIDAD RECIBIDA:", qty);

  const countedQty = Number(qty);

  if (Number.isNaN(countedQty) || countedQty < 0) {
    console.log("❌ Cantidad inválida:", qty);

    return {
      success: false,
      title: "Cantidad inválida",
      message: "La cantidad contada no es válida.",
    };
  }

  // 2) Validar ubicación
  const locationResult = await client.query(
    `
    SELECT id, warehouse_id
    FROM locations
    WHERE id = $1
      AND is_active = true
    LIMIT 1
    `,
    [locationSelected]
  );

  if (locationResult.rows.length === 0) {
    console.log("❌ Ubicación inválida:", locationSelected);

    return {
      success: false,
      title: "Ubicación inválida",
      message: "La ubicación que leíste no existe o no está activa.",
    };
  }

  const locationId = locationResult.rows[0].id;
  const warehouseId = locationResult.rows[0].warehouse_id;

  console.log("✅ Ubicación confirmada:", {
    locationId,
    warehouseId,
  });

  // 3) Validar producto
  const productResult = await client.query(
    `
    SELECT id, sku
    FROM products
    WHERE id = $1
      AND status = 'ACTIVE'
      AND deleted_erp = false
    LIMIT 1
    `,
    [productSelected]
  );

  if (productResult.rows.length === 0) {
    console.log("❌ Producto inválido:", productSelected);

    return {
      success: false,
      title: "Producto inválido",
      message: "El producto no existe, no está activo o fue eliminado del ERP.",
    };
  }

  const productId = productResult.rows[0].id;
  const productSku = productResult.rows[0].sku;

  console.log("✅ Producto confirmado:", {
    productId,
    productSku,
  });

  // 4) Buscar línea actual con LOCK
  const invResult = await client.query(
    `
    SELECT id, qty_on_hand, qty_reserved, inventory_quantity
    FROM inventory_by_location
    WHERE location_id = $1
      AND product_sku = $2
    FOR UPDATE
    `,
    [locationId, productSku]
  );

  let inventoryRowId = null;
  let oldQtyOnHand = 0;
  let previousInventoryQuantity = null;
  let action = "SKIP";
  let difference = 0;
  let wasCreated = false;

  // 5) Si existe, actualizar SOLO inventory_quantity
  if (invResult.rows.length > 0) {
    const row = invResult.rows[0];

    inventoryRowId = row.id;
    oldQtyOnHand = Number(row.qty_on_hand || 0);
    previousInventoryQuantity =
      row.inventory_quantity == null
        ? null
        : Number(row.inventory_quantity);

    difference = countedQty - oldQtyOnHand;

    if (difference > 0) action = "GAIN";
    if (difference < 0) action = "LOSS";
    if (difference === 0) action = "SKIP";

    console.log("✅ Línea existente encontrada:", {
      inventoryRowId,
      oldQtyOnHand,
      previousInventoryQuantity,
      countedQty,
      difference,
      action,
    });

    await client.query(
      `
      UPDATE inventory_by_location
      SET
        inventory_quantity = $1,
        counted_by = $2,
        counted_at = NOW(),
        updated_at = NOW()
      WHERE id = $3
      `,
      [countedQty, userId, inventoryRowId]
    );
  } else {
    // 6) Si no existe, crear línea nueva
    oldQtyOnHand = 0;
    previousInventoryQuantity = null;
    difference = countedQty;
    action = countedQty > 0 ? "GAIN" : "SKIP";
    wasCreated = true;

    console.log("🟨 No existía línea. Creando nueva línea:", {
      warehouseId,
      locationId,
      productSku,
      countedQty,
      userId,
    });

    const insertResult = await client.query(
      `
      INSERT INTO inventory_by_location (
        warehouse_id,
        location_id,
        product_sku,
        qty_on_hand,
        inventory_quantity,
        qty_reserved,
        old_qty_on_hand,
        counted_by,
        counted_at,
        updated_at
      )
      VALUES ($1, $2, $3, 0.00, $4, 0.00, 0.00, $5, NOW(), NOW())
      RETURNING id
      `,
      [warehouseId, locationId, productSku, countedQty, userId]
    );

    inventoryRowId = insertResult.rows[0].id;
  }

  console.log("✅ Conteo guardado correctamente:", {
    inventoryRowId,
    productSku,
    locationId,
    countedQty,
  });

  return {
    success: true,
    title: "Conteo guardado",
    message: "El conteo fue guardado correctamente.",
    data: {
      inventoryRowId,
      productId,
      productSku,
      locationId,
      warehouseId,
      countedQty,
      previousInventoryQuantity,
      oldQtyOnHand,
      difference,
      action,
      wasCreated,
    },
  };
}


export async function updateInventoryByCount(client, {
  locationSelected,
  productSelected,
  qty,
  userId,
  referenceId = null,
  note = "Ajuste por conteo físico"
}) {
  // 1) Validar datos básicos
  if (!locationSelected || !productSelected || qty == null) {
    return {
      success: false,
      title: "No se pudo guardar conteo",
      message: "Debe enviar ubicación, producto y cantidad."
    };
  }

  console.log("1️⃣  UBICACION LEIDA: ", locationSelected);
  console.log("2️⃣  PRODUCTO LEIDA: ", productSelected);


  const countedQty = Number(qty);

  if (Number.isNaN(countedQty) || countedQty < 0) {
    console.log("❌ La cantidad contada no es válida.");
    return {
      success: false,
      title: "No se pudo guardar conteo",
      message: "La cantidad contada no es válida."
    };
  }

  console.log("3️⃣  CANTIDAD CONTADA: ", countedQty);

  // 2) Validar ubicación y obtener warehouse_id
  const locationResult = await client.query(
    `
    SELECT id, warehouse_id
    FROM locations
    WHERE id = $1
    LIMIT 1
    `,
    [locationSelected]
  );

  if (locationResult.rows.length === 0) {
    console.log("❌ La ubicación que leíste no es correcta.");
    return {
      success: false,
      title: "No se pudo guardar conteo",
      message: "La ubicación que leíste no es correcta."
    };
  }

  const { id: locationId, warehouse_id: warehouseId } = locationResult.rows[0];

  console.log("✅ Ubicacion fue confirmada: ", locationId);

  // 3) Validar producto
  const productResult = await client.query(
    `
    SELECT id, sku
    FROM products
    WHERE id = $1
      AND status = 'ACTIVE'
      AND deleted_erp = false
    LIMIT 1
    `,
    [productSelected]
  );

  if (productResult.rows.length === 0) {
    console.log("❌ El producto no existe o no está activo.");
    return {
      success: false,
      title: "No se pudo guardar conteo",
      message: "El producto no existe o no está activo."
    };
  }

  const { id: productId, sku: productSku } = productResult.rows[0];

  console.log("✅ PRODUCTO fue confirmado: ", productSku, "ID: ", productId);

  // 4) Buscar línea actual con lock
  const invResult = await client.query(
    `
    SELECT id, qty_on_hand, qty_reserved
    FROM inventory_by_location
    WHERE location_id = $1
      AND product_sku = $2
    FOR UPDATE
    `,
    [locationId, productSku]
  );

  let action = "SKIP";
  let difference = 0;
  let oldQtyOnHand = 0;
  let inventoryRowId = null;
  let fromLocationId = null;
  let toLocationId = null;
  let referenceType = null;

  if (invResult.rows.length > 0) {
    const row = invResult.rows[0];
    console.log("✅ linea de inventario para ese producto y ubicacion: ", row);
    inventoryRowId = row.id;
    oldQtyOnHand = Number(row.qty_on_hand || 0);

    const qtyReserved = Number(row.qty_reserved || 0);

    // 5) Validar reservado > contado
    /*if (qtyReserved > countedQty) {
      console.log("❌ El producto no existe o no está activo.");
      return {
        success: false,
        title: "No se pudo guardar conteo",
        message: "La cantidad reservada es mayor la contada."
      };
    }*/

    difference = countedQty - oldQtyOnHand;

    if (difference < 0) action = "LOSS";
    else if (difference > 0) action = "GAIN";
    else action = "SKIP";

    // 6) Actualizar línea
    await client.query(
      `
  UPDATE inventory_by_location
  SET
    old_qty_on_hand = qty_on_hand,
    qty_on_hand = $1,
    inventory_quantity = $1,
    counted_by = $2,
    counted_at = NOW(),
    updated_at = NOW()
  WHERE id = $3
  `,
      [countedQty, userId, inventoryRowId]
    );
  } else {
    // 7) No existe línea: crearla
    difference = countedQty;
    oldQtyOnHand = 0;
    action = countedQty > 0 ? "GAIN" : "SKIP";

    const insertResult = await client.query(
      `
  INSERT INTO inventory_by_location (
    warehouse_id,
    location_id,
    product_sku,
    qty_on_hand,
    inventory_quantity,
    qty_reserved,
    old_qty_on_hand,
    counted_by,      -- 🔥 agregada
    counted_at,      -- 🔥 recomendado también
    updated_at
  )
  VALUES ($1, $2, $3, $4, $4, 0, 0, $5, NOW(), NOW())
  RETURNING id
  `,
      [warehouseId, locationId, productSku, countedQty, userId]
    );

    inventoryRowId = insertResult.rows[0].id;
  }

  // 8) Si no hubo diferencia, no crear movimiento
  if (action === "SKIP") {
    return {
      success: true,
      title: "Conteo guardado",
      message: "No hubo diferencia de inventario.",
      data: {
        action,
        difference,
        productId,
        productSku,
        locationId,
        warehouseId,
        inventoryRowId,
        oldQtyOnHand,
        newQtyOnHand: countedQty
      }
    };
  }

  // 9) Crear / obtener ubicación virtual


  if (action === "LOSS") {
    const lossResult = await client.query(
      `
      INSERT INTO locations (
        warehouse_id,
        code,
        description,
        is_active,
        location_type
      )
      VALUES ($1, $2, $3, true, $4)
      ON CONFLICT (warehouse_id, code)
DO UPDATE SET code = EXCLUDED.code
      RETURNING id
      `,
      [
        warehouseId,
        "INV-LOSS",
        "Ubicación virtual para pérdidas de inventario",
        "VIRTUAL_LOSS"
      ]
    );

    const lossLocationId = lossResult.rows[0].id;

    fromLocationId = locationId;
    toLocationId = lossLocationId;
    referenceType = "INV-LOSS";
  }

  if (action === "GAIN") {
    const gainResult = await client.query(
      `
      INSERT INTO locations (
        warehouse_id,
        code,
        description,
        is_active,
        location_type
      )
      VALUES ($1, $2, $3, true, $4)
      ON CONFLICT (warehouse_id, code)
DO UPDATE SET code = EXCLUDED.code
      RETURNING id
      `,
      [
        warehouseId,
        "INV-GAIN",
        "Ubicación virtual para ganancias de inventario",
        "VIRTUAL_GAIN"
      ]
    );

    const gainLocationId = gainResult.rows[0].id;

    fromLocationId = gainLocationId;
    toLocationId = locationId;
    referenceType = "INV-GAIN";
  }

  // 10) Crear movimiento
  await createInventoryMovement(client, {
    productSku,
    fromLocationId,
    toLocationId,
    qty: Math.abs(difference),
    movementType: "INVENTORY",
    referenceType,
    referenceId,
    createdBy: userId,
    note
  });

  return {
    success: true,
    title: "Conteo guardado",
    message: "El conteo fue aplicado correctamente.",
    data: {
      action,
      difference,
      productId,
      productSku,
      locationId,
      warehouseId,
      inventoryRowId,
      oldQtyOnHand,
      newQtyOnHand: countedQty
    }
  };
}




//un servicio más pequeño que reserve exactamente la cantidad pendiente que acabas de crear en la nueva stock_move_line.
export async function reserveMoveLineQuantity(
  client,
  line,
  qtyToReserve
) {

  console.log("================================");
  console.log("🚀 RESERVE MOVE LINE QUANTITY");
  console.log("LINE:", line);
  console.log("QTY TO RESERVE:", qtyToReserve);
  console.log("================================");

  const result = await client.query(`
    UPDATE inventory_by_location
    SET qty_reserved =
        qty_reserved + LEAST(qty_available, $1)
    WHERE product_sku = $2
      AND warehouse_id = $3
      AND location_id = $4
      AND qty_available > 0
    RETURNING
      qty_on_hand,
      qty_reserved,
      qty_available
  `, [
    qtyToReserve,
    line.sku,
    line.warehouse_id,
    line.location_id
  ]);

  console.log("📦 RESULTADO RESERVA:");
  console.log(result.rows);

  if (result.rowCount === 0) {
    throw {
      code: "RESERVE_ERROR",
      message: "No fue posible reservar inventario"
    };
  }

  return result.rows[0];
}
