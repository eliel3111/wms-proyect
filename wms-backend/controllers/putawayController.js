import { db } from "../db.js";
import { getActiveProductById, getPrimaryBarcodeBySku } from "../services/productService.js";
import { getActiveStorageLocationByCode, getUserActiveLocation } from "../services/locationService.js";
import { moveInventoryBetweenLocations } from "../services/inventoryService.js";

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
    console.log(code.length);

    if (!code) {
      return res.status(400).json({
        success: false,
        message: "Código requerido"
      });
    }

    const result = await getActiveStorageLocationByCode(db, code);

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




