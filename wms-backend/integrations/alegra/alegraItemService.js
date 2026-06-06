import alegraClient from "./alegraClient.js";

function cleanParams(params = {}) {
  return Object.fromEntries(
    Object.entries(params).filter(
      ([, value]) => value !== undefined && value !== null && value !== ""
    )
  );
}

async function get(url, params = {}) {
  const response = await alegraClient.get(url, {
    params: cleanParams(params),
  });

  return response.data;
}

async function post(url, body = {}, params = {}) {
  const response = await alegraClient.post(url, body, {
    params: cleanParams(params),
  });

  return response.data;
}

async function put(url, body = {}, params = {}) {
  const response = await alegraClient.put(url, body, {
    params: cleanParams(params),
  });

  return response.data;
}

export const alegraItemsService = {
  getItems: (params) => get("/items", params),

  getItemById: (id, params) => get(`/items/${id}`, params),

  createItem: (body, params) => post("/items", body, params),

  updateItem: (id, body, params) => put(`/items/${id}`, body, params),
};


export const alegraItemCategoriesService = {
  getCategories: (params) => get("/item-categories", params),

  getCategoryById: (id, params) => get(`/item-categories/${id}`, params),

  createCategory: (body, params) => post("/item-categories", body, params),

  updateCategory: (id, body, params) =>
    put(`/item-categories/${id}`, body, params),
};


export const alegraWarehousesService = {
  getWarehouses: (params) => get("/warehouses", params),

  getWarehouseById: (id, params) =>
    get(`/warehouses/${id}`, params),

  createWarehouse: (body, params) =>
    post("/warehouses", body, params),

  updateWarehouse: (id, body, params) =>
    put(`/warehouses/${id}`, body, params),
};


export const alegraPurchaseOrdersService = {
  getPurchaseOrders: (params) =>
    get("/purchase-orders", params),

  getPurchaseOrderById: (id, params) =>
    get(`/purchase-orders/${id}`, params),

  getAllPurchaseOrders: async (params = {}) => {
    const limit = 30;
    let start = 0;
    let allOrders = [];
    let page = 1;

    while (true) {
      console.log(
        `📄 Consultando página ${page} | start=${start} | limit=${limit}`
      );

      const orders = await get("/purchase-orders", {
        ...params,
        start,
        limit,
      });

      console.log(
        `✅ Página ${page} recibió ${orders?.length || 0} órdenes`
      );

      if (!orders || orders.length === 0) {
        console.log("🏁 No hay más órdenes");
        break;
      }

      allOrders.push(...orders);

      console.log(
        `📦 Total acumulado: ${allOrders.length} órdenes`
      );

      if (orders.length < limit) {
        console.log(
          `🏁 Última página encontrada (${orders.length} < ${limit})`
        );
        break;
      }

      start += limit;
      page++;
    }

    console.log(
      `🎉 Sincronización completada. Total órdenes: ${allOrders.length}`
    );

    return allOrders;
  },
};