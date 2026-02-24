import { db } from "../db.js";

// =====================================================
// SERVICE: VALIDATE PICKING
// =====================================================
export async function validatePickingService(picking_id) {
    
    if (!picking_id) {
        return {
            success: false,
            message: "picking_id is required"
        };
    }

    const query = `
        SELECT id, name, state, picking_type
        FROM stock_picking
        WHERE id = $1
          AND state NOT IN ('done','cancel')
        LIMIT 1;
    `;

    const { rows } = await db.query(query, [picking_id]);

    // 🔴 no existe o cerrado
    if (rows.length === 0) {
        return {
            success: false,
            message: "Picking inválido o cerrado"
        };
    }

    // 🟢 válido
    return {
        success: true,
        picking: rows[0]
    };
}
