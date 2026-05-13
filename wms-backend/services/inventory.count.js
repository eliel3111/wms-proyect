
import { getIO } from "../socket.js";

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