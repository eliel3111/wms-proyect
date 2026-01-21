export async function getActiveProductById(client, productId) {
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

  if (result.rowCount === 0) {
    return null;
  }

  return result.rows[0];
}


/*Usando el sku de un producto te da el codigo de barra primario de ese producto*/

export async function getPrimaryBarcodeBySku(client, sku) {
  return client.query(`
    SELECT barcode
    FROM product_barcodes
    WHERE product_sku = $1
    ORDER BY is_primary DESC, id ASC
    LIMIT 1
  `, [sku]);
}

