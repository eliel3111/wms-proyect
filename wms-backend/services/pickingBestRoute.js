import { updateDispatchMoveState } from "../services/pickingReservationExisting.service.js";


//
export async function getPickingProductsWithLocationsService(client, pickingId) {
  console.log("🧠 [SERVICE] Procesando picking:", pickingId);

  // ==============================
  // 1️⃣ TRAER MOVES, se buscan todos los lines de la orden de venta, de obtiene el produc id y la cantidad pedida.
  // ==============================
const movesResult = await client.query(
  `
    SELECT
      id,
      product_id,

      GREATEST(
        COALESCE(pending_qty, 0),
        0
      ) AS product_qty,

      product_uom_id,
      erp_move_id,
      erp_product_id,
      source_transaction_id,
      sku

    FROM despacho_stock_move

    WHERE picking_id = $1

      AND COALESCE(
        state,
        ''
      ) NOT IN (
        'cancel',
        'done'
      )

      AND COALESCE(
        pending_qty,
        0
      ) > 0

    ORDER BY id ASC
  `,
  [
    pickingId
  ]
);
  if (!movesResult.rows.length) {
    return {
      data: [],
      message: "No hay productos en este picking",
    };
  }

  const moves = movesResult.rows;
  //console.log("PRODUCTOS DEL PEDIDO: ", moves);

  // ==============================
  // 2️⃣ PRODUCT IDS, Se filtran los ids para que no se repitan.
  // ==============================
  const productIds = [...new Set(moves.map(m => m.product_id))];

  // ==============================
  // 3️⃣ SKUs
  // ==============================
  const productsResult = await client.query(`
    SELECT id, sku
    FROM products
    WHERE id = ANY($1::int[])
  `, [productIds]);

  //// Relaciona product_id → SKU
  const skuMap = new Map();
  // Lista de SKU para consultar el inventario
  const skuList = [];

  for (const p of productsResult.rows) {
    skuMap.set(p.id, p.sku);
    skuList.push(p.sku);
  }
  console.log("TODOS LOS SKUS: ", skuList);
  // ==============================
  // 4️⃣ INVENTARIO + LOCATIONS, por cada sku, se busca la ubicacion, almacen, cantidad disponible.
  // ==============================
  const inventoryResult =
  await client.query(
    `
      SELECT
        ibl.product_sku,
        ibl.location_id,
        ibl.warehouse_id,
        ibl.qty_available,
        l.tramo,
        l.nivel,
        l.code,
        l.location_type

      FROM inventory_by_location AS ibl

      JOIN locations AS l
        ON l.id = ibl.location_id
       AND l.warehouse_id =
           ibl.warehouse_id

      WHERE ibl.product_sku =
            ANY($1::text[])

        AND COALESCE(
          ibl.qty_available,
          0
        ) > 0

        AND l.location_type
            IS DISTINCT FROM
            'SHIPPING'

        AND UPPER(
          COALESCE(
            l.code,
            ''
          )
        ) NOT LIKE 'GENERAL-%'
    `,
    [
      skuList
    ]
  );

  console.log("📦 INVENTORY RESULT:", inventoryResult.rows);

  // ==============================
  // 5️⃣ MAP INVENTORY
  // ==============================
  const inventoryMap = new Map();

  for (const row of inventoryResult.rows) {
    if (!inventoryMap.has(row.product_sku)) {
      inventoryMap.set(row.product_sku, []);
    }

    inventoryMap.get(row.product_sku).push({
      location_id: row.location_id,
      quantity: Math.floor(Number(row.qty_available)) || 0,
      tramo: row.tramo,
      nivel: row.nivel,
      almacen: row.warehouse_id,
    });
  }

//Aqui utilizando el almacen de la orden de venta se busca el almacen o id de almacen interno del wms
  const warehouseResult = await client.query(
  `
    SELECT
      w.id,
      w.code,
      w.name,
      w.erp_warehouse_id,
      sp.erp_location_id
    FROM public.stock_picking AS sp
    JOIN public.warehouses AS w
      ON w.erp_warehouse_id = sp.erp_location_id
    WHERE sp.id = $1
      AND w.status = 'ACTIVE'
  `,
  [pickingId]
);



  if (warehouseResult.rowCount === 0) {
    throw new Error("No existe warehouse por defecto");
  }

  const warehouseId = warehouseResult.rows[0].id;

  // ==============================
  // 6️⃣ CONFIG + FALLBACK
  // ==============================
  const config = await getPickingConfig(client);

  let defaultLocation = null;

  if (config.allow_picking_without_locations) {

    defaultLocation = await getOrCreateDefaultLocation(client, warehouseId);
  }

  // ==============================
  // 7️⃣ RESULT FINAL
  // ==============================
  const resultMap = new Map();
  let hasAtLeastOneLocation = false;

  for (const move of moves) {
    const sku = skuMap.get(move.product_id);

    // 🔴 VALIDACIÓN SKU
    if (!sku) {
      const error = new Error(`Producto ${move.product_id} no tiene SKU`);
      error.code = "NO_SKU";
      throw error;
    }

    const productLocations = inventoryMap.get(sku);

    //console.log("UBICACIONES DEL PRODUCTO: ", sku, "ES: ", productLocations);

    let finalLocations = [];

    if (productLocations?.length) {
      // 🟢 Tiene ubicaciones reales
      hasAtLeastOneLocation = true;
      finalLocations = productLocations;

    } else if (config.allow_picking_without_locations && defaultLocation) {
      // 🟡 Fallback GENERAL
      finalLocations = [{
        location_id: defaultLocation.id,
        quantity: 0,
        tramo: defaultLocation.tramo,
        nivel: defaultLocation.nivel,
        almacen: defaultLocation.warehouse_id,
        code: defaultLocation.code,
        is_fallback: true
      }];

    } else {
      continue;
    }
    if (!resultMap.has(move.product_id)) {
      resultMap.set(move.product_id, {
        product_id: move.product_id,
        sku,
        picking_id: Number(pickingId),
        moves: [],
        locations: finalLocations,
      });
    }

    resultMap.get(move.product_id).moves.push({
      move_id: move.id,
      product_qty: Math.floor(Number(move.product_qty)) || 0,
      move_product_uom_id: move.product_uom_id,
    });
  }

  if (
    !hasAtLeastOneLocation &&
    !config.allow_picking_without_locations
  ) {
    return {
      data: [],
      message: "Ningún producto tiene inventario en ubicaciones",
    };
  }

  return {
    data: Array.from(resultMap.values()),
  };
}

//CASO 1: Buscar 1 ubicacion ideal
export function selectBestLocation(product) {

  //suma las cantidades solicitadas y se unifica por producto, ya que un producto pudiera tener mas de un move.
  const requiredQty = product.moves.reduce(
    (sum, m) => sum + Number(m.product_qty),
    0
  );

  //Se obtiene sus ubicaciones
  const locations = product.locations || [];

  if (!locations.length) return null;

  // ==============================
  // 🔹 CASO 1: UNA SOLA UBICACIÓN, se intenta buscar una ubicacion con toda la cantidad solicitada de ese producto
  // ==============================
  const validLocations = locations.filter(
    loc => Number(loc.quantity) >= requiredQty
  );

  //Si hay una ubicacion que satisface todo
  if (validLocations.length > 0) {
    validLocations.sort((a, b) => {
      if (a.tramo !== b.tramo) return a.tramo - b.tramo;
      return a.nivel - b.nivel;
    });

    return {
      sugerido: [
        {
          location_id: validLocations[0].location_id,
          quantity_taken: requiredQty,
          tramo: validLocations[0].tramo,
          nivel: validLocations[0].nivel,
          almacen: validLocations[0].almacen
        }
      ]
    };
  }

  // ==============================
  // 🔥 CASO 2: SPLIT ENTRE UBICACIONES
  // ==============================
  return splitAcrossLocations(locations, requiredQty);
}


//CASO 2: Dividir en varias ubicaciones
function splitAcrossLocations(locations, requiredQty) {
  let remaining = requiredQty;

  // ==============================
  // 1️⃣ ORDENAR (mayor cantidad primero)
  // ==============================
  const sorted = [...locations].sort((a, b) => {
    if (b.quantity !== a.quantity) return b.quantity - a.quantity;

    // desempate: menor tramo → menor nivel
    if (a.tramo !== b.tramo) return a.tramo - b.tramo;
    return a.nivel - b.nivel;
  });

  const result = [];

  // ==============================
  // 2️⃣ ITERAR HASTA COMPLETAR
  // ==============================
  for (const loc of sorted) {
    if (remaining <= 0) break;

    const available = Number(loc.quantity);

    if (available <= 0) continue;

    const taken = Math.min(available, remaining);

    result.push({
      location_id: loc.location_id,
      quantity_taken: taken,
      tramo: loc.tramo,
      nivel: loc.nivel,
      almacen: loc.almacen,
    });

    remaining -= taken;
  }

  // ==============================
  // 3️⃣ VALIDACIÓN FINAL
  // ==============================
  if (remaining > 0) {
    return {
      error: "Inventario insuficiente",
      faltante: remaining,
      sugerido: result,
    };
  }

  return result;
}





