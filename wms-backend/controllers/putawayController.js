import { db } from "../db.js";
import { getActiveProductById, getPrimaryBarcodeBySku, getActiveProductBySku } from "../services/productService.js";
import { getActiveStorageLocationByCode, getUserActiveLocation, getActiveLocationByCodeAndType } from "../services/locationService.js";
import { moveInventoryBetweenLocations, createInventoryMovement } from "../services/inventoryService.js";

// CREATE A PUTAWAY LINE
export async function createPutawayLine(req, res) {

  console.log("ESTA ENTRANDO AL END POINT");
  console.log(req.body);
  const { productId, fromLocationId, qty } = req.body;
  const userId = req.user.id;

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    // ✅ USO DEL SERVICIO
    const product = await getActiveProductById(client, productId);

    if (!product) {
      throw { code: "PRODUCT_NOT_FOUND_OR_INACTIVE" };
    }

    console.log("Producto válido:", product);




    // 1️⃣ Validar sesión activa
    const sessionResult = await client.query(`
      SELECT id
      FROM putaway_sessions
      WHERE user_id = $1
        AND status IN ('picking','putting')
      LIMIT 1
      FOR UPDATE
    `, [userId]);

    if (sessionResult.rowCount === 0) {
      throw { code: "NO_ACTIVE_SESSION" };
    }

    const sessionId = sessionResult.rows[0].id;
    console.log(sessionId);

    // 2️⃣ Validar que from_location es RECEIVING
    const locResult = await client.query(`
      SELECT id, location_type
      FROM locations
      WHERE id = $1 AND is_active = true
    `, [fromLocationId]);

    if (locResult.rowCount === 0 || locResult.rows[0].location_type !== "RECEIVING") {
      throw { code: "INVALID_RECEIVING_LOCATION" };
    }

    console.log("UBICACION", locResult.rows);

    // 3️⃣ Validar stock disponible (usando qty_available)
    const stockResult = await client.query(`
  SELECT qty_on_hand, qty_reserved, qty_available
  FROM inventory_by_location
  WHERE product_sku = $1 AND location_id = $2
  FOR UPDATE
`, [product.sku, fromLocationId]);

    if (stockResult.rowCount === 0 || Number(stockResult.rows[0].qty_available) < Number(qty)) {
      throw { code: "QTY_EXCEEDS_RECEIVING" };
    }

    const inventoryRow = stockResult.rows[0];


    console.log("CANTIDAD DISPONIBLES", stockResult.rows[0].qty_on_hand);


    const userLocation = await getUserActiveLocation(client, req.user.id);

    if (!userLocation) {
      return res.status(404).json({
        success: false,
        error: "USER_LOCATION_NOT_FOUND"
      });
    }
    console.log("SE BUSCO LA UBICACION DEL USUARIO: ", userLocation);

    // 4️⃣ Buscar si ya existe linea
    const existingLineResult = await client.query(`
      SELECT id, picked_qty, remaining_qty, status
      FROM putaway_lines
      WHERE putaway_session_id = $1
        AND product_id = $2
        AND from_location_id = $3
        AND status IN ('picked','partial')
      FOR UPDATE
    `, [sessionId, productId, fromLocationId]);

    console.log("CEHQUIAR SI LA LINEA EXISTE", existingLineResult);
    // Si existe entonces sumarle
    if (existingLineResult.rowCount > 0) {
      const line = existingLineResult.rows[0];

      const newPickedQty = Number(line.picked_qty) + Number(qty);

      const updateResult = await client.query(`
        UPDATE putaway_lines
        SET picked_qty = $1,
            remaining_qty = $1,
            to_location_id = $2,
            status = 'picked'
        WHERE id = $3
        RETURNING *
      `, [newPickedQty, userLocation.id, line.id]);


      console.log("SE actualizo la linea: ", userLocation);

      //Aqui luego se puede buscar la informacion del almacen del usuario
      const warehouseId = 1;

      await moveInventoryBetweenLocations(client, {
        warehouseId: warehouseId,
        productSku: product.sku,
        fromLocationId: fromLocationId,
        toLocationId: userLocation.id,
        qty: qty
      });


      await client.query("COMMIT");

      return res.json({
        success: true,
        line: updateResult.rows[0],
        mode: "updated"
      });
    }

    // Si no existe entonces crear
    console.log("SE INICIA LA CREACION DE LA LINEA");
    const insertResult = await client.query(`
  INSERT INTO putaway_lines
  (putaway_session_id, product_id, from_location_id, to_location_id, picked_qty, remaining_qty, status)
  VALUES ($1, $2, $3, $4, $5, $5, 'picked')
  RETURNING *
`, [sessionId, productId, fromLocationId, userLocation.id, qty]);


    console.log("SE CREO YA UNA LINEA: ", insertResult);

    //Aqui luego se puede buscar la informacion del almacen del usuario
    const warehouseId = 1;

    await moveInventoryBetweenLocations(client, {
      warehouseId: warehouseId,
      productSku: product.sku,
      fromLocationId: fromLocationId,
      toLocationId: userLocation.id,
      qty: qty
    });



    await client.query("COMMIT");

    res.json({
      success: true,
      line: insertResult.rows[0]
    });

  } catch (err) {
    await client.query("ROLLBACK");

    res.status(400).json({
      success: false,
      error: err.code || "PUTAWAY_ERROR"
    });
  } finally {
    client.release();
  }
}



