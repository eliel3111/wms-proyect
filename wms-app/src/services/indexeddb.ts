// src/db/indexeddb.ts

export const DB_NAME = "wms_db";
export const DB_VERSION = 1;
export const RECEPCION_STORE = "recepcionIDB";

export function openReceptionDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    // ❌ Error
    request.onerror = () => {
      console.error("IndexedDB error:", request.error);
      reject(request.error);
    };

    // ✅ Success
    request.onsuccess = () => {
      const db = request.result;
      console.log("IndexedDB opened:", db.name, "v", db.version);

      // Manejo de versionchange (buena práctica)
      db.onversionchange = () => {
        console.warn("DB version change detected, closing DB");
        db.close();
      };

      resolve(db);
    };

    // 🔄 Upgrade / Create
    request.onupgradeneeded = () => {
      const db = request.result;
      console.log("IndexedDB upgrade needed");

      if (!db.objectStoreNames.contains(RECEPCION_STORE)) {
        db.createObjectStore(RECEPCION_STORE, {
          keyPath: "id", // o purchase_order_id
        });
        console.log(`ObjectStore created: ${RECEPCION_STORE}`);
      }
    };
  });
}