// =====================================================
// SERVICIO DE RESERVA INICIAL DE INVENTARIO
//
// allow_picking_without_locations = false:
//   Solo utiliza ubicaciones físicas.
//
// allow_picking_without_locations = true:
//   Utiliza ubicaciones físicas primero y completa
//   cualquier faltante utilizando GENERAL.
//
// Se asume que todavía NO existen stock_move_line
// activas para los despacho_stock_move recibidos.
// =====================================================
export async function reserveInventoryForMove(
  client,
  move
) {
  console.log("");
  console.log("=======================================");
  console.log("🟦 reserveInventoryForMove");
  console.log("=======================================");
  console.log("🟦 MOVE:", move);

  if (!client) {
    throw new Error(
      "La conexión de base de datos es requerida."
    );
  }

  if (!move || typeof move !== "object") {
    throw new Error(
      "Debe proporcionar los datos del producto."
    );
  }

  // ==========================================
  // 1. DATOS DEL PRODUCTO
  // ==========================================

  const productSku = move.sku;

  const dispatchMoves = Array.isArray(
    move.moves
  )
    ? move.moves
    : [];

  const sourceLocations = Array.isArray(
    move.locations
  )
    ? move.locations
    : [];

  if (!productSku) {
    throw new Error(
      `El producto ${move.product_id} no tiene SKU.`
    );
  }

  // ==========================================
  // 2. OBTENER UBICACIONES SELECCIONADAS
  // ==========================================

  /*
   * selectBestLocation puede devolver:
   *
   * 1. Un arreglo:
   * [
   *   {
   *     location_id,
   *     quantity_taken,
   *     ...
   *   }
   * ]
   *
   * 2. Un objeto:
   * {
   *   error,
   *   faltante,
   *   sugerido: [...]
   * }
   */
  const rawMoveLines = Array.isArray(
    move.selected_location
  )
    ? move.selected_location
    : Array.isArray(
          move.selected_location?.sugerido
        )
      ? move.selected_location.sugerido
      : [];

  // ==========================================
  // 3. AGREGAR "restante"
  // ==========================================

  const moveLines = rawMoveLines.map(
    (row) => {
      const quantityTaken = Number(
        row.quantity_taken || 0
      );

      const safeQuantity =
        Number.isFinite(quantityTaken)
          ? Math.max(quantityTaken, 0)
          : 0;

      return {
        ...row,
        quantity_taken: safeQuantity,
        restante: safeQuantity,
      };
    }
  );

  console.log(
    "📦 SKU:",
    productSku
  );

  console.log(
    "🚚 DISPATCH MOVES:",
    dispatchMoves
  );

  console.log(
    "📍 MOVE LINES CON RESTANTE:",
    moveLines
  );

  // ==========================================
  // 4. OBTENER CONFIGURACIÓN
  // ==========================================

  const config =
    await getPickingConfig(client);

  const allowPickingWithoutLocations =
    config?.allow_picking_without_locations ===
    true;

  console.log("⚙️ CONFIGURACIÓN:", {
    allow_picking_without_locations:
      allowPickingWithoutLocations,
  });

  // ==========================================
  // 5. VALIDAR MOVIMIENTOS DE DESPACHO
  // ==========================================

  if (dispatchMoves.length === 0) {
    console.log(
      "⚠️ No hay movimientos de despacho"
    );

    return {
      reserved: 0,
      physical_reserved: 0,
      general_reserved: 0,
      required: 0,
      missing: 0,
      note:
        "Sin movimientos de despacho",
      moves: [],
      remaining_locations: moveLines,
    };
  }

  // ==========================================
  // 6. VARIABLES GENERALES
  // ==========================================

  let cantidadReservada = 0;
  let cantidadFisicaReservada = 0;
  let cantidadGeneralReservada = 0;

  const moveResults = [];

  /*
   * Evita llamar varias veces a
   * getOrCreateDefaultLocation para el mismo
   * almacén durante esta ejecución.
   */
  const generalLocationCache =
    new Map();

  const EPSILON = 0.000001;

  // ==========================================
  // FUNCIÓN INTERNA:
  // NORMALIZAR UBICACIÓN GENERAL
  // ==========================================

  const normalizeDefaultLocation = (
    location
  ) => {
    if (!location) {
      throw new Error(
        "No se recibió una ubicación GENERAL válida."
      );
    }

    /*
     * getOrCreateDefaultLocation normalmente
     * devuelve:
     *
     * {
     *   id,
     *   warehouse_id,
     *   code,
     *   tramo,
     *   nivel
     * }
     *
     * createStockMoveLine necesita:
     *
     * {
     *   location_id,
     *   almacen
     * }
     */
    const locationId = Number(
      location.location_id ??
        location.id
    );

    const warehouseId = Number(
      location.almacen ??
        location.warehouse_id
    );

    if (
      !Number.isFinite(locationId) ||
      locationId <= 0
    ) {
      throw new Error(
        "La ubicación GENERAL no tiene un location_id válido."
      );
    }

    if (
      !Number.isFinite(warehouseId) ||
      warehouseId <= 0
    ) {
      throw new Error(
        "La ubicación GENERAL no tiene un warehouse_id válido."
      );
    }

    return {
      ...location,
      location_id: locationId,
      almacen: warehouseId,
      warehouse_id: warehouseId,
      quantity: 0,
      quantity_taken: 0,
      restante: 0,
      is_fallback: true,
    };
  };

  // ==========================================
  // FUNCIÓN INTERNA:
  // OBTENER UBICACIÓN GENERAL
  // ==========================================

  const resolveGeneralLocation = async (
    preferredWarehouseId = null
  ) => {
    /*
     * Primero se busca una ubicación GENERAL
     * que ya venga dentro de move.locations.
     */
    const inlineFallbackRaw =
      sourceLocations.find(
        (location) =>
          location.is_fallback === true ||
          String(location.code || "")
            .toUpperCase()
            .startsWith("GENERAL-")
      );

    const inlineFallback =
      inlineFallbackRaw
        ? normalizeDefaultLocation(
            inlineFallbackRaw
          )
        : null;

    /*
     * Prioridad para elegir almacén:
     *
     * 1. Almacén utilizado por una ubicación física.
     * 2. Almacén de la ubicación GENERAL recibida.
     * 3. Primera ubicación disponible del producto.
     * 4. Almacén relacionado con el picking.
     */
    let warehouseId = Number(
      preferredWarehouseId
    );

    if (
      !Number.isFinite(warehouseId) ||
      warehouseId <= 0
    ) {
      warehouseId = Number(
        inlineFallback?.almacen
      );
    }

    if (
      !Number.isFinite(warehouseId) ||
      warehouseId <= 0
    ) {
      const locationWithWarehouse =
        sourceLocations.find(
          (location) => {
            const value = Number(
              location.almacen ??
                location.warehouse_id
            );

            return (
              Number.isFinite(value) &&
              value > 0
            );
          }
        );

      warehouseId = Number(
        locationWithWarehouse?.almacen ??
          locationWithWarehouse
            ?.warehouse_id
      );
    }

    /*
     * Si move no trae ningún almacén,
     * buscarlo utilizando el picking.
     */
    if (
      !Number.isFinite(warehouseId) ||
      warehouseId <= 0
    ) {
      const warehouseResult =
        await client.query(
          `
            SELECT
              w.id AS warehouse_id
            FROM stock_picking AS sp
            JOIN warehouses AS w
              ON w.erp_warehouse_id =
                 sp.erp_location_id
            WHERE sp.id = $1
              AND w.status = 'ACTIVE'
            ORDER BY
              w.is_default DESC,
              w.id ASC
            LIMIT 1
          `,
          [
            Number(
              move.picking_id
            ),
          ]
        );

      warehouseId = Number(
        warehouseResult.rows[0]
          ?.warehouse_id
      );
    }

    if (
      !Number.isFinite(warehouseId) ||
      warehouseId <= 0
    ) {
      throw new Error(
        `No se pudo determinar el almacén para crear ` +
        `la ubicación GENERAL del producto ${productSku}.`
      );
    }

    /*
     * Si la ubicación GENERAL recibida pertenece
     * al almacén requerido, se utiliza directamente.
     */
    if (
      inlineFallback &&
      Number(
        inlineFallback.almacen
      ) === warehouseId
    ) {
      generalLocationCache.set(
        warehouseId,
        inlineFallback
      );

      return inlineFallback;
    }

    if (
      generalLocationCache.has(
        warehouseId
      )
    ) {
      return generalLocationCache.get(
        warehouseId
      );
    }

    const defaultLocation =
      await getOrCreateDefaultLocation(
        client,
        warehouseId
      );

    const normalizedLocation =
      normalizeDefaultLocation(
        defaultLocation
      );

    generalLocationCache.set(
      warehouseId,
      normalizedLocation
    );

    return normalizedLocation;
  };

  // ==========================================
  // FUNCIÓN INTERNA:
  // CREAR STOCK_MOVE_LINE PARA UN MOVIMIENTO
  // DE despacho_stock_move
  // ==========================================

  const createStockMoveLine = async (
    dispatchMove,
    location,
    qty
  ) => {
    const dispatchMoveId = Number(
      dispatchMove.move_id
    );

    const pickingId = Number(
      move.picking_id
    );

    const productId = Number(
      move.product_id
    );

    const warehouseId = Number(
      location.almacen ??
        location.warehouse_id
    );

    const locationId = Number(
      location.location_id ??
        location.id
    );

    const quantity = Number(qty);

    if (
      !Number.isSafeInteger(
        dispatchMoveId
      ) ||
      dispatchMoveId <= 0
    ) {
      throw new Error(
        "ID de despacho_stock_move inválido."
      );
    }

    if (
      !Number.isSafeInteger(
        pickingId
      ) ||
      pickingId <= 0
    ) {
      throw new Error(
        "picking_id inválido al crear stock_move_line."
      );
    }

    if (
      !Number.isSafeInteger(
        productId
      ) ||
      productId <= 0
    ) {
      throw new Error(
        "product_id inválido al crear stock_move_line."
      );
    }

    if (
      !Number.isSafeInteger(
        warehouseId
      ) ||
      warehouseId <= 0
    ) {
      throw new Error(
        "warehouse_id inválido al crear stock_move_line."
      );
    }

    if (
      !Number.isSafeInteger(
        locationId
      ) ||
      locationId <= 0
    ) {
      throw new Error(
        "location_id inválido al crear stock_move_line."
      );
    }

    if (
      !Number.isFinite(quantity) ||
      quantity <= 0
    ) {
      throw new Error(
        "La cantidad de stock_move_line debe ser mayor que cero."
      );
    }

    /*
     * Buscar y bloquear el movimiento padre
     * directamente en despacho_stock_move.
     */
    const dispatchResult =
      await client.query(
        `
          SELECT
            id,
            picking_id,
            product_id,
            product_uom_id,
            pending_qty,
            state
          FROM despacho_stock_move
          WHERE id = $1
          FOR UPDATE
        `,
        [dispatchMoveId]
      );

    const persistedDispatchMove =
      dispatchResult.rows[0];

    if (!persistedDispatchMove) {
      throw new Error(
        `No existe despacho_stock_move con ID ${dispatchMoveId}.`
      );
    }

    if (
      String(
        persistedDispatchMove
          .picking_id
      ) !== String(pickingId)
    ) {
      throw new Error(
        `El movimiento ${dispatchMoveId} no pertenece al picking ${pickingId}.`
      );
    }

    if (
      String(
        persistedDispatchMove
          .product_id
      ) !== String(productId)
    ) {
      throw new Error(
        `El movimiento ${dispatchMoveId} no pertenece al producto ${productId}.`
      );
    }

    if (
      ["done", "cancel"].includes(
        String(
          persistedDispatchMove.state ||
            ""
        )
      )
    ) {
      throw new Error(
        `El movimiento de despacho ${dispatchMoveId} está ${persistedDispatchMove.state}.`
      );
    }

    /*
     * Se obtiene el UOM directamente del
     * movimiento guardado en despacho_stock_move.
     */
    const productUomId = Number(
      persistedDispatchMove
        .product_uom_id
    );

    if (
      !Number.isSafeInteger(
        productUomId
      ) ||
      productUomId <= 0
    ) {
      throw new Error(
        `El movimiento de despacho ${dispatchMoveId} no tiene un product_uom_id válido.`
      );
    }

    const insertResult =
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
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            0,
            'assigned'
          )
          RETURNING
            id,
            move_id,
            picking_id,
            product_id,
            location_id,
            warehouse_id,
            product_uom_qty,
            qty_done,
            state
        `,
        [
          dispatchMoveId,
          pickingId,
          productId,
          productUomId,
          warehouseId,
          locationId,
          quantity,
        ]
      );

    console.log(
      "✅ stock_move_line creado para despacho_stock_move:",
      insertResult.rows[0]
    );

    return insertResult.rows[0];
  };

  // ==========================================
  // 7. RECORRER CADA MOVIMIENTO DE DESPACHO
  // ==========================================

  for (
    const dispatchMove of
    dispatchMoves
  ) {
    console.log("");
    console.log("---------------------------------------");

    console.log(
      "🚚 PROCESANDO DESPACHO_STOCK_MOVE:",
      dispatchMove.move_id
    );

    console.log("---------------------------------------");

    /*
     * pending_qty es la cantidad pendiente
     * informada por ADM Cloud.
     *
     * product_qty queda como fallback para
     * mantener compatibilidad temporal.
     */
    const requiredQty = Number(
      dispatchMove.pending_qty ??
        dispatchMove.product_qty ??
        0
    );

    if (
      !Number.isFinite(
        requiredQty
      ) ||
      requiredQty <= 0
    ) {
      console.log(
        "⚠️ Movimiento de despacho sin cantidad pendiente:",
        dispatchMove
      );

      moveResults.push({
        move_id: Number(
          dispatchMove.move_id
        ),
        required: 0,
        reserved: 0,
        physical_reserved: 0,
        general_reserved: 0,
        missing: 0,
        state: null,
        note:
          "Movimiento de despacho sin cantidad pendiente",
        skipped: true,
      });

      continue;
    }

    let reservedForMove = 0;
    let physicalReservedForMove = 0;
    let generalReservedForMove = 0;

    /*
     * Se utiliza para crear GENERAL en el mismo
     * almacén de la ubicación física utilizada.
     */
    let preferredWarehouseId =
      null;

    console.log(
      "📌 Cantidad requerida:",
      requiredQty
    );

    // ========================================
    // 8. RESERVAR UBICACIONES FÍSICAS
    // ========================================

    if (moveLines.length > 0) {
      /*
       * Primero se intenta encontrar una sola
       * ubicación que pueda cubrir todo el
       * movimiento.
       */
      const fullLocation =
        moveLines.find(
          (location) =>
            Number(
              location.restante
            ) > EPSILON &&
            Number(
              location.restante
            ) >= requiredQty
        );

      // ======================================
      // CASO 1:
      // UNA UBICACIÓN CUBRE TODO
      // ======================================

      if (fullLocation) {
        console.log(
          "🟢 Una ubicación cubre todo:",
          {
            location_id:
              fullLocation.location_id,
            disponible:
              fullLocation.restante,
            requerido:
              requiredQty,
          }
        );

        const qtyToReserve =
          requiredQty;

        await createStockMoveLine(
          dispatchMove,
          fullLocation,
          qtyToReserve
        );

        fullLocation.restante =
          Number(
            fullLocation.restante
          ) - qtyToReserve;

        reservedForMove +=
          qtyToReserve;

        physicalReservedForMove +=
          qtyToReserve;

        cantidadReservada +=
          qtyToReserve;

        cantidadFisicaReservada +=
          qtyToReserve;

        preferredWarehouseId =
          Number(
            fullLocation.almacen
          );

        console.log(
          "📉 Restante ubicación:",
          fullLocation.restante
        );
      } else {
        // ====================================
        // CASO 2:
        // DIVIDIR ENTRE VARIAS UBICACIONES
        // ====================================

        console.log(
          "🟡 Ninguna ubicación cubre todo."
        );

        console.log(
          "🟡 Dividiendo reserva entre ubicaciones..."
        );

        for (
          const location of
          moveLines
        ) {
          const locationRemaining =
            Number(
              location.restante || 0
            );

          if (
            !Number.isFinite(
              locationRemaining
            ) ||
            locationRemaining <=
              EPSILON
          ) {
            console.log(
              `⏭️ Location ${location.location_id} restante=0`
            );

            continue;
          }

          const qtyMissing =
            requiredQty -
            reservedForMove;

          if (
            qtyMissing <= EPSILON
          ) {
            break;
          }

          const qtyToReserve =
            Math.min(
              locationRemaining,
              qtyMissing
            );

          if (
            qtyToReserve <= EPSILON
          ) {
            continue;
          }

          console.log(
            "📦 Usando ubicación física:",
            {
              location_id:
                location.location_id,
              restanteAntes:
                locationRemaining,
              faltanteMove:
                qtyMissing,
              qtyToReserve,
            }
          );

          await createStockMoveLine(
            dispatchMove,
            location,
            qtyToReserve
          );

          location.restante =
            locationRemaining -
            qtyToReserve;

          reservedForMove +=
            qtyToReserve;

          physicalReservedForMove +=
            qtyToReserve;

          cantidadReservada +=
            qtyToReserve;

          cantidadFisicaReservada +=
            qtyToReserve;

          if (
            !preferredWarehouseId
          ) {
            preferredWarehouseId =
              Number(
                location.almacen
              );
          }

          console.log(
            "📊 Después de reservar:",
            {
              move_id:
                dispatchMove.move_id,
              reservedForMove,
              requiredQty,
              location_id:
                location.location_id,
              restanteLocation:
                location.restante,
            }
          );

          if (
            reservedForMove >=
            requiredQty - EPSILON
          ) {
            console.log(
              "✅ Movimiento de despacho completamente reservado físicamente"
            );

            break;
          }
        }
      }
    } else {
      console.log(
        "⚪ No hay ubicaciones físicas seleccionadas."
      );
    }

    // ========================================
    // 9. CALCULAR CANTIDAD FALTANTE
    // ========================================

    let missingQty = Math.max(
      requiredQty -
        reservedForMove,
      0
    );

    console.log(
      "🧮 Resultado después de ubicaciones físicas:",
      {
        requiredQty,
        physicalReservedForMove,
        reservedForMove,
        missingQty,
      }
    );

    // ========================================
    // 10. COMPLETAR CON GENERAL
    // ========================================

    if (
      missingQty > EPSILON &&
      allowPickingWithoutLocations
    ) {
      console.log(
        "🟡 Completando faltante con ubicación GENERAL:",
        {
          moveId:
            dispatchMove.move_id,
          missingQty,
          preferredWarehouseId,
        }
      );

      const defaultLocation =
        await resolveGeneralLocation(
          preferredWarehouseId
        );

      await createStockMoveLine(
        dispatchMove,
        defaultLocation,
        missingQty
      );

      generalReservedForMove +=
        missingQty;

      reservedForMove +=
        missingQty;

      cantidadReservada +=
        missingQty;

      cantidadGeneralReservada +=
        missingQty;

      console.log(
        "🟡 Cantidad agregada a GENERAL:",
        {
          moveId:
            dispatchMove.move_id,
          locationId:
            defaultLocation.location_id,
          warehouseId:
            defaultLocation.almacen,
          quantity:
            missingQty,
        }
      );

      missingQty = 0;
    }

    // ========================================
    // 11. DETERMINAR ESTADO DEL MOVIMIENTO
    // ========================================

    let note =
      "Cantidad no reservada";

    let state =
      "confirmed";

    const moveCompletelyCovered =
      reservedForMove >=
      requiredQty - EPSILON;

    if (moveCompletelyCovered) {
      /*
       * Toda la cantidad fue colocada en
       * ubicación GENERAL.
       *
       * Se mantiene confirmed porque no existe
       * una reserva física real.
       */
      if (
        physicalReservedForMove <=
          EPSILON &&
        generalReservedForMove >
          EPSILON
      ) {
        note =
          "Cantidad reservada con ubicación general";

        state =
          "confirmed";
      } else if (
        generalReservedForMove >
          EPSILON
      ) {
        /*
         * Parte física y parte GENERAL.
         *
         * Según el flujo solicitado, se considera
         * cubierta completamente.
         */
        note =
          "Cantidad completa reservada; faltante asignado a ubicación general";

        state =
          "assigned";
      } else {
        /*
         * Toda la cantidad se cubrió usando
         * ubicaciones físicas.
         */
        note =
          "Cantidad completa reservada";

        state =
          "assigned";
      }
    } else if (
      reservedForMove > EPSILON
    ) {
      note =
        "Cantidad parcialmente reservada";

      state =
        "partially_available";
    }

    const finalMissingQty =
      Math.max(
        requiredQty -
          reservedForMove,
        0
      );

    // ========================================
    // 12. ACTUALIZAR DESPACHO_STOCK_MOVE
    // ========================================

    const dispatchMoveId = Number(
      dispatchMove.move_id
    );

    const updateResult =
      await client.query(
        `
          UPDATE despacho_stock_move
          SET
            note = $1,
            state = $2,
            write_date = NOW()
          WHERE id = $3
            AND picking_id = $4
            AND product_id = $5
            AND COALESCE(state, '')
                  NOT IN (
                    'done',
                    'cancel'
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
          note,
          state,
          dispatchMoveId,
          Number(
            move.picking_id
          ),
          Number(
            move.product_id
          ),
        ]
      );

    if (
      updateResult.rowCount !== 1
    ) {
      throw new Error(
        `No se pudo actualizar despacho_stock_move ${dispatchMoveId}.`
      );
    }

    console.log(
      "✅ DESPACHO_STOCK_MOVE ACTUALIZADO:",
      {
        move_id:
          dispatchMoveId,
        requiredQty,
        reservedForMove,
        physicalReservedForMove,
        generalReservedForMove,
        missing:
          finalMissingQty,
        state,
        note,
      }
    );

    moveResults.push({
      move_id:
        dispatchMoveId,
      required:
        requiredQty,
      reserved:
        reservedForMove,
      physical_reserved:
        physicalReservedForMove,
      general_reserved:
        generalReservedForMove,
      missing:
        finalMissingQty,
      uses_general_location:
        generalReservedForMove >
        EPSILON,
      state,
      note,
    });
  }

  // ==========================================
  // 13. CALCULAR CANTIDAD TOTAL SOLICITADA
  // ==========================================

  const totalRequired =
    dispatchMoves.reduce(
      (
        total,
        dispatchMove
      ) => {
        const quantity = Number(
          dispatchMove.pending_qty ??
            dispatchMove.product_qty ??
            0
        );

        if (
          !Number.isFinite(
            quantity
          ) ||
          quantity <= 0
        ) {
          return total;
        }

        return total + quantity;
      },
      0
    );

  const totalMissing =
    Math.max(
      totalRequired -
        cantidadReservada,
      0
    );

  // ==========================================
  // 14. NOTA GENERAL
  // ==========================================

  let generalNote =
    "Cantidad no reservada";

  if (
    cantidadReservada >=
      totalRequired - EPSILON &&
    totalRequired > 0
  ) {
    if (
      cantidadFisicaReservada <=
        EPSILON &&
      cantidadGeneralReservada >
        EPSILON
    ) {
      generalNote =
        "Cantidad reservada con ubicación general";
    } else if (
      cantidadGeneralReservada >
      EPSILON
    ) {
      generalNote =
        "Cantidad completa reservada; faltante asignado a ubicación general";
    } else {
      generalNote =
        "Cantidad completa reservada";
    }
  } else if (
    cantidadReservada >
    EPSILON
  ) {
    generalNote =
      "Cantidad parcialmente reservada";
  }

  console.log("");
  console.log("=======================================");
  console.log("✅ RESERVA FINAL");
  console.log("=======================================");

  console.log({
    sku:
      productSku,
    allow_picking_without_locations:
      allowPickingWithoutLocations,
    totalRequired,
    cantidadReservada,
    cantidadFisicaReservada,
    cantidadGeneralReservada,
    missing:
      totalMissing,
    locations:
      moveLines,
    moves:
      moveResults,
  });

  // ==========================================
  // 15. DEVOLVER RESULTADO
  // ==========================================

  return {
    /*
     * Se conserva "reserved" porque el
     * controller actual utiliza ese campo.
     */
    reserved:
      cantidadReservada,

    physical_reserved:
      cantidadFisicaReservada,

    general_reserved:
      cantidadGeneralReservada,

    required:
      totalRequired,

    missing:
      totalMissing,

    uses_general_location:
      cantidadGeneralReservada >
      EPSILON,

    note:
      generalNote,

    moves:
      moveResults,

    remaining_locations:
      moveLines,
  };
}





