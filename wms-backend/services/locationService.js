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
    console.log("INICIANDO BUSQUEDA DE LOCATION", code)
  return client.query(`
    SELECT id, code
    FROM locations
    WHERE code = $1
      AND location_type = 'STORAGE'
      AND is_active = true
    LIMIT 1
  `, [code]);
  
}



/*SERVICIO: Utiliza el id del usuario para buscar si tiene un location asignado a el y si lo tiene entonces buscar la informacion de ese location asignado a el*/

export async function getUserActiveLocation(client, userId) {
    
  const result = await client.query(`
    SELECT 
      l.id,
      l.code,
      l.warehouse_id,
      l.location_type
    FROM user_locations ul
    JOIN locations l ON l.id = ul.location_id
    WHERE ul.user_id = $1
      AND l.is_active = true
    LIMIT 1
  `, [userId]);

  return result.rowCount ? result.rows[0] : null;
}
