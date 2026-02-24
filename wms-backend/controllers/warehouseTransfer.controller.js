import { db } from "../db.js";
import { getActiveProductById, getPrimaryBarcodeBySku, getActiveProductBySku } from "../services/productService.js";
import { getActiveStorageLocationByCode, getUserActiveLocation, getActiveLocationByCodeAndType } from "../services/locationService.js";
import { moveInventoryBetweenLocations, createInventoryMovement } from "../services/inventoryService.js";
import { getActiveTransferSession } from "../services/transferSession.service.js";
import { AppError } from "../utils/AppError.js";
import { validatePickingService } from "../services/pickingService.js";
import { buildTransferHtml } from "../templates/build-nota-recepcion.js";
import { generatePdf } from "../templates/generate-nota-recepcion.js";
import { randomUUID } from "crypto";
import { uploadPdfToS3 } from "../services/s3UploadPdf.js";
import { sendTransferEmail } from "../services/sendReceiptEmail.js";

//Start putaway transfer pick session
export async function authorizeWarehouseSession(req, res) {
    try {

        //const userId = req.user?.id;
        //🚨🚨🚨🚨🚨🚨🚨QUITAR LO DE ABAJO
        const userId = 1;

        if (!userId) {
            throw new AppError("User not authenticated", 401);
        }

        // 🔹 1. Buscar almacenes activos
        const query = `
      SELECT id, code, name
      FROM warehouses
      WHERE status = 'ACTIVE'
      ORDER BY name ASC;
    `;

        const { rows: warehouses } = await db.query(query);
        const total = warehouses.length;

        // 🔹 2. Validar cantidad de almacenes
        if (total <= 1) {
            return res.status(200).json({
                success: true,
                status: "INACTIVE",
                message: total === 0
                    ? "No active warehouses found. Transfer not available."
                    : "Only one warehouse available. Transfer requires at least two warehouses.",
                warehouses_count: total,
                warehouses: warehouses
            });
        }

        // 🔹 3. Buscar picking interno abierto y NO locked
        const pickingSearch = `
  SELECT id, name, location_id, location_dest_id
  FROM stock_picking
  WHERE picking_type = 'internal'
  AND state IN ('draft','confirmed','assigned')
  AND COALESCE(locked,false) = false
  ORDER BY id DESC
  LIMIT 1;
`;

        const { rows: pickingRows } = await db.query(pickingSearch);

        let picking;

        // 🟢 4. Si existe picking abierto → usarlo
        if (pickingRows.length > 0) {
            picking = pickingRows[0];
        }
        // 🟢 5. Si NO existe → crear uno
        else {
            const { rows } = await db.query(`
        INSERT INTO stock_picking (
          picking_type,
          state,
          user_id,
          create_date
        )
        VALUES ('internal','draft',$1,now())
        RETURNING id, name, location_id, location_dest_id;
      `, [userId]);

            picking = rows[0];
        }



        //BUSCAR STOCK MOVE POR EL PICKING EXISTENTE
        const pendingQuery = `
            SELECT 
            sm.id,
            sm.product_id,
            sm.product_qty,
            sm.state,

            p.sku,
            p.description,
            p.uom

            FROM stock_move sm
            JOIN products p ON p.id = sm.product_id

            WHERE sm.picking_id = $1
            AND sm.state NOT IN ('done','cancel')

            AND p.status = 'ACTIVE'
            AND p.deleted_erp = false

            ORDER BY sm.id ASC
            `;

        const { rows: pendingLines } = await db.query(pendingQuery, [picking.id]);

        return res.status(200).json({
            success: true,
            status: "ACTIVE",
            message: "Warehouse transfer session ready",
            warehouses_count: total,
            warehouses,

            picking: {
                pickingId: picking.id,
                name: picking.name,
                location_id: picking.location_id,
                location_dest_id: picking.location_dest_id
            },

            pendingLines: pendingLines || []
        });



    } catch (error) {
        console.error("authorizeWarehouseSession error:", error);

        return res.status(500).json({
            success: false,
            status: "ERROR",
            message: "Server error",
            error: error.message
        });
    }
}

//set up location origen
export async function settingLocationOrigin(req, res) {

    console.log("BODY LLEGANDO:", req.body);

    try {
        const { picking_id, warehouse_id } = req.body;

        console.log(picking_id);
        console.log(warehouse_id);

        // 🔹 Validar que venga el id
        if (!picking_id) {
            return res.status(400).json({
                success: false,
                message: "picking_id es requerido"
            });
        }

        // 🔹 Validar input
        if (!warehouse_id) {
            return res.status(400).json({
                success: false,
                message: "warehouse_id es requerido"
            });
        }

        // 🔹 Query validar picking elegible
        const query = `
      SELECT id, state, picking_type
      FROM stock_picking
      WHERE id = $1
        AND picking_type = 'internal'
        AND state NOT IN ('done', 'cancel')
      LIMIT 1;
    `;

        const { rows } = await db.query(query, [picking_id]);

        // 🔴 Si no existe o no es válido
        if (rows.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Picking inválido: no existe, no es interno, o ya está done/cancel."
            });
        }

        // 🟢 Picking válido
        const picking = rows[0];

        //-------------------------

        // 🔹 Query validar warehouse activo
        const warehouseQuery = `
            SELECT id, code, name, status
            FROM warehouses
            WHERE id = $1
                AND status = 'ACTIVE'
            LIMIT 1;
            `;


        const warehouseResult = await db.query(warehouseQuery, [warehouse_id]);

        if (warehouseResult.rows.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Warehouse inválido o inactivo."
            });
        }

        const warehouse = warehouseResult.rows[0];

        // 🔹 PASO 4: actualizar location origen
        const updateQuery = `
            UPDATE stock_picking
            SET location_id = $1
            WHERE id = $2
            RETURNING id, location_id, location_dest_id, state, picking_type, write_date;
            `;

        const updateResult = await db.query(updateQuery, [warehouse_id, picking_id]);

        if (updateResult.rows.length === 0) {
            return res.status(400).json({
                success: false,
                message: "No se pudo actualizar el picking."
            });
        }

        const updatedPicking = updateResult.rows[0];

        return res.status(200).json({
            success: true,
            message: "Picking validado y location origen configurado",
            picking_before_update: picking,
            warehouse: warehouse,
            picking_updated: updatedPicking
        });


    } catch (error) {
        console.error("Error validando picking:", error);

        return res.status(500).json({
            success: false,
            message: "Error del servidor",
            error: error.message
        });
    }
}


