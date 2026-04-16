import dotenv from "dotenv";

const env = process.env.NODE_ENV || "prod";

const envFile = env === "test"
  ? ".env.test"
  : ".env";

dotenv.config({ path: envFile });

console.log("🔥 ENV cargado:", envFile);