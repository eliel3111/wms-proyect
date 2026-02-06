import { getOdooClient } from "./odoo.client.js";
import { getOdooUid } from "./odoo.session.js";
import { db } from "../../db.js";
import { lockSyncControl, finishSyncControl } from "../odoo/syncControl.js"

const OLD_DATE = "2000-01-01 00:00:00";
const SYNC_STATUS = {
    RUNNING: "running",
    SUCCESS: "success",
    FAILED: "failed"
};

export async function getActiveProducts() {
  const model = "product.product";
  let lock = null;
  let maxWriteDate = null;

  try {
    const uid = await getOdooUid();
    const client = getOdooClient("object");

    lock = await lockSyncControl(model);
    if (!lock) {
      console.log(`[SYNC] ${model} ya está corriendo, se omite este ciclo`);
      return [];
    }

    maxWriteDate = lock.lastWriteDate;

    const productDomain = [
      ["active", "=", true],
      ["write_date", ">", maxWriteDate],
    ];

    const productFields = [
      "id",
      "product_tmpl_id",
      "name",
      "default_code",
      "barcode",
      "uom_id",
      "write_date",
      "active",
    ];

    const products = await new Promise((resolve, reject) => {
      client.methodCall(
        "execute_kw",
        [
          process.env.ODOO_DB,
          uid,
          process.env.ODOO_API_KEY,
          "product.product",
          "search_read",
          [productDomain],
          { fields: productFields, limit: 500 },
        ],
        (err, res) => (err ? reject(err) : resolve(res))
      );
    });

    if (!products.length) {
      await finishSyncControl(model, SYNC_STATUS.SUCCESS, maxWriteDate);
      return [];
    }

    // actualizar maxWriteDate
    for (const p of products) {
      if (!maxWriteDate || p.write_date > maxWriteDate) {
        maxWriteDate = p.write_date;
      }
    }

    const templateIds = [
      ...new Set(products.map(p => p.product_tmpl_id?.[0]).filter(Boolean)),
    ];

    const templateFields = [
      "id",
      "name",
      "type",
      "categ_id",
      "description_purchase",
      "description_sale",
      "sale_ok",
      "purchase_ok",
      "active",
      "write_date",
    ];

    let templates = [];
    if (templateIds.length) {
      const templateDomain = [["id", "in", templateIds]];

      templates = await new Promise((resolve, reject) => {
        client.methodCall(
          "execute_kw",
          [
            process.env.ODOO_DB,
            uid,
            process.env.ODOO_API_KEY,
            "product.template",
            "search_read",
            [templateDomain],
            { fields: templateFields },
          ],
          (err, res) => (err ? reject(err) : resolve(res))
        );
      });
    }

    const templatesById = Object.fromEntries(templates.map(t => [t.id, t]));

    const result = products.map(p => {
      const tmplId = p.product_tmpl_id?.[0];
      const tmpl = tmplId ? templatesById[tmplId] : null;

      return {
        erp_product_id: p.id,
        erp_template_id: tmplId,

        name: tmpl?.name,
        type: tmpl?.type,
        description_sale: tmpl?.description_sale,
        description_purchase: tmpl?.description_purchase,
        category_id: tmpl?.categ_id?.[0],

        sku: p.default_code,
        barcode: p.barcode,
        uom_name: p.uom_id?.[1],

        active: p.active,
        write_date: p.write_date,
      };
    });

    console.log("RESULTADO: ", result)

    await finishSyncControl(model, SYNC_STATUS.SUCCESS, maxWriteDate);
    return result;

  } catch (error) {
    console.error(`[SYNC ERROR] ${model}`, error);

    if (lock) {
      await finishSyncControl(model, SYNC_STATUS.FAILED, lock?.lastWriteDate, error.message);
    }
    throw error;
  }
}
