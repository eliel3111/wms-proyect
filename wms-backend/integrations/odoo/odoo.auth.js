import { getOdooClient } from "./odoo.client.js";

export function authenticateOdoo() {
  const client = getOdooClient("common");

  return new Promise((resolve, reject) => {
    client.methodCall(
      "authenticate",
      [
        process.env.ODOO_DB,
        process.env.ODOO_USER,
        process.env.ODOO_API_KEY,
        {},
      ],
      (error, uid) => {
        if (error) {
          console.error("Odoo XML-RPC error:", error);
          return reject(error);
        }

        if (!uid) {
          return reject(new Error("Invalid Odoo credentials"));
        }

        resolve(uid);
      }
    );
  });
}