// set up destination location
export async function settingLocationDestination(req, res) {
    try {
        const { picking_id, warehouse_id } = req.body;

        // 🔹 Validate inputs
        if (!picking_id) {
            return res.status(400).json({
                success: false,
                message: "picking_id is required"
            });
        }

        if (!warehouse_id) {
            return res.status(400).json({
                success: false,
                message: "warehouse_id is required"
            });
        }

        // =====================================================
        // 🔹 STEP 1: validate picking
        // =====================================================
        const pickingQuery = `
            SELECT id, state, picking_type
            FROM stock_picking
            WHERE id = $1
              AND picking_type = 'internal'
              AND state NOT IN ('done','cancel')
            LIMIT 1;
        `;

        const pickingResult = await db.query(pickingQuery, [picking_id]);

        if (pickingResult.rows.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Invalid picking: does not exist, is not internal, or already done/cancelled."
            });
        }

        const picking = pickingResult.rows[0];

        // =====================================================
        // 🔹 STEP 2: validate active warehouse
        // =====================================================
        const warehouseQuery = `
            SELECT id, code, name, status
            FROM warehouses
            WHERE id = $1
              AND status = 'ACTIVE'
            LIMIT 1;
        `;

        const warehouseResult = await db.query(warehouseQuery, [warehouse_id]);

        if (warehouseResult.rows.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Invalid or inactive warehouse."
            });
        }

        const warehouse = warehouseResult.rows[0];

        // =====================================================
        // 🔹 STEP 3: update destination location
        // write_date updates automatically via trigger
        // =====================================================
        const updateQuery = `
            UPDATE stock_picking
            SET location_dest_id = $1
            WHERE id = $2
            RETURNING id, location_id, location_dest_id, state, picking_type, write_date;
        `;

        const updateResult = await db.query(updateQuery, [warehouse_id, picking_id]);

        if (updateResult.rows.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Failed to update picking destination."
            });
        }

        const updatedPicking = updateResult.rows[0];

        // =====================================================
        // 🟢 RESPONSE
        // =====================================================
        return res.status(200).json({
            success: true,
            message: "Destination location configured successfully",
            picking_before_update: picking,
            warehouse: warehouse,
            picking_updated: updatedPicking
        });

    } catch (error) {
        console.error("Error setting destination location:", error);

        return res.status(500).json({
            success: false,
            message: "Server error",
            error: error.message
        });
    }
}


