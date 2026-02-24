import xmlrpc from "xmlrpc";

const ODOO_URL = process.env.ODOO_URL;
const ODOO_DB = process.env.ODOO_DB;
const ODOO_USER = process.env.ODOO_USER;
const ODOO_PASS = process.env.ODOO_PASS;

export async function getOdooWarehouses(uid) {
  return new Promise((resolve, reject) => {

    const models = xmlrpc.createClient({
      url: `${ODOO_URL}/xmlrpc/2/object`
    });

    models.methodCall(
      "execute_kw",
      [
        ODOO_DB,
        uid,
        ODOO_PASS,
        "stock.warehouse",
        "search_read",
        [[]],
        {
          fields: ["id", "name", "code", "active", "lot_stock_id"]
        }
      ],
      (err, value) => {
        if (err) return reject(err);
        resolve(value);
      }
    );
  });
}