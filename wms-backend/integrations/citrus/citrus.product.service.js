// services/product.service.js

export async function insertProductFromERP(client, item) {

    if (!item) {
        throw new Error("Item inválido recibido");
    }

    

    // 🆔 ERP ID
    const erpId = item.Id ?? null;

    // 1️⃣ SKU
    let sku = item.SKU;

    if (!sku || sku.trim() === "") {

        const lastSkuResult = await client.query(`
            SELECT sku
            FROM products
            WHERE sku LIKE 'SKU-%'
            ORDER BY id DESC
            LIMIT 1
        `);

        let nextNumber = 1;

        if (lastSkuResult.rowCount > 0) {
            const lastSku = lastSkuResult.rows[0].sku;
            const numericPart = parseInt(lastSku.split("-")[1]);
            nextNumber = numericPart + 1;
        }

        sku = `SKU-${String(nextNumber).padStart(3, "0")}`;
    }

    // 2️⃣ DESCRIPTION
    const description =
        item.Nombre ||
        item.Descripcion ||
        "SIN DESCRIPCIÓN";

    // 3️⃣ UOM
    const uom = "UNITS";

    // 4️⃣ UOM_ID
    const uom_id =
        item.ItemUnidadIdSec
            ? Number(item.ItemUnidadIdSec)
            : 1;

    // 5️⃣ STATUS + deleted_erp
    const isActive = item.Estatus === "A";

    const status = isActive ? "ACTIVE" : "INACTIVE";
    const deleted_erp = isActive ? false : true;

    // 6️⃣ UPSERT usando erp_id como clave principal
    const result = await client.query(`
        INSERT INTO products
        (
            erp_id,
            sku,
            description,
            uom,
            uom_id,
            is_lot_tracked,
            is_expirable,
            is_serialized,
            status,
            deleted_erp,
            updated_at
        )
        VALUES
        ($1,$2,$3,$4,$5,false,false,false,$6,$7,now())

        ON CONFLICT (erp_id)
        DO UPDATE SET
            sku = EXCLUDED.sku,
            description = EXCLUDED.description,
            uom = EXCLUDED.uom,
            uom_id = EXCLUDED.uom_id,
            status = EXCLUDED.status,
            deleted_erp = EXCLUDED.deleted_erp,
            updated_at = now()

        RETURNING *;
    `, [
        erpId,
        sku,
        description,
        uom,
        uom_id,
        status,
        deleted_erp
    ]);

const product = result.rows[0];
    const productSku = product.sku;

    // -------------------------------------------------
    // 7️⃣ BARCODE LOGIC
    // -------------------------------------------------

    const barcode = item.CodigoBarra?.trim();

    if (barcode) {

        // Buscar si el barcode ya existe para ese SKU
        const barcodeExists = await client.query(`
            SELECT 1
            FROM product_barcodes
            WHERE product_sku = $1
            AND barcode = $2
            LIMIT 1
        `, [productSku, barcode]);

        if (barcodeExists.rowCount === 0) {

            // Verificar si ya existe un barcode para ese SKU
            const existingBarcodes = await client.query(`
                SELECT 1
                FROM product_barcodes
                WHERE product_sku = $1
                LIMIT 1
            `, [productSku]);

            const isPrimary = existingBarcodes.rowCount === 0;

            await client.query(`
                INSERT INTO product_barcodes
                (
                    product_sku,
                    barcode,
                    is_primary,
                    created_at
                )
                VALUES ($1,$2,$3,now())
            `, [
                productSku,
                barcode,
                isPrimary
            ]);
        }
    }

    return product;
}