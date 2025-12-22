import { openReceptionDB, RECEPCION_STORE } from "./indexeddb";

// GUARDAR recepción
export async function saveReceptionIDB(data: {
  id: number;
  purchase_order_number: string;
  lines: any[];
}) {
  const db = await openReceptionDB();

  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(RECEPCION_STORE, "readwrite");
    const store = tx.objectStore(RECEPCION_STORE);

    store.put({
      ...data,
      started_at: new Date().toISOString(),
    });

    tx.oncomplete = () => {
      console.log("Recepción guardada en IndexedDB");
      resolve();
    };

    tx.onerror = () => {
      reject(tx.error);
    };
  });
}

// LEER recepción por orden de compra
export async function getReceptionByPOId(poId: number) {
  const db = await openReceptionDB();

  return new Promise<any>((resolve, reject) => {
    const tx = db.transaction(RECEPCION_STORE, "readonly");
    const store = tx.objectStore(RECEPCION_STORE);

    const request = store.get(poId);

    request.onsuccess = () => {
      resolve(request.result ?? null);
    };

    request.onerror = () => {
      reject(request.error);
    };
  });
}
