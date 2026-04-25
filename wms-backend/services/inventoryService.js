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

  if (qty > qty_promised) {
    throw {
      code: "QTY_GT_PROMISED",
      message: "No puedes mover más de lo comprometido"
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

    console.log("VALORES: ", warehouseId, productSku, fromLocationId, toLocationId, qty);
    console.log("SE INICIA EL MOVIMIENTO DE INVENTARIO");
    // 1️⃣ Buscar inventario origen
    const fromResult = await client.query(`
    SELECT id, qty_on_hand, qty_reserved, qty_available
    FROM inventory_by_location
    WHERE warehouse_id = $1
      AND product_sku = $2
      AND location_id = $3
    FOR UPDATE
  `, [warehouseId, productSku, fromLocationId]);

    if (fromResult.rowCount === 0) {
        throw {
            code: "ORIGIN_NOT_FOUND",
            message: "No existe inventario en la ubicación de origen"
        };
    }
    console.log("INVENTARIO ORIGEN: ", fromResult.rows[0]);
    const fromInv = fromResult.rows[0];

    // 2️⃣ Validar cantidad disponible
    if (qty > Number(fromInv.qty_available)) {
        throw {
            code: "QTY_EXCEEDS_AVAILABLE",
            message: "Cantidad mayor a la disponible en la ubicación de origen"
        };
    }
 
    // 3️⃣ Restar de origen
    await client.query(`
    UPDATE inventory_by_location
    SET qty_on_hand = qty_on_hand - $1,
        updated_at = now()
    WHERE id = $2
  `, [qty, fromInv.id]);


    console.log("SE RESTA LA CANTIDAD DEL ORIGEN");
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
    console.log("SE BUSCA LA UBICACION DE DESTINO", toResult);
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
    console.log("📦 INVENTARIO DESTINO CREADO:", toInvId);
  } else {
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






export async function updateInventoryByCount(client, {
  locationSelected,
  productSelected,
  qty,
  userId = null,
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

  const countedQty = Number(qty);

  if (Number.isNaN(countedQty) || countedQty < 0) {
    return {
      success: false,
      title: "No se pudo guardar conteo",
      message: "La cantidad contada no es válida."
    };
  }

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
    return {
      success: false,
      title: "No se pudo guardar conteo",
      message: "La ubicación que leíste no es correcta."
    };
  }

  const { id: locationId, warehouse_id: warehouseId } = locationResult.rows[0];

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
    return {
      success: false,
      title: "No se pudo guardar conteo",
      message: "El producto no existe o no está activo."
    };
  }

  const { id: productId, sku: productSku } = productResult.rows[0];

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

  if (invResult.rows.length > 0) {
    const row = invResult.rows[0];
    inventoryRowId = row.id;
    oldQtyOnHand = Number(row.qty_on_hand || 0);

    const qtyReserved = Number(row.qty_reserved || 0);

    // 5) Validar reservado > contado
    if (qtyReserved > countedQty) {
      return {
        success: false,
        title: "No se pudo guardar conteo",
        message: "La cantidad reservada es mayor la contada."
      };
    }

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
        updated_at = NOW()
      WHERE id = $2
      `,
      [countedQty, inventoryRowId]
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
        qty_reserved,
        old_qty_on_hand,
        updated_at
      )
      VALUES ($1, $2, $3, $4, 0, 0, NOW())
      RETURNING id
      `,
      [warehouseId, locationId, productSku, countedQty]
    );

    inventoryRowId = insertResult.rows[0].id;
  }

  // 8) Si no hubo diferencia, no crear movimiento
  if (action === "SKIP") {

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
  let fromLocationId = null;
  let toLocationId = null;
  let referenceType = null;

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
