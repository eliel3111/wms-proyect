import { db } from "../db.js";
import { buildReceiptHtml } from "../templates/build-nota-recepcion.js";
import { generatePdf } from "../templates/generate-nota-recepcion.js";
import { randomUUID } from "crypto";
import { uploadPdfToS3 } from "../services/s3UploadPdf.js";
import { sendReceiptEmail } from "../services/sendReceiptEmail.js";
import { runFullSync } from "../cron/cronJobs.js";


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
      SELECT id, name, user_id, erp_cliente
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
        name: p.name,
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