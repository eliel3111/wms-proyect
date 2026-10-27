import { getPickingConfig, getOrCreateDefaultLocation } from "../services/pickingBestRoute.js";




//Esta función compara la cantidad solicitada de un movimiento con la cantidad que ya está distribuida en sus líneas de picking. Según la diferencia, intenta agregar cantidad, conservarla o reducirla.
export async function reserveMissingQtyForExistingMoveLines(
  client,
  move,
  stockMove
) {
  if (!stockMove) {
    throw new Error("Debe enviar stockMove");
  }
  console.log("*************************************************************");
  //client - Conexión a PostgreSQL
  //move - Producto con SKU, picking_id y ubicaciones
  //stockMove - Movimiento específico que se está revisando




  //Obtiene los datos del movimiento y del producto
  const moveId = stockMove.move_id;  // "6"
  const pickingId = move.picking_id; // ID del pedido
  const productId = move.product_id; // ID del producto
  const sku = move.sku;              // SKU del producto
  const requestedMove = move.moves.find(
    (item) => String(item.move_id) === String(moveId)
  );

  if (!requestedMove) {
    throw new Error(
      `No se encontró el movimiento ${moveId} en move.moves.`
    );
  }

  const requiredQty = Number(requestedMove.product_qty);

  console.log("🟣 ---- reserveMissingQtyForExistingMoveLines ----");
  console.log("🆔 moveId:", moveId);
  console.log("📦 productId:", productId);
  console.log("🏷️ sku:", sku);
  console.log("📌 requiredQty:", requiredQty);



  const config = await getPickingConfig(client);


  let moveLines =
    await getStockMoveLinesByMoveId(
      client,
      moveId
    );

  let processedLines =
    moveLines.filter(
      (line) =>
        Number(line.qty_done || 0) > 0
    );

  let openReservedLines =
    moveLines.filter(
      (line) =>
        Number(line.qty_done || 0) === 0
    );

  console.log(
    "🟨🟨🟨 LÍNEAS CON CANTIDAD PICKEADA:",
    processedLines
  );

  let processedAdjustment = {
    changed: false,
  };

  /*
   * Esta lógica continúa ejecutándose solamente
   * cuando se permite recoger desde GENERAL.
   */
  if (
    config.allow_picking_without_locations
  ) {
    processedAdjustment =
      await adjustProcessedMoveLinesByAvailability(
        client,
        {
          move,
          stockMove,
          processedLines,
        }
      );

    /*
     * La función anterior puede modificar líneas.
     * Se vuelven a consultar para trabajar con
     * los valores reales guardados en PostgreSQL.
     */
    moveLines =
      await getStockMoveLinesByMoveId(
        client,
        moveId
      );

    processedLines =
      moveLines.filter(
        (line) =>
          Number(line.qty_done || 0) > 0
      );

    openReservedLines =
      moveLines.filter(
        (line) =>
          Number(line.qty_done || 0) === 0
      );
  }

  /*
   * Cantidad realmente leída por el picker.
   *
   * Ejemplo:
   * product_uom_qty = 4
   * qty_done = 3
   *
   * processedQty será 3.
   */
  const processedQty =
    sumQty(
      processedLines,
      "qty_done"
    );

  /*
   * Cantidad total asignada en las líneas
   * que tienen alguna lectura.
   *
   * En el ejemplo anterior será 4.
   */
  const processedAssignedQty =
    sumQty(
      processedLines,
      "product_uom_qty"
    );

  /*
   * Cantidad asignada en líneas que todavía
   * no tienen ninguna lectura.
   */
  const openReservedQty =
    sumQty(
      openReservedLines,
      "product_uom_qty"
    );

  /*
   * La cobertura se calcula con toda la cantidad
   * asignada, no solamente con qty_done.
   */
  const coveredQty =
    processedAssignedQty +
    openReservedQty;

  const diffQty =
    requiredQty -
    coveredQty;

  console.log(
    "🧮 RESUMEN DE RESERVA:",
    {
      requiredQty,

      // Cantidad realmente escaneada.
      processedQty,

      // Cantidad asignada en líneas con lectura.
      processedAssignedQty,

      // Cantidad asignada en líneas sin lectura.
      openReservedQty,

      coveredQty,
      diffQty,

      processedLinesChanged:
        processedAdjustment.changed,

      allow_picking_without_locations:
        config.allow_picking_without_locations,
    }
  );

  // 🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩
  // CASO 1: LA ORDEN AUMENTÓ
  // =====================================================
  if (diffQty > 0) {
    console.log("🟢 CASO 1: La orden aumentó");
    console.log("🟢 Cantidad adicional a agregar en stock_move_line:", diffQty);

    if (config.allow_picking_without_locations) {
      const result = await increaseExistingMoveLineWithoutLocations(client, {
        move,
        stockMove,
        moveLines,
        openReservedLines,
        diffQty,
      });

      await updateDispatchMoveState(
        client,
        moveId
      );

      return {
        ...result,
        case: "ORDER_INCREASED",
      };
    }

    // =====================================================
    // NUEVA LÓGICA:
    // Buscar disponibilidad real por moveId
    // =====================================================
    const availableResult = await availableLocationsForMoveId(
      client,
      moveId,
      moveLines
    );

    console.log("📍 REAL AVAILABLE LINES:", availableResult.lines);
    console.log("📍 Total real disponible:", availableResult.totalPotentialQty);

    if (availableResult.lines.length === 0) {
      await updateDispatchMoveState(
        client,
        moveId
      );

      return {
        reserved: 0,
        createdQty: 0,
        skipped: true,
        case: "ORDER_INCREASED_NO_STOCK",
        missingQty: diffQty,
        message:
          "La orden aumentó, pero no hay inventario disponible para reservar la diferencia.",
      };
    }

    // =====================================================
    // Elegir una ubicación si puede cubrir todo.
    // Si no, acumular varias.
    // =====================================================
    const potentialResult = buildLinesToAddFromRealAvailableLines(
      availableResult.lines,
      diffQty
    );

    console.log("📍 POTENCIALES PARA AGREGAR:", potentialResult.lines);
    console.log("📍 Cantidad seleccionada:", potentialResult.totalSelectedQty);
    console.log("📍 Faltante:", potentialResult.remainingQty);

    if (potentialResult.lines.length === 0) {
      await updateDispatchMoveState(
        client,
        moveId
      );

      return {
        reserved: 0,
        createdQty: 0,
        skipped: true,
        case: "ORDER_INCREASED_NO_STOCK",
        missingQty: diffQty,
        message:
          "La orden aumentó, pero no hay inventario disponible para reservar la diferencia.",
      };
    }

    // =====================================================
    // Crear o aumentar stock_move_line
    // SIN tocar inventory_by_location.qty_reserved
    // =====================================================

    const addedQty = await createOrIncreaseMoveLinesWithoutInventoryReservation(
      client,
      {
        move,
        stockMove,
        potentialLines: potentialResult.lines,
        openReservedLines,
      }
    );

    const finalCoveredQty = coveredQty + addedQty;

    await updateDispatchMoveState(
      client,
      moveId
    );

    return {
      reserved: 0,
      createdQty: addedQty,
      skipped: false,
      case:
        potentialResult.remainingQty > 0
          ? "ORDER_INCREASED_PARTIAL"
          : "ORDER_INCREASED",
      missingQty: potentialResult.remainingQty,
      message:
        potentialResult.remainingQty > 0
          ? "La orden aumentó. Se agregaron líneas parciales sin tocar qty_reserved."
          : "La orden aumentó. Se agregaron líneas adicionales sin tocar qty_reserved.",
    };
  }

  console.log("*************************************************************");
  // 🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩

  // =====================================================
  // CASO 2: LA ORDEN QUEDÓ IGUAL
  // =====================================================
  if (diffQty === 0) {
    console.log("✅ CASO 2: La orden está exacta. No falta ni sobra reserva.");

    await updateDispatchMoveState(
      client,
      moveId
    );

    return {
      reserved: 0,
      skipped: true,
      case: "ORDER_EXACT",
      message: "El move ya está cubierto exactamente. No se hace ningún cambio.",
    };
  }

  // =====================================================
  // CASO 3: LA ORDEN BAJÓ
  // =====================================================
  // =====================================================
  // CASO 3: LA ORDEN BAJÓ
  // =====================================================
  if (diffQty < 0) {
    const EPSILON = 0.000001;

    const qtyToRelease =
      Math.abs(diffQty);

    console.log(
      "🟠 CASO 3: La orden bajó"
    );

    console.log(
      "🟠 Cantidad total a liberar:",
      qtyToRelease
    );

    console.log(
      "📦 Cantidad requerida:",
      requiredQty
    );

    console.log(
      "📟 Cantidad realmente leída:",
      processedQty
    );

    console.log(
      "📦 Cantidad asignada en líneas procesadas:",
      processedAssignedQty
    );

    console.log(
      "📦 Líneas abiertas:",
      openReservedLines
    );

    /*
     * ===================================================
     * CASO 3-A
     *
     * Las líneas con qty_done/product_uom_qty ya superan
     * por sí solas la nueva cantidad requerida.
     *
     * Ejemplo:
     * product_uom_qty = 4
     * qty_done = 3
     * requiredQty = 2
     *
     * Resultado:
     * product_uom_qty = 2
     * qty_done = 2
     * ===================================================
     */
    if (
      processedAssignedQty >
      requiredQty + EPSILON
    ) {
      let remainingToReduce =
        processedAssignedQty -
        requiredQty;

      let processedReleasedQty = 0;
      let pickedQtyReduced = 0;

      /*
       * El usuario indicó reducir de ID menor
       * a ID mayor.
       */
      const sortedProcessedLines = [
        ...processedLines,
      ].sort((a, b) => {
        const idA = BigInt(a.id);
        const idB = BigInt(b.id);

        if (idA < idB) return -1;
        if (idA > idB) return 1;

        return 0;
      });

      console.log(
        "🟠 Líneas procesadas que pueden reducirse:",
        sortedProcessedLines
      );

      for (
        const line of
        sortedProcessedLines
      ) {
        if (
          remainingToReduce <=
          EPSILON
        ) {
          break;
        }

        const currentAssignedQty =
          Number(
            line.product_uom_qty || 0
          );

        const currentDoneQty =
          Number(
            line.qty_done || 0
          );

        if (
          !Number.isFinite(
            currentAssignedQty
          ) ||
          !Number.isFinite(
            currentDoneQty
          )
        ) {
          throw new Error(
            `La línea ${line.id} tiene cantidades inválidas.`
          );
        }

        const reductionForThisLine =
          Math.min(
            currentAssignedQty,
            remainingToReduce
          );

        const newAssignedQty =
          Math.max(
            currentAssignedQty -
            reductionForThisLine,
            0
          );

        /*
         * qty_done nunca puede ser mayor que
         * product_uom_qty.
         */
        const newDoneQty =
          Math.min(
            currentDoneQty,
            newAssignedQty
          );

        const doneReduction =
          currentDoneQty -
          newDoneQty;

        /*
         * Si la línea completa debe desaparecer
         * de la operación activa, se cancela.
         *
         * Se pone qty_done en cero porque la lectura
         * todavía es temporal.
         */
        if (
          newAssignedQty <= EPSILON
        ) {
          const cancelledResult =
            await client.query(
              `
              UPDATE stock_move_line
              SET
                qty_done = 0,
                state = 'cancel',
                write_date = NOW()
              WHERE id = $1
                AND move_id = $2
                AND COALESCE(
                  state,
                  ''
                ) NOT IN (
                  'cancel',
                  'done'
                )
              RETURNING
                id,
                move_id,
                product_uom_qty,
                qty_done,
                state
            `,
              [
                line.id,
                moveId,
              ]
            );

          if (
            cancelledResult.rowCount !==
            1
          ) {
            throw new Error(
              `No se pudo cancelar la línea procesada ${line.id}.`
            );
          }

          console.log(
            "🚫 Línea procesada cancelada:",
            cancelledResult.rows[0]
          );
        } else {
          const updatedResult =
            await client.query(
              `
              UPDATE stock_move_line
              SET
                product_uom_qty = $1,
                qty_done = $2,
                write_date = NOW()
              WHERE id = $3
                AND move_id = $4
                AND COALESCE(
                  state,
                  ''
                ) NOT IN (
                  'cancel',
                  'done'
                )
              RETURNING
                id,
                move_id,
                product_uom_qty,
                qty_done,
                state
            `,
              [
                newAssignedQty,
                newDoneQty,
                line.id,
                moveId,
              ]
            );

          if (
            updatedResult.rowCount !==
            1
          ) {
            throw new Error(
              `No se pudo reducir la línea procesada ${line.id}.`
            );
          }

          console.log(
            "✂️ Línea procesada reducida:",
            {
              before: {
                id: line.id,
                product_uom_qty:
                  currentAssignedQty,
                qty_done:
                  currentDoneQty,
              },
              after:
                updatedResult.rows[0],
            }
          );
        }

        remainingToReduce -=
          reductionForThisLine;

        processedReleasedQty +=
          reductionForThisLine;

        pickedQtyReduced +=
          doneReduction;
      }

      if (
        remainingToReduce > EPSILON
      ) {
        throw new Error(
          `No fue posible reducir ${remainingToReduce} unidades del movimiento ${moveId}.`
        );
      }

      /*
       * Si las líneas procesadas ya ocupan toda
       * la nueva cantidad requerida, ninguna línea
       * abierta puede permanecer activa.
       */
      let openReleasedQty = 0;

      for (
        const line of
        openReservedLines
      ) {
        const lineQty =
          Number(
            line.product_uom_qty || 0
          );

        const cancelledResult =
          await client.query(
            `
            UPDATE stock_move_line
            SET
              state = 'cancel',
              write_date = NOW()
            WHERE id = $1
              AND move_id = $2
              AND COALESCE(
                state,
                ''
              ) NOT IN (
                'cancel',
                'done'
              )
            RETURNING
              id,
              move_id,
              product_uom_qty,
              qty_done,
              state
          `,
            [
              line.id,
              moveId,
            ]
          );

        if (
          cancelledResult.rowCount !==
          1
        ) {
          throw new Error(
            `No se pudo cancelar la línea abierta ${line.id}.`
          );
        }

        openReleasedQty +=
          lineQty;

        console.log(
          "🚫 Línea abierta cancelada:",
          cancelledResult.rows[0]
        );
      }

      await updateDispatchMoveState(
        client,
        moveId
      );

      const verifyResult =
        await client.query(
          `
          SELECT
            id,
            product_uom_qty,
            qty_done,
            state
          FROM stock_move_line
          WHERE move_id = $1
          ORDER BY id ASC
        `,
          [moveId]
        );

      console.log(
        "✅ LÍNEAS DESPUÉS DE REDUCIR:",
        verifyResult.rows
      );

      return {
        reserved: 0,
        createdQty: 0,

        released:
          processedReleasedQty +
          openReleasedQty,

        pickedQtyReduced,

        changed: true,
        skipped: false,
        case:
          "ORDER_DECREASED_PROCESSED_LINES",

        message:
          pickedQtyReduced > 0
            ? "La orden bajó. Se ajustaron la cantidad asignada y la cantidad temporalmente recogida."
            : "La orden bajó. Se redujo la cantidad asignada.",
      };
    }

    /*
     * ===================================================
     * CASO 3-B
     *
     * Lo procesado no supera la cantidad requerida.
     * Se conserva y solamente se reorganizan/reducen
     * las líneas abiertas, manteniendo tu lógica actual.
     * ===================================================
     */

    const requiredForOpenLines =
      Math.max(
        requiredQty -
        processedAssignedQty,
        0
      );

    console.log(
      "📦 Cantidad que deben conservar las líneas abiertas:",
      requiredForOpenLines
    );

    const sortedLines = [
      ...openReservedLines,
    ].sort(
      (a, b) =>
        Number(
          b.product_uom_qty
        ) -
        Number(
          a.product_uom_qty
        )
    );

    const selectedLines = [];

    /*
     * Si no queda cantidad para líneas abiertas,
     * no se selecciona ninguna. Todas se cancelarán.
     */
    if (
      requiredForOpenLines >
      EPSILON
    ) {
      const singleLine =
        sortedLines.find(
          (line) =>
            Number(
              line.product_uom_qty
            ) >=
            requiredForOpenLines
        );

      if (singleLine) {
        selectedLines.push({
          id:
            singleLine.id,

          qty:
            requiredForOpenLines,
        });
      } else {
        let accumulated = 0;

        for (
          const line of sortedLines
        ) {
          if (
            accumulated >=
            requiredForOpenLines -
            EPSILON
          ) {
            break;
          }

          const available =
            Number(
              line.product_uom_qty ||
              0
            );

          const qtyForThisLine =
            Math.min(
              available,
              requiredForOpenLines -
              accumulated
            );

          if (
            qtyForThisLine <=
            EPSILON
          ) {
            continue;
          }

          selectedLines.push({
            id:
              line.id,

            qty:
              qtyForThisLine,
          });

          accumulated +=
            qtyForThisLine;
        }
      }
    }

    console.log(
      "✅ LÍNEAS ABIERTAS SELECCIONADAS:",
      selectedLines
    );

    /*
     * Actualizar las líneas abiertas que se conservarán.
     */
    for (
      const selected of
      selectedLines
    ) {
      const result =
        await client.query(
          `
          UPDATE stock_move_line
          SET
            product_uom_qty = $1,
            write_date = NOW()
          WHERE id = $2
            AND move_id = $3
            AND COALESCE(
              qty_done,
              0
            ) = 0
            AND COALESCE(
              state,
              ''
            ) NOT IN (
              'cancel',
              'done'
            )
          RETURNING
            id,
            move_id,
            product_uom_qty,
            qty_done,
            state
        `,
          [
            selected.qty,
            selected.id,
            moveId,
          ]
        );

      if (
        result.rowCount !== 1
      ) {
        throw new Error(
          `No se pudo actualizar la línea abierta ${selected.id}.`
        );
      }

      console.log(
        "✂️ Línea abierta ajustada:",
        result.rows[0]
      );
    }

    /*
     * Cancelar las líneas abiertas no seleccionadas.
     */
    const selectedIds =
      new Set(
        selectedLines.map(
          (line) =>
            String(line.id)
        )
      );

    const linesToCancel =
      openReservedLines.filter(
        (line) =>
          !selectedIds.has(
            String(line.id)
          )
      );

    console.log(
      "🚫 LÍNEAS ABIERTAS A CANCELAR:",
      linesToCancel
    );

    for (
      const line of
      linesToCancel
    ) {
      const cancelledResult =
        await client.query(
          `
          UPDATE stock_move_line
          SET
            state = 'cancel',
            write_date = NOW()
          WHERE id = $1
            AND move_id = $2
            AND COALESCE(
              qty_done,
              0
            ) = 0
            AND COALESCE(
              state,
              ''
            ) NOT IN (
              'cancel',
              'done'
            )
          RETURNING
            id,
            move_id,
            product_uom_qty,
            qty_done,
            state
        `,
          [
            line.id,
            moveId,
          ]
        );

      if (
        cancelledResult.rowCount !==
        1
      ) {
        throw new Error(
          `No se pudo cancelar la línea abierta ${line.id}.`
        );
      }

      console.log(
        "🚫 Línea abierta cancelada:",
        cancelledResult.rows[0]
      );
    }

    await updateDispatchMoveState(
      client,
      moveId
    );

    const verifyResult =
      await client.query(
        `
        SELECT
          id,
          product_uom_qty,
          qty_done,
          state
        FROM stock_move_line
        WHERE move_id = $1
        ORDER BY id ASC
      `,
        [moveId]
      );

    console.log(
      "✅ LÍNEAS DESPUÉS DE REDUCIR:",
      verifyResult.rows
    );

    return {
      reserved: 0,
      createdQty: 0,
      released:
        qtyToRelease,
      pickedQtyReduced: 0,
      changed: true,
      skipped: false,
      case:
        "ORDER_DECREASED",
      message:
        "La orden bajó. Se liberó la reserva sobrante.",
    };
  }
}


