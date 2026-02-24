import dotenv from "dotenv";
dotenv.config();
import { db } from "./db.js";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import apiRoutes from "./routes/apiRoutes.js";
//import { startCronJobs, productsCronJobs } from "./cron/cronJobs.js";
//import { startCitrusCron } from "./integrations/citrus/citrus.cron.js";




console.log("🔥 ESTE ES EL SERVER.JS QUE ESTÁ CORRIENDO 🔥");

//startCronJobs();
//productsCronJobs();

//CITRUS SYNC
//startCitrusCron();

const app = express();
const PORT = process.env.PORT || 3000;

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
