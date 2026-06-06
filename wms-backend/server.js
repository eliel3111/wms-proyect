console.log("🚨 SERVER NUEVO EJECUTANDO 🚨");
import "./env.js"; // 🔥 PRIMERO

import { db } from "./db.js";

import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import apiRoutes from "./routes/apiRoutes.js";
import http from "http";
import { Server } from "socket.io";
import { setIO } from "./socket.js";

//import { getActiveSaleOrders } from "./integrations/odoo/odoo.sale.service.js";
//[ODOO] import { getActiveSaleMoves } from "./integrations/odoo/odoo.sale.lines.service.js";
import { startCronJobs, productsCronJobs } from "./cron/cronJobs.js";
//import { startWarehouseCron } from "./cron/cronJobs.js";
import { startMainCron, runFullSync } from "./cron/cronJobs.js";
import { assignmentService } from "./services/saleAssignmentService.js";
import { reserveInventoryForMove } from "./services/pickingBestRoute.js"


//CITRUS
import { fetchPurchaseOrdersTest, fetchAllItemsAndSync } from "./integrations/citrus/citrus.items.js";
import { createConduce } from "./integrations/citrus/citrus.saleOrder.js";
import {getActiveSaleOrders} from "./integrations/citrus/citrus.saleOrder.js"
import {syncAllPurchaseOrders} from "./integrations/citrus/citrus.sync.js";
import { startCitrusCron } from "./integrations/citrus/citrus.cron.js";

//ALEGRA
import { alegraItemsService, alegraItemCategoriesService, alegraWarehousesService } from "./integrations/alegra/alegraItemService.js";
import {
  alegraPurchaseOrdersService,
} from "./integrations/alegra/alegraItemService.js";
import {upsertWarehouses} from "./integrations/alegra/alegra.wharehouse.js";
import {chunkArray,  processInParallel} from "./integrations/alegra/alegra.item.js";






const app = express();