// CONFIRM A PRODUCT
export async function scanPutawayProduct(req, res) {
  try {
    const { barcode } = req.body;

    if (!barcode) {
      return res.status(400).json({
        success: false,
        message: "Barcode requerido"
      });
    }

    // 1️⃣ Buscar producto por barcode
    const productResult = await db.query(
      `
      SELECT p.id, p.sku, p.description, p.uom
      FROM product_barcodes pb
      JOIN products p ON p.sku = pb.product_sku
      WHERE pb.barcode = $1
      LIMIT 1
      `,
      [barcode]
    );

    if (productResult.rowCount === 0) {
      return res.json({
        success: false,
        message: "Producto no existe"
      });
    }

    const product = productResult.rows[0];

    // 2️⃣ Buscar inventario en ubicaciones de recepción con stock disponible
    const locationResult = await db.query(
      `
      SELECT 
        ibl.location_id,
        l.code AS location_code,
        ibl.qty_available
      FROM inventory_by_location ibl
      JOIN locations l ON l.id = ibl.location_id
      WHERE ibl.product_sku = $1
        AND ibl.qty_available > 0
        AND l.location_type = 'RECEIVING'
      ORDER BY ibl.qty_available DESC
      `,
      [product.sku]
    );


    if (locationResult.rowCount === 0) {
      return res.json({
        success: false,
        message: "Producto no está en recepción"
      });
    }

    // 3️⃣ Respuesta final
    return res.json({
      success: true,
      product,
      locations: locationResult.rows
    });

  } catch (error) {
    console.error("❌ scanPutawayProduct:", error);
    return res.status(500).json({
      success: false,
      message: "Error escaneando producto"
    });
  }
}


// VERIFY IF AN USER HAS AN ACTIVE SESSION + RECEIVING LOCATIONS
export async function getActivePutawaySessionExtended(req, res) {
  try {
    const userId = req.user.id; // viene del authMiddleware

    // 1️⃣ Buscar sesión activa
    const sessionResult = await db.query(
      `
      SELECT id, status, started_at, warehouse_id
      FROM putaway_sessions
      WHERE user_id = $1
        AND status NOT IN ('completed', 'cancelled')
      ORDER BY started_at DESC
      LIMIT 1
      `,
      [userId]
    );

    // 2️⃣ Buscar ubicaciones de RECEPCIÓN activas
    const locationsResult = await db.query(
      `
      SELECT id, code
      FROM locations
      WHERE location_type = 'RECEIVING'
        AND is_active = true
      ORDER BY code ASC
      `
    );

    // Si NO hay sesión
    if (sessionResult.rows.length === 0) {
      return res.json({
        success: true,
        hasSession: false
      });
    }

    // Si SÍ hay sesión
    return res.json({
      success: true,
      hasSession: true,
      session: sessionResult.rows[0],
      receivingLocations: locationsResult.rows
    });

  } catch (error) {
    console.error("❌ getActivePutawaySession:", error);
    return res.status(500).json({
      success: false,
      message: "Error checking active putaway session"
    });
  }
}



