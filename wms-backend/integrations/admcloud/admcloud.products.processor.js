import crypto from "crypto";
import { db } from "../../db.js";


// ======================================================
// DIVIDIR PRODUCTOS EN BATCHES
// ======================================================

export function chunkArray(array, size) {
  const result = [];

  for (let i = 0; i < array.length; i += size) {
    result.push(
      array.slice(i, i + size)
    );
  }

  return result;
}


// ======================================================
// PROCESAR BATCHES CON CONCURRENCIA CONTROLADA
// ======================================================

export async function processInParallel(
  chunks,
  concurrency = 4
) {
  let index = 0;

  async function worker(workerId) {
    while (true) {
      if (index >= chunks.length) {
        break;
      }

      const currentIndex = index++;
      const chunk = chunks[currentIndex];

      try {
        await processBatch(
          chunk,
          currentIndex + 1
        );

      } catch (error) {
        console.error(
          `🧨 Worker ${workerId} falló en batch ${currentIndex + 1}`,
          error
        );

        // Continuar con los siguientes batches
        continue;
      }
    }

    console.log(
      `👷 Worker ${workerId} terminó`
    );
  }

  const workers = [];

  for (let i = 0; i < concurrency; i++) {
    workers.push(
      worker(i + 1)
    );
  }

  await Promise.all(workers);
}


// ======================================================
// GENERAR HASH
// IMPORTANTE:
// usa los campos YA MAPEADOS, no los originales de AdmCloud
// ======================================================

function generateHash(product) {
  const data = [
    product.erp_sku,
    product.description,
    product.erp_name,
    product.uom,
    product.status,
    product.category_id,
    product.reference,
    product.unit_cost
  ].join("|");

  return crypto
    .createHash("md5")
    .update(data)
    .digest("hex");
}


// ======================================================
// PROCESAR UN BATCH
// ======================================================

export async function processBatch(
  chunk,
  batchIndex
) {
  try {
    console.log(
      `➡️ Procesando batch ${batchIndex} (${chunk.length} productos)`
    );


    // ==================================================
    // 1. MAP ADM CLOUD → WMS
    // ==================================================

    const mappedProducts = chunk.map((p) => ({
  erp_sku: p.SKU?.trim() || null,

  description:
    p.PurchaseDescription?.trim() ||
    p.SalesDescription?.trim() ||
    p.Name?.trim() ||
    "SIN DESCRIPCION",

  erp_name: p.Name?.trim() || null,

  erp_id: String(p.ID),

  uom: p.ReportUOMName || "EA",

  status: p.Inactive ? "INACTIVE" : "ACTIVE",

  category_id: null,

  erp_category_id: p.ItemClassID || null,

  erp_uom_plan_id: p.UOMPlanID || null,

  reference: p.SKU?.trim() || null,

  unit_cost: Number(p.Cost ?? 0)
}));


    // ==================================================
    // 2. CREAR MAPS
    // ==================================================

    const productMap = new Map();
    const hashMap = new Map();

    for (const product of mappedProducts) {

      productMap.set(
        product.erp_id,
        product
      );

      hashMap.set(
        product.erp_id,
        generateHash(product)
      );
    }


    // ==================================================
    // 3. BUSCAR PRODUCTOS EXISTENTES
    // ==================================================

    const erpIds = [
      ...hashMap.keys()
    ];

    const dbRes = await db.query(`
  SELECT erp_id, hash
  FROM products
  WHERE erp_id = ANY($1::text[])
`, [erpIds]);


    const dbMap = new Map();

    for (const row of dbRes.rows) {
      dbMap.set(
        String(row.erp_id),
        row.hash
      );
    }


    // ==================================================
    // 4. DETERMINAR INSERT / UPDATE
    // ==================================================

    const toInsert = [];
    const toUpdate = [];

    for (
      const [erpId, newHash]
      of hashMap
    ) {

      const oldHash =
        dbMap.get(erpId);

      // No existe
      if (!oldHash) {

        toInsert.push(erpId);

      }

      // Existe pero cambió
      else if (oldHash !== newHash) {

        toUpdate.push(erpId);

      }
    }


    console.log(
      `🟢 Nuevos: ${toInsert.length}`
    );

    console.log(
      `🟡 Cambiados: ${toUpdate.length}`
    );

    console.log(
      `⏭️ Sin cambios: ${
        chunk.length -
        toInsert.length -
        toUpdate.length
      }`
    );


    // ==================================================
    // 5. INSERT
    // ==================================================

    if (toInsert.length > 0) {

      const insertProducts =
        toInsert.map((id) => {

          const product =
            productMap.get(id);

          return {
            ...product,

            hash:
              hashMap.get(id)
          };
        });


      await bulkInsertProducts(
        insertProducts
      );
    }


    // ==================================================
    // 6. UPDATE
    // ==================================================

    if (toUpdate.length > 0) {

      const updateProducts =
        toUpdate.map((id) => {

          const product =
            productMap.get(id);

          return {
            ...product,

            hash:
              hashMap.get(id)
          };
        });


      await bulkUpdateProducts(
        updateProducts
      );
    }


    console.log(
      `✅ Batch ${batchIndex} completado`
    );

  } catch (error) {

    console.error(
      `❌ Error batch ${batchIndex}`,
      error
    );

    throw error;
  }
}