// Ejecutar dentro de la transacción del controller.
// No modifica inventory_by_location.qty_reserved.
//
// stockMove.move_id contiene despacho_stock_move.id.
// Se mantiene stockMove como nombre del parámetro para
// no romper los llamados existentes.
export async function adjustProcessedMoveLinesByAvailability(
  client,
  {
    move,
    stockMove: dispatchMove,
    processedLines,
  }
) {
  const moveId =
    dispatchMove?.move_id;

  if (!moveId) {
    throw new Error(
      "Debe enviar el ID de despacho_stock_move."
    );
  }

  if (!move?.sku) {
    throw new Error(
      "Debe enviar move.sku."
    );
  }

  // La cantidad solicitada corresponde a pending_qty,
  // enviada dentro de move.moves como product_qty.
  const requestedMove =
    move.moves?.find(
      (item) =>
        String(item.move_id) ===
        String(moveId)
    );

  if (!requestedMove) {
    throw new Error(
      `No se encontró el movimiento de despacho ${moveId} en move.moves.`
    );
  }

  const requiredQty =
    Number(requestedMove.product_qty);

  if (
    !Number.isFinite(requiredQty) ||
    requiredQty < 0
  ) {
    throw new Error(
      "La cantidad pendiente es inválida."
    );
  }

  const lines = (
    Array.isArray(processedLines)
      ? processedLines
      : []
  )
    .filter(
      (line) =>
        String(line.move_id) ===
        String(moveId) &&
        !["cancel", "done"].includes(
          String(line.state || "")
        ) &&
        Number(line.qty_done || 0) > 0
    )
    .sort((a, b) =>
      BigInt(a.id) < BigInt(b.id)
        ? -1
        : BigInt(a.id) > BigInt(b.id)
          ? 1
          : 0
    );

  const qtyDoneTotal =
    lines.reduce(
      (sum, line) =>
        sum +
        Number(line.qty_done || 0),
      0
    );

  if (qtyDoneTotal > requiredQty) {
    throw new Error(
      `El movimiento de despacho ${moveId} tiene ` +
      `${qtyDoneTotal} unidades recogidas, pero ` +
      `ADM Cloud indica ${requiredQty} pendientes.`
    );
  }

  let remainingPending =
    requiredQty - qtyDoneTotal;

  let processedQty = 0;
  let changed = false;

  // Evita consultar y contar dos veces la disponibilidad
  // de una misma ubicación.
  const stockByLocation =
    new Map();

  for (const line of lines) {
    if (
      String(line.picking_id) !==
      String(move.picking_id) ||
      String(line.product_id) !==
      String(move.product_id)
    ) {
      throw new Error(
        `La línea ${line.id} no corresponde al picking o producto esperado.`
      );
    }

    const locationId =
      line.location_id;

    const warehouseId =
      line.warehouse_id;

    const locationKey =
      `${warehouseId}:${locationId}`;

    if (
      !stockByLocation.has(
        locationKey
      )
    ) {
      const { rows } =
        await client.query(
          `
            SELECT qty_available
            FROM inventory_by_location
            WHERE product_sku = $1
              AND location_id = $2
              AND warehouse_id = $3
            FOR UPDATE
          `,
          [
            move.sku,
            locationId,
            warehouseId,
          ]
        );

      if (rows.length > 1) {
        throw new Error(
          "Inventario duplicado para SKU, ubicación y almacén."
        );
      }

      const available =
        rows.length > 0
          ? Number(
            rows[0].qty_available
          )
          : 0;

      if (
        !Number.isFinite(available)
      ) {
        throw new Error(
          `Cantidad disponible inválida en la ubicación ${locationId}.`
        );
      }

      stockByLocation.set(
        locationKey,
        Math.max(available, 0)
      );
    }

    const qtyDone =
      Number(line.qty_done || 0);

    const available =
      stockByLocation.get(
        locationKey
      );

    const pendingQty =
      Math.min(
        available,
        remainingPending
      );

    const finalQty =
      qtyDone + pendingQty;

    if (
      Number(
        line.product_uom_qty || 0
      ) !== finalQty
    ) {
      const updated =
        await client.query(
          `
            UPDATE stock_move_line
            SET
              product_uom_qty = $1,
              write_date = NOW()
            WHERE id = $2
              AND move_id = $3
              AND picking_id = $4
              AND product_id = $5
              AND COALESCE(state, '')
                    NOT IN ('cancel', 'done')
              AND qty_done = $6
              AND product_uom_qty = $7
            RETURNING id
          `,
          [
            finalQty,
            line.id,
            moveId,
            move.picking_id,
            move.product_id,
            qtyDone,
            line.product_uom_qty,
          ]
        );

      if (
        updated.rows.length !== 1
      ) {
        throw new Error(
          `La línea ${line.id} cambió mientras se ajustaba.`
        );
      }

      line.product_uom_qty =
        finalQty;

      changed = true;
    }

    stockByLocation.set(
      locationKey,
      Math.max(
        available - pendingQty,
        0
      )
    );

    remainingPending -=
      pendingQty;

    processedQty +=
      finalQty;

    console.log(
      "📍 Línea de despacho ajustada:",
      {
        dispatchMoveId:
          moveId,
        lineId:
          line.id,
        locationId,
        warehouseId,
        qtyDone,
        available,
        pendingQty,
        finalQty,
      }
    );
  }

  console.log(
    "📦 Cantidad final asignada en líneas tocadas:",
    processedQty
  );

  return {
    processedQty,
    qtyDoneTotal,
    missingQty:
      Math.max(
        requiredQty -
        processedQty,
        0
      ),
    changed,
  };
}