// saving internal picking
export async function addProductToInternalPicking(req, res) {
    const client = await db.connect();

    try {
        const {
            picking_id,
            product_id,
            qty,
            location_id,
            warehouse_id,
            warehouse_dest_id,
        } = req.body;
        const user_id = req.user.id;
        console.log(picking_id);
        console.log(product_id);
        console.log(warehouse_id);
        console.log(warehouse_dest_id);
        console.log(user_id);
        console.log(qty);
        // =====================================================
        // 🟦 1) VALIDAR PARAMETROS
        // =====================================================
        if (!picking_id || !product_id || !warehouse_id || !warehouse_dest_id || !user_id || qty === undefined) {
            return res.status(400).json({ success: false, message: "Missing required data." });
        }

        // qty > 0
        if (Number(qty) <= 0) {
            return res.status(400).json({ success: false, message: "qty must be greater than 0." });
        }

        // origen != destino
        if (Number(warehouse_id) === Number(warehouse_dest_id)) {
            return res.status(400).json({
                success: false,
                message: "Origin and destination locations cannot be the same."
            });
        }

        // =====================================================
        // 🟦 2) BEGIN TRANSACTION
        // =====================================================
        await client.query("BEGIN");

        // =====================================================
        // 🟦 3) LOCK + VALIDAR PICKING (FOR UPDATE)
        //     - existe
        //     - state NOT IN done/cancel
        //     - (opcional) picking_type internal
        //     - location_id y location_dest_id deben coincidir con lo que envía el request
        // =====================================================
        const pickingQ = `
      SELECT id, name, state, picking_type, location_id, location_dest_id
      FROM stock_picking
      WHERE id = $1
      FOR UPDATE;
    `;
        const pickingR = await client.query(pickingQ, [picking_id]);

        if (pickingR.rowCount === 0) {
            await client.query("ROLLBACK");
            return res.status(400).json({ success: false, message: "Picking not found." });
        }

        const picking = pickingR.rows[0];

        if (["done", "cancel"].includes(String(picking.state))) {
            await client.query("ROLLBACK");
            return res.status(400).json({ success: false, message: "Picking is closed (done/cancel)." });
        }

        // si quieres forzar internal:
        if (String(picking.picking_type) !== "internal") {
            await client.query("ROLLBACK");
            return res.status(400).json({ success: false, message: "Picking is not internal." });
        }
        console.log("PICKING", picking.location_id);
        // validar que request location_id coincida con el picking
        if (Number(picking.location_id) !== Number(warehouse_id)) {
            await client.query("ROLLBACK");
            return res.status(400).json({
                success: false,
                message: "Origin location does not match picking origin (stock_picking.location_id)."
            });
        }

        if (Number(picking.location_dest_id) !== Number(warehouse_dest_id)) {
            await client.query("ROLLBACK");
            return res.status(400).json({
                success: false,
                message: "Destination location does not match picking destination (stock_picking.location_dest_id)."
            });
        }

        // Si picking estaba draft => confirmed
        if (String(picking.state) === "draft") {
            await client.query(
                `UPDATE stock_picking SET state = 'confirmed', write_date = NOW() WHERE id = $1;`,
                [picking_id]
            );
        }

        // =====================================================
        // 🟦 4) VALIDAR LOCATION ACTIVA DEL USUARIO + MISMO ORIGEN
        //     (ideal: usar client, no db)
        // =====================================================
        const userLocation = await getUserActiveLocation(client, user_id);


        if (!userLocation) {
            await client.query("ROLLBACK");
            return res.status(400).json({
                success: false,
                message: "User has no active location assigned."
            });
        }


        /* el usuario debe estar en el almacén origen
        if (Number(userLocation.warehouse_id) !== Number(warehouse_id)) {
            await client.query("ROLLBACK");
            return res.status(403).json({
                success: false,
                message: "User is not in the origin location."
            });
        }*/


        // =====================================================
        // 🟦 5) VALIDAR PRODUCTO ACTIVO (lock opcional)
        // =====================================================
        console.log("PRODUCT ID: ", product_id);

        const productQ = `
      SELECT id, uom_id, sku
      FROM products
      WHERE id = $1
        AND deleted_erp = false
        AND status = 'ACTIVE'
      LIMIT 1;
    `;
        const productR = await client.query(productQ, [product_id]);

        if (productR.rowCount === 0) {
            await client.query("ROLLBACK");
            return res.status(400).json({
                success: false,
                message: "Product not found or inactive."
            });
        }
        console.log("ORIGEN DE PRODUCTO", productR.rows[0]);
        const { uom_id: productUomId, sku } = productR.rows[0];

        // =====================================================
        // 🟦 6) VALIDAR INVENTARIO DISPONIBLE REAL (considerando reservado)
        //     Usamos FOR UPDATE para lock del inventario origen
        // =====================================================
        const invQ = `
  SELECT id, qty_available
  FROM inventory_by_location
  WHERE product_sku = $1
    AND warehouse_id = $2
    AND location_id = $3
  FOR UPDATE;
`;
        console.log("$1", sku);
        console.log("$2", warehouse_id);
        console.log("$3", location_id);
        const invR = await client.query(invQ, [sku, warehouse_id, location_id]);
        console.log(invR);
        // ❌ no existe inventario en esa ubicación exacta
        if (invR.rowCount === 0) {
            await client.query("ROLLBACK");
            return res.status(400).json({
                success: false,
                message: "No inventory found in the specified location."
            });
        }

        // ⚠️ seguridad: no debería existir más de una fila
        if (invR.rowCount > 1) {
            await client.query("ROLLBACK");
            return res.status(500).json({
                success: false,
                message: "Inventory data inconsistency: multiple rows found for same product/location."
            });
        }

        // 🔥 qty_available ya es real
        const availableReal = Number(invR.rows[0].qty_available);

        if (availableReal < Number(qty)) {
            await client.query("ROLLBACK");
            return res.status(400).json({
                success: false,
                message: `Not enough inventory. Available: ${availableReal}`
            });
        }



        // =====================================================
        // 🟦 7) UPSERT LÓGICO: si existe stock_move (picking_id + product_id) => update
        //     si no existe => insert
        //     También puedes lockear la fila existente con FOR UPDATE
        // =====================================================
        const existingMoveQ = `
            SELECT id, product_qty, reserved_qty, state
            FROM stock_move
            WHERE picking_id = $1
                AND product_id = $2
                AND state NOT IN ('cancel', 'done')
            LIMIT 1
            FOR UPDATE;
            `;
        const existingMoveR = await client.query(existingMoveQ, [picking_id, product_id]);

        let move;
        let referenceMoveId;


        if (existingMoveR.rowCount > 0) {

            const current = existingMoveR.rows[0];

            // 🔥 acumular qty
            const newQty = Number(current.product_qty) + Number(qty);

            const updMoveQ = `
                UPDATE stock_move
                SET
                product_qty = $1,
                state = 'confirmed',
                write_date = NOW(),
                user_id = $2,
                user_location = $3,
                product_uom_id = COALESCE(product_uom_id, $4)
                WHERE id = $5
                RETURNING *;
            `;

            const updMoveR = await client.query(updMoveQ, [
                newQty,
                user_id,
                userLocation.id,
                productUomId,
                current.id
            ]);

            move = updMoveR.rows[0];
            referenceMoveId = current.id;
        } else {




            // Insert nuevo move limpio
            const insMoveQ = `
    INSERT INTO stock_move (
      name,
      reference,
      state,
      product_id,
      product_qty,
      quantity_done,
      warehouse_id,
      warehouse_dest_id,
      picking_id,
      create_date,
      user_id,
      product_uom_id,
      user_location
    )
    VALUES (
      $1,$2,'confirmed',$3,$4,0,$5,$6,$7,NOW(),$8,$9,$10
    )
    RETURNING *;
  `;

            const insMoveR = await client.query(insMoveQ, [
                `MOVE-${Date.now()}`,
                picking.name,
                product_id,
                qty,
                warehouse_id,
                warehouse_dest_id,
                picking_id,
                user_id,
                productUomId,
                userLocation.id
            ]);

            move = insMoveR.rows[0];
            referenceMoveId = move.id;
        }


        // =====================================================
        // 🟦 8) MOVER INVENTARIO + CREAR INVENTORY_MOVEMENTS
        //     - ideal: todo dentro del mismo client/tx
        // =====================================================
        // IMPORTANTE: decide tu regla:
        // A) mover inventario real ahora
        // B) solo reservar ahora y mover cuando se "done"
        // Tú dijiste: "se mueve la cantidad qty ... con el servicio que ya existe"
        // => entonces movemos real aquí.

        await moveInventoryBetweenLocations(
            client,
            {
                warehouseId: Number(warehouse_id),
                productSku: sku,
                fromLocationId: Number(location_id),
                toLocationId: Number(userLocation.id),
                qty: Number(qty)
            }
        );


        // crear inventory_movements con movement_type = WAREHOUSE_TRANSFER
        const movementResult = await createInventoryMovement(client, {
            productSku: sku,
            fromLocationId: Number(location_id),
            toLocationId: Number(userLocation.id),
            qty: Number(qty),
            movementType: "MOVE",   // 🔥 importante
            referenceType: "stock.move",    // opcional pero recomendado
            referenceId: referenceMoveId,
            createdBy: user_id,
            note: `Transfer from ${location_id} to ${userLocation.id}`
        });


        // =====================================================
        // 🟩 9) COMMIT
        // =====================================================
        await client.query("COMMIT");

        return res.status(200).json({
            success: true,
            message: "Product added to transfer successfully.",
            picking_id: picking_id,

            product: {
                product_id: product_id,
                sku: sku,
                qty_added: Number(qty)
            },

            stock_move: {
                move_id: move.id,
                total_qty_in_move: move.product_qty,
                state: move.state
            },

            inventory_movement: movementResult.rows[0]
        });


    } catch (error) {
        try { await client.query("ROLLBACK"); } catch (_) { }

        console.error("🔥 ERROR REAL saveInternalPickingProduct:", error);

        // si el error ya es controlado (tiene status)
        if (error.status) {
            return res.status(error.status).json({
                success: false,
                message: error.message
            });
        }

        // si viene de tus validaciones manuales
        if (error.message) {
            return res.status(400).json({
                success: false,
                message: error.message
            });
        }

        // error desconocido
        return res.status(500).json({
            success: false,
            message: "Server error inesperado"
        });
    } finally {
        client.release();
    }
}

