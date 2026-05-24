// services/product.service.js
// #6Esta función se encarga de sincronizar un producto que viene desde un ERP hacia tu base de datos. Primero valida que el objeto recibido sea válido y obtiene su identificador (erp_id). Luego revisa si el producto ya existe en la tabla products usando ese erp_id: si existe, lo actualiza con la información más reciente; si no existe, lo inserta como un nuevo registro. Durante este proceso, si el producto no trae un SKU, la función genera uno automáticamente basado en el último SKU registrado. También mapea campos del ERP como nombre, descripción, unidad de medida y estado (activo o inactivo). Finalmente, si el producto incluye un código de barras, lo guarda en una tabla separada evitando duplicados. En resumen, garantiza que los productos del ERP estén correctamente creados o actualizados en tu sistema sin generar duplicados y manteniendo la información sincronizada.
export async function insertProductFromERP(client, item) {

    if (!item) {
        throw new Error("Item inválido recibido");
    }

    const erpId = item.Id ?? null;

    // SKU 
     let erp_sku = item.SKU;
     let sku = "";

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
        item.Nombre;

    const description =
        item.Descripcion ||
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
        erp_sku = $3,
        description = $4,
        uom = $5,
        uom_id = $6,
        status = $7,
        deleted_erp = $8,
        updated_at = now()
    WHERE erp_id = $1
    RETURNING *;
`, [
    erpId,
    name,
    erp_sku,
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
        erp_sku,
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
    ($1,$2,$3,$4,$5,$6,$7,false,false,false,$8,$9,now())
    RETURNING *;
`, [
    erpId,
    name,
    erp_sku,
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
SELECT
    $1::text,
    $2::text,
    NOT EXISTS (
        SELECT 1
        FROM product_barcodes
        WHERE product_sku = $1::text
          AND is_primary = true
    ),
    now()
ON CONFLICT (barcode) DO NOTHING;
`, [
    productSku,
    barcode
]);
    }

    return product;
}