// ==========================================================
// 🟩🟩 CASO 1:
// BUSCAR UBICACIONES REALES DISPONIBLES PARA UN
// MOVIMIENTO DE despacho_stock_move
// ==========================================================

export async function availableLocationsForMoveId(
  client,
  moveId,
  existingMoveLines = []
) {
  if (!moveId) {
    throw new Error(
      "Debe enviar moveId para buscar ubicaciones disponibles."
    );
  }

  console.log(
    "🔎 Buscando ubicaciones disponibles para despacho moveId:",
    moveId
  );

  // ========================================================
  // 1. BUSCAR MOVIMIENTO EN despacho_stock_move
  // ========================================================

  const moveResult = await client.query(
    `
    SELECT
      dsm.id AS move_id,
      dsm.product_id,

      COALESCE(
        dsm.pending_qty,
        GREATEST(
          COALESCE(dsm.product_qty, 0) -
          COALESCE(dsm.quantity_done, 0),
          0
        )
      ) AS product_qty,

      dsm.product_uom_id,
      dsm.picking_id,
      dsm.state,
      dsm.erp_product_id,

      COALESCE(
        NULLIF(dsm.sku, ''),
        p.sku
      ) AS sku

    FROM despacho_stock_move AS dsm

    JOIN products AS p
      ON p.id = dsm.product_id

    WHERE dsm.id = $1

    LIMIT 1

    FOR UPDATE OF dsm
  `,
    [moveId]
  );

  if (moveResult.rows.length === 0) {
    throw new Error(
      `No se encontró despacho_stock_move con id ${moveId}.`
    );
  }

  const dispatchMove =
    moveResult.rows[0];

  const moveState =
    String(
      dispatchMove.state || ""
    ).toLowerCase();

  if (
    moveState === "cancel" ||
    moveState === "done"
  ) {
    throw new Error(
      `El despacho_stock_move ${moveId} está en estado ${dispatchMove.state}.`
    );
  }

  if (!dispatchMove.sku) {
    throw new Error(
      `El producto ${dispatchMove.product_id} no tiene SKU asociado.`
    );
  }

  console.log(
    "📦 Producto del movimiento de despacho:",
    {
      moveId:
        dispatchMove.move_id,
      pickingId:
        dispatchMove.picking_id,
      productId:
        dispatchMove.product_id,
      sku:
        dispatchMove.sku,
      pendingQty:
        Number(
          dispatchMove.product_qty || 0
        ),
    }
  );

  // ========================================================
  // 2. BUSCAR INVENTARIO EN UBICACIONES FÍSICAS
  // ========================================================

  const inventoryResult =
    await client.query(
      `
        SELECT
          ibl.location_id,
          ibl.warehouse_id,
          ibl.qty_on_hand,
          ibl.qty_reserved,
          ibl.qty_available,

          l.code AS location_code,
          l.location_type,
          l.tramo,
          l.nivel

        FROM inventory_by_location AS ibl

        JOIN locations AS l
          ON l.id = ibl.location_id
         AND l.warehouse_id =
             ibl.warehouse_id

        WHERE ibl.product_sku = $1

          -- No utilizar ubicaciones de despacho.
          AND l.location_type
              IS DISTINCT FROM 'SHIPPING'

          -- GENERAL no es inventario físico.
          -- Se utiliza por separado solamente cuando
          -- allow_picking_without_locations=true.
          AND UPPER(
            COALESCE(
              l.code,
              ''
            )
          ) NOT LIKE 'GENERAL-%'

          AND l.is_active = true

          AND COALESCE(
            ibl.qty_available,
            0
          ) > 0

        ORDER BY
          COALESCE(l.tramo, 0) DESC,
          COALESCE(l.nivel, 0) ASC,
          ibl.location_id ASC
      `,
      [dispatchMove.sku]
    );

  const inventoryLines =
    inventoryResult.rows;

  console.log(
    "📍 Inventario físico encontrado:",
    inventoryLines
  );

  if (inventoryLines.length === 0) {
    return {
      move:
        dispatchMove,
      lines: [],
      totalPotentialQty: 0,
    };
  }

  // ========================================================
  // 3. CALCULAR CUÁNTO YA CONSUME ESTE MOVIMIENTO
  //    POR UBICACIÓN
  //
  //    Se ignoran las líneas done y cancel porque
  //    despacho_stock_move.pending_qty ya representa
  //    la cantidad actualmente pendiente.
  // ========================================================

  const usedByLocation =
    new Map();

  for (
    const line of
    existingMoveLines
  ) {
    const lineState =
      String(
        line.state || ""
      ).toLowerCase();

    if (
      lineState === "cancel" ||
      lineState === "done"
    ) {
      continue;
    }

    if (
      !line.location_id ||
      !line.warehouse_id
    ) {
      continue;
    }

    const locationId =
      Number(
        line.location_id
      );

    const warehouseId =
      Number(
        line.warehouse_id
      );

    if (
      !Number.isFinite(locationId) ||
      !Number.isFinite(warehouseId)
    ) {
      continue;
    }

    const qtyDone =
      Number(
        line.qty_done || 0
      );

    const productUomQty =
      Number(
        line.product_uom_qty || 0
      );

    /*
 * product_uom_qty es la cantidad total asignada
 * a la ubicación.
 *
 * qty_done es la parte escaneada dentro de esa
 * cantidad, no una cantidad adicional.
 *
 * Math.max también protege datos inconsistentes
 * donde qty_done sea mayor que product_uom_qty.
 */
    const usedQty = Math.max(
      productUomQty,
      qtyDone
    );

    if (
      !Number.isFinite(usedQty) ||
      usedQty <= 0
    ) {
      continue;
    }

    /*
     * Se utiliza almacén + ubicación para evitar
     * mezclar ubicaciones de almacenes diferentes.
     */
    const locationKey =
      `${warehouseId}:${locationId}`;

    const previous =
      Number(
        usedByLocation.get(
          locationKey
        ) || 0
      );

    usedByLocation.set(
      locationKey,
      previous + usedQty
    );
  }

  console.log(
    "🧮 Cantidad activa ya utilizada por ubicación:",
    Object.fromEntries(
      usedByLocation
    )
  );

  // ========================================================
  // 4. RESTAR LO YA UTILIZADO DE LA DISPONIBILIDAD
  // ========================================================

  const realAvailableLines =
    inventoryLines
      .map((line) => {
        const locationId =
          Number(
            line.location_id
          );

        const warehouseId =
          Number(
            line.warehouse_id
          );

        const inventoryQty =
          Number(
            line.qty_available || 0
          );

        const locationKey =
          `${warehouseId}:${locationId}`;

        const alreadyUsedInMove =
          Number(
            usedByLocation.get(
              locationKey
            ) || 0
          );

        const realAvailableQty =
          Math.max(
            inventoryQty -
            alreadyUsedInMove,
            0
          );

        return {
          location_id:
            locationId,

          warehouse_id:
            warehouseId,

          /*
           * Se conserva almacen porque otras funciones
           * del picking utilizan este nombre.
           */
          almacen:
            warehouseId,

          location_code:
            line.location_code,

          location_type:
            line.location_type,

          tramo:
            line.tramo,

          nivel:
            line.nivel,

          quantity:
            realAvailableQty,

          inventory_qty_available:
            inventoryQty,

          already_used_in_move:
            alreadyUsedInMove,
        };
      })
      .filter(
        (line) =>
          Number(line.quantity) > 0
      );

  const totalPotentialQty =
    realAvailableLines.reduce(
      (
        total,
        line
      ) =>
        total +
        Number(
          line.quantity || 0
        ),
      0
    );

  console.log(
    "✅ Ubicaciones realmente disponibles:",
    realAvailableLines
  );

  console.log(
    "✅ Total real disponible:",
    totalPotentialQty
  );

  return {
    move:
      dispatchMove,
    lines:
      realAvailableLines,
    totalPotentialQty,
  };
}