//ALEGRA
//🟪🟪🟪🟪🟪🟪🟪🟪🟪🟪🟪🟪🟪🟪
app.get("/alegra", async (req, res) => {
  try {


/*const warehouses = await alegraWarehousesService.getWarehouses({status: 'active'});
await upsertWarehouses(warehouses);*/



   
//PRODUCTOS
/*let allProducts = [];
  let start = 0;
  const limit = 30;
  let total = 0;

  do {
    const response = await alegraItemsService.getItems({
      start,
      limit,
      metadata: true,
      status: 'active',
    });

    const data = response.data;
    const metadata = response.metadata;
    console.log(data);
    total = metadata.total;

    allProducts = allProducts.concat(data);

    console.log(`📦 Traídos: ${allProducts.length} / ${total}`);

    start += limit;

  } while (allProducts.length < total);


 //console.log("TOTAL DE PRODUCTOS", allProducts);

 /*PRUEBA DE 30
 let allProducts = [];

const response = await alegraItemsService.getItems({
  start: 0,
  limit: 30,
  metadata: true,
  status: 'active',
});

allProducts = response.data;

//console.log(allProducts);*/

//-------------------------------------------------
/*const BATCH_SIZE = 100;
const CONCURRENCY = 1;
const chunks = chunkArray(allProducts, BATCH_SIZE);
await processInParallel(chunks, CONCURRENCY);
console.log("🎉 Todos los batches procesados");*/
//-------------------------------------------------

//Busca todas las ordenes de compra
const orders =
  await alegraPurchaseOrdersService.getAllPurchaseOrders();

//console.log(orders);

    res.json({
      success: true,
      data: orders,
      //data: allProducts,
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
//🟪🟪🟪🟪🟪🟪🟪🟪🟪🟪🟪🟪🟪🟪



//CITRUS
//🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩

//[CITRUS] SYNC ITEMS AND PURCHASE ORDERS
//startCitrusCron();

//Sincroniza todos los productos con el ERO Citrus de prueba
app.get("/test-sync-items", async (req, res) => {

    try {

        console.log("🚀 TEST SYNC ITEMS INICIADO");

        // Obtener nombre de la BD actual
    const result = await db.query(`
        SELECT current_database() AS db
    `);

    const currentDb = result.rows[0].db;

    console.log("DATABASE:", currentDb);

    // Validar producción
    if (currentDb !== "wms_db") {
        return res.status(403).json({
            success: false,
            message: "Este endpoint solo funciona en PRODUCCIÓN"
        });
    }


        const items = await fetchAllItemsAndSync();

        console.log("✅ TEST FINALIZADO");

       /* return res.json({
            success: true,
            total_items: items.length,
            message: "Sync test completed"
        });*/
        return res.json({
            success: true,
            message: "Sync test completed"
        });

    } catch (error) {

        console.error(
            "🔥 ERROR TEST ENDPOINT:",
            error
        );

        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});


const PORT = process.env.PORT || 3000;
app.get("/test-purchase-orders", async (req, res) => {
  console.log("🚨CPO CHECK 1");
  const data = await getActiveSaleOrders();
  //await assignmentService();

  res.json({
    success: true,
    data
  });
});
app.use(express.json());

/* ==================================================
   TEST CREAR CONDUCE
================================================== */

app.post("/test-create-conduce", async (req, res) => {

  try {

    const payloadERP = {

      ClienteId: 1,

      ClienteNombre: "Cliente Consumidor Final",

      ClienteDireccion: "Santo Domingo",

      Fecha: new Date(),

      Estatus: "A",

      TiendaId: 1,

      VendedorId: 1,

      Nota: "Conduce creado desde WMS",

      OrdenVentaId: 3,

      Detalles: [

        {
          ItemId: 2,
          ItemNombre: "Producto Prueba",
          ItemCantidad: 1
        },

        {
          ItemId: 4,
          ItemNombre: "11088F 3/4 95H",
          ItemCantidad: 1
        }

      ]

    };

    console.log("🟨 PAYLOAD ERP:");
    console.log(JSON.stringify(payloadERP, null, 2));

    /* =====================================
       CREATE CONDUCE
    ===================================== */

    const responseERP = await createConduce(payloadERP);

    console.log("🟩 ERP RESPONSE:");
    console.log(responseERP);

    /* =====================================
       SUCCESS
    ===================================== */

    return res.status(200).json({

      success: true,

      payloadERP,

      responseERP

    });

  } catch (error) {

    console.error("🟥 TEST CREATE CONDUCE ERROR:");
    console.error(error);

    return res.status(500).json({

      success: false,

      message: error.message

    });
  }

});
//🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩


//ODOO
//🟨🟨🟨🟨🟨🟨🟨🟨🟨🟨🟨🟨🟨🟨🟨🟨🟨🟨
console.log("🔥 ODOO CRON NUEVO EJECUTANDO 🔥");
// 🔥 Cron automático
//startMainCron();

// [ODOO]
//await runFullSync();
//[ODOO] SALES ORDER
app.get("/test-sale-orders", async (req, res) => {

  try {

    const picking = await getActiveSaleOrders();
   console.log("🟩TERMINO PROCESO");

    const moves = await getActiveSaleMoves(picking);

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

//🟨🟨🟨🟨🟨🟨🟨🟨🟨🟨🟨🟨🟨🟨🟨🟨🟨🟨






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
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*", // luego puedes restringir igual que tu CORS
  },
});

// Guardar instancia global
setIO(io);

io.on("connection", (socket) => {
  console.log("🟢 Cliente conectado:", socket.id);

  socket.on("join_inventory_summary", () => {
    socket.join("inventory_summary");
    console.log(`📦 ${socket.id} joined inventory_summary`);
  });

  socket.on("disconnect", () => {
    console.log("🔴 Cliente desconectado:", socket.id);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server + Socket corriendo en puerto ${PORT}`);
});
