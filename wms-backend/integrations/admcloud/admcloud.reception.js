import admcloudClient from "./admcloudClient.js";


// ============================================================
// HELPERS
// ============================================================

function toNumber(
  value,
  fallback = 0
) {
  const parsed =
    Number(value);

  return Number.isFinite(parsed)
    ? parsed
    : fallback;
}


function toText(
  value
) {
  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }

  const normalized =
    String(value).trim();

  return normalized || null;
}


// ============================================================
// VALIDAR GUID
// ============================================================

function isGuid(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return false;
  }

  const normalized =
    String(value).trim();

  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
    .test(normalized);
}

// ============================================================
// NORMALIZAR ITEM
// ============================================================

function normalizeReceptionItem(
  item,
  index
) {

  if (
    !item ||
    typeof item !== "object"
  ) {
    throw new Error(
      `ITEM_INVALID_${index + 1}`
    );
  }


  const rowOrder =
    toNumber(
      item.RowOrder,
      index + 1
    );


  const itemId =
    toText(
      item.ItemID
    );


  const quantity =
    toNumber(
      item.Quantity,
      NaN
    );


  const cost =
    toNumber(
      item.Cost,
      0
    );


  const price =
    toNumber(
      item.Price,
      0
    );


  const uomId =
    toText(
      item.UOMID
    );


  const rowType =
    toNumber(
      item.RowType,
      0
    );


  const estimatedDeliveryDate =
    toText(
      item.EstimatedDeliveryDate
    );


  const exchangeRate =
    toNumber(
      item.ExchangeRate,
      0
    );


  const warrantyDays =
    toNumber(
      item.WarrantyDays,
      0
    );


  const warrantyUnits =
    toNumber(
      item.WarrantyUnits,
      0
    );


  // ==========================================================
  // VALIDACIONES
  // ==========================================================

  if (
    !Number.isInteger(rowOrder) ||
    rowOrder <= 0
  ) {
    throw new Error(
      `INVALID_ROW_ORDER_ITEM_${index + 1}`
    );
  }


  if (!itemId) {
    throw new Error(
      `ITEM_ID_REQUIRED_ITEM_${index + 1}`
    );
  }


  if (!isGuid(itemId)) {
    throw new Error(
      `INVALID_ITEM_ID_ITEM_${index + 1}`
    );
  }


  if (
    !Number.isFinite(quantity) ||
    quantity <= 0
  ) {
    throw new Error(
      `INVALID_QUANTITY_ITEM_${index + 1}`
    );
  }


  if (
    !Number.isFinite(cost) ||
    cost < 0
  ) {
    throw new Error(
      `INVALID_COST_ITEM_${index + 1}`
    );
  }


  if (
    !Number.isFinite(price) ||
    price < 0
  ) {
    throw new Error(
      `INVALID_PRICE_ITEM_${index + 1}`
    );
  }


  if (
    uomId &&
    !isGuid(uomId)
  ) {
    throw new Error(
      `INVALID_UOM_ID_ITEM_${index + 1}`
    );
  }


  return {

    RowOrder:
      rowOrder,

    ItemID:
      itemId,

    Cost:
      cost,

    Price:
      price,

    Quantity:
      quantity,

    UOMID:
      uomId,

    RowType:
      rowType,

    EstimatedDeliveryDate:
      estimatedDeliveryDate,

    ExchangeRate:
      exchangeRate,

    WarrantyDays:
      warrantyDays,

    WarrantyUnits:
      warrantyUnits
  };
}


// ============================================================
// CREAR RECEPTION ADM CLOUD
// ============================================================

