console.log("🚨 SERVER NUEVO EJECUTANDO 🚨");
import dotenv from "dotenv";
dotenv.config();
import { db } from "./db.js";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import apiRoutes from "./routes/apiRoutes.js";
import { getActiveSaleOrders } from "./integrations/odoo/odoo.sale.service.js";
import { getActiveSaleMoves } from "./integrations/odoo/odoo.sale.lines.service.js";
import { startCronJobs, productsCronJobs } from "./cron/cronJobs.js";
import { startCitrusCron } from "./integrations/citrus/citrus.cron.js";
//import { startWarehouseCron } from "./cron/cronJobs.js";
import { startMainCron, runFullSync } from "./cron/cronJobs.js";
import { assignmentService } from "./services/saleAssignmentService.js";
import {syncAllPurchaseOrders} from "./integrations/citrus/citrus.sync.js"

import { reserveInventoryForMove } from "./services/pickingBestRoute.js"




import { fetchPurchaseOrdersTest } from "./integrations/citrus/citrus.items.js";
const app = express();
const PORT = process.env.PORT || 3000;
/*app.get("/test-purchase-orders", async (req, res) => {
  //console.log("🚨CPO CHECK 1");
  const data = await syncAllPurchaseOrders();

  res.json({
    success: true,
    data
  });
});*/
app.use(express.json());
app.post("/test/reserve-real", async (req, res) => {
  const client = await db.connect();

  console.log("🟥 Endpoint POST /test/reserve-real iniciado");

  try {
    await client.query("BEGIN");
 console.log(req.body);
    const { data } = req.body;

    if (!data || !Array.isArray(data)) {
      return res.status(400).json({
        success: false,
        message: "Data inválida"
      });
    }

    let totalReserved = 0;
    let results = [];

    /* ==============================
       1️⃣ PROBAR FUNCIÓN REAL
    ============================== */

    for (const move of data) {

      console.log("🟡 Probando producto:", move.product_id);

      // 🔥 AQUÍ LLAMAS TU FUNCIÓN REAL
      const result = await reserveInventoryForMove(client, move);

      console.log("Resultado reserva real:", result);

      totalReserved += result.reserved;

      results.push({
        product_id: move.product_id,
        reserved: result.reserved
      });
    }

    /* ==============================
       2️⃣ VALIDACIÓN
    ============================== */

    if (totalReserved === 0) {
      console.log("⚠️ No se reservó nada");

      await client.query("ROLLBACK");

      return res.status(200).json({
        success: false,
        message: "No se pudo reservar inventario",
        results
      });
    }

    await client.query("COMMIT");

    console.log(
      `🟨 Total reservado: ${totalReserved} | Productos: ${data.length}`
    );

    console.log("🟩 Endpoint POST /test/reserve-real terminado");

    return res.status(200).json({
      success: true,
      totalReserved,
      results
    });

  } catch (error) {

    await client.query("ROLLBACK");

    console.error("🟥 ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Error en prueba de reserva"
    });

  } finally {
    client.release();
  }
});
































console.log("🔥 CRON NUEVO EJECUTANDO 🔥");
// 🔥 Cron automático
//startMainCron();

// 🔥 Ejecutar manual al iniciar (opcional)
// await runFullSync();

app.get("/test-sale-orders", async (req, res) => {

  try {

    const picking = await getActiveSaleOrders();
   console.log("RESULTADO FINAL 🚨🚨🚨🚨 ", picking);

    const moves = await getActiveSaleMoves(picking);

    await assignmentService();

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




//CITRUS SYNC
//startCitrusCron();



// -----------------------------
// 1. Middlewares globales
// -----------------------------
const res = await db.query("SELECT current_database()");
console.log("USANDO DB:", res.rows[0].current_database);


/*app.use(
  cors({
    origin: process.env.FRONTEND_URL,
    credentials: true,// Necesario para enviar cookies al frontend
  })
);*/



const allowedOrigins = [
  "http://localhost:5173",
  "http://192.168.1.44:5173",
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

// -----------------------------
// 2. Rutas de API
// -----------------------------
app.post("/webhook/products", async (req, res) => {
  console.log("Webhook product:", req.body);

  // guardar o sync
  //await syncProduct(req.body);

  res.sendStatus(200);
});



app.use("/api", apiRoutes);
app.get("/health", (req, res) => res.json({ ok: true }));
app.get("/__ping", (req, res) => res.send("pong"));

// -----------------------------
// 3. Iniciar servidor
// -----------------------------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
