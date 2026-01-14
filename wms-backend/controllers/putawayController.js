import { db } from "../db.js";


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

    // 2️⃣ Buscar inventario en ubicaciones de recepción con stock
    const locationResult = await db.query(
      `
      SELECT 
        ibl.location_id,
        l.code AS location_code,
        ibl.qty_on_hand
      FROM inventory_by_location ibl
      JOIN locations l ON l.id = ibl.location_id
      WHERE ibl.product_sku = $1
        AND ibl.qty_on_hand > 0
        AND l.location_type = 'RECEIVING'
      ORDER BY ibl.qty_on_hand DESC
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
        pl.picked_qty,
        pl.put_qty,
        (pl.picked_qty - pl.put_qty) AS pending_qty
      FROM putaway_lines pl
      JOIN products p ON p.id = pl.product_id
      WHERE pl.putaway_session_id = $1
        AND pl.status IN ('picked','partial')
      ORDER BY p.sku
    `, [putawaySessionId]);

    // 3️⃣ Responder al frontend
    return res.json({
      success: true,
      sessionId: putawaySessionId,
      totalLines: linesResult.rowCount,
      data: linesResult.rows
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