export async function createAdmCloudReception(
  data
) {

  console.log("");
  console.log(
    "🟨🟨🟨 ========================================"
  );
  console.log(
    "🟨 CREANDO RECEPTION EN ADM CLOUD"
  );
  console.log(
    "🟨🟨🟨 ========================================"
  );


  // ==========================================================
  // VALIDAR BODY
  // ==========================================================

  if (
    !data ||
    typeof data !== "object"
  ) {
    throw new Error(
      "RECEPTION_PAYLOAD_REQUIRED"
    );
  }


  // ==========================================================
  // HEADER
  // ==========================================================

  const docDate =
    toText(
      data.DocDate
    );


  const reference =
    toText(
      data.Reference
    );


  const relationshipId =
    toText(
      data.RelationshipID
    );


  const locationId =
    toText(
      data.LocationID
    );


  const notes =
    toText(
      data.Notes
    );


  // ==========================================================
  // VALIDACIONES HEADER
  // ==========================================================

  if (!docDate) {
    throw new Error(
      "DOC_DATE_REQUIRED"
    );
  }


  if (
    relationshipId &&
    !isGuid(relationshipId)
  ) {
    throw new Error(
      "INVALID_RELATIONSHIP_ID"
    );
  }


  if (!locationId) {
    throw new Error(
      "LOCATION_ID_REQUIRED"
    );
  }


  if (
    !isGuid(locationId)
  ) {
    throw new Error(
      "INVALID_LOCATION_ID"
    );
  }


  // ==========================================================
  // ITEMS
  // ==========================================================

  if (
    !Array.isArray(
      data.Items
    ) ||
    data.Items.length === 0
  ) {
    throw new Error(
      "RECEPTION_ITEMS_REQUIRED"
    );
  }


  const items =
    data.Items.map(
      (
        item,
        index
      ) =>
        normalizeReceptionItem(
          item,
          index
        )
    );


  // ==========================================================
  // PAYLOAD FINAL
  // ==========================================================

  const payload = {

    DocDate:
      docDate,

    Reference:
      reference,

    RelationshipID:
      relationshipId,

    LocationID:
      locationId,

    Notes:
      notes,

    Items:
      items,

    Documents:
      Array.isArray(
        data.Documents
      )
        ? data.Documents
        : [],

    Files:
      Array.isArray(
        data.Files
      )
        ? data.Files
        : [],

    CustomFields:
      Array.isArray(
        data.CustomFields
      )
        ? data.CustomFields
        : []
  };


  console.log("");
  console.log(
    "📤 PAYLOAD ADM CLOUD:"
  );

  console.dir(
    payload,
    {
      depth: null
    }
  );


  // ==========================================================
  // LLAMAR API
  // ==========================================================

  let response;


  try {

    response =
      await admcloudClient.post(
        "/Receptions",
        payload
      );

  } catch (error) {

    console.error("");
    console.error(
      "❌ ERROR HTTP ADM CLOUD"
    );


    console.error(
      "Status:",
      error.response?.status
    );


    console.error(
      "Data:",
      error.response?.data
    );


    console.error(
      "Message:",
      error.message
    );


    const admMessage =
      error.response?.data?.message ||
      error.response?.data?.Message ||
      error.message;


    throw new Error(
      `ADM_CLOUD_RECEPTION_ERROR: ${admMessage}`
    );

  }


  // ==========================================================
  // RESPUESTA ADM CLOUD
  // ==========================================================

  const responseData =
    response?.data;


  console.log("");
  console.log(
    "📥 RESPUESTA ADM CLOUD:"
  );

  console.dir(
    responseData,
    {
      depth: null
    }
  );


  if (!responseData) {
    throw new Error(
      "ADM_CLOUD_EMPTY_RESPONSE"
    );
  }


  // ==========================================================
  // ADM CLOUD NORMALMENTE USA:
  //
  // {
  //   success,
  //   message,
  //   data
  // }
  //
  // data debería contener el resultado / ID creado.
  // ==========================================================

  if (
    responseData.success ===
    false
  ) {

    throw new Error(
      responseData.message ||
      "ADM_CLOUD_RECEPTION_FAILED"
    );

  }


  const receptionId =
    toText(
      responseData.data
    );


  if (!receptionId) {

    console.warn(
      "⚠️ ADM Cloud respondió success pero no encontramos data/ID."
    );

  }


  console.log("");
  console.log(
    "✅ RECEPTION ADM CLOUD CREADA"
  );


  console.log(
    "🆔 Reception ID:",
    receptionId
  );


  return {

    success: true,

    receptionId,

    payload,

    response:
      responseData
  };
}





