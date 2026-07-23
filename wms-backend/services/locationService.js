// SERVICE: To confirm if a location barcode scanned by the member exist and is active. If so, obtain the information

export async function getActiveLocationByCodeAndType(client, barcode, locationType) {
  return client.query(`
    SELECT 
      id,
      warehouse_id,
      code,
      location_type
    FROM locations
    WHERE code = $1
      AND is_active = true
      AND location_type = ANY($2)
    LIMIT 1
  `, [barcode, [locationType]]);
}


/*
const locResult = await getActiveLocationByCodeAndType(
  client,
  scannedCode,
  "STORAGE"
);

if (locResult.rowCount === 0) {
  throw { code: "INVALID_LOCATION" };
}

const location = locResult.rows[0];

// Ya tienes:
location.id
location.warehouse_id
location.code
location.location_type
*/


/*BUSCAR UBICACION STORAGE POR CODIGO ACTIVO*/
export async function getActiveStorageLocationByCode(client, code) {

  console.log("INICIANDO BUSQUEDA DE LOCATION:", code);

 const result = await client.query(
  `
  SELECT id, code
  FROM locations
  WHERE code = $1
    AND location_type <> 'SHIPPING'
    AND is_active = true
  LIMIT 1
  `,
  [code]
);

  console.log("📍 LOCATION ROWCOUNT:", result.rowCount);
  console.log("📍 LOCATION ROWS:", result.rows);

  return result;
}



/*SERVICIO: Utiliza el id del usuario para buscar si tiene un location asignado a el y si lo tiene entonces buscar la informacion de ese location asignado a el*/

export async function getUserActiveLocation(
  client,
  userId,
  sourceWarehouseId
) {

  console.log("================================");
  console.log("🔍 GET USER ACTIVE LOCATION");
  console.log("USER ID:", userId);

  const warehouseId = Number(sourceWarehouseId);

console.log("🏬 SOURCE WAREHOUSE:", warehouseId);

if (!warehouseId) {
  throw {
    code: "INVALID_SOURCE_WAREHOUSE",
    message: "Source warehouse not provided"
  };
}

  // Buscar ubicación existente
  const result = await client.query(`
  SELECT
    l.id,
    l.code,
    l.warehouse_id,
    l.location_type
  FROM user_locations ul
  JOIN locations l
    ON l.id = ul.location_id
  WHERE ul.user_id = $1
    AND l.warehouse_id = $2
    AND l.is_active = true
  LIMIT 1
`, [
  userId,
  warehouseId
]);

  console.log("ROW COUNT:", result.rowCount);
  console.log("ROWS:", result.rows);

  if (result.rowCount > 0) {
    console.log("✅ USER LOCATION ENCONTRADA");
    return result.rows[0];
  }

  console.log("⚠️ USER LOCATION NO EXISTE");
  console.log("🔨 CREANDO USER LOCATION");

  //--------------------------------------------------
  // Buscar warehouse del usuario
  //--------------------------------------------------

  

  if (!warehouseId) {
    throw {
      code: "USER_WITHOUT_WAREHOUSE",
      message: `User ${userId} does not have a warehouse assigned`
    };
  }

  const warehouseResult = await client.query(`
    SELECT id
    FROM warehouses
    WHERE id = $1
`, [warehouseId]);

if (warehouseResult.rowCount === 0) {
  console.log(`❌Warehouse ${warehouseId} assigned to user ${userId} does not exist`);
    throw {
        code: "INVALID_USER_WAREHOUSE",
        message: `Warehouse ${warehouseId} assigned to user ${userId} does not exist`
    };
}

  console.log("🏬 USER WAREHOUSE:", warehouseId);

  //--------------------------------------------------
  // Verificar si ya existe una ubicación USER-HAND
  //--------------------------------------------------

  const existingLocation = await client.query(`
    SELECT
      id,
      code,
      warehouse_id,
      location_type
    FROM locations
    WHERE code = $1
      AND warehouse_id = $2
    LIMIT 1
  `, [
    `USER-HAND-${userId}`,
    warehouseId
  ]);

  let location;

  if (existingLocation.rowCount > 0) {

    console.log("📍 UBICACION YA EXISTE");

    location = existingLocation.rows[0];

  } else {

    console.log("📍 CREANDO NUEVA UBICACION", userId);

    console.log("📍 CREANDO NUEVA UBICACION", userId);

try {

  const locationResult = await client.query(`
    INSERT INTO locations
    (
      code,
      warehouse_id,
      location_type,
      is_active
    )
    VALUES
    (
      $1,
      $2,
      'PICKING',
      true
    )
    RETURNING
      id,
      code,
      warehouse_id,
      location_type
  `, [
    `USER-HAND-${userId}`,
    warehouseId
  ]);

  console.log("📍 CREANDO NUEVA UBICACION 2");

  location = locationResult.rows[0];

  console.log("✅ UBICACION CREADA:", location);

} catch (err) {

  console.log("================================");
  console.log("🔥 ERROR INSERT LOCATION");
  console.log("================================");

  console.log(err);
  console.log("MESSAGE:", err.message);
  console.log("CODE:", err.code);
  console.log("DETAIL:", err.detail);
  console.log("CONSTRAINT:", err.constraint);
  console.log("TABLE:", err.table);
  console.log("COLUMN:", err.column);

  throw err;
}
  }

  //--------------------------------------------------
  // Asociar ubicación al usuario
  //--------------------------------------------------

 console.log("🔍 VALIDANDO USER_LOCATION");

const existingUserLocation = await client.query(`
    SELECT 1
    FROM user_locations
    WHERE user_id = $1
      AND location_id = $2
    LIMIT 1
`, [
    userId,
    location.id
]);

console.log("ROW COUNT:", existingUserLocation.rowCount);

if (existingUserLocation.rowCount === 0) {

    console.log("🔗 ASIGNANDO UBICACION AL USUARIO");

    const insertUserLocation = await client.query(`
      INSERT INTO user_locations
      (
        user_id,
        location_id
      )
      VALUES
      (
        $1,
        $2
      )
      RETURNING *
    `, [
      userId,
      location.id
    ]);

    console.log("✅ UBICACION ASIGNADA");
    console.log(insertUserLocation.rows);
}

console.log("🎉 USER LOCATION LISTA");

  return location;
}