import { db } from "../db.js";
import { getActiveStorageLocationByCode } from "../services/locationService.js";
import { reserveInventoryForMove } from "../services/pickingBestRoute.js"
import { getPickingProductsWithLocationsService, getPickingConfig, reconcileExactMoveLocations } from "../services/pickingBestRoute.js";
import { selectBestLocation, getMoveLinesOrderedByLocation, redistributeExactMoveFromGeneral, cancelOpenGeneralMoveLinesForPicking } from "../services/pickingBestRoute.js";
import { createInventoryMovement, moveInventoryBetweenLocationsV2, moveInventoryGeneralLocation, reserveMoveLineQuantity } from "../services/inventoryService.js"
import { getOrCreateDefaultLocation } from "../services/pickingBestRoute.js"
import { buildCitrusConducePayload, createConduce } from "../integrations/citrus/citrus.saleOrder.js"
import { reserveMissingQtyForExistingMoveLines } from "../services/pickingReservationExisting.service.js";
import {
  cancelConduce
} from "../integrations/citrus/citrus.conduce.js";
//Search a sale order using an guid
import {
  syncAdmCloudSalesOrderByGuidService,
} from "../integrations/admcloud/admcloud.salesOrders.js";
import {
  releasePickingAssignmentIfCompleted
} from "../services/pickingAssignmentCleanup.service.js";
import {
  getPendingDispatchBySalesOrderService,
  syncAdmCloudPendingDispatchMoves,
} from "../integrations/admcloud/admcloud.pendingDispatch.js";
import {
  prepareAdmCloudDispatchService,
  sendAdmCloudDispatchService,
  syncAdmCloudDispatchService
} from "../integrations/admcloud/admcloud.conduce.js";
import {
  confirmPickingWithAlternateLocation,
  refreshPickingLocationSnapshots,
} from "../services/pickingAlternativeLocations.service.js";
import {
  getAdmCloudDispatchService
} from "../integrations/admcloud/admcloud.conduce.js";



export async function updateOriginWarehouse(req, res) {

  const client = await db.connect();

  try {

    const {
      moveId,
      warehouseId
    } = req.body;

    console.log("🟨 UPDATE ORIGIN WAREHOUSE");
    console.log("MOVE ID:", moveId);
    console.log("WAREHOUSE ID:", warehouseId);


    // ==============================
    // VALIDACIONES
    // ==============================

    if (!moveId) {
      return res.status(400).json({
        success: false,
        title: "Movimiento requerido",
        message: "El moveId es requerido."
      });
    }


    if (!warehouseId) {
      return res.status(400).json({
        success: false,
        title: "Origen requerido",
        message: "Debe seleccionar un origen."
      });
    }


    const parsedMoveId = Number(moveId);
    const parsedWarehouseId = Number(warehouseId);


    if (
      !Number.isInteger(parsedMoveId) ||
      !Number.isInteger(parsedWarehouseId)
    ) {
      return res.status(400).json({
        success: false,
        title: "Datos inválidos",
        message: "moveId y warehouseId deben ser números enteros."
      });
    }


    // SOLO PERMITIMOS 1 O 2
    if (
      parsedWarehouseId !== 1 &&
      parsedWarehouseId !== 2
    ) {
      return res.status(400).json({
        success: false,
        title: "Origen inválido",
        message: "El origen debe ser 1 o 2."
      });
    }


    await client.query("BEGIN");


    // ==============================
    // BUSCAR Y ACTUALIZAR STOCK_MOVE
    // ==============================

    const result = await client.query(
      `
            UPDATE stock_move
            SET erp_warehouse_id = $1
            WHERE id = $2
            RETURNING
                id,
                erp_warehouse_id
            `,
      [
        parsedWarehouseId,
        parsedMoveId
      ]
    );


    // ==============================
    // NO EXISTE MOVE
    // ==============================

    if (result.rowCount === 0) {

      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        title: "Movimiento no encontrado",
        message: "No se encontró el movimiento solicitado."
      });
    }


    await client.query("COMMIT");


    console.log(
      "✅ ORIGEN ACTUALIZADO:",
      result.rows[0]
    );


    return res.status(200).json({
      success: true,
      title: "Origen actualizado",
      message: "El origen del movimiento fue actualizado correctamente.",
      data: result.rows[0]
    });


  } catch (error) {

    await client.query("ROLLBACK");

    console.error(
      "❌ ERROR updateOriginWarehouse:",
      error
    );

    return res.status(500).json({
      success: false,
      title: "Error al actualizar",
      message: "No se pudo actualizar el origen del movimiento."
    });

  } finally {

    client.release();

  }
}



export async function closePicking(req, res) {
  // ==========================================================
  // 1. DATOS RECIBIDOS
  // ==========================================================

  const { pickingId, locationId } = req.body;
  const userId = req.user?.id;

  let client;
  let transactionStarted = false;
  let releaseError;
  let preparedAdmCloudDispatch = null;
  let admCloudDispatchResult = null;

  console.log("================================");
  console.log("🚀 INICIANDO CIERRE DE PICKING");
  console.log("📥 Datos recibidos:", {
    pickingId,
    locationId,
    userId,
  });
  console.log("================================");

  // ==========================================================
  // 2. VALIDAR USUARIO
  // ==========================================================

  if (!userId) {
    return res.status(401).json({
      success: false,
      title: "Usuario no autenticado",
      message: "No se encontró el usuario autenticado",
    });
  }

  // ==========================================================
  // 3. VALIDAR DATOS REQUERIDOS
  // ==========================================================

  if (!pickingId || !locationId) {
    return res.status(400).json({
      success: false,
      title: "Datos requeridos",
      message: "Debe enviar pickingId y locationId",
    });
  }

  try {
    // ========================================================
    // 4. INICIAR CONEXIÓN Y TRANSACCIÓN
    // ========================================================

    client = await db.connect();

    await client.query("BEGIN");
    transactionStarted = true;

    console.log("🟢 BEGIN iniciado");

    // ========================================================
    // 5. OBTENER CONFIGURACIÓN
    // ========================================================

    const config = await getPickingConfig(client);

    console.log("⚙️ Configuración del picking:", config);

    // ========================================================
    // 6. BUSCAR PICKING
    // ========================================================

    const pickingResult = await client.query(
      `
    SELECT
      id,
      name,
      state,
      erp_cliente_id,
      erp_cliente,
      erp_direccion_cliente,
      erp_tienda_id,
      erp_vendedor_id,
      erp_location_id,
      order_name,
      sale_id
    FROM public.stock_picking
    WHERE id = $1
    FOR UPDATE
  `,
      [pickingId]
    );

    // ========================================================
    // 7. VALIDAR QUE EL PICKING EXISTA
    // ========================================================

    if (pickingResult.rowCount === 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      console.log("❌ PICKING NO ENCONTRADO:", pickingId);

      return res.status(404).json({
        success: false,
        title: "PICKING NO ENCONTRADO",
        message: "El picking no existe",
      });
    }

    const picking = pickingResult.rows[0];

    console.log("📦 Picking encontrado:", picking);

    // ========================================================
    // 8. VALIDAR ESTADO DEL PICKING
    // ========================================================

    if (["cancel", "done"].includes(picking.state)) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      console.log("❌ Estado de picking inválido:", {
        pickingId,
        state: picking.state,
      });

      return res.status(409).json({
        success: false,
        title: "PICKING ESTADO INVÁLIDO",
        message: "El picking ya está cerrado o cancelado",
        data: {
          pickingId: picking.id,
          currentState: picking.state,
        },
      });
    }

    // ========================================================
    // 9. OBTENER LÍNEAS ACTIVAS
    // ========================================================

    const linesResult = await client.query(
      `
    SELECT
      sml.*,
      p.sku,
      p.erp_id,
      p.description
    FROM stock_move_line AS sml
    JOIN products AS p
      ON p.id = sml.product_id
    WHERE sml.picking_id = $1
      AND COALESCE(sml.state, '')
          NOT IN ('cancel', 'done')
    ORDER BY sml.id ASC
  `,
      [pickingId]
    );

    const lines = linesResult.rows;

    console.log(
      "📋 Líneas activas del picking:",
      lines
    );

    // ========================================================
    // VALIDAR QUE EXISTAN LÍNEAS
    // ========================================================

    if (lines.length === 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(422).json({
        success: false,
        title: "NO EXISTEN LÍNEAS",
        message:
          "Este pedido no tiene líneas disponibles",
      });
    }

    // ========================================================
    // VALIDAR QUE SE HAYA RECOGIDO ALGUNA CANTIDAD
    // ========================================================

    const totalQtyDone = lines.reduce(
      (total, line) =>
        total + Number(line.qty_done || 0),
      0
    );

    console.log(
      "📦 Cantidad total recogida:",
      totalQtyDone
    );



    if (totalQtyDone <= 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(422).json({
        success: false,
        title: "NO HAY PRODUCTOS RECOGIDOS",
        message:
          "No se puede cerrar el picking porque todas las líneas tienen qty_done en 0.",
        data: {
          pickingId: picking.id,
          pickingName: picking.name,
          totalQtyDone: 0,
        },
      });
    }

    // ========================================================
    // 10. PREPARAR CONDUCE EN ADM CLOUD
    // ========================================================

    preparedAdmCloudDispatch =
      await prepareAdmCloudDispatchService(
        client,
        pickingId
      );

    if (!preparedAdmCloudDispatch?.success) {
      throw new Error(
        preparedAdmCloudDispatch?.message ||
        "No se pudo preparar el conduce."
      );
    }

    console.log("✅ Conduce preparado:", {
      pickingId:
        preparedAdmCloudDispatch.data.pickingId,

      itemsCount:
        preparedAdmCloudDispatch.data.itemsCount,

      moveLineIds:
        preparedAdmCloudDispatch.data.moveLineIds,
    });

    // ========================================================
    // 11. CONTINUAR CIERRE DEL PICKING
    // ========================================================

    // Aquí continúa:
    // UPDATE stock_move_line SET state = 'done'
    // movimientos de inventario
    // actualización del picking





    // ========================================================
    // 13. PROCESAR CADA LÍNEA
    // ========================================================

    for (const line of lines) {
      const qtyDone = Number(line.qty_done || 0);
      const qtyPlanned = Number(
        line.product_uom_qty || 0
      );

      console.log("--------------------------------");
      console.log("📦 Procesando stock_move_line:", {
        lineId: line.id,
        moveId: line.move_id,
        sku: line.sku,
        qtyDone,
        qtyPlanned,
        fromLocation: line.location_id,
        toLocation: locationId,
      });

      // ======================================================
      // 13A. VALIDAR CANTIDADES
      // ======================================================

      if (
        !Number.isFinite(qtyDone) ||
        !Number.isFinite(qtyPlanned)
      ) {
        throw {
          code: "INVALID_QUANTITY",
          title: "Cantidad inválida",
          message:
            `La línea ${line.id} contiene una cantidad inválida`,
        };
      }

      // ======================================================
      // 13B. IGNORAR LÍNEAS SIN CANTIDAD RECOGIDA
      // ======================================================

      if (qtyDone <= 0) {
        console.log(
          "⏭️ Línea ignorada porque qtyDone es 0:",
          line.sku
        );

        continue;
      }

      if (qtyPlanned <= 0) {
        console.log(
          "⏭️ Línea ignorada porque qtyPlanned es 0:",
          line.sku
        );

        continue;
      }

      // ======================================================
      // 13C. MOVER INVENTARIO
      // ======================================================

      if (!config.allow_picking_without_locations) {
        console.log(
          "📍 Movimiento normal desde ubicación física"
        );

        const resultMove =
          await moveInventoryBetweenLocationsV2(
            client,
            {
              productSku: line.sku,
              fromLocation: line.location_id,
              toLocation: locationId,
              qty: qtyDone,
              qty_promised: 0,
            }
          );

        console.log(
          "✅ Resultado movimiento normal:",
          resultMove
        );
      } else {
        console.log(
          "📍 Movimiento permitiendo ubicación GENERAL"
        );

        const resultMove =
          await moveInventoryGeneralLocation(
            client,
            {
              productSku: line.sku,
              fromLocation: line.location_id,
              toLocation: locationId,
              qty: qtyDone,
              qty_promised: 0,
            }
          );

        console.log(
          "✅ Resultado movimiento GENERAL:",
          resultMove
        );
      }

      // ======================================================
      // 13D. REGISTRAR MOVIMIENTO DE INVENTARIO
      // ======================================================

      const inventoryMovement =
        await createInventoryMovement(
          client,
          {
            productSku: line.sku,
            fromLocationId: line.location_id,
            toLocationId: locationId,
            qty: qtyDone,
            movementType: "SHIP",
            referenceType: picking.name,
            referenceId: pickingId,
            createdBy: userId,
            note:
              `Movimiento por cierre de picking ` +
              `${picking.name}`,
          }
        );

      console.log(
        "✅ Movimiento de inventario registrado:",
        inventoryMovement
      );

      // ======================================================
      // 13E. LÍNEA COMPLETAMENTE PROCESADA
      // ======================================================

      if (qtyDone === qtyPlanned) {


        console.log("✅ Línea completada:", {
          lineId: line.id,
          moveId: line.move_id,
          qtyDone,
          qtyPlanned,
        });

        continue;
      }

      // ======================================================
      // 13F. LÍNEA PROCESADA PARCIALMENTE
      // ======================================================

      if (
        qtyDone > 0 &&
        qtyDone < qtyPlanned
      ) {
        const remainingQty =
          qtyPlanned - qtyDone;

        console.log(
          "🟡 Línea parcialmente procesada:",
          {
            lineId: line.id,
            qtyPlanned,
            qtyDone,
            remainingQty,
          }
        );

        /*
         * La línea original representará solamente
         * la cantidad efectivamente recogida.
         *
         *
 * El estado todavía permanece abierto.
 * Se cambiará a done solamente después
 * de que ADM Cloud cree el conduce.
 */
        const originalLineResult =
          await client.query(
            `
              UPDATE stock_move_line
              SET
                product_uom_qty = $1,
                qty_done = $2
              WHERE id = $3
              RETURNING *
            `,
            [
              qtyDone,
              qtyDone,
              line.id,
            ]
          );

        console.log(
          "✅ Línea original ajustada:",
          originalLineResult.rows[0]
        );

        /*
         * Crear una nueva línea para la cantidad pendiente.
         */
        const newMoveLineResult =
          await client.query(
            `
              INSERT INTO stock_move_line (
                move_id,
                picking_id,
                product_id,
                product_uom_id,
                product_uom_qty,
                qty_done,
                location_id,
                warehouse_id,
                state
              )
              VALUES (
                $1,
                $2,
                $3,
                $4,
                $5,
                0,
                $6,
                $7,
                'assigned'
              )
              RETURNING *
            `,
            [
              line.move_id,
              line.picking_id,
              line.product_id,
              line.product_uom_id,
              remainingQty,
              line.location_id,
              line.warehouse_id,
            ]
          );

        console.log(
          "🟡 Nueva línea pendiente creada:",
          newMoveLineResult.rows[0]
        );
      }
    }


    // ========================================================
    // 14. ACTUALIZAR ESTADO DE LOS STOCK_MOVE
    // ========================================================

    /* const completedMovesResult =
   await client.query(
     `
       UPDATE public.despacho_stock_move AS dsm
       SET
         state = 'done',
         write_date = NOW()
       WHERE dsm.picking_id = $1
 
         AND COALESCE(
           dsm.state,
           ''
         ) <> 'cancel'
 
         AND NOT EXISTS (
           SELECT 1
           FROM public.stock_move_line AS sml
           WHERE sml.move_id = dsm.id
             AND COALESCE(
               sml.state,
               ''
             ) NOT IN (
               'done',
               'cancel'
             )
         )
 
       RETURNING
         dsm.id,
         dsm.erp_move_id,
         dsm.erp_product_id,
         dsm.product_qty,
         dsm.pending_qty,
         dsm.state
     `,
     [pickingId]
   );
 
 console.log(
   "✅ DESPACHO_STOCK_MOVE COMPLETADOS:",
   completedMovesResult.rows
 );*/


    // ========================================================
    // 15. LIBERAR ASIGNACIÓN DEL PICKER
    // ========================================================

    const assignmentCleanupResult =
      await releasePickingAssignmentIfCompleted(
        client,
        pickingId
      );

    console.log(
      "🧹 Resultado de desasignación automática:",
      assignmentCleanupResult
    );

    // ========================================================
    // 16. DETERMINAR SI TODO EL PICKING FUE COMPLETADO
    // ========================================================

    const allLinesCompleted = lines.every(
      (line) => {
        const qtyDone = Number(
          line.qty_done || 0
        );

        const qtyPlanned = Number(
          line.product_uom_qty || 0
        );

        return qtyDone === qtyPlanned;
      }
    );

    console.log(
      "📊 Todas las líneas completadas:",
      allLinesCompleted
    );

    // ========================================================
    // 17. CERRAR PICKING SI TODO ESTÁ COMPLETO
    // ========================================================

    /*if (allLinesCompleted) {
      await client.query(
        `
          UPDATE stock_picking
          SET state = 'done'
          WHERE id = $1
        `,
        [pickingId]
      );

      console.log(
        "✅ stock_picking actualizado a done"
      );
    } else {
      console.log(
        "🟡 Picking parcialmente despachado; permanece abierto"
      );
    }*/

    // ========================================================
    // 18. FUTURA RELACIÓN ADM CLOUD
    // ========================================================
    // ==========================================================
    // CREAR CONDUCE EN ADM CLOUD AL FINAL
    // ==========================================================

    admCloudDispatchResult =
      await sendAdmCloudDispatchService(
        preparedAdmCloudDispatch
      );

    if (!admCloudDispatchResult?.success) {
      throw new Error(
        admCloudDispatchResult?.message ||
        "ADM Cloud no pudo crear el conduce."
      );
    }

    const dispatchGuid = String(
      admCloudDispatchResult?.data?.dispatchGuid ?? ""
    )
      .trim()
      .toLowerCase();

    const guidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    if (!guidRegex.test(dispatchGuid)) {
      throw new Error(
        "ADM Cloud creó el conduce, pero no devolvió un dispatchGuid válido."
      );
    }

    const GREEN_BACKGROUND = "\x1b[42m";
    const BLACK_TEXT = "\x1b[30m";
    const BOLD_TEXT = "\x1b[1m";
    const RESET_COLOR = "\x1b[0m";

    const greenStyle =
      `${GREEN_BACKGROUND}${BLACK_TEXT}${BOLD_TEXT}`;

    console.log(
      `${greenStyle} ✅ Conduce creado en ADM Cloud: ${JSON.stringify({
        dispatchGuid,
        itemsCount:
          admCloudDispatchResult.data.itemsCount,
      })} ${RESET_COLOR}`
    );

    /*
     * TODO: Guardar aquí la relación entre:
     *
     * - sale_id
     * - picking_id
     * - despacho/conduce creado en ADM Cloud
     *
     * Ejemplo futuro:
     *
     * await client.query(
     *   `
     *     INSERT INTO sale_order_dispatches (
     *       sale_id,
     *       picking_id,
     *       admcloud_dispatch_id,
     *       status
     *     )
     *     VALUES ($1, $2, $3, 'created')
     *   `,
     *   [
     *     picking.sale_id,
     *     pickingId,
     *     admCloudResult.dispatchId,
     *   ]
     * );
     */


    // ========================================================
    // MARCAR COMO DONE LAS LÍNEAS INCLUIDAS EN EL CONDUCE
    // ========================================================

    const dispatchedMoveLineIds = [
      ...new Set(
        (
          preparedAdmCloudDispatch
            ?.data
            ?.moveLineIds || []
        )
          .map((id) =>
            Number(id)
          )
          .filter(
            (id) =>
              Number.isSafeInteger(id) &&
              id > 0
          )
      ),
    ];

    if (
      dispatchedMoveLineIds.length === 0
    ) {
      throw {
        code:
          "EMPTY_DISPATCH_MOVE_LINES",

        title:
          "Conduce sin líneas locales",

        message:
          "El conduce fue preparado sin identificadores de stock_move_line.",
      };
    }

    const completedLinesResult =
      await client.query(
        `
      UPDATE public.stock_move_line
      SET
        state = 'done',
        user_id = $1,
        erp_dispatch_id = $4,
        write_date = NOW()

      WHERE picking_id = $2

        AND id = ANY($3::bigint[])

        AND COALESCE(
          state,
          ''
        ) NOT IN (
          'cancel',
          'done'
        )

        AND COALESCE(
          qty_done,
          0
        ) > 0

      RETURNING
        id,
        move_id,
        product_id,
        product_uom_qty,
        qty_done,
        state,
        user_id,
        erp_dispatch_id
    `,
        [
          userId,
          pickingId,
          dispatchedMoveLineIds,
          dispatchGuid,
        ]
      );

    console.log(
      "✅ Líneas finalizadas y vinculadas al conduce:",
      completedLinesResult.rows
    );

    console.log(
      "☁️ Registro de despacho ADM Cloud pendiente"
    );

    // ========================================================
    // 19. CONFIRMAR TRANSACCIÓN
    // ========================================================

    await client.query("COMMIT");
    transactionStarted = false;

    console.log(
      "🟢 COMMIT realizado correctamente"
    );

    const completedMoveIds = [
      ...new Set(
        completedLinesResult.rows
          .map((line) => Number(line.move_id))
          .filter(
            (moveId) =>
              Number.isSafeInteger(moveId) &&
              moveId > 0
          )
      ),
    ];

    console.log(
      "✅ Move IDs incluidos en el conduce:",
      completedMoveIds
    );










    // ========================================================
    // 20. SINCRONIZAR CONDUCE DESPUÉS DE RESPONDER
    // ========================================================

    const syncPayload = {
      db,
      pickingId: picking.id,
      saleId: picking.sale_id,
      dispatchGuid
    };

    res.once("finish", () => {

      console.log(
        "📨 Respuesta enviada. Iniciando sincronización ADM Cloud..."
      );

      setImmediate(() => {

        syncAdmCloudDispatchService(syncPayload)
          .then((result) => {

            console.log(
              "✅ SINCRONIZACIÓN COMPLETADA:",
              result.data
            );

          })
          .catch((error) => {

            console.error(
              "❌ ERROR EN SINCRONIZACIÓN BACKGROUND:",
              {
                pickingId: syncPayload.pickingId,
                dispatchGuid: syncPayload.dispatchGuid,
                message: error.message
              }
            );

          });

      });

    });






    // ========================================================
    // 20. RESPUESTA EXITOSA
    // ========================================================

    return res.status(200).json({
      success: true,
      title: "Picking procesado",
      message:
        allLinesCompleted
          ? "Picking completado correctamente"
          : "Picking procesado parcialmente",
      data: {
        pickingId: picking.id,
        pickingName: picking.name,
        saleId: picking.sale_id,
        state:
          allLinesCompleted
            ? "done"
            : picking.state,
        allLinesCompleted,
        completedMoveIds: [
          ...new Set(completedMoveIds),
        ],

        /*
         * Se mantiene como arreglo vacío para conservar
         * compatibilidad temporal con el frontend.
         *
         * Cuando ADM Cloud esté implementado,
         * puedes reemplazarlo por los despachos creados.
         */
        conduces:
          admCloudDispatchResult
            ? [
              {
                id:
                  admCloudDispatchResult
                    .data
                    .dispatchGuid,

                dispatchGuid:
                  admCloudDispatchResult
                    .data
                    .dispatchGuid,

                itemsCount:
                  admCloudDispatchResult
                    .data
                    .itemsCount,
              },
            ]
            : [],
      },
    });
  } catch (error) {
    // ========================================================
    // 21. REVERTIR TRANSACCIÓN
    // ========================================================

    if (
      client &&
      transactionStarted
    ) {
      try {
        await client.query(
          "ROLLBACK"
        );

        transactionStarted = false;

        console.log(
          "🟠 ROLLBACK ejecutado"
        );
      } catch (rollbackError) {
        releaseError =
          rollbackError;

        console.error(
          "❌ Error realizando ROLLBACK:",
          rollbackError.message
        );
      }
    }

    console.error(
      "================================"
    );

    console.error(
      "❌ ERROR closePicking:",
      {
        code:
          error.code,

        title:
          error.title,

        message:
          error.message,

        statusCode:
          error.statusCode,

        admCloudStatus:
          error.admCloudStatus,

        admCloudData:
          error.admCloudData,
      }
    );

    console.error(
      "================================"
    );

    const candidateStatus =
      Number(error.statusCode);

    const responseStatus =
      Number.isInteger(
        candidateStatus
      ) &&
        candidateStatus >= 400 &&
        candidateStatus <= 599
        ? candidateStatus
        : 500;

    return res
      .status(responseStatus)
      .json({
        success: false,

        code:
          error.code ||
          "CLOSE_PICKING_ERROR",

        title:
          error.title ||
          "Error cerrando picking",

        message:
          error.message ||
          "No se pudo cerrar el picking.",

        admCloudStatus:
          error.admCloudStatus ||
          null,

        admCloudError:
          error.admCloudData ||
          null,
      });
  } finally {
    if (client) {
      client.release(
        releaseError
      );

      console.log(
        "🔚 Cliente PostgreSQL liberado"
      );
    }
  }
}