// ============================================================
// CONFIRMAR RECEPCIÓN EN ADM CLOUD POR ID
//
// RESULTADO:
//
// EXISTE:
// {
//   exists: true,
//   receptionId: "...",
//   reception: {...}
// }
//
// NO EXISTE:
// {
//   exists: false,
//   receptionId: "...",
//   reception: null
// }
//
// ERROR ADM:
// throw Error
// ============================================================

export async function confirmAdmCloudReceptionById(
  receptionId
) {

  // ==========================================================
  // 1. NORMALIZAR ID
  // ==========================================================

  const normalizedReceptionId =
    String(
      receptionId ??
      ""
    ).trim();


  // ==========================================================
  // 2. VALIDAR ID
  // ==========================================================

  if (
    !normalizedReceptionId
  ) {

    const error =
      new Error(
        "El ID de la recepción de ADM Cloud es requerido."
      );


    error.code =
      "ADM_RECEPTION_ID_REQUIRED";


    throw error;

  }


  if (
    !isGuid(
      normalizedReceptionId
    )
  ) {

    const error =
      new Error(
        `El ID ${normalizedReceptionId} no es un GUID válido.`
      );


    error.code =
      "ADM_RECEPTION_INVALID_ID";


    throw error;

  }


  console.log("");
  console.log(
    "☁️ ========================================"
  );

  console.log(
    "☁️ CONFIRMANDO RECEPCIÓN EN ADM CLOUD"
  );

  console.log(
    "☁️ ID:",
    normalizedReceptionId
  );

  console.log(
    "☁️ ========================================"
  );


  try {

    // ========================================================
    // 3. CONSULTAR ADM CLOUD
    //
    // admcloudClient ya agrega:
    //
    // company
    // role
    // appid
    // Authorization
    // ========================================================

    const response =
      await admcloudClient.get(
        `/Receptions/${encodeURIComponent(
          normalizedReceptionId
        )}`
      );


    // ========================================================
    // 4. RESPUESTA ADM CLOUD
    //
    // Esperamos:
    //
    // {
    //   success: true,
    //   message: null,
    //   data: {...}
    // }
    // ========================================================

    const apiResponse =
      response?.data;


    /*console.log(
      "☁️ ADM RECEPTION RESPONSE:"
    );

    console.dir(
      apiResponse,
      {
        depth: null
      }
    );*/


    // ========================================================
    // 5. VALIDAR RESPUESTA
    // ========================================================

    if (
      !apiResponse ||
      typeof apiResponse !==
        "object"
    ) {

      const error =
        new Error(
          "ADM Cloud devolvió una respuesta inválida al consultar la recepción."
        );


      error.code =
        "ADM_RECEPTION_INVALID_RESPONSE";


      throw error;

    }


    // ========================================================
    // 6. ADM CLOUD RESPONDIÓ success:false
    //
    // NO asumimos que significa "no existe".
    //
    // Puede ser:
    // - error interno
    // - autenticación
    // - validación
    // - otro error de ADM
    //
    // Por seguridad hacemos throw.
    // ========================================================

    if (
      apiResponse.success === false
    ) {

      const error =
        new Error(
          apiResponse.message ||
          "ADM Cloud no pudo consultar la recepción."
        );


      error.code =
        "ADM_RECEPTION_LOOKUP_FAILED";


      error.admData =
        apiResponse;


      throw error;

    }


    // ========================================================
    // 7. NO HAY DATA
    //
    // La llamada funcionó pero ADM no devolvió recepción.
    // ========================================================

    if (
      !apiResponse.data
    ) {

      console.log(
        "ℹ️ RECEPCIÓN NO ENCONTRADA EN ADM CLOUD"
      );


      return {

        exists:
          false,

        receptionId:
          normalizedReceptionId,

        reception:
          null

      };

    }


    // ========================================================
    // 8. RECEPCIÓN CONFIRMADA
    // ========================================================

    console.log(
      "✅ RECEPCIÓN CONFIRMADA EN ADM CLOUD"
    );


    return {

      exists:
        true,

      receptionId:
        normalizedReceptionId,

      reception:
        apiResponse.data

    };


  } catch (
    error
  ) {

    // ========================================================
    // 9. 404 = NO EXISTE
    //
    // Tu admcloudClient transforma errores Axios a:
    //
    // {
    //   status,
    //   message,
    //   data
    // }
    // ========================================================

    if (
      Number(
        error?.status
      ) === 404
    ) {

      console.log(
        "ℹ️ RECEPCIÓN NO EXISTE EN ADM CLOUD:",
        normalizedReceptionId
      );


      return {

        exists:
          false,

        receptionId:
          normalizedReceptionId,

        reception:
          null

      };

    }


    // ========================================================
    // 10. SI ES UN ERROR CREADO POR ESTE SERVICIO,
    //     CONSERVARLO
    // ========================================================

    if (
      error instanceof Error &&
      error.code
    ) {

      throw error;

    }


    // ========================================================
    // 11. ERROR REAL COMUNICANDO CON ADM CLOUD
    // ========================================================

    console.error(
      "❌ ERROR CONFIRMANDO RECEPCIÓN ADM:",
      error
    );


    const serviceError =
      new Error(
        error?.message ||
        "No fue posible confirmar la recepción en ADM Cloud."
      );


    serviceError.code =
      "ADM_RECEPTION_CONFIRMATION_ERROR";


    serviceError.status =
      error?.status ||
      500;


    serviceError.admData =
      error?.data ||
      null;


    throw serviceError;

  }

}