//🟩🟩 CASO 1: 2. Servicio para elegir líneas hasta cubrir diffQty
export function buildLinesToAddFromRealAvailableLines(
  realAvailableLines,
  diffQty
) {
  const requiredToAdd = Number(diffQty || 0);

  if (requiredToAdd <= 0) {
    return {
      lines: [],
      totalSelectedQty: 0,
      remainingQty: 0,
    };
  }

  const cleanLines = (realAvailableLines || [])
    .map(line => ({
      ...line,
      quantity: Number(line.quantity || 0),
    }))
    .filter(line => line.quantity > 0);

  if (cleanLines.length === 0) {
    return {
      lines: [],
      totalSelectedQty: 0,
      remainingQty: requiredToAdd,
    };
  }

  // =====================================================
  // 1. Intentar cubrir todo con una sola ubicación
  // =====================================================
  const singleLine = cleanLines.find(
    line => Number(line.quantity) >= requiredToAdd
  );

  if (singleLine) {
    return {
      lines: [
        {
          location_id: Number(singleLine.location_id),
          warehouse_id: Number(singleLine.warehouse_id || 1),
          quantity: requiredToAdd,
        },
      ],
      totalSelectedQty: requiredToAdd,
      remainingQty: 0,
    };
  }

  // =====================================================
  // 2. Si ninguna sola cubre, acumular varias
  // =====================================================
  const selectedLines = [];
  let accumulated = 0;

  for (const line of cleanLines) {
    if (accumulated >= requiredToAdd) break;

    const available = Number(line.quantity || 0);
    const qtyToTake = Math.min(available, requiredToAdd - accumulated);

    if (qtyToTake <= 0) continue;

    selectedLines.push({
      location_id: Number(line.location_id),
      warehouse_id: Number(line.warehouse_id || 1),
      quantity: qtyToTake,
    });

    accumulated += qtyToTake;
  }

  return {
    lines: selectedLines,
    totalSelectedQty: accumulated,
    remainingQty: requiredToAdd - accumulated,
  };
}