export async function getBestShippingLocation(req, res) {
  const pickingId = Number(req.params.pickingId);

  console.log("=================================");
  console.log("🚚 GET BEST SHIPPING LOCATION");
  console.log("📦 Picking ID:", pickingId);
  console.log("=================================");

  let client;
  let transactionStarted = false;
  let releaseError;

  const createControllerError = (
    statusCode,
    title,
    message
  ) =>
    Object.assign(new Error(message), {
      statusCode,
      title,
    });

  try {
    // ==========================================================
    // 1. VALIDAR PICKING ID
    // ==========================================================

    if (
      !Number.isSafeInteger(pickingId) ||
      pickingId <= 0
    ) {
      return res.status(400).json({
        success: false,
        title: "Picking inválido",
        message:
          "Debe enviar un pickingId entero positivo válido.",
      });
    }

    client = await db.connect();

    // ==========================================================
    // 2. BUSCAR PICKING Y OBTENER sale_id
    // ==========================================================

    const pickingResult = await client.query(
      `
        SELECT
          id,
          name,
          state,
          sale_id
        FROM public.stock_picking
        WHERE id = $1
        LIMIT 1
      `,
      [pickingId]
    );

    const picking = pickingResult.rows[0];

    if (!picking) {
      return res.status(404).json({
        success: false,
        title: "Picking no encontrado",
        message: `No existe el picking ${pickingId}.`,
      });
    }

    const saleId = String(
      picking.sale_id ?? ""
    )
      .trim()
      .toLowerCase();

    if (!saleId) {
      return res.status(422).json({
        success: false,
        title: "Picking sin orden de venta",
        message:
          `El picking ${pickingId} no tiene una orden de venta asociada en sale_id.`,
      });
    }

    const guidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    if (!guidRegex.test(saleId)) {
      return res.status(422).json({
        success: false,
        title: "GUID de orden inválido",
        message:
          `El sale_id del picking ${pickingId} no contiene un GUID válido.`,
      });
    }

    console.log("✅ Picking encontrado:", {
      pickingId: picking.id,
      pickingName: picking.name,
      pickingState: picking.state,
      saleId,
    });

    // ==========================================================
    // 3. INICIAR TRANSACCIÓN
    // ==========================================================

    await client.query("BEGIN");
    transactionStarted = true;

    console.log("🟢 BEGIN ejecutado");

    // ==========================================================
    // 4. SINCRONIZAR ORDEN DE VENTA DESDE ADM CLOUD
    // ==========================================================

    const syncedOrder =
      await syncAdmCloudSalesOrderByGuidService(
        client,
        saleId,
        pickingId
      );

    if (!syncedOrder?.picking?.id) {
      throw createControllerError(
        502,
        "Respuesta inválida de sincronización",
        "La sincronización de ADM Cloud no devolvió el picking procesado."
      );
    }

    console.log(
      "✅ Orden de venta sincronizada desde ADM Cloud:",
      {
        requestedPickingId: pickingId,
        synchronizedPickingId:
          syncedOrder.picking.id,
        saleId,
        lines: syncedOrder.lines,
      }
    );

    // ==========================================================
    // 5. OBTENER UBICACIONES SHIPPING ACTIVAS
    // ==========================================================

    const locationsResult = await client.query(
      `
        SELECT
          id,
          warehouse_id,
          code
        FROM public.locations
        WHERE is_active = true
          AND location_type = 'SHIPPING'
        ORDER BY id ASC
      `
    );

    if (locationsResult.rowCount === 0) {
      throw createControllerError(
        404,
        "Sin ubicaciones de despacho",
        "No hay ubicaciones de despacho disponibles. Contacte al administrador."
      );
    }

    const locations = locationsResult.rows;

    console.log(
      "📍 Ubicaciones SHIPPING encontradas:",
      locationsResult.rowCount
    );

    console.table(locations);

    // ==========================================================
    // 6. OBTENER CARGA ACTUAL DE CADA UBICACIÓN
    // ==========================================================

    const assignmentsResult = await client.query(
      `
        SELECT
          location_id,
          COALESCE(
            SUM(line_count),
            0
          ) AS total_lines
        FROM public.shipping_assignments
        WHERE assignment_date = CURRENT_DATE
        GROUP BY location_id
      `
    );

    const assignmentsMap = new Map();

    for (const row of assignmentsResult.rows) {
      assignmentsMap.set(
        Number(row.location_id),
        Number(row.total_lines || 0)
      );
    }

    console.log(
      "🗺️ Carga por ubicación:",
      Object.fromEntries(assignmentsMap)
    );

    // ==========================================================
    // 7. SELECCIONAR LA MEJOR UBICACIÓN
    // ==========================================================

    let bestLocation = null;

    // Caso 1: todavía no existe ninguna asignación hoy.
    if (assignmentsResult.rowCount === 0) {
      console.log(
        "🟢 No hay asignaciones hoy. Seleccionando primera ubicación."
      );

      bestLocation = locations[0];
    } else {
      // Caso 2: buscar primero una ubicación sin asignaciones.
      const locationsWithoutAssignments =
        locations.filter(
          (location) =>
            !assignmentsMap.has(
              Number(location.id)
            )
        );

      console.log(
        "🟡 Ubicaciones sin asignaciones:",
        locationsWithoutAssignments.length
      );

      console.table(
        locationsWithoutAssignments
      );

      if (
        locationsWithoutAssignments.length > 0
      ) {
        bestLocation =
          locationsWithoutAssignments[0];

        console.log(
          "✅ Ubicación libre seleccionada:",
          bestLocation.code
        );
      } else {
        // Caso 3: todas tienen carga; elegir la menor.
        console.log(
          "🔄 Todas las ubicaciones tienen carga. Buscando la menor..."
        );

        let minimumLoad = Infinity;

        for (const location of locations) {
          const currentLoad =
            assignmentsMap.get(
              Number(location.id)
            ) || 0;

          console.log(
            `📍 ${location.code} | carga=${currentLoad}`
          );

          if (currentLoad < minimumLoad) {
            minimumLoad = currentLoad;
            bestLocation = location;
          }
        }
      }
    }

    // Seguridad adicional.
    if (!bestLocation) {
      bestLocation = locations[0];
    }

    // ==========================================================
    // 8. CONFIRMAR TRANSACCIÓN
    // ==========================================================

    await client.query("COMMIT");
    transactionStarted = false;

    console.log("✅ COMMIT ejecutado");

    // ==========================================================
    // 9. RESPUESTA
    // ==========================================================

    return res.status(200).json({
      success: true,
      message:
        "Orden sincronizada y ubicación de despacho seleccionada.",
      data: {
        location_id: bestLocation.id,
        warehouse_id:
          bestLocation.warehouse_id,
        code: bestLocation.code,
      },
      synchronization: {
        synchronized: true,
        picking_id:
          syncedOrder.picking.id,
        sale_id: saleId,
        lines: syncedOrder.lines,
      },
    });
  } catch (error) {
    // ==========================================================
    // 10. ROLLBACK
    // ==========================================================

    if (client && transactionStarted) {
      try {
        await client.query("ROLLBACK");
        transactionStarted = false;

        console.log("🟠 ROLLBACK ejecutado");
      } catch (rollbackError) {
        releaseError = rollbackError;

        console.error(
          "❌ Error realizando ROLLBACK:",
          rollbackError.message
        );
      }
    }

    console.error(
      "🔥 Error obteniendo ubicación de despacho:",
      {
        message: error.message,
        title: error.title,
        statusCode: error.statusCode,
        admCloudStatus:
          error.response?.status,
        admCloudData:
          error.response?.data,
      }
    );

    const candidateStatus = Number(
      error.statusCode ??
      error.response?.status
    );

    const status =
      Number.isInteger(candidateStatus) &&
        candidateStatus >= 400 &&
        candidateStatus <= 599
        ? candidateStatus
        : error.isAxiosError
          ? 502
          : 500;

    return res.status(status).json({
      success: false,
      title:
        error.title ||
        "Error obteniendo ubicación de despacho",
      message:
        error.message ||
        "No se pudo sincronizar la orden ni obtener la ubicación de despacho.",
      admCloudError:
        error.response?.data || null,
    });
  } finally {
    // ==========================================================
    // 11. LIBERAR CONEXIÓN
    // ==========================================================

    if (client) {
      client.release(releaseError);
    }

    console.log(
      "🔚 END GET BEST SHIPPING LOCATION"
    );
  }
}





