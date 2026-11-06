import { db } from "../db.js";
import { getActiveProductById, getPrimaryBarcodeBySku, getActiveProductBySku } from "../services/productService.js";
import { getActiveStorageLocationByCode, getUserActiveLocation, getActiveLocationByCodeAndType } from "../services/locationService.js";
import { moveInventoryBetweenLocations, createInventoryMovement } from "../services/inventoryService.js";

// CREATE A PUTAWAY LINE
export async function createPutawayLine(req, res) {

  console.log("========================================");
  console.log("🚀 CREATE PUTAWAY LINE");
  console.log("========================================");

  console.log("📥 BODY:", req.body);
  console.log("👤 USER:", req.user);
  const { productId, fromLocationId, qty } = req.body;
  const userId = req.user.id;
  const numericQty = Number(qty);

  console.log("📦 PRODUCT ID:", productId);
  console.log("📍 FROM LOCATION:", fromLocationId);
  console.log("🔢 QTY ORIGINAL:", qty);
  console.log("🔢 QTY NUMBER:", numericQty);
  console.log("🔢 QTY TYPE:", typeof qty);

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

    console.log("📄 SESSION RESULT:", sessionResult.rows);

    if (sessionResult.rowCount === 0) {
      console.log("❌ NO ACTIVE SESSION");
      throw { code: "NO_ACTIVE_SESSION" };
    }

    const sessionId = sessionResult.rows[0].id;
    console.log("✅ SESSION ID:", sessionId);
//--------------------------------------------------------------
    const locResult = await client.query(`
  SELECT
      id,
      warehouse_id,
      location_type
  FROM locations
  WHERE id = $1
    AND is_active = true
`, [fromLocationId]);

if (
  locResult.rowCount === 0 ||
  locResult.rows[0].location_type !== "RECEIVING"
) {
  console.log("❌ INVALID RECEIVING LOCATION");
  throw { code: "INVALID_RECEIVING_LOCATION" };
}

const sourceWarehouseId =
  Number(locResult.rows[0].warehouse_id);

console.log("📍 LOCATION RESULT:", locResult.rows);
console.log("🏬 SOURCE WAREHOUSE:", sourceWarehouseId);

//-------------------------------------------------------

    // 3️⃣ Validar stock disponible (usando qty_available)
    const stockResult = await client.query(`
  SELECT qty_on_hand, qty_reserved, qty_available
  FROM inventory_by_location
  WHERE product_sku = $1 AND location_id = $2
  FOR UPDATE
`, [product.sku, fromLocationId]);

    console.log("📦 STOCK RESULT:", stockResult.rows);

    if (stockResult.rowCount === 0 || Number(stockResult.rows[0].qty_available) < Number(qty)) {
      throw { code: "QTY_EXCEEDS_RECEIVING" };
    }

    const inventoryRow = stockResult.rows[0];

    console.log("📦 INVENTARIO ENCONTRADO");

    console.log("📦 QTY ON HAND:", stockResult.rows[0].qty_on_hand);
    console.log("📦 QTY RESERVED:", stockResult.rows[0].qty_reserved);
    console.log("📦 QTY AVAILABLE:", stockResult.rows[0].qty_available);





    const userLocation =
    await getUserActiveLocation(
        client,
        req.user.id,
        sourceWarehouseId
    );
    console.log("📍 USER LOCATION:", userLocation);
    if (!userLocation) {
      console.log("❌ USER LOCATION NOT FOUND");
      return res.status(404).json({
        success: false,
        error: "USER_LOCATION_NOT_FOUND"
      });
    }
    console.log("✅ USER LOCATION VALIDADA");

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

    console.log("📄 EXISTING LINE RESULT:", existingLineResult.rows);
    // Si existe entonces sumarle
    if (existingLineResult.rowCount > 0) {
      console.log("🟡 EXISTE LINEA, ACTUALIZANDO");
      const line = existingLineResult.rows[0];


      console.log("📄 LINE:", line);
      const newPickedQty = Number(line.picked_qty) + Number(qty);
      console.log("🔢 NEW PICKED QTY:", newPickedQty);
      const updateResult = await client.query(`
        UPDATE putaway_lines
        SET picked_qty = $1,
            remaining_qty = $1,
            to_location_id = $2,
            status = 'picked'
        WHERE id = $3
        RETURNING *
      `, [newPickedQty, userLocation.id, line.id]);



      console.log("✅ LINEA ACTUALIZADA", userLocation);
      console.log("📄 UPDATE RESULT:", updateResult.rows);

      //Aqui luego se puede buscar la informacion del almacen del usuario
      const warehouseId = Number(userLocation.warehouse_id);

      console.log("========================================");
      console.log("🚚 INICIANDO MOVIMIENTO INVENTARIO");
      console.log("========================================");

      console.log({
        warehouseId,
        productSku: product.sku,
        fromLocationId,
        toLocationId: userLocation.id,
        qty: numericQty
      });

      try {

        const movementResult =
          await moveInventoryBetweenLocations(client, {
            warehouseId: sourceWarehouseId,
            productSku: product.sku,
            fromLocationId,
            toLocationId: userLocation.id,
            qty: numericQty
          });

        console.log("✅ MOVIMIENTO EXITOSO");
        console.log("📦 MOVEMENT RESULT:", movementResult);

      } catch (movementError) {

        console.log("========================================");
        console.log("🔥 ERROR EN MOVIMIENTO INVENTARIO");
        console.log("========================================");

        console.log("❌ ERROR:", movementError);
        console.log("❌ ERROR MESSAGE:", movementError.message);
        console.log("❌ ERROR CODE:", movementError.code);
        console.log("❌ ERROR STACK:", movementError.stack);

        throw movementError;
      }


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

  const warehouseId = Number(userLocation.warehouse_id);

    await moveInventoryBetweenLocations(client, {
      warehouseId: sourceWarehouseId,
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
    console.log("================================");
    console.log("📦 PUT AWAY | PRODUCTO ESCANEADO");
    console.log("BARCODE:", barcode);
    console.log("TIPO:", typeof barcode);
    console.log("================================");

    if (!barcode) {
      return res.status(400).json({
        success: false,
        message: "Barcode requerido"
      });
    }

    // ==============================
    // 1️⃣ Buscar producto por barcode
    // ==============================
    let productResult = await db.query(
      `
  SELECT p.id, p.sku, p.description, p.uom
  FROM product_barcodes pb
  JOIN products p ON p.sku = pb.product_sku
  WHERE UPPER(pb.barcode) = UPPER($1)
  LIMIT 1
  `,
      [barcode]
    );

    // ==============================
    // 2️⃣ Si no existe barcode → buscar SKU
    // ==============================
    if (productResult.rowCount === 0) {

      console.log("⚠️ Barcode no encontrado, buscando SKU...");

      productResult = await db.query(
        `
    SELECT id, sku, description, uom
    FROM products
    WHERE UPPER(sku) = UPPER($1)
    LIMIT 1
    `,
        [barcode]
      );
    }

    // ==============================
    // 3️⃣ Producto no existe
    // ==============================
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
      console.log("🟩🟩 BARCODES: ", barcodeResult.rows);
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


// ============================================================
// DROP PUTAWAY
// CONTROLLER ORIGINAL + LOGS DE DIAGNÓSTICO
// ============================================================

export async function dropPutaway(req, res) {

  console.log(
    "\x1b[45m\x1b[37m\x1b[1m 🚚 INICIANDO DROP PUTAWAY \x1b[0m"
  );

  console.log("🕒 FECHA:", new Date().toISOString());
  console.log("🌐 ENDPOINT:", req.method, req.originalUrl || req.url);

  let client = null;
  let transactionStarted = false;

  try {

    // =========================================================
    // 1️⃣ DATOS DEL REQUEST
    // =========================================================

    const userId = Number(req.user.id);

    const {
      putaway_session_id,
      product_id,
      to_location_code,
      qty
    } = req.body;

    const qtyNumber = Number(qty);

    console.log(
      "\x1b[44m\x1b[37m\x1b[1m 📥 [DEBUG 01] REQUEST RECIBIDO \x1b[0m"
    );

    console.log("========================================");
    console.log("🚚 DROP PUTAWAY");
    console.log("========================================");

    console.log("USER ID:", userId);
    console.log("PUTAWAY SESSION:", putaway_session_id);
    console.log("PRODUCT:", product_id);
    console.log("TO LOCATION:", to_location_code);
    console.log("QTY:", qtyNumber);

    console.log("📦 REQUEST BODY:", {
      putaway_session_id,
      product_id,
      to_location_code,
      qty
    });

    console.log("🔍 TIPOS DE DATOS:", {
      userId: typeof userId,
      putaway_session_id: typeof putaway_session_id,
      product_id: typeof product_id,
      to_location_code: typeof to_location_code,
      qty: typeof qty,
      qtyNumber: typeof qtyNumber
    });

    // =========================================================
    // 2️⃣ VALIDAR QTY
    // =========================================================

    console.log(
      "\x1b[44m\x1b[37m 📊 [DEBUG 02] VALIDANDO CANTIDAD \x1b[0m"
    );

    console.log({
      qtyOriginal: qty,
      qtyNumber,
      isInteger: Number.isInteger(qtyNumber),
      greaterThanZero: qtyNumber > 0
    });

    if (
      !Number.isInteger(qtyNumber) ||
      qtyNumber <= 0
    ) {

      console.log(
        "\x1b[41m\x1b[37m ❌ INVALID_QTY \x1b[0m"
      );

      return res.status(400).json({
        success: false,
        code: "INVALID_QTY",
        message: "qty debe ser un entero mayor que 0"
      });

    }

    console.log("✅ CANTIDAD VALIDADA");

    // =========================================================
    // 3️⃣ OBTENER CONEXIÓN
    // =========================================================

    console.log(
      "\x1b[46m\x1b[30m 🔌 [DEBUG 03] OBTENIENDO DB CLIENT \x1b[0m"
    );

    console.log("📊 DB POOL ANTES:", {
      total: db.totalCount,
      idle: db.idleCount,
      waiting: db.waitingCount
    });

    client = await db.connect();

    console.log("✅ DB CLIENT OBTENIDO");

    console.log("📊 DB POOL DESPUÉS:", {
      total: db.totalCount,
      idle: db.idleCount,
      waiting: db.waitingCount
    });

    // =========================================================
    // 4️⃣ INICIAR TRANSACCIÓN
    // =========================================================

    console.log(
      "\x1b[46m\x1b[30m 🔄 [DEBUG 04] INICIANDO TRANSACCIÓN \x1b[0m"
    );

    await client.query("BEGIN");

    transactionStarted = true;

    console.log("🟢 BEGIN PUTAWAY");

    console.log("🔒 TRANSACTION STARTED:", transactionStarted);

    // =========================================================
    // 5️⃣ VALIDAR SESIÓN
    // =========================================================

    console.log(
      "\x1b[44m\x1b[37m 🔍 [DEBUG 05] BUSCANDO PUTAWAY SESSION \x1b[0m"
    );

    console.log("📋 SESSION ID:", putaway_session_id);

    console.log("🧾 SQL:");
    console.log(`
      SELECT id, status, user_id
      FROM putaway_sessions
      WHERE id = ${putaway_session_id}
      FOR UPDATE
    `);

    const sessionResult = await client.query(
      `
      SELECT
        id,
        status,
        user_id

      FROM putaway_sessions

      WHERE id = $1

      FOR UPDATE
      `,
      [
        putaway_session_id
      ]
    );

    console.log("📊 SESSION ROWCOUNT:", sessionResult.rowCount);
    console.log("📊 SESSION ROWS:", sessionResult.rows);

    if (sessionResult.rowCount === 0) {

      console.log(
        "\x1b[41m\x1b[37m ❌ SESSION_NOT_FOUND \x1b[0m"
      );

      throw {
        status: 404,
        code: "SESSION_NOT_FOUND",
        message: "La sesión no existe"
      };

    }

    const session = sessionResult.rows[0];

    console.log("✅ SESSION OBTENIDA:", session);

    console.log("🔍 SESSION DETAILS:", {
      sessionId: session.id,
      sessionStatus: session.status,
      sessionUserId: session.user_id,
      authenticatedUserId: userId
    });

    // =========================================================
    // 6️⃣ VALIDAR PROPIEDAD DE SESIÓN
    // =========================================================

    console.log(
      "\x1b[44m\x1b[37m 👤 [DEBUG 06] VALIDANDO USUARIO \x1b[0m"
    );

    console.log("USER ID TOKEN:", userId);
    console.log("SESSION USER ID:", session.user_id);

    console.log(
      "¿SON IGUALES?:",
      Number(session.user_id) === userId
    );

    if (
      Number(session.user_id) !==
      userId
    ) {

      console.log(
        "\x1b[41m\x1b[37m ❌ SESSION_NOT_OWNED \x1b[0m"
      );

      throw {
        status: 403,
        code: "SESSION_NOT_OWNED",
        message: "La sesión no pertenece al usuario"
      };

    }

    console.log("✅ LA SESIÓN PERTENECE AL USUARIO");

    // =========================================================
    // 7️⃣ VALIDAR ESTADO DE SESIÓN
    // =========================================================

    console.log(
      "\x1b[44m\x1b[37m 📋 [DEBUG 07] VALIDANDO ESTADO \x1b[0m"
    );

    console.log("STATUS ACTUAL:", session.status);
    console.log("STATUS PERMITIDOS:", ["picking", "putting"]);

    if (
      ![
        "picking",
        "putting"
      ].includes(session.status)
    ) {

      console.log(
        "\x1b[41m\x1b[37m ❌ SESSION_NOT_ACTIVE \x1b[0m"
      );

      throw {
        status: 400,
        code: "SESSION_NOT_ACTIVE",
        message: "La sesión no está activa"
      };

    }

    console.log("✅ STATUS DE SESIÓN VÁLIDO");

    // =========================================================
    // 8️⃣ VALIDAR UBICACIÓN DESTINO
    // =========================================================

    console.log(
      "\x1b[44m\x1b[37m 📍 [DEBUG 08] BUSCANDO STORAGE DESTINO \x1b[0m"
    );

    console.log("📍 CODE:", to_location_code);
    console.log("📍 LOCATION TYPE:", "STORAGE");

    const locationResult =
      await getActiveLocationByCodeAndType(
        client,
        to_location_code,
        "STORAGE"
      );

    console.log("📊 LOCATION ROWCOUNT:", locationResult.rowCount);
    console.log("📊 LOCATION ROWS:", locationResult.rows);

    if (
      locationResult.rowCount === 0
    ) {

      console.log(
        "\x1b[41m\x1b[37m ❌ INVALID_STORAGE_LOCATION \x1b[0m"
      );

      throw {
        status: 400,
        code: "INVALID_STORAGE_LOCATION",
        message: "Ubicación destino inválida"
      };

    }

    const toLocation = locationResult.rows[0];

    const destinationWarehouseId =
  Number(toLocation.warehouse_id);

console.log(
  "🏬 WAREHOUSE DESTINO:",
  destinationWarehouseId
);

    console.log("📍 STORAGE DESTINO:", toLocation);

 

    console.log("📊 DATOS DE DESTINO:", {
      toLocationId: toLocation.id,
      toLocationCode: toLocation.code,
      toLocationType: toLocation.location_type,
      toWarehouseId: toLocation.warehouse_id
    });

    // =========================================================
// DEBUG 08 - WAREHOUSE DESTINO
// =========================================================

console.log(
  "\x1b[44m\x1b[37m\x1b[1m 🏬 [DEBUG 08] WAREHOUSE DESTINO IDENTIFICADO \x1b[0m"
);

console.log({
  destinationWarehouseId,
  destinationLocationId: Number(toLocation.id),
  destinationLocationCode: toLocation.code,
  destinationLocationType: toLocation.location_type
});

console.log(
  "ℹ️ El sourceWarehouseId será obtenido de la ubicación USER-HAND real en la sección 9."
);

    // =========================================================
// 9️⃣ OBTENER USER-HAND REAL DESDE PUTAWAY_LINES
// =========================================================

console.log(
  "\x1b[44m\x1b[37m\x1b[1m 🔍 BUSCANDO DOCK REAL DEL PUTAWAY \x1b[0m"
);

const userLocationResult = await client.query(
  `
  SELECT DISTINCT
    l.id,
    l.code,
    l.warehouse_id,
    l.location_type

  FROM putaway_lines pl

  INNER JOIN products p
    ON p.id = pl.product_id

  INNER JOIN locations l
    ON l.id = pl.to_location_id

  INNER JOIN user_locations ul
    ON ul.location_id = l.id

  WHERE
    pl.putaway_session_id = $1
    AND p.sku = $2
    AND ul.user_id = $3
    AND pl.status IN ('picked', 'partial')
    AND pl.remaining_qty > 0
    AND l.location_type = 'PICKING'
    AND l.is_active = true
  `,
  [
    putaway_session_id,
    product_id,
    userId
  ]
);

console.log(
  "📦 USER LOCATION ROWCOUNT:",
  userLocationResult.rowCount
);

console.table(userLocationResult.rows);

if (userLocationResult.rowCount === 0) {
  throw {
    status: 400,
    code: "USER_LOCATION_NOT_FOUND",
    message:
      "No se encontró una ubicación de recogida con unidades pendientes para este producto y usuario."
  };
}

// Evitar seleccionar arbitrariamente otro dock.
if (userLocationResult.rowCount > 1) {
  throw {
    status: 409,
    code: "MULTIPLE_DOCK_LOCATIONS",
    message:
      "El producto tiene líneas pendientes en varias ubicaciones de recogida."
  };
}

const userLocation = userLocationResult.rows[0];

const dockLocationId = Number(userLocation.id);

const sourceWarehouseId =
  Number(userLocation.warehouse_id);

console.log(
  "\x1b[42m\x1b[30m\x1b[1m ✅ USER-HAND REAL IDENTIFICADO \x1b[0m"
);

console.log({
  userId,
  dockLocationId,
  dockCode: userLocation.code,
  sourceWarehouseId,
  destinationWarehouseId
});


    // =========================================================
    // 🔟 BUSCAR PRODUCTO
    // =========================================================

    console.log(
      "\x1b[44m\x1b[37m 📦 [DEBUG 10] BUSCANDO PRODUCTO \x1b[0m"
    );

    console.log("📥 PRODUCT_ID RECIBIDO:", product_id);
    console.log("📥 TYPE:", typeof product_id);

    console.log(
      "🔎 Se buscará como SKU en getActiveProductBySku()"
    );

    const product =
      await getActiveProductBySku(
        client,
        product_id
      );

    console.log("📦 RESULTADO BÚSQUEDA PRODUCTO:", product);

    if (!product) {

      console.log(
        "\x1b[41m\x1b[37m ❌ PRODUCT_NOT_FOUND \x1b[0m"
      );

      throw {
        status: 404,
        code: "PRODUCT_NOT_FOUND",
        message:
          "Producto no existe o no está activo"
      };

    }

    const productId = product.id;

    console.log(
      "📦 PRODUCTO RESUELTO:",
      product
    );

    console.log("📊 PRODUCTO FINAL:", {
      id: productId,
      sku: product.sku,
      description: product.description,
      uom: product.uom
    });

    console.log("🔍 COMPARACIÓN DE IDENTIFICADORES:", {
      requestProductId: product_id,
      databaseProductId: productId,
      databaseSku: product.sku
    });

    // =========================================================
    // 1️⃣1️⃣ BUSCAR LÍNEAS PUTAWAY
    // =========================================================

    console.log("========================================");
    console.log("🔍 BUSCANDO LINEAS PUTAWAY");
    console.log("SESSION:", putaway_session_id);
    console.log("PRODUCT:", productId);
    console.log("USER LOCATION:", dockLocationId);

    console.log(
      "\x1b[45m\x1b[37m\x1b[1m 🔎 [DEBUG 11] DIAGNÓSTICO DE PUTAWAY_LINES \x1b[0m"
    );

    console.log("========================================");

    console.log("🎯 FILTROS EXACTOS:", {
      putaway_session_id,
      productId,
      dockLocationId,
      status: ["picked", "partial"]
    });

    console.log("🔡 TIPOS DE DATOS:", {
      putaway_session_id: typeof putaway_session_id,
      productId: typeof productId,
      dockLocationId: typeof dockLocationId
    });

    console.log("📍 UBICACIÓN USUARIO:", {
      id: userLocation.id,
      code: userLocation.code,
      warehouse_id: userLocation.warehouse_id
    });

    console.log("📍 UBICACIÓN DESTINO:", {
      id: toLocation.id,
      code: toLocation.code,
      warehouse_id: toLocation.warehouse_id
    });

    console.log(
      "🟨 IMPORTANTE: pl.to_location_id debe coincidir con dockLocationId."
    );

    console.log(
      "🟨 No se compara con la ubicación STORAGE destino."
    );

    console.log(
      "🧪 SQL PARA REVISAR EN PGADMIN (NO SE EJECUTA):"
    );

    console.log(`
      SELECT
        id,
        putaway_session_id,
        product_id,
        from_location_id,
        to_location_id,
        picked_qty,
        remaining_qty,
        status
      FROM putaway_lines
      WHERE putaway_session_id = ${Number(putaway_session_id)}
        AND product_id = ${Number(productId)}
      ORDER BY id;
    `);

    // =========================================================
    // CONSULTA ORIGINAL SIN MODIFICAR
    // =========================================================

    const linesResult =
      await client.query(
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

        WHERE
          pl.putaway_session_id = $1
          AND pl.product_id = $2
          AND pl.to_location_id = $3
          AND pl.status IN (
            'picked',
            'partial'
          )

        ORDER BY pl.id

        FOR UPDATE
        `,
        [
          putaway_session_id,
          productId,
          dockLocationId
        ]
      );

    console.log(
      "📦 LINES ROWCOUNT:",
      linesResult.rowCount
    );

    console.log(
      "📦 LINES:",
      linesResult.rows
    );

    console.log(
      "\x1b[44m\x1b[37m 📊 [DEBUG 11] RESULTADOS DE LA CONSULTA \x1b[0m"
    );

    console.log({
      rowCount: linesResult.rowCount,
      sessionIdFilter: putaway_session_id,
      productIdFilter: productId,
      toLocationIdFilter: dockLocationId,
      acceptedStatuses: ["picked", "partial"]
    });

    console.table(linesResult.rows);

    if (
      linesResult.rowCount === 0
    ) {

      console.log(
        "\x1b[41m\x1b[37m\x1b[1m ❌ NO_LINES_IN_DOCK \x1b[0m"
      );

      console.log("========================================");

      console.log("🚨 DIAGNÓSTICO DEL ERROR:", {
        userId,
        putaway_session_id,
        product_id,
        resolvedProductId: productId,
        productSku: product.sku,
        dockLocationId,
        dockCode: userLocation.code,
        dockWarehouseId: userLocation.warehouse_id,
        storageCode: toLocation.code,
        storageWarehouseId: toLocation.warehouse_id,
        sessionStatus: session.status
      });

      console.log(
        "⚠️ POSIBLES CAUSAS:"
      );

      console.log(
        "1. Las líneas existen en otra sesión de Putaway."
      );

      console.log(
        "2. El product_id no coincide con la línea."
      );

      console.log(
        "3. pl.to_location_id es distinto de dockLocationId."
      );

      console.log(
        "4. El estado de las líneas no es picked ni partial."
      );

      console.log(
        "5. Se obtuvo o creó un USER-HAND distinto del utilizado al recoger."
      );

      console.log(
        "↩️ ENTRANDO AL CATCH PARA ROLLBACK"
      );

      throw {
        status: 400,
        code: "NO_LINES_IN_DOCK",
        message:
          "No hay líneas disponibles de este producto en el dock"
      };

    }

    const availableLines =
      linesResult.rows;

    console.log("✅ LÍNEAS PUTAWAY ENCONTRADAS");

    console.table(availableLines);

    // =========================================================
    // 1️⃣2️⃣ VALIDAR CANTIDAD TOTAL PENDIENTE
    // =========================================================

    console.log(
      "\x1b[44m\x1b[37m 📊 [DEBUG 12] VALIDANDO CANTIDAD PENDIENTE \x1b[0m"
    );

    console.log("📦 LÍNEAS DISPONIBLES:", availableLines.length);

    console.table(
      availableLines.map(line => ({
        id: line.id,
        picked_qty: line.picked_qty,
        remaining_qty: line.remaining_qty
      }))
    );

    const totalRemaining =
      availableLines.reduce(
        (
          total,
          line
        ) => {

          return (
            total +
            Number(
              line.remaining_qty
            )
          );

        },
        0
      );

    console.log(
      "📦 TOTAL PENDIENTE:",
      totalRemaining
    );

    console.log(
      "📦 CANTIDAD SOLICITADA:",
      qtyNumber
    );

    console.log("📊 COMPARACIÓN:", {
      totalRemaining,
      qtyNumber,
      difference: totalRemaining - qtyNumber,
      enoughQuantity: qtyNumber <= totalRemaining
    });

    if (
      qtyNumber >
      totalRemaining
    ) {

      console.log(
        "\x1b[41m\x1b[37m ❌ QTY_EXCEEDS_PENDING_IN_DOCK \x1b[0m"
      );

      throw {
        status: 400,
        code:
          "QTY_EXCEEDS_PENDING_IN_DOCK",
        message:
          "Cantidad mayor que el total pendiente en dock"
      };

    }

    console.log("✅ CANTIDAD SUFICIENTE EN DOCK");

    // =========================================================
    // 1️⃣3️⃣ CONSUMIR LÍNEAS
    // =========================================================

    console.log(
      "\x1b[44m\x1b[37m 📦 [DEBUG 13] CONSUMIENDO PUTAWAY_LINES \x1b[0m"
    );

    let qtyToDrop =
      qtyNumber;

    console.log("📦 CANTIDAD INICIAL:", qtyToDrop);
    console.log("📋 TOTAL LÍNEAS:", availableLines.length);

    for (
      const line
      of availableLines
    ) {

      console.log("========================================");
      console.log("🔄 PROCESANDO LÍNEA:", line.id);

      console.log("📦 DATOS DE LA LÍNEA:", {
        lineId: line.id,
        pickedQty: line.picked_qty,
        remainingQty: line.remaining_qty,
        fromLocationId: line.from_location_id,
        toLocationId: line.to_location_id,
        qtyToDrop
      });

      if (
        qtyToDrop <= 0
      ) {

        console.log(
          "⏹️ YA NO QUEDA CANTIDAD POR PROCESAR"
        );

        break;

      }

      const currentRemaining =
        Number(
          line.remaining_qty
        );

      console.log(
        "📊 CURRENT REMAINING:",
        currentRemaining
      );

      if (
        currentRemaining <= 0
      ) {

        console.log(
          "⏭️ LÍNEA SIN CANTIDAD PENDIENTE:",
          line.id
        );

        continue;

      }

      const take =
        Math.min(
          currentRemaining,
          qtyToDrop
        );

      const newRemaining =
        currentRemaining -
        take;

      const newStatus =
        newRemaining === 0
          ? "completed"
          : "partial";

      console.log("========================================");
      console.log("📦 CONSUMIENDO PUTAWAY LINE");

      console.log({
        lineId: line.id,
        currentRemaining,
        take,
        newRemaining,
        newStatus
      });

      // =======================================================
      // ACTUALIZAR PUTAWAY LINE
      // =======================================================

      console.log(
        "\x1b[44m\x1b[37m 🛠️ [DEBUG 13] UPDATE PUTAWAY_LINE \x1b[0m"
      );

      console.log("📤 UPDATE DATA:", {
        id: line.id,
        remaining_qty: newRemaining,
        status: newStatus
      });

      await client.query(
        `
        UPDATE putaway_lines

        SET
          remaining_qty = $1,
          status = $2,
          updated_at = NOW()

        WHERE id = $3
        `,
        [
          newRemaining,
          newStatus,
          line.id
        ]
      );

      console.log("✅ PUTAWAY LINE ACTUALIZADA:", line.id);

      // =======================================================
      // TRAZABILIDAD DEL DROP
      // =======================================================

      console.log(
        "\x1b[44m\x1b[37m 🧾 [DEBUG 13] INSERT PUTAWAY_DROP_LINES \x1b[0m"
      );

      console.log("📤 DROP LINE DATA:", {
        putaway_session_id,
        putaway_line_id: line.id,
        product_id: productId,
        to_location_id: toLocation.id,
        qty_dropped: take,
        status: "confirmed",
        created_by_user_id: userId
      });

      await client.query(
        `
        INSERT INTO putaway_drop_lines
        (
          putaway_session_id,
          putaway_line_id,
          product_id,
          to_location_id,
          qty_dropped,
          status,
          created_by_user_id
        )

        VALUES
        (
          $1,
          $2,
          $3,
          $4,
          $5,
          'confirmed',
          $6
        )
        `,
        [
          putaway_session_id,
          line.id,
          productId,
          toLocation.id,
          take,
          userId
        ]
      );

      console.log("✅ PUTAWAY DROP LINE INSERTADA");

      qtyToDrop -= take;

      console.log("📊 DESPUÉS DE LA LÍNEA:", {
        lineId: line.id,
        quantityTaken: take,
        remainingToDrop: qtyToDrop
      });

    }

    // =========================================================
    // 1️⃣4️⃣ VALIDACIÓN EXTRA
    // =========================================================

    console.log(
      "\x1b[44m\x1b[37m 📊 [DEBUG 14] VALIDACIÓN FINAL \x1b[0m"
    );

    console.log("📦 QTY TO DROP RESTANTE:", qtyToDrop);

    if (
      qtyToDrop > 0
    ) {

      console.log(
        "\x1b[41m\x1b[37m ❌ QTY_EXCEEDS_PENDING_IN_DOCK \x1b[0m"
      );

      throw {
        status: 400,
        code:
          "QTY_EXCEEDS_PENDING_IN_DOCK",
        message:
          "No hay suficiente cantidad pendiente en el dock"
      };

    }

    console.log("✅ TODAS LAS CANTIDADES FUERON PROCESADAS");

    // =========================================================
    // 1️⃣5️⃣ MOVER INVENTARIO
    // =========================================================

    console.log(
      "\x1b[45m\x1b[37m\x1b[1m 🚚 [DEBUG 15] MOVIENDO INVENTARIO \x1b[0m"
    );

    console.log("========================================");
    console.log("🚚 MOVIENDO INVENTARIO PUTAWAY");

    console.log({
      warehouseId: sourceWarehouseId,
      productSku: product.sku,
      fromLocationId: dockLocationId,
      toLocationId: toLocation.id,
      qty: qtyNumber
    });

    console.log("📍 MOVIMIENTO COMPLETO:", {
      from: {
        locationId: dockLocationId,
        locationCode: userLocation.code,
        warehouseId: userLocation.warehouse_id
      },
      to: {
        locationId: toLocation.id,
        locationCode: toLocation.code,
        warehouseId: toLocation.warehouse_id
      },
      product: {
        id: productId,
        sku: product.sku
      },
      qty: qtyNumber
    });

    await moveInventoryBetweenLocations(
      client,
      {
        warehouseId:
          sourceWarehouseId,

        productSku:
          product.sku,

        fromLocationId:
          dockLocationId,

        toLocationId:
          toLocation.id,

        qty:
          qtyNumber
      }
    );

    console.log("✅ INVENTARIO MOVIDO CORRECTAMENTE");

    // =========================================================
    // 1️⃣6️⃣ REGISTRAR INVENTORY MOVEMENT
    // =========================================================

    console.log(
      "\x1b[44m\x1b[37m 🧾 [DEBUG 16] INVENTORY MOVEMENT \x1b[0m"
    );

    console.log("📤 MOVEMENT DATA:", {
      productSku: product.sku,
      fromLocationId: dockLocationId,
      toLocationId: toLocation.id,
      qty: qtyNumber,
      movementType: "MOVE",
      referenceType: "PUTAWAY",
      referenceId: String(putaway_session_id),
      createdBy: userId,
      note: `Putaway drop a ubicación ${toLocation.code}`
    });

    await createInventoryMovement(
      client,
      {
        productSku:
          product.sku,

        fromLocationId:
          dockLocationId,

        toLocationId:
          toLocation.id,

        qty:
          qtyNumber,

        movementType:
          "MOVE",

        referenceType:
          "PUTAWAY",

        referenceId:
          String(
            putaway_session_id
          ),

        createdBy:
          userId,

        note:
          `Putaway drop a ubicación ${toLocation.code}`
      }
    );

    console.log("✅ INVENTORY MOVEMENT REGISTRADO");

    // =========================================================
    // 1️⃣7️⃣ CERRAR SESIÓN SI NO QUEDAN PENDIENTES
    // =========================================================

    console.log(
      "\x1b[44m\x1b[37m 📋 [DEBUG 17] VALIDANDO FINALIZACIÓN DE SESIÓN \x1b[0m"
    );

    console.log(
      "🔍 VERIFICANDO SI EXISTEN LÍNEAS picked O partial"
    );

    console.log("📋 SESSION:", putaway_session_id);

    const sessionUpdateResult =
      await client.query(
        `
        UPDATE putaway_sessions

        SET
          status = 'completed',
          completed_at = NOW()

        WHERE
          id = $1

          AND NOT EXISTS
          (
            SELECT 1

            FROM putaway_lines

            WHERE
              putaway_session_id = $1
              AND status IN (
                'picked',
                'partial'
              )
          )

        RETURNING
          id,
          status,
          completed_at
        `,
        [
          putaway_session_id
        ]
      );

    console.log("📊 SESSION UPDATE ROWCOUNT:",
      sessionUpdateResult.rowCount
    );

    console.log("📊 SESSION UPDATE ROWS:",
      sessionUpdateResult.rows
    );

    if (
      sessionUpdateResult.rowCount > 0
    ) {

      console.log(
        "✅ PUTAWAY SESSION COMPLETADA:",
        sessionUpdateResult.rows[0]
      );

    } else {

      console.log(
        "📦 PUTAWAY SESSION AÚN TIENE LÍNEAS PENDIENTES"
      );

    }

    // =========================================================
    // 1️⃣8️⃣ COMMIT
    // =========================================================

    console.log(
      "\x1b[46m\x1b[30m 💾 [DEBUG 18] EJECUTANDO COMMIT \x1b[0m"
    );

    console.log("📊 DATOS ANTES DEL COMMIT:", {
      transactionStarted,
      putaway_session_id,
      productId,
      qtyNumber,
      dockLocationId,
      toLocationId: toLocation.id
    });

    await client.query(
      "COMMIT"
    );

    transactionStarted = false;

    console.log(
      "\x1b[42m\x1b[30m\x1b[1m ✅ COMMIT COMPLETADO \x1b[0m"
    );

    console.log("========================================");
    console.log("✅ DROP PUTAWAY COMPLETADO");
    console.log("========================================");

    // =========================================================
    // 1️⃣9️⃣ RESPUESTA
    // =========================================================

    console.log(
      "\x1b[42m\x1b[30m 📤 [DEBUG 19] RESPUESTA EXITOSA \x1b[0m"
    );

    console.log("📦 RESPUESTA:", {
      session,
      dock_location_id: dockLocationId,
      to_location: toLocation,
      product_id: productId,
      product_sku: product.sku,
      qty: qtyNumber
    });

    return res.status(200).json({

      success: true,

      message:
        "Putaway completado correctamente",

      data: {

        session,

        dock_location_id:
          dockLocationId,

        to_location:
          toLocation,

        product_id:
          productId,

        product_sku:
          product.sku,

        qty:
          qtyNumber

      }

    });

  } catch (error) {

    // =========================================================
    // 🔴 ROLLBACK
    // =========================================================

    console.log(
      "\x1b[41m\x1b[37m\x1b[1m ❌ [DEBUG ERROR] DROP PUTAWAY FAILED \x1b[0m"
    );

    console.log("========================================");

    console.log("🚨 ERROR DETAILS:", {
      status: error?.status,
      code: error?.code,
      message: error?.message,
      detail: error?.detail,
      hint: error?.hint,
      constraint: error?.constraint,
      table: error?.table,
      column: error?.column
    });

    console.log("📊 TRANSACTION STATE:", {
      clientExists: Boolean(client),
      transactionStarted
    });

    console.log("📋 REQUEST QUE FALLÓ:", {
      userId: req.user?.id,
      putaway_session_id: req.body?.putaway_session_id,
      product_id: req.body?.product_id,
      to_location_code: req.body?.to_location_code,
      qty: req.body?.qty
    });

    if (
      client &&
      transactionStarted
    ) {

      try {

        console.log(
          "\x1b[43m\x1b[30m ↩️ EJECUTANDO ROLLBACK \x1b[0m"
        );

        await client.query(
          "ROLLBACK"
        );

        console.log(
          "↩️ ROLLBACK DROP PUTAWAY COMPLETADO"
        );

      } catch (
        rollbackError
      ) {

        console.error(
          "❌ ERROR HACIENDO ROLLBACK DROP PUTAWAY:",
          rollbackError
        );

      }

    }

    console.error("========================================");
    console.error("❌ PUTAWAY DROP ERROR");
    console.error("ERROR:", error);
    console.error("========================================");

    // =========================================================
    // ERRORES CONTROLADOS
    // =========================================================

    if (
      error?.status &&
      error?.code
    ) {

      console.log(
        "\x1b[41m\x1b[37m 📤 ERROR CONTROLADO \x1b[0m"
      );

      console.log({
        status: error.status,
        code: error.code,
        message: error.message
      });

      return res
        .status(
          error.status
        )
        .json({

          success: false,

          code:
            error.code,

          message:
            error.message

        });

    }

    // =========================================================
    // ERROR NO CONTROLADO
    // =========================================================

    console.log(
      "\x1b[41m\x1b[37m 📤 ERROR 500 \x1b[0m"
    );

    return res
      .status(500)
      .json({

        success: false,

        code:
          "SERVER_ERROR",

        message:
          "Error interno procesando putaway"

      });

  } finally {

    // =========================================================
    // 🔓 SIEMPRE LIBERAR CONEXIÓN
    // =========================================================

    console.log(
      "\x1b[45m\x1b[37m 🔚 [DEBUG FINAL] FINALIZANDO DROP PUTAWAY \x1b[0m"
    );

    console.log("📊 DB POOL ANTES DE LIBERAR:", {
      total: db.totalCount,
      idle: db.idleCount,
      waiting: db.waitingCount
    });

    if (client) {

      client.release();

      console.log(
        "🔚 DROP PUTAWAY DB CLIENT LIBERADO"
      );

    }

    console.log("📊 DB POOL FINAL:", {
      total: db.totalCount,
      idle: db.idleCount,
      waiting: db.waitingCount
    });

  }

}


// GET ALL PENDING PUTAWAY LINES FOR A USER
export async function getPendingPutawayDrop(req, res) {
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
      console.log("🟩🟩 BARCODES: ", barcodeResult.rows);
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