//CLean all picking locations
export async function clearPickingLocations(req, res) {
    try {
        const { picking_id } = req.body;

        if (!picking_id) {
            return res.status(400).json({
                success: false,
                message: "picking_id requerido"
            });
        }

        // 🔎 buscar picking
        const pickingQuery = `
      SELECT id, state
      FROM stock_picking
      WHERE id = $1
      LIMIT 1
    `;
        const { rows } = await db.query(pickingQuery, [picking_id]);

        if (rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Picking no encontrado"
            });
        }

        const picking = rows[0];

        // ❌ no permitir si ya terminado
        if (["done", "cancel"].includes(picking.state)) {
            return res.status(400).json({
                success: false,
                message: "No se puede modificar un picking finalizado"
            });
        }

        // 🧹 limpiar locations
        await db.query(
            `
      UPDATE stock_picking
      SET 
        location_id = NULL,
        location_dest_id = NULL,
        write_date = NOW()
      WHERE id = $1
      `,
            [picking_id]
        );

        return res.json({
            success: true,
            message: "Almacenes limpiados correctamente"
        });

    } catch (error) {
        console.error("clearPickingLocations error:", error);

        return res.status(500).json({
            success: false,
            message: "Error limpiando almacenes",
            error: error.message
        });
    }
}


//Delete a stock move and revert inventory movements
export async function deleteWarehouseTransferLine(req, res) {
    const client = await db.connect();
    console.log("funciona funciona funciona");
    try {
        await client.query("BEGIN");

        const userId = req.user?.id;
        const { deleteLineId } = req.body;
        console.log(userId);
        console.log(deleteLineId);

        // -------------------------------------------------
        // 1. VALIDAR USER
        // -------------------------------------------------
        if (!userId) {
            return res.status(401).json({
                success: false,
                message: "Usuario no autenticado"
            });
        }

        // -------------------------------------------------
        // 2. VALIDAR ID LINEA
        // -------------------------------------------------
        if (!deleteLineId) {
            return res.status(400).json({
                success: false,
                message: "deleteLineId requerido"
            });
        }

        // -------------------------------------------------
        // 3. BUSCAR PERMISOS
        // -------------------------------------------------
        const userQuery = await client.query(`
            SELECT permissions
            FROM users
            WHERE id = $1
            AND is_active = true
            LIMIT 1
        `, [userId]);

        if (!userQuery.rows.length) {
            return res.status(403).json({
                success: false,
                message: "Usuario no activo o no existe"
            });
        }

        const permissions = userQuery.rows[0].permissions || {};

        const canDelete =
            permissions?.warehouse_transfer?.delete_stock_line === true;

        if (!canDelete) {
            return res.status(400).json({
                success: false,
                title: "Acceso no permitido.",
                message: "Este usuario no tiene permiso para borrar líneas de stock."
            });
        }

        // -------------------------------------------------
        // 4. BUSCAR LINEA STOCK MOVE
        // -------------------------------------------------
        const lineQuery = await client.query(`
            SELECT 
                id,
                product_qty,
                quantity_done,
                reserved_qty,
                warehouse_id,
                user_id,
                user_location,
                picking_id,
                state
            FROM stock_move
            WHERE id = $1
            LIMIT 1
        `, [deleteLineId]);

        if (!lineQuery.rows.length) {
            return res.status(404).json({
                success: false,
                message: "Línea de traslado no existe"
            });
        }

        const line = lineQuery.rows[0];
        const pickingId = line.picking_id;
        console.log("PICKING DE LINEA", pickingId);

        // -------------------------------------------------
        // 5. VALIDAR ESTADO
        // -------------------------------------------------
        if (["done", "cancel"].includes(line.state)) {
            return res.status(400).json({
                success: false,
                message: "No se puede eliminar una línea ya finalizada o cancelada"
            });
        }

        // -------------------------------------------------
        // 6. VALIDAR OWNER
        // -------------------------------------------------
        if (Number(line.user_id) !== Number(userId)) {
            return res.status(403).json({
                success: false,
                message: "No puede eliminar una línea creada por otro usuario"
            });
        }

        const query = `
      SELECT id, name, state, locked
      FROM stock_picking
      WHERE id = $1
      AND state NOT IN ('done','cancel')
      LIMIT 1
    `;

        const { rows } = await client.query(query, [pickingId]);

        // ❌ no existe o ya está done/cancel
        if (rows.length === 0) {
            return {
                success: false,
                title: "Picking no válido",
                message: "El traslado ya está completado, cancelado o no existe."
            };
        }

        const picking = rows[0];
        console.log("PICKING", picking);

        // 🔒 si está locked
        if (picking.locked === true) {
            console.log("Error PICKING BLOCKED")
            return res.status(400).json({
                success: false,
                title: "Transferencia cerrada",
                message: `El picking ${picking.name} está cerrado y no puede eliminarse ninguna linea.`
            });
        }


        // -------------------------------------------------
        // 7. CANCELAR LINEA
        // -------------------------------------------------
        await client.query(`
            UPDATE stock_move
            SET state='cancel',
                write_date = NOW()
            WHERE id=$1
        `, [deleteLineId]);

        // -------------------------------------------------
        // 8. BUSCAR MOVIMIENTOS INVENTARIO
        // -------------------------------------------------
        const movements = await client.query(`
            SELECT 
                product_sku,
                from_location_id,
                to_location_id,
                qty
            FROM inventory_movements
            WHERE reference_id = $1
            AND reference_type = 'stock.move'
        `, [deleteLineId]);

        // -------------------------------------------------
        // 9. REVERSAR INVENTARIO
        // -------------------------------------------------
        for (const mv of movements.rows) {

            const product_sku = mv.product_sku;
            const from_location_id = mv.from_location_id;
            const to_location_id = mv.to_location_id;
            const qty = mv.qty;

            // 🔁 devolver inventario
            await moveInventoryBetweenLocations(client, {
                warehouseId: Number(line.warehouse_id),
                productSku: product_sku,
                fromLocationId: Number(to_location_id),
                toLocationId: Number(from_location_id),
                qty: Number(qty)
            });

            // 🧾 log inventario
            await createInventoryMovement(client, {
                productSku: product_sku,
                fromLocationId: Number(to_location_id),
                toLocationId: Number(from_location_id),
                qty: Number(qty),
                movementType: "MOVE",
                referenceType: "stock.move(cancel)",
                referenceId: deleteLineId,
                createdBy: userId,
                note: `Cancelación de línea ${deleteLineId}`
            });
        }

        await client.query("COMMIT");

        return res.status(200).json({
            success: true,
            message: "Línea eliminada correctamente"
        });

    } catch (error) {
        await client.query("ROLLBACK");

        console.error("deleteWarehouseTransferLine:", error);

        return res.status(500).json({
            success: false,
            message: "Server error",
            error: error.message
        });

    } finally {
        client.release();
    }
}


