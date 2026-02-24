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
        //console.log("LOCK", lock);
        if (!lock) {
            console.log(`[SYNC] ${model} ya está corriendo, se omite este ciclo`);
            return [];
        }

        maxWriteDate = lock.lastWriteDate;

        // 🔎 CHECK RAPIDO SI HAY CAMBIOS
        const hasChanges = await new Promise((resolve, reject) => {
            client.methodCall(
                "execute_kw",
                [
                    process.env.ODOO_DB,
                    uid,
                    process.env.ODOO_API_KEY,
                    "product.product",
                    "search_count",
                    [[["write_date", ">", maxWriteDate]]],
                ],
                (err, res) => (err ? reject(err) : resolve(res))
            );
        });

        if (!hasChanges) {
            console.log("[SYNC] Sin cambios en productos");
            await finishSyncControl(model, SYNC_STATUS.SUCCESS, maxWriteDate);
            return [];
        }


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

        for (const p of products) {
            const productDate = new Date(p.write_date);
            const currentMax = maxWriteDate ? new Date(maxWriteDate) : null;

            if (!currentMax || productDate > currentMax) {
                console.log("fecha de producto:", p.write_date);
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
        console.log("DATE: ", maxWriteDate);


        for (const p of result) {

            /* =====================================
               1️⃣ VALIDAR SKU
            ===================================== */
            if (!p.sku || p.sku === false) {
                console.error(
                    `[SYNC PRODUCT] ❌ Producto ERP ${p.erp_product_id} sin SKU → SKIPPED`
                );
                continue;
            }

            /* =====================================
               2️⃣ NORMALIZAR DATA
            ===================================== */
            const sku = String(p.sku).trim();

            const description =
                p.description_sale ||
                p.description_purchase ||
                p.name ||
                "SIN DESCRIPCION";

            // UOM obligatorio uppercase <=10
            const uom = (p.uom_name || "UNITS").toUpperCase().slice(0, 10);

            const status = p.active ? "ACTIVE" : "INACTIVE";
            const categoryId = p.category_id || null;

            /* =====================================
               3️⃣ UPSERT
            ===================================== */
            try {
                await db.query(
                    `
      INSERT INTO products (
        sku,
        description,
        uom,
        status,
        category_id,
        deleted_erp
      )
      VALUES ($1,$2,$3,$4,$5,false)

      ON CONFLICT (sku)
      DO UPDATE SET
        description = EXCLUDED.description,
        uom = EXCLUDED.uom,
        status = EXCLUDED.status,
        category_id = EXCLUDED.category_id,
        deleted_erp = false,
        updated_at = now()
      `,
                    [
                        sku,
                        description,
                        uom,
                        status,
                        categoryId
                    ]
                );

                console.log(`[SYNC PRODUCT] ✅ ${sku} upsert OK`);

            } catch (err) {
                console.error(
                    `[SYNC PRODUCT ERROR] SKU ${sku}`,
                    err.message
                );
            }
        }






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
