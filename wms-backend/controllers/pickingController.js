import { db } from "../db.js";
import { getActiveStorageLocationByCode } from "../services/locationService.js";
import { reserveInventoryForMove } from "../services/pickingBestRoute.js"
import { getPickingProductsWithLocationsService, getPickingConfig } from "../services/pickingBestRoute.js";
import { selectBestLocation, getMoveLinesOrderedByLocation } from "../services/pickingBestRoute.js";
import { createInventoryMovement, moveInventoryBetweenLocationsV2, moveInventoryGeneralLocation, reserveMoveLineQuantity } from "../services/inventoryService.js"
import { getOrCreateDefaultLocation } from "../services/pickingBestRoute.js"
import { buildCitrusConducePayload, createConduce } from "../integrations/citrus/citrus.saleOrder.js"
import { reserveMissingQtyForExistingMoveLines } from "../services/pickingReservationExisting.service.js";


export async function closePicking(req, res) {
  const { pickingId, locationId } = req.body;

  const userId = req.user?.id;
  console.log("================================");
  console.log("🚀 INICIANDO CIERRE DE PICKING");
  console.log("📥 BODY:", req.body);
  console.log("================================");

  if (!userId) {
    return res.status(401).json({
      success: false,
      title: "Usuario no autenticado",
      message: "No se encontró el usuario autenticado"
    });
  }

  if (!pickingId || !locationId) {
    return res.status(400).json({
      success: false,
      title: "Datos requeridos",
      message: "Debe enviar pickingId y locationId"
    });
  }

  const client = await db.connect();

  try {
    await client.query("BEGIN");
    console.log("🟢 BEGIN iniciado");

    const config = await getPickingConfig(client);

    /*if (!config.allow_picking_without_locations && totalReserved === 0) {*/

    console.log("🟨 configuracion: ", config);


    // 1️⃣ VALIDAR PICKING
    const pickingResult = await client.query(`
      SELECT 
        id,
        name,
        state,
        erp_cliente_id,
        erp_cliente,
        erp_direccion_cliente,
        erp_tienda_id,
        erp_vendedor_id,
        sale_id
      FROM stock_picking
      WHERE id = $1
      LIMIT 1
    `, [pickingId]);

    if (pickingResult.rowCount === 0) {
      throw {
        code: "PICKING_NOT_FOUND",
        message: "El picking no existe"
      };
    }

    const picking = pickingResult.rows[0];

    console.log("📦 Picking encontrado:", picking);

    if (["cancel", "done"].includes(picking.state)) {
      throw {
        code: "INVALID_STATE",
        message: "El picking ya está cerrado o cancelado"
      };
    }

    // 2️⃣ OBTENER LÍNEAS
    const linesResult = await client.query(`
      SELECT 
        sml.*,
        p.sku,
        p.erp_id,
        p.description
      FROM stock_move_line sml
      JOIN products p ON p.id = sml.product_id
      WHERE sml.picking_id = $1
        AND sml.state NOT IN ('cancel', 'done')
    `, [pickingId]);

    const lines = linesResult.rows;
    console.log("📋 Líneas activas del picking:", lines);
    if (lines.length === 0) {
      throw {
        code: "NO_LINES",
        message: "El picking no tiene líneas"
      };
    }


    const citrusResult = buildCitrusConducePayload(picking, lines);

    console.log("🍊 Resultado Citrus Payload:", citrusResult);

    if (!citrusResult.success) {
      throw {
        code: "CITRUS_VALIDATION_ERROR",
        title: citrusResult.title,
        message: citrusResult.message
      };
    }

    const conduceResult = await createConduce(citrusResult.payload);

    console.log("📤 Resultado createConduce:", conduceResult);

    if (conduceResult.success === false) {

      await client.query("ROLLBACK");
      console.log("🟥 ERROR EN EL CONDUCE");
      return res.status(200).json({
        success: false,
        title: "ERROR EN CITRUS",
        message: conduceResult.message || "Error desconocido del ERP",
        data: conduceResult.data
      });
    }

    // 4️⃣ ACTUALIZAR stock_move_line
    await client.query(`
  UPDATE stock_move_line
  SET
    state = 'done',
    user_id = $1
  WHERE picking_id = $2
    AND state NOT IN ('cancel', 'done')
    AND COALESCE(qty_done, 0) > 0
`, [userId, pickingId]);

    console.log("✅ stock_move_line actualizado a done");
    const completedMoveIds = [];
    // 3️⃣ PROCESAR CADA LÍNEA
    for (const line of lines) {

      const qtyDone = Number(line.qty_done || 0);
      const qtyPlanned = Number(line.product_uom_qty || 0);
      console.log("🟨🟨🟨🟨 Procesando movimiento WMS:", {
        lineId: line.id,
        sku: line.sku,
        qtyDone,
        qtyPlanned
      });

      if (qtyDone === 0) {
        console.log("⏭️ Línea ignorada porque qtyDone es 0:", line.sku);
        continue;
      }
      if (qtyPlanned === 0) continue;

      if (!config.allow_picking_without_locations) {

        // 🔥 MOVER INVENTARIO NORMAL
        const resultMove = await moveInventoryBetweenLocationsV2(client, {
          productSku: line.sku,
          fromLocation: line.location_id,
          toLocation: locationId,
          qty: qtyDone,
          qty_promised: 0 //or qtyPlanned 🟧 RESERVACION
        });

        console.log("✅ RESULTADO MOVE:", resultMove);

      } else {

        console.log(
          "🟥🚨🟨 allow_picking_without_locations=true → usando moveInventoryGeneralLocation"
        );

        const resultMove = await moveInventoryGeneralLocation(client, {
          productSku: line.sku,
          fromLocation: line.location_id,
          toLocation: locationId,
          qty: qtyDone,
          qty_promised: 0 // or qtyPlanned  🟧 RESERVACION
        });

        console.log("✅ RESULTADO MOVE GENERAL:", resultMove);
      }
      console.log(line);

      if (qtyDone === 0) continue;

      // 🔥 CREAR MOVIMIENTO
      await createInventoryMovement(client, {
        productSku: line.sku,
        fromLocationId: line.location_id,
        toLocationId: locationId,
        qty: qtyDone,
        movementType: "SHIP",
        referenceType: picking.name,
        referenceId: pickingId,
        createdBy: userId,
        note: `Movimiento por cierre de picking ${picking.name}`
      });

      if (qtyDone === qtyPlanned) {

        console.log("✅ MOVE COMPLETADO");

        completedMoveIds.push(Number(line.move_id));

        console.log("🟨 COMPLETED MOVE IDS:", completedMoveIds);
      }

      if (
        qtyDone > 0 &&
        qtyDone < qtyPlanned
      ) {

        const remainingQty = qtyPlanned - qtyDone;

        // Ajustar línea original
        await client.query(`
    UPDATE stock_move_line
    SET product_uom_qty = $1,
        qty_done = $2
    WHERE id = $3
  `, [
          qtyDone,
          qtyDone,
          line.id
        ]);

        // Crear línea pendiente
        const newMoveLine = await client.query(`
    INSERT INTO stock_move_line (
      move_id,
      picking_id,
      product_id,
      product_uom_id,
      product_uom_qty,
      qty_done,
      location_id,
      warehouse_id,
      state
    )
    VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9
    )
    RETURNING *
  `, [
          line.move_id,
          line.picking_id,
          line.product_id,
          line.product_uom_id,
          remainingQty,
          0,
          line.location_id,
          line.warehouse_id,
          "assigned"
        ]);

        // Reservar pendiente 🟧🟧🟧🟧🟧 RESERVACION
        /*await reserveMoveLineQuantity(
          client,
          line,
          remainingQty
        );*/

        console.log(
          `🟨 Línea pendiente creada y reservada para ${line.sku}. Restante: ${remainingQty}`
        );
      }



    }



    if (completedMoveIds.length > 0) {

      await client.query(`
    UPDATE stock_move
    SET state = 'done'
    WHERE id = ANY($1::int[])
  `, [completedMoveIds]);

      console.log(
        "✅ stock_move actualizado a done:",
        completedMoveIds
      );
    }

    //CONFIRMAR SI TODO SE RECIBIO TODAS LAS LINEAS Y SI SE RECIBIO CERRAR EL PICKING.

    const allLinesCompleted = lines.every(line => {
      const qtyDone = Number(line.qty_done || 0);
      const qtyPlanned = Number(line.product_uom_qty || 0);

      return qtyDone === qtyPlanned;
    });

    console.log("🟨 ALL LINES COMPLETED:", allLinesCompleted);

    if (allLinesCompleted) {

      await client.query(`
    UPDATE stock_picking
    SET state = 'done'
    WHERE id = $1
  `, [pickingId]);

      console.log("✅ stock_picking actualizado a done");

    } else {

      console.log(
        "🟨 Picking parcialmente despachado, permanece abierto"
      );

    }

    await client.query("COMMIT");
    console.log("🟢 COMMIT realizado correctamente");


    return res.status(200).json({
      success: true,
      message: "Picking cerrado correctamente"
    });

    /*return res.status(200).json({
      success: true,
      title: "Picking cerrado",
      message: "Picking cerrado correctamente",
      conduce: conduceResult
    });*/

  } catch (error) {
    await client.query("ROLLBACK");

    console.error("================================");
    console.error("❌ ERROR closePicking");
    console.error(error);
    console.error("================================");

    return res.status(400).json({
      success: false,
      code: error.code || "ERROR",
      title: error.title || "Error cerrando picking",
      message: error.message || "Error cerrando picking"
    });

  } finally {
    client.release();
    console.log("🔚 Cliente PostgreSQL liberado");
  }
}







