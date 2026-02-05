import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import apiRoutes from "./routes/apiRoutes.js";
import { startCronJobs, productsCronJobs } from "./cron/cronJobs.js";



console.log("🔥 ESTE ES EL SERVER.JS QUE ESTÁ CORRIENDO 🔥");

//startCronJobs();
//productsCronJobs();

const app = express();
const PORT = process.env.PORT || 3000;

// -----------------------------
// 1. Middlewares globales
// -----------------------------
console.log("🗄️ DB HOST:", process.env.DB_HOST);

/*app.use(
  cors({
    origin: process.env.FRONTEND_URL,
    credentials: true,// Necesario para enviar cookies al frontend
  })
);*/

const allowedOrigins = [
  "http://localhost:5173",
  "https://wms-proyect.vercel.app",
  "https://www.sidialwms.com"
];

app.use(
  cors({
    origin: function (origin, callback) {
      // permitir requests sin origin (Postman, cron, etc.)
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);

app.options("*", cors());


app.use(express.json());
app.use(cookieParser()); // ← ahora sí, en el orden correcto

// -----------------------------
// 2. Rutas de API
// -----------------------------
app.use("/api", apiRoutes);
app.get("/health", (req, res) => res.json({ ok: true })); 
app.get("/__ping", (req, res) => res.send("pong"));

// -----------------------------
// 3. Iniciar servidor
// -----------------------------
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
