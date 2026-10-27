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


// GET A LOCATION ACTIVE USING A BARCODE
// GET A LOCATION ACTIVE USING A BARCODE
export async function dropPutaway(req, res) {

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

    console.log("========================================");
    console.log("🚚 DROP PUTAWAY");
    console.log("========================================");

    console.log("USER ID:", userId);
    console.log("PUTAWAY SESSION:", putaway_session_id);
    console.log("PRODUCT:", product_id);
    console.log("TO LOCATION:", to_location_code);
    console.log("QTY:", qtyNumber);


    // =========================================================
    // 2️⃣ VALIDAR QTY
    // Hacemos esto ANTES de pedir conexión
    // =========================================================

    if (
      !Number.isInteger(qtyNumber) ||
      qtyNumber <= 0
    ) {

      return res.status(400).json({
        success: false,
        code: "INVALID_QTY",
        message: "qty debe ser un entero mayor que 0"
      });

    }


    // =========================================================
    // 3️⃣ OBTENER CONEXIÓN
    // =========================================================

    client = await db.connect();

    console.log("✅ DB CLIENT OBTENIDO");


    // =========================================================
    // 4️⃣ INICIAR TRANSACCIÓN
    // =========================================================

    await client.query("BEGIN");

    transactionStarted = true;

    console.log("🟢 BEGIN PUTAWAY");


    // =========================================================
    // 5️⃣ VALIDAR SESIÓN
    //
    // IMPORTANTE:
    // usamos client.query()
    // NO db.query()
    // =========================================================

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


    if (sessionResult.rowCount === 0) {

      throw {
        status: 404,
        code: "SESSION_NOT_FOUND",
        message: "La sesión no existe"
      };

    }


    const session =
      sessionResult.rows[0];


    console.log(
      "SESSION OBTENIDA:",
      session
    );


    // =========================================================
    // 6️⃣ VALIDAR QUE LA SESIÓN PERTENECE AL USUARIO
    // =========================================================

    if (
      Number(session.user_id) !==
      userId
    ) {

      throw {
        status: 403,
        code: "SESSION_NOT_OWNED",
        message: "La sesión no pertenece al usuario"
      };

    }


    // =========================================================
    // 7️⃣ VALIDAR ESTADO DE SESIÓN
    // =========================================================

    if (
      ![
        "picking",
        "putting"
      ].includes(session.status)
    ) {

      throw {
        status: 400,
        code: "SESSION_NOT_ACTIVE",
        message: "La sesión no está activa"
      };

    }


    // =========================================================
    // 8️⃣ VALIDAR UBICACIÓN DESTINO
    // Debe ser STORAGE
    // =========================================================

    const locationResult =
      await getActiveLocationByCodeAndType(
        client,
        to_location_code,
        "STORAGE"
      );


    if (
      locationResult.rowCount === 0
    ) {

      throw {
        status: 400,
        code: "INVALID_STORAGE_LOCATION",
        message: "Ubicación destino inválida"
      };

    }


    const toLocation =
      locationResult.rows[0];


    const sourceWarehouseId =
      Number(
        toLocation.warehouse_id
      );


    console.log(
      "📍 STORAGE DESTINO:",
      toLocation
    );

    console.log(
      "🏬 WAREHOUSE DESTINO:",
      sourceWarehouseId
    );


    // =========================================================
    // 9️⃣ OBTENER USER-HAND / DOCK DEL USUARIO
    // =========================================================

    const userLocation =
      await getUserActiveLocation(
        client,
        userId,
        sourceWarehouseId
      );


    if (!userLocation) {

      throw {
        status: 404,
        code: "USER_LOCATION_NOT_FOUND",
        message:
          "No se encontró una ubicación activa para el usuario"
      };

    }


    console.log(
      "📍 USER LOCATION:",
      userLocation
    );


    const dockLocationId =
      Number(
        userLocation.id
      );


    // =========================================================
    // 🔟 BUSCAR PRODUCTO
    //
    // product_id actualmente está siendo usado como SKU.
    // =========================================================

    const product =
      await getActiveProductBySku(
        client,
        product_id
      );


    if (!product) {

      throw {
        status: 404,
        code: "PRODUCT_NOT_FOUND",
        message:
          "Producto no existe o no está activo"
      };

    }


    const productId =
      product.id;


    console.log(
      "📦 PRODUCTO RESUELTO:",
      product
    );


    // =========================================================
    // 1️⃣1️⃣ BUSCAR LÍNEAS PUTAWAY
    //
    // FOR UPDATE evita que dos requests consuman
    // la misma línea simultáneamente.
    // =========================================================

    console.log(
      "========================================"
    );

    console.log(
      "🔍 BUSCANDO LINEAS PUTAWAY"
    );

    console.log(
      "SESSION:",
      putaway_session_id
    );

    console.log(
      "PRODUCT:",
      productId
    );

    console.log(
      "USER LOCATION:",
      dockLocationId
    );


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


    if (
      linesResult.rowCount === 0
    ) {

      throw {
        status: 400,
        code: "NO_LINES_IN_DOCK",
        message:
          "No hay líneas disponibles de este producto en el dock"
      };

    }


    const availableLines =
      linesResult.rows;


    // =========================================================
    // 1️⃣2️⃣ VALIDAR CANTIDAD TOTAL PENDIENTE
    // =========================================================

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


    if (
      qtyNumber >
      totalRemaining
    ) {

      throw {
        status: 400,
        code:
          "QTY_EXCEEDS_PENDING_IN_DOCK",
        message:
          "Cantidad mayor que el total pendiente en dock"
      };

    }


    // =========================================================
    // 1️⃣3️⃣ CONSUMIR LÍNEAS
    // =========================================================

    let qtyToDrop =
      qtyNumber;


    for (
      const line
      of availableLines
    ) {

      if (
        qtyToDrop <= 0
      ) {

        break;

      }


      const currentRemaining =
        Number(
          line.remaining_qty
        );


      if (
        currentRemaining <= 0
      ) {

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


      console.log(
        "========================================"
      );

      console.log(
        "📦 CONSUMIENDO PUTAWAY LINE"
      );

      console.log({
        lineId:
          line.id,

        currentRemaining,

        take,

        newRemaining,

        newStatus
      });


      // =======================================================
      // ACTUALIZAR PUTAWAY LINE
      // =======================================================

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


      // =======================================================
      // TRAZABILIDAD DEL DROP
      // =======================================================

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


      qtyToDrop -=
        take;

    }


    // =========================================================
    // 1️⃣4️⃣ VALIDACIÓN EXTRA
    // =========================================================

    if (
      qtyToDrop > 0
    ) {

      throw {
        status: 400,
        code:
          "QTY_EXCEEDS_PENDING_IN_DOCK",
        message:
          "No hay suficiente cantidad pendiente en el dock"
      };

    }


    // =========================================================
    // 1️⃣5️⃣ MOVER INVENTARIO
    //
    // USER-HAND
    //     ↓
    // STORAGE
    // =========================================================

    console.log(
      "========================================"
    );

    console.log(
      "🚚 MOVIENDO INVENTARIO PUTAWAY"
    );

    console.log({
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


    // =========================================================
    // 1️⃣6️⃣ REGISTRAR INVENTORY MOVEMENT
    // =========================================================

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


    // =========================================================
    // 1️⃣7️⃣ CERRAR SESIÓN SI NO QUEDAN PENDIENTES
    // =========================================================

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

    await client.query(
      "COMMIT"
    );

    transactionStarted =
      false;


    console.log(
      "========================================"
    );

    console.log(
      "✅ DROP PUTAWAY COMPLETADO"
    );

    console.log(
      "========================================"
    );


    // =========================================================
    // 1️⃣9️⃣ RESPUESTA
    // =========================================================

    return res.status(
      200
    ).json({

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

    if (
      client &&
      transactionStarted
    ) {

      try {

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


    console.error(
      "========================================"
    );

    console.error(
      "❌ PUTAWAY DROP ERROR"
    );

    console.error(
      "ERROR:",
      error
    );

    console.error(
      "========================================"
    );


    // =========================================================
    // ERRORES CONTROLADOS
    // =========================================================

    if (
      error?.status &&
      error?.code
    ) {

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

    if (client) {

      client.release();

      console.log(
        "🔚 DROP PUTAWAY DB CLIENT LIBERADO"
      );

    }

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