export async function getBestShippingLocation(req, res) {
  const { pickingId } = req.params;

  console.log("=================================");
  console.log("🚚 GET BEST SHIPPING LOCATION");
  console.log("📦 Picking ID:", pickingId);
  console.log("=================================");

  if (!pickingId) {
    console.log("❌ No se recibió pickingId");
    return res.status(400).json({
      success: false,
      title: "Picking requerido",
      message: "Debe enviar el pickingId.",
    });
  }

  try {
    // 1️⃣ Validar picking
    const pickingResult = await db.query(
      `SELECT id FROM stock_picking WHERE id = $1 LIMIT 1`,
      [pickingId]
    );

    if (pickingResult.rowCount === 0) {
      console.log("❌ Picking no existe:", pickingId);

      return res.status(404).json({
        success: false,
        title: "Picking no encontrado",
        message: "El picking no existe.",
      });
    }
    console.log("📊 Picking encontrado:", pickingResult.rowCount);
    // 2️⃣ Obtener ubicaciones SHIPPING activas
    const locationsResult = await db.query(
      `
      SELECT id, warehouse_id, code
      FROM locations
      WHERE is_active = true
        AND location_type = 'SHIPPING'
      ORDER BY id ASC
      `
    );

    if (locationsResult.rowCount === 0) {
      console.log("❌ No existen ubicaciones SHIPPING");
      return res.status(404).json({
        success: false,
        title: "Sin ubicaciones de despacho",
        message: "No hay ubicaciones de despacho disponibles. Contacte al administrador.",
      });
    }

    console.log(
      "📍 Ubicaciones SHIPPING encontradas:",
      locationsResult.rowCount
    );

    const locations = locationsResult.rows;
    console.log("TODAS LAS UBICACIONES", locations);

    // 3️⃣ Obtener carga de hoy por ubicación
    const today = new Date().toISOString().slice(0, 10);



    const assignmentsResult = await db.query(
      `
  SELECT location_id, SUM(line_count) as total_lines
  FROM shipping_assignments
  WHERE assignment_date = CURRENT_DATE
  GROUP BY location_id
  `
    );
    const assignmentsMap = new Map();
    console.log(
      "🗺️ Assignments Map:",
      Object.fromEntries(assignmentsMap)
    );



    assignmentsResult.rows.forEach(row => {
      assignmentsMap.set(Number(row.location_id), Number(row.total_lines));
    });

    console.log("UBICACIONES CON ASIGNACIONES", assignmentsResult.rows);

    // 4️⃣ Elegir ubicación inteligente

    let bestLocation = null;

    // 🔹 CASO 1: no hay ningún assignment hoy
    if (assignmentsResult.rowCount === 0) {
      console.log(
        "🟢 No hay asignaciones hoy. Seleccionando primera ubicación."
      );

      bestLocation = locations[0];
    }

    // 🔹 CASO 2: hay assignments
    else {

      // 1. Buscar ubicaciones SIN assignments
      const locationsWithoutAssignments = locations.filter(
        loc => !assignmentsMap.has(Number(loc.id))
      );

      console.log(
        "🟡 Ubicaciones sin assignments:",
        locationsWithoutAssignments.length
      );

      console.table(locationsWithoutAssignments);

      // 👉 PRIORIDAD: usar una libre
      if (locationsWithoutAssignments.length > 0) {
        bestLocation = locationsWithoutAssignments[0];

        console.log(
          "✅ Se seleccionó ubicación libre:",
          bestLocation.code
        );
      } else {

        console.log(
          "🔄 Todas las ubicaciones tienen carga. Buscando menor carga..."
        );

        let minLoad = Infinity;

        for (const loc of locations) {
          const load = assignmentsMap.get(Number(loc.id)) || 0;

          console.log(
            `📍 ${loc.code} | carga=${load}`
          );


          if (load < minLoad) {
            minLoad = load;
            bestLocation = loc;
          }
        }
      }
    }

    // 🔹 fallback (extra seguridad)
    if (!bestLocation) {
      bestLocation = locations[0];
    }

    // 5️⃣ Respuesta
    return res.status(200).json({
      success: true,
      data: {
        location_id: bestLocation.id,
        code: bestLocation.code,
      },
    });

  } catch (error) {
    console.error("Error getting shipping location:", error);

    return res.status(500).json({
      success: false,
      title: "Error del servidor",
      message: "No se pudo obtener la ubicación de despacho.",
    });
  }
}