// ============================================================
// ACTUALIZAR RECEPTION ADM CLOUD
//
// IMPORTANTE:
//
// PUT /Receptions
//
// El ID de la recepción va en el BODY.
//
// Para las líneas que ya existen en ADM:
// enviamos también Items[].ID.
//
// Esto evita crear líneas duplicadas.
// ============================================================

export async function updateAdmCloudReception({

  receptionId,

  currentReception,

  data

}) {

  // ==========================================================
  // 1. VALIDAR RECEPTION ID
  // ==========================================================

  const normalizedReceptionId =
    String(
      receptionId ??
      ""
    ).trim();


  if (
    !normalizedReceptionId
  ) {

    const error =
      new Error(
        "El ID de la recepción ADM es requerido."
      );

    error.code =
      "ADM_RECEPTION_ID_REQUIRED";

    throw error;

  }


  if (
    !isGuid(
      normalizedReceptionId
    )
  ) {

    const error =
      new Error(
        `El ID ${normalizedReceptionId} no es un GUID válido.`
      );

    error.code =
      "ADM_RECEPTION_INVALID_ID";

    throw error;

  }


  // ==========================================================
  // 2. VALIDAR DATA
  // ==========================================================

  if (
    !data ||
    typeof data !== "object"
  ) {

    const error =
      new Error(
        "El payload de actualización es requerido."
      );

    error.code =
      "ADM_RECEPTION_UPDATE_PAYLOAD_REQUIRED";

    throw error;

  }


  // ==========================================================
  // 3. SI NO NOS PASARON LA RECEPCIÓN ACTUAL,
  //    BUSCARLA EN ADM
  // ==========================================================

  let existingReception =
    currentReception;


  if (
    !existingReception
  ) {

    const confirmation =
      await confirmAdmCloudReceptionById(
        normalizedReceptionId
      );


    if (
      !confirmation.exists ||
      !confirmation.reception
    ) {

      const error =
        new Error(
          `La recepción ${normalizedReceptionId} no existe en ADM Cloud.`
        );

      error.code =
        "ADM_RECEPTION_NOT_FOUND";

      throw error;

    }


    existingReception =
      confirmation.reception;

  }


  // ==========================================================
  // 4. VALIDAR QUE ADM DEVOLVIÓ LA MISMA RECEPCIÓN
  // ==========================================================

  const currentAdmId =
    String(
      existingReception?.ID ??
      ""
    ).trim();


  if (
    !currentAdmId ||
    currentAdmId.toLowerCase() !==
      normalizedReceptionId.toLowerCase()
  ) {

    const error =
      new Error(
        "La recepción cargada desde ADM no coincide con la recepción que se quiere actualizar."
      );

    error.code =
      "ADM_RECEPTION_ID_MISMATCH";

    throw error;

  }

// ==========================================================
// 5. HEADER
// ==========================================================


const docId =
  data.DocID !== undefined
    ? toText(
        data.DocID
      )
    : toText(
        existingReception.DocID
      );


if (
  !docId
) {

  const error =
    new Error(
      "DocID es requerido para actualizar la recepción ADM."
    );

  error.code =
    "ADM_RECEPTION_DOC_ID_REQUIRED";

  throw error;

}


  const docDate =
    toText(
      data.DocDate ??
      existingReception.DocDate
    );


  const reference =
    data.Reference !== undefined
      ? toText(
          data.Reference
        )
      : toText(
          existingReception.Reference
        );


  const relationshipId =
    data.RelationshipID !== undefined
      ? toText(
          data.RelationshipID
        )
      : toText(
          existingReception.RelationshipID
        );


  const locationId =
    data.LocationID !== undefined
      ? toText(
          data.LocationID
        )
      : toText(
          existingReception.LocationID
        );


  const notes =
    data.Notes !== undefined
      ? toText(
          data.Notes
        )
      : toText(
          existingReception.Notes
        );


  if (
    !docDate
  ) {

    const error =
      new Error(
        "DocDate es requerido para actualizar la recepción."
      );

    error.code =
      "DOC_DATE_REQUIRED";

    throw error;

  }


  if (
    relationshipId &&
    !isGuid(
      relationshipId
    )
  ) {

    const error =
      new Error(
        "RelationshipID no es un GUID válido."
      );

    error.code =
      "INVALID_RELATIONSHIP_ID";

    throw error;

  }


  if (
    locationId &&
    !isGuid(
      locationId
    )
  ) {

    const error =
      new Error(
        "LocationID no es un GUID válido."
      );

    error.code =
      "INVALID_LOCATION_ID";

    throw error;

  }


  // ==========================================================
  // 6. VALIDAR ITEMS NUEVOS DEL WMS
  // ==========================================================

  if (
    !Array.isArray(
      data.Items
    ) ||
    data.Items.length === 0
  ) {

    const error =
      new Error(
        "La recepción debe contener al menos un item."
      );

    error.code =
      "RECEPTION_ITEMS_REQUIRED";

    throw error;

  }


  const normalizedItems =
    data.Items.map(
      (
        item,
        index
      ) =>
        normalizeReceptionItem(
          item,
          index
        )
    );


  // ==========================================================
  // 7. ITEMS QUE YA EXISTEN EN ADM
  //
  // Ejemplo:
  //
  // ADM:
  //
  // {
  //   ID: "86968ae0...",
  //   RowOrder: 1,
  //   ItemID: "22520e8f...",
  //   Quantity: 400
  // }
  //
  // WMS ahora quiere:
  //
  // Quantity: 450
  //
  // Debemos conservar:
  //
  // ID: "86968ae0..."
  // ==========================================================

  const existingItems =
    Array.isArray(
      existingReception.Items
    )
      ? existingReception.Items
      : [];


  const usedExistingItemIds =
    new Set();


  // ==========================================================
  // 8. AGREGAR EL ID ADM A CADA LÍNEA EXISTENTE
  //
  // Primero:
  // RowOrder + ItemID
  //
  // Esto es más seguro que buscar solo ItemID,
  // porque una PO podría tener el mismo producto
  // en dos líneas diferentes.
  // ==========================================================

  const updateItems =
    normalizedItems.map(
      (
        item
      ) => {

        const matchingExistingItem =
          existingItems.find(
            existingItem => {

              if (
                !existingItem?.ID
              ) {
                return false;
              }


              if (
                usedExistingItemIds.has(
                  String(
                    existingItem.ID
                  )
                )
              ) {
                return false;
              }


              const sameRowOrder =
                Number(
                  existingItem.RowOrder
                ) ===
                Number(
                  item.RowOrder
                );


              const sameItemId =
                String(
                  existingItem.ItemID ??
                  ""
                )
                  .trim()
                  .toLowerCase() ===

                String(
                  item.ItemID ??
                  ""
                )
                  .trim()
                  .toLowerCase();


              return (
                sameRowOrder &&
                sameItemId
              );

            }
          );


        // ======================================================
        // LÍNEA YA EXISTE
        // ======================================================

        if (
          matchingExistingItem
        ) {

          usedExistingItemIds.add(
            String(
              matchingExistingItem.ID
            )
          );


          return {

            ID:
              matchingExistingItem.ID,

            ...item

          };

        }


        // ======================================================
        // LÍNEA NUEVA
        //
        // No enviamos ID.
        //
        // ADM deberá crear la línea.
        // ======================================================

        return item;

      }
    );


  // ==========================================================
  // 9. PAYLOAD FINAL
  //
  // NO mandar toda la respuesta GET de ADM.
  //
  // Tiene muchos campos readOnly.
  //
  // Mandamos solamente lo que necesitamos.
  // ==========================================================

  const payload = {

  ID:
    normalizedReceptionId,


  DocID:
    docId,


  DocDate:
    docDate,

  Reference:
    reference,

  RelationshipID:
    relationshipId,

  LocationID:
    locationId,

  Notes:
    notes,

  Items:
    updateItems

};


  // ==========================================================
  // DOCUMENTS
  // SOLO SI VIENEN EXPLÍCITAMENTE
  // ==========================================================

  if (
    Array.isArray(
      data.Documents
    )
  ) {

    payload.Documents =
      data.Documents;

  }


  // ==========================================================
  // FILES
  // ==========================================================

  if (
    Array.isArray(
      data.Files
    )
  ) {

    payload.Files =
      data.Files;

  }


  // ==========================================================
  // CUSTOM FIELDS
  // ==========================================================

  if (
    Array.isArray(
      data.CustomFields
    )
  ) {

    payload.CustomFields =
      data.CustomFields;

  }


  console.log("");
  console.log(
    "🟦🟦🟦 ========================================"
  );

  console.log(
    "🟦 ACTUALIZANDO RECEPTION ADM CLOUD"
  );

  console.log(
    "🆔 ID:",
    normalizedReceptionId
  );

  console.log(
    "🟦🟦🟦 ========================================"
  );


  console.log("");
  console.log(
    "📤 PAYLOAD UPDATE ADM CLOUD:"
  );

  console.dir(
    payload,
    {
      depth: null
    }
  );


  // ==========================================================
  // 10. PUT ADM CLOUD
  //
  // IMPORTANTE:
  //
  // NO:
  // PUT /Receptions/{id}
  //
  // SÍ:
  // PUT /Receptions
  //
  // porque el ID va en payload.ID.
  // ==========================================================

  let response;


  try {

    response =
      await admcloudClient.put(
        "/Receptions",
        payload
      );


  } catch (
    error
  ) {

    console.error("");
    console.error(
      "❌ ERROR ACTUALIZANDO RECEPTION ADM CLOUD"
    );

    console.error(
      error
    );


    const serviceError =
      new Error(
        error?.message ||
        "No fue posible actualizar la recepción en ADM Cloud."
      );


    serviceError.code =
      "ADM_RECEPTION_UPDATE_ERROR";


    serviceError.status =
      error?.status ||
      500;


    serviceError.admData =
      error?.data ||
      null;


    throw serviceError;

  }


  // ==========================================================
  // 11. RESPUESTA
  // ==========================================================

  const responseData =
    response?.data;


  console.log("");
  console.log(
    "📥 RESPUESTA UPDATE ADM CLOUD:"
  );

  console.dir(
    responseData,
    {
      depth: null
    }
  );


  if (
    !responseData
  ) {

    const error =
      new Error(
        "ADM Cloud devolvió una respuesta vacía al actualizar."
      );

    error.code =
      "ADM_RECEPTION_UPDATE_EMPTY_RESPONSE";

    throw error;

  }


  if (
    responseData.success ===
    false
  ) {

    const error =
      new Error(
        responseData.message ||
        "ADM Cloud rechazó la actualización de la recepción."
      );

    error.code =
      "ADM_RECEPTION_UPDATE_FAILED";

    error.admData =
      responseData;

    throw error;

  }


  console.log("");
  console.log(
    "✅ RECEPTION ADM CLOUD ACTUALIZADA"
  );

  console.log(
    "🆔 Reception ID:",
    normalizedReceptionId
  );


  return {

    success:
      true,

    receptionId:
      normalizedReceptionId,

    payload,

    response:
      responseData

  };

}









