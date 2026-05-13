import crypto from "crypto";
import { db } from "../../db.js";

/**
 * Divide el array en chunks
 */
export function chunkArray(array, size) {
  const result = [];
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }
  return result;
}



/**
 * Procesador con concurrencia controlada
 */
export async function processInParallel(chunks, concurrency) {
  let index = 0;

  async function worker(workerId) {
    while (true) {
      let currentIndex;

      // 🔒 sección crítica (simple pero efectiva en JS)
      if (index >= chunks.length) break;
      currentIndex = index++;

      const chunk = chunks[currentIndex];

      try {
        await processBatch(chunk, currentIndex + 1);
      } catch (err) {
        console.error(`🧨 Worker ${workerId} falló en batch ${currentIndex + 1}`);
        // 👉 decide si quieres parar todo:
        // throw err;

        // 👉 o continuar:
        continue;
      }
    }

    console.log(`👷 Worker ${workerId} terminó`);
  }

  const workers = [];

  for (let i = 0; i < concurrency; i++) {
    workers.push(worker(i + 1));
  }

  await Promise.all(workers);
}



// 🔥 generar hash
function generateHash(p) {
  const data = [
    p.reference,
    p.description,
    p.name,
    p.status,
    p.category?.id,
    p.inventory?.unitCost
  ].join("|");

  return crypto.createHash("md5").update(data).digest("hex");
}

//MANEJA CUALES VAN INSERT Y CUALES NO
export async function processBatch(chunk, batchIndex) {
  try {
    console.log(`➡️ Procesando batch ${batchIndex} (${chunk.length} items)`);

    // =========================
    // 1. MAPEAR PRODUCTOS
    // =========================
    const mappedProducts = chunk.map(p => ({
      erp_sku: p.reference?.reference || null,
      description: p.description || 'SIN DESCRIPCION',
      erp_name: p.name || null,
      erp_id: String(p.id),
      uom: "EA",
      status: p.status === "active" ? "ACTIVE" : "INACTIVE",
      category_id: p.category?.id || null,
      reference: p.reference?.reference || null,
      unit_cost: p.inventory?.unitCost || 0
    }));

    // =========================
    // 2. CREAR MAPS
    // =========================
    const productMap = new Map();
    const hashMap = new Map();

    for (const p of mappedProducts) {
      productMap.set(p.erp_id, p);
      hashMap.set(p.erp_id, generateHash(p));
    }

    console.log(productMap);
    console.log(hashMap);

    // =========================
    // 3. BUSCAR EN DB
    // =========================
    const erpIds = [...hashMap.keys()];

    console.log(erpIds);

    const dbRes = await db.query(`
      SELECT erp_id, hash
      FROM products
      WHERE erp_id = ANY($1)
    `, [erpIds]);

    console.log(dbRes.rows);
    const dbMap = new Map();

    dbRes.rows.forEach(r => {
      dbMap.set(String(r.erp_id), r.hash);
    });

    console.log("DBMAP", dbMap);

    // =========================
    // 4. COMPARAR HASHES
    // =========================
    const toInsert = [];
    const toUpdate = [];

    for (const [erp_id, newHash] of hashMap) {
      const oldHash = dbMap.get(erp_id);
      
      if (!oldHash) {
        toInsert.push(erp_id);
      } else if (oldHash !== newHash) {
        toUpdate.push(erp_id);
      }
    }

    console.log("TO INSERT", toInsert);
    console.log("TO UPDATE", toUpdate);

    // =========================
    // 5. PREPARAR INSERT
    // =========================
    if (toInsert.length > 0) {
      const insertProducts = toInsert.map(id => {
  const p = productMap.get(id);

  return {
    ...p,
    hash: hashMap.get(id) // 🔥 AQUÍ LE INYECTAS EL HASH
  };
});

      console.log(`🟢 Insertar: `, insertProducts);

      // 🔥 EJEMPLO BULK INSERT
      await bulkInsertProducts(insertProducts);
    }

    // =========================
    // 6. PREPARAR UPDATE
    // =========================
    if (toUpdate.length > 0) {
      const updateProducts = toUpdate.map(id => productMap.get(id));

      console.log(`🟡 Actualizar: ${updateProducts.length}`);

      // 🔥 EJEMPLO BULK UPDATE
      // await bulkUpdateProducts(updateProducts);
    }

    if (toInsert.length === 0 && toUpdate.length === 0) {
      console.log("⏭️ Sin cambios en este batch");
    }

    console.log(`✅ Batch ${batchIndex} completado`);

  } catch (error) {
    console.error(`❌ Error en batch ${batchIndex}`, error);
    throw error;
  }
}


export async function bulkInsertProducts(products) {
  if (!products || products.length === 0) return;

  const values = [];
  const params = [];
  let i = 1;

  for (const p of products) {
    values.push(`(
      $${i++}, $${i++}, $${i++}, $${i++},
      $${i++}, $${i++}, $${i++}, $${i++},
      $${i++}, $${i++}
    )`);

    params.push(
      p.erp_sku,        // 1
      p.description,    // 2
      p.erp_name,       // 3
      p.erp_id,         // 4
      p.uom,            // 5
      p.status,         // 6
      p.category_id,    // 7
      p.reference,      // 8
      p.unit_cost,      // 9
      p.hash            // 10 🔥 IMPORTANTE
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
    VALUES ${values.join(",")}
  `;

  await db.query(query, params);

  console.log(`✅ Insertados ${products.length} productos`);
}