//🟩🟩 CASO 1: 3. Servicio para crear o aumentar stock_move_line
export async function createOrIncreaseMoveLinesWithoutInventoryReservation(
  client,
  {
    move,
    stockMove,
    potentialLines,
    openReservedLines,
  }
) {
  let totalAdded = 0;

  for (const line of potentialLines) {
    const qtyToAdd = Number(line.quantity || 0);

    if (qtyToAdd <= 0) continue;

    const locationId = Number(line.location_id);
    const warehouseId = Number(line.warehouse_id || line.almacen || 1);

    // Buscar si ya existe una línea abierta para esa ubicación
    const existingLine = openReservedLines.find(existing =>
      Number(existing.location_id) === locationId &&
      Number(existing.qty_done || 0) === 0 &&
      existing.state !== "cancel"
    );

    if (existingLine) {
      const result = await client.query(
        `
        UPDATE stock_move_line
        SET product_uom_qty = COALESCE(product_uom_qty, 0) + $1
        WHERE id = $2
        RETURNING id, location_id, product_uom_qty
        `,
        [
          qtyToAdd,
          existingLine.id,
        ]
      );

      console.log("🟢 stock_move_line aumentada SIN tocar inventory_by_location:", {
        id: result.rows[0]?.id,
        location_id: result.rows[0]?.location_id,
        nueva_cantidad: result.rows[0]?.product_uom_qty,
        qty_agregada: qtyToAdd,
      });
    } else {
      const result = await client.query(
        `
        INSERT INTO stock_move_line (
          move_id,
          picking_id,
          product_id,
          product_uom_id,
          warehouse_id,
          location_id,
          product_uom_qty,
          qty_done,
          state
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,0,'assigned')
        RETURNING id, location_id, product_uom_qty
        `,
        [
          Number(stockMove.move_id),
          Number(move.picking_id),
          Number(move.product_id),
          Number(stockMove.move_product_uom_id),
          warehouseId,
          locationId,
          qtyToAdd,
        ]
      );

      console.log("✅ stock_move_line creada SIN tocar inventory_by_location:", {
        id: result.rows[0]?.id,
        move_id: stockMove.move_id,
        product_id: move.product_id,
        location_id: locationId,
        qty: qtyToAdd,
      });
    }

    totalAdded += qtyToAdd;
  }

  return totalAdded;
}

async function releaseExtraReservedQty(client, {
  openReservedLines,
  qtyToRelease,
  updateInventory = false,
}) {
  let remainingToRelease = Number(qtyToRelease || 0);
  let releasedQty = 0;

  console.log("🟠 ---- releaseExtraReservedQty ----");
  console.log("🟠 qtyToRelease:", qtyToRelease);
  console.log("🟠 updateInventory:", updateInventory);

  for (const line of openReservedLines) {
    if (remainingToRelease <= 0) break;

    const lineQty = Number(line.product_uom_qty || 0);

    if (lineQty <= 0) continue;

    const qtyFromThisLine = Math.min(lineQty, remainingToRelease);

    console.log("🟠 Liberando de stock_move_line:", {
      lineId: line.id,
      lineQty,
      qtyFromThisLine,
      locationId: line.location_id,
    });

    // ✅ NO tocar inventory_by_location si updateInventory viene false
    if (updateInventory === true) {
      await releaseReservationFromInventory(client, line, qtyFromThisLine);
    } else {
      console.log("🟡 Se omite inventory_by_location. No se reduce qty_reserved.");
    }

    // Si se libera toda la línea, cancelar la línea
    if (qtyFromThisLine === lineQty) {
      await client.query(
        `
        UPDATE stock_move_line
        SET state = 'cancel',
            product_uom_qty = 0
        WHERE id = $1
        `,
        [line.id]
      );

      console.log("✅ stock_move_line cancelada:", line.id);
    } else {
      // Si solo se libera parte, reducir product_uom_qty
      await client.query(
        `
        UPDATE stock_move_line
        SET product_uom_qty = product_uom_qty - $1
        WHERE id = $2
        `,
        [qtyFromThisLine, line.id]
      );

      console.log("✅ stock_move_line reducida:", {
        lineId: line.id,
        qtyFromThisLine,
      });
    }

    releasedQty += qtyFromThisLine;
    remainingToRelease -= qtyFromThisLine;
  }

  return {
    releasedQty,
    remainingToRelease,
  };
}


async function releaseReservationFromInventory(client, stockMoveLine, qtyToRelease) {
  console.log("🟠 Liberando inventory_by_location:", {
    stockMoveLineId: stockMoveLine.id,
    productId: stockMoveLine.product_id,
    locationId: stockMoveLine.location_id,
    qtyToRelease,
  });




  const product = await getProductSkuByProductId(
    client,
    stockMoveLine.product_id
  );

  if (!product?.sku) {
    throw new Error(
      `No se encontró SKU para product_id ${stockMoveLine.product_id}`
    );
  }
  console.log("🟨🟨🟨🟨🟨 location id: ", product.sku);
  console.log("🟨🟨🟨🟨🟨 product sku: ", stockMoveLine.location_id);
  const inventoryResult = await client.query(
    `
    SELECT id, qty_reserved
    FROM inventory_by_location
    WHERE product_sku = $1
      AND location_id = $2
    FOR UPDATE
    `,
    [
      product.sku,
      stockMoveLine.location_id,
    ]
  );

  if (inventoryResult.rows.length === 0) {
    throw new Error(
      `No existe inventory_by_location para SKU ${product.sku} en location_id ${stockMoveLine.location_id}`
    );
  }

  const inventoryLine = inventoryResult.rows[0];
  const currentReserved = Number(inventoryLine.qty_reserved || 0);

  if (currentReserved < qtyToRelease) {
    throw new Error(
      `No hay reserva suficiente para liberar. SKU ${product.sku}, location_id ${stockMoveLine.location_id}. Reservado actual: ${currentReserved}, se intenta liberar: ${qtyToRelease}`
    );
  }

  await client.query(
    `
    UPDATE inventory_by_location
    SET qty_reserved = qty_reserved - $1,
        updated_at = NOW()
    WHERE id = $2
    `,
    [
      qtyToRelease,
      inventoryLine.id,
    ]
  );

  console.log("✅ inventory_by_location liberado:", {
    sku: product.sku,
    locationId: stockMoveLine.location_id,
    qtyToRelease,
  });
}

async function createPotentialMoveLinesWithoutInventoryReservation(client, {
  move,
  stockMove,
  potentialLines,
}) {
  let totalCreated = 0;

  for (const line of potentialLines) {
    const qtyToCreate = Number(line.quantity || line.quantity_taken || 0);

    if (qtyToCreate <= 0) continue;

    await client.query(
      `
      INSERT INTO stock_move_line (
        move_id,
        picking_id,
        product_id,
        product_uom_id,
        warehouse_id,
        location_id,
        product_uom_qty,
        qty_done,
        state
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,0,'assigned')
      `,
      [
        Number(stockMove.move_id),
        Number(move.picking_id),
        Number(move.product_id),
        Number(stockMove.move_product_uom_id),
        Number(line.almacen || 1),
        Number(line.location_id),
        qtyToCreate,
      ]
    );

    totalCreated += qtyToCreate;

    console.log("✅ stock_move_line creada SIN tocar inventory_by_location:", {
      move_id: stockMove.move_id,
      product_id: move.product_id,
      location_id: line.location_id,
      qty: qtyToCreate,
    });
  }

  return totalCreated;
}


//Esta función busca las líneas de picking de un movimiento y devuelve las que no están canceladas.
// moveId corresponde a despacho_stock_move.id.
// stock_move_line.move_id conserva su nombre actual.
async function getStockMoveLinesByMoveId(
  client,
  moveId
) {
  const query = `
    SELECT *
    FROM stock_move_line
    WHERE move_id = $1
      AND COALESCE(state, '') NOT IN (
        'cancel',
        'done'
      )
    ORDER BY id ASC
  `;

  const { rows } =
    await client.query(
      query,
      [moveId]
    );

  return rows;
}

function sumQty(lines, field) {
  return lines.reduce((total, line) => {
    return total + Number(line[field] || 0);
  }, 0);
}


