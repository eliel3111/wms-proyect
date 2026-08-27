import admcloudClient
  from "./admcloudClient.js";

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