//validar translado de almacen
export async function closeTransferSession(req, res) {
    const client = await db.connect();

    try {
        const picking_id = req.body.picking_id;

        const user_id = req.user.id;
        console.log(picking_id);
        console.log(req.user);
        console.log("📥 closeTransferSession:", req.body);

        // -------------------------------------------------
        // 1. VALIDAR BODY
        // -------------------------------------------------
        if (!picking_id || !user_id) {
            return res.status(400).json({
                success: false,
                title: "Datos requeridos",
                message: "picking_id y user_id son obligatorios"
            });
        }

        await client.query("BEGIN");

        // ----------------------------
        // 1) Buscar picking y BLOQUEARLO (FOR UPDATE)
        // ----------------------------

        const pickingQuery = `
        SELECT id, state, user_id, locked, name, location_id, location_dest_id
        FROM stock_picking
        WHERE id = $1
        FOR UPDATE;
        `;

        const pickingResult = await client.query(pickingQuery, [picking_id]);

        if (pickingResult.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({
                success: false,
                title: "Picking no existe",
                message: "No se encontró el picking indicado.",
            });
        }

        const picking = pickingResult.rows[0];

        const transferNumber = picking.name;              // 🔥 No. transferencia
        const originWarehouseId = picking.location_id;
        const destWarehouseId = picking.location_dest_id;

        //almacenes

        const warehouseQuery = `
SELECT id, code, name
FROM warehouses
WHERE id = ANY($1)
AND status = 'ACTIVE'
`;

        const warehouseResult = await client.query(warehouseQuery, [
            [originWarehouseId, destWarehouseId]
        ]);

        // ❌ Si no vienen ambos almacenes activos
        if (warehouseResult.rowCount < 2) {
            await client.query("ROLLBACK");

            return res.status(400).json({
                success: false,
                title: "Almacén inválido",
                message: "El almacén origen o destino no existe o está inactivo."
            });
        }

        let originWarehouse = null;
        let destWarehouse = null;

        for (const wh of warehouseResult.rows) {
            if (Number(wh.id) === Number(originWarehouseId)) {
                originWarehouse = wh;
            }

            if (Number(wh.id) === Number(destWarehouseId)) {
                destWarehouse = wh;
            }
        }

        // 🔴 doble seguridad (por si acaso)
        if (!originWarehouse || !destWarehouse) {
            await client.query("ROLLBACK");

            return res.status(400).json({
                success: false,
                title: "Error de almacenes",
                message: "No se pudo validar almacén origen o destino."
            });
        }

        //USER ACCOUNT

        const userQuery = `
SELECT id, full_name
FROM users
WHERE id = $1
AND is_active = true
LIMIT 1
`;

        const userResult = await client.query(userQuery, [user_id]);

        if (userResult.rowCount === 0) {
            throw new Error("Usuario no activo o no encontrado");
        }

        const user = userResult.rows[0];
        const userName = user.full_name;

        // ----------------------------
        // 2) Validar estado
        // ----------------------------
        if (["done", "cancel"].includes(picking.state)) {
            await client.query("ROLLBACK");
            return res.status(400).json({
                success: false,
                title: "Picking cerrado",
                message: `No se puede confirmar. El picking está en estado '${picking.state}'.`,
            });
        }

        // ----------------------------
        // 3) Validar locked
        // ----------------------------
        if (picking.locked) {
            await client.query("ROLLBACK");
            return res.status(400).json({
                success: false,
                title: "Traslado bloqueado",
                message: "Traslado ya fue validado.",
            });
        }

        // ----------------------------
        // 4) Validar dueño del picking
        // ----------------------------
        if (Number(picking.user_id) !== Number(user_id)) {
            await client.query("ROLLBACK");
            return res.status(403).json({
                success: false,
                title: "No autorizado",
                message: "Solo el usuario que creó el picking puede confirmarlo.",
            });
        }

        // -------------------------------------------------
        // 2.3 VALIDAR QUE HAY MOVES ABIERTOS
        // -------------------------------------------------
        const movesQuery = await client.query(`
        SELECT 
            id,
            product_id,
            product_qty,
            product_uom_id,
            warehouse_id,
            user_location
        FROM stock_move
        WHERE picking_id = $1
        AND state NOT IN ('done','cancel')
        FOR UPDATE;
        `, [picking_id]);

        const moves = movesQuery.rows;

        if (moves.length === 0) {
            await client.query("ROLLBACK");
            return res.status(400).json({
                success: false,
                title: "Sin líneas",
                message: "No hay líneas para procesar en este traslado"
            });
        }

        // moves ya traídos arriba
        for (const move of moves) {

            const userLocationId = Number(move.user_location);

            if (!userLocationId) {
                throw new Error(`Move ${move.id} no tiene user_location`);
            }

            await client.query(`
            INSERT INTO stock_move_line (
            move_id,
            picking_id,
            product_id,
            product_uom_id,
            product_uom_qty,
            qty_done,
            location_id,
            location_dest_id,
            state,
            user_id
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'assigned',$9)
        `, [
                move.id,
                picking_id,
                move.product_id,
                move.product_uom_id,
                Number(move.product_qty),
                0,           // qty_done
                userLocationId, // ubicación del usuario
                null,           // destino aún no
                user_id         // quien ejecuta
            ]);

        }

        // CREAR HEADER PARA EL PDF 

        const pdfHeader = {
            transferNo: transferNumber,

            origin: `${originWarehouse.code} - ${originWarehouse.name}`,
            destination: `${destWarehouse.code} - ${destWarehouse.name}`,

            createdBy: userName,
            date: new Date()
        };

        console.log("HEADER PDF:", pdfHeader);

        //BUSCAR LAS LINEAS DE PDF

        const query = `
SELECT 
    ROW_NUMBER() OVER (ORDER BY sm.id) AS line_no,
    sm.id AS move_id,
    sm.product_id,
    p.sku,
    p.description,
    sm.product_qty AS qty
FROM stock_move sm
JOIN products p ON p.id = sm.product_id
WHERE sm.picking_id = $1
AND sm.state NOT IN ('cancel')
ORDER BY sm.id;
`;

        const result = await client.query(query, [picking_id]);

        if (result.rowCount === 0) {
            throw new Error("Este traslado no tiene productos");
        }

        const enrichedLines = result.rows.map(r => ({
            line_no: Number(r.line_no),
            sku: r.sku,
            description: r.description,
            qty: Number(r.qty)
        }));

        console.log("📦 LINEAS PDF:", enrichedLines);


        const companyQuery = await client.query(`
  SELECT slug, receipt_email
  FROM companies
  WHERE is_active = TRUE
  LIMIT 1
`);

        if (!companyQuery.rows.length) {
            throw new Error("No active company found");
        }

        const slug = companyQuery.rows[0].slug;
        const receiptEmail = companyQuery.rows[0].receipt_email;

        console.log("SLUG:", slug);





        // ----------------------------
        // 7) Cerrar: actualizar estados y bloquear edición
        //  - NO ponemos write_date (como pediste)
        // ----------------------------
        await client.query(
            `
            UPDATE stock_move
            SET state='assigned'
            WHERE picking_id=$1
                AND state NOT IN ('done','cancel')
            `,
            [picking_id]
        );

        await client.query(
            `
            UPDATE stock_picking
            SET state='assigned',
                locked=true
            WHERE id=$1
            `,
            [picking_id]
        );




        const html = buildTransferHtml(pdfHeader, enrichedLines);

        const pdf = await generatePdf(html);

        //GENERAR NOMBRE DEL FILE:
        const tenantSlug = slug;
        // headerPDF.receiptId
        const year = new Date().getFullYear();  // 2026
        const uuid = randomUUID();

        // 📄 nombre del archivo
        const fileName = `receipt_${year}_${picking_id}_${uuid}.pdf`;

        // 🗂 ruta en S3 (multi-tenant)
        const s3Key = `${tenantSlug}/receipts/${fileName}`;

        // ☁️ subir a S3
        await uploadPdfToS3({
            buffer: pdf,
            key: s3Key,
        });

        console.log("✅ PDF subido a S3:", s3Key);

        const updateResult = await client.query(`
    UPDATE stock_picking
    SET pdf_url = $1
    WHERE id = $2
    RETURNING id;
  `, [s3Key, picking_id]);

        // 🔥 Si no actualizó ninguna fila
        if (updateResult.rowCount === 0) {
            throw new Error("Picking no encontrado o no se actualizó el PDF");
        }

        console.log("✅ PDF guardado en picking:", updateResult.rows[0].id);

        await client.query("COMMIT");
        await sendTransferEmail({
            receiptEmail,
            pdfBuffer: pdf, // el buffer que generaste
            transferCode: picking.name,
            slug
        });

        // -------------------------------------------------
        // RESPUESTA FINAL
        // -------------------------------------------------
        return res.status(200).json({
            success: true,
            title: "Traslado cerrado",
            message: "La sesión de traslado fue cerrada correctamente"
        });

    } catch (error) {
        try { await client.query("ROLLBACK"); } catch (_) { }
        console.error("closeTransferSession:", error);

        return res.status(500).json({
            success: false,
            title: "Error del servidor",
            message: "No se pudo cerrar el traslado",
            error: error.message
        });

    } finally {
        client.release();
    }
}