async function increaseExistingMoveLineWithoutLocations(
  client,
  {
    move,
    stockMove,
    moveLines,
    openReservedLines,
    diffQty,
  }
) {
  const moveId = stockMove.move_id;
  const pickingId = move.picking_id;
  const productId = move.product_id;
  const productUomId = stockMove.move_product_uom_id;
  const sku = move.sku;

  let remainingDiff = Number(diffQty);

  let reducedQty = 0;
  let increasedExistingQty = 0;
  let createdQty = 0;
  let fallbackQty = 0;

  if (!Number.isFinite(remainingDiff) || remainingDiff < 0) {
    throw new Error("diffQty debe ser una cantidad válida.");
  }

  if (!sku) {
    throw new Error("El producto no tiene SKU.");
  }

  console.log(
    "🟣 ---- increaseExistingMoveLineWithoutLocations ----"
  );

  console.log("📦 Datos iniciales:", {
    moveId,
    pickingId,
    productId,
    sku,
    diffQty: remainingDiff,
    openReservedLines: openReservedLines.length,
  });

  // ==========================================================
  // 1. REVISAR CADA LÍNEA ABIERTA EXISTENTE
  // ==========================================================

  for (const line of openReservedLines) {
    if (remainingDiff <= 0) {
      break;
    }

    if (String(line.move_id) !== String(moveId)) {
      continue;
    }

    if (Number(line.qty_done || 0) !== 0) {
      continue;
    }

    const locationId = line.location_id;
    const warehouseId = line.warehouse_id;
    const currentLineQty = Number(line.product_uom_qty || 0);

    /*
     * Buscar inventario usando:
     * - SKU
     * - location_id
     * - warehouse_id
     */
    const inventoryResult = await client.query(
      `
        SELECT
          ibl.location_id,
          ibl.warehouse_id,
          ibl.qty_on_hand
        FROM inventory_by_location ibl
        WHERE ibl.product_sku = $1
          AND ibl.location_id = $2
          AND ibl.warehouse_id = $3
        FOR UPDATE
      `,
      [
        sku,
        locationId,
        warehouseId,
      ]
    );

    /*
     * Si no existe inventory_by_location para esa ubicación,
     * no se modifica la línea.
     *
     * Puede ser una ubicación GENERAL.
     */
    if (inventoryResult.rows.length === 0) {
      console.log(
        "⚪ La ubicación no tiene inventory_by_location. Se conserva:",
        {
          lineId: line.id,
          locationId,
          warehouseId,
          currentLineQty,
        }
      );

      continue;
    }

    if (inventoryResult.rows.length > 1) {
      throw new Error(
        `Hay inventario duplicado para SKU ${sku}, ` +
        `ubicación ${locationId} y almacén ${warehouseId}.`
      );
    }

    const qtyOnHand = Math.max(
      Number(inventoryResult.rows[0].qty_on_hand || 0),
      0
    );

    if (!Number.isFinite(qtyOnHand)) {
      throw new Error(
        `qty_on_hand inválido en la ubicación ${locationId}.`
      );
    }

    // ========================================================
    // 1A. qty_on_hand MENOR QUE LA CANTIDAD DE LA LÍNEA
    // ========================================================

    if (qtyOnHand < currentLineQty) {
      const quantityReduced =
        currentLineQty - qtyOnHand;

      const updateResult = await client.query(
        `
          UPDATE stock_move_line
          SET
            product_uom_qty = $1,
            write_date = NOW()
          WHERE id = $2
            AND move_id = $3
            AND qty_done = 0
            AND COALESCE(state, '') NOT IN ('cancel', 'done')
            AND product_uom_qty = $4
          RETURNING
            id,
            product_uom_qty,
            location_id,
            warehouse_id
        `,
        [
          qtyOnHand,
          line.id,
          moveId,
          currentLineQty,
        ]
      );

      if (updateResult.rows.length !== 1) {
        throw new Error(
          `La línea ${line.id} cambió mientras se ajustaba.`
        );
      }

      /*
       * Si una línea tenía 10, pero solo existen 4:
       *
       * Se reduce la línea:
       * 10 → 4
       *
       * Las 6 eliminadas vuelven a ser cantidad faltante:
       * remainingDiff = remainingDiff + 6
       */
      remainingDiff += quantityReduced;
      reducedQty += quantityReduced;

      // Actualizar el objeto en memoria.
      line.product_uom_qty = qtyOnHand;

      console.log("🔻 Línea reducida:", {
        lineId: line.id,
        locationId,
        warehouseId,
        before: currentLineQty,
        qtyOnHand,
        quantityReduced,
        remainingDiff,
      });

      continue;
    }

    // ========================================================
    // 1B. qty_on_hand IGUAL A LA CANTIDAD DE LA LÍNEA
    // ========================================================

    if (qtyOnHand === currentLineQty) {
      console.log("✅ Línea exacta. No se modifica:", {
        lineId: line.id,
        locationId,
        warehouseId,
        productUomQty: currentLineQty,
        qtyOnHand,
        remainingDiff,
      });

      continue;
    }

    // ========================================================
    // 1C. qty_on_hand MAYOR QUE LA CANTIDAD DE LA LÍNEA
    // ========================================================

    const locationExtraAvailable =
      qtyOnHand - currentLineQty;

    const quantityToIncrease = Math.min(
      locationExtraAvailable,
      remainingDiff
    );

    if (quantityToIncrease <= 0) {
      continue;
    }

    const newLineQty =
      currentLineQty + quantityToIncrease;

    const updateResult = await client.query(
      `
        UPDATE stock_move_line
        SET
          product_uom_qty = $1,
          state = 'assigned',
          write_date = NOW()
        WHERE id = $2
          AND move_id = $3
          AND qty_done = 0
          AND COALESCE(state, '') NOT IN ('cancel', 'done')
          AND product_uom_qty = $4
        RETURNING
          id,
          product_uom_qty,
          location_id,
          warehouse_id
      `,
      [
        newLineQty,
        line.id,
        moveId,
        currentLineQty,
      ]
    );

    if (updateResult.rows.length !== 1) {
      throw new Error(
        `La línea ${line.id} cambió mientras se aumentaba.`
      );
    }

    remainingDiff -= quantityToIncrease;
    increasedExistingQty += quantityToIncrease;

    // Actualizar el objeto en memoria.
    line.product_uom_qty = newLineQty;

    console.log("🔺 Línea aumentada:", {
      lineId: line.id,
      locationId,
      warehouseId,
      before: currentLineQty,
      qtyOnHand,
      quantityToIncrease,
      after: newLineQty,
      remainingDiff,
    });
  }

  // ==========================================================
  // 2. SI YA SE CUBRIÓ TODO, TERMINAR
  // ==========================================================

  if (remainingDiff <= 0) {
    console.log(
      "✅ Toda la diferencia fue agregada a líneas existentes."
    );

    return {
      reserved: increasedExistingQty,
      assignedQty: increasedExistingQty,
      increasedExistingQty,
      createdQty: 0,
      reducedQty,
      fallbackQty: 0,
      missingQty: 0,
      changed:
        increasedExistingQty > 0 ||
        reducedQty > 0,
      skipped: false,
      case: "ORDER_INCREASED",
      message:
        "La cantidad faltante fue distribuida en líneas existentes.",
    };
  }

  // ==========================================================
  // 3. CALCULAR CANTIDAD YA ASIGNADA POR UBICACIÓN
  // ==========================================================

  /*
   * Esto evita volver a usar la misma cantidad de una ubicación.
   *
   * Ejemplo:
   * qty_on_hand = 10
   * ya asignado en líneas abiertas = 6
   *
   * disponible para nuevas líneas = 4
   */
  const assignedByLocation = new Map();

  for (const line of moveLines) {
    if (
      String(line.move_id) !== String(moveId) ||
      line.state === "cancel" ||
      Number(line.qty_done || 0) !== 0
    ) {
      continue;
    }

    const key =
      `${line.warehouse_id}:${line.location_id}`;

    const assignedQty =
      Number(line.product_uom_qty || 0);

    assignedByLocation.set(
      key,
      (assignedByLocation.get(key) || 0) +
      assignedQty
    );
  }

  // ==========================================================
  // 4. BUSCAR TODAS LAS UBICACIONES DISPONIBLES DEL SKU
  // ==========================================================

  const locationsResult = await client.query(
    `
      SELECT
        ibl.location_id,
        ibl.warehouse_id,
        ibl.qty_on_hand,
        l.tramo,
        l.nivel,
        l.code
      FROM inventory_by_location ibl
      JOIN locations l
        ON l.id = ibl.location_id
       AND l.warehouse_id = ibl.warehouse_id
      WHERE ibl.product_sku = $1
        AND ibl.qty_on_hand > 0
        AND l.location_type IS DISTINCT FROM 'SHIPPING'
      ORDER BY
        l.tramo ASC,
        l.nivel ASC,
        ibl.location_id ASC
      FOR UPDATE OF ibl
    `,
    [sku]
  );

  const locationsAvailableNow = locationsResult.rows
    .map((row) => {
      const key =
        `${row.warehouse_id}:${row.location_id}`;

      const alreadyAssigned =
        assignedByLocation.get(key) || 0;

      const quantity = Math.max(
        Number(row.qty_on_hand || 0) -
        alreadyAssigned,
        0
      );

      return {
        location_id: row.location_id,
        quantity,
        tramo: row.tramo,
        nivel: row.nivel,
        almacen: row.warehouse_id,
        code: row.code,
      };
    })
    .filter(
      (location) => Number(location.quantity) > 0
    );

  console.log(
    "📍 UBICACIONES DISPONIBLES AHORA:",
    locationsAvailableNow
  );

  // ==========================================================
  // 5. SI NO HAY INVENTARIO, UTILIZAR GENERAL
  // ==========================================================

  if (locationsAvailableNow.length === 0) {
    /*
     * Tomar el almacén de una línea existente.
     * Así location_id y warehouse_id pertenecen al mismo almacén.
     */
    const sourceLine =
      openReservedLines[0] ||
      moveLines[0];

    if (!sourceLine?.warehouse_id) {
      throw new Error(
        "No se pudo determinar el almacén para la ubicación GENERAL."
      );
    }

    const warehouseId =
      Number(sourceLine.warehouse_id);

    const defaultLocation =
      await getOrCreateDefaultLocation(
        client,
        warehouseId
      );

    await client.query(
      `
        INSERT INTO stock_move_line (
          move_id,
          picking_id,
          product_id,
          product_uom_id,
          warehouse_id,
          location_id,
          product_uom_qty,
          qty_done,
          state
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8)
      `,
      [
        Number(moveId),
        Number(pickingId),
        Number(productId),
        Number(productUomId),
        Number(defaultLocation.warehouse_id),
        Number(defaultLocation.id),
        remainingDiff,
        "assigned",
      ]
    );

    fallbackQty = remainingDiff;
    remainingDiff = 0;

    console.log("🟡 Línea GENERAL creada:", {
      moveId,
      locationId: defaultLocation.id,
      warehouseId:
        defaultLocation.warehouse_id,
      quantity: fallbackQty,
    });

    return {
      reserved:
        increasedExistingQty +
        fallbackQty,
      assignedQty:
        increasedExistingQty +
        fallbackQty,
      increasedExistingQty,
      createdQty: fallbackQty,
      reducedQty,
      fallbackQty,
      missingQty: 0,
      changed: true,
      skipped: false,
      case: "ORDER_INCREASED_FALLBACK",
      message:
        "No había inventario disponible. La cantidad faltante fue asignada a la ubicación GENERAL.",
    };
  }

  // ==========================================================
  // 6. SELECCIONAR UBICACIONES PARA remainingDiff
  // ==========================================================

  const requiredQty = remainingDiff;
  let suggestedLocations = [];

  /*
   * Primero buscar una sola ubicación que tenga toda
   * la cantidad necesaria.
   */
  const validLocations =
    locationsAvailableNow.filter(
      (location) =>
        Number(location.quantity) >=
        requiredQty
    );

  if (validLocations.length > 0) {
    validLocations.sort((a, b) => {
      if (a.tramo !== b.tramo) {
        return a.tramo - b.tramo;
      }

      return a.nivel - b.nivel;
    });

    const selected =
      validLocations[0];

    suggestedLocations = [
      {
        location_id:
          selected.location_id,
        quantity_taken:
          requiredQty,
        tramo: selected.tramo,
        nivel: selected.nivel,
        almacen: selected.almacen,
        code: selected.code,
      },
    ];
  } else {
    /*
     * Ninguna ubicación cubre todo.
     * Dividir entre varias ubicaciones.
     */
    let remainingToSelect =
      requiredQty;

    const sorted = [
      ...locationsAvailableNow,
    ].sort((a, b) => {
      if (b.quantity !== a.quantity) {
        return b.quantity - a.quantity;
      }

      if (a.tramo !== b.tramo) {
        return a.tramo - b.tramo;
      }

      return a.nivel - b.nivel;
    });

    for (const location of sorted) {
      if (remainingToSelect <= 0) {
        break;
      }

      const available =
        Number(location.quantity);

      if (available <= 0) {
        continue;
      }

      const taken = Math.min(
        available,
        remainingToSelect
      );

      suggestedLocations.push({
        location_id:
          location.location_id,
        quantity_taken: taken,
        tramo: location.tramo,
        nivel: location.nivel,
        almacen: location.almacen,
        code: location.code,
      });

      remainingToSelect -= taken;
    }
  }

  // ==========================================================
  // 7. CREAR LAS NUEVAS stock_move_line
  // ==========================================================

  for (const location of suggestedLocations) {
    const qty =
      Number(location.quantity_taken);

    if (qty <= 0) {
      continue;
    }

    await client.query(
      `
        INSERT INTO stock_move_line (
          move_id,
          picking_id,
          product_id,
          product_uom_id,
          warehouse_id,
          location_id,
          product_uom_qty,
          qty_done,
          state
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8)
      `,
      [
        Number(moveId),
        Number(pickingId),
        Number(productId),
        Number(productUomId),
        Number(location.almacen),
        Number(location.location_id),
        qty,
        "assigned",
      ]
    );

    createdQty += qty;
    remainingDiff -= qty;

    console.log("🟢 Nueva línea física creada:", {
      moveId,
      locationId:
        location.location_id,
      warehouseId:
        location.almacen,
      quantity: qty,
      remainingDiff,
    });
  }

  remainingDiff = Math.max(
    remainingDiff,
    0
  );

  // ==========================================================
  // 8. DEVOLVER RESULTADO
  // ==========================================================

  const totalAdded =
    increasedExistingQty +
    createdQty;

  return {
    /*
     * Se mantiene "reserved" para que sea compatible
     * con tu controller actual.
     *
     * Esta función no actualiza
     * inventory_by_location.qty_reserved.
     */
    reserved: totalAdded,
    assignedQty: totalAdded,
    increasedExistingQty,
    createdQty,
    reducedQty,
    fallbackQty,
    missingQty: remainingDiff,
    changed:
      totalAdded > 0 ||
      reducedQty > 0,
    skipped: totalAdded === 0,
    case:
      remainingDiff > 0
        ? totalAdded > 0
          ? "ORDER_INCREASED_PARTIAL"
          : "ORDER_INCREASED_NO_STOCK"
        : "ORDER_INCREASED",
    message:
      remainingDiff > 0
        ? `Se asignaron ${totalAdded} unidades; faltan ${remainingDiff}.`
        : "La cantidad faltante fue asignada completamente.",
  };
}


