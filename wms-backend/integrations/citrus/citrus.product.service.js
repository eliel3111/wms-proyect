// services/product.service.js

export async function insertProductFromERP(client, item) {

    if (!item) {
        throw new Error("Item inválido recibido");
    }

    const erpId = item.Id ?? null;

    // SKU
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

    const name =
        item.Nombre ||
        item.Descripcion ||
        "SIN DESCRIPCIÓN";

    const description =
        item.Referencia ||
        "SIN DESCRIPCIÓN";    

    const uom = "UNITS";

    const uom_id =
        item.ItemUnidadIdSec
            ? Number(item.ItemUnidadIdSec)
            : 1;

    const isActive = item.Estatus === "A";

    const status = isActive ? "ACTIVE" : "INACTIVE";
    const deleted_erp = isActive ? false : true;

    // --------------------------------
    // 1️⃣ INTENTAR UPDATE PRIMERO
    // --------------------------------

 const updateResult = await client.query(`
    UPDATE products
    SET
        erp_name = $2,
        description = $3,
        uom = $4,
        uom_id = $5,
        status = $6,
        deleted_erp = $7,
        updated_at = now()
    WHERE erp_id = $1
    RETURNING *;
`, [
    erpId,
    name,
    description,
    uom,
    uom_id,
    status,
    deleted_erp
]);

    let product;

    if (updateResult.rowCount > 0) {

        product = updateResult.rows[0];

    } else {

        // --------------------------------
        // 2️⃣ SOLO SI NO EXISTE → INSERT
        // --------------------------------

        const insertResult = await client.query(`
    INSERT INTO products
    (
        erp_id,
        erp_name,
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
    ($1,$2,$3,$4,$5,$6,false,false,false,$7,$8,now())
    RETURNING *;
`, [
    erpId,
    name,
    sku,
    description,
    uom,
    uom_id,
    status,
    deleted_erp
]);

        product = insertResult.rows[0];
    }

    const productSku = product.sku;

    // --------------------------------
    // 3️⃣ BARCODE LOGIC
    // --------------------------------

    const barcode = item.CodigoBarra?.trim();

    if (barcode) {

        await client.query(`
            INSERT INTO product_barcodes
            (product_sku, barcode, is_primary, created_at)
            VALUES ($1,$2,true,now())
            ON CONFLICT (barcode) DO NOTHING
        `, [
            productSku,
            barcode
        ]);
    }

    return product;
}