import { db } from "../db.js";

export async function assignmentService() {
    const client = await db.connect();

    console.log("🚀 INICIANDO SERVICIO DE ASIGNACIÓN");

    try {

        await client.query("BEGIN");

        // PASO 1 Buscar los pedidos activos que hay en el sistema
        const pickings = await getActivePickings(client);

        console.log("Pickings encontrados:", pickings.length);

        //Por cada pedido que existe
        for (const picking of pickings) {

            const lockedPicking = await lockPicking(client, picking.id);

            console.log("🔒 PICKING LOCKED:", lockedPicking.id);

            // buscar moves
            const moves = await client.query(`
    SELECT sm.*, p.sku
    FROM stock_move sm
    JOIN products p ON p.id = sm.product_id
    WHERE sm.picking_id = $1
    AND sm.state IN ('confirmed', 'partially_available', 'draft')
`, [picking.id]);

            console.log("NUMERO DE PRODUCTOS EN UN PEDIDO", moves.rowCount);

            let totalReserved = 0;

            /* ==============================
               1️⃣ RESERVAR INVENTARIO
            ============================== 

            for (const move of moves.rows) {
                //console.log("🚨🚨 ALERTA", move);
                const result = await reserveInventoryForMove(client, move);

                console.log("Resultado reserva:", result);

                totalReserved += result.reserved;
            }
                
            /* ==============================
               2️⃣ VERIFICAR SI SE RESERVÓ ALGO
            ============================== 

            if (totalReserved === 0) {

                console.log("⚠️ No se pudo reservar inventario para este picking");

                continue;
            }*/



            /* ==============================
               3️⃣ BUSCAR PICKER DISPONIBLE
            ============================== */

            let elElegido = await getActivePickers(client);

            if (!elElegido) {

                console.log("⚠️ No hay picker disponible");

                elElegido = await service1(client); // ✅ REUTILIZA LA VARIABLE

                if (!elElegido) {
                    console.log("❌ Tampoco se pudo asignar por carga");
                    continue;
                }
            }

            console.log("🎯 PICKER SELECCIONADO:", elElegido);



            /* ==============================
               5️⃣ CREAR ASIGNACIÓN
            ============================== */

            const existing = await client.query(`
  SELECT 1
  FROM picking_assignments
  WHERE stock_picking_id = $1
`, [picking.id]);

            if (existing.rowCount === 0) {

                await client.query(`
    INSERT INTO picking_assignments (
      stock_picking_id,
      picker_id,
      assignment_datetime,
      assignment_day,
      line_count
    )
    VALUES ($1, $2, NOW(), CURRENT_DATE, $3)
  `, [picking.id, elElegido, moves.rowCount]);

                console.log("✅ Picking asignado correctamente");

                /* ==============================
                   4️⃣ ACTUALIZAR PICKING (SOLO SI INSERTÓ)
                ============================== */

                await client.query(`
    UPDATE stock_picking sp
    SET 
        state = 'assigned',
        user_id = p.user_id
    FROM pickers p
    WHERE sp.id = $1
    AND p.id = $2
  `, [picking.id, elElegido]);

            }

        }

        await client.query("COMMIT");

    } catch (error) {

        await client.query("ROLLBACK");
        console.error("ERROR:", error);

    } finally {
        client.release();
    }

}





