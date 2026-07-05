import { db } from "../db.js";
import { saveInventoryByCount } from "../services/inventoryService.js";
import { getInventorySessionStatusService } from "../services/inventory.count.js";
import { emitInventorySummary } from "../services/inventory.count.js";
import { buscarTodasLasExistenciasAlmacen } from "../integrations/citrus/citrus.erpStockSync.js";


export async function inventoryScan(req, res) {
  try {
    const { productScanned, locationScanned } = req.body;

    console.log("1️⃣  UBICACION: ", locationScanned);
    console.log("2️⃣  PRODUCT: ", productScanned);

    // 1️⃣ Si NO hay nada
    if (!productScanned && !locationScanned) {
      console.log("❌ Debe escanear una ubicación o un producto.");
      return res.json({
        success: false,
        title: "Escaneo requerido",
        message: "Debe escanear una ubicación o un producto."
      });
    }

    // ==============================
    // VALIDAR ESTADO DE LA SESIÓN
    // ==============================

    const result = await getInventorySessionStatusService();

    //console.log("📦 Resultado sesión:", result);

    if (!result.success) {
      console.log("❌ No se pudo obtener el estado de la sesión.");

      return res.json({
        success: false,
        title: "Error de sesión",
        message: "No se pudo obtener el estado actual de la sesión de inventario."
      });
    }

    /*console.log(
      "📦 Sesión activa:",
      result.hasActiveSession,
      "| Estado:",
      result.session?.status ?? "Sin sesión"
    );*/

    // No existe una sesión activa
    if (!result.hasActiveSession || !result.session) {
      console.log("❌ No existe una sesión de inventario activa.");

      return res.json({
        success: false,
        title: "No hay una sesión activa",
        message: "Debe crear e iniciar una sesión de inventario antes de realizar conteos."
      });
    }

    // Existe la sesión pero NO está iniciada
    if (result.session.status !== "in-progress") {
      console.log(
        `❌ La sesión ${result.session.code} se encuentra en estado '${result.session.status}'.`
      );

      return res.json({
        success: false,
        title: "Sesión no iniciada",
        message:
          "La sesión de inventario aún no ha sido iniciada. Inicie la sesión antes de comenzar a contar productos."
      });
    }

    console.log(
      `✅ Sesión ${result.session.code} en estado '${result.session.status}'. Puede continuar.`
    );


    // SOLO ubicación
    if (
      (locationScanned && !productScanned) ||
      (locationScanned === productScanned)
    ) {

      const location = await db.query(`
        SELECT id, code
        FROM locations
        WHERE code = $1
          AND is_active = true
        LIMIT 1
    `, [locationScanned]);

      if (location.rows.length === 0) {
        console.log("❌ La ubicación escaneada no existe o no está activa.");
        return res.json({
          success: false,
          title: "Ubicación inválida",
          message: "La ubicación escaneada no existe o no está activa."
        });
      }

      console.log("✅✅ UBICACION confirmada: ", location.rows[0])

      return res.json({
        success: true,
        type: "location",
        data: location.rows[0]
      });
    }


    // NO se encontró producto pero podría ser ubicación
    if (!locationScanned && productScanned) {

      const location = await db.query(`
        SELECT id, code
        FROM locations
        WHERE code = $1
          AND is_active = true
        LIMIT 1
    `, [productScanned]);

      if (location.rows.length === 0) {
        console.log("❌ Tiene que leer una ubicacion valida primero.");
        return res.json({
          success: false,
          title: "Ubicación inválida",
          message: "Tiene que leer una ubicacion valida primero."
        });
      }

      console.log("✅✅ UBICACION confirmada: ", location.rows[0])

      return res.json({
        success: true,
        type: "location",
        data: location.rows[0]
      });
    }




    // 3️⃣ Si viene producto SIN ubicación → ERROR
    if (productScanned && !locationScanned) {
      console.log("❌ Debe escanear una ubicación antes de escanear un producto.");
      return res.json({
        success: false,
        title: "Falta ubicación",
        message: "Debe escanear una ubicación antes de escanear un producto."
      });
    }

    // 4️⃣ Validar ubicación
    const location = await db.query(`
      SELECT id, code
      FROM locations
      WHERE code = $1
        AND is_active = true
      LIMIT 1
    `, [locationScanned]);

    if (location.rows.length === 0) {
      console.log("❌ La ubicación escaneada no existe o no está activa.");
      return res.json({
        success: false,
        title: "Ubicación inválida",
        message: "La ubicación escaneada no existe o no está activa."
      });
    }

    const locationId = location.rows[0].id;

    console.log("✅✅ UBICACION confirmada: ", locationId);
    console.log("🟨 Buscando PRODUCTO escaneado : ", productScanned);
    // 5️⃣ Buscar producto
    const productResult = await db.query(`
  SELECT 
    p.id,
    p.erp_id,
    p.sku,
    p.description,
    P.erp_name,
    p.erp_id,
    p.erp_sku
  FROM products p
  LEFT JOIN product_barcodes bp 
    ON p.sku = bp.product_sku
  WHERE 
        bp.product_sku = $1
     OR bp.barcode = $1
     OR p.sku = $1
     OR p.erp_sku = $1
  LIMIT 1
`, [productScanned]);

    if (productResult.rows.length === 0) {
      console.log("❌ El código escaneado no corresponde a ningún producto.");
      return res.json({
        success: false,
        title: "Producto no encontrado",
        message: "El código escaneado no corresponde a ningún producto."
      });
    }

    const product = productResult.rows[0];
    console.log("✅✅ PRODUCTO confirmada: ", product);

    // 6️⃣ Buscar inventario en esa ubicación
    let qty = 0;
    console.log("🟨 Buscando inventario de esta ubicacion: ", locationId, "y este producto: ", product.sku);
    const inventoryResult = await db.query(`
      SELECT inventory_quantity
      FROM inventory_by_location
      WHERE product_sku = $1
        AND location_id = $2
      LIMIT 1
    `, [product.sku, locationId]);

    if (inventoryResult.rows.length > 0) {
      const inventoryQty = Number(inventoryResult.rows[0].inventory_quantity);
      console.log("✅✅ INVENTARIO confirmada: ", inventoryResult.rows[0]);
      if (inventoryQty > 0) {
        qty = inventoryQty;
      }
    }

    // 7️⃣ Respuesta final
    return res.json({
      success: true,
      type: "product",
      data: product,
      location: location.rows[0], // 👈 opcional pero útil
      qty
    });

  } catch (error) {
    console.error("❌ Error en inventoryScan:", error);
    return res.status(500).json({
      success: false,
      title: "ERROR",
      message: "Error interno"
    });
  }
}