export async function getPickingDifferences(req, res) {

  const { pickingId } = req.params;

  console.log("🚀 getPickingDifferences iniciado");
  console.log("📦 PARAMS:", req.params);

  // 🔴 VALIDAR ID
  if (!pickingId) {

    console.log("❌ PICKING_ID_REQUIRED");

    return res.status(400).json({
      success: false,
      message: "PICKING_ID_REQUIRED",
    });
  }

  const id = Number(pickingId);

  console.log("🔢 PICKING ID:", id);

  if (isNaN(id)) {

    console.log("❌ INVALID_PICKING_ID");

    return res.status(400).json({
      success: false,
      message: "INVALID_PICKING_ID",
    });
  }

  try {

    console.log("🔍 BUSCANDO PICKING...");

    // 1️⃣ VALIDAR PICKING
    const pickingResult = await db.query(
      `
      SELECT id, name, state
      FROM stock_picking
      WHERE id = $1
      LIMIT 1
      `,
      [id]
    );

    console.log(
      "📦 PICKING RESULT:",
      pickingResult.rows
    );

    if (pickingResult.rowCount === 0) {

      console.log("❌ PICKING_NOT_FOUND");

      return res.status(404).json({
        success: false,
        message: "PICKING_NOT_FOUND",
      });
    }

    const picking = pickingResult.rows[0];

    console.log("✅ PICKING ENCONTRADO:", picking);

    // 2️⃣ VALIDAR STATE
    console.log("📌 PICKING STATE:", picking.state);

    /*
    if (picking.state !== "assigned") {

      console.log("❌ PICKING_NOT_ASSIGNED");

      return res.status(409).json({
        success: false,
        message: "PICKING_NOT_ASSIGNED",
        data: {
          current_state: picking.state
        }
      });
    }*/

    console.log("🔍 BUSCANDO DIFERENCIAS...");

    // 3️⃣ BUSCAR LÍNEAS CON DIFERENCIA
    const linesResult = await db.query(
      `
    SELECT
      sml.id,
      sml.product_id,
      sml.product_uom_qty,
      sml.qty_done,
      sml.state,
      p.sku,
      p.description,
      p.erp_name,
      p.erp_sku,
      p.erp_id
    FROM stock_move_line sml
    LEFT JOIN products p
      ON p.id = sml.product_id
    WHERE sml.picking_id = $1
      AND COALESCE(sml.state, '') NOT IN ('cancel', 'done')
      AND COALESCE(sml.product_uom_qty, 0)
          <> COALESCE(sml.qty_done, 0)
    ORDER BY sml.id ASC
  `,
      [id]
    );

    console.log(
      "📋 LÍNEAS CON DIFERENCIA:",
      linesResult.rows
    );

    console.log(
      "📊 TOTAL DIFERENCIAS:",
      linesResult.rowCount
    );

    // 4️⃣ RESPONSE
    console.log("✅ RESPUESTA EXITOSA");

    return res.status(200).json({
      success: true,
      data: {
        picking_id: picking.id,
        picking_name: picking.name,
        state: picking.state,
        lines: linesResult.rows,
      },
    });

  } catch (error) {

    console.error("🔥 ERROR getPickingDifferences:");

    console.error("MESSAGE:", error.message);

    console.error("STACK:", error.stack);

    console.error("FULL ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "ERROR_GETTING_PICKING_DIFFERENCES",
    });
  }
}





// =====================================================
// CONFIRMAR PICKING - RUTA NORMAL O ALTERNATIVA
// =====================================================

export async function confirmPickingLine(req, res) {
  let client;
  let transactionStarted = false;

  console.log("======================================");
  console.log("📦 CONFIRM PICKING LINE");
  console.log("📥 INPUT:", req.body);
  console.log("======================================");

  try {
    const {
      id,
      pickingId,
      productId,
      locationId,
      qty,
    } = req.body;

    if (
      !productId ||
      !locationId ||
      qty === undefined ||
      qty === null ||
      qty === ""
    ) {
      return res.status(400).json({
        success: false,
        title: "Datos incompletos",
        message:
          "Debe enviar productId, locationId y qty.",
      });
    }

    // id puede ser NULL para una línea nueva.
    // En ese caso pickingId es obligatorio.
    if (!id && !pickingId) {
      return res.status(400).json({
        success: false,
        title: "Picking requerido",
        message:
          "Debe enviar pickingId cuando id sea null.",
      });
    }

    client = await db.connect();

    await client.query("BEGIN");
    transactionStarted = true;

    const result =
      await confirmPickingWithAlternateLocation(
        client,
        {
          id: id || null,
          pickingId,
          productId,
          locationId,
          qty,
        }
      );

    await client.query("COMMIT");
    transactionStarted = false;

    console.log("✅ PICKING CONFIRMADO:", result);

    return res.status(200).json(result);

  } catch (error) {
    if (client && transactionStarted) {
      await client.query("ROLLBACK");
    }

    console.error(
      "❌ ERROR confirmPickingLine:",
      error
    );

    return res.status(
      error.statusCode || 500
    ).json({
      success: false,
      title:
        error.title ||
        "Error confirmando recogida",
      message:
        error.statusCode
          ? error.message
          : "Ocurrió un error al guardar la recogida.",
      code:
        error.code ||
        "PICKING_CONFIRM_ERROR",
    });

  } finally {
    client?.release();
  }
}





// =====================================================
// SCAN PICKING - UBICACIÓN O PRODUCTO
// =====================================================

export async function scanPickingCode(req, res) {
  let client;

  try {
    const {
      code,
      pickingId,
      lineId,
      productId,
    } = req.body;

    if (!code || !pickingId) {
      return res.status(400).json({
        success: false,
        code: "INVALID_REQUEST",
        title: "Datos incompletos",
        message:
          "Debe enviar code y pickingId.",
      });
    }

    client = await db.connect();

    const normalized = String(code)
      .trim()
      .toUpperCase();

    // =================================================
    // 1. VERIFICAR SI ES UNA UBICACIÓN
    // =================================================

    const locationResult =
      await getActiveStorageLocationByCode(
        client,
        normalized
      );

    if (locationResult.rowCount > 0) {
      const location =
        locationResult.rows[0];

      if (!lineId && !productId) {
        return res.json({
          success: false,
          code: "PRODUCT_CONTEXT_REQUIRED",
          title: "Seleccione una línea",
          message:
            "Primero debe existir una línea de recogida activa para validar la ubicación.",
        });
      }

      // Refrescar el listado almacenado.
      await refreshPickingLocationSnapshots(
        client,
        pickingId
      );

      const lineResult = lineId
        ? await client.query(
          `
            SELECT
              sml.id,
              sml.product_id,
              sml.location_id,
              sml.is_general,
              sml.available_locations,
              p.sku
            FROM stock_move_line AS sml
            JOIN products AS p
              ON p.id = sml.product_id
            WHERE sml.id = $1
              AND sml.picking_id = $2
              AND sml.state NOT IN ('done', 'cancel')
            `,
          [lineId, pickingId]
        )
        : await client.query(
          `
            SELECT
              NULL::bigint AS id,
              dsm.product_id,
              NULL::bigint AS location_id,
              FALSE AS is_general,
              '[]'::jsonb AS available_locations,
              p.sku
            FROM despacho_stock_move AS dsm
            JOIN products AS p
              ON p.id = dsm.product_id
            WHERE dsm.picking_id = $1
              AND dsm.product_id = $2
              AND dsm.state NOT IN ('done', 'cancel')
            LIMIT 1
            `,
          [pickingId, productId]
        );

      if (!lineResult.rowCount) {
        return res.json({
          success: false,
          code: "LINE_NOT_FOUND",
          title: "Línea no encontrada",
          message:
            "No se encontró la línea del producto dentro de este picking.",
        });
      }

      const line = lineResult.rows[0];

      const isOriginalLocation =
        Number(line.location_id) ===
        Number(location.id);

      // Una ubicación alternativa debe aparecer
      // en la lista actualizada de inventario.
      const listedLocations =
        Array.isArray(line.available_locations)
          ? line.available_locations
          : [];

      let inventoryLocation =
        listedLocations.find(
          (item) =>
            Number(item.location_id) ===
            Number(location.id)
        );

      // Para un producto todavía sin línea, consultar
      // su inventario directamente.
      if (!lineId) {
        const direct = await client.query(
          `
          SELECT
            ibl.location_id,
            ibl.warehouse_id,
            ibl.qty_on_hand,
            ibl.qty_available
          FROM inventory_by_location AS ibl
          JOIN products AS p
            ON p.sku = ibl.product_sku
          WHERE p.id = $1
            AND ibl.location_id = $2
            AND ibl.qty_on_hand > 0
          `,
          [line.product_id, location.id]
        );

        inventoryLocation =
          direct.rows[0] || null;
      }

      // Mantener compatibilidad con el flujo
      // existente de una ubicación GENERAL virtual.
      const config =
        await getPickingConfig(client);

      const isVirtualOriginal =
        isOriginalLocation &&
        config.allow_picking_without_locations &&
        normalized.startsWith("GENERAL-");

      if (
        !inventoryLocation &&
        !isVirtualOriginal
      ) {
        return res.json({
          success: false,
          code: "LOCATION_WITHOUT_INVENTORY",
          title: "Ubicación sin inventario",
          message:
            `La ubicación ${location.code} no tiene inventario disponible del producto ${line.sku}.`,
        });
      }

      return res.json({
        success: true,
        type: "location",
        data: {
          id: location.id,
          code: location.code,
          product_id: line.product_id,
          sku: line.sku,
          is_alternative: !isOriginalLocation,
          qty_on_hand: Number(
            inventoryLocation?.qty_on_hand || 0
          ),
        },
      });
    }

    // =================================================
    // 2. BUSCAR PRODUCTO POR BARCODE O SKU
    // =================================================

    let productResult = await client.query(
      `
      SELECT p.id, p.sku
      FROM product_barcodes AS pb
      JOIN products AS p
        ON p.sku = pb.product_sku
      WHERE UPPER(pb.barcode) = $1
      LIMIT 1
      `,
      [normalized]
    );

    if (!productResult.rowCount) {
      productResult = await client.query(
        `
        SELECT id, sku
        FROM products
        WHERE UPPER(sku) = $1
        LIMIT 1
        `,
        [normalized]
      );
    }

    if (!productResult.rowCount) {
      return res.json({
        success: false,
        code: "INVALID_CODE",
        title: "Código inválido",
        message:
          "El código no corresponde a una ubicación ni a un producto.",
      });
    }

    const product =
      productResult.rows[0];

    // =================================================
    // 3. VERIFICAR QUE EL PRODUCTO PERTENECE AL PICKING
    // =================================================

    const membershipResult = await client.query(
      `
      SELECT id
      FROM despacho_stock_move
      WHERE picking_id = $1
        AND product_id = $2
        AND state NOT IN ('done', 'cancel')
      LIMIT 1
      `,
      [pickingId, product.id]
    );

    if (!membershipResult.rowCount) {
      return res.json({
        success: false,
        code: "NOT_IN_PICKING",
        title: "Producto no válido",
        message:
          "Este producto no pertenece al despacho.",
      });
    }

    return res.json({
      success: true,
      type: "product",
      data: product,
    });

  } catch (error) {
    console.error(
      "❌ ERROR scanPickingCode:",
      error
    );

    return res.status(500).json({
      success: false,
      code: "SCAN_ERROR",
      title: "Error de escaneo",
      message:
        "No se pudo validar el código escaneado.",
    });

  } finally {
    client?.release();
  }
}






export async function getAdmCloudDispatchMonitorController(
  req,
  res
) {

  const client =
    await db.connect();


  try {

    // =========================================================
    // 1. PARAMS
    // =========================================================

    const pageRaw =
      Number(
        req.query.page
      );


    const limitRaw =
      Number(
        req.query.limit
      );


    const page =
      Number.isInteger(pageRaw) &&
        pageRaw > 0
        ? pageRaw
        : 1;


    const limit =
      Number.isInteger(limitRaw) &&
        limitRaw > 0
        ? Math.min(
          limitRaw,
          100
        )
        : 10;


    const offset =
      (page - 1) * limit;


    // =========================================================
    // 2. SEARCH
    //
    // Frontend manda algo como:
    //
    // search=CDD-00019501,CDD-00019502
    //
    // =========================================================

    const searchRaw =
      String(
        req.query.search || ""
      )
        .trim();


    const searchValues =
      searchRaw
        .split(",")
        .map(
          value =>
            value.trim()
        )
        .filter(Boolean)
        .slice(
          0,
          50
        );


    console.log(
      "🚚 [DISPATCH MONITOR]",
      {
        page,
        limit,
        offset,
        searchValues
      }
    );


    // =========================================================
    // 3. TOTAL
    // =========================================================

    const countResult =
      await client.query(
        `
                SELECT
                    COUNT(*)::int
                    AS total

                FROM admcloud_dispatches d

                WHERE

                    (
                        cardinality(
                            $1::text[]
                        ) = 0

                        OR

                        EXISTS (

                            SELECT
                                1

                            FROM unnest(
                                $1::text[]
                            ) AS search_value

                            WHERE

                                COALESCE(
                                    d.erp_doc_id::text,
                                    ''
                                )
                                ILIKE
                                '%' || search_value || '%'

                                OR

                                COALESCE(
                                    d.erp_reference::text,
                                    ''
                                )
                                ILIKE
                                '%' || search_value || '%'

                                OR

                                COALESCE(
                                    d.erp_relationship_name::text,
                                    ''
                                )
                                ILIKE
                                '%' || search_value || '%'

                        )

                    )
                `,
        [
          searchValues
        ]
      );


    const total =
      Number(
        countResult.rows[0]
          ?.total || 0
      );


    // =========================================================
    // 4. OBTENER CONDUCES
    // =========================================================

    const dispatchResult =
      await client.query(
        `
                SELECT

                    /* =============================================
                       ADM CLOUD DISPATCH
                    ============================================= */

                    d.id,

                    d.picking_id,

                    d.sale_id,

                    d.erp_conduce_id,

                    d.erp_doc_id,

                    d.erp_reference,

                    d.erp_relationship_id,

                    d.erp_relationship_name,

                    d.erp_location_id,

                    d.erp_ship_to_address_id,

                    d.erp_ship_to_address1,

                    d.erp_ship_to_address2,

                    d.erp_billing_status_desc,

d.erp_status,

-- Estado local del conduce en SIDIAL
d.state AS state,

d.erp_doc_type,

                    d.erp_creation_date,

                    d.erp_doc_date,

                    d.erp_calculated_total_cost,

                    d.created_at,

                    d.updated_at,


                    /* =============================================
                       WAREHOUSE
                    ============================================= */

                    w.id
                        AS warehouse_id,

                    w.code
                        AS warehouse_code,

                    w.name
                        AS warehouse_name,

                    w.description
                        AS warehouse_description,

                    w.status
                        AS warehouse_status,

                    w.erp_warehouse_id
                        AS warehouse_erp_id


                FROM admcloud_dispatches d


                /* =============================================
                   JOIN WAREHOUSE

                   Usamos ::text porque tienes valores como:

                   UUID
                   "1"
                   "2"

                   dentro de erp_warehouse_id.
                ============================================= */

                LEFT JOIN LATERAL (

                    SELECT

                        wh.id,

                        wh.code,

                        wh.name,

                        wh.description,

                        wh.status,

                        wh.erp_warehouse_id

                    FROM warehouses wh

                    WHERE

                        wh.erp_warehouse_id::text =
                        d.erp_location_id::text

                    ORDER BY

                        CASE

                            WHEN
                                wh.status = 'ACTIVE'
                            THEN 0

                            ELSE 1

                        END,

                        wh.id ASC

                    LIMIT 1

                ) w ON TRUE


                /* =============================================
                   MULTI SEARCH
                ============================================= */

                WHERE

                    (
                        cardinality(
                            $1::text[]
                        ) = 0

                        OR

                        EXISTS (

                            SELECT
                                1

                            FROM unnest(
                                $1::text[]
                            ) AS search_value

                            WHERE

                                COALESCE(
                                    d.erp_doc_id::text,
                                    ''
                                )
                                ILIKE
                                '%' || search_value || '%'

                                OR

                                COALESCE(
                                    d.erp_reference::text,
                                    ''
                                )
                                ILIKE
                                '%' || search_value || '%'

                                OR

                                COALESCE(
                                    d.erp_relationship_name::text,
                                    ''
                                )
                                ILIKE
                                '%' || search_value || '%'

                        )

                    )


                /* =============================================
                   ÚLTIMOS CONDUCES PRIMERO
                ============================================= */

                ORDER BY

                    d.erp_doc_date
                        DESC
                        NULLS LAST,

                    d.id
                        DESC


                LIMIT $2

                OFFSET $3
                `,
        [
          searchValues,
          limit,
          offset
        ]
      );


    // =========================================================
    // 5. TOTAL PAGES
    // =========================================================

    const totalPages =
      Math.ceil(
        total / limit
      );


    // =========================================================
    // 6. RESPONSE
    // =========================================================

    return res.status(200).json({

      success: true,

      page,

      limit,

      total,

      totalPages,

      data:
        dispatchResult.rows

    });


  } catch (error) {

    console.error(
      "❌ Error cargando monitor de conduces:",
      error
    );


    return res.status(500).json({

      success: false,

      title:
        "Error cargando conduces",

      message:
        "No se pudieron obtener los conduces de despacho.",

      data: [],

      total: 0

    });


  } finally {

    client.release();

  }

}