async function getActivePickers(client) {

    console.log("🔎 Buscando pickers activos...");

    /* =====================================
       1️⃣ OBTENER PICKERS ACTIVOS
    ===================================== */

    const activeResult = await client.query(`
    SELECT id
    FROM pickers
    WHERE active = TRUE
    AND active_today = TRUE
  `);

    const activeIds = activeResult.rows.map(r => r.id);

    console.log("PICKERS ACTIVOS:", activeIds);

    if (activeIds.length === 0) {

        console.log("⚠️ No hay pickers activos");

        return null;

    }

    /* =====================================
       2️⃣ BUSCAR PICKERS SIN ASIGNACIONES HOY
    ===================================== */

    const noneAssignmentsResult = await client.query(`
    SELECT p.id
    FROM pickers p
    WHERE p.id = ANY($1)
    AND NOT EXISTS (
        SELECT 1
        FROM picking_assignments pa
        WHERE pa.picker_id = p.id
        AND pa.assignment_day = CURRENT_DATE
    )
  `, [activeIds]);

    const noneAssignments = noneAssignmentsResult.rows.map(r => r.id);

    console.log("PICKERS SIN ASIGNACIONES HOY:", noneAssignments);

    /* =====================================
       3️⃣ SELECCIONAR PICKER
    ===================================== */

    let elElegido = null;

    if (noneAssignments.length > 0) {

        const randomIndex = Math.floor(Math.random() * noneAssignments.length);

        elElegido = noneAssignments[randomIndex];

    }

    /* =====================================
       4️⃣ RESULTADO
    ===================================== */

    if (elElegido) {

        console.log("🎯 PICKER SELECCIONADO:", elElegido);

        return elElegido;

    }

    console.log("⚠️ Todos los pickers ya tienen asignaciones hoy");

    return null;

}



async function service1(client) {

    console.log("📦 SERVICE #1 — buscando picker con menos carga");

    /* ==============================
       1️⃣ PICKERS ACTIVOS
    ============================== */

    const activeResult = await client.query(`
        SELECT id
        FROM pickers
        WHERE active = TRUE
        AND active_today = TRUE
        FOR UPDATE
    `);

    const activeIds = activeResult.rows.map(r => r.id);

    console.log("🟢 ACTIVE PICKERS:", activeIds);

    if (activeIds.length === 0) {
        console.log("⚠️ No hay pickers activos");
        return null;
    }

    /* ==============================
       2️⃣ CARGA POR PICKER (HOY)
    ============================== */

    const loadResult = await client.query(`
    SELECT 
        picker_id,
        SUM(line_count) AS total_lines
    FROM picking_assignments
    WHERE assignment_day = CURRENT_DATE
    AND picker_id = ANY($1)
    GROUP BY picker_id
`, [activeIds]);

    const loadMap = new Map();

    // inicializar todos en 0
    for (const id of activeIds) {
        loadMap.set(id, 0);
    }

    // llenar con datos reales
    for (const row of loadResult.rows) {
        loadMap.set(row.picker_id, Number(row.total_lines));
    }

    console.log("📊 CARGA POR PICKER:", Object.fromEntries(loadMap));

    /* ==============================
       3️⃣ ENCONTRAR MÍNIMO
    ============================== */

    let minLoad = Infinity;

    for (const value of loadMap.values()) {
        if (value < minLoad) {
            minLoad = value;
        }
    }

    /* ==============================
       4️⃣ PICKERS CON MENOR CARGA
    ============================== */

    const candidatos = [];

    for (const [pickerId, load] of loadMap.entries()) {
        if (load === minLoad) {
            candidatos.push(pickerId);
        }
    }

    console.log("🎯 PICKERS CON MENOR CARGA:", candidatos);

    /* ==============================
       5️⃣ DESEMPATE RANDOM
    ============================== */

    const randomIndex = Math.floor(Math.random() * candidatos.length);
    const elElegido = candidatos[randomIndex];

    console.log("🏆 PICKER ELEGIDO:", elElegido);

    return elElegido;
}




async function getActivePickings(client) {

    const result = await client.query(`
    SELECT id
    FROM stock_picking
    WHERE picking_type = 'outgoing'
    AND state NOT IN ('assigned', 'cancel', 'done')
    FOR UPDATE SKIP LOCKED
    `);

    return result.rows;

}
//LOCK PICKING FOR UPDATE
async function lockPicking(client, pickingId) {

    const result = await client.query(`
    SELECT *
    FROM stock_picking
    WHERE id = $1
    FOR UPDATE
  `, [pickingId]);

    return result.rows[0];

}