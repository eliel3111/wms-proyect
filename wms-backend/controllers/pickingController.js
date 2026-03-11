import { db } from "../db.js";
import { buildReceiptHtml } from "../templates/build-nota-recepcion.js";
import { generatePdf } from "../templates/generate-nota-recepcion.js";
import { randomUUID } from "crypto";
import { uploadPdfToS3 } from "../services/s3UploadPdf.js";
import { sendReceiptEmail } from "../services/sendReceiptEmail.js";
import { runFullSync } from "../cron/cronJobs.js";


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