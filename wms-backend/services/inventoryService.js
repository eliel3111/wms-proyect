// services/inventoryService.js

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

    if (toResult.rowCount === 0) {
        // 👉 crear inventario destino
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


    const toInv = toResult.rows[0];
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