export async function applyInventoryCount(req, res) {
  const client = await db.connect();

  try {
    const { locationSelected, productSelected, qty } = req.body;
    const userId = req.user?.id ?? 1; //🟥🟥 quitar en produccion #QUITARPRODUCCION

    await client.query("BEGIN");

    const result = await saveInventoryByCount(client, {
      locationSelected,
      productSelected,
      qty,
      userId,
      referenceId: null,
      note: "Ajuste por conteo físico"
    });

    if (!result.success) {
      await client.query("ROLLBACK");
      return res.json(result);
    }

    const summary = await emitInventorySummary(client);
    console.log("Resumen 🟥🟩🟨🟪", summary);

    await client.query("COMMIT");
    return res.json(result);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("❌ Error applyInventoryCount:", error);

    return res.status(500).json({
      success: false,
      title: "No se pudo guardar conteo",
      message: "Ocurrió un error interno."
    });
  } finally {
    client.release();
  }
}




export async function getInventoryLiveSummary(req, res) {
  const client = await db.connect();

  try {
    const summary = await emitInventorySummary(client);

    console.log("Resumen 🟥🟩🟨🟪", summary);

    return res.json(summary);

  } catch (error) {
    console.error("❌ Error getInventoryLiveSummary:", error);

    return res.status(500).json({
      success: false,
      title: "No se pudo obtener el resumen",
      message: "Ocurrió un error interno."
    });

  } finally {
    client.release();
  }
}





// Obtiene el estado actual del monitor de inventario para determinar si existe una sesión activa y la configuración de ajuste.
export async function getInventorySessionStatus(req, res) {
  try {
    const userId = Number(req.user?.id);

    console.log("🟦🟦🟦 ================================");
    console.log("🟨 INVENTORY MONITOR");
    console.log("🔍 CONSULTANDO ESTADO DE SESIÓN");

    console.log("👤 Usuario:", userId);

    if (!userId) {
      console.log("❌ Usuario no autenticado");

      return res.status(200).json({
        success: false,
        title: "Usuario no encontrado",
        message: "No se pudo identificar el usuario autenticado."
      });
    }

    const result = await getInventorySessionStatusService();

    console.log(
      "📦 Resultado:",
      `Session=${result}`,
      `Mode=${result.adjustmentMode}`
    );

    if (result.hasActiveSession) {
      console.log(
        "🟢 Sesión activa:",
        result.session.code,
        `(${result.session.status})`
      );
    } else {
      console.log("🟥 No existe sesión activa");
    }
    console.log("================================ 🟦🟦🟦");
    return res.status(200).json(result);

  } catch (error) {

    console.error(
      "❌ Error en getInventorySessionStatus:",
      error
    );

    return res.status(200).json({
      success: false,
      title: "Error al consultar inventario",
      message: "Ocurrió un error buscando el estado de la sesión de inventario."
    });
  }
}