export async function getPickingDifferences(req, res) {

  const { pickingId } = req.params;

  console.log("🚀 getPickingDifferences iniciado");
  console.log("📦 PARAMS:", req.params);

  // 🔴 VALIDAR ID
  if (!pickingId) {

    console.log("❌ PICKING_ID_REQUIRED");

    return res.status(400).json({
      success: false,
      message: "PICKING_ID_REQUIRED",
    });
  }

  const id = Number(pickingId);

  console.log("🔢 PICKING ID:", id);

  if (isNaN(id)) {

    console.log("❌ INVALID_PICKING_ID");

    return res.status(400).json({
      success: false,
      message: "INVALID_PICKING_ID",
    });
  }

  try {

    console.log("🔍 BUSCANDO PICKING...");

    // 1️⃣ VALIDAR PICKING
    const pickingResult = await db.query(
      `
      SELECT id, name, state
      FROM stock_picking
      WHERE id = $1
      LIMIT 1
      `,
      [id]
    );

    console.log(
      "📦 PICKING RESULT:",
      pickingResult.rows
    );

    if (pickingResult.rowCount === 0) {

      console.log("❌ PICKING_NOT_FOUND");

      return res.status(404).json({
        success: false,
        message: "PICKING_NOT_FOUND",
      });
    }

    const picking = pickingResult.rows[0];

    console.log("✅ PICKING ENCONTRADO:", picking);

    // 2️⃣ VALIDAR STATE
    console.log("📌 PICKING STATE:", picking.state);

    if (picking.state !== "assigned") {

      console.log("❌ PICKING_NOT_ASSIGNED");

      return res.status(409).json({
        success: false,
        message: "PICKING_NOT_ASSIGNED",
        data: {
          current_state: picking.state
        }
      });
    }

    console.log("🔍 BUSCANDO DIFERENCIAS...");

    // 3️⃣ BUSCAR LÍNEAS CON DIFERENCIA
    const linesResult = await db.query(
      `
      SELECT
        sml.id,
        sml.product_id,
        sml.product_uom_qty,
        sml.qty_done,
        p.sku,
        p.description,
        p.erp_name,
        p.erp_sku,
        p.erp_id
      FROM stock_move_line sml
      LEFT JOIN products p ON p.id = sml.product_id
      WHERE sml.picking_id = $1
        AND sml.product_uom_qty <> sml.qty_done
      ORDER BY sml.id ASC
      `,
      [id]
    );

    console.log(
      "📋 LÍNEAS CON DIFERENCIA:",
      linesResult.rows
    );

    console.log(
      "📊 TOTAL DIFERENCIAS:",
      linesResult.rowCount
    );

    // 4️⃣ RESPONSE
    console.log("✅ RESPUESTA EXITOSA");

    return res.status(200).json({
      success: true,
      data: {
        picking_id: picking.id,
        picking_name: picking.name,
        state: picking.state,
        lines: linesResult.rows,
      },
    });

  } catch (error) {

    console.error("🔥 ERROR getPickingDifferences:");

    console.error("MESSAGE:", error.message);

    console.error("STACK:", error.stack);

    console.error("FULL ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "ERROR_GETTING_PICKING_DIFFERENCES",
    });
  }
}




export async function confirmPickingLine(req, res) {
  const client = await db.connect();
  console.log("🟨🟨 CONFIRMING LINE");
  try {
    const { id, locationId, productId, qty } = req.body;

    // 🔴 VALIDACIÓN
    if (!id || !locationId || !productId || !qty) {
      return res.json({
        success: false,
        title: "Datos incompletos",
        message: "Debe enviar id, locationId, productId y qty"
      });
    }

    // 🔎 BUSCAR LÍNEA
    const result = await client.query(
      `
      SELECT *
      FROM stock_move_line
      WHERE id = $1
        AND product_id = $2
        AND location_id = $3
      `,
      [id, productId, locationId]
    );

    if (result.rows.length === 0) {
      return res.json({
        success: false,
        title: "Línea no encontrada",
        message: "No coincide el producto o la ubicación"
      });
    }

    const line = result.rows[0];

    // 🔴 VALIDAR QTY
    if (Number(qty) < 0) {
      return res.json({
        success: false,
        title: "Cantidad inválida",
        message: "Debe ser mayor a 0"
      });
    }

    if (Number(qty) > Number(line.product_uom_qty)) {
      return res.json({
        success: false,
        title: "Cantidad excedida",
        message: "No puede recoger más de lo solicitado"
      });
    }

    // ✅ UPDATE
    await client.query(
      `
      UPDATE stock_move_line
      SET qty_done = $1
      WHERE id = $2
      `,
      [qty, id]
    );

    return res.json({
      success: true,
      title: "OK",
      message: "Cantidad registrada"
    });

  } catch (error) {
    console.error("🔥 ERROR confirmPickingLine:", error);

    return res.json({
      success: false,
      title: "Error interno",
      message: "Algo salió mal"
    });
  } finally {
    client.release();
  }
};





export async function scanPickingCode(req, res) {
  console.log("🟦 [START] scanPickingCode");


  const client = await db.connect();

  const dbInfo = await client.query(`
  SELECT current_database()
`);

  console.log(
    "🗄️ DATABASE:",
    dbInfo.rows[0].current_database
  );

  try {
    const { code, pickingId } = req.body;

    console.log("📥 INPUT:", req.body);

    // ==============================
    // 1️⃣ VALIDACIÓN
    // ==============================
    if (!code || !pickingId) {
      return res.status(400).json({
        success: false,
        message: "code y pickingId son requeridos",
      });
    }

    const normalized = code.trim().toUpperCase();

    console.log("🔎 Código normalizado:", JSON.stringify(normalized));

    let detectedType = null;
    let detectedData = null;

    // ==============================
    // 2️⃣ VALIDAR UBICACIÓN
    // ==============================
    const locationResult = await getActiveStorageLocationByCode(
      client,
      normalized
    );

    console.log("🟥 location response  db", locationResult.rows[0]);

    if (locationResult.rowCount > 0) {
      detectedType = "location";
      detectedData = locationResult.rows[0];

      console.log("📍 UBICACIÓN DETECTADA:", detectedData);
    }

    // ==============================
    // 3️⃣ VALIDAR PRODUCTO
    // ==============================
    let productId = null;

    if (!detectedType) {
      // ==============================
      // 🔎 BUSCAR PRODUCTO POR BARCODE
      // ==============================
      let productResult = await client.query(
        `
  SELECT p.id, p.sku
  FROM product_barcodes pb
  JOIN products p ON p.sku = pb.product_sku
  WHERE UPPER(pb.barcode) = $1
  LIMIT 1
`,
        [normalized]
      );

      // ==============================
      // 🔎 SI NO EXISTE → BUSCAR SKU
      // ==============================
      if (productResult.rowCount === 0) {

        console.log("⚠️ Barcode no encontrado, buscando SKU...");

        productResult = await client.query(
          `
    SELECT id, sku
    FROM products
    WHERE UPPER(sku) = $1
    LIMIT 1
  `,
          [normalized]
        );
      }
      if (productResult.rowCount === 0) {
        console.log("❌ Código inválido");

        return res.json({
          success: false,
          code: "INVALID_CODE",
          message: "El código no corresponde a una ubicación ni a un producto",
        });
      }

      detectedType = "product";
      detectedData = productResult.rows[0];
      productId = detectedData.id;

      console.log("📦 PRODUCTO DETECTADO:", detectedData);
    }

    // 🔹 Obtener configuración
    const pickingConfig = await getPickingConfig(client);

    console.log("⚙️ PICKING CONFIG:", pickingConfig);

    // ==============================
    // 🔥 IGNORAR VALIDACIÓN LOCATION
    // ==============================
    if (
      detectedType === "location" &&
      pickingConfig.allow_picking_without_locations === true
    ) {
      const warehouseResult = await client.query(`
  SELECT id
  FROM warehouses
  WHERE is_default = true
    AND status = 'ACTIVE'
  LIMIT 1
`);

      if (warehouseResult.rowCount === 0) {
        throw new Error("No existe warehouse por defecto");
      }

      const warehouseId = warehouseResult.rows[0].id;

      let defaultLocation =
        await getOrCreateDefaultLocation(
          client,
          warehouseId
        );
      console.log("✅ Location permitida sin validar picking", defaultLocation);

      return res.json({
        success: true,
        type: "location",
        data: {
          id: defaultLocation.id,
          code: defaultLocation.code
        },
        skipPickingValidation: true
      });
    }



    // ==============================
    // 4️⃣ VALIDAR QUE PERTENECE AL PICKING
    // ==============================
    const moveLinesResult = await client.query(
      `
      SELECT product_id, location_id
      FROM stock_move_line
      WHERE picking_id = $1
    `,
      [pickingId]
    );

    if (!moveLinesResult.rows.length) {
      console.log("⚠️ No hay líneas en el picking");

      return res.json({
        success: false,
        message: "El picking no tiene líneas",
      });
    }

    let isValid = false;

    for (const row of moveLinesResult.rows) {
      // 🔹 Validar producto
      if (detectedType === "product" && row.product_id == productId) {
        isValid = true;
        break;
      }

      // 🔹 Validar ubicación
      if (
        detectedType === "location" &&
        row.location_id == detectedData.id
      ) {
        isValid = true;
        break;
      }
    }

    if (!isValid) {
      console.log("❌ No pertenece al picking");

      return res.json({
        success: false,
        code: "NOT_IN_PICKING",
        title: "Código no válido",
        message: "El código escaneado no pertenece a este pedido",
      });
    }

    // ==============================
    // 5️⃣ RESPUESTA FINAL
    // ==============================
    console.log("✅ VALIDACIÓN EXITOSA");

    return res.json({
      success: true,
      type: detectedType,
      data: detectedData,
    });

  } catch (error) {
    console.error("🔥 [ERROR scanPickingCode]:", error);

    return res.status(500).json({
      success: false,
      message: "Error interno",
      error: error.message,
    });

  } finally {
    client.release();
    console.log("🔚 [END] scanPickingCode");
  }
}




