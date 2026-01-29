import { db } from "../db.js";
import { getActiveProductById, getPrimaryBarcodeBySku, getActiveProductBySku } from "../services/productService.js";
import { getActiveStorageLocationByCode, getUserActiveLocation, getActiveLocationByCodeAndType } from "../services/locationService.js";
import { moveInventoryBetweenLocations, createInventoryMovement } from "../services/inventoryService.js";
import { getActiveTransferSession } from "../services/transferSession.service.js";

// GET ALL PENDING TRANSFER LINES FOR A USER
export async function getPendingTransfer(req, res) {
    try {
        console.log("🔥 GET /transfer/pending funcionando");

        // 👉 si usas authMiddleware, normalmente viene de req.user
        const userId = req.user?.id || req.query.userId;
        console.log("🔥 userId:", userId);

        if (!userId) {
            return res.status(400).json({
                success: false,
                code: "USER_REQUIRED",
                message: "User id requerido"
            });
        }

        // 1️⃣ Buscar sesión activa de transferencia del usuario
        const session = await getActiveTransferSession(db, userId);


        if (!session) {
            return res.json({
                success: true,
                sessionId: null,
                totalLines: 0,
                data: []
            });
        }


        const transferSessionId = session.id;

        // 2️⃣ Buscar líneas pendientes (NO completed)
        const linesResult = await db.query(`
      SELECT
        tl.id,
        p.sku,
        p.description,
        p.uom,

        lf.code AS from_location,
        lt.code AS to_location,

        tl.picked_qty,
        tl.remaining_qty AS pending_qty
      FROM transfer_lines tl
      JOIN products p ON p.id = tl.product_id
      JOIN locations lf ON lf.id = tl.from_location_id
      JOIN locations lt ON lt.id = tl.to_location_id
      WHERE tl.transfer_session_id = $1
        AND tl.status IN ('open','partial')
      ORDER BY p.sku;
    `, [transferSessionId]);

        // 3️⃣ Enriquecer con código de barras (igual que putaway)
        const enrichedLines = [];

        for (const line of linesResult.rows) {
            const barcodeResult = await getPrimaryBarcodeBySku(db, line.sku);

            enrichedLines.push({
                ...line,
                barcode: barcodeResult.rowCount > 0
                    ? barcodeResult.rows[0].barcode
                    : null
            });
        }

        // 4️⃣ Responder al frontend
        return res.json({
            success: true,
            sessionId: transferSessionId,
            totalLines: enrichedLines.length,
            data: enrichedLines
        });

    } catch (error) {
        console.error("❌ Error en getPendingTransfers:", error);

        return res.status(500).json({
            success: false,
            code: "INTERNAL_ERROR",
            message: "Error buscando transferencias pendientes"
        });
    }
}


// START A TRANSFER SESSION FOR A USER
export async function startingTransfer(req, res) {
    try {
        console.log("🔥 GET /transfer/start");

        const userId = req.user?.id; // viene del authMiddleware

        if (!userId) {
            return res.status(403).json({
                success: false,
                code: "NO_USER",
                message: "Usuario no autenticado"
            });
        }

        // 1️⃣ Buscar sesión activa
        const activeSession = await db.query(`
      SELECT *
      FROM transfer_sessions
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
      INSERT INTO transfer_sessions
        (user_id, status)
      VALUES
        ($1, 'open')
      RETURNING *
    `, [userId]);

        return res.status(201).json({
            success: true,
            alreadyExists: false,
            session: newSession.rows[0]
        });

    } catch (error) {
        console.error("❌ Error en startingTransfer:", error);

        return res.status(500).json({
            success: false,
            code: "START_TRANSFER_ERROR",
            message: "Error iniciando sesión de transferencia"
        });
    }
}