// Cambia la configuración de ajuste de inventario validando que no exista una sesión activa.
export async function updateInventoryAdjustmentMode(req, res) {
  const client = await db.connect();

  try {
    console.log("🟦🟦🟦 ================================");
    console.log("🟨 INVENTORY MONITOR");
    console.log("⚙️ CAMBIANDO MODO DE AJUSTE");

    const { adjustmentMode } = req.body;

    console.log("📥 MODO RECIBIDO:", adjustmentMode);

    // =====================================
    // VALIDAR MODO
    // =====================================

    if (
      adjustmentMode !== "final" &&
      adjustmentMode !== "immediate"
    ) {
      console.log("❌ MODO INVÁLIDO");

      return res.status(200).json({
        success: false,
        title: "Modo inválido",
        message: "El modo de ajuste debe ser final o immediate."
      });
    }

    console.log("✅ MODO VÁLIDO");

    // =====================================
    // VALIDAR SESIÓN ACTIVA
    // =====================================

    console.log("🔍 BUSCANDO SESIÓN ACTIVA...");

    const sessionResult = await client.query(`
      SELECT id, code, status
      FROM inventory_sessions
      WHERE status IN ('draft', 'in-progress')
      LIMIT 1
    `);

    console.log("📊 SESIONES ENCONTRADAS:", sessionResult.rowCount);

    if (sessionResult.rowCount > 0) {
      const session = sessionResult.rows[0];

      console.log(
        "⛔ SESIÓN ACTIVA:",
        session.code,
        "| STATUS:",
        session.status
      );

      return res.status(200).json({
        success: false,
        title: "Inventario activo",
        message:
          "No se puede cambiar el modo de ajuste mientras exista una sesión de inventario activa."
      });
    }

    console.log("✅ NO HAY SESIONES ACTIVAS");

    // =====================================
    // BUSCAR EMPRESA ACTIVA
    // =====================================

    console.log("🏢 BUSCANDO EMPRESA ACTIVA...");

    const companyResult = await client.query(`
      SELECT
        id,
        inventory_adjustment_mode
      FROM companies
      WHERE is_active = true
      ORDER BY created_at ASC
      LIMIT 1
    `);

    console.log("📊 EMPRESAS ENCONTRADAS:", companyResult.rowCount);

    if (companyResult.rowCount === 0) {
      console.log("❌ NO EXISTE EMPRESA ACTIVA");

      return res.status(200).json({
        success: false,
        title: "Empresa no encontrada",
        message: "No existe una empresa activa configurada."
      });
    }

    const company = companyResult.rows[0];

    console.log(
      "🏢 EMPRESA:",
      company.id
    );

    console.log(
      "⬅️ MODO ACTUAL:",
      company.inventory_adjustment_mode
    );

    // =====================================
    // ACTUALIZAR CONFIGURACIÓN
    // =====================================

    console.log(
      "➡️ ACTUALIZANDO MODO A:",
      adjustmentMode
    );

    await client.query(
      `
      UPDATE companies
      SET inventory_adjustment_mode = $1
      WHERE id = $2
      `,
      [adjustmentMode, company.id]
    );

    console.log("✅ CONFIGURACIÓN ACTUALIZADA");

    console.log("🟩 FIN INVENTORY MONITOR");
    console.log("================================ 🟦🟦🟦 ");

    return res.status(200).json({
      success: true,
      title: "Configuración actualizada",
      message:
        "El modo de ajuste de inventario fue actualizado correctamente.",
      adjustmentMode
    });

  } catch (error) {

    console.log("🟥 ERROR INVENTORY MONITOR");
    console.error(error);

    return res.status(200).json({
      success: false,
      title: "Error de configuración",
      message:
        "Ocurrió un error actualizando el modo de inventario."
    });

  } finally {
    client.release();
  }
}


