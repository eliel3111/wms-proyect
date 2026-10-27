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






export async function confirmPickingLine(req, res) {
  let client;

  console.log("\n");
  console.log("🟨🟨🟨 ========================================");
  console.log("📦 INICIANDO confirmPickingLine");
  console.log("🕒 Fecha:", new Date().toISOString());
  console.log("🟨🟨🟨 ========================================");

  try {
    console.log("🔌 Conectando con PostgreSQL...");

    client = await db.connect();

    console.log("✅ Conexión obtenida correctamente");

    const { id, locationId, productId, qty } = req.body;

    console.log("📨 BODY RECIBIDO:");
    console.log({
      id,
      locationId,
      productId,
      qty
    });

    console.log("🔎 TIPOS DE DATOS RECIBIDOS:");
    console.log({
      idType: typeof id,
      locationIdType: typeof locationId,
      productIdType: typeof productId,
      qtyType: typeof qty
    });

    /*
     * VALIDACIÓN DE DATOS REQUERIDOS
     */
    console.log("🛡️ Validando datos requeridos...");

    if (
      id === undefined ||
      id === null ||
      locationId === undefined ||
      locationId === null ||
      productId === undefined ||
      productId === null ||
      qty === undefined ||
      qty === null ||
      qty === ""
    ) {
      console.log("❌ VALIDACIÓN FALLIDA: datos incompletos");

      return res.json({
        success: false,
        title: "Datos incompletos",
        message: "Debe enviar id, locationId, productId y qty"
      });
    }

    console.log("✅ Datos requeridos recibidos");

    /*
     * CONVERTIR CANTIDAD
     */
    const qtyNumber = Number(qty);

    console.log("🔢 Cantidad convertida a número:", qtyNumber);

    if (Number.isNaN(qtyNumber)) {
      console.log("❌ VALIDACIÓN FALLIDA: qty no es un número");

      return res.json({
        success: false,
        title: "Cantidad inválida",
        message: "La cantidad debe ser numérica"
      });
    }

    /*
 * OBTENER CONFIGURACIÓN
 */
    const pickingConfig = await getPickingConfig(client);

    console.log("⚙️ PICKING CONFIG:", pickingConfig);

    /*
     * Guardaremos aquí la ubicación escaneada
     */
    let scannedLocation = null;

    /*
     * SI SE PERMITE PICKING SIN UBICACIÓN FIJA,
     * CONFIRMAR QUE LA UBICACIÓN RECIBIDA EXISTA
     */
    if (pickingConfig.allow_picking_without_locations === true) {

      console.log("🔎 Validando que locationId exista:", locationId);

      const locationResult = await client.query(
        `
    SELECT
      id,
      code,
      warehouse_id
    FROM locations
    WHERE id = $1
    LIMIT 1
    `,
        [locationId]
      );

      if (locationResult.rowCount === 0) {

        console.log("❌ La ubicación no existe:", locationId);

        return res.json({
          success: false,
          title: "Ubicación inválida",
          message: "La ubicación seleccionada no existe"
        });
      }

      scannedLocation = locationResult.rows[0];

      console.log(
        "✅ Ubicación válida:",
        scannedLocation
      );
    }

    /*
     * BUSCAR LA LÍNEA
     */
    console.log("🔎 Buscando línea en stock_move_line...");

    let result;

    if (pickingConfig.allow_picking_without_locations === true) {
      /*
       * No exigimos que location_id coincida,
       * porque el usuario puede recoger desde otra ubicación válida.
       */
      result = await client.query(
        `
        SELECT *
        FROM stock_move_line
        WHERE id = $1
          AND product_id = $2
        `,
        [id, productId]
      );
    } else {
      /*
       * Picking normal:
       * producto y ubicación deben coincidir con la línea.
       */
      result = await client.query(
        `
        SELECT *
        FROM stock_move_line
        WHERE id = $1
          AND product_id = $2
          AND location_id = $3
        `,
        [id, productId, locationId]
      );
    }

    console.log("📊 Resultado de la búsqueda:");
    console.log({
      rowCount: result.rowCount,
      rows: result.rows
    });

    if (result.rows.length === 0) {
      console.log("❌ LÍNEA NO ENCONTRADA");

      return res.json({
        success: false,
        title: "Línea no encontrada",
        message:
          pickingConfig.allow_picking_without_locations === true
            ? "No coincide el producto con la línea"
            : "No coincide el producto o la ubicación"
      });
    }

    const line = result.rows[0];

    console.log("✅ LÍNEA ENCONTRADA:");
    console.log(line);

    /*
     * VALIDAR LA CANTIDAD
     */
    console.log("🛡️ Validando cantidad...");

    const requestedQty = Number(line.product_uom_qty);
    const currentQtyDone = Number(line.qty_done || 0);

    console.log("📦 Comparación de cantidades:");
    console.log({
      qtyReceived: qtyNumber,
      productUomQty: requestedQty,
      currentQtyDone,
      remainingQty: requestedQty - currentQtyDone
    });

    if (qtyNumber < 0) {
      console.log("❌ VALIDACIÓN FALLIDA: cantidad menor a cero");

      return res.json({
        success: false,
        title: "Cantidad inválida",
        message: "Debe ser mayor o igual a 0"
      });
    }

    if (qtyNumber > requestedQty) {
      console.log(
        "❌ VALIDACIÓN FALLIDA: cantidad mayor a la solicitada"
      );

      return res.json({
        success: false,
        title: "Cantidad excedida",
        message: "No puede recoger más de lo solicitado"
      });
    }

    console.log("✅ Cantidad válida");

    /*
     * ACTUALIZAR STOCK_MOVE_LINE
     */
    let updateResult;

    if (pickingConfig.allow_picking_without_locations === true) {
      console.log("📍 Picking sin ubicación fija");
      console.log("✏️ Actualizando qty_done y location_id");


      updateResult = await client.query(
        `
  UPDATE stock_move_line
  SET
    qty_done = $1,
    location_id = $2,
    warehouse_id = $3
  WHERE id = $4
  RETURNING *
  `,
        [
          qtyNumber,
          scannedLocation.id,
          scannedLocation.warehouse_id,
          id
        ]
      );


    } else {
      console.log("📍 Picking con ubicación fija");
      console.log("✏️ Actualizando solamente qty_done");

      updateResult = await client.query(
        `
        UPDATE stock_move_line
        SET
          qty_done = $1
        WHERE id = $2
        RETURNING *
        `,
        [
          qtyNumber,
          id
        ]
      );
    }

    console.log("✅ UPDATE COMPLETADO");

    console.log("📊 Resultado del UPDATE:");
    console.log({
      rowCount: updateResult.rowCount,
      updatedLine: updateResult.rows[0]
    });

    console.log("🟩🟩🟩 ========================================");
    console.log("✅ CONFIRMACIÓN FINALIZADA CORRECTAMENTE");
    console.log("📌 Línea:", id);
    console.log("📌 Cantidad registrada:", qtyNumber);
    console.log("📌 Ubicación usada:", locationId);
    console.log("🟩🟩🟩 ========================================");

    return res.json({
      success: true,
      title: "OK",
      message: "Cantidad registrada",
      line: updateResult.rows[0]
    });

  } catch (error) {
    console.error("🔥🔥🔥 ========================================");
    console.error("❌ ERROR EN confirmPickingLine");
    console.error("🔥🔥🔥 ========================================");

    console.error("📌 Nombre:", error.name);
    console.error("📌 Mensaje:", error.message);
    console.error("📌 Código PostgreSQL:", error.code);
    console.error("📌 Detalle:", error.detail);
    console.error("📌 Constraint:", error.constraint);
    console.error("📌 Tabla:", error.table);
    console.error("📌 Stack:", error.stack);

    return res.status(500).json({
      success: false,
      title: "Error interno",
      message: "Algo salió mal"
    });

  } finally {
    if (client) {
      client.release();
      console.log("🔌 Conexión PostgreSQL liberada");
    }

    console.log("🏁 FIN confirmPickingLine");
    console.log("\n");
  }
}