//obtener todos los traslados pending
export async function getReceiveWarehouseTransfers(req, res) {
    const client = await db.connect();

    try {
        const userId = req.user.id;

        /* =============================
           1. VALIDAR USUARIO ACTIVO
        ============================== */

        const userQuery = `
      SELECT id, full_name, permissions
      FROM users
      WHERE id = $1
      AND is_active = true
      LIMIT 1
    `;

        const userResult = await client.query(userQuery, [userId]);

        if (userResult.rowCount === 0) {
            return res.status(404).json({
                success: false,
                title: "Usuario no válido",
                message: "Usuario no encontrado o inactivo",
            });
        }

        const user = userResult.rows[0];

        console.log("👤 Usuario:", user.full_name);
        console.log("🔐 Permisos:", user.permissions);

        /* =============================
           2. VALIDAR PERMISO
        ============================== */

        const hasAccess =
            user.permissions?.warehouse_transfer?.access_receive_module === true;

        if (!hasAccess) {
            return res.status(403).json({
                success: false,
                title: "Acceso denegado",
                message: "No tienes permiso para recibir traslados",
            });
        }

        /* =============================
           3. BUSCAR PICKINGS VALIDOS
        ============================== */

        const pickingQuery = `
      SELECT 
        sp.id,
        sp.name,
        sp.location_id,
        sp.location_dest_id,

        origin.code AS origin_code,
        origin.status AS origin_status,

        dest.code AS dest_code,
        dest.status AS dest_status

      FROM stock_picking sp

      JOIN warehouses origin 
        ON origin.id = sp.location_id

      JOIN warehouses dest 
        ON dest.id = sp.location_dest_id

      WHERE sp.state IN ('assigned','waiting')
      AND sp.picking_type = 'internal'
      AND sp.locked = true
    `;

        const pickingResult = await client.query(pickingQuery);

        if (pickingResult.rowCount === 0) {
            return res.json({
                success: false,
                title: "Sin traslados",
                message: "No hay traslados pendientes por recibir",
            });
        }

        /* =============================
           4. VALIDAR ALMACENES ACTIVOS
        ============================== */

        const validPickings = [];

        for (const picking of pickingResult.rows) {
            if (picking.origin_status !== "ACTIVE" || picking.dest_status !== "ACTIVE") {
                return res.json({
                    success: false,
                    title: "Almacén inactivo",
                    message: "Uno de los almacenes del traslado está inactivo",
                });
            }

            /* =============================
               5. CONTAR LINEAS EN STOCK_MOVE
            ============================== */

            const moveQuery = `
        SELECT COUNT(*) AS total
        FROM stock_move
        WHERE picking_id = $1
        AND state = 'assigned'
      `;

            const moveResult = await client.query(moveQuery, [picking.id]);

            const totalLines = parseInt(moveResult.rows[0].total);

            if (totalLines === 0) {
                return res.json({
                    success: false,
                    title: "Sin productos",
                    message: "El traslado no tiene líneas asignadas",
                });
            }

            validPickings.push({
                id: picking.id,
                name: picking.name,
                origin: picking.origin_code,
                destination: picking.dest_code,
                total_lines: totalLines,
            });
        }

        /* =============================
           6. RESPUESTA FINAL
        ============================== */

        return res.json({
            success: true,
            total: validPickings.length,
            data: validPickings,
        });

    } catch (error) {
        console.error("getReceiveWarehouseTransfers error:", error);

        return res.status(500).json({
            success: false,
            title: "Server error",
            message: "Error obteniendo traslados",
        });
    } finally {
        client.release();
    }
};