export async function getPickingProductsWithLocations(req, res) {
  console.log("🟦 ----[START] Controller----");

  const client = await db.connect();

  try {
    const { pickingId } = req.params;

    if (!pickingId) {
      return res.status(400).json({
        success: false,
        message: "pickingId es requerido",
      });
    }

    await client.query("BEGIN");

    //Se elimina las lineas del picking o de la recogida del usuario
    //para que cada vez que entra se ejecute la logica de nuevo

    const deleteMoveLinesResult = await client.query(
      `
  DELETE FROM stock_move_line
  WHERE picking_id = $1
  RETURNING id
  `,
      [pickingId]
    );

    console.log(
      `🗑️ Líneas eliminadas de stock_move_line: ${deleteMoveLinesResult.rowCount}`
    );


    const result = await getPickingProductsWithLocationsService(
      client,
      pickingId
    );


    // 🔴 VALIDAR SI NO HAY DATA
    if (!result.data || result.data.length === 0) {

      return res.status(200).json({
        success: false,
        message: result.message || "El producto no tiene cantidad en ninguna ubicación",
      });

    }

    //console.log("🟥🟥🚨🚨 RESULT ERROR: ", result);


    result.data.forEach((item) => {

      console.log("=================================");
      console.log("📦 SKU:", item.sku);
      console.log("🆔 PRODUCT ID:", item.product_id);

      console.log("🚚 MOVES:");

      item.moves.forEach((move, index) => {
        console.log(`Move #${index + 1}`, move);
      });

      console.log("📍 LOCATIONS:");

      item.locations.forEach((location, index) => {
        console.log(`Location #${index + 1}`, location);
      });

    });


    const enrichedData = result.data.map(product => {
      const bestLocation = selectBestLocation(product);

      return {
        ...product,
        selected_location: bestLocation
      };
    });

    console.log("enricheddata ", enrichedData);



    let totalReserved = 0;
    let hasPickingChanges = false;
    let results = [];

    /* ==============================
       1️⃣ RESERVAR INVENTARIO
    ============================== */

    for (const move of enrichedData) {
      console.log("🟡 Probando producto:", move.product_id);

      const pickingId = move.picking_id;
      const productId = move.product_id;
      const requiredQty = move.moves[0].product_qty;

      // 🔍 1. Buscar líneas existentes en stock_move_line
      const query = `
    SELECT COALESCE(SUM(product_uom_qty), 0) AS total_qty
    FROM stock_move_line
    WHERE picking_id = $1
      AND product_id = $2
  `;

      const { rows } = await client.query(query, [pickingId, productId]);

      const totalQty = parseFloat(rows[0].total_qty) || 0;

      console.log("📦 Total ya procesado en move_line:", totalQty);
      console.log("📦 Cantidad requerida:", requiredQty);

      if (totalQty === requiredQty) {
        console.log("⛔ Ya está completamente procesado, se omite reserva");

        results.push({
          product_id: productId,
          reserved: 0,
          skipped: true
        });

        continue;
      }

      //🟨🟨🟨🟨🟨🟨🟨
      // 🚫 2. Validación para NO ejecutar reserva
      if (totalQty > 0) {
        console.log("🟡 Ya existen líneas, revisando si falta reservar diferencia...");

        const resultExisting = await reserveMissingQtyForExistingMoveLines(
          client,
          move
        );

        console.log("🟢 Resultado reserva con líneas existentes:", resultExisting);

        const reservedQty = Number(resultExisting?.reserved || 0);
        const createdQty = Number(resultExisting?.createdQty || 0);
        const releasedQty = Number(resultExisting?.released || 0);

        totalReserved += reservedQty;

        // ✅ Importante:
        // Aunque reserved sea 0, puede haber cambios reales en stock_move_line.
        if (
          resultExisting?.changed === true ||
          resultExisting?.case === "ORDER_INCREASED" ||
          resultExisting?.case === "ORDER_DECREASED"
        ) {
          hasPickingChanges = true;
        }

        results.push({
          product_id: productId,
          reserved: reservedQty,
          createdQty,
          released: releasedQty,
          changed: resultExisting?.changed || false,
          case: resultExisting?.case || null,
          skipped: resultExisting?.skipped || false,
          message: resultExisting?.message || "",
        });

        continue;
      }
      //🟨🟨🟨🟨🟨🟨🟨

      console.log("RESERVAR MOVE: ", move);
      // 🔥 3. Ejecutar reserva SOLO si no hay líneas
      const result = await reserveInventoryForMove(client, move);

      console.log("Resultado reserva real:", result);

      totalReserved += result.reserved;

      results.push({
        product_id: move.product_id,
        reserved: result.reserved
      });
    }

    /* ==============================
       2️⃣ VALIDACIÓN
    ============================== */

    const finalResult = await getMoveLinesOrderedByLocation(client, pickingId);

    console.log("FINAL RESULT: ", finalResult);

    const config = await getPickingConfig(client);

    if (
      !config.allow_picking_without_locations &&
      totalReserved === 0 &&
      !hasPickingChanges
    ) {
      console.log("⚠️ No se reservó nada y no hubo cambios en stock_move_line");

      await client.query("ROLLBACK");

      return res.status(200).json({
        success: true,
        message: "No se pudo reservar inventario",
        data: finalResult,
      });
    }



    await client.query("COMMIT");

    return res.json({
      success: true,
      message: result.message,
      data: finalResult,
    });

  } catch (error) {
    console.error("🔥 [ERROR Controller]:", error);

    await client.query("ROLLBACK");

    return res.status(500).json({
      success: false,
      message: "Error interno",
      error: error.message,
    });

  } finally {
    client.release();
    console.log("🔚 [END Controller]");
  }
}




