import cron from "node-cron";
import { getActivePurchaseOrders, getPurchaseOrderLinesByOrderId } from "../integrations/odoo/odoo.purchase.service.js";
import { getActiveProducts } from "../integrations/odoo/odoo.products.service.js";

export function startCronJobs() {
    // Cada 15 minutos
    cron.schedule("* * * * *", async () => {
        try {
            console.log("[CRON] Sync PURSCHASE ORDER start");
            let orderLines;
            const orders = await getActivePurchaseOrders();

            for (const order of orders) {
                orderLines = await getPurchaseOrderLinesByOrderId(order.id);

                // guardar order + lines en tu WMS
            }


            console.log("[CRON] Sync PURSCHASE ORDER done, Count: ", orders.length, " Data: ", orders);
            console.log(orderLines);
        } catch (err) {
            console.error("[CRON] Sync PURSCHASE ORDER failed:", err);
        }
    });

    console.log("✅ Cron jobs started");
}


export function productsCronJobs() {
    // Cada 15 minutos
    cron.schedule("* * * * *", async () => {
  try {
    console.log("[CRON] Sync products start");
    await getActiveProducts();
    console.log("[CRON] Sync products done");
  } catch (err) {
    console.error("[CRON] Sync products failed:", err);
  }
});

    console.log("✅ Cron jobs started");
}