// Get receiving by picking id (warehouse transfer)
export async function getReceivingByPickingId(req, res) {

    const { pickingId } = req.params;
    const operatorId = req.user?.id;

    if (!pickingId) {
        return res.status(400).json({
            success: false,
            message: "PICKING_ID_REQUIRED",
        });
    }

    try {

        /* 1️⃣ Buscar picking */
        const pickingResult = await db.query(`
      SELECT id, name, state, locked
      FROM stock_picking
      WHERE id = $1
      LIMIT 1
    `, [pickingId]);

        if (pickingResult.rowCount === 0) {
            return res.status(404).json({
                success: false,
                title: "Picking no encontrado",
                message: "El traslado no existe."
            });
        }

        const picking = pickingResult.rows[0];

        /* ⛔ cancelado o done */
        if (["done", "cancel"].includes(picking.state)) {
            return res.status(409).json({
                success: false,
                title: "Picking cerrado",
                message: "Este traslado ya fue completado o cancelado."
            });
        }

        /* ⛔ no confirmado */
        if (picking.locked === false) {
            return res.status(409).json({
                success: false,
                title: "Picking no confirmado",
                message: "Debes confirmar el picking antes de recibir."
            });
        }

        /* 2️⃣ Buscar recepción activa */
        let receiptResult = await db.query(`
      SELECT id, status
      FROM receipts
      WHERE purchase_order_id = $1
      AND status NOT IN ('completed','abandoned')
      LIMIT 1
    `, [picking.id]);

        let receiptId;

        /* generar código */
        const seqResult = await db.query(`
      SELECT nextval('receipt_code_seq') AS seq
    `);

        const nextNumber = seqResult.rows[0].seq;
        const yearReceipt = new Date().getFullYear();
        const receiptCodeGenerated = `${yearReceipt}-${nextNumber}`;

        /* crear si no existe */
        if (receiptResult.rowCount === 0) {

            const createReceipt = await db.query(`
        INSERT INTO receipts (
          receipt_code,
          purchase_order_id,
          operator_id,
          status,
          started_at
        )
        VALUES ($1,$2,$3,'in_progress',NOW())
        RETURNING id
      `, [receiptCodeGenerated, picking.id, operatorId]);

            receiptId = createReceipt.rows[0].id;

        } else {
            receiptId = receiptResult.rows[0].id;
        }

        /* 3️⃣ Buscar líneas del picking */
        const linesResult = await db.query(`
      SELECT 
        sm.id,
        sm.product_id,
        sm.product_qty AS ordered_qty,
        sm.quantity_done AS received_qty,
        p.sku,
        p.description
      FROM stock_move sm
      JOIN products p ON p.id = sm.product_id
      WHERE sm.picking_id = $1
      AND sm.state NOT IN ('cancel','done') 
      AND p.status = 'ACTIVE'
      AND p.deleted_erp = false
      ORDER BY sm.id ASC
    `, [picking.id]);

        /* 4️⃣ Obtener SKUs */
        const validSkus = linesResult.rows.map(l => l.sku);

        /* 5️⃣ Buscar barcodes */
        let barcodeMap = new Map();

        if (validSkus.length > 0) {
            const barcodeResult = await db.query(`
        SELECT product_sku, barcode
        FROM product_barcodes
        WHERE product_sku = ANY($1)
      `, [validSkus]);

            barcodeResult.rows.forEach(row => {
                if (!barcodeMap.has(row.product_sku)) {
                    barcodeMap.set(row.product_sku, []);
                }
                barcodeMap.get(row.product_sku).push(row.barcode);
            });
        }

        /* 6️⃣ Enriquecer líneas */
        const enrichedLines = linesResult.rows.map(line => ({
            id: line.id,
            sku: line.sku,
            description: line.description,
            ordered_qty: Number(line.ordered_qty),
            received_qty: Number(line.received_qty),
            barcodes: barcodeMap.get(line.sku) || []
        }));

        /* 7️⃣ Respuesta */
        return res.status(200).json({
            success: true,
            data: {
                id: picking.id,
                picking_name: picking.name,
                receipt_id: receiptId,
                lines: enrichedLines
            }
        });

    } catch (error) {
        console.error("Error getReceivingByPickingId:", error);
        return res.status(500).json({
            success: false,
            message: "ERROR_FETCHING_PICKING_RECEIVING"
        });
    }
}




