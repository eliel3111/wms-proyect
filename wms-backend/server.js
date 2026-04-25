console.log("🚨 SERVER NUEVO EJECUTANDO 🚨");
import "./env.js"; // 🔥 PRIMERO

import { db } from "./db.js";

import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import apiRoutes from "./routes/apiRoutes.js";

//import { getActiveSaleOrders } from "./integrations/odoo/odoo.sale.service.js";
// [ODOO] import { getActiveSaleMoves } from "./integrations/odoo/odoo.sale.lines.service.js";
import { startCronJobs, productsCronJobs } from "./cron/cronJobs.js";
import { startCitrusCron } from "./integrations/citrus/citrus.cron.js";
//import { startWarehouseCron } from "./cron/cronJobs.js";
import { startMainCron, runFullSync } from "./cron/cronJobs.js";
import { assignmentService } from "./services/saleAssignmentService.js";
import {syncAllPurchaseOrders} from "./integrations/citrus/citrus.sync.js"

import { reserveInventoryForMove } from "./services/pickingBestRoute.js"


import { fetchPurchaseOrdersTest } from "./integrations/citrus/citrus.items.js";

//ALEGRA
import { alegraItemsService, alegraItemCategoriesService, alegraWarehousesService } from "./integrations/alegra/alegraItemService.js";
import {getActiveSaleOrders} from "./integrations/citrus/citrus.saleOrder.js"
import {upsertWarehouses} from "./integrations/alegra/alegra.wharehouse.js"


import { inventoryScan } from "./controllers/inventoryController.js";



const app = express();

app.get("/alegra", async (req, res) => {
  try {

//ALMACEN
const warehouses = await alegraWarehousesService.getWarehouses({status: 'active'});
await upsertWarehouses(warehouses);

console.log(warehouses);

    
//PRODUCTOS
/*const products = await alegraItemsService.getItems({
  start: 0,
  limit: 30,
  metadata: true,
  status: 'active',
});*/


    res.json({
      success: true,
      data: warehouses,
    });
  } catch (error) {
    console.error("❌ Error en /test:", error.message);

    res.status(500).json({
      success: false,
      message: "Error obteniendo productos de Alegra",
      error: error.message,
    });
  }
});


const PORT = process.env.PORT || 3000;
app.get("/test-purchase-orders", async (req, res) => {
  console.log("🚨CPO CHECK 1");
  const data = await getActiveSaleOrders();

  res.json({
    success: true,
    data
  });
});
app.use(express.json());



//app.post("/inventory", inventoryScan);







console.log("🔥 CRON NUEVO EJECUTANDO 🔥");
// 🔥 Cron automático
//startMainCron();

// [ODOO]
//await runFullSync();
//[ODOO] SALES ORDER
app.get("/test-sale-orders", async (req, res) => {

  try {

    const picking = await getActiveSaleOrders();
   console.log("🟩TERMINO PROCESO");

    //const moves = await getActiveSaleMoves(picking);

    //await assignmentService();

    res.json({
      success: true,
      data: true
    });

  } catch (error) {

    res.json({
      success: false,
      error: error.message
    });

  }

});



//startCronJobs();
//productsCronJobs();
//console.log("🔥 LLAMANDO CRON 🔥");
//startWarehouseCron();




//[CITRUS] SYNC ITEMS AND PURCHASE ORDERS
//startCitrusCron();



// -----------------------------
// 1. Middlewares globales
// -----------------------------
const res = await db.query("SELECT current_database()");
console.log("USANDO DB:", res.rows[0].current_database);




const allowedOrigins = [
  "http://localhost:5173",
  "http://192.168.1.43:5173",
  "https://wms-proyect.vercel.app",
  "https://www.sidialwms.com"
];

app.use(cors({
  origin: function (origin, callback) {

    // permitir sin origin (postman, mobile direct)
    if (!origin) return callback(null, true);

    // permitir red local completa (wifi)
    if (origin.startsWith("http://192.168")) {
      return callback(null, true);
    }

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    console.log("❌ CORS blocked:", origin);
    callback(new Error("Not allowed by CORS"));
  },
  credentials: true
}));



app.use(express.json());
app.use(cookieParser()); // ← ahora sí, en el orden correcto
app.use("/api", apiRoutes);
app.get("/health", (req, res) => res.json({ ok: true }));
app.get("/__ping", (req, res) => res.send("pong"));

// -----------------------------
// 3. Iniciar servidor
// -----------------------------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