//Sevicio de reserva de inventario
/*export async function reserveInventoryForMove(client, move) {

  const productSku = move.sku;
  const stockMove = move.moves[0];
  const moveLines = Array.isArray(move.selected_location)
    ? move.selected_location
    : move.selected_location?.sugerido || [];
  let cantidadReservada = 0;


  
  //3️⃣ ACTUALIZAR RESERVA
  
  const values = [];
  const updates = [];
  const config = await getPickingConfig(client);


  let resultQuery = null; // ✅ AQUÍ
  console.log("🟨🟨 MOVE DE reserveInventoryForMove: ", move);
  console.log("🟨🟨 stockMove DE reserveInventoryForMove: ", stockMove);

  if (!moveLines || moveLines.length === 0) {
    console.log("⚠️ No hay líneas para reservar");

    // ==============================
    // 6️⃣ CONFIG + FALLBACK
    // ==============================


    //let defaultLocation = null;

    if (config.allow_picking_without_locations) {
      //const warehouseId = inventoryResult.rows[0]?.warehouse_id || 1;
      //defaultLocation = await getOrCreateDefaultLocation(client, warehouseId);
      console.log("🟥🟨 CONTINUAMOS");
    } else {
      console.log("🟥🟨 DEVUELVES");
      return { reserved: 0, note: "Sin líneas" };
    }
  }


  if (1 == 1) {
    console.log("🟥🟨 CONTINUAMOS");
  } else {
    moveLines.forEach((row, index) => {
      const i = index * 4;
      console.log("ROW ROW ROW ROW", row);
      values.push(
        Number(row.quantity_taken),
        productSku,
        Number(row.almacen),
        Number(row.location_id)
      );

      updates.push(`
    (product_sku = $${i + 2}
     AND warehouse_id = $${i + 3}
     AND location_id = $${i + 4})
  `);
    });

    console.log("🟥🟥VALUES DE reserveInventoryForMove: ", values);



    resultQuery = await client.query(
      `
  UPDATE inventory_by_location ibl
  SET 
    qty_reserved = ibl.qty_reserved + LEAST(ibl.qty_available, data.qty)
  FROM (
    VALUES ${moveLines
        .map((_, i) => `($${i * 4 + 1}::int, $${i * 4 + 2}::text, $${i * 4 + 3}::int, $${i * 4 + 4}::int)`)
        .join(",")}
  ) AS data(qty, sku, warehouse_id, location_id)
  WHERE ibl.product_sku = data.sku
    AND ibl.warehouse_id = data.warehouse_id
    AND ibl.location_id = data.location_id
    AND ibl.qty_available > 0
  RETURNING 
    ibl.location_id,
    ibl.qty_reserved,
    ibl.qty_available
  `,
      values
    );

  }




  console.log("🟥🟥RESULT DE VALUES DE reserveInventoryForMove: ", resultQuery);

  //2️⃣ RECORRER INVENTARIO

  console.log("🟨🟨 MOVE LINES DE reserveInventoryForMove: ", moveLines);
  // ===============================
  // PICKING SIN UBICACIONES
  // ===============================
  if (config.allow_picking_without_locations) {

    console.log("⚠️ Picking sin ubicaciones habilitado");


    // ===============================
    // VALIDAR SI YA EXISTE MOVE LINE
    // ===============================
    const existingMoveLine = await client.query(`
  SELECT id
  FROM stock_move_line
  WHERE move_id = $1
  AND picking_id = $2
`, [
      stockMove.move_id,
      move.picking_id
    ]);

    if (existingMoveLine.rows.length > 0) {
      console.log("⚠️ Move line ya existe");

      return {
        reserved: 0,
        note: "Move line ya existe"
      };
    }


    // ===============================
    // PICKING SIN UBICACIONES
    // ===============================

    await client.query(`
    INSERT INTO stock_move_line
    (
      move_id,
      picking_id,
      product_id,
      product_uom_id,
      warehouse_id,
      location_id,
      product_uom_qty,
      state
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
  `, [
      Number(stockMove.move_id),
      Number(move.picking_id),
      Number(move.product_id),
      Number(stockMove.move_product_uom_id),

      // fallback location
      Number(move.locations[0].almacen),
      Number(move.locations[0].location_id),

      // cantidad completa del move
      Number(stockMove.product_qty),

      "assigned"
    ]);

    cantidadReservada = Number(stockMove.product_qty);

    console.log(`📦 Reservado SIN LOCATION ${stockMove.product_qty}`);

  } else {

    // ===============================
    // PICKING NORMAL CON UBICACIONES
    // ===============================
    for (const row of moveLines) {

      await client.query(`
      INSERT INTO stock_move_line
      (
        move_id,
        picking_id,
        product_id,
        product_uom_id,
        warehouse_id,
        location_id,
        product_uom_qty,
        state
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `, [
        Number(stockMove.move_id),
        Number(move.picking_id),
        Number(move.product_id),
        Number(stockMove.move_product_uom_id),

        Number(row.almacen),
        Number(row.location_id),
        Number(row.quantity_taken),

        "assigned"
      ]);

      cantidadReservada += Number(row.quantity_taken);

      console.log(
        `📦 Reservado ${row.quantity_taken} en location ${row.location_id}`
      );

      if (cantidadReservada >= Number(stockMove.product_qty)) {
        break;
      }
    }
  }

  //===============================
  //5️⃣ DETERMINAR RESULTADO
  //===============================

  let note = "";

  if (cantidadReservada === parseInt(stockMove.product_qty)) {

    note = "Cantidad completa reservada";

  } else if (cantidadReservada > 0) {

    note = "Cantidad parcialmente reservada";

  } else {

    note = "Cantidad no reservada";
  }

  //===============================
 //6️⃣ ACTUALIZAR STOCK MOVE
 // ===============================
  let state = "confirmed";
  if (cantidadReservada === parseInt(stockMove.product_qty)) {
    state = "assigned";
  } else if (cantidadReservada > 0) {
    state = "partially_available";
  }

  await client.query(`
    UPDATE stock_move
    SET 
        reserved_qty = $1,
        note = $2,
        state = $3
    WHERE id = $4
`, [cantidadReservada, note, state, stockMove.move_id]);

  return {
    reserved: cantidadReservada,
    note
  };
}*/