// VERIFY IF AN USER HAS AN ACTIVE SESSION
export async function getActivePutawaySession(req, res) {
  try {
    const userId = req.user.id; // viene del authMiddleware

    const { rows } = await db.query(
      `
      SELECT id, status, started_at
      FROM putaway_sessions
      WHERE user_id = $1
        AND status NOT IN ('completed', 'cancelled')
      ORDER BY started_at DESC
      LIMIT 1
      `,
      [userId]
    );

    if (rows.length === 0) {
      return res.json({
        success: true,
        hasSession: false
      });
    }

    return res.json({
      success: true,
      hasSession: true,
      session: rows[0]
    });

  } catch (error) {
    console.error("❌ getActivePutawaySession:", error);
    return res.status(500).json({
      success: false,
      message: "Error checking active putaway session"
    });
  }
}



// START A PUTAWAY SESSION FOR A USER
export async function startingPutaway(req, res) {
  try {
    const userId = req.user.id; // viene del authMiddleware

    if (!userId) {
      return res.status(401).json({
        success: false,
        code: "NO_USER",
        message: "Usuario no autenticado"
      });
    }

    // 1️⃣ Buscar sesión activa
    const activeSession = await db.query(`
      SELECT *
      FROM putaway_sessions
      WHERE user_id = $1
        AND status NOT IN ('completed', 'cancelled')
      ORDER BY started_at DESC
      LIMIT 1
    `, [userId]);

    if (activeSession.rowCount > 0) {
      return res.json({
        success: true,
        alreadyExists: true,
        session: activeSession.rows[0]
      });
    }

    // 2️⃣ Crear nueva sesión
    const newSession = await db.query(`
      INSERT INTO putaway_sessions
        (user_id, status)
      VALUES
        ($1, 'picking')
      RETURNING *
    `, [userId]);

    return res.status(201).json({
      success: true,
      alreadyExists: false,
      session: newSession.rows[0]
    });

  } catch (error) {
    console.error("Error starting putaway session:", error);
    return res.status(500).json({
      success: false,
      code: "START_PUTAWAY_ERROR",
      message: "Error iniciando sesión de putaway"
    });
  }
}


// GET ALL PENDING PUTAWAY LINES FOR A USER
export async function getPendingPutaway(req, res) {
  try {
    console.log("🔥 GET /putaway/pending funcionando");

    // 👉 si usas authMiddleware, normalmente viene de req.user
    const userId = req.user?.id || req.query.userId;
    console.log("🔥", userId);
    if (!userId) {
      return res.status(400).json({
        success: false,
        code: "USER_REQUIRED",
        message: "User id requerido"
      });
    }

    // 1️⃣ Buscar sesión activa de putaway del usuario
    const sessionResult = await db.query(`
      SELECT id
      FROM putaway_sessions
      WHERE user_id = $1
        AND status IN ('picking','putting')
      ORDER BY started_at DESC
      LIMIT 1
    `, [userId]);

    if (sessionResult.rowCount === 0) {
      return res.json({
        success: true,
        data: [],
        session: null
      });
    }

    const putawaySessionId = sessionResult.rows[0].id;

    // 2️⃣ Buscar líneas pendientes (NO completed)
    const linesResult = await db.query(`
      SELECT
        pl.id,
        p.sku,
        p.description,
        p.uom,
        pl.picked_qty,
        pl.remaining_qty AS pending_qty
      FROM putaway_lines pl
      JOIN products p ON p.id = pl.product_id
      WHERE pl.putaway_session_id = $1
        AND pl.status IN ('picked','partial')
      ORDER BY p.sku;
    `, [putawaySessionId]);

    const enrichedLines = [];

    for (const line of linesResult.rows) {
      const barcodeResult = await getPrimaryBarcodeBySku(db, line.sku);

      enrichedLines.push({
        ...line,
        barcode: barcodeResult.rowCount > 0 ? barcodeResult.rows[0].barcode : null
      });
    }

    // 3️⃣ Responder al frontend
    return res.json({
      success: true,
      sessionId: putawaySessionId,
      totalLines: enrichedLines.length,
      data: enrichedLines
    });


  } catch (error) {
    console.error("❌ Error en getPendingPutaway:", error);

    return res.status(500).json({
      success: false,
      code: "INTERNAL_ERROR",
      message: "Error buscando putaway pendientes"
    });
  }
}