//🟨🟨 funcion para iniciar la sincronizacion de buscar todas las existencias del erp y llevarnos a la base de datos del wms y tener snapshot de la existencias antes del almacen.
let syncExistenciaRunning = false;

async function runSyncExistenciaAlmacenOnce(client, sessionId) {

  if (!client) {
    return {
      success: false,
      message: "client es requerido para sincronizar existencia.",
    };
  }
  if (!sessionId) {
    return {
      success: false,
      skipped: false,
      message: "sessionId es requerido para sincronizar existencia.",
    };
  }

  if (syncExistenciaRunning) {
    console.log("⏳ Sync existencia almacén ya está corriendo, se omite esta ejecución");

    return {
      success: true,
      skipped: true,
      message: "La sincronización ya estaba corriendo.",
    };
  }

  syncExistenciaRunning = true;

  try {
    console.log("====================================");
    console.log("⏱️ SYNC EXISTENCIA ALMACÉN INICIADO");
    console.log("🆔 SESSION ID:", sessionId);
    console.log("====================================");

    const data = await buscarTodasLasExistenciasAlmacen(client, sessionId);

    console.log("✅ SYNC EXISTENCIA ALMACÉN FINALIZADO");

    return {
      success: true,
      skipped: false,
      data,
    };

  } catch (error) {
    console.error("🔥 ERROR SYNC EXISTENCIA ALMACÉN:");
    console.error(error);

    return {
      success: false,
      skipped: false,
      message: error.message || "Error sincronizando existencia almacén",
    };

  } finally {
    syncExistenciaRunning = false;
  }
}



// Crea una nueva sesión de inventario validando que no exista otra activa.
export async function createInventorySession(req, res) {
  const client = await db.connect();

  try {

    console.log("🟦🟦🟦 ================================");
    console.log("🟨 INVENTORY MONITOR");
    console.log("🆕 CREANDO NUEVA SESIÓN");



    //const userId = 2;
    const userId = Number(req.user?.id);

    console.log("👤 USER ID:", userId);

    if (!userId) {
      console.log("❌ USER ID INVÁLIDO");

      return res.status(200).json({
        success: false,
        title: "Usuario no encontrado",
        message: "No se pudo identificar el usuario autenticado."
      });
    }

    await client.query("BEGIN");

    // =====================================
    // VALIDAR SESIÓN ACTIVA
    // =====================================

    console.log("🔍 BUSCANDO SESIONES ACTIVAS");

    const activeSessionResult = await client.query(`
      SELECT
        id,
        code,
        status
      FROM inventory_sessions
      WHERE status IN ('draft', 'in-progress', 'review')
      LIMIT 1
    `);

    if (activeSessionResult.rowCount > 0) {

      const activeSession = activeSessionResult.rows[0];

      console.log(
        "⛔ SESIÓN ACTIVA:",
        activeSession.code
      );



      await client.query("ROLLBACK");

      return res.status(200).json({
        success: false,
        title: "Sesión activa encontrada",
        message:
          `Ya existe una sesión de inventario activa: ${activeSession.code}.`
      });
    }

    console.log("✅ NO HAY SESIONES ACTIVAS");

    // =====================================
    // OBTENER CONFIGURACIÓN
    // =====================================

    console.log("🏢 BUSCANDO EMPRESA ACTIVA");

    const companyResult = await client.query(`
      SELECT
        inventory_adjustment_mode
      FROM companies
      WHERE is_active = true
      ORDER BY created_at ASC
      LIMIT 1
    `);

    if (companyResult.rowCount === 0) {

      await client.query("ROLLBACK");

      return res.status(200).json({
        success: false,
        title: "Empresa no encontrada",
        message: "No existe una empresa activa configurada."
      });
    }

    const adjustmentMode =
      companyResult.rows[0].inventory_adjustment_mode;

    console.log(
      "⚙️ INVENTORY MODE:",
      adjustmentMode
    );

    if (
      adjustmentMode !== "final" &&
      adjustmentMode !== "immediate"
    ) {

      await client.query("ROLLBACK");

      return res.status(200).json({
        success: false,
        title: "Configuración inválida",
        message:
          "El modo de ajuste de inventario no está configurado correctamente."
      });
    }

    // =====================================
    // CREAR SESIÓN
    // =====================================

    console.log("📝 CREANDO SESIÓN");

    const sessionResult = await client.query(
      `
      INSERT INTO inventory_sessions
      (
        user_id
      )
      VALUES
      (
        $1
      )
      RETURNING *
      `,
      [userId]
    );

    const session = sessionResult.rows[0];

    console.log(
      "✅ SESIÓN CREADA:",
      session.code
    );



    // =====================================
    // OBTENER NOMBRE USUARIO
    // =====================================

    const userResult = await client.query(
      `
      SELECT
        id,
        full_name
      FROM users
      WHERE id = $1
      `,
      [userId]
    );

    const user =
      userResult.rowCount > 0
        ? userResult.rows[0]
        : null;

    // =====================================
    // SINCRONIZAR EXISTENCIA CON SESSION ID
    // =====================================

    const syncResult = await runSyncExistenciaAlmacenOnce(client, session.id);

    if (!syncResult.success) {
      await client.query("ROLLBACK");

      return res.status(200).json({
        success: false,
        title: "Error sincronizando inventario",
        message:
          syncResult.message ||
          "No se pudo sincronizar la existencia del almacén.",
      });
    }



    await client.query("COMMIT");

    console.log("🟩 SESIÓN CREADA CORRECTAMENTE");
    console.log("🟦🟦🟦 ================================");





    return res.status(200).json({
      success: true,
      title: "SESSION_CREATED",
      message: "Sesión de inventario creada correctamente.",

      hasActiveSession: true,

      adjustmentMode,

      session: {
        id: session.id,
        code: session.code,
        user_id: session.user_id,
        full_name: user?.full_name || "",
        status: session.status,
        start_date: session.start_date,
        end_date: session.end_date,
        created_at: session.created_at,
        updated_at: session.updated_at
      }
    });

  } catch (error) {

    await client.query("ROLLBACK");

    console.log("🟥 ERROR CREANDO SESIÓN");
    console.error(error);

    return res.status(200).json({
      success: false,
      title: "Error creando sesión",
      message:
        "Ocurrió un error al crear la sesión de inventario."
    });

  } finally {
    client.release();
  }
}







