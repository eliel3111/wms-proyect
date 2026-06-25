
import { getIO } from "../socket.js";
import pool from "../db.js";

export async function emitInventorySummary(client) {
  console.log("inicio resumen 🟥🟩🟨🟪");

  const summaryResult = await client.query(`
    SELECT 
      ibl.counted_by AS user_id,
      u.full_name,
      COUNT(*)::int AS total_lines_counted
    FROM inventory_by_location ibl
    JOIN users u ON u.id = ibl.counted_by
    WHERE ibl.inventory_quantity > 0
      AND ibl.counted_by IS NOT NULL
    GROUP BY ibl.counted_by, u.full_name
    ORDER BY total_lines_counted DESC
  `);

  console.log("RESULTADO DB 🟥: ", summaryResult.rows);

  // 🔴 SI NO HAY DATA → TERMINAR
  if (summaryResult.rows.length === 0) {
    console.log("⚠️ No hay datos de inventario, no se emite nada");
    return {
      success: true,
      summary: [],
      total: 0,
    };
  }

  // 🔥 PRIMERO calcular total
  const total = summaryResult.rows.reduce(
    (acc, row) => acc + row.total_lines_counted,
    0
  );

  // 🔥 LUEGO construir summary con %
  const summary = summaryResult.rows.map(row => ({
    user_id: row.user_id,
    full_name: row.full_name,
    total_lines_counted: row.total_lines_counted,
    porcent: total > 0
      ? Number(((row.total_lines_counted / total) * 100).toFixed(2))
      : 0,
  }));

  const io = getIO();

  io.to("inventory_summary").emit("inventory_update", {
    summary,
    total,
  });

  console.log("RESULTADO FINAL 🟩:", { summary, total });

  return {
    success: true,
    summary,
    total,
  };
}




//Consulta el modo de ajuste de inventario y determina si existe una sesión activa para mostrar en Inventory Monitor. 
export async function getInventorySessionStatusService() {
  const client = await pool.connect();

  try {
    const companyResult = await client.query(`
    SELECT
        id,
        inventory_adjustment_mode
    FROM companies
    WHERE is_active = true
    ORDER BY created_at ASC
    LIMIT 1
`);

    if (companyResult.rowCount === 0) {
      console.log(
    "❌ Empresa no encontrada"
);
    return {
        success: false,
        title: "Empresa no encontrada",
        message: "No existe una empresa activa configurada."
    };
}

    const company = companyResult.rows[0];

const adjustmentMode =
    company.inventory_adjustment_mode || "final";

console.log(
    "🟩 Empresa activa:",
    company.id,
    "Modo:",
    adjustmentMode
);

    const sessionResult = await client.query(
      `
      SELECT
        s.id,
        s.code,
        s.user_id,
        u.full_name,
        s.status,
        s.start_date,
        s.end_date,
        s.created_at,
        s.updated_at
      FROM inventory_sessions s
      INNER JOIN users u ON u.id = s.user_id
      WHERE s.status IN ('draft', 'in-progress', 'review')
      ORDER BY s.created_at DESC
      LIMIT 1
      `
    );

    if (sessionResult.rowCount > 0) {
      return {
        success: true,
        hasActiveSession: true,
        adjustmentMode,
        session: sessionResult.rows[0]
      };
    }

    return {
      success: true,
      hasActiveSession: false,
      adjustmentMode,
      session: null
    };
  } finally {
    client.release();
  }
}