// ==========================================================
// 📦 GET PICKING PRODUCTS WITH LOCATIONS - ADM CLOUD
// ==========================================================

export async function getPickingProductsWithLocations(req, res) {

  console.log("🟦 ----[START] Controller----");

  let client;
  let transactionStarted = false;
  let releaseError;

  try {

    // ==========================================================
    // 1. VALIDAR PICKING ID
    // ==========================================================

    const pickingId = String(
      req.params.pickingId ?? ""
    ).trim();

    if (
      !/^[1-9]\d*$/.test(pickingId) ||
      BigInt(pickingId) > 9223372036854775807n
    ) {
      return res.status(400).json({
        success: false,
        title: "Picking inválido",
        message:
          "Debes enviar un pickingId entero positivo válido.",
      });
    }

    client = await db.connect();

    // ==========================================================
    // 2. BUSCAR PICKING Y SALE ID
    // ==========================================================

    const pickingResult = await client.query(
      `
      SELECT
        id,
        sale_id,
        state

      FROM public.stock_picking

      WHERE id = $1
      `,
      [pickingId]
    );

    const localPicking = pickingResult.rows[0];

    if (!localPicking) {
      return res.status(404).json({
        success: false,
        title: "Picking no encontrado",
        message:
          `No existe un picking con el ID ${pickingId}.`,
      });
    }

    if (
      ["done", "cancel"].includes(
        localPicking.state
      )
    ) {
      return res.status(409).json({
        success: false,
        title: "Picking cerrado",
        message:
          "No se puede preparar un picking finalizado o cancelado.",
      });
    }

    const saleId = String(
      localPicking.sale_id ?? ""
    ).trim();

    if (!saleId) {
      return res.status(422).json({
        success: false,
        title: "Picking sin pedido de venta",
        message:
          `El picking ${pickingId} no tiene sale_id.`,
      });
    }

    const guidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    if (!guidRegex.test(saleId)) {
      return res.status(422).json({
        success: false,
        title: "GUID del pedido inválido",
        message:
          `El sale_id del picking ${pickingId} no es un GUID válido.`,
      });
    }

    console.log("🔗 PEDIDO ASOCIADO:", {
      pickingId,
      saleId,
    });

    // ==========================================================
    // 3. INICIAR TRANSACCIÓN
    // ==========================================================

    await client.query("BEGIN");

    transactionStarted = true;

    // ==========================================================
    // 4. CONSULTAR PENDIENTES EN ADM CLOUD
    // ==========================================================

    console.log(
      "🔎 BUSCANDO PENDIENTES ADM CLOUD:",
      {
        pickingId,
        saleId,
      }
    );

    const pendingDispatchResult =
      await getPendingDispatchBySalesOrderService(
        saleId,
        {
          skip: 0,
        }
      );

    if (
      !pendingDispatchResult ||
      !Array.isArray(
        pendingDispatchResult.data
      )
    ) {
      const error = new Error(
        "ADM Cloud no devolvió una lista válida de pendientes de despacho."
      );

      error.statusCode = 502;
      error.code =
        "INVALID_PENDING_DISPATCH_RESPONSE";

      error.title =
        "Respuesta inválida de ADM Cloud";

      throw error;
    }

    const pendingDispatchRows =
      pendingDispatchResult.data;

    console.log(
      "📦 PENDIENTES ADM CLOUD:",
      {
        pickingId,
        saleId,
        rowsReceived:
          pendingDispatchRows.length,
      }
    );

    // ==========================================================
    // 5. BLOQUEAR EL PICKING
    //
    // NUEVO:
    // Evita que otra confirmación del mismo picking
    // modifique las líneas durante esta sincronización.
    // ==========================================================

    const lockedPicking = await client.query(
      `
      SELECT id, state

      FROM stock_picking

      WHERE id = $1

      FOR UPDATE
      `,
      [pickingId]
    );

    if (
      !lockedPicking.rowCount ||
      ["done", "cancel"].includes(
        lockedPicking.rows[0].state
      )
    ) {
      const error = new Error(
        "El picking ya no está disponible para preparar."
      );

      error.statusCode = 409;
      error.title = "Picking no disponible";

      throw error;
    }

    console.log(
      "🔒 PICKING BLOQUEADO:",
      pickingId
    );

    // ==========================================================
    // 6. SINCRONIZAR DESPACHO_STOCK_MOVE
    // ==========================================================

    const dispatchSyncSummary =
      await syncAdmCloudPendingDispatchMoves(
        client,
        pendingDispatchRows,
        pickingId,
        saleId
      );

    console.log(
      "✅ DESPACHO SINCRONIZADO:",
      {
        pickingId,
        saleId,
        rowsReceived:
          pendingDispatchRows.length,
        sync:
          dispatchSyncSummary,
      }
    );

    // ==========================================================
    // 7. ACTUALIZAR COLUMNAS NUEVAS
    //
    // NUEVO:
    // available_locations
    // max_product_qty
    //
    // Se actualizan las líneas existentes.
    // ==========================================================

    await refreshPickingLocationSnapshots(
      client,
      pickingId
    );

    console.log(
      "✅ UBICACIONES Y MÁXIMOS ACTUALIZADOS"
    );

    // ==========================================================
    // 8. OBTENER CONFIGURACIÓN DEL PICKING
    // ==========================================================

    const config =
      await getPickingConfig(client);

    console.log(
      "⚙️ CONFIGURACIÓN DEL PICKING:",
      config
    );

    // ==========================================================
    // 9. LIMPIEZA DE UBICACIONES GENERAL VIRTUALES
    //
    // Se conserva tu lógica existente.
    // ==========================================================

    let generalCleanup = {
      changed: false,
      cancelledLines: 0,
      affectedMoves: [],
    };

    if (
      !config.allow_picking_without_locations
    ) {
      generalCleanup =
        await cancelOpenGeneralMoveLinesForPicking(
          client,
          pickingId
        );

      console.log(
        "🧹 RESULTADO LIMPIEZA GENERAL:",
        generalCleanup
      );
    }

    // ==========================================================
    // 10. OBTENER PRODUCTOS, MOVES Y UBICACIONES
    // ==========================================================

    const result =
      await getPickingProductsWithLocationsService(
        client,
        pickingId
      );

    // ==========================================================
    // 11. SI NO HAY PRODUCTOS CON UBICACIONES
    //
    // NUEVO:
    // Conservar las líneas existentes del picking.
    // ==========================================================

    if (
      !result.data ||
      result.data.length === 0
    ) {

      const existingLines =
        await getMoveLinesOrderedByLocation(
          client,
          pickingId
        );

      await client.query("COMMIT");

      transactionStarted = false;

      return res.status(200).json({
        success:
          existingLines.length > 0,

        title:
          existingLines.length > 0
            ? "Ruta existente"
            : "Sin ubicaciones disponibles",

        message:
          existingLines.length > 0
            ? "Se conservaron las líneas existentes del picking."
            : result.message ||
            "No hay ubicaciones disponibles para recoger.",

        data:
          existingLines,
      });
    }

    // ==========================================================
    // 12. SELECCIONAR MEJORES UBICACIONES
    // ==========================================================

    const enrichedData = result.data.map(
      (product) => ({
        ...product,

        selected_location:
          selectBestLocation(product),
      })
    );

    console.log(
      "📦 PRODUCTOS CON UBICACIONES:",
      enrichedData
    );

    // ==========================================================
    // 13. VARIABLES DE RESERVA
    // ==========================================================

    let totalReserved = 0;

    let hasPickingChanges = false;

    const results = [];

    // ==========================================================
    // 14. PROCESAR PRODUCTOS
    // ==========================================================

    for (const product of enrichedData) {

      console.log(
        "🟡 PROCESANDO PRODUCTO:",
        product.product_id
      );

      const productId =
        product.product_id;

      // ========================================================
      // 15. PROCESAR CADA MOVIMIENTO
      // ========================================================

      for (const stockMove of product.moves) {

        const moveId =
          stockMove.move_id;

        const requiredQty = Number(
          stockMove.product_qty || 0
        );

        console.log(
          "🟦 PROCESANDO MOVIMIENTO:",
          {
            moveId,
            productId,
            requiredQty,
          }
        );

        // ======================================================
        // 16. OBTENER CANTIDAD ASIGNADA ACTUALMENTE
        // ======================================================

        const { rows } = await client.query(
          `
          SELECT
            COALESCE(
              SUM(sml.product_uom_qty),
              0
            ) AS total_qty

          FROM stock_move_line AS sml

          WHERE sml.move_id = $1
            AND sml.picking_id = $2
            AND COALESCE(sml.state, '') NOT IN (
              'cancel',
              'done'
            )
          `,
          [
            moveId,
            pickingId,
          ]
        );

        const totalQty = Number(
          rows[0]?.total_qty || 0
        );

        console.log(
          "📦 CANTIDADES DEL MOVIMIENTO:",
          {
            moveId,
            totalQty,
            requiredQty,
          }
        );

        // ======================================================
        // 17. PROTEGER LÍNEAS GENERALES
        //
        // NUEVO:
        // Si el usuario recogió desde otra ubicación,
        // no se debe reorganizar automáticamente.
        // ======================================================

        const manualResult = await client.query(
          `
          SELECT
            COUNT(*) AS total_lines,

            COALESCE(
              SUM(product_uom_qty),
              0
            ) AS total_qty

          FROM stock_move_line

          WHERE picking_id = $1
            AND move_id = $2
            AND is_general = TRUE
            AND state NOT IN (
              'done',
              'cancel'
            )
          `,
          [
            pickingId,
            moveId,
          ]
        );

        const totalGeneralLines = Number(
          manualResult.rows[0].total_lines
        );

        const totalGeneralQty = Number(
          manualResult.rows[0].total_qty
        );

        // ======================================================
        // CASO: EXISTEN LÍNEAS GENERALES
        // ======================================================

        if (totalGeneralLines > 0) {

          console.log(
            "🟣 MOVIMIENTO CON LÍNEAS GENERALES:",
            {
              moveId,
              totalGeneralLines,
              totalGeneralQty,
              totalQty,
              requiredQty,
            }
          );

          // Si el ERP cambió la cantidad pendiente,
          // detener antes de alterar el trabajo manual.

          if (
            Math.abs(
              totalQty - requiredQty
            ) > 0.000001
          ) {

            const error = new Error(
              `El movimiento ${moveId} contiene líneas generales y su cantidad pendiente cambió de ${totalQty} a ${requiredQty}. Debe revisarse antes de continuar.`
            );

            error.statusCode = 409;

            error.title =
              "Despacho modificado en ADM Cloud";

            error.code =
              "MANUAL_PICKING_REQUIRES_REVIEW";

            throw error;
          }

          // Mantener las líneas exactamente como están.

          results.push({
            move_id: moveId,
            product_id: productId,
            reserved: 0,
            changed: false,
            skipped: true,

            case:
              "MANUAL_LINES_PROTECTED",

            message:
              "La distribución manual fue conservada.",
          });

          console.log(
            "✅ DISTRIBUCIÓN MANUAL PROTEGIDA:",
            moveId
          );

          continue;
        }

        // ======================================================
        // 18. COMPARAR CANTIDAD ACTUAL CON REQUERIDA
        // ======================================================

        const quantitiesAreEqual =
          Math.abs(
            totalQty - requiredQty
          ) <= 0.000001;

        // ======================================================
        // CASO 1: CANTIDAD EXACTA
        // ======================================================

        if (quantitiesAreEqual) {

          console.log(
            "✅ MOVIMIENTO CON CANTIDAD EXACTA"
          );

          // ====================================================
          // 19. REDISTRIBUIR GENERAL VIRTUAL SI APLICA
          // ====================================================

          if (
            config.allow_picking_without_locations
          ) {

            const generalResult =
              await redistributeExactMoveFromGeneral(
                client,
                product,
                stockMove
              );

            if (
              generalResult.redistributed
            ) {

              const redistributedQty = Number(
                generalResult.reserved || 0
              );

              totalReserved +=
                redistributedQty;

              hasPickingChanges = true;

              results.push({
                move_id: moveId,
                product_id: productId,

                reserved:
                  redistributedQty,

                physical_reserved:
                  Number(
                    generalResult.physical_reserved || 0
                  ),

                general_reserved:
                  Number(
                    generalResult.general_reserved || 0
                  ),

                changed: true,
                skipped: false,

                case:
                  "ORDER_EXACT_REDISTRIBUTED",

                message:
                  "La reserva fue redistribuida entre ubicaciones físicas y GENERAL.",
              });

              continue;
            }

            console.log(
              "⏭️ NO FUE NECESARIO REDISTRIBUIR GENERAL:",
              generalResult.reason
            );
          }

          // ====================================================
          // 20. RECONCILIAR UBICACIONES FÍSICAS
          // ====================================================

          const physicalResult =
            await reconcileExactMoveLocations(
              client,
              product,
              stockMove
            );

          if (
            physicalResult.redistributed
          ) {

            hasPickingChanges = true;

            results.push({
              move_id: moveId,
              product_id: productId,

              reserved: 0,

              physical_reserved:
                requiredQty,

              createdQty:
                physicalResult.createdLines,

              updatedQty:
                physicalResult.updatedLines,

              cancelledQty:
                physicalResult.cancelledLines,

              changed: true,
              skipped: false,

              case:
                "ORDER_EXACT_LOCATIONS_REDISTRIBUTED",

              message:
                "La cantidad era correcta, pero las ubicaciones fueron actualizadas según el inventario físico.",

              distribution:
                physicalResult.distribution,
            });

            continue;
          }

          results.push({
            move_id: moveId,
            product_id: productId,

            reserved: 0,
            changed: false,
            skipped: true,

            case: "ORDER_EXACT",

            reason:
              physicalResult.reason,

            message:
              "La cantidad y la distribución ya están correctas.",
          });

          continue;
        }

        // ======================================================
        // CASO 2: EXISTEN LÍNEAS, PERO CAMBIÓ LA CANTIDAD
        // ======================================================

        if (totalQty > 0) {

          console.log(
            "🟡 MOVIMIENTO CON LÍNEAS EXISTENTES"
          );

          const resultExisting =
            await reserveMissingQtyForExistingMoveLines(
              client,
              product,
              stockMove
            );

          const reservedQty = Number(
            resultExisting?.reserved || 0
          );

          const createdQty = Number(
            resultExisting?.createdQty || 0
          );

          const releasedQty = Number(
            resultExisting?.released || 0
          );

          totalReserved +=
            reservedQty;

          if (
            resultExisting?.changed === true ||
            createdQty > 0 ||
            releasedQty > 0
          ) {
            hasPickingChanges = true;
          }

          results.push({
            move_id: moveId,
            product_id: productId,

            reserved:
              reservedQty,

            createdQty,
            released:
              releasedQty,

            changed:
              resultExisting?.changed || false,

            case:
              resultExisting?.case || null,

            skipped:
              resultExisting?.skipped || false,

            message:
              resultExisting?.message || "",
          });

          continue;
        }

        // ======================================================
        // CASO 3: RESERVA INICIAL
        // ======================================================

        console.log(
          "🟢 RESERVA INICIAL DEL MOVIMIENTO"
        );

        const reservationResult =
          await reserveInventoryForMove(
            client,
            {
              ...product,

              moves: [
                stockMove
              ],
            }
          );

        const reservedQty = Number(
          reservationResult?.reserved || 0
        );

        totalReserved +=
          reservedQty;

        results.push({
          move_id: moveId,
          product_id: productId,
          reserved: reservedQty,
        });

      } // FIN MOVES

    } // FIN PRODUCTOS

    // ==========================================================
    // 21. ACTUALIZAR UBICACIONES DE LAS LÍNEAS NUEVAS
    //
    // NUEVO:
    // Ahora también se actualizan las líneas creadas
    // durante la reserva inicial o reconciliación.
    // ==========================================================

    await refreshPickingLocationSnapshots(
      client,
      pickingId
    );

    console.log(
      "✅ SNAPSHOTS DE INVENTARIO ACTUALIZADOS"
    );

    // ==========================================================
    // 22. OBTENER STOCK MOVE LINES FINALES
    // ==========================================================

    const finalResult =
      await getMoveLinesOrderedByLocation(
        client,
        pickingId
      );

    // ==========================================================
    // 23. VERIFICAR SI HUBO NUEVAS RESERVAS
    // ==========================================================

    const noNewReservations =
      !config.allow_picking_without_locations &&
      totalReserved === 0 &&
      !hasPickingChanges;

    // ==========================================================
    // 24. COMMIT
    // ==========================================================

    await client.query("COMMIT");

    transactionStarted = false;

    console.log(
      "📦 RESULTADOS DE RESERVAS:",
      results
    );

    console.log(
      "📦 STOCK MOVE LINES FINALES:",
      finalResult
    );

    // ==========================================================
    // 25. RESPUESTA FINAL
    // ==========================================================

    return res.status(200).json({
      success: true,

      title:
        "Picking preparado",

      message:
        noNewReservations
          ? finalResult.length > 0
            ? "El picking ya tiene líneas asignadas."
            : "Pedido actualizado, pero no se pudo reservar inventario."
          : result.message ||
          "Picking actualizado correctamente.",

      data:
        finalResult,
    });

  } catch (error) {

    // ==========================================================
    // 26. ROLLBACK
    // ==========================================================

    if (
      client &&
      transactionStarted
    ) {
      try {

        await client.query("ROLLBACK");

        transactionStarted = false;

        console.log(
          "🟠 ROLLBACK EJECUTADO"
        );

      } catch (rollbackError) {

        releaseError =
          rollbackError;

        console.error(
          "❌ ERROR ROLLBACK:",
          rollbackError.message
        );
      }
    }

    console.error(
      "🔥 ERROR PREPARANDO PICKING:",
      error
    );

    const candidateStatus = Number(
      error.statusCode ??
      error.response?.status
    );

    const status =
      Number.isInteger(candidateStatus) &&
        candidateStatus >= 400 &&
        candidateStatus <= 599
        ? candidateStatus
        : error.isAxiosError
          ? 502
          : 500;

    return res.status(status).json({
      success: false,

      title:
        error.title ||
        "Error preparando el picking",

      message:
        error.message ||
        "No se pudo actualizar el pedido y preparar el picking.",

      code:
        error.code ||
        "PICKING_PREPARATION_ERROR",
    });

  } finally {

    if (client) {
      client.release(releaseError);
    }

    console.log(
      "🔚 [END Controller]"
    );
  }
}



