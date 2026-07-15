
import { getIO } from "../socket.js";
import pool from "../db.js";

export async function emitInventorySummary(client) {
  console.log("🚀 Inicio resumen");

  // ==============================
  // CONTADORES
  // ==============================
  const summaryResult = await client.query(`
    SELECT
      ibl.counted_by AS user_id,
      u.full_name,
      COUNT(*)::int AS total_lines_counted
    FROM inventory_by_location ibl
    JOIN users u
      ON u.id = ibl.counted_by
    WHERE ibl.inventory_quantity > 0
      AND ibl.counted_by IS NOT NULL
    GROUP BY ibl.counted_by, u.full_name
    ORDER BY total_lines_counted DESC
  `);

  // ==============================
  // TOTAL DE PRODUCTOS A CONTAR
  // ==============================
const totalProductsResult = await client.query(`
  SELECT COUNT(*)::int AS total_products
  FROM erp_inventory_snapshot
  WHERE session_inventory_id = (
    SELECT id
    FROM inventory_sessions
    WHERE status IN ('draft', 'in-progress', 'review')
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
  )
`);

  const totalProducts = Number(
    totalProductsResult.rows[0]?.total_products || 0
  );

  console.log("TOTAL DE LÍNEAS DEL SNAPSHOT:", totalProducts);

  // ==============================
  // SI NO HAY CONTEOS
  // ==============================
  if (summaryResult.rows.length === 0) {

    const response = {
      success: true,
      summary: [],
      total: 0,
      totalProducts,
      totalPercent: 0,
    };

    getIO()
      .to("inventory_summary")
      .emit("inventory_summary", response);

    return response;
  }

  // ==============================
  // TOTAL CONTADO
  // ==============================
  const total = summaryResult.rows.reduce(
    (acc, row) => acc + Number(row.total_lines_counted),
    0
  );

  // ==============================
  // RESUMEN POR USUARIO
  // ==============================
  const summary = summaryResult.rows.map((row) => ({
    user_id: Number(row.user_id),
    full_name: row.full_name,
    total_lines_counted: Number(row.total_lines_counted),

    // <-- el frontend espera "percent"
    percent:
      total > 0
        ? Number(
          ((Number(row.total_lines_counted) / total) * 100).toFixed(2)
        )
        : 0,
  }));

  // ==============================
  // PORCENTAJE GENERAL
  // ==============================
  const totalPercent =
    totalProducts > 0
      ? Number(((total / totalProducts) * 100).toFixed(2))
      : 0;

  const response = {
    success: true,
    summary,
    total,
    totalProducts,
    totalPercent,
  };

  // ==============================
  // WEBSOCKET
  // ==============================
  getIO()
    .to("inventory_summary")
    .emit("inventory_summary", response);

  console.log("🟢 INVENTORY SUMMARY:", response);

  return response;
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