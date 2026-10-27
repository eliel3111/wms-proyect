import admcloudClient
  from "./admcloudClient.js";



// =====================================================
// OBTENER TODOS LOS CAMPOS Y RUTAS DEL OBJETO
// =====================================================

function getDetailedFields(
  value,
  parentPath = "",
  result = []
) {
  if (
    value === null ||
    value === undefined
  ) {
    result.push({
      field:
        parentPath,

      type:
        value === null
          ? "null"
          : "undefined",

      value,
    });

    return result;
  }

  if (Array.isArray(value)) {
    result.push({
      field:
        parentPath,

      type:
        "array",

      value:
        `Array(${value.length})`,
    });

    value.forEach(
      (item, index) => {
        getDetailedFields(
          item,
          `${parentPath}[${index}]`,
          result
        );
      }
    );

    return result;
  }

  if (
    typeof value === "object"
  ) {
    const entries =
      Object.entries(value);

    if (
      entries.length === 0
    ) {
      result.push({
        field:
          parentPath,

        type:
          "object",

        value:
          "{}",
      });

      return result;
    }

    for (
      const [key, childValue]
      of entries
    ) {
      const fieldPath =
        parentPath
          ? `${parentPath}.${key}`
          : key;

      getDetailedFields(
        childValue,
        fieldPath,
        result
      );
    }

    return result;
  }

  result.push({
    field:
      parentPath,

    type:
      typeof value,

    value,
  });

  return result;
}


// =====================================================
// CONTROLLER
// GET PRODUCTO ADM CLOUD POR GUID
// =====================================================

export async function getAdmCloudProductByIdController(
  req,
  res
) {
  const productId =
    String(
      req.params.productId ?? ""
    ).trim();

  console.log(
    "========================================"
  );

  console.log(
    "📦 GET ADM CLOUD PRODUCT BY ID"
  );

  console.log(
    "🆔 Product ID:",
    productId
  );

  console.log(
    "========================================"
  );

  try {
    const result =
      await getAdmCloudProductByIdService(
        productId
      );

    const product =
      result.product;

    const detailedFields =
      getDetailedFields(
        product
      );

    /*
     * Esto te permitirá localizar rápidamente:
     *
     * UOMID
     * SalesUOMID
     * PurchaseUOMID
     * InventoryUOMID
     * Unit
     */
    const unitFields =
      detailedFields.filter(
        (item) => {
          const fieldName =
            String(
              item.field || ""
            ).toLowerCase();

          return (
            fieldName.includes(
              "uom"
            ) ||
            fieldName.includes(
              "unit"
            ) ||
            fieldName.includes(
              "measure"
            )
          );
        }
      );

    console.log(
      "🔑 Campos superiores:"
    );

    console.table(
      Object.keys(
        product
      ).map(
        (field) => ({
          field,

          type:
            product[field] === null
              ? "null"
              : Array.isArray(
                    product[field]
                  )
                ? "array"
                : typeof product[
                    field
                  ],
        })
      )
    );

    console.log(
      "📏 Campos relacionados con unidades:"
    );

    console.table(
      unitFields
    );

    return res
      .status(200)
      .json({
        success: true,

        title:
          "Producto encontrado",

        message:
          "El producto fue obtenido correctamente desde ADM Cloud.",

        requestedProductId:
          result
            .requestedProductId,

        admCloudHttpStatus:
          result.httpStatus,

        /*
         * Producto completo sin eliminar campos.
         */
        data:
          product,

        inspection: {
          topLevelFields:
            Object.keys(
              product
            ),

          unitFields,

          /*
           * Lista todos los campos anidados,
           * sus tipos y valores.
           */
          detailedFields,
        },

        /*
         * Respuesta original de ADM Cloud.
         */
        rawAdmCloudResponse:
          result.rawResponse,
      });
  } catch (error) {
    console.error(
      "🔥 Error controller producto ADM Cloud:",
      {
        message:
          error.message,

        code:
          error.code,

        statusCode:
          error.statusCode,

        admCloudStatus:
          error.admCloudStatus,

        admCloudData:
          error.admCloudData,
      }
    );

    const candidateStatus =
      Number(
        error.statusCode
      );

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

        code:
          error.code ||
          "GET_ADMCLOUD_PRODUCT_ERROR",

        title:
          error.title ||
          "Error obteniendo producto",

        message:
          error.message ||
          "No se pudo obtener el producto desde ADM Cloud.",

        admCloudStatus:
          error.admCloudStatus ||
          null,

        admCloudError:
          error.admCloudData ||
          null,
      });
  }
}


const GUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


// =====================================================
// CREAR ERROR CONTROLADO
// =====================================================

function createProductError(
  statusCode,
  title,
  message,
  code,
  extra = {}
) {
  return Object.assign(
    new Error(message),
    {
      statusCode,
      title,
      code,
      ...extra,
    }
  );
}


// =====================================================
// BUSCAR PRODUCTO ADM CLOUD POR GUID
// =====================================================