// ============================================================
// ELIMINAR RECEPTION ADM CLOUD
//
// DELETE /Receptions/{id}
//
// Se usa principalmente para compensación:
// si WMS crea una recepción ADM y luego algo falla,
// eliminamos esa recepción de ADM Cloud.
// ============================================================

export async function deleteAdmCloudReception(
  receptionId
) {

  const normalizedReceptionId =
    String(
      receptionId ?? ""
    ).trim();


  // ==========================================================
  // 1. VALIDAR ID
  // ==========================================================

  if (
    !normalizedReceptionId
  ) {

    const error =
      new Error(
        "El ID de la recepción ADM es requerido."
      );

    error.code =
      "ADM_RECEPTION_ID_REQUIRED";

    throw error;
  }


  if (
    !isGuid(
      normalizedReceptionId
    )
  ) {

    const error =
      new Error(
        `El ID ${normalizedReceptionId} no es un GUID válido.`
      );

    error.code =
      "ADM_RECEPTION_INVALID_ID";

    throw error;
  }


  console.log("");
  console.log(
    "🟥🟥🟥 ========================================"
  );

  console.log(
    "🗑️ ELIMINANDO RECEPTION ADM CLOUD"
  );

  console.log(
    "🆔 Reception ID:",
    normalizedReceptionId
  );

  console.log(
    "🟥🟥🟥 ========================================"
  );


  try {

    // ========================================================
    // 2. DELETE REAL
    //
    // admcloudClient ya agrega:
    // company
    // role
    // appid
    // authorization
    // ========================================================

    const response =
      await admcloudClient.delete(
        `/Receptions/${encodeURIComponent(
          normalizedReceptionId
        )}`
      );


    const responseData =
      response?.data;


    console.log("");
    console.log(
      "📥 RESPUESTA DELETE ADM CLOUD:"
    );

    console.dir(
      responseData,
      {
        depth: null
      }
    );


    // ========================================================
    // 3. VALIDAR RESPUESTA
    // ========================================================

    if (
      !responseData ||
      typeof responseData !== "object"
    ) {

      const error =
        new Error(
          "ADM Cloud devolvió una respuesta inválida al eliminar la recepción."
        );

      error.code =
        "ADM_RECEPTION_DELETE_INVALID_RESPONSE";

      throw error;
    }


    if (
      responseData.success === false
    ) {

      const error =
        new Error(
          responseData.message ||
          "ADM Cloud no pudo eliminar la recepción."
        );

      error.code =
        "ADM_RECEPTION_DELETE_FAILED";

      error.admData =
        responseData;

      throw error;
    }


    console.log("");
    console.log(
      "✅ RECEPTION ADM CLOUD ELIMINADA"
    );

    console.log(
      "🆔 Reception ID:",
      normalizedReceptionId
    );


    return {

      success:
        true,

      receptionId:
        normalizedReceptionId,

      response:
        responseData

    };


  } catch (
    error
  ) {

    // ========================================================
    // SI YA NO EXISTE:
    //
    // Para compensación esto puede considerarse exitoso,
    // porque el estado deseado ya se cumplió:
    // la recepción no existe.
    // ========================================================

    if (
      Number(
        error?.status
      ) === 404
    ) {

      console.log(
        "⚠️ La recepción ya no existe en ADM Cloud:",
        normalizedReceptionId
      );


      return {

        success:
          true,

        alreadyDeleted:
          true,

        receptionId:
          normalizedReceptionId,

        response:
          null

      };
    }


    // Si el error ya fue creado por nosotros,
    // mantenerlo.
    if (
      error instanceof Error &&
      error.code
    ) {

      throw error;
    }


    console.error("");
    console.error(
      "❌ ERROR ELIMINANDO RECEPTION ADM CLOUD:"
    );

    console.error(
      error
    );


    const serviceError =
      new Error(
        error?.message ||
        "No fue posible eliminar la recepción en ADM Cloud."
      );


    serviceError.code =
      "ADM_RECEPTION_DELETE_ERROR";


    // IMPORTANTE:
    // admcloudClient convierte Axios errors a:
    //
    // {
    //   status,
    //   message,
    //   data
    // }

    serviceError.status =
      error?.status ||
      500;


    serviceError.admData =
      error?.data ||
      null;


    throw serviceError;
  }
}