// =====================================================
// OBTENER STOCK MOVE LINES ORDENADAS POR UBICACIÓN
// =====================================================

export async function getMoveLinesOrderedByLocation(
  client,
  pickingId
) {
  const result = await client.query(
    `
    SELECT
      sml.id,
      sml.move_id,
      sml.picking_id,
      sml.product_id,
      sml.product_uom_id,

      sml.product_uom_qty,
      sml.qty_done,

      sml.location_id,
      sml.warehouse_id,

      sml.is_general,
      sml.source_move_line_id,
      sml.available_locations,
      sml.max_product_qty,

      l.tramo,
      l.nivel,
      l.code,

      p.sku,
      p.description,
      p.erp_name,
      p.erp_sku,
      p.erp_id

    FROM stock_move_line AS sml

    INNER JOIN locations AS l
      ON l.id = sml.location_id
     AND l.warehouse_id = sml.warehouse_id

    INNER JOIN products AS p
      ON p.id = sml.product_id

    WHERE sml.picking_id = $1
      AND sml.state NOT IN ('done', 'cancel')
      AND (
        sml.product_uom_qty > 0
        OR sml.qty_done > 0
      )

    ORDER BY
      sml.is_general ASC,
      l.tramo DESC,
      l.nivel DESC,
      sml.id ASC
    `,
    [pickingId]
  );

  return result.rows;
}




