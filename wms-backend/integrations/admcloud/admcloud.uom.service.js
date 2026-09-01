//wms-backend/intgrations/admcloud/admcloud.uom.service.js
import db from "../../db.js";
import admcloudClient from "./admcloudClient.js";

export async function syncAdmCloudUoms() {
    const client = await db.connect();

    try {
        console.log("");
        console.log("📏 ========================================");
        console.log("📏 SINCRONIZANDO UOM DESDE ADM CLOUD");
        console.log("📏 ========================================");

        // ============================================================
        // 1. BUSCAR UOM EN ADM CLOUD
        // ============================================================

        const response = await admcloudClient.get("/UOM");

        const data = response.data;

        console.log("📥 Respuesta recibida de ADM Cloud");

        const uoms = Array.isArray(data)
            ? data
            : Array.isArray(data?.data)
                ? data.data
                : [];

        console.log("📦 UOM recibidos:", uoms.length);

        if (uoms.length === 0) {
            throw new Error(
                "ADM Cloud devolvió 0 UOM. Se cancela la sincronización para evitar desactivar registros."
            );
        }

        await client.query("BEGIN");

        // ============================================================
        // 2. GUARDAR IDs RECIBIDOS
        // ============================================================

        const receivedErpIds = [];

        let inserted = 0;
        let updated = 0;

        // ============================================================
        // 3. INSERT / UPDATE
        // ============================================================

        for (const uom of uoms) {

            console.log(uom);
            console.log(uom.CustomFields);
    const erpId = String(uom.ID);

    const codigo =
        uom.Code ??
        uom.Name ??
        erpId;

    receivedErpIds.push(erpId);

    const result = await client.query(
        `
        INSERT INTO uom (
            erp_id,
            codigo,
            nombre,
            tipo,
            factor_base,
            activa,
            create_date,
            write_date
        )
        VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            TRUE,
            NOW(),
            NOW()
        )

        ON CONFLICT (erp_id)

        DO UPDATE SET
            codigo = EXCLUDED.codigo,
            nombre = EXCLUDED.nombre,
            tipo = EXCLUDED.tipo,
            factor_base = EXCLUDED.factor_base,
            activa = TRUE,
            write_date = NOW()

        RETURNING
            id,
            erp_id,
            (xmax = 0) AS inserted
        `,
        [
            erpId,
            codigo,
            uom.Name ?? "",
            "unidad",
            1
        ]
    );

    if (result.rows[0]?.inserted) {
        inserted++;
    } else {
        updated++;
    }
}

        // ============================================================
        // 4. DESACTIVAR UOM QUE YA NO LLEGAN DE ADM CLOUD
        // ============================================================

        const deactivateResult = await client.query(
            `
            UPDATE uom

            SET
                activa = FALSE,
                write_date = NOW()

            WHERE
                activa = TRUE
                AND erp_id IS NOT NULL
                AND NOT (
                    erp_id = ANY($1::varchar[])
                )

            RETURNING
                id,
                erp_id,
                codigo,
                nombre
            `,
            [receivedErpIds]
        );

        const deactivated = deactivateResult.rowCount;

        if (deactivated > 0) {
            console.log(
                "🔴 UOM desactivados:",
                deactivateResult.rows
            );
        }

        await client.query("COMMIT");

        // ============================================================
        // 5. RESULTADO
        // ============================================================

        const summary = {
            success: true,
            totalReceived: uoms.length,
            inserted,
            updated,
            deactivated
        };

        console.log("");
        console.log("✅ SINCRONIZACIÓN UOM COMPLETADA");
        console.log(summary);

        return summary;

    } catch (error) {
        await client.query("ROLLBACK");

        console.error("");
        console.error("❌ ERROR SINCRONIZANDO UOM");
        console.error(error);

        throw error;

    } finally {
        client.release();
    }
}