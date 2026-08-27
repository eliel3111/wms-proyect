
import { getIO } from "../socket.js";
import pool from "../db.js";



export async function emitInventorySummary(client) {

  console.log("🚀 Inicio resumen");


  // ============================================================
  // 1. OBTENER SESIÓN ACTIVA
  // ============================================================

  const sessionResult = await client.query(`
    SELECT
      id,
      code,
      status

    FROM inventory_sessions

    WHERE status IN (
      'draft',
      'in-progress',
      'review'
    )

    ORDER BY
      updated_at DESC,
      id DESC

    LIMIT 1
  `);


  // ============================================================
  // SI NO EXISTE SESIÓN ACTIVA
  // ============================================================

  if (sessionResult.rows.length === 0) {

    const response = {
      success: true,
      summary: [],
      total: 0,
      totalProducts: 0,
      totalPercent: 0
    };


    getIO()
      .to("inventory_summary")
      .emit(
        "inventory_summary",
        response
      );


    return response;
  }


  const session = sessionResult.rows[0];

  const sessionId = Number(session.id);


  console.log(
    "📦 SESSION SUMMARY:",
    {
      sessionId,
      code: session.code
    }
  );


  // ============================================================
  // 2. PRODUCTOS ÚNICOS CONTADOS POR USUARIO
  // SIN IMPORTAR WAREHOUSE
  // ============================================================

  const summaryResult = await client.query(`
    SELECT
      ibl.counted_by AS user_id,
      u.full_name,

      COUNT(
        DISTINCT ibl.product_sku
      )::int AS total_lines_counted

    FROM inventory_by_location ibl

    JOIN users u
      ON u.id = ibl.counted_by

    WHERE
      ibl.counted_by IS NOT NULL

      AND ibl.counted_at IS NOT NULL

    GROUP BY
      ibl.counted_by,
      u.full_name

    ORDER BY
      total_lines_counted DESC
  `);


  // ============================================================
  // 3. TOTAL DE PRODUCTOS ÚNICOS CONTADOS
  // SIN IMPORTAR WAREHOUSE
  // ============================================================

  const countedProductsResult = await client.query(`
    SELECT
      COUNT(
        DISTINCT ibl.product_sku
      )::int AS total_counted

    FROM inventory_by_location ibl

    WHERE
      ibl.counted_by IS NOT NULL

      AND ibl.counted_at IS NOT NULL
  `);


  const total = Number(
    countedProductsResult
      .rows[0]
      ?.total_counted || 0
  );


  console.log(
    "TOTAL PRODUCTOS ÚNICOS CONTADOS:",
    total
  );


  // ============================================================
  // 4. TOTAL PRODUCTOS A CONTAR
  // SNAPSHOT DE LA SESIÓN ACTUAL
  // ============================================================

  const totalProductsResult = await client.query(
    `
    SELECT
      COUNT(*)::int AS total_products

    FROM erp_inventory_snapshot

    WHERE session_inventory_id = $1
    `,
    [
      sessionId
    ]
  );


  const totalProducts = Number(
    totalProductsResult
      .rows[0]
      ?.total_products || 0
  );


  console.log(
    "TOTAL DE PRODUCTOS DEL SNAPSHOT:",
    totalProducts
  );


  // ============================================================
  // 5. SI NO HAY CONTEOS
  // ============================================================

  if (summaryResult.rows.length === 0) {

    const response = {
      success: true,
      summary: [],
      total: 0,
      totalProducts,
      totalPercent: 0
    };


    getIO()
      .to("inventory_summary")
      .emit(
        "inventory_summary",
        response
      );


    return response;
  }


  // ============================================================
  // 6. TOTAL DE PARTICIPACIÓN DE USUARIOS
  // ============================================================

  const totalUserParticipation =
    summaryResult.rows.reduce(
      (acc, row) =>
        acc +
        Number(
          row.total_lines_counted
        ),
      0
    );


  // ============================================================
  // 7. RESUMEN POR USUARIO
  // ============================================================

  const summary =
    summaryResult.rows.map(
      (row) => ({

        user_id:
          Number(
            row.user_id
          ),

        full_name:
          row.full_name,

        total_lines_counted:
          Number(
            row.total_lines_counted
          ),

        percent:
          totalUserParticipation > 0
            ? Number(
                (
                  (
                    Number(
                      row.total_lines_counted
                    ) /
                    totalUserParticipation
                  ) *
                  100
                ).toFixed(2)
              )
            : 0

      })
    );


  // ============================================================
  // 8. PORCENTAJE GENERAL
  // ============================================================

  const totalPercent =
    totalProducts > 0
      ? Number(
          (
            (
              total /
              totalProducts
            ) *
            100
          ).toFixed(2)
        )
      : 0;


  const response = {
    success: true,
    summary,
    total,
    totalProducts,
    totalPercent
  };


  // ============================================================
  // 9. WEBSOCKET
  // ============================================================

  getIO()
    .to("inventory_summary")
    .emit(
      "inventory_summary",
      response
    );


  console.log(
    "🟢 INVENTORY SUMMARY:",
    response
  );


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
    s.updated_at,

    EXISTS (
      SELECT 1
      FROM inventory_adjustment_jobs iaj
      WHERE iaj.inventory_session_id = s.id
        AND iaj.status = 'completed'
    ) AS has_completed_adjustment

  FROM inventory_sessions s

  INNER JOIN users u
    ON u.id = s.user_id

  WHERE s.status IN (
    'draft',
    'in-progress',
    'review'
  )

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