async function cancelReservationForStockMoveLine(client, stockMoveLine) {
  console.log("🟠 Cancelando reserva de stock_move_line:", stockMoveLine.id);

  const product = await getProductSkuByProductId(
    client,
    stockMoveLine.product_id
  );

  if (!product?.sku) {
    throw new Error(
      `No se encontró SKU para product_id ${stockMoveLine.product_id}`
    );
  }

  const qtyToCancel = Number(stockMoveLine.product_uom_qty || 0);

  if (qtyToCancel <= 0) {
    return;
  }

  const query = `
    SELECT id, qty_reserved
    FROM inventory_by_location
    WHERE product_sku = $1
      AND location_id = $2
    FOR UPDATE
  `;

  const { rows } = await client.query(query, [
    product.sku,
    stockMoveLine.location_id,
  ]);

  if (rows.length === 0) {
    throw new Error(
      `No existe inventory_by_location para SKU ${product.sku} en location_id ${stockMoveLine.location_id}`
    );
  }

  const inventoryLine = rows[0];
  const currentReserved = Number(inventoryLine.qty_reserved || 0);

  if (currentReserved < qtyToCancel) {
    throw new Error(
      `No hay cantidad reservada suficiente. SKU ${product.sku}, location_id ${stockMoveLine.location_id}. Reservado actual: ${currentReserved}, se intenta cancelar: ${qtyToCancel}`
    );
  }

  await client.query(
    `
    UPDATE inventory_by_location
    SET qty_reserved = qty_reserved - $1,
        updated_at = NOW()
    WHERE id = $2
    `,
    [qtyToCancel, inventoryLine.id]
  );

  console.log("✅ Reserva cancelada en inventory_by_location:", {
    sku: product.sku,
    location_id: stockMoveLine.location_id,
    qtyToCancel,
  });
}