export async function getAssignedPickings(req, res) {
  console.log("🟦 ----[START] Get Assigned Pickings Endpoint----");

  const client = await db.connect();

  try {
    const userId = req.user?.id;

    console.log("📥 userId recibido desde req.user:", userId);

    if (!userId) {
      console.log("❌ Usuario no autenticado o id no disponible");

      return res.status(401).json({
        success: false,
        title: "No autorizado",
        message: "No se pudo identificar el usuario",
      });
    }

    await client.query("BEGIN");
    console.log("🔐 BEGIN TRANSACTION");

    // 1) Buscar picker por user_id
    const pickerResult = await client.query(
      `
      SELECT id
      FROM pickers
      WHERE user_id = $1
      LIMIT 1
      `,
      [userId]
    );

    if (!pickerResult.rows.length) {
      console.log("⚠️ Usuario sin permiso de picker");

      await client.query("ROLLBACK");

      return res.status(403).json({
        success: false,
        title: "Usuario sin permiso",
        message: "Tú no eres un picker",
      });
    }

    const pickerId = pickerResult.rows[0].id;
    console.log("✅ Picker encontrado:", pickerId);

    // 2) Buscar todos los stock_picking_id asignados a ese picker
    const assignmentsResult = await client.query(
      `
      SELECT stock_picking_id
      FROM picking_assignments
      WHERE picker_id = $1
      `,
      [pickerId]
    );

    if (!assignmentsResult.rows.length) {
      console.log("ℹ️ No hay asignaciones para este picker");

      await client.query("ROLLBACK");

      return res.json({
        success: true,
        title: "No hay recogidas pendientes",
        message: "Está todo al día, excelente trabajo",
        data: [],
      });
    }

    const stockPickingIds = assignmentsResult.rows.map(
      (row) => row.stock_picking_id
    );

    console.log("📦 stockPickingIds encontrados:", stockPickingIds);

    // 3) Buscar masivamente en stock_picking
    const pickingsResult = await client.query(
      `
      SELECT
        id,
        name,
        order_name,
        erp_cliente
      FROM stock_picking
      WHERE id = ANY($1::int[])
        AND state NOT IN ('cancel', 'done')
        AND picking_type = 'outgoing'
      ORDER BY id DESC
      `,
      [stockPickingIds]
    );

    if (!pickingsResult.rows.length) {
      console.log("ℹ️ No hay pickings pendientes luego del filtro");

      await client.query("ROLLBACK");

      return res.json({
        success: true,
        title: "No hay recogidas pendientes",
        message: "Está todo al día, excelente trabajo",
        data: [],
      });
    }

    await client.query("COMMIT");
    console.log("✅ [SUCCESS] Pickings asignados obtenidos correctamente");
    console.log("📊 Total pickings devueltos:", pickingsResult.rows.length);

    return res.json({
      success: true,
      title: "Recogidas obtenidas",
      message: "Pedidos asignados cargados correctamente",
      data: pickingsResult.rows,
    });
  } catch (error) {
    console.error("🔥 [ERROR] Get Assigned Pickings:", error);

    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("🔥 [ROLLBACK ERROR]:", rollbackError);
    }

    return res.status(500).json({
      success: false,
      title: "Error interno",
      message: "Ocurrió un error obteniendo los pedidos asignados",
      error: error.message,
    });
  } finally {
    client.release();
    console.log("🔚 [END] Get Assigned Pickings Endpoint");
  }
}



//Reasignar un picking
export async function reassignPicking(req, res) {
  console.log("🟥----[START] Reassign Picking Endpoint----");

  const client = await db.connect(); // 👈 importante para transacción

  try {
    const { selectedPicker, selectedItem } = req.body;

    console.log("📥 Input:", { selectedPicker, selectedItem });

    // 🔹 Validación básica
    if (!selectedPicker || !selectedItem?.id) {
      console.log("❌ Datos inválidos");
      return res.json({
        success: false,
        message: "Datos inválidos",
      });
    }

    const pickingId = selectedItem.id;
    const newPickerId = selectedPicker;

    // 🔥 INICIAR TRANSACCIÓN
    await client.query("BEGIN");
    console.log("🔐 BEGIN TRANSACTION");

    // 🔹 1. Traer estado + usuario actual en UNA sola query
    const pickingResult = await client.query(`
    SELECT *
    FROM stock_picking
    WHERE id = $1
    FOR UPDATE
  `, [pickingId]);


    if (!pickingResult.rows.length) {
      console.log("❌ Picking no encontrado");

      await client.query("ROLLBACK");

      return res.json({
        success: false,
        message: "Picking no encontrado",
      });
    }

    const { state, user_id: currentUserId } = pickingResult.rows[0];

    console.log("📦 Estado:", state, "| Actual user:", currentUserId);

    // 🔹 2. Validar estado
    if (state === "done" || state === "cancel") {
      console.log("⚠️ Picking bloqueado");

      await client.query("ROLLBACK");

      return res.json({
        success: true,
        message: "Picking ya está en estado done/cancel",
      });
    }










    //LOCK PICKING FOR UPDATe
    if (state === "confirmed") {
      // buscar moves
      const moves = await client.query(`
        SELECT sm.*, p.sku
        FROM stock_move sm
        JOIN products p ON p.id = sm.product_id
        WHERE sm.picking_id = $1
        AND sm.state IN ('confirmed', 'partially_available')
    `, [pickingId]);

      console.log("NUMERO DE PRODUCTOS EN UN PEDIDO", moves.rowCount);

      let totalReserved = 0;

      /* ==============================
         1️⃣ RESERVAR INVENTARIO
      ============================== */

      for (const move of moves.rows) {
        //console.log("🚨🚨 ALERTA", move);
        const result = await reserveInventoryForMove(client, move);

        console.log("Resultado reserva:", result);

        totalReserved += result.reserved;
      }

      /* ==============================
         2️⃣ VERIFICAR SI SE RESERVÓ ALGO
      ============================== */

      if (totalReserved === 0) {
        console.log("⚠️ No se pudo reservar inventario");

        await client.query("ROLLBACK");

        return res.json({
          success: false,
          message: "No se pudo reservar inventario",
        });
      }

    }
    /// 🔹 4. Obtener user_id desde pickers
    console.log("🔍 Buscando picker en tabla pickers");

    const pickerResult = await client.query(
      `
  SELECT user_id, active
  FROM pickers
  WHERE id = $1
  `,
      [newPickerId]
    );

    if (!pickerResult.rows.length) {
      console.log("❌ Picker no encontrado");

      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        message: "Picker no encontrado",
      });
    }

    const { user_id: userIdObtenido, active } = pickerResult.rows[0];

    // 🔹 Validar activo
    if (!active) {
      console.log("⚠️ Picker inactivo");

      await client.query("ROLLBACK");

      return res.status(400).json({
        success: false,
        message: "El picker está inactivo",
      });
    }

    //console.log("👤 user_id obtenido:", userIdObtenido);
    //console.log("👤 current:", userIdObtenido);
    // 🧪 VALIDACIÓN PRO: evitar doble update innecesario
    /*if (currentUserId == userIdObtenido) {
      console.log("ℹ️ Ya asignado al mismo usuario (desde picker)");

      await client.query("ROLLBACK");

      return res.json({
        success: true,
        message: "El picking ya está asignado a este usuario",
      });
    }*/

    // 🔹 5. Update stock_picking con user_id REAL
    console.log("✏️ Actualizando stock_picking.user_id");

    await client.query(
      `
  UPDATE stock_picking 
  SET 
      user_id = $1,
      state = 'assigned'
  WHERE id = $2
  `,
      [userIdObtenido, pickingId]
    );
    // 🔹 6. Upsert eficiente en picking_assignments
    console.log("🔄 Upsert picking_assignments");

    await client.query(
      `
      INSERT INTO picking_assignments (stock_picking_id, picker_id)
      VALUES ($1, $2)
      ON CONFLICT (stock_picking_id)
      DO UPDATE SET picker_id = EXCLUDED.picker_id
      `,
      [pickingId, newPickerId]
    );

    // 🔥 COMMIT
    await client.query("COMMIT");

    console.log("✅ [SUCCESS] Reasignación completada");

    return res.json({
      success: true,
      message: "Picking reasignado correctamente",
    });

  } catch (error) {
    console.error("🔥 [ERROR]", error);

    // 🔥 ROLLBACK en error
    await client.query("ROLLBACK");

    return res.json({
      success: false,
      message: "Error interno",
      error: error.message,
    });

  } finally {
    client.release(); // 👈 MUY IMPORTANTE
    console.log("🔚 [END] Reassign Picking Endpoint");
  }
}




//quitar asignacion de picking
export async function unassignPicking(
  req,
  res
) {

  console.log(
    "=========================================="
  );

  console.log(
    "🚀 [START] UNASSIGN PICKING"
  );

  console.log(
    "📥 BODY:",
    req.body
  );

  console.log(
    "=========================================="
  );


  const client =
    await db.connect();


  try {

    const {
      pickingId
    } = req.body;


    // ==========================================
    // 1. VALIDAR PICKING ID
    // ==========================================

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

      return res
        .status(400)
        .json({
          success:
            false,

          code:
            "INVALID_PICKING_ID",

          title:
            "Picking inválido",

          message:
            "El picking seleccionado no es válido."
        });
    }


    await client.query(
      "BEGIN"
    );


    console.log(
      "🔐 BEGIN"
    );


    // ==========================================
    // 2. CONFIRMAR QUE STOCK_PICKING EXISTE
    // ==========================================

    const pickingResult =
      await client.query(
        `
        SELECT
          id,
          name,
          state

        FROM stock_picking

        WHERE id = $1

        LIMIT 1
        `,
        [
          parsedPickingId
        ]
      );


    if (
      pickingResult.rowCount === 0
    ) {

      await client.query(
        "ROLLBACK"
      );


      return res
        .status(404)
        .json({
          success:
            false,

          code:
            "PICKING_NOT_FOUND",

          title:
            "Picking no encontrado",

          message:
            `No existe un picking con id ${parsedPickingId}.`
        });
    }


    const picking =
      pickingResult.rows[0];


    console.log(
      "✅ PICKING ENCONTRADO:",
      picking
    );


    // ==========================================
    // 3. ELIMINAR ASIGNACIÓN
    // ==========================================

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
      deleteResult.rows
    );


    // ==========================================
    // 4. NO ESTABA ASIGNADO
    // ==========================================

    if (
      deleteResult.rowCount === 0
    ) {

      await client.query(
        "ROLLBACK"
      );


      return res
        .status(404)
        .json({
          success:
            false,

          code:
            "PICKING_ASSIGNMENT_NOT_FOUND",

          title:
            "Pedido no asignado",

          message:
            `El picking ${picking.name} no tiene una asignación activa.`
        });
    }


    // ==========================================
    // 5. COMMIT
    // ==========================================

    await client.query(
      "COMMIT"
    );


    console.log(
      "✅ COMMIT"
    );


    // ==========================================
    // 6. RESPONSE
    // ==========================================

    return res
      .status(200)
      .json({
        success:
          true,

        code:
          "PICKING_UNASSIGNED",

        title:
          "Pedido desasignado",

        message:
          `El picking ${picking.name} fue desasignado correctamente.`,

        picking: {
          id:
            picking.id,

          name:
            picking.name
        },

        deletedAssignments:
          deleteResult.rowCount
      });


  } catch (
  error
  ) {

    console.error(
      "🔥 ERROR UNASSIGN PICKING:",
      error
    );


    try {

      await client.query(
        "ROLLBACK"
      );

    } catch (
    rollbackError
    ) {

      console.error(
        "🔥 Error haciendo rollback:",
        rollbackError
      );
    }


    return res
      .status(500)
      .json({
        success:
          false,

        code:
          "UNASSIGN_PICKING_ERROR",

        title:
          "Error desasignando pedido",

        message:
          error?.message ||
          "Ocurrió un error desasignando el pedido."
      });


  } finally {

    client.release();


    console.log(
      "🔚 [END] UNASSIGN PICKING"
    );
  }
}




//Obtener todos los pickers activos unicamente
export async function getActivePickers(req, res) {

  const client = await db.connect();

  console.log("🟥 Endpoint GET /picking/active-pickers [getActivePickers()] iniciado");

  try {

    /* ==============================
       1️⃣ BUSCAR PICKERS ACTIVOS
    ============================== */

    const pickersResult = await client.query(`
      SELECT id, user_id
      FROM pickers
      WHERE active = true
      AND active_today = true
    `);

    if (pickersResult.rowCount === 0) {
      console.log("🟨 No hay pickers activos disponibles");

      return res.status(200).json({
        success: false,
        title: "Sin pickers",
        message: "No hay pickers disponibles en este momento."
      });
    }

    /* ==============================
       2️⃣ JOIN CON USERS
    ============================== */

    const usersResult = await client.query(`
      SELECT 
        p.id AS picker_id,
        p.user_id,
        u.full_name,
        u.is_active
      FROM pickers p
      JOIN users u ON u.id = p.user_id
      WHERE p.active = true
      AND p.active_today = true
    `);

    let activos = [];
    let inactivos = [];

    for (const row of usersResult.rows) {

      if (row.is_active) {
        activos.push({
          picker_id: row.picker_id,
          user_id: row.user_id,
          full_name: row.full_name
        });
      } else {
        inactivos.push({
          picker_id: row.picker_id,
          user_id: row.user_id,
          full_name: row.full_name
        });
      }
    }

    /* ==============================
       3️⃣ VALIDACIONES
    ============================== */

    if (activos.length === 0) {
      console.log("🟨 Pickers encontrados pero usuarios inactivos");

      return res.status(200).json({
        success: false,
        title: "Usuarios no disponibles",
        message: "Los pickers encontrados no tienen usuarios activos.",
        detail: inactivos
      });
    }

    /* ==============================
       LOG RESUMEN
    ============================== */

    console.log(
      `🟨 Pickers activos: ${activos.length} | ` +
      `Usuarios inactivos filtrados: ${inactivos.length} | ` +
      `Total encontrados: ${usersResult.rowCount}`
    );

    console.log("🟩 Endpoint GET /picking/active-pickers [getActivePickers()] terminado");

    return res.status(200).json({
      success: true,
      data: activos,
      message: "Pickers activos obtenidos correctamente."
    });

  } catch (error) {

    console.error("🟥 ERROR en getActivePickers:", error);

    return res.status(500).json({
      success: false,
      title: "Error interno",
      message: "Ocurrió un error al obtener los pickers."
    });

  } finally {
    client.release();
  }
};