// Save warehouse transfer receiving
export async function saveWarehouseTransfer(req, res) {

  console.log("🚀 HIT /warehouse-transfers/save");
  console.log("BODY:", req.body);

  const client = await db.connect();

  try {

    const {
      picking_id,
      picking_name,
      reception_status, // se ignora
      lines
    } = req.body;

    /* ---------------- VALIDACIONES ---------------- */

    if (!picking_id || !picking_name) {
      return res.status(400).json({
        success:false,
        title:"Datos incompletos",
        message:"picking_id y picking_name son requeridos"
      });
    }

    if (!Array.isArray(lines) || lines.length === 0) {
      return res.status(400).json({
        success:false,
        title:"Sin líneas",
        message:"No hay líneas para actualizar"
      });
    }

    for (const line of lines) {
      if (
        typeof line.id !== "number" ||
        typeof line.quantity_done !== "number" ||
        line.quantity_done < 0
      ) {
        return res.status(400).json({
          success:false,
          title:"Formato inválido",
          message:"Cada línea debe tener id y quantity_done >= 0"
        });
      }
    }

    /* ---------------- TRANSACCIÓN ---------------- */

    await client.query("BEGIN");

    /* ---------------- VALIDAR PICKING ---------------- */

    const pickingResult = await client.query(`
      SELECT id, state, locked
      FROM stock_picking
      WHERE id = $1
      FOR UPDATE
    `,[picking_id]);

    if (pickingResult.rowCount === 0) {
      throw new Error("PICKING_NOT_FOUND");
    }

    const picking = pickingResult.rows[0];

    if (["done","cancel"].includes(picking.state)) {
      return res.status(409).json({
        success:false,
        title:"Picking cerrado",
        message:"El traslado ya está completado o cancelado"
      });
    }

    if (picking.locked !== true) {
      return res.status(409).json({
        success:false,
        title:"Picking no confirmado",
        message:"Debes confirmar el picking antes de recibir"
      });
    }

    /* 🔥 poner picking en waiting */
    await client.query(`
      UPDATE stock_picking
      SET state = 'waiting'
      WHERE id = $1
    `,[picking_id]);

    /* ---------------- UPDATE MASIVO stock_move ---------------- */

    const lineIds = lines.map(l => l.id);
    const qtys = lines.map(l => l.quantity_done);

    await client.query(`
      UPDATE stock_move sm
      SET quantity_done = data.quantity_done
      FROM (
        SELECT
          UNNEST($1::BIGINT[]) AS id,
          UNNEST($2::NUMERIC[]) AS quantity_done
      ) AS data
      WHERE sm.id = data.id
      AND sm.state NOT IN ('cancel','done')
    `,[lineIds, qtys]);

    /* ---------------- COMMIT ---------------- */

    await client.query("COMMIT");

    return res.json({
      success:true,
      message:"Transferencia guardada correctamente"
    });

  } catch(error){

    await client.query("ROLLBACK");
    console.error("❌ saveWarehouseTransfer:", error);

    return res.status(500).json({
      success:false,
      title:"Error guardando",
      message:error.message || "Error interno"
    });

  } finally {
    client.release();
  }
}



// Get receiving differences by picking (warehouse transfer)
export async function getReceivingDifferences(req, res) {
 console.log("ESTA FUNCIONANDO");
  const { poId } = req.params;
 console.log("id obtenido: ", poId);
  /* 1️⃣ validar parámetro */
  if (!poId ) {
    return res.status(400).json({
      success:false,
      title:"ID requerido",
      message:"Debes enviar el picking id"
    });
  }

  const pickingId = Number(poId );

  if (isNaN(pickingId)) {
    return res.status(400).json({
      success:false,
      title:"ID inválido",
      message:"El picking id no es válido"
    });
  }

  try {

    /* 2️⃣ buscar picking */
    const pickingResult = await db.query(`
      SELECT id, name, state, locked
      FROM stock_picking
      WHERE id = $1
      LIMIT 1
    `,[pickingId]);

    if (pickingResult.rowCount === 0) {
      return res.status(404).json({
        success:false,
        title:"Picking no encontrado",
        message:"El traslado no existe"
      });
    }

    const picking = pickingResult.rows[0];

    /* 3️⃣ validar estado */
    if (["cancel","done"].includes(picking.state)) {
      return res.status(409).json({
        success:false,
        title:"Picking cerrado",
        message:"El traslado está cancelado o finalizado"
      });
    }

    if (picking.state !== "waiting") {
      return res.status(409).json({
        success:false,
        title:"No recibido",
        message:"El picking aún no ha sido recibido"
      });
    }

    if (picking.locked === false) {
      return res.status(409).json({
        success:false,
        title:"Picking no confirmado",
        message:"Debes confirmar el picking antes de validar"
      });
    }

    /* 4️⃣ buscar líneas con diferencias + productos */
    const linesResult = await db.query(`
      SELECT 
        sm.id,
        sm.product_id,
        sm.quantity_done::float AS received_qty,
        sm.product_qty::float AS ordered_qty,
        (sm.product_qty - sm.quantity_done)::float AS difference_qty,
        p.sku,
        p.description,
        p.status,
        p.deleted_erp
      FROM stock_move sm
      LEFT JOIN products p ON p.id = sm.product_id
      WHERE sm.picking_id = $1
      AND sm.state NOT IN ('cancel','done')
      AND sm.product_qty <> sm.quantity_done
      ORDER BY sm.id ASC
    `,[pickingId]);

    /* 5️⃣ validar productos activos */
    const invalidProducts = linesResult.rows.filter(
      p => !p.sku || p.status !== "ACTIVE" || p.deleted_erp === true
    );

    if (invalidProducts.length > 0) {

      const list = invalidProducts
        .map(p => `SKU:${p.sku || "UNKNOWN"} (product_id:${p.product_id})`)
        .join(", ");

      return res.status(409).json({
        success:false,
        title:"Producto inválido",
        message:`Productos inactivos o eliminados: ${list}`
      });
    }

    /* 6️⃣ limpiar respuesta */
    const cleanLines = linesResult.rows.map(l => ({
      id: l.id,
      product_id: l.product_id,
      sku: l.sku,
      description: l.description,
      received_qty: l.received_qty,
      ordered_qty: l.ordered_qty,
      difference_qty: l.difference_qty
    }));

    /* 7️⃣ respuesta final */
    return res.json({
      success:true,
      data:{
        picking_id: picking.id,
        picking_name: picking.name,
        lines: cleanLines
      }
    });

  } catch(error){

    console.error("❌ getReceivingDifferences:", error);

    return res.status(500).json({
      success:false,
      title:"Error interno",
      message:"Error obteniendo diferencias del picking"
    });
  }
}