// Inicia una sesión de inventario creada previamente en estado draft.
export async function startInventorySession(req, res) {
  const client = await db.connect();

  try {

    console.log("🟦🟦🟦 ================================");
    console.log("🟨 INVENTORY MONITOR");
    console.log("▶️ INICIANDO SESIÓN DE INVENTARIO");

    //const id = 2;
    const { id } = req.body;

    console.log("📥 SESSION ID:", id);

    if (!id) {
      console.log("❌ ID NO RECIBIDO");

      return res.status(200).json({
        success: false,
        title: "ID requerido",
        message: "Debe enviar el ID de la sesión."
      });
    }

    await client.query("BEGIN");

    // =====================================
    // BUSCAR SESIÓN
    // =====================================

    console.log("🔍 BUSCANDO SESIÓN");

    const sessionResult = await client.query(
      `
      SELECT
        id,
        code,
        user_id,
        status
      FROM inventory_sessions
      WHERE id = $1
      AND status NOT IN ('review', 'posted', 'cancelled')
      FOR UPDATE
      `,
      [id]
    );

    if (sessionResult.rowCount === 0) {

      console.log("❌ SESIÓN NO ENCONTRADA");

      await client.query("ROLLBACK");

      return res.status(200).json({
        success: false,
        title: "Sesión no encontrada",
        message: "La sesión no existe o no puede ser iniciada."
      });
    }

    const session = sessionResult.rows[0];

    console.log(
      "📋 SESSION:",
      session.code,
      "| STATUS:",
      session.status
    );

    // =====================================
    // VALIDAR YA INICIADA
    // =====================================

    if (session.status === "in-progress") {

      console.log("⚠️ SESIÓN YA INICIADA");

      await client.query("ROLLBACK");

      return res.status(200).json({
        success: false,
        title: "Sesión ya iniciada",
        message: "La sesión ya se encuentra en progreso."
      });
    }

    // =====================================
    // VALIDAR QUE SOLO SE INICIE DESDE DRAFT
    // =====================================

    if (session.status !== "draft") {

      console.log(
        "❌ ESTADO INVÁLIDO:",
        session.status
      );

      await client.query("ROLLBACK");

      return res.status(200).json({
        success: false,
        title: "Estado inválido",
        message:
          "Solo las sesiones en estado draft pueden iniciarse."
      });
    }

    // =====================================
    // VALIDAR OTRA SESIÓN EN PROGRESO
    // =====================================

    console.log("🔍 VALIDANDO OTRAS SESIONES EN PROGRESO");

    const otherSessionResult = await client.query(
      `
      SELECT
          id,
          code
      FROM inventory_sessions
      WHERE status = 'in-progress'
      AND id <> $1
      LIMIT 1
      `,
      [id]
    );

    if (otherSessionResult.rowCount > 0) {

      const otherSession = otherSessionResult.rows[0];

      console.log(
        "⛔ OTRA SESIÓN EN PROGRESO:",
        otherSession.code
      );

      await client.query("ROLLBACK");

      return res.status(200).json({
        success: false,
        title: "Inventario activo",
        message:
          `Ya existe una sesión en progreso (${otherSession.code}).`
      });
    }

    console.log("✅ NO HAY OTRAS SESIONES EN PROGRESO");

    // =====================================
    // OBTENER CONFIGURACIÓN
    // =====================================

    console.log("🏢 OBTENIENDO CONFIGURACIÓN");

    const companyResult = await client.query(`
      SELECT
        inventory_adjustment_mode
      FROM companies
      WHERE is_active = true
      ORDER BY created_at ASC
      LIMIT 1
    `);

    if (companyResult.rowCount === 0) {

      console.log("❌ EMPRESA ACTIVA NO ENCONTRADA");

      await client.query("ROLLBACK");

      return res.status(200).json({
        success: false,
        title: "Empresa no encontrada",
        message: "No existe una empresa activa configurada."
      });
    }

    const adjustmentMode =
      companyResult.rows[0].inventory_adjustment_mode || "final";

    console.log(
      "⚙️ MODO INVENTARIO:",
      adjustmentMode
    );

    // =====================================
    // ACTUALIZAR SESIÓN
    // =====================================

    console.log("✏️ ACTUALIZANDO SESIÓN");

    const updateResult = await client.query(
      `
      UPDATE inventory_sessions
      SET
          status = 'in-progress',
          start_date = NOW(),
          updated_at = NOW()
      WHERE id = $1
      RETURNING
          id,
          code,
          user_id,
          status,
          start_date,
          end_date,
          created_at,
          updated_at
      `,
      [id]
    );

    const updatedSession = updateResult.rows[0];

    // =====================================
    // OBTENER NOMBRE USUARIO
    // =====================================

    const userResult = await client.query(
      `
      SELECT
          full_name
      FROM users
      WHERE id = $1
      `,
      [updatedSession.user_id]
    );

    const fullName =
      userResult.rowCount > 0
        ? userResult.rows[0].full_name
        : "";

    await client.query("COMMIT");

    console.log(
      "✅ SESIÓN INICIADA:",
      updatedSession.code
    );

    console.log("🟩 SESSION STARTED");
    console.log("🟦🟦🟦 ================================");

    return res.status(200).json({
      success: true,
      title: "SESSION_STARTED",
      message:
        "La sesión de inventario fue iniciada correctamente.",

      hasActiveSession: true,

      adjustmentMode,

      session: {
        id: updatedSession.id,
        code: updatedSession.code,
        user_id: updatedSession.user_id,
        full_name: fullName,
        status: updatedSession.status,
        start_date: updatedSession.start_date,
        end_date: updatedSession.end_date,
        created_at: updatedSession.created_at,
        updated_at: updatedSession.updated_at
      }
    });

  } catch (error) {

    await client.query("ROLLBACK");

    console.log("🟥 ERROR INICIANDO SESIÓN");
    console.error(error);

    return res.status(200).json({
      success: false,
      title: "Error iniciando sesión",
      message:
        "Ocurrió un error al iniciar la sesión de inventario."
    });

  } finally {
    client.release();
  }
}











