import admcloudClient from "./admcloudClient.js";
import { db } from "../../db.js";

// ============================================================
// OBTENER TODAS LAS UBICACIONES / ALMACENES DE ADM CLOUD
// ============================================================
//
// Endpoint:
// GET /Locations
//
// Adm Cloud requiere "skip" para paginación.
//
// Este servicio seguirá haciendo llamadas hasta que
// Adm Cloud devuelva una página vacía.
//
// ============================================================

export async function getAdmCloudLocations() {

  const allLocations = [];

  let skip = 0;
  let callNumber = 1;

  console.log("");
  console.log("🏭 ========================================");
  console.log("🏭 OBTENIENDO LOCATIONS DE ADM CLOUD");
  console.log("🏭 ========================================");

  while (true) {

    console.log(
      `📡 Llamada #${callNumber} | skip=${skip}`
    );

    const response = await admcloudClient.get(
      "/Locations",
      {
        params: {
          skip,
        },
      }
    );

    // Adm Cloud devuelve normalmente:
    //
    // {
    //   success: true,
    //   message: null,
    //   data: [...]
    // }

    const locations = response.data?.data || [];

    console.log(
      `📦 Locations recibidos: ${locations.length}`
    );

    // Si ya no vienen locations terminamos.
    if (locations.length === 0) {
      break;
    }

    allLocations.push(...locations);

    // Avanzamos exactamente la cantidad recibida.
    skip += locations.length;

    callNumber++;
  }

  console.log("");
  console.log(
    `✅ TOTAL LOCATIONS ADM CLOUD: ${allLocations.length}`
  );

  return allLocations;
}







export async function syncAdmCloudWarehouses() {

  console.log("");
  console.log("🔄 ========================================");
  console.log("🔄 SINCRONIZANDO WAREHOUSES ADM CLOUD");
  console.log("🔄 ========================================");

  const locations =
    await getAdmCloudLocations();

  await upsertAdmCloudWarehouses(
    locations
  );

  console.log(
    `✅ Sync completado: ${locations.length} locations`
  );

  return {
    total: locations.length
  };
}








// ============================================================
// UPSERT LOCATIONS ADM CLOUD → WAREHOUSES WMS
// ============================================================

export async function upsertAdmCloudWarehouses(warehouses) {

  if (!warehouses || warehouses.length === 0) {
    console.log("⚠️ No hay locations de Adm Cloud para sincronizar");
    return;
  }

  const values = [];
  const params = [];

  let paramIndex = 1;

  warehouses.forEach((w) => {

    // --------------------------------------------------------
    // Construir dirección
    // --------------------------------------------------------

    const address = [
      w.Address1,
      w.Address2,
      w.City,
      w.State,
      w.PostalCode
    ]
      .filter(Boolean)
      .join(", ") || null;


    // --------------------------------------------------------
    // VALUES
    // --------------------------------------------------------

    values.push(`(
      $${paramIndex++},
      $${paramIndex++},
      $${paramIndex++},
      $${paramIndex++},
      $${paramIndex++},
      $${paramIndex++},
      $${paramIndex++}
    )`);


    // --------------------------------------------------------
    // MAP ADM CLOUD → WMS
    // --------------------------------------------------------

    params.push(

      // code
      w.Code?.trim() ||
        `WH-${w.ID.substring(0, 2).toUpperCase()}`,

      // name
      w.Name?.trim() || "SIN NOMBRE",

      // description
      w.Notes?.trim() || null,

      // status
      w.Inactive
        ? "INACTIVE"
        : "ACTIVE",

      // address_line
      address,

      // is_default
      false,

      // erp_warehouse_id
      String(w.ID)
    );
  });


  // ==========================================================
  // UPSERT
  // ==========================================================

  const query = `
    INSERT INTO warehouses (
      code,
      name,
      description,
      status,
      address_line,
      is_default,
      erp_warehouse_id
    )
    VALUES ${values.join(",")}

    ON CONFLICT (erp_warehouse_id)

    DO UPDATE SET
      code = EXCLUDED.code,
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      status = EXCLUDED.status,
      address_line = EXCLUDED.address_line,
      is_default = EXCLUDED.is_default;
  `;


  const result = await db.query(
    query,
    params
  );


  console.log("");
  console.log("🏭 ========================================");
  console.log("✅ ADM CLOUD LOCATIONS → WAREHOUSES");
  console.log(`📦 Locations recibidos: ${warehouses.length}`);
  console.log(`💾 Registros afectados: ${result.rowCount}`);
  console.log("🏭 ========================================");


  return result;
}