//Servicio para obtener congifuracion de picking inicial
export async function getPickingConfig(client) {
  try {
    const result = await client.query(`
      SELECT allow_picking_without_locations
      FROM companies
      LIMIT 1
    `);

    // 🔹 Si no hay registro → default
    if (result.rows.length === 0) {
      return {
        allow_picking_without_locations: false
      };
    }

    return {
      allow_picking_without_locations:
        result.rows[0].allow_picking_without_locations ?? false
    };

  } catch (error) {
    console.error("❌ Error getPickingConfig:", error.message);

    return {
      allow_picking_without_locations: false
    };
  }
}

export async function cancelOpenGeneralMoveLinesForPicking(
  client,
  pickingId
) {
  const normalizedPickingId =
    Number(pickingId);

  if (
    !Number.isSafeInteger(
      normalizedPickingId
    ) ||
    normalizedPickingId <= 0
  ) {
    throw new Error(
      `pickingId inválido: ${pickingId}`
    );
  }

  console.log(
    "🚫 Revisando líneas GENERAL porque allow_picking_without_locations=false"
  );

  // ===================================================
  // 1. CANCELAR LÍNEAS GENERAL ABIERTAS
  // ===================================================

  /*
   * Solamente cancela líneas que:
   *
   * - Pertenecen al picking.
   * - Pertenecen a un despacho_stock_move.
   * - El producto de la línea coincide con el movimiento.
   * - Están en una ubicación GENERAL.
   * - No tienen cantidad recogida.
   * - No están canceladas ni terminadas.
   * - Su despacho_stock_move sigue activo.
   */
  const cancelledResult =
    await client.query(
      `
        UPDATE stock_move_line AS sml

        SET
          state = 'cancel',
          write_date = NOW()

        FROM
          locations AS l,
          despacho_stock_move AS dsm

        WHERE sml.picking_id = $1

          AND dsm.id =
              sml.move_id

          AND dsm.picking_id =
              sml.picking_id

          AND dsm.product_id =
              sml.product_id

          AND COALESCE(
            dsm.state,
            ''
          ) NOT IN (
            'cancel',
            'done'
          )

          AND l.id =
              sml.location_id

          AND l.warehouse_id =
              sml.warehouse_id

          AND UPPER(
            COALESCE(
              l.code,
              ''
            )
          ) LIKE 'GENERAL-%'

          AND COALESCE(
            sml.qty_done,
            0
          ) = 0

          AND COALESCE(
            sml.state,
            ''
          ) NOT IN (
            'cancel',
            'done'
          )

        RETURNING
          sml.id,
          sml.move_id,
          sml.picking_id,
          sml.product_id,
          sml.product_uom_qty,
          sml.qty_done,
          sml.location_id,
          sml.warehouse_id,
          sml.state
      `,
      [
        normalizedPickingId
      ]
    );

  const cancelledLines =
    cancelledResult.rows;

  console.log(
    "🚫 Líneas GENERAL canceladas:",
    cancelledLines
  );

  // ===================================================
  // 2. SI NO SE CANCELÓ NADA, TERMINAR
  // ===================================================

  if (
    cancelledLines.length === 0
  ) {
    return {
      changed: false,
      cancelledLines: 0,
      affectedMoves: [],
    };
  }

  // ===================================================
  // 3. OBTENER IDs ÚNICOS DE MOVIMIENTOS AFECTADOS
  // ===================================================

  const affectedMoveIds = [
    ...new Set(
      cancelledLines
        .map(
          (line) =>
            Number(
              line.move_id
            )
        )
        .filter(
          (moveId) =>
            Number.isSafeInteger(
              moveId
            ) &&
            moveId > 0
        )
    ),
  ];

  if (
    affectedMoveIds.length === 0
  ) {
    throw new Error(
      "Las líneas GENERAL canceladas no tienen move_id válido."
    );
  }

  console.log(
    "📦 despacho_stock_move afectados:",
    affectedMoveIds
  );

  // ===================================================
  // 4. BUSCAR Y BLOQUEAR despacho_stock_move
  // ===================================================

  const movesResult =
    await client.query(
      `
        SELECT
          id,
          picking_id,
          product_id,
          product_qty,
          quantity_done,
          pending_qty,
          state,
          note
        FROM despacho_stock_move
        WHERE picking_id = $1
          AND id = ANY(
            $2::bigint[]
          )
        FOR UPDATE
      `,
      [
        normalizedPickingId,
        affectedMoveIds,
      ]
    );

  /*
   * Validar que todos los move_id cancelados
   * realmente pertenezcan a despacho_stock_move.
   */
  const foundMoveIds =
    new Set(
      movesResult.rows.map(
        (move) =>
          Number(move.id)
      )
    );

  const missingMoveIds =
    affectedMoveIds.filter(
      (moveId) =>
        !foundMoveIds.has(
          moveId
        )
    );

  if (
    missingMoveIds.length > 0
  ) {
    throw new Error(
      `No se encontraron los siguientes movimientos ` +
      `en despacho_stock_move: ${missingMoveIds.join(", ")}`
    );
  }

  const affectedMoves = [];

  // ===================================================
  // 5. RECALCULAR CADA despacho_stock_move
  // ===================================================

  for (
    const dispatchMove of
    movesResult.rows
  ) {
    const moveId =
      Number(
        dispatchMove.id
      );

    const productId =
      Number(
        dispatchMove.product_id
      );

    /*
     * En despacho_stock_move:
     *
     * product_qty:
     * Cantidad originalmente ordenada.
     *
     * quantity_done:
     * Cantidad completada informada por ADM Cloud.
     *
     * pending_qty:
     * Cantidad que todavía necesita despacharse.
     *
     * Por eso la cantidad requerida para este proceso
     * es pending_qty.
     */
    const orderedQty =
      Number(
        dispatchMove.product_qty ||
        0
      );

    const erpCompletedQty =
      Number(
        dispatchMove.quantity_done ||
        0
      );

    const requiredQty =
      Number(
        dispatchMove.pending_qty ||
        0
      );

    if (
      !Number.isFinite(
        requiredQty
      ) ||
      requiredQty < 0
    ) {
      throw new Error(
        `pending_qty inválido en despacho_stock_move ${moveId}.`
      );
    }

    /*
     * No modificar movimientos ya finalizados.
     *
     * En condiciones normales esto no debería ocurrir,
     * porque la consulta que canceló las líneas solamente
     * tomó movimientos activos.
     */
    if (
      ["done", "cancel"].includes(
        dispatchMove.state
      )
    ) {
      affectedMoves.push({
        move_id: moveId,
        product_id: productId,
        skipped: true,
        required: requiredQty,
        ordered: orderedQty,
        erp_completed: erpCompletedQty,
        state:
          dispatchMove.state,
        note:
          "Movimiento finalizado; no fue recalculado.",
      });

      continue;
    }

    // =================================================
    // 6. CALCULAR COBERTURA ACTUAL
    // =================================================

    const coverageResult =
      await client.query(
        `
          SELECT
            COALESCE(
              SUM(
                CASE
                  WHEN COALESCE(
                    sml.state,
                    ''
                  ) <> 'cancel'

                  AND COALESCE(
                    sml.qty_done,
                    0
                  ) > 0

                  THEN sml.qty_done

                  ELSE 0
                END
              ),
              0
            ) AS done_qty,

            COALESCE(
              SUM(
                CASE
                  WHEN COALESCE(
                    sml.state,
                    ''
                  ) NOT IN (
                    'cancel',
                    'done'
                  )

                  AND COALESCE(
                    sml.qty_done,
                    0
                  ) = 0

                  THEN sml.product_uom_qty

                  ELSE 0
                END
              ),
              0
            ) AS open_reserved_qty

          FROM stock_move_line AS sml

          WHERE sml.picking_id = $1

            AND sml.move_id = $2

            AND sml.product_id = $3
        `,
        [
          normalizedPickingId,
          moveId,
          productId,
        ]
      );

    const doneQty =
      Number(
        coverageResult.rows[0]
          ?.done_qty || 0
      );

    const openReservedQty =
      Number(
        coverageResult.rows[0]
          ?.open_reserved_qty || 0
      );

    /*
     * Cantidad cubierta por:
     *
     * - Unidades recogidas.
     * - Reservas abiertas.
     */
    const coveredQty =
      doneQty +
      openReservedQty;

    const missingQty =
      Math.max(
        requiredQty -
        coveredQty,
        0
      );

    // =================================================
    // 7. DETERMINAR ESTADO DEL MOVIMIENTO
    // =================================================

    let state =
      "confirmed";

    let note =
      "Cantidad no reservada";

    if (
      requiredQty <= 0
    ) {
      /*
       * ADM Cloud indica que no queda cantidad pendiente.
       */
      state =
        "done";

      note =
        "Sin cantidad pendiente de despacho";
    } else if (
      coveredQty >=
      requiredQty
    ) {
      state =
        "assigned";

      note =
        "Cantidad completa reservada";
    } else if (
      coveredQty > 0
    ) {
      state =
        "partially_available";

      note =
        "Cantidad parcialmente reservada";
    }

    // =================================================
    // 8. ACTUALIZAR despacho_stock_move
    // =================================================

    /*
     * IMPORTANTE:
     *
     * No actualizamos pending_qty con openReservedQty.
     *
     * pending_qty viene de ADM Cloud y representa la
     * cantidad pendiente por despachar.
     *
     * openReservedQty representa solamente lo reservado
     * físicamente dentro del WMS.
     */
    const updateResult =
      await client.query(
        `
          UPDATE despacho_stock_move

          SET
            state = $1,
            note = $2,
            write_date = NOW()

          WHERE id = $3
            AND picking_id = $4
            AND product_id = $5
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
          normalizedPickingId,
          productId,
        ]
      );

    /*
     * Si requiredQty era cero, state se determinó como done.
     * La condición del WHERE evalúa el estado anterior,
     * por lo que permite actualizarlo correctamente.
     */
    if (
      updateResult.rows.length !== 1
    ) {
      throw new Error(
        `No se pudo actualizar despacho_stock_move ${moveId}.`
      );
    }

    const moveSummary = {
      move_id:
        moveId,

      product_id:
        productId,

      ordered:
        orderedQty,

      erp_completed:
        erpCompletedQty,

      required:
        requiredQty,

      picked:
        doneQty,

      reserved:
        openReservedQty,

      covered:
        coveredQty,

      missing:
        missingQty,

      state,

      note,
    };

    affectedMoves.push(
      moveSummary
    );

    console.log(
      "✅ despacho_stock_move recalculado:",
      moveSummary
    );
  }

  // ===================================================
  // 9. DEVOLVER RESULTADO
  // ===================================================

  return {
    changed: true,

    cancelledLines:
      cancelledLines.length,

    affectedMoves,
  };
}
































export async function getOrCreateDefaultLocation(
  client,
  warehouseId
) {
  try {
    const normalizedWarehouseId =
      Number(warehouseId);

    if (
      !Number.isInteger(normalizedWarehouseId) ||
      normalizedWarehouseId <= 0
    ) {
      throw new Error(
        `warehouseId inválido: ${warehouseId}`
      );
    }

    const generalCode =
      `GENERAL-${normalizedWarehouseId}`;

    console.log(
      "🔎 Buscando ubicación GENERAL:",
      {
        warehouseId: normalizedWarehouseId,
        code: generalCode,
      }
    );

    // ========================================
    // 1. BUSCAR POR LA CLAVE ÚNICA REAL
    // ========================================

    const existingResult =
      await client.query(
        `
          SELECT
            id,
            code,
            warehouse_id,
            location_type,
            tramo,
            nivel
          FROM locations
          WHERE warehouse_id = $1
            AND code = $2
          LIMIT 1
          FOR UPDATE
        `,
        [
          normalizedWarehouseId,
          generalCode,
        ]
      );

    if (existingResult.rows.length === 1) {
      const existingLocation =
        existingResult.rows[0];

      console.log(
        "✅ Ubicación GENERAL existente:",
        existingLocation
      );

      /*
       * No se modifica tramo ni nivel.
       * Esto evita colisionar con otra GENERAL
       * que tenga 999/999.
       */
      return existingLocation;
    }

    // ========================================
    // 2. CREAR SI NO EXISTE
    // ========================================

    /*
 * GENERAL es una ubicación virtual usada cuando
 * se permite preparar el picking sin existencia
 * registrada en una ubicación física.
 *
 * Se utiliza PICKING porque STORAGE requiere
 * tramo y nivel según check_tramo_nivel_storage.
 */
    const insertResult =
  await client.query(
    `
      INSERT INTO locations (
        code,
        warehouse_id,
        location_type,
        tramo,
        nivel
      )
      VALUES (
        $1,
        $2,
        'PICKING',
        NULL,
        NULL
      )

      ON CONFLICT (
        warehouse_id,
        code
      )
      DO UPDATE SET
        code = EXCLUDED.code

      RETURNING
        id,
        code,
        warehouse_id,
        location_type,
        tramo,
        nivel
    `,
    [
      generalCode,
      normalizedWarehouseId,
    ]
  );

    if (insertResult.rows.length !== 1) {
      throw new Error(
        `No se pudo obtener la ubicación ${generalCode}.`
      );
    }

    const defaultLocation =
      insertResult.rows[0];

    console.log(
      "✅ Ubicación GENERAL creada:",
      defaultLocation
    );

    return defaultLocation;
  } catch (error) {
    console.error(
      "❌ Error getOrCreateDefaultLocation:",
      {
        warehouseId,
        code:
          Number.isFinite(Number(warehouseId))
            ? `GENERAL-${Number(warehouseId)}`
            : null,
        message: error.message,
        postgresCode: error.code,
        detail: error.detail,
        constraint: error.constraint,
      }
    );

    throw error;
  }
}









export async function redistributeExactMoveFromGeneral(
  client,
  product,
  stockMove
) {
  const EPSILON = 0.000001;

  const moveId =
    Number(stockMove.move_id);

  const requiredQty =
    Number(stockMove.product_qty || 0);

  if (
    !Number.isInteger(moveId) ||
    moveId <= 0
  ) {
    throw new Error(
      "move_id inválido para redistribuir."
    );
  }

  if (
    !Number.isFinite(requiredQty) ||
    requiredQty <= 0
  ) {
    return {
      redistributed: false,
      skipped: true,
      reason: "INVALID_REQUIRED_QTY",
    };
  }

  console.log("");
  console.log(
    "🔄 ---- redistributeExactMoveFromGeneral ----"
  );

  console.log("📦 Datos:", {
    moveId,
    productId: product.product_id,
    sku: product.sku,
    requiredQty,
  });

  // ==========================================
  // 1. OBTENER DISTRIBUCIÓN FÍSICA DESEADA
  // ==========================================

  const selectedLocations =
    Array.isArray(product.selected_location)
      ? product.selected_location
      : Array.isArray(
            product.selected_location?.sugerido
          )
        ? product.selected_location.sugerido
        : [];

  /*
   * Evita que las ubicaciones sugeridas excedan
   * la cantidad requerida del stock_move.
   */
  let remainingDesiredQty =
    requiredQty;

  const desiredPhysicalLocations = [];

  for (const location of selectedLocations) {
    if (
      remainingDesiredQty <= EPSILON
    ) {
      break;
    }

    const locationId =
      Number(location.location_id);

    const warehouseId =
      Number(
        location.almacen ??
          location.warehouse_id
      );

    const suggestedQty =
      Number(
        location.quantity_taken || 0
      );

    if (
      !Number.isInteger(locationId) ||
      locationId <= 0 ||
      !Number.isInteger(warehouseId) ||
      warehouseId <= 0 ||
      !Number.isFinite(suggestedQty) ||
      suggestedQty <= EPSILON
    ) {
      continue;
    }

    const quantityToUse =
      Math.min(
        suggestedQty,
        remainingDesiredQty
      );

    desiredPhysicalLocations.push({
      location_id: locationId,
      almacen: warehouseId,
      quantity_taken:
        quantityToUse,
    });

    remainingDesiredQty -=
      quantityToUse;
  }

  console.log(
    "📍 Distribución física deseada:",
    desiredPhysicalLocations
  );

  // ==========================================
  // 2. OBTENER LÍNEAS ACTUALES
  // ==========================================

  const currentLinesResult =
    await client.query(
      `
        SELECT
          sml.id,
          sml.move_id,
          sml.product_uom_qty,
          sml.qty_done,
          sml.location_id,
          sml.warehouse_id,
          sml.state,
          l.code,
          l.location_type,
          l.tramo,
          l.nivel
        FROM stock_move_line AS sml
        JOIN locations AS l
          ON l.id = sml.location_id
         AND l.warehouse_id =
             sml.warehouse_id
        WHERE sml.move_id = $1
          AND COALESCE(
            sml.state,
            ''
          ) NOT IN (
            'cancel',
            'done'
          )
        ORDER BY sml.id ASC
        FOR UPDATE OF sml
      `,
      [moveId]
    );

  const currentLines =
    currentLinesResult.rows;

  if (currentLines.length === 0) {
    return {
      redistributed: false,
      skipped: true,
      reason: "NO_EXISTING_LINES",
    };
  }

  console.log(
    "📦 Líneas actuales:",
    currentLines
  );

  // ==========================================
  // 3. PROTEGER LÍNEAS YA PICHEADAS
  // ==========================================

  const processedLines =
    currentLines.filter(
      (line) =>
        Number(line.qty_done || 0) >
        EPSILON
    );

  if (processedLines.length > 0) {
    console.log(
      "⛔ No se redistribuye porque existen líneas con qty_done > 0:",
      processedLines
    );

    return {
      redistributed: false,
      skipped: true,
      reason: "HAS_PROCESSED_LINES",
      processedLines:
        processedLines.map(
          (line) => line.id
        ),
    };
  }

  // ==========================================
  // 4. CONFIRMAR QUE EXISTE GENERAL
  // ==========================================

  const generalLines =
    currentLines.filter(
      (line) =>
        String(line.code || "")
          .toUpperCase()
          .startsWith("GENERAL-")
    );

  if (generalLines.length === 0) {
    return {
      redistributed: false,
      skipped: true,
      reason: "NO_GENERAL_LINES",
    };
  }

  const previousGeneralQty =
    generalLines.reduce(
      (total, line) =>
        total +
        Number(
          line.product_uom_qty || 0
        ),
      0
    );

  // ==========================================
  // 5. COMPARAR DISTRIBUCIÓN ACTUAL
  // ==========================================

  const desiredPhysicalMap =
    new Map();

  for (
    const location of
    desiredPhysicalLocations
  ) {
    const key =
      `${location.almacen}:` +
      `${location.location_id}`;

    desiredPhysicalMap.set(
      key,
      (
        desiredPhysicalMap.get(key) ||
        0
      ) +
        Number(
          location.quantity_taken
        )
    );
  }

  const currentPhysicalMap =
    new Map();

  for (const line of currentLines) {
    const isGeneral =
      String(line.code || "")
        .toUpperCase()
        .startsWith("GENERAL-");

    if (isGeneral) {
      continue;
    }

    const key =
      `${line.warehouse_id}:` +
      `${line.location_id}`;

    currentPhysicalMap.set(
      key,
      (
        currentPhysicalMap.get(key) ||
        0
      ) +
        Number(
          line.product_uom_qty || 0
        )
    );
  }

  const allPhysicalKeys =
    new Set([
      ...desiredPhysicalMap.keys(),
      ...currentPhysicalMap.keys(),
    ]);

  let physicalDistributionChanged =
    false;

  for (const key of allPhysicalKeys) {
    const desiredQty =
      desiredPhysicalMap.get(key) || 0;

    const currentQty =
      currentPhysicalMap.get(key) || 0;

    if (
      Math.abs(
        desiredQty - currentQty
      ) > EPSILON
    ) {
      physicalDistributionChanged =
        true;

      break;
    }
  }

  console.log(
    "🧮 Comparación de distribución:",
    {
      desired:
        Object.fromEntries(
          desiredPhysicalMap
        ),
      current:
        Object.fromEntries(
          currentPhysicalMap
        ),
      changed:
        physicalDistributionChanged,
    }
  );

  /*
   * Ejemplo después de redistribuir:
   *
   * Actual:
   *   physical 248 = 5
   *   GENERAL-1 = 7
   *
   * Deseado:
   *   physical 248 = 5
   *
   * Como la parte física es igual,
   * no se vuelve a cancelar y crear.
   */
  if (!physicalDistributionChanged) {
    console.log(
      "✅ La distribución física ya está correcta."
    );

    return {
      redistributed: false,
      skipped: true,
      reason:
        "DISTRIBUTION_ALREADY_CORRECT",
    };
  }

  // ==========================================
  // 6. CANCELAR LÍNEAS ABIERTAS ANTERIORES
  // ==========================================

  /*
   * Estas líneas tienen qty_done = 0.
   * Por eso pueden reorganizarse sin perder
   * trabajo realizado por el picker.
   */
  const cancelledResult =
    await client.query(
      `
        UPDATE stock_move_line
        SET
          state = 'cancel',
          write_date = NOW()
        WHERE move_id = $1
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
          location_id,
          warehouse_id,
          product_uom_qty
      `,
      [moveId]
    );

  console.log(
    "🚫 Líneas anteriores canceladas:",
    cancelledResult.rows
  );

  // ==========================================
  // 7. CREAR LA NUEVA DISTRIBUCIÓN
  // ==========================================

  /*
   * reserveInventoryForMove hará:
   *
   * - Crear las líneas físicas primero.
   * - Completar el faltante con GENERAL.
   * - Actualizar reserved_qty y state.
   */
  const reservationResult =
    await reserveInventoryForMove(
      client,
      {
        ...product,
        moves: [
          {
            ...stockMove,
            product_qty:
              requiredQty,
          },
        ],
      }
    );

  console.log(
    "✅ Movimiento redistribuido:",
    reservationResult
  );

  return {
    redistributed: true,
    skipped: false,
    case:
      "ORDER_EXACT_REDISTRIBUTED",
    previousGeneralQty,
    cancelledLines:
      cancelledResult.rowCount,
    ...reservationResult,
  };
}













export async function reconcileExactMoveLocations(
  client,
  product,
  stockMove
) {
  const EPSILON = 0.000001;

  const moveId = Number(
    stockMove?.move_id
  );

  const pickingId = Number(
    product?.picking_id
  );

  const productId = Number(
    product?.product_id
  );

  const productUomId = Number(
    stockMove?.move_product_uom_id
  );

  const requiredQty = Number(
    stockMove?.product_qty || 0
  );

  if (
    !Number.isSafeInteger(moveId) ||
    moveId <= 0
  ) {
    throw new Error(
      "move_id inválido para reconciliar ubicaciones."
    );
  }

  if (
    !Number.isSafeInteger(pickingId) ||
    pickingId <= 0
  ) {
    throw new Error(
      "picking_id inválido para reconciliar ubicaciones."
    );
  }

  if (
    !Number.isSafeInteger(productId) ||
    productId <= 0
  ) {
    throw new Error(
      "product_id inválido para reconciliar ubicaciones."
    );
  }

  if (
    !Number.isSafeInteger(productUomId) ||
    productUomId <= 0
  ) {
    throw new Error(
      "product_uom_id inválido para reconciliar ubicaciones."
    );
  }

  if (
    !Number.isFinite(requiredQty) ||
    requiredQty <= 0
  ) {
    return {
      redistributed: false,
      changed: false,
      reason: "INVALID_REQUIRED_QTY",
    };
  }

  console.log("");
  console.log(
    "🔄 ---- reconcileExactMoveLocations ----"
  );

  console.log("📦 Movimiento:", {
    moveId,
    pickingId,
    productId,
    sku: product?.sku,
    requiredQty,
  });

  // =====================================================
  // 1. NORMALIZAR selected_location
  // =====================================================

  /*
   * selectBestLocation puede devolver:
   *
   * Caso una ubicación:
   * {
   *   sugerido: [...]
   * }
   *
   * Caso dividido:
   * [...]
   *
   * Caso insuficiente:
   * {
   *   error: "...",
   *   sugerido: [...]
   * }
   */
  const selectedLocations =
    Array.isArray(
      product?.selected_location
    )
      ? product.selected_location
      : Array.isArray(
            product?.selected_location
              ?.sugerido
          )
        ? product.selected_location
            .sugerido
        : [];

  if (
    selectedLocations.length === 0
  ) {
    return {
      redistributed: false,
      changed: false,
      reason:
        "NO_SELECTED_LOCATIONS",
    };
  }

  // =====================================================
  // 2. CONSTRUIR DISTRIBUCIÓN DESEADA
  // =====================================================

  const desiredMap = new Map();

  let remainingRequired =
    requiredQty;

  for (
    const location of
    selectedLocations
  ) {
    if (
      remainingRequired <= EPSILON
    ) {
      break;
    }

    const locationId = Number(
      location.location_id ??
        location.id
    );

    const warehouseId = Number(
      location.almacen ??
        location.warehouse_id
    );

    const suggestedQty = Number(
      location.quantity_taken ??
        location.quantity ??
        0
    );

    if (
      !Number.isSafeInteger(
        locationId
      ) ||
      locationId <= 0 ||
      !Number.isSafeInteger(
        warehouseId
      ) ||
      warehouseId <= 0 ||
      !Number.isFinite(
        suggestedQty
      ) ||
      suggestedQty <= EPSILON
    ) {
      continue;
    }

    const quantityToUse =
      Math.min(
        suggestedQty,
        remainingRequired
      );

    const key =
      `${warehouseId}:` +
      `${locationId}`;

    if (!desiredMap.has(key)) {
      desiredMap.set(key, {
        key,
        warehouse_id:
          warehouseId,
        location_id:
          locationId,
        product_uom_qty: 0,
        qty_done: 0,
      });
    }

    desiredMap.get(
      key
    ).product_uom_qty +=
      quantityToUse;

    remainingRequired -=
      quantityToUse;
  }

  /*
   * No modificar las líneas cuando las ubicaciones
   * sugeridas no pueden cubrir la cantidad completa.
   */
  if (
    remainingRequired > EPSILON
  ) {
    console.log(
      "⚠️ No se redistribuye: las ubicaciones sugeridas no cubren la cantidad completa.",
      {
        requiredQty,
        missingQty:
          remainingRequired,
      }
    );

    return {
      redistributed: false,
      changed: false,
      reason:
        "INSUFFICIENT_SELECTED_LOCATIONS",
      requiredQty,
      missingQty:
        remainingRequired,
    };
  }

  const desiredRows =
    Array.from(
      desiredMap.values()
    );

  console.log(
    "📍 Distribución física deseada:"
  );

  console.table(
    desiredRows.map(
      (row) => ({
        warehouse_id:
          row.warehouse_id,
        location_id:
          row.location_id,
        product_uom_qty:
          row.product_uom_qty,
      })
    )
  );

  // =====================================================
  // 3. OBTENER Y BLOQUEAR LÍNEAS ACTUALES
  // =====================================================

  const currentResult =
    await client.query(
      `
        SELECT
          id,
          move_id,
          picking_id,
          product_id,
          product_uom_id,
          product_uom_qty,
          qty_done,
          warehouse_id,
          location_id,
          state,
          user_id
        FROM stock_move_line
        WHERE move_id = $1
          AND picking_id = $2
          AND COALESCE(
            state,
            ''
          ) NOT IN (
            'cancel',
            'done'
          )
        ORDER BY id ASC
        FOR UPDATE
      `,
      [
        moveId,
        pickingId,
      ]
    );

  const currentLines =
    currentResult.rows;

  if (
    currentLines.length === 0
  ) {
    return {
      redistributed: false,
      changed: false,
      reason:
        "NO_ACTIVE_MOVE_LINES",
    };
  }

  console.log(
    "📦 Distribución actual:"
  );

  console.table(
    currentLines.map(
      (line) => ({
        id: line.id,
        warehouse_id:
          line.warehouse_id,
        location_id:
          line.location_id,
        product_uom_qty:
          line.product_uom_qty,
        qty_done:
          line.qty_done,
        state:
          line.state,
      })
    )
  );

  // =====================================================
  // 4. AGRUPAR DISTRIBUCIÓN ACTUAL
  // =====================================================

  const currentMap =
    new Map();

  let totalCurrentDone = 0;

  for (
    const line of currentLines
  ) {
    const warehouseId = Number(
      line.warehouse_id
    );

    const locationId = Number(
      line.location_id
    );

    const assignedQty = Number(
      line.product_uom_qty || 0
    );

    const doneQty = Number(
      line.qty_done || 0
    );

    if (
      !Number.isFinite(
        assignedQty
      ) ||
      !Number.isFinite(doneQty)
    ) {
      throw new Error(
        `La línea ${line.id} tiene cantidades inválidas.`
      );
    }

    const key =
      `${warehouseId}:` +
      `${locationId}`;

    if (!currentMap.has(key)) {
      currentMap.set(key, {
        product_uom_qty: 0,
        qty_done: 0,
      });
    }

    const current =
      currentMap.get(key);

    current.product_uom_qty +=
      assignedQty;

    current.qty_done +=
      doneQty;

    totalCurrentDone +=
      doneQty;
  }

  /*
   * qty_done es una lectura temporal.
   * Nunca se conservará una cantidad mayor
   * que la nueva cantidad requerida.
   */
  let remainingDone =
    Math.min(
      totalCurrentDone,
      requiredQty
    );

  // =====================================================
  // 5. CONSERVAR qty_done EN SU UBICACIÓN CUANDO SEA POSIBLE
  // =====================================================

  for (
    const desired of desiredRows
  ) {
    const current =
      currentMap.get(
        desired.key
      );

    const currentDoneAtLocation =
      Number(
        current?.qty_done || 0
      );

    const qtyToKeep =
      Math.min(
        currentDoneAtLocation,
        desired.product_uom_qty,
        remainingDone
      );

    desired.qty_done =
      qtyToKeep;

    remainingDone -=
      qtyToKeep;
  }

  /*
   * Si todavía queda qty_done por distribuir,
   * se reparte entre las nuevas ubicaciones.
   */
  for (
    const desired of desiredRows
  ) {
    if (
      remainingDone <= EPSILON
    ) {
      break;
    }

    const availableCapacity =
      desired.product_uom_qty -
      desired.qty_done;

    if (
      availableCapacity <= EPSILON
    ) {
      continue;
    }

    const qtyToMove =
      Math.min(
        availableCapacity,
        remainingDone
      );

    desired.qty_done +=
      qtyToMove;

    remainingDone -=
      qtyToMove;
  }

  console.log(
    "📍 Distribución deseada con qty_done:"
  );

  console.table(
    desiredRows.map(
      (row) => ({
        warehouse_id:
          row.warehouse_id,
        location_id:
          row.location_id,
        product_uom_qty:
          row.product_uom_qty,
        qty_done:
          row.qty_done,
      })
    )
  );

  // =====================================================
  // 6. COMPARAR DISTRIBUCIÓN ACTUAL VS DESEADA
  // =====================================================

  const allKeys =
    new Set([
      ...currentMap.keys(),
      ...desiredMap.keys(),
    ]);

  let distributionChanged =
    false;

  for (const key of allKeys) {
    const current =
      currentMap.get(key);

    const desired =
      desiredMap.get(key);

    const currentAssigned =
      Number(
        current?.product_uom_qty ||
          0
      );

    const desiredAssigned =
      Number(
        desired?.product_uom_qty ||
          0
      );

    const currentDone =
      Number(
        current?.qty_done || 0
      );

    const desiredDone =
      Number(
        desired?.qty_done || 0
      );

    if (
      Math.abs(
        currentAssigned -
          desiredAssigned
      ) > EPSILON ||
      Math.abs(
        currentDone -
          desiredDone
      ) > EPSILON
    ) {
      distributionChanged =
        true;

      break;
    }
  }

  if (!distributionChanged) {
    console.log(
      "✅ La cantidad y las ubicaciones ya están correctas."
    );

    return {
      redistributed: false,
      changed: false,
      reason:
        "DISTRIBUTION_ALREADY_CORRECT",
    };
  }

  // =====================================================
  // 7. INDEXAR LÍNEAS ACTUALES POR UBICACIÓN
  // =====================================================

  const currentLinesByLocation =
    new Map();

  for (
    const line of currentLines
  ) {
    const key =
      `${Number(
        line.warehouse_id
      )}:` +
      `${Number(
        line.location_id
      )}`;

    if (
      !currentLinesByLocation.has(
        key
      )
    ) {
      currentLinesByLocation.set(
        key,
        []
      );
    }

    currentLinesByLocation
      .get(key)
      .push(line);
  }

  const usedLineIds =
    new Set();

  const sourceUserId =
    currentLines.find(
      (line) =>
        Number(
          line.qty_done || 0
        ) > 0 &&
        line.user_id !== null
    )?.user_id ?? null;

  let createdLines = 0;
  let updatedLines = 0;
  let cancelledLines = 0;

  // =====================================================
  // 8. ACTUALIZAR O CREAR DISTRIBUCIÓN DESEADA
  // =====================================================

  for (
    const desired of desiredRows
  ) {
    const existingCandidates =
      currentLinesByLocation.get(
        desired.key
      ) || [];

    const existingLine =
      existingCandidates.find(
        (line) =>
          !usedLineIds.has(
            String(line.id)
          )
      );

    if (existingLine) {
      const updateResult =
        await client.query(
          `
            UPDATE stock_move_line
            SET
              warehouse_id = $1,
              location_id = $2,
              product_uom_qty = $3,
              qty_done = $4,
              state = 'assigned',
              write_date = NOW()
            WHERE id = $5
              AND move_id = $6
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
              warehouse_id,
              location_id,
              product_uom_qty,
              qty_done,
              state
          `,
          [
            desired.warehouse_id,
            desired.location_id,
            desired.product_uom_qty,
            desired.qty_done,
            existingLine.id,
            moveId,
          ]
        );

      if (
        updateResult.rowCount !== 1
      ) {
        throw new Error(
          `No se pudo actualizar la línea ${existingLine.id}.`
        );
      }

      usedLineIds.add(
        String(existingLine.id)
      );

      updatedLines++;

      console.log(
        "✏️ stock_move_line actualizada:",
        updateResult.rows[0]
      );
    } else {
      const insertResult =
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
              state,
              user_id
            )
            VALUES (
              $1,
              $2,
              $3,
              $4,
              $5,
              $6,
              $7,
              $8,
              'assigned',
              $9
            )
            RETURNING
              id,
              move_id,
              warehouse_id,
              location_id,
              product_uom_qty,
              qty_done,
              state
          `,
          [
            moveId,
            pickingId,
            productId,
            productUomId,
            desired.warehouse_id,
            desired.location_id,
            desired.product_uom_qty,
            desired.qty_done,
            sourceUserId,
          ]
        );

      createdLines++;

      console.log(
        "➕ stock_move_line creada:",
        insertResult.rows[0]
      );
    }
  }

  // =====================================================
  // 9. CANCELAR LÍNEAS SOBRANTES
  // =====================================================

  for (
    const line of currentLines
  ) {
    if (
      usedLineIds.has(
        String(line.id)
      )
    ) {
      continue;
    }

    const cancelResult =
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
            warehouse_id,
            location_id,
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
      cancelResult.rowCount !== 1
    ) {
      throw new Error(
        `No se pudo cancelar la línea sobrante ${line.id}.`
      );
    }

    cancelledLines++;

    console.log(
      "🚫 stock_move_line sobrante cancelada:",
      cancelResult.rows[0]
    );
  }

  // =====================================================
  // 10. ACTUALIZAR ESTADO DEL MOVIMIENTO
  // =====================================================

  await updateDispatchMoveState(
    client,
    moveId
  );

  // =====================================================
  // 11. VERIFICAR RESULTADO
  // =====================================================

  const verificationResult =
    await client.query(
      `
        SELECT
          id,
          move_id,
          picking_id,
          product_id,
          product_uom_qty,
          qty_done,
          warehouse_id,
          location_id,
          state
        FROM stock_move_line
        WHERE move_id = $1
        ORDER BY id ASC
      `,
      [moveId]
    );

  console.log(
    "✅ DISTRIBUCIÓN FINAL:"
  );

  console.table(
    verificationResult.rows
  );

  return {
    redistributed: true,
    changed: true,
    reason:
      "PHYSICAL_DISTRIBUTION_CHANGED",
    requiredQty,
    totalDone:
      Math.min(
        totalCurrentDone,
        requiredQty
      ),
    createdLines,
    updatedLines,
    cancelledLines,
    distribution:
      desiredRows,
  };
}