export async function cancelPicking(req, res) {

  const client = await db.connect();

  console.log("🟥 Endpoint POST /picking/cancel [cancelPicking()] iniciado");

  try {
    const picking = req.body;
    const userId = req.user && req.user.id;

    /* ==============================
       1️⃣ VALIDACIONES BÁSICAS
    ============================== */

    if (!userId) {
      console.log("🟨 cancelPicking() detenido | usuario no autenticado");
      return res.status(401).json({
        success: false,
        title: "Usuario no autenticado",
        message: "No se pudo identificar el usuario.",
      });
    }

    if (!picking || !picking.id) {
      console.log("🟨 cancelPicking() detenido | falta picking.id");
      return res.status(400).json({
        success: false,
        title: "ID requerido",
        message: "Debes enviar el id del picking.",
      });
    }

    await client.query("BEGIN");

    /* ==============================
       2️⃣ VALIDAR PERMISOS
    ============================== */

    const userResult = await client.query(
      `
      SELECT permissions
      FROM users
      WHERE id = $1
      LIMIT 1
      `,
      [userId]
    );

    if (userResult.rowCount === 0) {
      await client.query("ROLLBACK");
      console.log("🟨 usuario no existe");
      return res.status(404).json({
        success: false,
        title: "Usuario no encontrado",
        message: "No se encontró el usuario.",
      });
    }

    const permissions = userResult.rows[0].permissions || {};

    const canCancel =
      permissions.picking_warehouse &&
      permissions.picking_warehouse.cancel_orders === true;

    if (!canCancel) {
      await client.query("ROLLBACK");
      console.log("🟨 sin permisos para cancelar");
      return res.status(403).json({
        success: false,
        title: "Sin permisos",
        message: "No tienes permiso para anular pedidos.",
      });
    }

    /* ==============================
       3️⃣ BLOQUEAR PICKING
    ============================== */

    const pickingResult = await client.query(
      `
      SELECT id, state
      FROM stock_picking
      WHERE id = $1
      FOR UPDATE
      `,
      [picking.id]
    );

    if (pickingResult.rowCount === 0) {
      await client.query("ROLLBACK");
      console.log("🟨 picking no encontrado");
      return res.status(404).json({
        success: false,
        title: "Picking no encontrado",
        message: "No existe el picking.",
      });
    }

    const currentState = pickingResult.rows[0].state;

    if (currentState === "done") {
      await client.query("ROLLBACK");
      console.log("🟨 picking en estado done");
      return res.status(200).json({
        success: true,
        title: "Picking completado",
        message: "No se puede anular un picking completado.",
      });
    }

    if (currentState === "cancel") {
      await client.query("ROLLBACK");
      console.log("🟨 picking ya cancelado");
      return res.status(200).json({
        success: true,
        title: "Ya cancelado",
        message: "El picking ya estaba anulado.",
      });
    }

    /* ==============================
       4️⃣ CONTAR MOVE LINES
    ============================== */

    const moveLinesResult = await client.query(
      `
      SELECT COUNT(*) AS count
      FROM stock_move_line
      WHERE picking_id = $1
      `,
      [picking.id]
    );

    const moveLinesCount = moveLinesResult.rows[0].count;

    /* ==============================
       5️⃣ LIBERAR INVENTARIO (MASIVO)
    ============================== */

    const inventoryUpdate = await client.query(
      `
      UPDATE inventory_by_location ibl
      SET qty_reserved = GREATEST(ibl.qty_reserved - sub.total_qty, 0)
      FROM (
        SELECT
          sml.location_id,
          p.sku,
          SUM(sml.product_uom_qty) AS total_qty
        FROM stock_move_line sml
        JOIN products p ON p.id = sml.product_id
        WHERE sml.picking_id = $1
        GROUP BY sml.location_id, p.sku
      ) sub
      WHERE ibl.location_id = sub.location_id
      AND ibl.product_sku = sub.sku
      `,
      [picking.id]
    );

    /* ==============================
       6️⃣ CANCELAR MOVE LINES
    ============================== */

    const cancelMoveLines = await client.query(
      `
      UPDATE stock_move_line
      SET state = 'cancel'
      WHERE picking_id = $1
      `,
      [picking.id]
    );

    /* ==============================
       7️⃣ CANCELAR MOVES
    ============================== */

    const cancelMoves = await client.query(
      `
      UPDATE stock_move
      SET state = 'cancel'
      WHERE picking_id = $1
      `,
      [picking.id]
    );

    /* ==============================
       8️⃣ CANCELAR PICKING
    ============================== */

    const cancelPicking = await client.query(
      `
      UPDATE stock_picking
      SET state = 'cancel',
          user_id = NULL
      WHERE id = $1
      `,
      [picking.id]
    );

    await client.query("COMMIT");

    /* ==============================
       LOG FINAL
    ============================== */

    console.log(
      `🟨 Picking ID: ${picking.id} | Estado: ${currentState} | MoveLines: ${moveLinesCount} | ` +
      `Reservas liberadas: ${inventoryUpdate.rowCount} | ` +
      `Moves cancelados: ${cancelMoves.rowCount} | ` +
      `MoveLines canceladas: ${cancelMoveLines.rowCount}`
    );

    console.log("🟩 Endpoint POST /picking/cancel [cancelPicking()] terminado");

    return res.status(200).json({
      success: true,
      title: "Picking anulado",
      message: "El picking fue anulado correctamente.",
    });

  } catch (error) {
    await client.query("ROLLBACK");

    console.error("🟥 ERROR cancelPicking:", error);

    return res.status(500).json({
      success: false,
      title: "Error",
      message: "Ocurrió un error al anular el picking.",
    });
  } finally {
    client.release();
  }
};



