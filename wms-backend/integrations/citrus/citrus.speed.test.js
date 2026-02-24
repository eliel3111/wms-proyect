import { fetchItemsPage } from "./citrus.items.js";

export async function testSpeed() {

  console.log("🚀 Test velocidad ERP");

  console.time("⏱ 1 request");
  await fetchItemsPage(0, 5);
  console.timeEnd("⏱ 1 request");

  console.time("⏱ 3 requests paralelo");

  await Promise.all([
    fetchItemsPage(0,5),
    fetchItemsPage(1,5),
    fetchItemsPage(2,5),
  ]);

  console.timeEnd("⏱ 3 requests paralelo");
}

testSpeed();
