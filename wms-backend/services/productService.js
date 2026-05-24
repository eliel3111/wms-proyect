export async function getActiveProductById(client, productId) {
  console.log("Eliel")
  const result = await client.query(
    `
    SELECT 
      id,
      sku,
      description,
      uom
    FROM products
    WHERE id = $1
      AND status = 'ACTIVE'
      AND deleted_erp = false
    LIMIT 1
    `,
    [productId]
  );
  console.log("Eliel")

  if (result.rowCount === 0) {
    return null;
  }

  return result.rows[0];
}


/*Usando el sku de un producto te da el codigo de barra primario de ese producto*/

export async function getPrimaryBarcodeBySku(client, sku) {

  return client.query(`
    SELECT
      id,
      barcode,
      is_primary
    FROM product_barcodes
    WHERE product_sku = $1
    ORDER BY is_primary DESC, id ASC
  `, [sku]);

}

// Utilizando un sku el me devuelve la informacion basica de un producto

// services/product.service.js

export async function getActiveProductBySku(db, sku) {
  const result = await db.query(
    `
    SELECT
      id,
      sku,
      description,
      uom
    FROM products
    WHERE sku = $1
      AND status = 'ACTIVE'
      AND deleted_erp = false
    LIMIT 1
    `,
    [sku]
  );

  return result.rowCount ? result.rows[0] : null;
}