export async function scanPutawayCode(req, res) {
    try {
        const { code } = req.body;

        if (!code) {
            return res.status(400).json({
                success: false,
                message: "Código requerido"
            });
        }

        const normalized = code.trim().toUpperCase();

        /* ======================================
           1️⃣ BUSCAR SI ES UBICACIÓN ACTIVA
        ====================================== */

        const locationResult = await getActiveStorageLocationByCode(db, normalized);

        if (locationResult.rowCount > 0) {
            return res.json({
                success: true,
                type: "location",
                location: locationResult.rows[0]
            });
        }

        /* ======================================
           2️⃣ SI NO ES UBICACIÓN → BUSCAR PRODUCTO
        ====================================== */

        const productResult = await db.query(`
      SELECT 
        p.id, 
        p.sku, 
        p.description, 
        p.uom
      FROM product_barcodes pb
      JOIN products p ON p.sku = pb.product_sku
      WHERE UPPER(pb.barcode) = $1
      LIMIT 1
    `, [normalized]);

        if (productResult.rowCount === 0) {
            return res.json({
                success: false,
                code: "NOT_FOUND",
                message: "El código no corresponde a una ubicación ni a un producto"
            });
        }

        return res.json({
            success: true,
            type: "product",
            product: productResult.rows[0]
        });

    } catch (error) {
        console.error("❌ scanPutawayCode:", error);
        return res.status(500).json({
            success: false,
            message: "Error procesando el código"
        });
    }
}

// CREATE A TRANSFER LINE 
export async function createTransferLine(req, res) {
    const { productId, fromLocationId, qty } = req.body;
    const userId = req.user.id;

    const client = await db.connect();

    try {
        await client.query("BEGIN");
        console.log(" ERROR 1");
        // 1️⃣ Validar producto activo
        const product = await getActiveProductById(client, productId);
        if (!product) throw { code: "PRODUCT_NOT_FOUND_OR_INACTIVE" };

        // 2️⃣ Validar sesión activa
        const sessionResult = await client.query(`
            SELECT id
            FROM transfer_sessions
            WHERE user_id = $1
                AND status IN ('open','in_progress')
            LIMIT 1
            FOR UPDATE
            `, [userId]);

        if (sessionResult.rowCount === 0) {
            throw { code: "NO_ACTIVE_TRANSFER_SESSION" };
        }

        const sessionId = sessionResult.rows[0].id;
        console.log("2");

        // 3️⃣ Validar ubicación origen STORAGE y obtener warehouse
        const locResult = await client.query(`
            SELECT id, location_type, warehouse_id
            FROM locations
            WHERE id = $1 AND is_active = true
            FOR UPDATE
            `, [fromLocationId]);

        if (locResult.rowCount === 0 || locResult.rows[0].location_type !== "STORAGE") {
            throw { code: "INVALID_STORAGE_LOCATION" };
        }

        const { warehouse_id } = locResult.rows[0];
        console.log("3 - warehouse desde location:", warehouse_id);


        // 4️⃣ Validar inventario disponible
        const stockResult = await client.query(`
      SELECT qty_on_hand, qty_reserved, qty_available
      FROM inventory_by_location
      WHERE product_sku = $1 AND location_id = $2
      FOR UPDATE
    `, [product.sku, fromLocationId]);

        if (
            stockResult.rowCount === 0 ||
            Number(stockResult.rows[0].qty_available) < Number(qty)
        ) {
            throw { code: "QTY_EXCEEDS_AVAILABLE" };
        }
        console.log("4", userId);
        console.log("5", warehouse_id);
        // 5️⃣ Ubicación destino del usuario
        const userLocation = await getUserActiveLocation(client, userId);
        if (!userLocation) throw { code: "USER_LOCATION_NOT_FOUND" };

        // 6️⃣ Buscar línea existente
        const existingLineResult = await client.query(`
      SELECT id, picked_qty, remaining_qty
      FROM transfer_lines
      WHERE transfer_session_id = $1
        AND product_id = $2
        AND from_location_id = $3
        AND to_location_id = $4
        AND status IN ('open','partial')
      FOR UPDATE
    `, [sessionId, productId, fromLocationId, userLocation.id]);

        if (existingLineResult.rowCount > 0) {
            const line = existingLineResult.rows[0];
            const newQty = Number(line.picked_qty) + Number(qty);

            const updateResult = await client.query(`
        UPDATE transfer_lines
        SET picked_qty = $1,
            remaining_qty = $1,
            status = 'open'
        WHERE id = $2
        RETURNING *
      `, [newQty, line.id]);


            console.log("5", warehouse_id);


            await moveInventoryBetweenLocations(client, {
                warehouseId: warehouse_id,
                productSku: product.sku,
                fromLocationId,
                toLocationId: userLocation.id,
                qty
            });
            console.log("6");
            await client.query("COMMIT");

            return res.json({ success: true, line: updateResult.rows[0], mode: "updated" });
        }

        // 7️⃣ Crear línea nueva
        const insertResult = await client.query(`
      INSERT INTO transfer_lines
      (transfer_session_id, product_id, from_location_id, to_location_id,
       picked_qty, remaining_qty, status)
      VALUES ($1,$2,$3,$4,$5,$5,'open')
      RETURNING *
    `, [sessionId, productId, fromLocationId, userLocation.id, qty]);

        // 8️⃣ Mover inventario real
        await moveInventoryBetweenLocations(client, {
            warehouseId: warehouse_id,
            productSku: product.sku,
            fromLocationId,
            toLocationId: userLocation.id,
            qty
        });

        await client.query("COMMIT");

        res.json({ success: true, line: insertResult.rows[0], mode: "created" });

    } catch (err) {
        await client.query("ROLLBACK");
        res.status(400).json({ success: false, error: err.code || "TRANSFER_ERROR" });
    } finally {
        client.release();
    }
}


