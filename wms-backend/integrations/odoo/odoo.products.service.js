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
        console.log("PRODUCTS", products);
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
            1️⃣ VALIDAR ERP ID
            ===================================== */
            if (!p.erp_product_id) {
                console.error(
                    `[SYNC PRODUCT] ❌ Producto sin ERP ID → SKIPPED`
                );
                continue;
            }

            /* =====================================
               1️⃣ VALIDAR SKU
            ===================================== */
            let sku = p.sku ? String(p.sku).trim() : null;

            if (!p.sku || p.sku === false) {
                console.warn(
                    `[SYNC PRODUCT] ⚠️ Producto ERP ${p.erp_product_id} sin SKU → Generando automático`
                );

                // 🔎 Buscar si ya existe en DB por erp_id
                const existing = await db.query(
                    `SELECT sku FROM products WHERE erp_id = $1 LIMIT 1`,
                    [p.erp_product_id]
                );

                if (existing.rowCount > 0) {
                    // ✅ Reusar SKU existente
                    sku = existing.rows[0].sku;
                    console.log(`[SYNC PRODUCT] 🔁 Reutilizando SKU existente: ${sku}`);
                } else {

                    // 🔢 Buscar último SKU tipo SKU-XXX
                    const lastSkuResult = await db.query(`
            SELECT sku
            FROM products
            WHERE sku LIKE 'SKU-%'
            ORDER BY sku DESC
            LIMIT 1
        `);

                    let nextNumber = 1;

                    if (lastSkuResult.rowCount > 0) {
                        const lastSku = lastSkuResult.rows[0].sku; // SKU-058
                        const match = lastSku.match(/SKU-(\d+)/);

                        if (match) {
                            nextNumber = parseInt(match[1], 10) + 1;
                        }
                    }

                    sku = `SKU-${String(nextNumber).padStart(3, "0")}`;

                    console.log(`[SYNC PRODUCT] 🆕 SKU generado automáticamente: ${sku}`);
                }
            }

            console.log("ESTO ES P", p);

            /* =====================================
               2️⃣ NORMALIZAR DATA
            ===================================== */


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
  erp_id,
  sku,
  description,
  uom,
  status,
  category_id,
  deleted_erp
)
VALUES ($1,$2,$3,$4,$5,$6,false)

ON CONFLICT (erp_id)
DO UPDATE SET
  sku = EXCLUDED.sku,
  description = EXCLUDED.description,
  uom = EXCLUDED.uom,
  status = EXCLUDED.status,
  category_id = EXCLUDED.category_id,
  deleted_erp = false,
  updated_at = now()
`,
                    [
                        p.erp_product_id,
                        sku,
                        description,
                        uom,
                        status,
                        categoryId
                    ]
                );

                console.log(`[SYNC PRODUCT] ✅ ${sku} upsert OK`);

                // 👇 verificar barcode
                if (p.barcode) {

                    console.log(sku);
                    console.log(p.barcode);



                    // 1️⃣ buscar barcodes existentes
                    const existing = await db.query(
                        `SELECT barcode 
             FROM product_barcodes
             WHERE product_sku = $1`,
                        [sku]
                    );

                    // 2️⃣ si no hay barcodes
                    if (existing.rows.length === 0) {

                        await db.query(
                            `INSERT INTO product_barcodes (product_sku, barcode, is_primary)
                 VALUES ($1, $2, $3)`,
                            [sku, p.barcode, true]
                        );

                        console.log("✅ Barcode primario insertado:", p.barcode);

                    } else {

                        // 3️⃣ verificar si ya existe
                        const barcodeExists = existing.rows.some(
                            row => row.barcode === p.barcode
                        );

                        if (!barcodeExists) {

                            await db.query(
                                `INSERT INTO product_barcodes (product_sku, barcode, is_primary)
                     VALUES ($1, $2, $3)`,
                                [sku, p.barcode, false]
                            );

                            console.log("➕ Barcode adicional insertado:", p.barcode);

                        } else {

                            console.log("⚪ Barcode ya existe:", p.barcode);

                        }
                    }
                }

            } catch (err) {
    console.error(
        `[SYNC PRODUCT ERROR] ERP ${p.erp_product_id}`,
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
