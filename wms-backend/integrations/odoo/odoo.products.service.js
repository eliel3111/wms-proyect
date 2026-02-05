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

        // 🔒 Lock global
        lock = await lockSyncControl(model);

        if (!lock) {
            console.log(`[SYNC] ${model} ya está corriendo, se omite este ciclo`);
            return;
        }

        maxWriteDate = lock.lastWriteDate;

        /* ==========================
           1️⃣ TRAER PRODUCTOS ACTIVOS
        ========================== */
        const productDomain = [
            ["active", "=", true],
            ["write_date", ">", maxWriteDate]
        ];

        const productFields = [
            "id",
            "product_tmpl_id",
            "name",
            "default_code",
            "barcode",
            "uom_id",
            "write_date",
            "active"
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
                    { fields: productFields, limit: 500 }
                ],
                (err, res) => (err ? reject(err) : resolve(res))
            );
        });

        console.log("[SYNC 1] Productos activos encontrados: ", products);


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
            "write_date"
        ];
        const templateDomain = [
            ["id", "in", templateIds]
        ];
/*
        const templates = await new Promise((resolve, reject) => {
            client.methodCall(
                "execute_kw",
                [
                    process.env.ODOO_DB,
                    uid,
                    process.env.ODOO_API_KEY,
                    "product.template",
                    "search_read",
                    [templateDomain],
                    { fields: templateFields }
                ],
                (err, res) => (err ? reject(err) : resolve(res))
            );
        });

        console.log("[SYNC] Templates encontrados:");
        console.dir(templates, { depth: null });



        // 1️⃣ sacar template IDs únicos
        const templateIds = [
            ...new Set(
                products
                    .map(p => p.product_tmpl_id?.[0])
                    .filter(Boolean)
            )
        ];

        // 2️⃣ traer templates
        const templates = await getTemplatesByIds(templateIds);*/

        // 3️⃣ mapear templates por ID
        const templatesById = Object.fromEntries(
            templates.map(t => [t.id, t])
        );

        // 4️⃣ unir data (esto es lo que guardas en tu WMS)
        const result = products.map(p => {
            const tmpl = templatesById[p.product_tmpl_id[0]];

            return {
                erp_product_id: p.id,
                erp_template_id: p.product_tmpl_id[0],

                // template
                name: tmpl?.name,
                type: tmpl?.type,
                description_sale: tmpl?.description_sale,
                description_purchase: tmpl?.description_purchase,
                category_id: tmpl?.categ_id?.[0],

                // product
                sku: p.default_code,
                barcode: p.barcode,
                uom_name: p.uom_id?.[1],

                active: p.active,
                write_date: p.write_date
            };
        });

        console.dir(result, { depth: null });
        return result;

        /* ==========================
           2️⃣ UPSERT EN TU WMS
        ========================== */
        /*for (const p of products) {
          await upsertProduct({
            erp_product_id: p.id,
            erp_template_id: p.product_tmpl_id?.[0],
            name: p.name,
            sku: p.default_code,
            barcode: p.barcode,
            uom_id: p.uom_id?.[0],
            active: p.active,
            write_date: p.write_date
          });
    
          // mantener max write_date
          if (!maxWriteDate || p.write_date > maxWriteDate) {
            maxWriteDate = p.write_date;
          }
        }*/

        /* ==========================
           3️⃣ MARCAR SYNC SUCCESS
        ========================== */
        //await finishSyncControl(model, SYNC_STATUS.SUCCESS, maxWriteDate);

    } catch (error) {
        console.error(`[SYNC ERROR] ${model}`, error);
        /*await finishSyncControl(
          model,
          SYNC_STATUS.FAILED,
          lock.lastWriteDate,
          error.message
        );*/
        throw error;
    }
}
