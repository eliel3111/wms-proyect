import { db } from "./db.js";

async function testConnection() {
  try {
    const result = await db.query("SELECT NOW()");
    console.log("✅ PostgreSQL conectado correctamente:");
    console.log(result.rows[0]);
  } catch (err) {
    console.error("❌ Error conectando a PostgreSQL:");
    console.error(err);
  } finally {
    db.end();
  }
}

testConnection();
