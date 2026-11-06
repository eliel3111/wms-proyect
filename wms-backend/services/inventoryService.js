// services/inventoryService.js
import { db } from "../db.js";



// Service to obtain the current stock of an array of SKUs
export async function getInventoryLocationsBySkus(
  db,
  skus = []
) {
  try {
    if (
      !Array.isArray(skus) ||
      skus.length === 0
    ) {
      return new Map();
    }

    const uniqueSkus = [
      ...new Set(
        skus
          .map((sku) =>
            String(sku).trim()
          )
          .filter(Boolean)
      ),
    ];

    if (uniqueSkus.length === 0) {
      return new Map();
    }

    const result =
      await db.query(
        `
          SELECT
            ibl.product_sku,
            ibl.location_id,

            SUM(
              COALESCE(
                ibl.qty_on_hand,
                0
              )
            ) AS qty_on_hand,

            l.id,
            l.code,
            l.warehouse_id,
            l.is_active,
            l.location_type,
            l.tramo,
            l.nivel

          FROM public.inventory_by_location AS ibl

          INNER JOIN public.locations AS l
            ON l.id = ibl.location_id
           AND l.warehouse_id =
               ibl.warehouse_id

          WHERE ibl.product_sku =
                ANY($1::text[])

            -- No incluir inventario ubicado
            -- en áreas de despacho.
            AND l.location_type
                IS DISTINCT FROM
                'SHIPPING'

            -- No incluir ubicaciones virtuales GENERAL.
            AND UPPER(
              COALESCE(
                l.code,
                ''
              )
            ) NOT LIKE 'GENERAL-%'

          GROUP BY
            ibl.product_sku,
            ibl.location_id,
            l.id,
            l.code,
            l.warehouse_id,
            l.is_active,
            l.location_type,
            l.tramo,
            l.nivel

          ORDER BY
            ibl.product_sku ASC,
            l.warehouse_id ASC,
            l.tramo ASC NULLS LAST,
            l.nivel ASC NULLS LAST,
            ibl.location_id ASC
        `,
        [
          uniqueSkus
        ]
      );

    const inventoryMap =
      new Map();

    // Crear una entrada incluso para los productos
    // que no tengan inventario disponible.
    for (const sku of uniqueSkus) {
      inventoryMap.set(
        sku,
        {
          total_qty_on_hand: 0,
          locations: [],
        }
      );
    }

    for (const row of result.rows) {
      const sku =
        row.product_sku;

      const qty =
        Number(
          row.qty_on_hand || 0
        );

      const productInventory =
        inventoryMap.get(sku);

      if (!productInventory) {
        continue;
      }

      productInventory.total_qty_on_hand +=
        qty;

      productInventory.locations.push({
        location_id:
          row.location_id,

        location_code:
          row.code,

        location_type:
          row.location_type,

        qty_on_hand:
          qty,

        warehouse_id:
          row.warehouse_id,

        is_active:
          row.is_active,

        tramo:
          row.tramo,

        nivel:
          row.nivel,
      });
    }

    return inventoryMap;
  } catch (error) {
    console.error(
      "❌ ERROR OBTENIENDO INVENTARIO POR SKU:",
      {
        message:
          error.message,

        code:
          error.code,

        detail:
          error.detail,

        constraint:
          error.constraint,
      }
    );

    throw error;
  }
}



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
    warehouseId, // 🟨 temporal, para compatibilidad
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
    // 0️⃣ VALIDAR DATOS
    // =====================================================

    const parsedQty = Number(qty);
    const parsedFromLocationId = Number(fromLocationId);
    const parsedToLocationId = Number(toLocationId);

    if (
      !productSku ||
      !Number.isInteger(parsedFromLocationId) ||
      parsedFromLocationId <= 0 ||
      !Number.isInteger(parsedToLocationId) ||
      parsedToLocationId <= 0 ||
      !Number.isFinite(parsedQty) ||
      parsedQty <= 0
    ) {
      throw {
        code: "INVALID_MOVE_DATA",
        message: "Los datos del movimiento no son válidos"
      };
    }

    if (
      parsedFromLocationId ===
      parsedToLocationId
    ) {
      throw {
        code: "SAME_LOCATION",
        message:
          "La ubicación de origen y destino no pueden ser iguales"
      };
    }


    // =====================================================
    // 1️⃣ BUSCAR WAREHOUSE REAL DE LAS LOCATIONS
    // =====================================================

    console.log(
      "🔍 BUSCANDO WAREHOUSE REAL DE ORIGEN Y DESTINO"
    );

    const locationsResult = await client.query(
      `
      SELECT
        id,
        warehouse_id,
        code,
        location_type,
        is_active

      FROM locations

      WHERE id = ANY($1::int[])

      FOR SHARE
      `,
      [
        [
          parsedFromLocationId,
          parsedToLocationId
        ]
      ]
    );

    if (locationsResult.rowCount !== 2) {
      throw {
        code: "LOCATION_NOT_FOUND",
        message:
          "No se encontró la ubicación de origen o destino"
      };
    }

    const fromLocation =
      locationsResult.rows.find(
        row =>
          Number(row.id) ===
          parsedFromLocationId
      );

    const toLocation =
      locationsResult.rows.find(
        row =>
          Number(row.id) ===
          parsedToLocationId
      );

    if (!fromLocation || !toLocation) {
      throw {
        code: "LOCATION_NOT_FOUND",
        message:
          "No se pudo identificar la ubicación de origen o destino"
      };
    }

    if (
      fromLocation.is_active !== true ||
      toLocation.is_active !== true
    ) {
      throw {
        code: "LOCATION_INACTIVE",
        message:
          "La ubicación de origen o destino está inactiva"
      };
    }

    const fromWarehouseId =
      Number(fromLocation.warehouse_id);

    const toWarehouseId =
      Number(toLocation.warehouse_id);


    console.log("🏬 WAREHOUSE ORIGEN:", {
      locationId: parsedFromLocationId,
      locationCode: fromLocation.code,
      warehouseId: fromWarehouseId
    });

    console.log("🏬 WAREHOUSE DESTINO:", {
      locationId: parsedToLocationId,
      locationCode: toLocation.code,
      warehouseId: toWarehouseId
    });


    // =====================================================
    // 🟨 VALIDAR warehouseId RECIBIDO
    // SOLO PARA DETECTAR ERRORES ANTIGUOS
    // =====================================================

    if (
      warehouseId != null &&
      Number(warehouseId) !== fromWarehouseId
    ) {
      console.log(
        "⚠️ WARNING:",
        "warehouseId recibido no coincide con el warehouse real del origen",
        {
          warehouseIdReceived:
            Number(warehouseId),

          actualFromWarehouseId:
            fromWarehouseId
        }
      );
    }


    // =====================================================
    // 2️⃣ BUSCAR INVENTARIO ORIGEN
    // =====================================================

    console.log(
      "🔍 PASO 2 - BUSCANDO INVENTARIO ORIGEN"
    );

    const fromResult = await client.query(
      `
      SELECT
        id,
        qty_on_hand,
        qty_reserved,
        qty_available

      FROM inventory_by_location

      WHERE
        warehouse_id = $1
        AND product_sku = $2
        AND location_id = $3

      FOR UPDATE
      `,
      [
        fromWarehouseId,
        productSku,
        parsedFromLocationId
      ]
    );


    if (fromResult.rowCount === 0) {
      throw {
        code: "ORIGIN_NOT_FOUND",
        message:
          "No existe inventario en la ubicación de origen"
      };
    }

    const fromInv =
      fromResult.rows[0];


    console.log(
      "📦 INVENTARIO ORIGEN:",
      fromInv
    );


    // =====================================================
    // 3️⃣ VALIDAR DISPONIBLE
    // =====================================================

    if (
      parsedQty >
      Number(fromInv.qty_available)
    ) {
      throw {
        code: "QTY_EXCEEDS_AVAILABLE",
        message:
          "Cantidad mayor a la disponible en la ubicación de origen"
      };
    }


    // =====================================================
    // 4️⃣ RESTAR ORIGEN
    // =====================================================

    const updateOriginResult =
      await client.query(
        `
        UPDATE inventory_by_location

        SET
          qty_on_hand =
            qty_on_hand - $1,

          updated_at =
            NOW()

        WHERE id = $2

        RETURNING *
        `,
        [
          parsedQty,
          fromInv.id
        ]
      );


    console.log(
      "📤 INVENTARIO ORIGEN ACTUALIZADO:",
      updateOriginResult.rows[0]
    );


    // =====================================================
    // 5️⃣ BUSCAR INVENTARIO DESTINO
    // 🔥 AQUÍ USAMOS toWarehouseId
    // =====================================================

    console.log(
      "🔍 PASO 5 - BUSCANDO INVENTARIO DESTINO"
    );

    const toResult = await client.query(
      `
      SELECT
        id,
        qty_on_hand

      FROM inventory_by_location

      WHERE
        warehouse_id = $1
        AND product_sku = $2
        AND location_id = $3

      FOR UPDATE
      `,
      [
        toWarehouseId,
        productSku,
        parsedToLocationId
      ]
    );


    let toInvId;


    // =====================================================
    // 6️⃣ CREAR DESTINO SI NO EXISTE
    // 🔥 TAMBIÉN USAMOS toWarehouseId
    // =====================================================

    if (toResult.rowCount === 0) {

      console.log(
        "➕ CREANDO INVENTARIO DESTINO",
        {
          warehouseId:
            toWarehouseId,

          locationId:
            parsedToLocationId,

          productSku
        }
      );


      const insertResult =
        await client.query(
          `
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
          `,
          [
            toWarehouseId,
            productSku,
            parsedToLocationId
          ]
        );


      toInvId =
        insertResult.rows[0].id;


      console.log(
        "📦 DESTINO CREADO:",
        insertResult.rows[0]
      );

    } else {

      toInvId =
        toResult.rows[0].id;


      console.log(
        "✅ DESTINO YA EXISTE:",
        toResult.rows[0]
      );
    }


    // =====================================================
    // 7️⃣ SUMAR DESTINO
    // =====================================================

    const updateDestinationResult =
      await client.query(
        `
        UPDATE inventory_by_location

        SET
          qty_on_hand =
            qty_on_hand + $1,

          updated_at =
            NOW()

        WHERE id = $2

        RETURNING *
        `,
        [
          parsedQty,
          toInvId
        ]
      );


    console.log(
      "📥 INVENTARIO DESTINO ACTUALIZADO:",
      updateDestinationResult.rows[0]
    );


    // =====================================================
    // 8️⃣ RESULTADO
    // =====================================================

    console.log(
      "🎉 MOVIMIENTO COMPLETADO"
    );

    console.log({
      productSku,

      qty:
        parsedQty,

      from: {
        warehouseId:
          fromWarehouseId,

        locationId:
          parsedFromLocationId
      },

      to: {
        warehouseId:
          toWarehouseId,

        locationId:
          parsedToLocationId
      }
    });


    return {
      success: true,

      productSku,

      qty:
        parsedQty,

      fromWarehouseId,
      toWarehouseId,

      fromLocationId:
        parsedFromLocationId,

      toLocationId:
        parsedToLocationId
    };


  } catch (err) {

    console.log("====================================");
    console.log("🔥 ERROR MOVE INVENTORY");
    console.log("====================================");

    console.log("ERROR:", err);
    console.log("MESSAGE:", err.message);
    console.log("CODE:", err.code);
    console.log("DETAIL:", err.detail);
    console.log("HINT:", err.hint);
    console.log("STACK:", err.stack);

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

  console.log("");
  console.log("🟦 ========================================");
  console.log("📦 saveInventoryByCount INICIADO");
  console.log("🟦 ========================================");

  // ============================================================
  // 1. VALIDAR USUARIO
  // ============================================================

  const countedUserId = Number(userId);

  if (
    !Number.isSafeInteger(countedUserId) ||
    countedUserId <= 0
  ) {

    console.error("❌ USER ID INVÁLIDO:", userId);

    return {
      success: false,
      title: "Usuario inválido",
      message:
        "No se pudo identificar al usuario que realiza el conteo.",
    };
  }

  console.log("👤 USER ID:", countedUserId);

  // ============================================================
  // 2. VALIDAR DATOS OBLIGATORIOS
  // ============================================================

  if (
    locationSelected == null ||
    productSelected == null ||
    qty == null ||
    qty === ""
  ) {

    console.error("❌ DATOS INCOMPLETOS:", {
      locationSelected,
      productSelected,
      qty,
    });

    return {
      success: false,
      title: "Datos incompletos",
      message:
        "Debe enviar ubicación, producto y cantidad.",
    };
  }

  const selectedLocationId =
    Number(locationSelected);

  const selectedProductId =
    Number(productSelected);

  const countedQty =
    Number(qty);

  if (
    !Number.isSafeInteger(selectedLocationId) ||
    selectedLocationId <= 0
  ) {

    return {
      success: false,
      title: "Ubicación inválida",
      message:
        "El identificador de la ubicación no es válido.",
    };
  }

  if (
    !Number.isSafeInteger(selectedProductId) ||
    selectedProductId <= 0
  ) {

    return {
      success: false,
      title: "Producto inválido",
      message:
        "El identificador del producto no es válido.",
    };
  }

  if (
    !Number.isFinite(countedQty) ||
    countedQty < 0
  ) {

    console.error(
      "❌ CANTIDAD INVÁLIDA:",
      qty
    );

    return {
      success: false,
      title: "Cantidad inválida",
      message:
        "La cantidad contada debe ser un número válido mayor o igual a cero.",
    };
  }

  console.log("📍 LOCATION ID:", selectedLocationId);
  console.log("📦 PRODUCT ID:", selectedProductId);
  console.log("🔢 CANTIDAD:", countedQty);

  // ============================================================
  // 3. BUSCAR SESIÓN DE INVENTARIO ACTIVA
  //
  // Se conserva la regla original:
  // Solo puede existir una sesión draft/in-progress.
  //
  // FOR SHARE evita que esta sesión sea modificada
  // mientras se guarda el conteo en la transacción actual.
  // ============================================================

  console.log("");
  console.log("🔍 VALIDANDO SESIÓN DE INVENTARIO");

  const sessionResult = await client.query(
    `
    SELECT
      id,
      code,
      status,
      erp_warehouse_id,
      start_date

    FROM inventory_sessions

    WHERE status IN (
      'draft',
      'in-progress'
    )

    ORDER BY created_at ASC

    LIMIT 2

    FOR SHARE
    `
  );

  console.log(
    "📋 SESIONES ABIERTAS:",
    sessionResult.rows.length
  );

  if (sessionResult.rows.length === 0) {

    console.error(
      "❌ NO EXISTE SESIÓN DE INVENTARIO"
    );

    return {
      success: false,
      title: "No hay sesión de inventario",
      message:
        "Debe crear e iniciar una sesión de inventario antes de contar productos.",
    };
  }

  if (sessionResult.rows.length > 1) {

    console.error(
      "❌ EXISTEN VARIAS SESIONES ABIERTAS"
    );

    return {
      success: false,
      title: "Más de una sesión abierta",
      message:
        "Solo puede existir una sesión de inventario abierta.",
    };
  }

  const activeSession =
    sessionResult.rows[0];

  // ============================================================
  // 4. VALIDAR ESTADO DE LA SESIÓN
  // ============================================================

  if (activeSession.status === "draft") {

    console.warn(
      "⚠️ SESIÓN TODAVÍA EN DRAFT"
    );

    return {
      success: false,
      title: "Sesión no iniciada",
      message:
        "Debe iniciar la sesión de inventario antes de realizar conteos.",
    };
  }

  if (activeSession.status !== "in-progress") {

    return {
      success: false,
      title: "Sesión inválida",
      message:
        "Solo puede contar productos cuando la sesión está en progreso.",
    };
  }

  const sessionId =
    Number(activeSession.id);

  const erpWarehouseId =
    String(
      activeSession.erp_warehouse_id ?? ""
    ).trim().toLowerCase();

  if (
    !Number.isSafeInteger(sessionId) ||
    sessionId <= 0
  ) {

    return {
      success: false,
      title: "Sesión inválida",
      message:
        "La sesión de inventario no tiene un ID válido.",
    };
  }

  if (!erpWarehouseId) {

    console.error(
      "❌ SESIÓN SIN ERP WAREHOUSE ID"
    );

    return {
      success: false,
      title: "Almacén ERP inválido",
      message:
        "La sesión no tiene un almacén ERP configurado.",
    };
  }

  if (!activeSession.start_date) {

    return {
      success: false,
      title: "Sesión sin fecha de inicio",
      message:
        "La sesión no tiene una fecha de inicio válida.",
    };
  }

  console.log(
    "✅ SESIÓN EN PROGRESO:",
    {
      sessionId,
      code: activeSession.code,
      status: activeSession.status,
      erpWarehouseId,
      startDate: activeSession.start_date,
    }
  );

  // ============================================================
  // 5. IDENTIFICAR ALMACÉN WMS DE LA SESIÓN
  //
  // inventory_sessions.erp_warehouse_id = GUID ADM Cloud
  // warehouses.erp_warehouse_id = GUID ADM Cloud
  // warehouses.id = ID interno WMS
  // ============================================================

  console.log("");
  console.log("🏬 IDENTIFICANDO ALMACÉN WMS");

  const warehouseResult = await client.query(
    `
    SELECT
      id,
      code,
      name,
      erp_warehouse_id

    FROM warehouses

    WHERE LOWER(erp_warehouse_id::text) = $1

    ORDER BY id ASC

    LIMIT 2
    `,
    [erpWarehouseId]
  );

  // ============================================================
  // 6. VALIDAR ALMACÉN DE LA SESIÓN
  // ============================================================

  if (warehouseResult.rows.length !== 1) {

    console.error(
      "❌ NO SE IDENTIFICÓ UN ÚNICO ALMACÉN WMS:",
      erpWarehouseId
    );

    return {
      success: false,
      title: "Almacén WMS inválido",
      message:
        "No se pudo identificar un único almacén WMS para esta sesión de inventario.",
    };
  }

  const sessionWarehouse =
    warehouseResult.rows[0];

  const sessionWarehouseId =
    Number(sessionWarehouse.id);

  if (
    !Number.isSafeInteger(sessionWarehouseId) ||
    sessionWarehouseId <= 0
  ) {

    return {
      success: false,
      title: "Almacén inválido",
      message:
        "El almacén WMS de esta sesión no tiene un identificador válido.",
    };
  }

  console.log(
    "✅ ALMACÉN DE LA SESIÓN:",
    {
      sessionId,
      warehouseId: sessionWarehouseId,
      warehouseName: sessionWarehouse.name,
      erpWarehouseId,
    }
  );

  // ============================================================
  // 7. VALIDAR QUE LA UBICACIÓN PERTENEZCA AL ALMACÉN
  //
  // Esta es la protección principal.
  //
  // La ubicación debe:
  // - Existir.
  // - Estar activa.
  // - Pertenecer al almacén de la sesión.
  //
  // No se confía en ningún warehouseId enviado por el frontend.
  // ============================================================

  console.log("");
  console.log("🔍 VALIDANDO UBICACIÓN DE LA SESIÓN");

  const locationResult = await client.query(
    `
    SELECT
      id,
      code,
      warehouse_id

    FROM locations

    WHERE id = $1

      AND warehouse_id = $2

      AND is_active = true

    LIMIT 1
    `,
    [
      selectedLocationId,
      sessionWarehouseId,
    ]
  );

  if (locationResult.rows.length === 0) {

    console.error(
      "❌ UBICACIÓN NO PERMITIDA:",
      {
        locationId: selectedLocationId,
        sessionWarehouseId,
      }
    );

    return {
      success: false,
      title: "Ubicación no permitida",
      message:
        "La ubicación seleccionada no existe, está inactiva o pertenece a otro almacén. Solo puede contar productos en las ubicaciones del almacén de esta sesión.",
    };
  }

  const location =
    locationResult.rows[0];

  const locationId =
    Number(location.id);

  const warehouseId =
    Number(location.warehouse_id);

  console.log(
    "✅ UBICACIÓN VALIDADA:",
    {
      locationId,
      locationCode: location.code,
      warehouseId,
      sessionWarehouseId,
    }
  );

  // ============================================================
  // 8. VALIDACIÓN ADICIONAL DE SEGURIDAD
  // ============================================================

  if (warehouseId !== sessionWarehouseId) {

    console.error(
      "🟥 BLOQUEADO: UBICACIÓN FUERA DEL ALMACÉN"
    );

    return {
      success: false,
      title: "Ubicación no permitida",
      message:
        "No puede realizar conteos fuera del almacén asignado a la sesión.",
    };
  }

  console.log(
    "🟩 UBICACIÓN CORRESPONDE AL ALMACÉN DE LA SESIÓN"
  );

  // ============================================================
  // 9. VALIDAR PRODUCTO
  // ============================================================

  console.log("");
  console.log("🔍 VALIDANDO PRODUCTO");

  const productResult = await client.query(
    `
    SELECT
      id,
      sku

    FROM products

    WHERE id = $1

      AND status = 'ACTIVE'

      AND deleted_erp = false

    LIMIT 1
    `,
    [selectedProductId]
  );

  if (productResult.rows.length === 0) {

    console.error(
      "❌ PRODUCTO INVÁLIDO:",
      selectedProductId
    );

    return {
      success: false,
      title: "Producto inválido",
      message:
        "El producto no existe, no está activo o fue eliminado del ERP.",
    };
  }

  const productId =
    Number(productResult.rows[0].id);

  const productSku =
    productResult.rows[0].sku;

  console.log(
    "✅ PRODUCTO VALIDADO:",
    {
      productId,
      productSku,
    }
  );

  // ============================================================
  // 10. BUSCAR INVENTARIO EXISTENTE CON LOCK
  //
  // Se agrega warehouse_id al WHERE.
  // Así nunca se modifica una línea de otro almacén.
  // ============================================================

  console.log("");
  console.log("🔍 BUSCANDO INVENTARIO EXISTENTE");

  const invResult = await client.query(
    `
    SELECT
      id,
      warehouse_id,
      location_id,
      product_sku,
      qty_on_hand,
      qty_reserved,
      inventory_quantity

    FROM inventory_by_location

    WHERE warehouse_id = $1

      AND location_id = $2

      AND product_sku = $3

    FOR UPDATE
    `,
    [
      sessionWarehouseId,
      locationId,
      productSku,
    ]
  );

  if (invResult.rows.length > 1) {

    console.error(
      "❌ SE ENCONTRARON LÍNEAS DUPLICADAS"
    );

    return {
      success: false,
      title: "Inventario duplicado",
      message:
        "Se encontraron varias líneas del mismo producto en la misma ubicación. Debe revisarse el inventario antes de guardar.",
    };
  }

  let inventoryRowId = null;

  let oldQtyOnHand = 0;

  let previousInventoryQuantity = null;

  let action = "SKIP";

  let difference = 0;

  let wasCreated = false;

  // ============================================================
  // 11. SI EXISTE, ACTUALIZAR SOLO INVENTORY_QUANTITY
  //
  // No modificamos qty_on_hand todavía.
  // El ajuste final se realiza mediante el worker.
  // ============================================================

  if (invResult.rows.length > 0) {

    const row =
      invResult.rows[0];

    inventoryRowId =
      Number(row.id);

    oldQtyOnHand =
      Number(row.qty_on_hand || 0);

    previousInventoryQuantity =
      row.inventory_quantity == null
        ? null
        : Number(row.inventory_quantity);

    difference =
      countedQty - oldQtyOnHand;

    if (difference > 0) {
      action = "GAIN";
    }

    if (difference < 0) {
      action = "LOSS";
    }

    if (difference === 0) {
      action = "SKIP";
    }

    console.log(
      "📦 LÍNEA DE INVENTARIO EXISTENTE:",
      {
        inventoryRowId,
        warehouseId,
        locationId,
        productSku,
        oldQtyOnHand,
        previousInventoryQuantity,
        countedQty,
        difference,
        action,
      }
    );

    const updateResult = await client.query(
      `
      UPDATE inventory_by_location

      SET
        inventory_quantity = $1,

        counted_by = $2,

        counted_at = NOW(),

        updated_at = NOW()

      WHERE id = $3

        AND warehouse_id = $4

        AND location_id = $5

      RETURNING id
      `,
      [
        countedQty,
        countedUserId,
        inventoryRowId,
        sessionWarehouseId,
        locationId,
      ]
    );

    if (updateResult.rowCount !== 1) {

      throw new Error(
        "No se pudo actualizar la línea de inventario validada."
      );
    }

    console.log(
      "✅ INVENTORY_QUANTITY ACTUALIZADA:",
      {
        inventoryRowId,
        countedQty,
      }
    );

  } else {

    // ==========================================================
    // 12. SI NO EXISTE, CREAR LÍNEA DE INVENTARIO
    //
    // El warehouse_id se obtiene de la sesión.
    // Nunca se acepta desde req.body.
    // ==========================================================

    oldQtyOnHand = 0;

    previousInventoryQuantity = null;

    difference = countedQty;

    action =
      countedQty > 0
        ? "GAIN"
        : "SKIP";

    wasCreated = true;

    console.log("");
    console.log(
      "🟨 CREANDO NUEVA LÍNEA DE INVENTARIO:",
      {
        sessionId,
        sessionWarehouseId,
        locationId,
        productSku,
        countedQty,
        userId: countedUserId,
      }
    );

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

      VALUES (
        $1,
        $2,
        $3,
        0.00,
        $4,
        0.00,
        0.00,
        $5,
        NOW(),
        NOW()
      )

      RETURNING id
      `,
      [
        sessionWarehouseId,
        locationId,
        productSku,
        countedQty,
        countedUserId,
      ]
    );

    inventoryRowId =
      Number(insertResult.rows[0].id);

    console.log(
      "✅ LÍNEA DE INVENTARIO CREADA:",
      inventoryRowId
    );

  }

  // ============================================================
  // 13. RESULTADO FINAL
  // ============================================================

  console.log("");
  console.log("🟩 ========================================");
  console.log("✅ CONTEO GUARDADO CORRECTAMENTE");
  console.log("🆔 SESIÓN:", sessionId);
  console.log("🏬 ALMACÉN WMS:", sessionWarehouseId);
  console.log("📍 UBICACIÓN:", locationId);
  console.log("📦 PRODUCTO:", productSku);
  console.log("🔢 CANTIDAD CONTADA:", countedQty);
  console.log("📊 DIFERENCIA:", difference);
  console.log("📌 ACCIÓN:", action);
  console.log("🟩 ========================================");

  return {
    success: true,

    title:
      "Conteo guardado",

    message:
      "El conteo fue guardado correctamente.",

    data: {
      inventoryRowId,

      sessionId,

      productId,
      productSku,

      locationId,

      warehouseId:
        sessionWarehouseId,

      erpWarehouseId,

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