// Obtiene todos los picking de despacho y sus asignaciones
export async function getPickings(req, res) {
  try {

    console.log("🟥 Endpoint GET /picking/active-orders [getPickings()] iniciado");

    /* =========================
       1️⃣ QUERY PARAMS
    ========================= */

    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    // Frontend manda:
    // search=1256,1300,1450

    const searchValues = req.query.search
      ? String(req.query.search)
        .split(",")
        .map(value => value.trim())
        .filter(Boolean)
      : [];

    console.log("🔎 Search recibido:", req.query.search);
    console.log("🔎 Search convertido a array:", searchValues);


    /* =========================
       2️⃣ WHERE DINÁMICO
    ========================= */

    let whereClause = `
      WHERE state NOT IN ('done', 'cancel')
        AND picking_type = 'outgoing'
    `;

    const queryParams = [];

    /*
      Si hay valores de búsqueda:

      ["1256", "1300"]

      buscamos cualquier picking cuyo
      order_name contenga 1256 O 1300
    */

    if (searchValues.length > 0) {

      queryParams.push(searchValues);

      whereClause += `
    AND EXISTS (
      SELECT 1
      FROM unnest($1::text[]) AS search_value
      WHERE
        COALESCE(stock_picking.order_name, '') ILIKE '%' || search_value || '%'
        OR
        COALESCE(stock_picking.erp_cliente, '') ILIKE '%' || search_value || '%'
    )
  `;
    }


    /* =========================
       3️⃣ TOTAL REGISTROS
    ========================= */

    const totalResult = await db.query(
      `
        SELECT COUNT(*) AS total
        FROM stock_picking
        ${whereClause}
      `,
      queryParams
    );

    const total = Number(
      totalResult.rows[0].total
    );


    /* =========================
       4️⃣ OBTENER PICKINGS
    ========================= */

    const pickingParams = [...queryParams];

    // Los índices dependen de si existe búsqueda o no
    const limitIndex = pickingParams.length + 1;

    pickingParams.push(limit);

    const offsetIndex = pickingParams.length + 1;

    pickingParams.push(offset);


    const pickingResult = await db.query(
      `
        SELECT
          id,
          name,
          user_id,
          erp_cliente,
          order_name
        FROM stock_picking

        ${whereClause}

        ORDER BY id DESC

        LIMIT $${limitIndex}
        OFFSET $${offsetIndex}
      `,
      pickingParams
    );

    const pickings = pickingResult.rows;


    /* =========================
       5️⃣ SIN RESULTADOS
    ========================= */

    if (pickings.length === 0) {
      return res.json({
        success: true,
        data: [],
        total,
        page,
        limit,
        search: searchValues
      });
    }


    /* =========================
       6️⃣ IDS
    ========================= */

    const pickingIds = pickings.map(
      p => p.id
    );


    /* =========================
       7️⃣ PICKING ASSIGNMENTS
    ========================= */

    const assignmentResult = await db.query(
      `
        SELECT
          stock_picking_id,
          picker_id
        FROM picking_assignments
        WHERE stock_picking_id = ANY($1)
      `,
      [pickingIds]
    );


    const assignmentMap = new Map();


    assignmentResult.rows.forEach(row => {

      assignmentMap.set(
        Number(row.stock_picking_id),
        Number(row.picker_id)
      );

    });


    /* =========================
       8️⃣ PICKERS
    ========================= */

    const pickerIds = [
      ...new Set(
        assignmentResult.rows.map(
          r => r.picker_id
        )
      )
    ];


    let pickerMap = new Map();


    if (pickerIds.length > 0) {

      const pickerResult = await db.query(
        `
          SELECT
            id,
            user_id,
            active,
            active_today
          FROM pickers
          WHERE id = ANY($1)
        `,
        [pickerIds]
      );


      pickerResult.rows.forEach(row => {

        pickerMap.set(
          row.id,
          row
        );

      });
    }


    /* =========================
       9️⃣ USERS
    ========================= */

    const userIds = [
      ...new Set(
        Array.from(
          pickerMap.values()
        ).map(
          p => p.user_id
        )
      )
    ];


    let userMap = new Map();


    if (userIds.length > 0) {

      const userResult = await db.query(
        `
          SELECT
            id,
            full_name
          FROM users
          WHERE id = ANY($1)
        `,
        [userIds]
      );


      userResult.rows.forEach(row => {

        userMap.set(
          row.id,
          row.full_name
        );

      });
    }


    /* =========================
       🔟 ENRIQUECER DATA
    ========================= */

    const result = pickings.map(p => {

      const pickerId =
        assignmentMap.get(
          Number(p.id)
        ) || null;


      const picker =
        pickerMap.get(
          pickerId
        );


      let pickerActive = false;
      let pickerName = null;


      if (picker) {

        pickerActive =
          picker.active &&
          picker.active_today;

        pickerName =
          userMap.get(
            picker.user_id
          ) || null;
      }


      return {
        id: p.id,

        name: p.order_name,

        erp_cliente:
          p.erp_cliente,

        picker_id:
          pickerId,

        picker_active:
          pickerActive,

        picker_name:
          pickerName
      };

    });


    /* =========================
       LOG
    ========================= */

    console.log(
      `🟨 Pickings: ${pickings.length}
       | Total: ${total}
       | Page: ${page}
       | Limit: ${limit}
       | Offset: ${offset}
       | Search: ${JSON.stringify(searchValues)}
       | Assignments: ${assignmentMap.size}
       | Pickers: ${pickerMap.size}
       | Users: ${userMap.size}`
    );


    console.log(
      "🟩 Endpoint GET /picking/active-orders [getPickings()] terminado"
    );


    /* =========================
       1️⃣1️⃣ RESPUESTA
    ========================= */

    return res.json({
      success: true,
      data: result,
      total,
      page,
      limit,
      search: searchValues
    });


  } catch (error) {

    console.error(
      "❌ ERROR GET PICKINGS:",
      error
    );


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








function createControllerError(
  statusCode,
  title,
  message
) {
  const error = new Error(message);

  error.statusCode = statusCode;
  error.title = title;

  return error;
}

// ==========================================================
// OBTENER LÍNEAS EXISTENTES DEL PICKING
// ==========================================================

export async function getPickingMoveLinesController(
  req,
  res
) {
  console.log(
    "🟦 ----[START] Get Picking Move Lines----"
  );

  let client;
  let transactionStarted = false;
  let releaseError;

  try {
    // ========================================================
    // 1. VALIDAR pickingId
    // ========================================================

    const pickingId = String(
      req.params.pickingId ?? ""
    ).trim();

    if (
      !/^[1-9]\d*$/.test(pickingId) ||
      BigInt(pickingId) >
      9223372036854775807n
    ) {
      return res.status(400).json({
        success: false,
        title: "Picking inválido",
        message:
          "Debes enviar un pickingId entero positivo válido.",
      });
    }

    // ========================================================
    // 2. ABRIR CONEXIÓN Y TRANSACCIÓN
    // ========================================================

    client = await db.connect();

    await client.query("BEGIN");
    transactionStarted = true;

    console.log("🔐 Transacción iniciada");

    // ========================================================
    // 3. BUSCAR EL PICKING LOCAL
    // ========================================================

    const pickingResult = await client.query(
      `
        SELECT
          id,
          name,
          state,
          sale_id
        FROM public.stock_picking
        WHERE id = $1
        LIMIT 1
      `,
      [pickingId]
    );

    const localPicking =
      pickingResult.rows[0];

    if (!localPicking) {
      throw createControllerError(
        404,
        "Picking no encontrado",
        `No existe un picking con el ID ${pickingId}.`
      );
    }

    console.log(
      "📦 Picking local encontrado:",
      localPicking
    );

    // ========================================================
    // 4. VALIDAR sale_id
    // ========================================================

    const saleId = String(
      localPicking.sale_id ?? ""
    ).trim();

    if (!saleId) {
      throw createControllerError(
        422,
        "Picking sin pedido de venta",
        `El picking ${pickingId} no tiene un valor en sale_id.`
      );
    }

    const guidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    if (!guidRegex.test(saleId)) {
      throw createControllerError(
        422,
        "GUID del pedido inválido",
        `El sale_id del picking ${pickingId} no es un GUID válido.`
      );
    }

    console.log(
      "🔗 Pedido asociado al picking:",
      {
        pickingId,
        pickingName:
          localPicking.name,
        saleId,
      }
    );

    // ========================================================
    // 5. OBTENER LAS stock_move_line EXISTENTES
    // ========================================================

    const finalResult =
      await getMoveLinesOrderedByLocation(
        client,
        pickingId
      );

    const finalLines =
      Array.isArray(finalResult)
        ? finalResult
        : [];

    console.log(
      "📦 Líneas finales:",
      finalLines
    );

    // ========================================================
    // 6. CONFIRMAR TRANSACCIÓN
    // ========================================================

    await client.query("COMMIT");
    transactionStarted = false;

    console.log(
      "✅ Transacción confirmada"
    );

    // ========================================================
    // 7. RESPUESTA
    // ========================================================

    return res.status(200).json({
      success: true,
      title: "Picking encontrado",
      message:
        finalLines.length > 0
          ? "Las líneas del picking fueron obtenidas correctamente."
          : "El picking todavía no tiene líneas operativas.",

      picking: {
        id:
          localPicking.id,
        name:
          localPicking.name,
        state:
          localPicking.state,
        sale_id:
          saleId,
      },

      data:
        finalLines,
    });
  } catch (error) {
    // ========================================================
    // 8. ROLLBACK
    // ========================================================

    if (
      client &&
      transactionStarted
    ) {
      try {
        await client.query(
          "ROLLBACK"
        );

        transactionStarted = false;

        console.log(
          "🟠 ROLLBACK ejecutado"
        );
      } catch (rollbackError) {
        releaseError =
          rollbackError;

        console.error(
          "❌ Error realizando ROLLBACK:",
          rollbackError.message
        );
      }
    }

    console.error(
      "🔥 Error obteniendo líneas del picking:",
      {
        pickingId:
          req.params.pickingId,

        message:
          error.message,
      }
    );

    const candidateStatus =
      Number(error.statusCode);

    const status =
      Number.isInteger(
        candidateStatus
      ) &&
        candidateStatus >= 400 &&
        candidateStatus <= 599
        ? candidateStatus
        : 500;

    return res
      .status(status)
      .json({
        success: false,

        title:
          error.title ||
          "Error obteniendo el picking",

        message:
          error.message ||
          "No se pudieron obtener las líneas del picking.",
      });
  } finally {
    // ========================================================
    // 9. LIBERAR CONEXIÓN
    // ========================================================

    if (client) {
      client.release(
        releaseError
      );
    }

    console.log(
      "🔚 ----[END] Get Picking Move Lines----"
    );
  }
}






// ============================================================
// GET ADM CLOUD DISPATCH DETAILS
// ============================================================

export async function getAdmCloudDispatchDetailsController(req, res) {

    console.log("");
    console.log("📦 ========================================");
    console.log("📦 GET ADM CLOUD DISPATCH DETAILS");
    console.log("📦 ========================================");

    let client;

    try {

        // ====================================================
        // 1. RECIBIR Y VALIDAR ID
        // ====================================================

        const { id } = req.params;

        console.log("📥 Dispatch ID recibido:", id);

        const dispatchId = Number(id);

        if (
            !Number.isSafeInteger(dispatchId) ||
            dispatchId <= 0
        ) {
            return res.status(400).json({
                success: false,
                title: "ID inválido",
                message: "El ID del conduce no es válido."
            });
        }

        client = await db.connect();


        // ====================================================
        // 2. BUSCAR CONDUCE EN ADM CLOUD DISPATCHES
        // ====================================================

        console.log("");
        console.log("🔎 Buscando conduce:", dispatchId);

        const dispatchResult = await client.query(
            `
            SELECT
                d.id,
                d.picking_id,
                d.sale_id,

                -- ============================================
                -- IDENTIFICADORES ADM CLOUD
                -- ============================================

                d.erp_conduce_id,
                d.erp_doc_id,
                d.erp_reference,

                -- ============================================
                -- CLIENTE
                -- ============================================

                d.erp_relationship_id,
                d.erp_relationship_name,

                -- ============================================
                -- UBICACIÓN
                -- ============================================

                d.erp_location_id,

                d.erp_ship_to_address_id,
                d.erp_ship_to_address1,
                d.erp_ship_to_address2,

                -- ============================================
                -- DATOS ADM CLOUD
                -- ============================================

                d.erp_billing_status_desc,
                d.erp_status,
                d.erp_doc_type,

                -- ============================================
                -- ESTADO LOCAL DEL CONDUCE EN SIDIAL
                -- completed = Completado
                -- reverted  = Anulado
                -- ============================================

                d.state,

                -- ============================================
                -- FECHAS
                -- ============================================

                d.erp_creation_date,
                d.erp_doc_date,

                -- ============================================
                -- COSTO
                -- ============================================

                d.erp_calculated_total_cost,

                -- ============================================
                -- AUDITORÍA
                -- ============================================

                d.created_at,
                d.updated_at

            FROM public.admcloud_dispatches d

            WHERE d.id = $1

            LIMIT 1
            `,
            [dispatchId]
        );


        // ====================================================
        // 3. VALIDAR QUE EXISTA
        // ====================================================

        if (dispatchResult.rowCount === 0) {

            console.log(
                "❌ Conduce no encontrado:",
                dispatchId
            );

            return res.status(404).json({
                success: false,
                title: "Conduce no encontrado",
                message: `No existe el conduce con ID ${dispatchId}.`
            });
        }


        const dispatch = dispatchResult.rows[0];


        // ====================================================
        // 4. INTERPRETAR ESTADO LOCAL
        // ====================================================

        let stateLabel = "Desconocido";

        let stateColor = "gray";

        switch (dispatch.state) {

            case "completed":

                stateLabel = "Completado";
                stateColor = "green";

                break;


            case "reverted":

                stateLabel = "Anulado";
                stateColor = "red";

                break;


            default:

                stateLabel = "Desconocido";
                stateColor = "gray";

                break;

        }


        console.log("");
        console.log("✅ CONDUCE ENCONTRADO");
        console.log("🆔 ID:", dispatch.id);
        console.log("📄 Documento:", dispatch.erp_doc_id);
        console.log("📋 Referencia:", dispatch.erp_reference);
        console.log("👤 Cliente:", dispatch.erp_relationship_name);
        console.log("📦 Picking ID:", dispatch.picking_id);
        console.log("🚚 ERP Conduce ID:", dispatch.erp_conduce_id);

        console.log("📊 Estado ADM Cloud:", dispatch.erp_status);

        console.log("📊 Estado SIDIAL:", {
            state: dispatch.state,
            label: stateLabel,
            color: stateColor
        });


        // ====================================================
        // 5. AGREGAR INFORMACIÓN VISUAL DEL ESTADO
        // ====================================================

        dispatch.state_label = stateLabel;
        dispatch.state_color = stateColor;


        // ====================================================
        // 6. VALIDAR ERP CONDUCE ID
        // ====================================================

        if (!dispatch.erp_conduce_id) {

            console.log(
                "⚠️ El conduce no tiene ERP Conduce ID."
            );

            return res.status(200).json({

                success: true,

                title: "Conduce encontrado",

                message:
                    "Conduce encontrado, sin líneas despachadas.",

                data: {

                    dispatch,

                    lines: [],

                    totals: {
                        ordered: 0,
                        completed: 0,
                        pending: 0
                    }

                }

            });
        }


        // ====================================================
        // 7. BUSCAR STOCK MOVE LINE DESPACHADAS
        // ====================================================

        console.log("");
        console.log("🔎 Buscando líneas despachadas...");

        console.log(
            "🔗 erp_dispatch_id:",
            dispatch.erp_conduce_id
        );


        const linesResult = await client.query(
            `
            SELECT

                -- ============================================
                -- STOCK MOVE LINE
                -- ============================================

                sml.id,
                sml.move_id,
                sml.picking_id,
                sml.product_id,

                sml.product_uom_id,
                sml.product_uom_qty,

                sml.qty_done,

                sml.location_id,
                sml.location_dest_id,

                sml.state,
                sml.user_id,
                sml.warehouse_id,

                sml.erp_dispatch_id,

                sml.create_date,
                sml.write_date,


                -- ============================================
                -- DATOS DEL PRODUCTO
                -- ============================================

                p.sku AS wms_sku,

                p.sku AS product_sku,

                p.sku AS sku,

                p.erp_id AS erp_item_id,

                p.erp_sku AS erp_item_sku,

                p.erp_name AS erp_item_name,

                p.description AS product_description,


                -- ============================================
                -- DESCRIPCIÓN PARA EL FRONTEND
                -- ============================================

                COALESCE(
                    NULLIF(p.erp_name, ''),
                    NULLIF(p.description, ''),
                    'Producto sin descripción'
                ) AS erp_name,


                -- ============================================
                -- CANTIDAD ORDENADA
                -- ============================================

                COALESCE(
                    sml.product_uom_qty,
                    0
                ) AS erp_quantity,


                -- ============================================
                -- CANTIDAD DESPACHADA
                -- ============================================

                COALESCE(
                    sml.qty_done,
                    0
                ) AS erp_completed_quantity,


                -- ============================================
                -- CANTIDAD PENDIENTE DE LA LÍNEA
                -- ============================================

                GREATEST(
                    COALESCE(sml.product_uom_qty, 0)
                    -
                    COALESCE(sml.qty_done, 0),
                    0
                ) AS erp_pending_completed_quantity


            FROM public.stock_move_line sml

            LEFT JOIN public.products p
                ON p.id = sml.product_id


            WHERE
                sml.erp_dispatch_id = $1

                AND sml.picking_id = $2

                AND sml.state = 'done'

                AND sml.qty_done > 0


            ORDER BY
                sml.id ASC
            `,
            [
                dispatch.erp_conduce_id,
                dispatch.picking_id
            ]
        );


        const lines = linesResult.rows;


        // ====================================================
        // 8. LOG DE LAS LÍNEAS
        // ====================================================

        console.log("");
        console.log("✅ LÍNEAS DESPACHADAS ENCONTRADAS");

        console.log("📦 Total:", lines.length);


        for (const line of lines) {

            console.log("------------------------------------");

            console.log(
                "🆔 Stock Move Line:",
                line.id
            );

            console.log(
                "📦 Product ID:",
                line.product_id
            );

            console.log(
                "🏷️ WMS SKU:",
                line.wms_sku
            );

            console.log(
                "🏷️ ADM SKU:",
                line.erp_item_sku
            );

            console.log(
                "📄 Producto:",
                line.erp_name
            );

            console.log(
                "📊 Ordenada:",
                line.erp_quantity
            );

            console.log(
                "✅ Despachada:",
                line.erp_completed_quantity
            );

            console.log(
                "⏳ Pendiente:",
                line.erp_pending_completed_quantity
            );

        }


        // ====================================================
        // 9. CALCULAR TOTALES
        // ====================================================

        const totals = lines.reduce(
            (acc, line) => {

                acc.ordered +=
                    Number(line.erp_quantity) || 0;

                acc.completed +=
                    Number(line.erp_completed_quantity) || 0;

                acc.pending +=
                    Number(line.erp_pending_completed_quantity) || 0;

                return acc;
            },
            {
                ordered: 0,
                completed: 0,
                pending: 0
            }
        );


        // ====================================================
        // 10. LOG RESUMEN
        // ====================================================

        console.log("");
        console.log("📊 ========================================");
        console.log("📊 RESUMEN DEL CONDUCE");
        console.log("📊 ========================================");

        console.log(
            "📄 Conduce:",
            dispatch.erp_doc_id
        );

        console.log(
            "📦 Total líneas:",
            lines.length
        );

        console.log(
            "📋 Cantidad ordenada:",
            totals.ordered
        );

        console.log(
            "✅ Cantidad despachada:",
            totals.completed
        );

        console.log(
            "⏳ Cantidad pendiente:",
            totals.pending
        );

        console.log(
            "📊 Estado:",
            dispatch.state
        );

        console.log(
            "🏷️ Estado mostrado:",
            dispatch.state_label
        );


        // ====================================================
        // 11. RESPUESTA FINAL
        // ====================================================

        return res.status(200).json({

            success: true,

            title: "Detalles del conduce",

            message:
                "Detalles del conduce obtenidos correctamente.",

            data: {

                dispatch,

                lines,

                totals

            }

        });


    } catch (error) {

        // ====================================================
        // ERROR
        // ====================================================

        console.error("");
        console.error("❌ ERROR GET ADM CLOUD DISPATCH DETAILS");
        console.error(error);

        return res.status(500).json({

            success: false,

            title: "Error obteniendo conduce",

            message:
                "Error obteniendo los detalles del conduce.",

            error:
                process.env.NODE_ENV === "development"
                    ? error.message
                    : undefined

        });

    } finally {

        // ====================================================
        // LIBERAR CONEXIÓN
        // ====================================================

        if (client) {
            client.release();
        }

        console.log("");
        console.log("📦 FIN GET ADM CLOUD DISPATCH DETAILS");
        console.log("📦 ========================================");

    }

}














// ============================================================
// ERROR CONTROLADO
// ============================================================

class ReverseDispatchError extends Error {
  constructor(
    status,
    title,
    message,
    code = "DISPATCH_REVERSE_ERROR"
  ) {
    super(message);

    this.name = "ReverseDispatchError";
    this.status = status;
    this.title = title;
    this.code = code;
  }
}


// ============================================================
// VALIDAR IDENTIFICADOR
// ACEPTA ID LOCAL O UUID DE ADM CLOUD
// ============================================================

function getDispatchIdentifier(value) {
  const id = String(value ?? "").trim();

  if (/^[1-9]\d*$/.test(id)) {
    return {
      type: "local",
      value: id
    };
  }

  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      .test(id)
  ) {
    return {
      type: "erp",
      value: id
    };
  }

  throw new ReverseDispatchError(
    400,
    "Identificador inválido",
    "Debes proporcionar un ID local o un UUID válido de ADM Cloud.",
    "INVALID_DISPATCH_ID"
  );
}


// ============================================================
// NORMALIZAR RESPUESTA DEL SERVICIO ADM CLOUD
// ============================================================

function normalizeAdmCloudResponse(response) {
  // Por si el servicio devuelve directamente el payload
  // o un objeto Axios con { data: payload }.

  if (
    response?.data &&
    typeof response.data.success === "boolean"
  ) {
    return response.data;
  }

  return response;
}


// ============================================================
// VERIFICAR SI ADM CLOUD PERMITE LA REVERSIÓN
// ============================================================

async function verifyDispatchInAdmCloud(dispatch) {
  console.log("");
  console.log("🌐 ========================================");
  console.log("🌐 VERIFICANDO CONDUCE EN ADM CLOUD");
  console.log("🌐 ========================================");

  console.log("📄 Conduce:", dispatch.erp_doc_id);
  console.log("🆔 ERP GUID:", dispatch.erp_conduce_id);

  let response;

  try {
    response = await getAdmCloudDispatchService({
      id: dispatch.erp_conduce_id
    });

  } catch (error) {

    // Únicamente este error explícito significa
    // que ADM Cloud confirmó ausencia de información.

    const errorCode =
      error?.code ||
      error?.response?.data?.code;

    if (errorCode === "EMPTY_DISPATCH_DATA") {
      console.log(
        "✅ ADM Cloud confirmó conduce sin información."
      );

      return {
        verified: true,
        erpStatus: "deleted"
      };
    }

    throw new ReverseDispatchError(
      502,
      "No fue posible verificar el conduce",
      "Falló la comunicación con ADM Cloud. No se modificó el inventario.",
      "ADM_CLOUD_VERIFICATION_FAILED"
    );
  }

  const result = normalizeAdmCloudResponse(response);

  console.log("📥 Respuesta ADM Cloud:", {
    success: result?.success,
    code: result?.code,
    ID: result?.data?.ID,
    DocID: result?.data?.DocID,
    Void: result?.data?.Void
  });


  // ========================================================
  // CASO 1: CONDUCE ELIMINADO EN ADM CLOUD
  // ========================================================

  if (
    result?.success === false &&
    result?.code === "EMPTY_DISPATCH_DATA"
  ) {
    console.log(
      "✅ Conduce eliminado en ADM Cloud. Reversión permitida."
    );

    return {
      verified: true,
      erpStatus: "deleted"
    };
  }


  // ========================================================
  // CASO 2: RESPUESTA NO VÁLIDA
  // ========================================================

  if (
    result?.success !== true ||
    !result?.data
  ) {
    throw new ReverseDispatchError(
      502,
      "Verificación incompleta",
      result?.message ||
      "ADM Cloud no confirmó el estado del conduce.",
      "INVALID_ADM_CLOUD_RESPONSE"
    );
  }

  const erpDispatch = result.data;


  // ========================================================
  // VALIDAR IDENTIDAD DEL CONDUCE
  // ========================================================

  if (
    String(erpDispatch.ID ?? "").toLowerCase() !==
    String(dispatch.erp_conduce_id).toLowerCase()
  ) {
    throw new ReverseDispatchError(
      409,
      "Conduce diferente",
      "ADM Cloud devolvió un conduce con un identificador diferente.",
      "ERP_DISPATCH_MISMATCH"
    );
  }


  // ========================================================
  // CASO 3: CONDUCE ANULADO
  // ========================================================

  if (erpDispatch.Void === true) {
    console.log(
      "✅ Conduce anulado en ADM Cloud."
    );

    return {
      verified: true,
      erpStatus: "voided"
    };
  }


  // ========================================================
  // CASO 4: CONDUCE ACTIVO
  // ========================================================

  if (erpDispatch.Void === false) {
    throw new ReverseDispatchError(
      409,
      "Conduce activo en ADM Cloud",
      `El conduce ${dispatch.erp_doc_id} continúa activo en ADM Cloud. Debe anularse antes de revertirlo en SIDIAL.`,
      "DISPATCH_STILL_ACTIVE"
    );
  }


  // ========================================================
  // ESTADO DESCONOCIDO
  // ========================================================

  throw new ReverseDispatchError(
    502,
    "Estado desconocido",
    "ADM Cloud no devolvió un valor booleano para Void.",
    "UNKNOWN_DISPATCH_STATUS"
  );
}


// ============================================================
// REVERSE ADM CLOUD DISPATCH CONTROLLER
// ============================================================

export async function reverseAdmCloudDispatchController(req, res) {

  console.log("");
  console.log("🔴 ========================================");
  console.log("🔴 INICIANDO REVERSIÓN DE CONDUCE");
  console.log("🔴 ========================================");

  let client = null;
  let transactionStarted = false;

  try {

    // ====================================================
    // 1. VALIDAR INPUT
    // ====================================================

    const identifier = getDispatchIdentifier(
      req.params.id
    );

    const reason =
      typeof req.body?.reason === "string"
        ? req.body.reason.trim()
        : "Conduce anulado o eliminado en ADM Cloud";

    if (reason.length > 1000) {
      throw new ReverseDispatchError(
        400,
        "Motivo inválido",
        "El motivo no puede superar 1000 caracteres."
      );
    }

    // El usuario autenticado debe provenir
    // del middleware de autenticación.
    const rawUserId =
      req.user?.id ??
      req.user?.user_id ??
      req.auth?.userId ??
      null;

    const reversedBy =
      rawUserId !== null &&
        /^\d+$/.test(String(rawUserId))
        ? String(rawUserId)
        : null;

    console.log("📥 INPUT:", {
      identifier,
      reason,
      reversedBy
    });


    // ====================================================
    // 2. BUSCAR CONDUCE LOCAL
    // ====================================================

    const lookupQuery =
      identifier.type === "local"
        ? `
                    SELECT
                        id,
                        picking_id,
                        sale_id,
                        erp_conduce_id,
                        erp_doc_id,
                        erp_reference,
                        state
                    FROM public.admcloud_dispatches
                    WHERE id = $1::bigint
                    LIMIT 1
                `
        : `
                    SELECT
                        id,
                        picking_id,
                        sale_id,
                        erp_conduce_id,
                        erp_doc_id,
                        erp_reference,
                        state
                    FROM public.admcloud_dispatches
                    WHERE erp_conduce_id = $1::uuid
                    LIMIT 1
                `;

    const localResult = await db.query(
      lookupQuery,
      [identifier.value]
    );

    if (localResult.rows.length === 0) {
      throw new ReverseDispatchError(
        404,
        "Conduce no encontrado",
        "El conduce solicitado no existe en SIDIAL.",
        "DISPATCH_NOT_FOUND"
      );
    }

    const localDispatch = localResult.rows[0];

    console.log("📦 CONDUCE LOCAL:", localDispatch);


    // ====================================================
    // 3. COMPROBAR SI YA ESTÁ REVERTIDO
    // ====================================================

    if (localDispatch.state === "reverted") {
      throw new ReverseDispatchError(
        409,
        "Conduce ya revertido",
        "Este conduce ya fue revertido anteriormente.",
        "DISPATCH_ALREADY_REVERTED"
      );
    }

    if (localDispatch.state !== "completed") {
      throw new ReverseDispatchError(
        409,
        "Estado no permitido",
        `No se puede revertir un conduce con estado ${localDispatch.state}.`,
        "INVALID_LOCAL_DISPATCH_STATE"
      );
    }


    // ====================================================
    // 4. VERIFICACIÓN EXTERNA ADM CLOUD
    // ====================================================

    const erpVerification =
      await verifyDispatchInAdmCloud(localDispatch);

    console.log(
      "✅ Verificación ADM Cloud:",
      erpVerification
    );


    // ====================================================
    // 5. ABRIR TRANSACCIÓN
    // ====================================================

    client = await db.connect();

    await client.query("BEGIN");

    transactionStarted = true;

    console.log("🟢 BEGIN");


    // ====================================================
    // 6. BLOQUEAR CONDUCE
    // ====================================================

    const lockedResult = await client.query(
      `
            SELECT
                id,
                picking_id,
                erp_conduce_id,
                erp_doc_id,
                state
            FROM public.admcloud_dispatches
            WHERE id = $1
            FOR UPDATE
            `,
      [localDispatch.id]
    );

    if (lockedResult.rows.length === 0) {
      throw new ReverseDispatchError(
        404,
        "Conduce no encontrado",
        "El conduce desapareció durante la operación."
      );
    }

    const dispatch = lockedResult.rows[0];

    if (
      String(dispatch.erp_conduce_id).toLowerCase() !==
      String(localDispatch.erp_conduce_id).toLowerCase()
    ) {
      throw new ReverseDispatchError(
        409,
        "Conduce modificado",
        "El identificador ERP cambió durante la verificación."
      );
    }

    if (dispatch.state !== "completed") {
      throw new ReverseDispatchError(
        409,
        "Conduce ya procesado",
        "El conduce ya no se encuentra en estado completed.",
        "DISPATCH_STATE_CHANGED"
      );
    }

    console.log(
      "🔒 CONDUCE BLOQUEADO:",
      dispatch.id
    );


    // ====================================================
    // 7. VALIDAR REVERSIÓN ANTERIOR
    // ====================================================

    const previousReversal = await client.query(
      `
            SELECT id
            FROM public.admcloud_dispatch_reversals
            WHERE erp_conduce_id = $1
            LIMIT 1
            `,
      [dispatch.erp_conduce_id]
    );

    if (previousReversal.rows.length > 0) {
      throw new ReverseDispatchError(
        409,
        "Reversión duplicada",
        "Ya existe una reversión registrada para este conduce.",
        "DUPLICATE_DISPATCH_REVERSAL"
      );
    }


    // ====================================================
    // 8. OBTENER PICKING
    // SOLO CONSULTAR, NO MODIFICAR SU ESTADO
    // ====================================================

    const pickingResult = await client.query(
      `
            SELECT
                id,
                name
            FROM public.stock_picking
            WHERE id = $1
            LIMIT 1
            `,
      [dispatch.picking_id]
    );

    if (pickingResult.rows.length === 0) {
      throw new ReverseDispatchError(
        409,
        "Picking no encontrado",
        "No existe el picking asociado al conduce."
      );
    }

    const picking = pickingResult.rows[0];

    console.log("📦 PICKING:", picking);


    // ====================================================
    // 9. BUSCAR STOCK MOVE LINES COMPLETADAS
    // ====================================================

    const moveLinesResult = await client.query(
      `
            SELECT
                sml.id,
                sml.move_id,
                sml.picking_id,
                sml.product_id,
                sml.product_uom_qty,
                sml.qty_done,
                sml.location_id,
                sml.location_dest_id,
                sml.warehouse_id,
                sml.user_id,
                sml.erp_dispatch_id,
                sml.state,

                p.sku,
                p.description,
                p.erp_sku,

                loc.warehouse_id AS location_warehouse_id,
                loc.code AS location_code

            FROM public.stock_move_line sml

            LEFT JOIN public.products p
                ON p.id = sml.product_id

            LEFT JOIN public.locations loc
                ON loc.id = sml.location_id

            WHERE sml.erp_dispatch_id = $1
              AND sml.picking_id = $2
              AND sml.state = 'done'
              AND sml.qty_done > 0

            ORDER BY sml.id ASC

            FOR UPDATE OF sml
            `,
      [
        dispatch.erp_conduce_id,
        dispatch.picking_id
      ]
    );

    const moveLines = moveLinesResult.rows;

    console.log(
      "📦 STOCK MOVE LINES A REVERTIR:"
    );

    console.table(
      moveLines.map((line) => ({
        id: line.id,
        sku: line.sku,
        qty_done: line.qty_done,
        location_id: line.location_id,
        warehouse_id: line.warehouse_id,
        state: line.state
      }))
    );

    if (moveLines.length === 0) {
      throw new ReverseDispatchError(
        409,
        "Sin líneas para revertir",
        "No existen líneas completadas asociadas a este conduce.",
        "NO_COMPLETED_MOVE_LINES"
      );
    }


    // ====================================================
    // 10. CREAR REGISTRO DE REVERSIÓN
    // EL UNIQUE DEL ERP GUID EVITA DUPLICADOS
    // ====================================================

    const reversalResult = await client.query(
      `
            INSERT INTO public.admcloud_dispatch_reversals (
                erp_conduce_id,
                dispatch_id,
                picking_id,
                total_qty_returned,
                reversed_by,
                reason
            )
            VALUES (
                $1,
                $2,
                $3,
                0,
                $4,
                $5
            )
            ON CONFLICT (erp_conduce_id)
            DO NOTHING
            RETURNING id
            `,
      [
        dispatch.erp_conduce_id,
        dispatch.id,
        dispatch.picking_id,
        reversedBy,
        reason
      ]
    );

    if (reversalResult.rows.length === 0) {
      throw new ReverseDispatchError(
        409,
        "Reversión duplicada",
        "Otro proceso ya registró la reversión."
      );
    }

    const reversalId = reversalResult.rows[0].id;

    console.log(
      "🧾 REVERSAL ID:",
      reversalId
    );


    // ====================================================
    // 11. REVERTIR CADA STOCK MOVE LINE
    // ====================================================

    let totalQtyReturned = 0;

    const reversedLines = [];
    const usedShipMovementIds = new Set();

    for (const line of moveLines) {

      console.log("");
      console.log(
        "🔄 REVIRTIENDO STOCK MOVE LINE:",
        line.id
      );

      const qty = Number(line.qty_done);

      // ================================================
      // VALIDAR DATOS FÍSICOS
      // ================================================

      if (
        !line.sku ||
        !line.location_id ||
        !line.location_warehouse_id ||
        !Number.isFinite(qty) ||
        qty <= 0
      ) {
        throw new ReverseDispatchError(
          409,
          "Línea incompleta",
          `La línea ${line.id} no tiene SKU, ubicación, almacén o cantidad válida.`,
          "INVALID_MOVE_LINE"
        );
      }

      if (
        line.warehouse_id !== null &&
        line.warehouse_id !== undefined &&
        String(line.warehouse_id) !==
        String(line.location_warehouse_id)
      ) {
        throw new ReverseDispatchError(
          409,
          "Almacén inconsistente",
          `La línea ${line.id} pertenece a un almacén diferente al de su ubicación.`,
          "WAREHOUSE_MISMATCH"
        );
      }

      const warehouseId =
        line.location_warehouse_id;

      const locationId =
        line.location_id;

      console.log("📦 PRODUCTO:", line.sku);
      console.log("📍 UBICACIÓN:", locationId);
      console.log("🏭 WAREHOUSE:", warehouseId);
      console.log("📊 CANTIDAD:", qty);


      // ================================================
      // BUSCAR MOVIMIENTO SHIP ORIGINAL
      // ================================================

      const shipResult = await client.query(
        `
                SELECT
                    id,
                    from_location_id,
                    to_location_id,
                    qty,
                    movement_type
                FROM public.inventory_movements
                WHERE movement_type = 'SHIP'
                  AND reference_type = $1
                  AND reference_id = $2
                  AND product_sku = $3
                  AND from_location_id = $4
                  AND qty = $5::numeric

                ORDER BY id ASC

                FOR UPDATE
                `,
        [
          picking.name,
          String(picking.id),
          line.sku,
          locationId,
          line.qty_done
        ]
      );

      // No inventamos el destino si no podemos
      // relacionarlo con una salida registrada.

      if (shipResult.rows.length !== 1) {
        throw new ReverseDispatchError(
          409,
          "Movimiento original ambiguo",
          `La línea ${line.id} tiene ${shipResult.rows.length} movimientos SHIP coincidentes. Se requiere identificar inequívocamente su salida antes de devolver inventario.`,
          "SHIP_MOVEMENT_NOT_UNIQUE"
        );
      }

      const originalShip = shipResult.rows[0];

      if (!originalShip.to_location_id) {
        throw new ReverseDispatchError(
          409,
          "Destino de salida desconocido",
          `El movimiento SHIP ${originalShip.id} no tiene ubicación de destino.`,
          "MISSING_SHIP_DESTINATION"
        );
      }

      if (
        line.location_dest_id !== null &&
        line.location_dest_id !== undefined &&
        String(line.location_dest_id) !==
        String(originalShip.to_location_id)
      ) {
        throw new ReverseDispatchError(
          409,
          "Ubicaciones inconsistentes",
          `El destino de la línea ${line.id} no coincide con el movimiento SHIP ${originalShip.id}.`,
          "SHIP_DESTINATION_MISMATCH"
        );
      }

      if (
        usedShipMovementIds.has(
          String(originalShip.id)
        )
      ) {
        throw new ReverseDispatchError(
          409,
          "Movimiento de salida duplicado",
          `El movimiento SHIP ${originalShip.id} coincide con más de una línea.`,
          "SHIP_MOVEMENT_REUSED"
        );
      }

      usedShipMovementIds.add(
        String(originalShip.id)
      );


      // ================================================
      // EVITAR REVERTIR DOS VECES EL MISMO SHIP
      // ================================================

      const alreadyReversedShip =
        await client.query(
          `
                    SELECT id
                    FROM public.inventory_movements
                    WHERE movement_type = 'MOVE'
                      AND reference_type = 'DISPATCH_VOID'
                      AND note LIKE $1
                    LIMIT 1
                    `,
          [
            `%SHIP_ID=${originalShip.id};%`
          ]
        );

      if (alreadyReversedShip.rows.length > 0) {
        throw new ReverseDispatchError(
          409,
          "Salida previamente revertida",
          `El movimiento SHIP ${originalShip.id} ya tiene registrada una reversión.`,
          "SHIP_ALREADY_REVERSED"
        );
      }


      // ================================================
      // DEVOLVER INVENTARIO
      // qty_available ES COLUMNA GENERATED
      // ================================================

      const inventoryResult = await client.query(
        `
                INSERT INTO public.inventory_by_location (
                    warehouse_id,
                    location_id,
                    product_sku,
                    qty_on_hand,
                    qty_reserved,
                    updated_at
                )
                VALUES (
                    $1,
                    $2,
                    $3,
                    $4::numeric,
                    0,
                    NOW()
                )

                ON CONFLICT (
                    warehouse_id,
                    location_id,
                    product_sku
                )

                DO UPDATE SET
                    qty_on_hand =
                        inventory_by_location.qty_on_hand
                        + EXCLUDED.qty_on_hand,

                    updated_at = NOW()

                RETURNING
                    id,
                    warehouse_id,
                    location_id,
                    product_sku,
                    qty_on_hand,
                    qty_reserved,
                    qty_available
                `,
        [
          warehouseId,
          locationId,
          line.sku,
          line.qty_done
        ]
      );

      const inventory = inventoryResult.rows[0];

      console.log(
        "✅ INVENTARIO RESTAURADO:",
        inventory
      );


      // ================================================
      // REGISTRAR MOVIMIENTO INVERSO
      // NO ELIMINAR EL SHIP ORIGINAL
      // ================================================

      const movementNote =
        `Reversión del conduce ${dispatch.erp_doc_id}; ` +
        `ERP_ID=${dispatch.erp_conduce_id}; ` +
        `STOCK_MOVE_LINE_ID=${line.id}; ` +
        `SHIP_ID=${originalShip.id}; ` +
        `REVERSAL_ID=${reversalId}; ` +
        `Motivo: ${reason}`;

      const movementResult = await client.query(
        `
                INSERT INTO public.inventory_movements (
                    product_sku,
                    from_location_id,
                    to_location_id,
                    qty,
                    movement_type,
                    reference_type,
                    reference_id,
                    created_at,
                    created_by,
                    note
                )
                VALUES (
                    $1,
                    $2,
                    $3,
                    $4::numeric,
                    'MOVE',
                    'DISPATCH_VOID',
                    $5,
                    NOW(),
                    $6,
                    $7
                )
                RETURNING id
                `,
        [
          line.sku,
          originalShip.to_location_id,
          locationId,
          line.qty_done,
          String(dispatch.id),
          reversedBy,
          movementNote
        ]
      );

      console.log(
        "✅ MOVIMIENTO INVERSO:",
        movementResult.rows[0].id
      );


      // ================================================
      // CANCELAR STOCK MOVE LINE
      // CONSERVAR qty_done PARA AUDITORÍA
      // ================================================

      await client.query(
        `
                UPDATE public.stock_move_line
                SET
                    state = 'cancel',
                    write_date = NOW()
                WHERE id = $1
                  AND state = 'done'
                `,
        [line.id]
      );

      console.log(
        "✅ STOCK MOVE LINE CANCELADA:",
        line.id
      );


      // ================================================
      // ACUMULAR RESULTADO
      // ================================================

      totalQtyReturned += qty;

      reversedLines.push({
        stock_move_line_id: line.id,
        product_id: line.product_id,
        sku: line.sku,
        qty_returned: qty,
        warehouse_id: warehouseId,
        location_id: locationId,
        original_ship_movement_id:
          originalShip.id,
        reversal_movement_id:
          movementResult.rows[0].id,
        inventory_qty_on_hand:
          inventory.qty_on_hand,
        inventory_qty_available:
          inventory.qty_available
      });

    }


    // ====================================================
    // 12. ACTUALIZAR REGISTRO DE REVERSIÓN
    // ====================================================

    await client.query(
      `
            UPDATE public.admcloud_dispatch_reversals
            SET total_qty_returned = $1
            WHERE id = $2
            `,
      [
        totalQtyReturned,
        reversalId
      ]
    );


    // ====================================================
    // 13. CAMBIAR CONDUCE A REVERTED
    // ====================================================

    const updatedDispatchResult = await client.query(
      `
            UPDATE public.admcloud_dispatches
            SET
                state = 'reverted',
                updated_at = NOW()
            WHERE id = $1
              AND state = 'completed'
            RETURNING
                id,
                picking_id,
                erp_conduce_id,
                erp_doc_id,
                state
            `,
      [dispatch.id]
    );

    if (updatedDispatchResult.rows.length !== 1) {
      throw new ReverseDispatchError(
        409,
        "Error actualizando conduce",
        "No se pudo cambiar el estado del conduce a reverted."
      );
    }


    // ====================================================
    // 14. NO MODIFICAR STOCK_PICKING
    // ====================================================

    console.log(
      "🔒 Estado de stock_picking conservado."
    );


    // ====================================================
    // 15. COMMIT
    // ====================================================

    await client.query("COMMIT");

    transactionStarted = false;

    console.log("");
    console.log("✅ ========================================");
    console.log("✅ CONDUCE REVERTIDO CORRECTAMENTE");
    console.log("✅ ========================================");

    console.log("📄 Conduce:", dispatch.erp_doc_id);
    console.log("📦 Picking:", dispatch.picking_id);
    console.log("📊 Total devuelto:", totalQtyReturned);
    console.log("🧾 Reversal ID:", reversalId);


    // ====================================================
    // 16. RESPONSE
    // ====================================================

    return res.status(200).json({
      success: true,

      title: "Conduce revertido",

      message:
        `El conduce ${dispatch.erp_doc_id} fue revertido correctamente en SIDIAL.`,

      data: {
        dispatch:
          updatedDispatchResult.rows[0],

        reversal_id:
          reversalId,

        erp_status:
          erpVerification.erpStatus,

        lines_reverted:
          reversedLines.length,

        total_qty_returned:
          totalQtyReturned,

        picking_state_modified:
          false,

        lines:
          reversedLines
      }
    });

  } catch (error) {

    // ====================================================
    // ROLLBACK
    // ====================================================

    if (client && transactionStarted) {
      try {
        await client.query("ROLLBACK");

        console.log(
          "🟠 ROLLBACK EJECUTADO"
        );
      } catch (rollbackError) {
        console.error(
          "❌ ERROR EN ROLLBACK:",
          rollbackError
        );
      }
    }

    console.error("");
    console.error(
      "🔥 ERROR REVIRTIENDO CONDUCE:",
      error
    );

    const isControlled =
      error instanceof ReverseDispatchError;

    return res.status(
      isControlled ? error.status : 500
    ).json({
      success: false,

      title:
        isControlled
          ? error.title
          : "Error interno",

      message:
        isControlled
          ? error.message
          : "Ocurrió un error al revertir el conduce. No se confirmó la transacción.",

      code:
        isControlled
          ? error.code
          : "INTERNAL_DISPATCH_REVERSE_ERROR"
    });

  } finally {

    // ====================================================
    // LIBERAR CONEXIÓN
    // ====================================================

    if (client) {
      client.release();
    }

    console.log(
      "🔚 [END] reverseAdmCloudDispatchController"
    );
  }
}