export async function cancelInventorySession(req, res) {
  const client = await db.connect();

  try {

    console.log("🟦🟦🟦 ================================");
    console.log("🟨 INVENTORY MONITOR");
    console.log("🚫 CANCELANDO SESIÓN");

    const { id } = req.body;
    //const userId = 1;
    const userId = Number(req.user?.id);

    console.log("📥 SESSION ID:", id);
    console.log("👤 USER ID:", userId);

    if (!userId) {

      console.log("❌ USER ID INVÁLIDO");

      return res.status(200).json({
        success: false,
        title: "Usuario no encontrado",
        message: "No se pudo identificar el usuario autenticado."
      });
    }

    if (!id) {

      console.log("❌ ID NO RECIBIDO");

      return res.status(200).json({
        success: false,
        title: "ID requerido",
        message: "Debe enviar el ID de la sesión."
      });
    }

    await client.query("BEGIN");

    // =====================================
    // BUSCAR SESIÓN
    // =====================================

    console.log("🔍 BUSCANDO SESIÓN");

    const sessionResult = await client.query(
      `
      SELECT
        id,
        code,
        user_id,
        status
      FROM inventory_sessions
      WHERE id = $1
      AND status NOT IN ('posted', 'cancelled')
      FOR UPDATE
      `,
      [id]
    );

    if (sessionResult.rowCount === 0) {

      console.log("❌ SESIÓN NO ENCONTRADA");

      await client.query("ROLLBACK");

      return res.status(200).json({
        success: false,
        title: "Sesión no encontrada",
        message:
          "La sesión no existe o ya fue cancelada."
      });
    }

    const session = sessionResult.rows[0];

    console.log(
      "📋 SESSION:",
      session.code,
      "| STATUS:",
      session.status
    );

    // =====================================
    // VALIDAR ESTADO
    // =====================================

    if (
      !["draft", "in-progress", "review"].includes(
        session.status
      )
    ) {

      console.log(
        "❌ ESTADO NO PERMITIDO:",
        session.status
      );

      await client.query("ROLLBACK");

      return res.status(200).json({
        success: false,
        title: "Estado inválido",
        message:
          "La sesión no puede ser cancelada."
      });
    }

    // =====================================
    // CANCELAR SESIÓN
    // =====================================

    console.log("✏️ CANCELANDO SESIÓN");

    const updateResult = await client.query(
      `
      UPDATE inventory_sessions
      SET
          status = 'cancelled',
          cancelled_by = $2,
          end_date = NOW(),
          updated_at = NOW()
      WHERE id = $1
      RETURNING
          id,
          code,
          user_id,
          status,
          cancelled_by,
          start_date,
          end_date,
          created_at,
          updated_at
      `,
      [id, userId]
    );

    const cancelledSession = updateResult.rows[0];

    // =====================================
    // LIMPIAR CONTEOS
    // =====================================

    console.log(
      "🧹 LIMPIANDO DATOS DE INVENTARIO"
    );

    const cleanResult = await client.query(`
      UPDATE inventory_by_location
      SET
          inventory_quantity = 0,
          counted_by = NULL,
          counted_at = NULL,
          old_qty_on_hand = NULL
    `);

    console.log(
      "📦 FILAS LIMPIADAS:",
      cleanResult.rowCount
    );

    await client.query("COMMIT");

    console.log(
      "✅ SESIÓN CANCELADA:",
      cancelledSession.code
    );

    console.log(
      "👤 CANCELADA POR:",
      cancelledSession.cancelled_by
    );

    console.log("🟦🟦🟦 ================================");

    return res.status(200).json({
      success: true,
      title: "SESSION_CANCELLED",
      message:
        "La sesión fue cancelada correctamente.",

      hasActiveSession: false,

      session: {
        id: cancelledSession.id,
        code: cancelledSession.code,
        user_id: cancelledSession.user_id,
        status: cancelledSession.status,
        cancelled_by: cancelledSession.cancelled_by,
        start_date: cancelledSession.start_date,
        end_date: cancelledSession.end_date,
        created_at: cancelledSession.created_at,
        updated_at: cancelledSession.updated_at
      }
    });

  } catch (error) {

    await client.query("ROLLBACK");

    console.log("🟥 ERROR CANCELANDO SESIÓN");
    console.error(error);

    return res.status(200).json({
      success: false,
      title: "Error cancelando sesión",
      message:
        "Ocurrió un error al cancelar la sesión."
    });

  } finally {

    client.release();

  }
}