export async function getAdmCloudProductByIdService(
  productId
) {
  const normalizedProductId =
    String(productId ?? "")
      .trim()
      .toLowerCase();

  // ===================================================
  // 1. VALIDAR GUID
  // ===================================================

  if (
    !GUID_REGEX.test(
      normalizedProductId
    )
  ) {
    throw createProductError(
      400,
      "ID de producto inválido",
      "Debes proporcionar un GUID válido para buscar el producto.",
      "INVALID_ADMCLOUD_PRODUCT_ID"
    );
  }

  console.log(
    "========================================"
  );

  console.log(
    "🔎 BUSCANDO PRODUCTO EN ADM CLOUD"
  );

  console.log(
    "🆔 Product ID:",
    normalizedProductId
  );

  console.log(
    "========================================"
  );

  try {
    // =================================================
    // 2. CONSULTAR ADM CLOUD
    // =================================================

    const response =
      await admcloudClient.get(
        `/Items/${encodeURIComponent(
          normalizedProductId
        )}`,
        {
          headers: {
            Accept:
              "application/json",
          },
        }
      );

    const result =
      response.data;

    console.log(
      "📡 HTTP Status ADM Cloud:",
      response.status
    );

    console.log(
      "📨 Respuesta completa ADM Cloud:"
    );

    console.dir(
      result,
      {
        depth: null,
        colors: true,
      }
    );

    // =================================================
    // 3. VALIDAR RESPUESTA ADM CLOUD
    // =================================================

    if (
      result?.success === false
    ) {
      throw createProductError(
        422,
        "ADM Cloud rechazó la consulta",
        result.message ||
        "ADM Cloud no pudo obtener el producto.",
        "ADMCLOUD_PRODUCT_REJECTED",
        {
          admCloudStatus:
            response.status,

          admCloudData:
            result,
        }
      );
    }

    if (
      !result ||
      !result.data
    ) {
      throw createProductError(
        404,
        "Producto no encontrado",
        `ADM Cloud no devolvió el producto ${normalizedProductId}.`,
        "ADMCLOUD_PRODUCT_NOT_FOUND",
        {
          admCloudStatus:
            response.status,

          admCloudData:
            result || null,
        }
      );
    }

    if (
      typeof result.data !==
      "object" ||
      Array.isArray(result.data)
    ) {
      throw createProductError(
        502,
        "Respuesta inválida de ADM Cloud",
        "ADM Cloud no devolvió un objeto de producto válido.",
        "INVALID_ADMCLOUD_PRODUCT_RESPONSE",
        {
          admCloudStatus:
            response.status,

          admCloudData:
            result,
        }
      );
    }

    const product =
      result.data;

    console.log(
      "✅ Producto encontrado:",
      {
        id:
          product.ID ??
          product.Id ??
          null,

        sku:
          product.SKU ??
          product.Reference ??
          null,

        name:
          product.Name ??
          product.Description ??
          null,
      }
    );

    // =================================================
    // 4. RETORNAR TODOS LOS CAMPOS SIN MODIFICAR
    // =================================================

    return {
      success: true,

      message:
        result.message || null,

      httpStatus:
        response.status,

      requestedProductId:
        normalizedProductId,

      product,

      // Mantiene disponible la respuesta original.
      rawResponse:
        result,
    };
  } catch (error) {
    // Los errores creados por este servicio
    // se vuelven a lanzar sin modificarlos.
    if (error.statusCode) {
      throw error;
    }

    const admCloudStatus =
      Number(
        error.response?.status
      ) || null;

    const admCloudData =
      error.response?.data ||
      null;

    console.error(
      "🔥 Error buscando producto ADM Cloud:",
      {
        productId:
          normalizedProductId,

        message:
          error.message,

        admCloudStatus,

        admCloudData,
      }
    );

    if (
      admCloudStatus === 404
    ) {
      throw createProductError(
        404,
        "Producto no encontrado",
        "ADM Cloud no encontró un producto con el GUID proporcionado.",
        "ADMCLOUD_PRODUCT_NOT_FOUND",
        {
          admCloudStatus,
          admCloudData,
        }
      );
    }

    throw createProductError(
      502,
      "Error consultando ADM Cloud",
      admCloudData?.message ||
      error.message ||
      "No se pudo consultar el producto en ADM Cloud.",
      "ADMCLOUD_PRODUCT_REQUEST_ERROR",
      {
        admCloudStatus,
        admCloudData,
      }
    );
  }
}

//Service to call adm cloud
export async function callAdmCloudProducts(
  params = {}
) {

  const response =
    await admcloudClient.get(
      "/Items",
      {
        params,
      }
    );

  return response.data;
}


// Service to search 50 until it calls all the products
const PAGE_SIZE = 50;

export async function getAdmCloudProducts() {
  const allProducts = [];

  let skip = 0;
  let callNumber = 1;

  while (true) {
    const response = await admcloudClient.get(
      "/Items",
      {
        params: {
          skip,
          // OnlyActive: true,
        },
      }
    );

    // Adm Cloud responde:
    // {
    //   success: true,
    //   message: null,
    //   data: [...]
    // }

    const products = response.data?.data || [];

    console.log(
      `📡 Llamada #${callNumber}: ${products.length} productos`
    );

    allProducts.push(...products);

    // Si llegaron menos de 50,
    // significa que llegamos a la última página
    if (products.length < PAGE_SIZE) {
      break;
    }

    skip += products.length;
    callNumber++;
  }

  console.log(
    `📦 Total de productos: ${allProducts.length}`
  );

  return allProducts;
}