export async function getAssignedPickings(req, res) {
  console.log("🟦 ----[START] Get Assigned Pickings Endpoint----");

  const client = await db.connect();

  try {
    const userId = req.user?.id;

    console.log("📥 userId recibido desde req.user:", userId);

    if (!userId) {
      console.log("❌ Usuario no autenticado o id no disponible");

      return res.status(401).json({
        success: false,
        title: "No autorizado",
        message: "No se pudo identificar el usuario",
      });
    }

    await client.query("BEGIN");
    console.log("🔐 BEGIN TRANSACTION");

    // 1) Buscar picker por user_id
    const pickerResult = await client.query(
      `
      SELECT id
      FROM pickers
      WHERE user_id = $1
      LIMIT 1
      `,
      [userId]
    );

    if (!pickerResult.rows.length) {
      console.log("⚠️ Usuario sin permiso de picker");

      await client.query("ROLLBACK");

      return res.status(403).json({
        success: false,
        title: "Usuario sin permiso",
        message: "Tú no eres un picker",
      });
    }

    const pickerId = pickerResult.rows[0].id;
    console.log("✅ Picker encontrado:", pickerId);

    // 2) Buscar todos los stock_picking_id asignados a ese picker
    const assignmentsResult = await client.query(
      `
      SELECT stock_picking_id
      FROM picking_assignments
      WHERE picker_id = $1
      `,
      [pickerId]
    );

    if (!assignmentsResult.rows.length) {
      console.log("ℹ️ No hay asignaciones para este picker");

      await client.query("ROLLBACK");

      return res.json({
        success: true,
        title: "No hay recogidas pendientes",
        message: "Está todo al día, excelente trabajo",
        data: [],
      });
    }

    const stockPickingIds = assignmentsResult.rows.map(
      (row) => row.stock_picking_id
    );

    console.log("📦 stockPickingIds encontrados:", stockPickingIds);

    // 3) Buscar masivamente en stock_picking
    const pickingsResult = await client.query(
      `
      SELECT
        id,
        name,
        order_name,
        erp_cliente
      FROM stock_picking
      WHERE id = ANY($1::int[])
        AND state NOT IN ('cancel', 'done')
        AND picking_type = 'outgoing'
      ORDER BY id DESC
      `,
      [stockPickingIds]
    );

    if (!pickingsResult.rows.length) {
      console.log("ℹ️ No hay pickings pendientes luego del filtro");

      await client.query("ROLLBACK");

      return res.json({
        success: true,
        title: "No hay recogidas pendientes",
        message: "Está todo al día, excelente trabajo",
        data: [],
      });
    }

    await client.query("COMMIT");
    console.log("✅ [SUCCESS] Pickings asignados obtenidos correctamente");
    console.log("📊 Total pickings devueltos:", pickingsResult.rows.length);

    return res.json({
      success: true,
      title: "Recogidas obtenidas",
      message: "Pedidos asignados cargados correctamente",
      data: pickingsResult.rows,
    });
  } catch (error) {
    console.error("🔥 [ERROR] Get Assigned Pickings:", error);

    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("🔥 [ROLLBACK ERROR]:", rollbackError);
    }

    return res.status(500).json({
      success: false,
      title: "Error interno",
      message: "Ocurrió un error obteniendo los pedidos asignados",
      error: error.message,
    });
  } finally {
    client.release();
    console.log("🔚 [END] Get Assigned Pickings Endpoint");
  }
}



//Reasignar un picking
export async function reassignPicking(req, res) {
  console.log("🟥----[START] Reassign Picking Endpoint----");

  const client = await db.connect(); // 👈 importante para transacción

  try {
    const { selectedPicker, selectedItem } = req.body;

    console.log("📥 Input:", { selectedPicker, selectedItem });

    // 🔹 Validación básica
    if (!selectedPicker || !selectedItem?.id) {
      console.log("❌ Datos inválidos");
      return res.json({
        success: false,
        message: "Datos inválidos",
      });
    }

    const pickingId = selectedItem.id;
    const newPickerId = selectedPicker;

    // 🔥 INICIAR TRANSACCIÓN
    await client.query("BEGIN");
    console.log("🔐 BEGIN TRANSACTION");

    // 🔹 1. Traer estado + usuario actual en UNA sola query
    const pickingResult = await client.query(`
    SELECT *
    FROM stock_picking
    WHERE id = $1
    FOR UPDATE
  `, [pickingId]);


    if (!pickingResult.rows.length) {
      console.log("❌ Picking no encontrado");

      await client.query("ROLLBACK");

      return res.json({
        success: false,
        message: "Picking no encontrado",
      });
    }

    const { state, user_id: currentUserId } = pickingResult.rows[0];

    console.log("📦 Estado:", state, "| Actual user:", currentUserId);

    // 🔹 2. Validar estado
    if (state === "done" || state === "cancel") {
      console.log("⚠️ Picking bloqueado");

      await client.query("ROLLBACK");

      return res.json({
        success: true,
        message: "Picking ya está en estado done/cancel",
      });
    }










    //LOCK PICKING FOR UPDATe
    if (state === "confirmed") {
      // buscar moves
      const moves = await client.query(`
        SELECT sm.*, p.sku
        FROM stock_move sm
        JOIN products p ON p.id = sm.product_id
        WHERE sm.picking_id = $1
        AND sm.state IN ('confirmed', 'partially_available')
    `, [pickingId]);

      console.log("NUMERO DE PRODUCTOS EN UN PEDIDO", moves.rowCount);

      let totalReserved = 0;

      /* ==============================
         1️⃣ RESERVAR INVENTARIO
      ============================== */

      for (const move of moves.rows) {
        //console.log("🚨🚨 ALERTA", move);
        const result = await reserveInventoryForMove(client, move);

        console.log("Resultado reserva:", result);

        totalReserved += result.reserved;
      }

      /* ==============================
         2️⃣ VERIFICAR SI SE RESERVÓ ALGO
      ============================== */

      if (totalReserved === 0) {
        console.log("⚠️ No se pudo reservar inventario");

        await client.query("ROLLBACK");

        return res.json({
          success: false,
          message: "No se pudo reservar inventario",
        });
      }

    }
    /// 🔹 4. Obtener user_id desde pickers
    console.log("🔍 Buscando picker en tabla pickers");

    const pickerResult = await client.query(
      `
  SELECT user_id, active
  FROM pickers
  WHERE id = $1
  `,
      [newPickerId]
    );

    if (!pickerResult.rows.length) {
      console.log("❌ Picker no encontrado");

      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        message: "Picker no encontrado",
      });
    }

    const { user_id: userIdObtenido, active } = pickerResult.rows[0];

    // 🔹 Validar activo
    if (!active) {
      console.log("⚠️ Picker inactivo");

      await client.query("ROLLBACK");

      return res.status(400).json({
        success: false,
        message: "El picker está inactivo",
      });
    }

    //console.log("👤 user_id obtenido:", userIdObtenido);
    //console.log("👤 current:", userIdObtenido);
    // 🧪 VALIDACIÓN PRO: evitar doble update innecesario
    if (currentUserId == userIdObtenido) {
      console.log("ℹ️ Ya asignado al mismo usuario (desde picker)");

      await client.query("ROLLBACK");

      return res.json({
        success: true,
        message: "El picking ya está asignado a este usuario",
      });
    }

    // 🔹 5. Update stock_picking con user_id REAL
    console.log("✏️ Actualizando stock_picking.user_id");

    await client.query(
      `
  UPDATE stock_picking 
  SET 
      user_id = $1,
      state = 'assigned'
  WHERE id = $2
  `,
      [userIdObtenido, pickingId]
    );
    // 🔹 6. Upsert eficiente en picking_assignments
    console.log("🔄 Upsert picking_assignments");

    await client.query(
      `
      INSERT INTO picking_assignments (stock_picking_id, picker_id)
      VALUES ($1, $2)
      ON CONFLICT (stock_picking_id)
      DO UPDATE SET picker_id = EXCLUDED.picker_id
      `,
      [pickingId, newPickerId]
    );

    // 🔥 COMMIT
    await client.query("COMMIT");

    console.log("✅ [SUCCESS] Reasignación completada");

    return res.json({
      success: true,
      message: "Picking reasignado correctamente",
    });

  } catch (error) {
    console.error("🔥 [ERROR]", error);

    // 🔥 ROLLBACK en error
    await client.query("ROLLBACK");

    return res.json({
      success: false,
      message: "Error interno",
      error: error.message,
    });

  } finally {
    client.release(); // 👈 MUY IMPORTANTE
    console.log("🔚 [END] Reassign Picking Endpoint");
  }
}