// Finaliza el conteo de inventario y mueve la sesión a estado review.
export async function completeInventorySession(req, res) {
  const client = await db.connect();

  try {

    console.log("🟦🟦🟦 ================================");
    console.log("🟨 INVENTORY MONITOR");
    console.log("✅ COMPLETANDO SESIÓN");

    const { id } = req.body;
    const userId = 1;
    //const userId = Number(req.user?.id);

    console.log("📥 SESSION ID:", id);
    console.log("👤 USER ID:", userId);

    if (!id) {
      console.log("❌ ID NO RECIBIDO");

      return res.status(200).json({
        success: false,
        title: "ID requerido",
        message: "Debe enviar el ID de la sesión."
      });
    }

    if (!userId) {
      console.log("❌ USER ID INVÁLIDO");

      return res.status(200).json({
        success: false,
        title: "Usuario inválido",
        message: "No se pudo identificar el usuario."
      });
    }

    await client.query("BEGIN");

    // =====================================
    // BUSCAR SESIÓN
    // =====================================

    console.log("🔍 BUSCANDO SESIÓN");

    const sessionResult = await client.query(
      `
      SELECT
          id,
          code,
          status
      FROM inventory_sessions
      WHERE id = $1
      FOR UPDATE
      `,
      [id]
    );

    if (sessionResult.rowCount === 0) {

      console.log("❌ SESIÓN NO ENCONTRADA");

      await client.query("ROLLBACK");

      return res.status(200).json({
        success: false,
        title: "Sesión no encontrada",
        message: "La sesión indicada no existe."
      });
    }

    const session = sessionResult.rows[0];

    console.log(
      "📋 SESSION:",
      session.code,
      "| STATUS:",
      session.status
    );

    // =====================================
    // VALIDAR ESTADO
    // =====================================

    if (
      !["in-progress", "review"].includes(
        session.status
      )
    ) {

      console.log(
        "❌ ESTADO INVÁLIDO:",
        session.status
      );

      await client.query("ROLLBACK");

      return res.status(200).json({
        success: false,
        title: "Estado inválido",
        message:
          "La sesión debe estar en estado in-progress o review."
      });
    }

    // =====================================
    // CALCULAR ESTADÍSTICAS
    // =====================================

    console.log("📊 CALCULANDO ESTADÍSTICAS");

    // Ubicaciones contadas
    const countedResult = await client.query(`
      SELECT COUNT(*) AS total
      FROM inventory_by_location
      WHERE inventory_quantity > 0
    `);

    // Diferencias encontradas
    const differencesResult = await client.query(`
      SELECT COUNT(*) AS total
      FROM inventory_by_location
      WHERE inventory_diff_quantity <> 0
    `);

    // Ubicaciones pendientes
    const pendingResult = await client.query(`
      SELECT COUNT(*) AS total
      FROM inventory_by_location
      WHERE qty_on_hand > 0
      AND (
          inventory_quantity IS NULL
          OR inventory_quantity = 0
      )
    `);

    const countedLocations =
      Number(countedResult.rows[0].total);

    const differenceLocations =
      Number(differencesResult.rows[0].total);

    const pendingLocations =
      Number(pendingResult.rows[0].total);

    console.log(
      "📍 UBICACIONES CONTADAS:",
      countedLocations
    );

    console.log(
      "⚠️ DIFERENCIAS ENCONTRADAS:",
      differenceLocations
    );

    console.log(
      "⏳ UBICACIONES PENDIENTES:",
      pendingLocations
    );

    // =====================================
    // ACTUALIZAR SESIÓN
    // =====================================

    console.log("✏️ ACTUALIZANDO SESIÓN");

    const updateResult = await client.query(
      `
      UPDATE inventory_sessions
      SET
          status = 'review',
          counted_locations = $2,
          pending_locations = $3,
          difference_locations = $4,
          completed_by = $5,
          end_date = NOW(),
          updated_at = NOW()
      WHERE id = $1
      RETURNING
          id,
          code,
          user_id,
          status,
          counted_locations,
          pending_locations,
          difference_locations,
          completed_by,
          start_date,
          end_date,
          created_at,
          updated_at
      `,
      [
        id,
        countedLocations,
        pendingLocations,
        differenceLocations,
        userId
      ]
    );

    const updatedSession =
      updateResult.rows[0];

    await client.query("COMMIT");

    console.log("✅ SESIÓN COMPLETADA");
    console.log(
      "📍 CONTADAS:",
      countedLocations
    );
    console.log(
      "⚠️ DIFERENCIAS:",
      differenceLocations
    );
    console.log(
      "⏳ PENDIENTES:",
      pendingLocations
    );
    console.log("🟦🟦🟦 ================================");

    return res.status(200).json({
      success: true,
      title: "SESSION_COMPLETED",
      message:
        "La sesión fue enviada a revisión.",

      hasActiveSession: true,

      session: updatedSession,

      summary: {
        counted_locations: countedLocations,
        difference_locations: differenceLocations,
        pending_locations: pendingLocations
      }
    });

  } catch (error) {

    await client.query("ROLLBACK");

    console.log("🟥 ERROR COMPLETANDO SESIÓN");
    console.error(error);

    return res.status(200).json({
      success: false,
      title: "Error completando sesión",
      message:
        "Ocurrió un error completando la sesión."
    });

  } finally {

    client.release();

  }
}