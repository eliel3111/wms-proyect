import { getOdooClient } from "./odoo.client.js";
import { getOdooUid } from "./odoo.session.js";
import { db } from "../../db.js";
import { upsertPurchaseOrder } from "../purchaseOrder.upsert.js";

const OLD_DATE = "2000-01-01 00:00:00";
export const SYNC_STATUS = {
  RUNNING: "running",
  SUCCESS: "success",
  FAILED: "failed"
};

export async function lockSyncControl(model) {
  const client = await db.connect();
    //console.log("EL MODEL RECIBIDO PARA SYN ES: ", model);
  try {
    await client.query("BEGIN");

    // 1️⃣ Buscar registro con lock
    const result = await client.query(
      `
      SELECT id, last_write_date, status
      FROM sync_control
      WHERE model = $1
      FOR UPDATE
      `,
      [model]
    );

    // 2️⃣ Si existe y está corriendo → salir
    if (result.rowCount > 0) {
      const row = result.rows[0];

      if (row.status === "running") {
        await client.query("ROLLBACK");
        return null; // ocupado
      }

      // 3️⃣ Existe y NO está corriendo → marcar running
      await client.query(
        `
        UPDATE sync_control
        SET status = 'running',
            updated_at = now(),
            error_message = NULL
        WHERE model = $1
        `,
        [model]
      );

      await client.query("COMMIT");

      return {
        id: row.id,
        lastWriteDate: row.last_write_date
      };
    }

    // 4️⃣ No existe → crear registro
    const insertResult = await client.query(
      `
      INSERT INTO sync_control (model, last_write_date, status)
      VALUES ($1, $2, 'running')
      RETURNING id, last_write_date
      `,
      [model, OLD_DATE]
    );

    await client.query("COMMIT");

    return {
      id: insertResult.rows[0].id,
      lastWriteDate: insertResult.rows[0].last_write_date
    };

  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}



/*const model = "product.product";

  const lock = await lockSyncControl(model);
  if (!lock) {
    console.log(`[SYNC] ${model} ya está corriendo`);
    return;
  }*/

/**
 * @param {string} model
 * @param {"success"|"failed"} status
 * @param {string} lastWriteDate
 * @param {string|null} errorMessage
 */
export async function finishSyncControl(
  model,
  status,
  lastWriteDate,
  errorMessage = null
) {
  await db.query(
    `
    UPDATE sync_control
    SET
      status = $1,
      last_write_date = $2,
      updated_at = now(),
      error_message = $3
    WHERE model = $4
    `,
    [status, lastWriteDate, errorMessage, model]
  );
}


/*
    await finishSyncControl(model, SYNC_STATUS.SUCCESS, maxWriteDate);

  } catch (error) {
    await finishSyncControl(
      model,
      SYNC_STATUS.FAILED,
      lock.lastWriteDate,
      error.message
    );
    throw error;
  }*/