//Obtener todos los pickers activos unicamente
export async function getActivePickers(req, res) {

  const client = await db.connect();

  console.log("🟥 Endpoint GET /picking/active-pickers [getActivePickers()] iniciado");

  try {

    /* ==============================
       1️⃣ BUSCAR PICKERS ACTIVOS
    ============================== */

    const pickersResult = await client.query(`
      SELECT id, user_id
      FROM pickers
      WHERE active = true
      AND active_today = true
    `);

    if (pickersResult.rowCount === 0) {
      console.log("🟨 No hay pickers activos disponibles");

      return res.status(200).json({
        success: false,
        title: "Sin pickers",
        message: "No hay pickers disponibles en este momento."
      });
    }

    /* ==============================
       2️⃣ JOIN CON USERS
    ============================== */

    const usersResult = await client.query(`
      SELECT 
        p.id AS picker_id,
        p.user_id,
        u.full_name,
        u.is_active
      FROM pickers p
      JOIN users u ON u.id = p.user_id
      WHERE p.active = true
      AND p.active_today = true
    `);

    let activos = [];
    let inactivos = [];

    for (const row of usersResult.rows) {

      if (row.is_active) {
        activos.push({
          picker_id: row.picker_id,
          user_id: row.user_id,
          full_name: row.full_name
        });
      } else {
        inactivos.push({
          picker_id: row.picker_id,
          user_id: row.user_id,
          full_name: row.full_name
        });
      }
    }

    /* ==============================
       3️⃣ VALIDACIONES
    ============================== */

    if (activos.length === 0) {
      console.log("🟨 Pickers encontrados pero usuarios inactivos");

      return res.status(200).json({
        success: false,
        title: "Usuarios no disponibles",
        message: "Los pickers encontrados no tienen usuarios activos.",
        detail: inactivos
      });
    }

    /* ==============================
       LOG RESUMEN
    ============================== */

    console.log(
      `🟨 Pickers activos: ${activos.length} | ` +
      `Usuarios inactivos filtrados: ${inactivos.length} | ` +
      `Total encontrados: ${usersResult.rowCount}`
    );

    console.log("🟩 Endpoint GET /picking/active-pickers [getActivePickers()] terminado");

    return res.status(200).json({
      success: true,
      data: activos,
      message: "Pickers activos obtenidos correctamente."
    });

  } catch (error) {

    console.error("🟥 ERROR en getActivePickers:", error);

    return res.status(500).json({
      success: false,
      title: "Error interno",
      message: "Ocurrió un error al obtener los pickers."
    });

  } finally {
    client.release();
  }
};



export async function cancelPicking(req, res) {

  const client = await db.connect();

  console.log("🟥 Endpoint POST /picking/cancel [cancelPicking()] iniciado");

  try {
    const picking = req.body;
    const userId = req.user && req.user.id;

    /* ==============================
       1️⃣ VALIDACIONES BÁSICAS
    ============================== */

    if (!userId) {
      console.log("🟨 cancelPicking() detenido | usuario no autenticado");
      return res.status(401).json({
        success: false,
        title: "Usuario no autenticado",
        message: "No se pudo identificar el usuario.",
      });
    }

    if (!picking || !picking.id) {
      console.log("🟨 cancelPicking() detenido | falta picking.id");
      return res.status(400).json({
        success: false,
        title: "ID requerido",
        message: "Debes enviar el id del picking.",
      });
    }

    await client.query("BEGIN");

    /* ==============================
       2️⃣ VALIDAR PERMISOS
    ============================== */

    const userResult = await client.query(
      `
      SELECT permissions
      FROM users
      WHERE id = $1
      LIMIT 1
      `,
      [userId]
    );

    if (userResult.rowCount === 0) {
      await client.query("ROLLBACK");
      console.log("🟨 usuario no existe");
      return res.status(404).json({
        success: false,
        title: "Usuario no encontrado",
        message: "No se encontró el usuario.",
      });
    }

    const permissions = userResult.rows[0].permissions || {};

    const canCancel =
      permissions.picking_warehouse &&
      permissions.picking_warehouse.cancel_orders === true;

    if (!canCancel) {
      await client.query("ROLLBACK");
      console.log("🟨 sin permisos para cancelar");
      return res.status(403).json({
        success: false,
        title: "Sin permisos",
        message: "No tienes permiso para anular pedidos.",
      });
    }

    /* ==============================
       3️⃣ BLOQUEAR PICKING
    ============================== */

    const pickingResult = await client.query(
      `
      SELECT id, state
      FROM stock_picking
      WHERE id = $1
      FOR UPDATE
      `,
      [picking.id]
    );

    if (pickingResult.rowCount === 0) {
      await client.query("ROLLBACK");
      console.log("🟨 picking no encontrado");
      return res.status(404).json({
        success: false,
        title: "Picking no encontrado",
        message: "No existe el picking.",
      });
    }

    const currentState = pickingResult.rows[0].state;

    if (currentState === "done") {
      await client.query("ROLLBACK");
      console.log("🟨 picking en estado done");
      return res.status(200).json({
        success: true,
        title: "Picking completado",
        message: "No se puede anular un picking completado.",
      });
    }

    if (currentState === "cancel") {
      await client.query("ROLLBACK");
      console.log("🟨 picking ya cancelado");
      return res.status(200).json({
        success: true,
        title: "Ya cancelado",
        message: "El picking ya estaba anulado.",
      });
    }

    /* ==============================
       4️⃣ CONTAR MOVE LINES
    ============================== */

    const moveLinesResult = await client.query(
      `
      SELECT COUNT(*) AS count
      FROM stock_move_line
      WHERE picking_id = $1
      `,
      [picking.id]
    );

    const moveLinesCount = moveLinesResult.rows[0].count;

    /* ==============================
       5️⃣ LIBERAR INVENTARIO (MASIVO)
    ============================== */

    const inventoryUpdate = await client.query(
      `
      UPDATE inventory_by_location ibl
      SET qty_reserved = GREATEST(ibl.qty_reserved - sub.total_qty, 0)
      FROM (
        SELECT
          sml.location_id,
          p.sku,
          SUM(sml.product_uom_qty) AS total_qty
        FROM stock_move_line sml
        JOIN products p ON p.id = sml.product_id
        WHERE sml.picking_id = $1
        GROUP BY sml.location_id, p.sku
      ) sub
      WHERE ibl.location_id = sub.location_id
      AND ibl.product_sku = sub.sku
      `,
      [picking.id]
    );

    /* ==============================
       6️⃣ CANCELAR MOVE LINES
    ============================== */

    const cancelMoveLines = await client.query(
      `
      UPDATE stock_move_line
      SET state = 'cancel'
      WHERE picking_id = $1
      `,
      [picking.id]
    );

    /* ==============================
       7️⃣ CANCELAR MOVES
    ============================== */

    const cancelMoves = await client.query(
      `
      UPDATE stock_move
      SET state = 'cancel'
      WHERE picking_id = $1
      `,
      [picking.id]
    );

    /* ==============================
       8️⃣ CANCELAR PICKING
    ============================== */

    const cancelPicking = await client.query(
      `
      UPDATE stock_picking
      SET state = 'cancel',
          user_id = NULL
      WHERE id = $1
      `,
      [picking.id]
    );

    await client.query("COMMIT");

    /* ==============================
       LOG FINAL
    ============================== */

    console.log(
      `🟨 Picking ID: ${picking.id} | Estado: ${currentState} | MoveLines: ${moveLinesCount} | ` +
      `Reservas liberadas: ${inventoryUpdate.rowCount} | ` +
      `Moves cancelados: ${cancelMoves.rowCount} | ` +
      `MoveLines canceladas: ${cancelMoveLines.rowCount}`
    );

    console.log("🟩 Endpoint POST /picking/cancel [cancelPicking()] terminado");

    return res.status(200).json({
      success: true,
      title: "Picking anulado",
      message: "El picking fue anulado correctamente.",
    });

  } catch (error) {
    await client.query("ROLLBACK");

    console.error("🟥 ERROR cancelPicking:", error);

    return res.status(500).json({
      success: false,
      title: "Error",
      message: "Ocurrió un error al anular el picking.",
    });
  } finally {
    client.release();
  }
};