async function getProductSkuByProductId(client, productId) {
  const query = `
    SELECT sku
    FROM products
    WHERE id::text = $1::text
       OR sku::text = $1::text
    LIMIT 1
  `;

  const { rows } = await client.query(query, [productId]);

  return rows[0];
}

async function cancelStockMoveLine(client, stockMoveLineId) {
  await client.query(
    `
    UPDATE stock_move_line
    SET state = 'cancel'
    WHERE id = $1
    `,
    [stockMoveLineId]
  );

  console.log("✅ stock_move_line cancelada:", stockMoveLineId);
}

function buildPotentialMoveLinesFromLocations(locations, requiredQty) {
  const cleanLocations = (locations || [])
    .map(location => ({
      ...location,
      quantity: Number(location.quantity || 0),
      tramo: Number(location.tramo || 0),
    }))
    .filter(location => location.quantity > 0);

  /**
   * 1. Buscar ubicaciones con cantidad exacta.
   */
  const exactMatches = cleanLocations.filter(
    location => location.quantity === requiredQty
  );

  if (exactMatches.length > 0) {
    const bestExactMatch = exactMatches.sort((a, b) => b.tramo - a.tramo)[0];

    return {
      lines: [
        {
          location_id: bestExactMatch.location_id,
          quantity: requiredQty,
          tramo: bestExactMatch.tramo,
          almacen: bestExactMatch.almacen,
        },
      ],
      totalPotentialQty: requiredQty,
      remainingQty: 0,
    };
  }

  /**
   * 2. Si no hay cantidad exacta, ordenar por tramo mayor a menor.
   */
  const sortedLocations = cleanLocations.sort((a, b) => b.tramo - a.tramo);

  let remainingQty = requiredQty;
  const lines = [];

  for (const location of sortedLocations) {
    if (remainingQty <= 0) break;

    const qtyToTake = Math.min(location.quantity, remainingQty);

    lines.push({
      location_id: location.location_id,
      quantity: qtyToTake,
      tramo: location.tramo,
      almacen: location.almacen,
    });

    remainingQty -= qtyToTake;
  }

  const totalPotentialQty = lines.reduce(
    (total, line) => total + Number(line.quantity || 0),
    0
  );

  return {
    lines,
    totalPotentialQty,
    remainingQty,
  };
}

async function createAndReservePotentialMoveLines(client, {
  move,
  stockMove,
  sku,
  potentialLines,
}) {
  let totalReserved = 0;

  for (const line of potentialLines) {
    const qtyToReserve = Number(line.quantity || 0);

    if (qtyToReserve <= 0) continue;

    /**
     * 1. Reservar en inventory_by_location.
     */
    const inventoryResult = await client.query(
      `
      UPDATE inventory_by_location
      SET qty_reserved = qty_reserved + $1,
          updated_at = NOW()
      WHERE product_sku = $2
        AND location_id = $3
        AND qty_available >= $1
      RETURNING id, qty_reserved, qty_available
      `,
      [qtyToReserve, sku, line.location_id]
    );

    if (inventoryResult.rows.length === 0) {
      throw new Error(
        `No se pudo reservar SKU ${sku} en location_id ${line.location_id}. No hay qty_available suficiente.`
      );
    }

    /**
     * 2. Crear stock_move_line.
     */
    await client.query(
      `
      INSERT INTO stock_move_line (
        move_id,
        picking_id,
        product_id,
        product_uom_qty,
        qty_done,
        location_id,
        product_uom_id,
        warehouse_id,
        state
      )
      VALUES ($1, $2, $3, $4, 0, $5, $6, $7, 'assigned')
      `,
      [
        stockMove.move_id,
        move.picking_id,
        move.product_id,
        qtyToReserve,
        line.location_id,
        stockMove.move_product_uom_id,
        line.almacen || 1,
      ]
    );

    totalReserved += qtyToReserve;

    console.log("✅ Nueva stock_move_line creada y reservada:", {
      sku,
      location_id: line.location_id,
      qtyToReserve,
    });
  }

  return totalReserved;
}

export async function updateDispatchMoveState(
  client,
  moveId
) {
  // ==========================================
  // 1. BUSCAR Y BLOQUEAR MOVIMIENTO DE DESPACHO
  // ==========================================

  const dispatchMoveResult =
    await client.query(
      `
        SELECT
          id,
          picking_id,
          product_id,
          product_qty,
          quantity_done,
          pending_qty,
          state
        FROM despacho_stock_move
        WHERE id = $1
        FOR UPDATE
      `,
      [moveId]
    );

  const dispatchMove =
    dispatchMoveResult.rows[0];

  if (!dispatchMove) {
    throw new Error(
      `No existe despacho_stock_move con ID ${moveId}.`
    );
  }

  if (
    ["done", "cancel"].includes(
      String(
        dispatchMove.state || ""
      )
    )
  ) {
    return {
      moveId:
        Number(dispatchMove.id),
      requiredQty:
        Number(
          dispatchMove.pending_qty ||
          0
        ),
      pickedQty: 0,
      reservedOpenQty: 0,
      coveredQty: 0,
      state:
        dispatchMove.state,
      changed: false,
      skipped: true,
      reason:
        "DISPATCH_MOVE_TERMINAL",
    };
  }

  /*
   * pending_qty viene de ADM Cloud.
   * Es la cantidad pendiente actual que debe
   * cubrir el WMS.
   */
  const requiredQty =
    Number(
      dispatchMove.pending_qty || 0
    );

  if (
    !Number.isFinite(requiredQty) ||
    requiredQty < 0
  ) {
    throw new Error(
      `pending_qty inválido para despacho_stock_move ${moveId}.`
    );
  }

  // ==========================================
  // 2. CALCULAR COBERTURA ACTIVA
  // ==========================================

  const coverageResult =
    await client.query(
      `
        SELECT
          COALESCE(
            SUM(
              COALESCE(
                sml.qty_done,
                0
              )
            ),
            0
          ) AS picked_qty,

          COALESCE(
            SUM(
              GREATEST(
                COALESCE(
                  sml.product_uom_qty,
                  0
                ) -
                COALESCE(
                  sml.qty_done,
                  0
                ),
                0
              )
            ),
            0
          ) AS reserved_open_qty,

          COALESCE(
            SUM(
              GREATEST(
                COALESCE(
                  sml.product_uom_qty,
                  0
                ),
                COALESCE(
                  sml.qty_done,
                  0
                )
              )
            ),
            0
          ) AS covered_qty

        FROM stock_move_line AS sml

        WHERE sml.move_id = $1
          AND sml.picking_id = $2
          AND sml.product_id = $3
          AND COALESCE(
                sml.state,
                ''
              ) NOT IN (
                'cancel',
                'done'
              )
      `,
      [
        dispatchMove.id,
        dispatchMove.picking_id,
        dispatchMove.product_id,
      ]
    );

  const pickedQty =
    Number(
      coverageResult.rows[0]
        .picked_qty || 0
    );

  const reservedOpenQty =
    Number(
      coverageResult.rows[0]
        .reserved_open_qty || 0
    );

  const coveredQty =
    Number(
      coverageResult.rows[0]
        .covered_qty || 0
    );

  // ==========================================
  // 3. DETERMINAR ESTADO
  // ==========================================

  let state =
    "confirmed";

  let note =
    "Cantidad no reservada";

  if (requiredQty === 0) {
    state = "done";
    note =
      "Sin cantidad pendiente por despachar";
  } else if (
    coveredQty >= requiredQty
  ) {
    state = "assigned";
    note =
      "Cantidad pendiente completamente reservada";
  } else if (
    coveredQty > 0
  ) {
    state =
      "partially_available";

    note =
      "Cantidad pendiente parcialmente reservada";
  }

  // ==========================================
  // 4. ACTUALIZAR despacho_stock_move
  // ==========================================

  const updatedResult =
    await client.query(
      `
        UPDATE despacho_stock_move
        SET
          state = $1,
          note = $2,
          write_date = NOW()
        WHERE id = $3
          AND COALESCE(
                state,
                ''
              ) NOT IN (
                'cancel',
                'done'
              )
        RETURNING
          id,
          picking_id,
          product_id,
          product_qty,
          quantity_done,
          pending_qty,
          state,
          note,
          write_date
      `,
      [
        state,
        note,
        moveId,
      ]
    );

  if (
    updatedResult.rows.length !== 1
  ) {
    throw new Error(
      `No se pudo actualizar despacho_stock_move ${moveId}.`
    );
  }

  const result = {
    moveId:
      Number(moveId),
    requiredQty,
    pickedQty,
    reservedOpenQty,
    coveredQty,
    missingQty:
      Math.max(
        requiredQty -
        coveredQty,
        0
      ),
    state,
    note,
    changed: true,
  };

  console.log(
    "✅ despacho_stock_move actualizado:",
    result
  );

  return result;
}