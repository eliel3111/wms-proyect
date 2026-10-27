/**
 * ============================================================
 * PICKING ASSIGNMENT CLEANUP SERVICE
 * ============================================================
 *
 * Descripción:
 *
 * Recibe un pickingId y verifica todas las líneas de stock_move
 * relacionadas con ese picking.
 *
 * REGLAS:
 *
 * 1. Si existe al menos un stock_move cuyo estado NO sea
 *    "done" ni "cancel":
 *
 *      → El picking continúa asignado.
 *      → NO se elimina nada de picking_assignments.
 *
 * 2. Si TODAS las líneas de stock_move están:
 *
 *      "done"
 *      o
 *      "cancel"
 *
 *      → Se elimina la asignación del picking de:
 *
 *        picking_assignments
 *
 *      usando:
 *
 *        stock_picking_id = pickingId
 *
 * 3. Si el picking no tiene ningún stock_move:
 *
 *      → NO se elimina la asignación.
 *
 * Esto evita liberar accidentalmente un picking que todavía
 * no tiene movimientos creados.
 *
 * ============================================================
 */


export async function
releasePickingAssignmentIfCompleted(
  client,
  pickingId
) {

  console.log(
    "============================================================"
  );

  console.log(
    "🧹 CHECK PICKING ASSIGNMENT"
  );

  console.log(
    "📦 PICKING ID:",
    pickingId
  );

  console.log(
    "============================================================"
  );


  // ==========================================================
  // 1. VALIDAR PICKING ID
  // ==========================================================

  const parsedPickingId =
    Number(
      pickingId
    );


  if (
    !Number.isInteger(
      parsedPickingId
    ) ||
    parsedPickingId <= 0
  ) {

    return {
      success:
        false,

      code:
        "INVALID_PICKING_ID",

      message:
        "El pickingId no es válido.",

      pickingId:
        parsedPickingId
    };
  }


  if (
    !client
  ) {

    return {
      success:
        false,

      code:
        "DB_CLIENT_REQUIRED",

      message:
        "Se requiere un cliente de base de datos.",

      pickingId:
        parsedPickingId
    };
  }


  // ==========================================================
  // 2. VERIFICAR STOCK_MOVES
  // ==========================================================
  //
  // total_moves:
  // todas las líneas del picking.
  //
  // pending_moves:
  // cualquier línea que NO esté done/cancel.
  //
  // También consideramos state NULL como pendiente.
  // ==========================================================

  const movesResult =
    await client.query(
      `
      SELECT

        COUNT(*)::int AS total_moves,

        COUNT(*) FILTER (
          WHERE
            state IS NULL
            OR state NOT IN (
              'done',
              'cancel'
            )
        )::int AS pending_moves

      FROM stock_move

      WHERE picking_id = $1
      `,
      [
        parsedPickingId
      ]
    );


  const totalMoves =
    Number(
      movesResult.rows[0]?.total_moves ??
      0
    );


  const pendingMoves =
    Number(
      movesResult.rows[0]?.pending_moves ??
      0
    );


  console.log(
    "📊 ESTADO STOCK_MOVES:",
    {
      pickingId:
        parsedPickingId,

      totalMoves,

      pendingMoves
    }
  );


  // ==========================================================
  // 3. NO EXISTEN STOCK_MOVES
  // ==========================================================
  //
  // Por seguridad NO desasignamos.
  // ==========================================================

  if (
    totalMoves === 0
  ) {

    console.log(
      "⚠️ El picking no tiene stock_move. Se mantiene asignado."
    );


    return {
      success:
        true,

      code:
        "PICKING_HAS_NO_MOVES",

      released:
        false,

      pickingId:
        parsedPickingId,

      totalMoves:
        0,

      pendingMoves:
        0,

      message:
        "El picking no tiene líneas en stock_move y se mantiene asignado."
    };
  }


  // ==========================================================
  // 4. TODAVÍA EXISTEN MOVES PENDIENTES
  // ==========================================================

  if (
    pendingMoves > 0
  ) {

    console.log(
      "⏳ El picking todavía tiene movimientos pendientes."
    );


    console.log(
      "🔒 Se mantiene asignado."
    );


    return {
      success:
        true,

      code:
        "PICKING_STILL_IN_PROGRESS",

      released:
        false,

      pickingId:
        parsedPickingId,

      totalMoves,

      pendingMoves,

      message:
        "El picking todavía tiene líneas pendientes y continúa asignado."
    };
  }


  // ==========================================================
  // 5. TODAS LAS LÍNEAS ESTÁN DONE O CANCEL
  // ==========================================================

  console.log(
    "✅ Todos los stock_move están done o cancel."
  );


  console.log(
    "🗑️ Eliminando picking_assignments..."
  );


  const deleteResult =
    await client.query(
      `
      DELETE FROM picking_assignments

      WHERE stock_picking_id = $1

      RETURNING *
      `,
      [
        parsedPickingId
      ]
    );


  console.log(
    "🗑️ ASIGNACIONES ELIMINADAS:",
    deleteResult.rowCount
  );


  // ==========================================================
  // 6. RESULTADO
  // ==========================================================

  return {
    success:
      true,

    code:
      "PICKING_ASSIGNMENT_RELEASED",

    released:
      true,

    pickingId:
      parsedPickingId,

    totalMoves,

    pendingMoves:
      0,

    deletedAssignments:
      deleteResult.rowCount,

    message:
      deleteResult.rowCount > 0
        ? "Todas las líneas están completadas o canceladas. El picking fue desasignado."
        : "Todas las líneas están completadas o canceladas, pero el picking ya no tenía una asignación."
  };
}