// obtiene todos los picking de despacho y sus asignaciones
export async function getPickings(req, res) {
  try {

    console.log("🟥 Endpoint GET /picking/available-users [getPickings()] iniciado");
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    /* =========================
       1️⃣ TOTAL REGISTROS
    ========================= */
    const totalResult = await db.query(`
      SELECT COUNT(*) AS total
      FROM stock_picking
      WHERE state NOT IN ('done', 'cancel')
        AND picking_type = 'outgoing'
    `);

    const total = Number(totalResult.rows[0].total);

    /* =========================
       2️⃣ OBTENER PICKINGS
    ========================= */
    const pickingResult = await db.query(`
      SELECT id, name, user_id, erp_cliente, order_name
      FROM stock_picking
      WHERE state NOT IN ('done', 'cancel')
        AND picking_type = 'outgoing'
      ORDER BY id DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);

    const pickings = pickingResult.rows;

    if (pickings.length === 0) {
      return res.json({
        success: true,
        data: [],
        total,
        page,
        limit
      });
    }

    /* =========================
       3️⃣ IDS
    ========================= */
    const pickingIds = pickings.map(p => p.id);

    /* =========================
       4️⃣ PICKING ASSIGNMENTS
    ========================= */
    const assignmentResult = await db.query(`
      SELECT stock_picking_id, picker_id
      FROM picking_assignments
      WHERE stock_picking_id = ANY($1)
    `, [pickingIds]);

    const assignmentMap = new Map();

    assignmentResult.rows.forEach(row => {
      assignmentMap.set(
        Number(row.stock_picking_id),
        Number(row.picker_id)
      );
    });

    /* =========================
       5️⃣ PICKERS
    ========================= */
    const pickerIds = [...new Set(assignmentResult.rows.map(r => r.picker_id))];
    //console.log("PICKERS IDS:", pickerIds)
    let pickerMap = new Map();

    if (pickerIds.length > 0) {
      const pickerResult = await db.query(`
        SELECT id, user_id, active, active_today
        FROM pickers
        WHERE id = ANY($1)
      `, [pickerIds]);

      pickerResult.rows.forEach(row => {
        pickerMap.set(row.id, row);
      });
    }
    //console.log("PICKERS IDS:", pickerMap);
    /* =========================
       6️⃣ USERS
    ========================= */
    const userIds = [...new Set(
      Array.from(pickerMap.values()).map(p => p.user_id)
    )];

    //console.log("USERS:", userIds);

    let userMap = new Map();

    if (userIds.length > 0) {
      const userResult = await db.query(`
        SELECT id, full_name
        FROM users
        WHERE id = ANY($1)
      `, [userIds]);

      userResult.rows.forEach(row => {
        userMap.set(row.id, row.full_name);
      });
    }
    //console.log("NAMES:", userMap);
    /* =========================
       7️⃣ ENRIQUECER DATA
    ========================= */
    const result = pickings.map(p => {
      //console.log(p.id);
      //console.log(assignmentMap);
      const pickerId = assignmentMap.get(Number(p.id)) || null;
      const picker = pickerMap.get(pickerId);

      let pickerActive = false;
      let pickerName = null;
      //console.log(picker);
      if (picker) {
        //console.log("eliel");
        pickerActive = picker.active && picker.active_today;
        pickerName = userMap.get(picker.user_id) || null;
      }

      return {
        id: p.id,
        name: p.order_name,
        erp_cliente: p.erp_cliente,
        picker_id: pickerId,
        picker_active: pickerActive,
        picker_name: pickerName
      };
    });
    console.log(
      `🟨 Pickings: ${pickings.length} | Total: ${total} | Page: ${page} | Limit: ${limit} | Offset: ${offset} | Assignments: ${assignmentMap.size} | Pickers: ${pickerMap.size} | Users: ${userMap.size}`
    );
    console.log("🟩 Endpoint GET /picking/available-users [getPickings()] terminado");
    /* =========================
       8️⃣ RESPUESTA
    ========================= */
    return res.json({
      success: true,
      data: result,
      total,
      page,
      limit
    });

  } catch (error) {
    console.error("❌ ERROR GET PICKINGS:", error);
    return res.status(500).json({
      success: false,
      message: "ERROR_FETCHING_PICKINGS"
    });
  }
}



export async function updatePickerActiveToday(req, res) {

  try {

    const { pickerId, value } = req.body

    // -----------------------------
    // 1 VALIDACION BASICA
    // -----------------------------
    if (typeof pickerId !== "number") {
      return res.status(400).json({
        success: false,
        title: "Invalid pickerId",
        message: "pickerId must be a number"
      })
    }

    if (typeof value !== "boolean") {
      return res.status(400).json({
        success: false,
        title: "Invalid value",
        message: "value must be boolean"
      })
    }

    // -----------------------------
    // 2 BUSCAR PICKER
    // -----------------------------
    const pickerResult = await db.query(
      `
      SELECT id, active, user_id
      FROM pickers
      WHERE id = $1
      `,
      [pickerId]
    )

    if (pickerResult.rowCount === 0) {
      return res.json({
        success: false,
        title: "Picker not found",
        message: "The picker does not exist"
      })
    }

    const picker = pickerResult.rows[0]

    // -----------------------------
    // 3 VALIDAR ACTIVE
    // -----------------------------
    if (!picker.active) {
      return res.json({
        success: false,
        title: "Picker inactive",
        message: "This picker is not active"
      })
    }

    // -----------------------------
    // 4 VALIDAR USUARIO ACTIVO
    // -----------------------------
    const userResult = await db.query(
      `
      SELECT id
      FROM users
      WHERE id = $1
      AND is_active = true
      `,
      [picker.user_id]
    )

    if (userResult.rowCount === 0) {
      return res.json({
        success: false,
        title: "User inactive",
        message: "The user associated with this picker is not active"
      })
    }

    // -----------------------------
    // 5 UPDATE ACTIVE TODAY
    // -----------------------------
    await db.query(
      `
      UPDATE pickers
      SET active_today = $1
      WHERE id = $2
      `,
      [value, pickerId]
    )

    return res.json({
      success: true,
      title: "Updated",
      message: "Picker status updated successfully"
    })

  } catch (error) {

    console.error(error)

    return res.status(500).json({
      success: false,
      title: "Server error",
      message: "Unexpected error occurred"
    })

  }

}



export async function getAvailablePickers(req, res) {
  try {

    const userId = req.user.id;

    /* 1️⃣ Buscar usuario */
    const userResult = await db.query(
      `
      SELECT id, permissions
      FROM users
      WHERE id = $1
      AND is_active = true
      `,
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.json({
        success: false,
        title: "Usuario no existe",
        message: "Usuario no encontrado o inactivo"
      });
    }

    const permissions = userResult.rows[0].permissions;

    /* 2️⃣ Verificar permiso */
    if (!permissions?.picking_warehouse?.view_pickers) {
      return res.json({
        success: false,
        title: "Permiso denegado",
        message: "No tiene permiso para ver pickers"
      });
    }

    /* 3️⃣ Buscar usuarios disponibles */
    const usersResult = await db.query(
      `
      SELECT u.id, u.full_name
FROM users u
LEFT JOIN pickers p ON p.user_id = u.id
WHERE u.is_active = true
AND (p.user_id IS NULL OR p.active = false)
ORDER BY u.full_name;
      `
    );

    if (usersResult.rows.length === 0) {
      return res.json({
        success: false,
        title: "Sin usuarios disponibles",
        message: "No hay usuarios disponibles para agregar como picker"
      });
    }

    /* 4️⃣ Respuesta */
    res.status(200).json({
      success: true,
      data: usersResult.rows
    });

  } catch (error) {

    console.error("ERROR_FETCHING_AVAILABLE_PICKERS", error);

    res.status(500).json({
      success: false,
      title: "Error interno",
      message: "No se pudieron obtener los usuarios"
    });

  }
}



export async function addPickers(req, res) {
  try {

    const requesterId = req.user.id;
    const users = req.body.users;

    if (!Array.isArray(users) || users.length === 0) {
      return res.json({
        success: false,
        title: "Datos inválidos",
        message: "Debe enviar al menos un usuario"
      });
    }

    /* 1️⃣ validar usuario que hace la petición */

    const requester = await db.query(
      `
      SELECT id, permissions
      FROM users
      WHERE id = $1
      AND is_active = true
      `,
      [requesterId]
    );

    if (requester.rows.length === 0) {
      return res.json({
        success: false,
        title: "Usuario no existe",
        message: "Usuario no encontrado o inactivo"
      });
    }

    const permissions = requester.rows[0].permissions;

    /* 2️⃣ validar permiso */

    if (!permissions?.picking_warehouse?.manage_pickers) {
      return res.json({
        success: false,
        title: "Permiso denegado",
        message: "No tiene permiso para administrar pickers"
      });
    }

    /* 3️⃣ confirmar usuarios válidos */

    const validUsers = await db.query(
      `
      SELECT id
      FROM users
      WHERE id = ANY($1)
      AND is_active = true
      `,
      [users]
    );

    if (validUsers.rows.length === 0) {
      return res.json({
        success: false,
        title: "Usuarios no válidos",
        message: "No se encontraron usuarios activos"
      });
    }

    const validIds = validUsers.rows.map(u => u.id);

    /* 4️⃣ insert o activar picker */

    const result = await db.query(
      `
      INSERT INTO pickers (user_id, active, active_today)
      SELECT id, true, true
      FROM users
      WHERE id = ANY($1)
      ON CONFLICT (user_id)
      DO UPDATE SET
        active = true,
        active_today = true
      RETURNING user_id
      `,
      [validIds]
    );

    res.status(200).json({
      success: true,
      message: "Pickers agregados o reactivados correctamente",
      pickers: result.rows
    });

  } catch (error) {

    console.error("ERROR_ADDING_PICKERS", error);

    res.status(500).json({
      success: false,
      title: "Error interno",
      message: "No se pudieron agregar los pickers"
    });

  }
}



export async function removePicker(req, res) {
  try {

    const requesterId = req.user.id;
    const { picker_id } = req.body;

    if (!picker_id) {
      return res.json({
        success: false,
        title: "Datos inválidos",
        message: "Debe enviar picker_id"
      });
    }

    /* 1️⃣ Buscar usuario */
    const userResult = await db.query(
      `
      SELECT id, permissions
      FROM users
      WHERE id = $1
      AND is_active = true
      `,
      [requesterId]
    );

    if (userResult.rows.length === 0) {
      return res.json({
        success: false,
        title: "Usuario no existe",
        message: "Usuario no encontrado o inactivo"
      });
    }

    const permissions = userResult.rows[0].permissions;

    /* 2️⃣ Verificar permiso */
    if (!permissions?.picking_warehouse?.manage_pickers) {
      return res.status(403).json({
        success: false,
        title: "Permiso denegado",
        message: "No tiene permiso para administrar pickers"
      });
    }

    /* 3️⃣ Confirmar picker */
    const pickerResult = await db.query(
      `
      SELECT id
      FROM pickers
      WHERE id = $1
      AND active = true
      `,
      [picker_id]
    );

    if (pickerResult.rows.length === 0) {
      return res.json({
        success: false,
        title: "Picker no encontrado",
        message: "El picker no existe o ya está desactivado"
      });
    }

    /* 4️⃣ Desactivar picker */
    const update = await db.query(
      `
      UPDATE pickers
      SET active = false,
          active_today = false
      WHERE id = $1
      RETURNING id
      `,
      [picker_id]
    );

    res.status(200).json({
      success: true,
      message: "Picker desactivado correctamente",
      picker: update.rows[0]
    });

  } catch (error) {

    console.error("ERROR_REMOVING_PICKER", error);

    res.status(500).json({
      success: false,
      title: "Error interno",
      message: "No se pudo eliminar el picker"
    });

  }
}



export async function getAllPickers(req, res) {
  try {

    const requesterId = req.user.id;

    /* 1️⃣ validar usuario */
    const userResult = await db.query(
      `
      SELECT id, permissions
      FROM users
      WHERE id = $1
      AND is_active = true
      `,
      [requesterId]
    );

    if (userResult.rows.length === 0) {
      return res.json({
        success: false,
        title: "Usuario no existe",
        message: "Usuario no encontrado o inactivo"
      });
    }

    const permissions = userResult.rows[0].permissions;

    /* 2️⃣ validar permiso */
    if (!permissions?.picking_warehouse?.view_pickers) {
      return res.status(403).json({
        success: false,
        title: "Permiso denegado",
        message: "No tiene permiso para ver pickers"
      });
    }

    /* 3️⃣ buscar pickers activos */

    const result = await db.query(
      `
      SELECT 
        p.id,
        p.user_id,
        p.active_today,
        u.full_name
      FROM pickers p
      JOIN users u ON u.id = p.user_id
      WHERE p.active = true
      ORDER BY u.full_name
      `
    );

    res.status(200).json({
      success: true,
      data: result.rows
    });

  } catch (error) {

    console.error("ERROR_FETCHING_PICKERS", error);

    res.status(500).json({
      success: false,
      title: "Error interno",
      message: "No se pudieron obtener los pickers"
    });

  }
}