export async function scanPickingCode(req, res) {
  console.log("🟦🟨🟨🟨🟨 [START] scanPickingCode");


  const client = await db.connect();

  const dbInfo = await client.query(`
  SELECT current_database()
`);

  console.log(
    "🗄️ DATABASE:",
    dbInfo.rows[0].current_database
  );

  try {
    const { code, pickingId } = req.body;

    console.log("📥 INPUT:", req.body);

    // ==============================
    // 1️⃣ VALIDACIÓN
    // ==============================
    if (!code || !pickingId) {
      return res.status(400).json({
        success: false,
        message: "code y pickingId son requeridos",
      });
    }

    const normalized = code.trim().toUpperCase();

    console.log("🔎 Código normalizado:", JSON.stringify(normalized));

    let detectedType = null;
    let detectedData = null;

    // ==============================
    // 2️⃣ VALIDAR UBICACIÓN
    // ==============================
    const locationResult = await getActiveStorageLocationByCode(
      client,
      normalized
    );

    console.log("🟥 location response  db", locationResult.rows[0]);

    if (locationResult.rowCount > 0) {
      detectedType = "location";
      detectedData = locationResult.rows[0];

      console.log("📍 UBICACIÓN DETECTADA:", detectedData);
    }

    // ==============================
    // 3️⃣ VALIDAR PRODUCTO
    // ==============================
    let productId = null;

    if (!detectedType) {
      // ==============================
      // 🔎 BUSCAR PRODUCTO POR BARCODE
      // ==============================
      let productResult = await client.query(
        `
  SELECT p.id, p.sku
  FROM product_barcodes pb
  JOIN products p ON p.sku = pb.product_sku
  WHERE UPPER(pb.barcode) = $1
  LIMIT 1
`,
        [normalized]
      );

      // ==============================
      // 🔎 SI NO EXISTE → BUSCAR SKU
      // ==============================
      if (productResult.rowCount === 0) {

        console.log("⚠️ Barcode no encontrado, buscando SKU...");

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
      if (productResult.rowCount === 0) {
        console.log("❌ Código inválido");

        return res.json({
          success: false,
          code: "INVALID_CODE",
          message: "El código no corresponde a una ubicación ni a un producto",
        });
      }

      detectedType = "product";
      detectedData = productResult.rows[0];
      productId = detectedData.id;

      console.log("📦 PRODUCTO DETECTADO:", detectedData);
    }

    // 🔹 Obtener configuración
    const pickingConfig = await getPickingConfig(client);

    console.log("⚙️ PICKING CONFIG:", pickingConfig);

    // 🔥 PERMITIR CUALQUIER LOCATION EXISTENTE
    // ==============================
    if (
      detectedType === "location" &&
      pickingConfig.allow_picking_without_locations === true
    ) {
      console.log("🔎 Confirmando que location existe:", normalized);

      const locationCheck = await client.query(
        `
    SELECT id, code, warehouse_id, location_type
    FROM locations
    WHERE UPPER(TRIM(code)) = UPPER(TRIM($1))
    LIMIT 1
    `,
        [normalized]
      );

      if (locationCheck.rowCount === 0) {
        console.log("❌ Location no existe:", normalized);

        return res.json({
          success: false,
          code: "LOCATION_NOT_FOUND",
          title: "Ubicación no encontrada",
          message: "La ubicación escaneada no existe"
        });
      }

      const scannedLocation = locationCheck.rows[0];

      console.log(
        "✅ Location existe y se permite sin validar contra picking:",
        scannedLocation
      );

      return res.json({
        success: true,
        type: "location",
        data: {
          id: scannedLocation.id,
          code: scannedLocation.code
        },
        skipPickingValidation: true
      });
    }



    // ==============================
    // 4️⃣ VALIDAR QUE PERTENECE AL PICKING
    // ==============================
    const moveLinesResult = await client.query(
      `
      SELECT product_id, location_id
      FROM stock_move_line
      WHERE picking_id = $1
    `,
      [pickingId]
    );

    if (!moveLinesResult.rows.length) {
      console.log("⚠️ No hay líneas en el picking");

      return res.json({
        success: false,
        message: "El picking no tiene líneas",
      });
    }

    let isValid = false;

    for (const row of moveLinesResult.rows) {
      // 🔹 Validar producto
      if (detectedType === "product" && row.product_id == productId) {
        isValid = true;
        break;
      }

      // 🔹 Validar ubicación
      if (
        detectedType === "location" &&
        row.location_id == detectedData.id
      ) {
        isValid = true;
        break;
      }
    }

    if (!isValid) {
      console.log("❌ No pertenece al picking");

      return res.json({
        success: false,
        code: "NOT_IN_PICKING",
        title: "Código no válido",
        message: "El código escaneado no pertenece a este pedido",
      });
    }

    // ==============================
    // 5️⃣ RESPUESTA FINAL
    // ==============================
    console.log("✅ VALIDACIÓN EXITOSA");

    return res.json({
      success: true,
      type: detectedType,
      data: detectedData,
    });

  } catch (error) {
    console.error("🔥 [ERROR scanPickingCode]:", error);

    return res.status(500).json({
      success: false,
      message: "Error interno",
      error: error.message,
    });

  } finally {
    client.release();
    console.log("🔚 [END] scanPickingCode");
  }
}








//Busca la orden unica y se inicia la logica del picking
export async function getPickingProductsWithLocations(req, res) {
  console.log("🟦 ----[START] Controller----");

  let client;
  let transactionStarted = false;
  let releaseError;

  try {
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
        message: "Debes enviar un pickingId entero positivo válido.",
      });
    }

    client = await db.connect();

    // ==========================================================
    // 1. BUSCAR EL PICKING Y OBTENER sale_id
    // ==========================================================

    const pickingResult = await client.query(
      `
        SELECT id, sale_id
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
        message: `No existe un picking con el ID ${pickingId}.`,
      });
    }

    const saleId = String(
      localPicking.sale_id ?? ""
    ).trim();

    if (!saleId) {
      return res.status(422).json({
        success: false,
        title: "Picking sin pedido de venta",
        message: `El picking ${pickingId} no tiene un valor en sale_id.`,
      });
    }

    const guidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    if (!guidRegex.test(saleId)) {
      return res.status(422).json({
        success: false,
        title: "GUID del pedido inválido",
        message: `El sale_id del picking ${pickingId} no es un GUID válido.`,
      });
    }

    console.log("🔗 Pedido asociado al picking:", {
      pickingId,
      saleId,
    });

    // ==========================================================
    // 2. INICIAR TRANSACCIÓN
    // ==========================================================

    await client.query("BEGIN");
    transactionStarted = true;

    // ==========================================================
// 3. ACTUALIZAR EL PEDIDO DESDE ADM CLOUD
// ==========================================================

/*const syncedOrder =
  await syncAdmCloudSalesOrderByGuidService(
    client,
    saleId,
    pickingId
  );

if (!syncedOrder?.picking?.id) {
  const error = new Error(
    "La sincronización no devolvió un picking válido."
  );

  error.statusCode = 502;
  error.code = "INVALID_SALES_ORDER_SYNC";
  error.title = "Respuesta inválida de ADM Cloud";

  throw error;
}

console.log(
  "✅ Pedido actualizado desde ADM Cloud:",
  {
    pickingId: syncedOrder.picking.id,
    saleId,
    lines: syncedOrder.lines,
  }
);*/

// ==========================================================
// 4. BUSCAR PENDIENTES DE DESPACHO EN ADM CLOUD
// ==========================================================

console.log(
  "🔎 Buscando pendientes de despacho en ADM Cloud:",
  {
    pickingId,
    saleId,
  }
);

const pendingDispatchResult =
  await getPendingDispatchBySalesOrderService(
    saleId,
    {
      /*
       * Se comienza desde la primera página.
       * No enviamos filtros porque queremos todas
       * las líneas pendientes de esta orden.
       */
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
  error.admCloudData =
    pendingDispatchResult ?? null;

  throw error;
}

const pendingDispatchRows =
  pendingDispatchResult.data;

console.log(
  "📦 Pendientes encontrados en ADM Cloud:",
  {
    pickingId,
    saleId,
    rowsReceived:
      pendingDispatchRows.length,
    httpStatus:
      pendingDispatchResult.httpStatus ??
      null,
  }
);

// ==========================================================
// 5. SINCRONIZAR despacho_stock_move
// ==========================================================

const dispatchSyncSummary =
  await syncAdmCloudPendingDispatchMoves(
    client,

    /*
     * Líneas devueltas por PendingDispatchByItem.
     */
    pendingDispatchRows,

    /*
     * stock_picking.id
     */
    pickingId,

    /*
     * stock_picking.sale_id
     *
     * Se guardará en:
     * despacho_stock_move.source_transaction_id
     */
    saleId
  );

console.log(
  "✅ Despacho sincronizado:",
  {
    pickingId,
    saleId,
    rowsReceived:
      pendingDispatchRows.length,
    sync:
      dispatchSyncSummary,
  }
);





    const config =
  await getPickingConfig(client);

console.log(
  "⚙️ CONFIGURACIÓN DEL PICKING:",
  config
);

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
    "🧹 Resultado limpieza GENERAL:",
    generalCleanup
  );
}


    // ==========================================================
    // 4. OBTENER PRODUCTOS Y UBICACIONES: Esto dara como resultado el id del producto, el sku, los moves de ese producto y las ubicaciones con cantidad.
    // ==========================================================

    const result = await getPickingProductsWithLocationsService(
      client,
      pickingId
    );

    if (!result.data || result.data.length === 0) {
      // Conservar la sincronización aunque no haya ubicaciones.
      await client.query("COMMIT");
      transactionStarted = false;

      return res.status(200).json({
        success: false,
        title: "Sin ubicaciones disponibles",
        message:
          result.message ||
          "El producto no tiene cantidad en ninguna ubicación",
        data: [],
      });
    }

    //----------------------------------------------
    //Se agrega a la respuesta de arriba, selected_location que son de todas las ubicaciones las elegidas.

    const enrichedData = result.data.map((product) => ({
      ...product,
      selected_location: selectBestLocation(product),
    }));

    //Cambiame este console para ver esa informacion de una forma estructurada en el console log.
    console.log("enrichedData:", enrichedData);

    
    //La cantidad que los servicios reporten como reservada durante esta ejecución.
    let totalReserved = 0;
    //Si el servicio de líneas existentes reportó cambios, creó cantidad o liberó cantidad.
    let hasPickingChanges = false;
    //Un resumen de lo que ocurrió con cada movimiento.
    const results = [];

    // ==========================================================
    // 5. RESERVAR INVENTARIO
    // ==========================================================

    //Recorre cada producto y sus movimientos
    for (const product of enrichedData) {
      console.log("🟡 Probando producto:", product.product_id);

      const productId = product.product_id;

      //Un producto puede tener varios movimientos: se revisa cada movimiento o stock_move indivialmente.
      for (const stockMove of product.moves) {
        const moveId = stockMove.move_id;
        const requiredQty = Number(stockMove.product_qty || 0);

        console.log("🟦 Procesando stock_move:", {
          moveId,
          productId,
          requiredQty,
        });

        // Consulta cuánto tiene asignado actualmente
// este movimiento de despacho.
//
// No toma líneas done ni cancel porque
// despacho_stock_move.pending_qty ya representa
// la cantidad pendiente actual de ADM Cloud.
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
      AND COALESCE(
        sml.state,
        ''
      ) NOT IN (
        'cancel',
        'done'
      )
  `,
  [
    moveId,
    pickingId,
  ]
);