// ======================================================
// BULK INSERT
// ======================================================

export async function bulkInsertProducts(
  products
) {
  if (
    !products ||
    products.length === 0
  ) {
    return;
  }


  const values = [];
  const params = [];

  let i = 1;


  for (const p of products) {

    values.push(`
      (
        $${i++},
        $${i++},
        $${i++},
        $${i++},
        $${i++},
        $${i++},
        $${i++},
        $${i++},
        $${i++},
        $${i++}
      )
    `);


    params.push(

      p.erp_sku,

      p.description,

      p.erp_name,

      p.erp_id,

      p.uom,

      p.status,

      p.category_id,

      p.reference,

      p.unit_cost,

      p.hash
    );
  }


  const query = `
    INSERT INTO products (
      erp_sku,
      description,
      erp_name,
      erp_id,
      uom,
      status,
      category_id,
      reference,
      unit_cost,
      hash
    )
    VALUES
    ${values.join(",")}
  `;


  await db.query(
    query,
    params
  );


  console.log(
    `✅ Insertados ${products.length} productos`
  );
}


// ======================================================
// UPDATE DE PRODUCTOS CAMBIADOS
// ======================================================

export async function bulkUpdateProducts(
  products
) {

  if (
    !products ||
    products.length === 0
  ) {
    return;
  }


  const client =
    await db.connect();


  try {

    await client.query(
      "BEGIN"
    );


    for (const p of products) {

      await client.query(
        `
          UPDATE products

          SET
            erp_sku = $1,
            description = $2,
            erp_name = $3,
            uom = $4,
            status = $5,
            category_id = $6,
            reference = $7,
            unit_cost = $8,
            hash = $9

          WHERE erp_id = $10
        `,
        [
          p.erp_sku,
          p.description,
          p.erp_name,
          p.uom,
          p.status,
          p.category_id,
          p.reference,
          p.unit_cost,
          p.hash,
          p.erp_id
        ]
      );
    }


    await client.query(
      "COMMIT"
    );


    console.log(
      `✅ Actualizados ${products.length} productos`
    );


  } catch (error) {

    await client.query(
      "ROLLBACK"
    );

    throw error;


  } finally {

    client.release();

  }
}



export async function syncAdmCloudProducts(
  products
) {

  const BATCH_SIZE = 100;
  const CONCURRENCY = 2;


  console.log(
    `📦 Productos para sincronizar: ${products.length}`
  );


  const chunks =
    chunkArray(
      products,
      BATCH_SIZE
    );


  console.log(
    `📦 Total batches: ${chunks.length}`
  );


  await processInParallel(
    chunks,
    CONCURRENCY
  );


  console.log(
    "✅ Sincronización Adm Cloud completada"
  );


  return {
    totalProducts:
      products.length,

    batches:
      chunks.length
  };
}