// GET A LOCATION ACTIVE USING A BARCODE
export async function scanPutawayLocation(req, res) {
  try {
    const { code } = req.body;
    console.log(code);

    if (!code) {
      return res.status(400).json({
        success: false,
        message: "Código requerido"
      });
    }

    const result = await getActiveStorageLocationByCode(db, code);
    console.log("RESULTADO", result);
    if (result.rowCount === 0) {
      return res.json({
        success: false,
        code: "INVALID_STORAGE_LOCATION",
        message: "Ubicación no válida"
      });
    }

    console.log(result);

    return res.json({
      success: true,
      location: result.rows[0]
    });

  } catch (error) {
    console.error("❌ scanPutawayLocation:", error);
    return res.status(500).json({
      success: false,
      message: "Error buscando ubicación"
    });
  }
}


// GET A LOCATION ACTIVE USING A BARCODE
export async function dropPutaway(req, res) {
  // controllers/putaway.controller.js
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const userId = req.user.id; // asumiendo auth middleware
    console.log("ID ID ID ID ID ID", userId);
    console.log("REQ.USER:", req.user);

    const { putaway_session_id, product_id, to_location_code, qty } = req.body;

    /* -----------------------------
       1️⃣ Validar qty
    ------------------------------*/
    if (!qty || qty <= 0 || !Number.isInteger(Number(qty))) {
      return res.status(400).json({
        code: "INVALID_QTY",
        message: "qty debe ser un entero mayor que 0"
      });
    }

    /* -----------------------------
       2️⃣ Validar sesión activa
    ------------------------------*/
    const sessionResult = await db.query(
      `
      SELECT id, status, user_id
      FROM putaway_sessions
      WHERE id = $1
      `,
      [putaway_session_id]
    );

    if (sessionResult.rowCount === 0) {
      return res.status(404).json({
        code: "SESSION_NOT_FOUND",
        message: "La sesión no existe"
      });
    }

    const session = sessionResult.rows[0];
    console.log("SESSION OBTENIDA", session);
    if (Number(session.user_id) !== userId) {
      return res.status(403).json({
        code: "SESSION_NOT_OWNED",
        message: "La sesión no pertenece al usuario"
      });
    }

    if (!["picking", "putting"].includes(session.status)) {
      return res.status(400).json({
        code: "SESSION_NOT_ACTIVE",
        message: "La sesión no está activa"
      });
    }

    /* -----------------------------
       3️⃣ Obtener dock del usuario
    ------------------------------*/
    const userLocation = await getUserActiveLocation(client, req.user.id);

    if (!userLocation) {
      return res.status(404).json({
        success: false,
        error: "USER_LOCATION_NOT_FOUND"
      });
    }
    console.log("SE BUSCO LA UBICACION DEL USUARIO: ", userLocation);
    console.log("alerta alerta", userLocation);
    const dockLocationId = Number(userLocation.id);

    /* -----------------------------
       4️⃣ Validar ubicación destino
    ------------------------------*/
    const locationResult = await getActiveLocationByCodeAndType(
      client,
      to_location_code,
      "STORAGE"
    );

    if (locationResult.rowCount === 0) {
      return res.status(400).json({
        code: "INVALID_STORAGE_LOCATION",
        message: "Ubicación destino inválida"
      });
    }

    const toLocation = locationResult.rows[0];
    console.log(toLocation);

    /* -----------------------------
   4️⃣ Traer líneas disponibles en dock (FOR UPDATE)
------------------------------*/
    //Buscar producto usando solo sku
    const product = await getActiveProductBySku(client, product_id);

    if (!product) {
      return res.status(404).json({
        code: "PRODUCT_NOT_FOUND",
        message: "Producto no existe o no está activo"
      });
    }

    console.log("PRODUCTO RESUELTO:", product);

    // 👉 ya tienes:
    const productId = product.id;



    console.log("PUTAWAY SESSION ID", putaway_session_id);
    console.log("product id", productId);
    console.log("UBICACION DE USUARIO", dockLocationId)
    const linesResult = await client.query(
      `
  SELECT
    pl.id,
    pl.putaway_session_id,
    pl.product_id,
    pl.from_location_id,
    pl.to_location_id,
    pl.picked_qty,
    pl.remaining_qty
  FROM putaway_lines pl
  WHERE pl.putaway_session_id = $1
    AND pl.product_id = $2
    AND pl.to_location_id = $3       -- dock del usuario (ajusta si tu modelo usa otra columna)
    AND pl.status IN ('picked','partial')
  ORDER BY pl.id
  FOR UPDATE
  `,
      [putaway_session_id, productId, dockLocationId]
    );
    if (linesResult.rowCount === 0) {
      return res.status(400).json({
        code: "NO_LINES_IN_DOCK",
        message: "No hay líneas disponibles de este producto en el dock"
      });
    }

    const availableLines = linesResult.rows;

    console.log("📦 LÍNEAS DISPONIBLES EN DOCK:", availableLines);

    /* -----------------------------
   5️⃣ Consumir cantidades una por una (loop)
------------------------------*/
    const totalRemaining = availableLines.reduce(
      (sum, l) => sum + Number(l.remaining_qty),
      0
    );

    if (Number(qty) > totalRemaining) {
      throw {
        code: "QTY_EXCEEDS_PENDING_IN_DOCK",
        message: "Cantidad mayor que el total pendiente en dock"
      };
    }

    let qtyToDrop = Number(qty);

    for (const line of availableLines) {
      if (qtyToDrop <= 0) break;

      const currentRemaining = Number(line.remaining_qty);

      if (currentRemaining <= 0) continue;

      const take = Math.min(currentRemaining, qtyToDrop);

      const newRemaining = currentRemaining - take;
      const newStatus = newRemaining === 0 ? "completed" : "partial";

      // 🔁 actualizar línea
      await client.query(`
    UPDATE putaway_lines
    SET remaining_qty = $1,
        status = $2,
        updated_at = now()
    WHERE id = $3
  `, [newRemaining, newStatus, line.id]);

      // 🧾 trazabilidad
      await client.query(`
    INSERT INTO putaway_drop_lines
      (putaway_session_id, putaway_line_id, product_id, to_location_id, qty_dropped, status, created_by_user_id)
    VALUES
      ($1, $2, $3, $4, $5, 'confirmed', $6)
  `, [
        putaway_session_id,
        line.id,
        productId,
        toLocation.id,
        take,
        userId
      ]);

      qtyToDrop -= take;
    }

    /* -----------------------------
       6️⃣ Validar si alcanzó la cantidad solicitada
    ------------------------------*/

    if (qtyToDrop > 0) {
      throw {
        code: "QTY_EXCEEDS_PENDING_IN_DOCK",
        message: "No hay suficiente cantidad pendiente en el dock"
      };
    }


    /* -----------------------------
   7️⃣ Mover inventario del dock a storage
------------------------------*/

    await moveInventoryBetweenLocations(client, {
      warehouseId: toLocation.warehouse_id,
      productSku: product.sku,
      fromLocationId: dockLocationId,
      toLocationId: toLocation.id,
      qty: Number(qty)
    });

    /* -----------------------------
       8️⃣ Registrar movimiento de inventario
    ------------------------------*/
    console.log("CANTIDAD",qty);
    await createInventoryMovement(client, {
      productSku: product.sku,
      fromLocationId: dockLocationId,
      toLocationId: toLocation.id,
      qty: Number(qty),
      movementType: "MOVE",
      referenceType: "PUTAWAY",
      referenceId: String(putaway_session_id),
      createdBy: userId,
      note: `Putaway drop a ubicación ${toLocation.code}`
    });


    /* -----------------------------
       9️⃣ Cerrar sesión si ya no quedan líneas pendientes
    ------------------------------*/

    await client.query(`
      UPDATE putaway_sessions
      SET status = 'completed', completed_at = now()
      WHERE id = $1
        AND NOT EXISTS (
          SELECT 1 FROM putaway_lines
          WHERE putaway_session_id = $1
            AND status IN ('picked','partial')
        )
    `, [putaway_session_id]);

    await client.query("COMMIT");

    console.log("Si llega aquí, todo está OK")

    return res.status(200).json({
      success: true,
      message: "Validaciones correctas",
      data: {
        session,
        dock_location_id: dockLocationId,
        to_location: toLocation,
        product_id,
        qty: Number(qty)
      }
    });

  } catch (error) {
    await client.query("ROLLBACK");

    if (error?.code) {
      return res.status(400).json(error);
    }

    console.error("❌ PUTAWAY DROP ERROR:", error);

    return res.status(500).json({
      code: "SERVER_ERROR",
      message: "Error interno"
    });
  }

};