const totalQty =
  Number(rows[0]?.total_qty || 0);

console.log(
  "📦 Cantidad activa en move_line:",
  totalQty
);

console.log(
  "📦 Cantidad pendiente requerida:",
  requiredQty
);






        // ==========================================================
// La cantidad solicitada y la cantidad activa son iguales.
// También hay que verificar que las ubicaciones coincidan.
// ==========================================================

const quantitiesAreEqual =
  Math.abs(
    totalQty -
    requiredQty
  ) <= 0.000001;

if (quantitiesAreEqual) {
  console.log(
    "✅ El movimiento tiene la cantidad total exacta."
  );

  /*
   * Si GENERAL está permitido, primero se conserva
   * tu lógica actual para mover desde GENERAL hacia
   * ubicaciones físicas.
   */
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
      const redistributedQty =
        Number(
          generalResult.reserved ||
          0
        );

      totalReserved +=
        redistributedQty;

      hasPickingChanges = true;

      results.push({
        move_id:
          moveId,
        product_id:
          productId,
        reserved:
          redistributedQty,
        physical_reserved:
          Number(
            generalResult
              .physical_reserved || 0
          ),
        general_reserved:
          Number(
            generalResult
              .general_reserved || 0
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
      "⏭️ No fue necesario redistribuir GENERAL:",
      generalResult.reason
    );
  }

  /*
   * Aunque la cantidad total sea correcta,
   * comparar las ubicaciones actuales contra
   * el inventario físico sugerido.
   */
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
      move_id:
        moveId,
      product_id:
        productId,
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

  console.log(
    "⏭️ No fue necesario actualizar ubicaciones:",
    physicalResult.reason
  );

  results.push({
    move_id:
      moveId,
    product_id:
      productId,
    reserved: 0,
    changed: false,
    skipped: true,
    case:
      "ORDER_EXACT",
    reason:
      physicalResult.reason,
    message:
      "La cantidad y la distribución por ubicación ya están correctas.",
  });

  continue;
}





        //==========================================================
        // El movimiento tiene líneas existentes.
        if (totalQty > 0) {
          console.log("🟡 Ya existen líneas para este stock_move");

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

          totalReserved += reservedQty;

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
            reserved: reservedQty,
            createdQty,
            released: releasedQty,
            changed: resultExisting?.changed || false,
            case: resultExisting?.case || null,
            skipped: resultExisting?.skipped || false,
            message: resultExisting?.message || "",
          });

          continue;
        }







        //==========================================================
        // El movimiento todavía no tiene líneas.
        console.log("🟢 Reserva inicial del stock_move");

        const reservationResult = await reserveInventoryForMove(
          client,
          {
            ...product,
            moves: [stockMove],
          }
        );

        const reservedQty = Number(
          reservationResult?.reserved || 0
        );







        totalReserved += reservedQty;

        results.push({
          move_id: moveId,
          product_id: productId,
          reserved: reservedQty,
        });
      }
    }

    // ==========================================================
    // 6. OBTENER LÍNEAS FINALES
    // ==========================================================

    const finalResult = await getMoveLinesOrderedByLocation(
      client,
      pickingId
    );



    const noNewReservations =
      !config.allow_picking_without_locations &&
      totalReserved === 0 &&
      !hasPickingChanges;

    // Conservar también la actualización del pedido
    // cuando no se agreguen reservas nuevas.
    await client.query("COMMIT");
    transactionStarted = false;

    console.log("📦 Resultado de reservas:", results);
    console.log("FINAL RESULT:", finalResult);

    return res.status(200).json({
      success: true,
      message: noNewReservations
        ? finalResult.length > 0
          ? "El picking ya tiene líneas asignadas."
          : "Pedido actualizado, pero no se pudo reservar inventario."
        : result.message || "Picking actualizado correctamente.",
      data: finalResult,
    });

  } catch (error) {
    // ==========================================================
    // 7. REVERTIR SI OCURRE UN ERROR
    // ==========================================================

    if (client && transactionStarted) {
      try {
        await client.query("ROLLBACK");
        transactionStarted = false;
      } catch (rollbackError) {
        releaseError = rollbackError;

        console.error(
          "❌ Error realizando ROLLBACK:",
          rollbackError.message
        );
      }
    }

    console.error("🔥 [ERROR Controller]:", error.message);

    const candidateStatus = Number(
      error.statusCode ?? error.response?.status
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
      title: error.title || "Error preparando el picking",
      message:
        error.message ||
        "No se pudo actualizar el pedido y preparar el picking.",
    });

  } finally {
    if (client) {
      client.release(releaseError);
    }

    console.log("🔚 [END Controller]");
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