// POST /transfer/drop
export async function dropTransfer(req, res) {
  const client = await db.connect();
  console.log("INICIO DROP");
  try {
    await client.query("BEGIN");

    const userId = req.user.id;
    const { transfer_session_id, product_sku, to_location_code, qty } = req.body;
 console.log(userId);

 console.log("ubicacion: ", to_location_code);
    /* -----------------------------
       1️⃣ Validar qty
    ------------------------------*/
    if (!qty || Number(qty) <= 0) {
      return res.status(400).json({
        code: "INVALID_QTY",
        message: "qty debe ser un número mayor que 0"
      });
    }

    /* -----------------------------
       2️⃣ Validar sesión (activa y del usuario)
    ------------------------------*/
    const sessionResult = await client.query(`
      SELECT id, status, user_id, warehouse_id
      FROM transfer_sessions
      WHERE id = $1
      FOR UPDATE
    `, [transfer_session_id]);

    if (sessionResult.rowCount === 0) {
      return res.status(404).json({
        code: "SESSION_NOT_FOUND",
        message: "La sesión no existe"
      });
    }

    const session = sessionResult.rows[0];

    if (Number(session.user_id) !== Number(userId)) {
      return res.status(403).json({
        code: "SESSION_NOT_OWNED",
        message: "La sesión no pertenece al usuario"
      });
    }

    if (!["open", "in_progress"].includes(session.status)) {
      return res.status(400).json({
        code: "SESSION_NOT_ACTIVE",
        message: "La sesión no está activa"
      });
    }
    console.log("SESSION ESTA ACTIVA");
    /* -----------------------------
       3️⃣ Obtener ubicación del usuario (destino intermedio / mano)
    ------------------------------*/
    console.log("El user id es: ", userId, "su tipo es,", typeof(userId));
    const userLocation = await getUserActiveLocation(client, userId);
    console.log("user location: ", userLocation)
    if (!userLocation) {
      return res.status(404).json({
        code: "USER_LOCATION_NOT_FOUND",
        message: "El usuario no tiene ubicación asignada"
      });
    }

    const userLocationId = Number(userLocation.id);
     console.log("SE OBTUVO LA UBICACION DEL USUARIO", userLocationId);
    /* -----------------------------
       4️⃣ Validar ubicación destino STORAGE
    ------------------------------*/
    console.log(to_location_code, "codigo de ubicacion destino");
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
    console.log("SE OBTUVO UBICACION DESTINO, ", toLocation);
    /* -----------------------------
       5️⃣ Resolver producto por SKU
    ------------------------------*/
    const product = await getActiveProductBySku(client, product_sku);

    if (!product) {
      return res.status(404).json({
        code: "PRODUCT_NOT_FOUND",
        message: "Producto no existe o no está activo"
      });
    }

    const productId = Number(product.id);
    console.log("SE OBTUBO EL PRODUCTO", product);
    /* -----------------------------
       6️⃣ Traer líneas disponibles "en mano" (to_location_id = userLocation)
         (estas son las líneas que ya fueron “picked” hacia el usuario)
    ------------------------------*/
    const linesResult = await client.query(`
      SELECT
        tl.id,
        tl.transfer_session_id,
        tl.product_id,
        tl.from_location_id,
        tl.to_location_id,
        tl.picked_qty,
        tl.remaining_qty,
        tl.status
      FROM transfer_lines tl
      WHERE tl.transfer_session_id = $1
        AND tl.product_id = $2
        AND tl.to_location_id = $3
        AND tl.status IN ('open','partial')
      ORDER BY tl.id
      FOR UPDATE
    `, [transfer_session_id, productId, userLocationId]);

    if (linesResult.rowCount === 0) {
      return res.status(400).json({
        code: "NO_LINES_IN_USER_LOCATION",
        message: "No hay líneas disponibles de este producto en la ubicación del usuario"
      });
    }

    const availableLines = linesResult.rows;
    console.log("ATENTION", availableLines);
    /* -----------------------------
       7️⃣ Validar total pendiente
    ------------------------------*/
    const totalRemaining = availableLines.reduce(
      (sum, l) => sum + Number(l.remaining_qty),
      0
    );

    if (Number(qty) > totalRemaining) {
      return res.status(400).json({
        code: "QTY_EXCEEDS_PENDING_IN_HAND",
        message: "Cantidad mayor que el total pendiente en la ubicación del usuario"
      });
    }

    /* -----------------------------
       8️⃣ Consumir cantidades una por una y crear transfer_drop_lines
    ------------------------------*/
    let qtyToMove = Number(qty);

    for (const line of availableLines) {
      if (qtyToMove <= 0) break;

      const currentRemaining = Number(line.remaining_qty);
      if (currentRemaining <= 0) continue;

      const take = Math.min(currentRemaining, qtyToMove);
      const newRemaining = currentRemaining - take;
      const newStatus = newRemaining === 0 ? "completed" : "partial";

      // ✅ actualizar transfer_lines
      await client.query(`
        UPDATE transfer_lines
        SET remaining_qty = $1,
            status = $2
        WHERE id = $3
      `, [newRemaining, newStatus, line.id]);

      // ✅ trazabilidad
      await client.query(`
        INSERT INTO transfer_drop_lines
          (transfer_session_id, transfer_line_id, product_id, from_location_id, to_location_id, qty_moved, status, created_by_user_id)
        VALUES
          ($1,$2,$3,$4,$5,$6,'confirmed',$7)
      `, [
        transfer_session_id,
        line.id,
        productId,
        userLocationId,   // desde la mano del usuario
        toLocation.id,    // hacia storage final
        take,
        userId
      ]);

      qtyToMove -= take;
    }

    if (qtyToMove > 0) {
      return res.status(400).json({
        code: "QTY_NOT_FULFILLED",
        message: "No se pudo completar la cantidad solicitada"
      });
    }

    /* -----------------------------
       9️⃣ Mover inventario real (userLocation -> toLocation)
    ------------------------------*/
    await moveInventoryBetweenLocations(client, {
      warehouseId: toLocation.warehouse_id || session.warehouse_id,
      productSku: product.sku,
      fromLocationId: userLocationId,
      toLocationId: Number(toLocation.id),
      qty: Number(qty)
    });

    /* -----------------------------
       🔟 Registrar movimiento histórico
    ------------------------------*/
    await createInventoryMovement(client, {
      productSku: product.sku,
      fromLocationId: userLocationId,
      toLocationId: Number(toLocation.id),
      qty: Number(qty),
      movementType: "MOVE",
      referenceType: "TRANSFER",
      referenceId: String(transfer_session_id),
      createdBy: userId,
      note: `Transfer drop a ubicación ${toLocation.code}`
    });

    /* -----------------------------
       1️⃣1️⃣ Cerrar sesión si ya no quedan líneas pendientes
    ------------------------------*/
    await client.query(`
      UPDATE transfer_sessions
      SET status = 'completed',
          completed_at = now(),
          updated_at = now()
      WHERE id = $1
        AND NOT EXISTS (
          SELECT 1 FROM transfer_lines
          WHERE transfer_session_id = $1
            AND status IN ('open','partial')
        )
    `, [transfer_session_id]);

    await client.query("COMMIT");

    return res.status(200).json({
      success: true,
      message: "Transfer drop confirmado",
      data: {
        session_id: transfer_session_id,
        user_location_id: userLocationId,
        to_location: toLocation,
        product: { id: productId, sku: product.sku },
        qty: Number(qty)
      }
    });

  } catch (error) {
    await client.query("ROLLBACK");

    if (error?.code) {
      return res.status(400).json(error);
    }

    console.error("❌ TRANSFER DROP ERROR:", error);

    return res.status(500).json({
      code: "SERVER_ERROR",
      message: "Error interno"
    });
  } finally {
    client.release();
  }
}

