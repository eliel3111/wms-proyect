import pkg from "pg";

const { Pool } = pkg;

console.log("DB CONFIG:", {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  database: process.env.DB_NAME,
});


// ============================================================
// POOL GENERAL
// WMS + CRON + ENDPOINTS NORMALES
// ============================================================

export const db = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,

  ssl:
    process.env.DB_SSL === "true"
      ? { rejectUnauthorized: false }
      : false,

  // Máximo de conexiones simultáneas del pool general
  max: 50,

  // Tiempo máximo esperando una conexión disponible
  connectionTimeoutMillis: 30000,

  // Cerrar conexiones ociosas después de 30 segundos
  idleTimeoutMillis: 30000,

  // Una query individual no puede durar más de 30 segundos
  statement_timeout: 30000,
});


// ============================================================
// POOL EXCLUSIVO PARA AUTENTICACIÓN
// LOGIN + REFRESH TOKEN + LOGOUT
// ============================================================

export const authDb = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,

  ssl:
    process.env.DB_SSL === "true"
      ? { rejectUnauthorized: false }
      : false,

  // Estas conexiones quedan separadas del pool general
  max: 5,

  // Auth no debe quedarse esperando 30 segundos
  connectionTimeoutMillis: 5000,

  idleTimeoutMillis: 30000,

  statement_timeout: 30000,
});


// ============================================================
// MONITOREO DEL POOL GENERAL
// ============================================================

setInterval(() => {

  console.log("📊 DB POOL GENERAL:", {
    total: db.totalCount,
    idle: db.idleCount,
    waiting: db.waitingCount,
  });

}, 10000);


// ============================================================
// MONITOREO DEL POOL DE AUTENTICACIÓN
// ============================================================

setInterval(() => {

  console.log("🔐 DB POOL AUTH:", {
    total: authDb.totalCount,
    idle: authDb.idleCount,
    waiting: authDb.waitingCount,
  });

}, 10000);


export default db;