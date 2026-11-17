import db from "../db.js";
import { getAdmCloudDispatchService } from "../integrations/admcloud/admcloud.conduce.js";
import { getAdmCloudCreditInvoiceById } from "../integrations/admcloud/admcloud_inspeccion.js";

const UUID_PATTERN =
    /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

const ZERO_UUID =
    "00000000-0000-0000-0000-000000000000";

const BATCH_SIZE = 100;

const ALL_TABLE_COLUMNS = [
    "id",
    "document_type",
    "erp_document_id",
    "erp_line_id",
    "erp_trans_id",
    "erp_row_order",
    "erp_item_id",
    "erp_item_sku",
    "erp_item_name",
    "completed_quantity",
    "inspected_quantity",
    "returned_quantity",
    "erp_uom_id",
    "erp_uom_name",
    "erp_uom_factor",
    "erp_source_transaction_id",
    "erp_source_row_id",
    "erp_source_transaction_type",
    "erp_source_transaction_type_name",
    "erp_source_transaction_doc_date",
    "erp_source_transaction_reference",
    "inspection_status",
    "inspection_notes",
    "inspected_by",
    "inspected_at",
    "created_at",
    "updated_at",
    "erp_quantity",
    "erp_cost",
    "erp_price",
    "erp_discount_percent",
    "erp_row_type",
    "erp_estimated_delivery_date",
    "erp_exchange_rate",
    "erp_warranty_days",
    "erp_warranty_units",
    "erp_tax_schedule_id",
    "erp_tax_percent",
    "erp_location_id",
    "erp_lot_id",
    "erp_bin_id",
    "erp_parent_item_id",
    "erp_attribute_option_1_id",
    "erp_attribute_option_2_id"
];

const ERP_SYNC_COLUMNS = [
    "document_type",
    "erp_document_id",
    "erp_line_id",
    "erp_trans_id",
    "erp_row_order",
    "erp_item_id",
    "erp_item_sku",
    "erp_item_name",
    "completed_quantity",
    "erp_quantity",
    "erp_uom_id",
    "erp_uom_name",
    "erp_uom_factor",
    "erp_source_transaction_id",
    "erp_source_row_id",
    "erp_source_transaction_type",
    "erp_source_transaction_type_name",
    "erp_source_transaction_doc_date",
    "erp_source_transaction_reference",
    "erp_cost",
    "erp_price",
    "erp_discount_percent",
    "erp_row_type",
    "erp_estimated_delivery_date",
    "erp_exchange_rate",
    "erp_warranty_days",
    "erp_warranty_units",
    "erp_tax_schedule_id",
    "erp_tax_percent",
    "erp_location_id",
    "erp_lot_id",
    "erp_bin_id",
    "erp_parent_item_id",
    "erp_attribute_option_1_id",
    "erp_attribute_option_2_id"
];

const WMS_PRESERVED_COLUMNS = [
    "inspected_quantity",
    "returned_quantity",
    "inspection_status",
    "inspection_notes",
    "inspected_by",
    "inspected_at"
];

const SYSTEM_COLUMNS = [
    "id",
    "created_at",
    "updated_at"
];

const LINE_COLUMNS_SQL =
    ALL_TABLE_COLUMNS.join(",\n                        ");

function normalizeDocumentType(value) {
    const normalized = String(value ?? "")
        .trim()
        .toUpperCase();

    return ["CONDUCE", "FACTURA"].includes(normalized)
        ? normalized
        : null;
}

function unwrapDocument(result) {
    return result?.data?.data ?? result?.data ?? result ?? {};
}

function getValue(object, ...keys) {
    for (const key of keys) {
        if (
            object &&
            Object.prototype.hasOwnProperty.call(object, key) &&
            object[key] !== undefined
        ) {
            return object[key];
        }
    }

    return undefined;
}

function normalizeText(value) {
    if (value === null || value === undefined) {
        return null;
    }

    const text = String(value).trim();

    return text === ""
        ? null
        : text;
}

function normalizeUuid(
    value,
    fieldName
) {
    if (
        value === null ||
        value === undefined
    ) {
        return null;
    }

    const text =
        String(value).trim();

    if (
        text === "" ||
        text.toLowerCase() === ZERO_UUID
    ) {
        return null;
    }

    if (!UUID_PATTERN.test(text)) {
        throw new Error(
            `${fieldName} contiene un UUID inválido: ${text}`
        );
    }

    return text.toLowerCase();
}

function normalizeRequiredUuid(
    value,
    fieldName
) {
    const uuid =
        normalizeUuid(
            value,
            fieldName
        );

    if (!uuid) {
        throw new Error(
            `${fieldName} es requerido en la línea recibida desde Adm Cloud.`
        );
    }

    return uuid;
}

function normalizeNumber(
    value,
    fallback = 0
) {
    if (
        value === null ||
        value === undefined ||
        value === ""
    ) {
        return fallback;
    }

    const number =
        Number(value);

    return Number.isFinite(number)
        ? number
        : fallback;
}

function normalizeNullableNumber(value) {
    if (
        value === null ||
        value === undefined ||
        value === ""
    ) {
        return null;
    }

    const number =
        Number(value);

    return Number.isFinite(number)
        ? number
        : null;
}

function normalizeInteger(
    value,
    fallback = null
) {
    if (
        value === null ||
        value === undefined ||
        value === ""
    ) {
        return fallback;
    }

    const number =
        Number(value);

    if (!Number.isFinite(number)) {
        return fallback;
    }

    return Math.trunc(number);
}

function normalizeDate(value) {
    if (
        value === null ||
        value === undefined
    ) {
        return null;
    }

    const text =
        String(value).trim();

    if (
        text === "" ||
        text.startsWith("0001-01-01")
    ) {
        return null;
    }

    const match =
        text.match(
            /^\d{4}-\d{2}-\d{2}/
        );

    return match
        ? match[0]
        : null;
}

function normalizeComparisonValue(value) {
    if (
        value === null ||
        value === undefined ||
        value === ""
    ) {
        return null;
    }

    if (value instanceof Date) {
        return value
            .toISOString()
            .slice(
                0,
                10
            );
    }

    if (typeof value === "number") {
        return Number(value);
    }

    const text =
        String(value).trim();

    if (/^-?\d+(?:\.\d+)?$/.test(text)) {
        return Number(text);
    }

    if (UUID_PATTERN.test(text)) {
        return text.toLowerCase();
    }

    const dateMatch =
        text.match(
            /^\d{4}-\d{2}-\d{2}/
        );

    if (
        dateMatch &&
        (
            text.includes("T") ||
            /^\d{4}-\d{2}-\d{2}$/.test(text)
        )
    ) {
        return dateMatch[0];
    }

    return text;
}

function valuesAreEqual(
    a,
    b
) {
    return (
        normalizeComparisonValue(a) ===
        normalizeComparisonValue(b)
    );
}

function mapReturnSyncLine(
    item,
    documentType,
    documentGuid
) {
    const erpLineId =
        normalizeRequiredUuid(
            getValue(
                item,
                "ID",
                "Id",
                "id"
            ),
            "Items[].ID"
        );

    const erpItemId =
        normalizeRequiredUuid(
            getValue(
                item,
                "ItemID",
                "ItemId",
                "itemID",
                "itemId"
            ),
            "Items[].ItemID"
        );

    return {
        document_type:
            documentType,

        erp_document_id:
            documentGuid.toLowerCase(),

        erp_line_id:
            erpLineId,

        erp_trans_id:
            normalizeUuid(
                getValue(
                    item,
                    "TransID",
                    "TransId",
                    "transID",
                    "transId"
                ),
                "Items[].TransID"
            ),

        erp_row_order:
            normalizeInteger(
                getValue(
                    item,
                    "RowOrder",
                    "rowOrder"
                )
            ),

        erp_item_id:
            erpItemId,

        erp_item_sku:
            normalizeText(
                getValue(
                    item,
                    "ItemSKU",
                    "ItemSku",
                    "itemSKU",
                    "itemSku"
                )
            ),

        erp_item_name:
            normalizeText(
                getValue(
                    item,
                    "Name",
                    "name"
                )
            ),

        completed_quantity:
            normalizeNumber(
                getValue(
                    item,
                    "CompletedQuantity",
                    "completedQuantity"
                ),
                0
            ),

        erp_quantity:
            normalizeNumber(
                getValue(
                    item,
                    "Quantity",
                    "quantity"
                ),
                0
            ),

        erp_uom_id:
            normalizeUuid(
                getValue(
                    item,
                    "UOMID",
                    "UomID",
                    "uomID",
                    "uomId"
                ),
                "Items[].UOMID"
            ),

        erp_uom_name:
            normalizeText(
                getValue(
                    item,
                    "UOMName",
                    "UomName",
                    "uomName"
                )
            ),

        erp_uom_factor:
            normalizeNullableNumber(
                getValue(
                    item,
                    "UOMFactor",
                    "UomFactor",
                    "uomFactor"
                )
            ),

        erp_source_transaction_id:
            normalizeUuid(
                getValue(
                    item,
                    "SourceTransactionID",
                    "SourceTransactionId",
                    "sourceTransactionID",
                    "sourceTransactionId"
                ),
                "Items[].SourceTransactionID"
            ),

        erp_source_row_id:
            normalizeUuid(
                getValue(
                    item,
                    "SourceRowID",
                    "SourceRowId",
                    "sourceRowID",
                    "sourceRowId"
                ),
                "Items[].SourceRowID"
            ),

        erp_source_transaction_type:
            normalizeText(
                getValue(
                    item,
                    "SourceTransactionType",
                    "sourceTransactionType"
                )
            ),

        erp_source_transaction_type_name:
            normalizeText(
                getValue(
                    item,
                    "SourceTransactionTypeName",
                    "sourceTransactionTypeName"
                )
            ),

        erp_source_transaction_doc_date:
            normalizeDate(
                getValue(
                    item,
                    "SourceTransactionDocDate",
                    "sourceTransactionDocDate"
                )
            ),

        erp_source_transaction_reference:
            normalizeText(
                getValue(
                    item,
                    "SourceTransactionReference",
                    "sourceTransactionReference"
                )
            ),

        erp_cost:
            normalizeNullableNumber(
                getValue(
                    item,
                    "Cost",
                    "cost"
                )
            ),

        erp_price:
            normalizeNullableNumber(
                getValue(
                    item,
                    "Price",
                    "price"
                )
            ),

        erp_discount_percent:
            normalizeNumber(
                getValue(
                    item,
                    "DiscountPercent",
                    "discountPercent"
                ),
                0
            ),

        erp_row_type:
            normalizeInteger(
                getValue(
                    item,
                    "RowType",
                    "rowType"
                ),
                0
            ),

        erp_estimated_delivery_date:
            normalizeDate(
                getValue(
                    item,
                    "EstimatedDeliveryDate",
                    "estimatedDeliveryDate"
                )
            ),

        erp_exchange_rate:
            normalizeNumber(
                getValue(
                    item,
                    "ExchangeRate",
                    "exchangeRate"
                ),
                0
            ),

        erp_warranty_days:
            normalizeInteger(
                getValue(
                    item,
                    "WarrantyDays",
                    "warrantyDays"
                ),
                0
            ),

        erp_warranty_units:
            normalizeInteger(
                getValue(
                    item,
                    "WarrantyUnits",
                    "warrantyUnits"
                ),
                0
            ),

        erp_tax_schedule_id:
            normalizeUuid(
                getValue(
                    item,
                    "TaxScheduleID",
                    "TaxScheduleId",
                    "taxScheduleID",
                    "taxScheduleId"
                ),
                "Items[].TaxScheduleID"
            ),

        erp_tax_percent:
            normalizeNumber(
                getValue(
                    item,
                    "TaxPercent",
                    "taxPercent"
                ),
                0
            ),

        erp_location_id:
            normalizeUuid(
                getValue(
                    item,
                    "LocationID",
                    "LocationId",
                    "locationID",
                    "locationId"
                ),
                "Items[].LocationID"
            ),

        erp_lot_id:
            normalizeUuid(
                getValue(
                    item,
                    "LotID",
                    "LotId",
                    "lotID",
                    "lotId"
                ),
                "Items[].LotID"
            ),

        erp_bin_id:
            normalizeUuid(
                getValue(
                    item,
                    "BinID",
                    "BinId",
                    "binID",
                    "binId"
                ),
                "Items[].BinID"
            ),

        erp_parent_item_id:
            normalizeUuid(
                getValue(
                    item,
                    "ParentItemID",
                    "ParentItemId",
                    "parentItemID",
                    "parentItemId"
                ),
                "Items[].ParentItemID"
            ),

        erp_attribute_option_1_id:
            normalizeUuid(
                getValue(
                    item,
                    "AttributeOption1ID",
                    "AttributeOption1Id",
                    "attributeOption1ID",
                    "attributeOption1Id"
                ),
                "Items[].AttributeOption1ID"
            ),

        erp_attribute_option_2_id:
            normalizeUuid(
                getValue(
                    item,
                    "AttributeOption2ID",
                    "AttributeOption2Id",
                    "attributeOption2ID",
                    "attributeOption2Id"
                ),
                "Items[].AttributeOption2ID"
            )
    };
}

function mapLineForFrontend(row) {
    return {
        ...row,

        id:
            String(row.id),

        sku:
            row.erp_item_sku,

        description:
            row.erp_item_name,

        quantity:
            Number(
                row.erp_quantity ??
                0
            ),

        completed_quantity:
            Number(
                row.completed_quantity ??
                0
            ),

        inspected_quantity:
            Number(
                row.inspected_quantity ??
                0
            ),

        returned_quantity:
            Number(
                row.returned_quantity ??
                0
            ),

        erp_uom_factor:
            row.erp_uom_factor === null
                ? null
                : Number(
                    row.erp_uom_factor
                ),

        erp_cost:
            row.erp_cost === null
                ? null
                : Number(
                    row.erp_cost
                ),

        erp_price:
            row.erp_price === null
                ? null
                : Number(
                    row.erp_price
                ),

        erp_discount_percent:
            row.erp_discount_percent === null
                ? null
                : Number(
                    row.erp_discount_percent
                ),

        erp_exchange_rate:
            row.erp_exchange_rate === null
                ? null
                : Number(
                    row.erp_exchange_rate
                ),

        erp_tax_percent:
            row.erp_tax_percent === null
                ? null
                : Number(
                    row.erp_tax_percent
                )
    };
}

function logRawAdmItems(rawItems) {
    console.log("");
    console.log(
        "🌐 ========================================================"
    );
    console.log(
        "🌐 DATOS RAW RECIBIDOS DESDE ADM CLOUD"
    );
    console.log(
        "🌐 TOTAL ITEMS:",
        rawItems.length
    );
    console.log(
        "🌐 ========================================================"
    );

    rawItems.forEach(
        (
            item,
            index
        ) => {

            console.log("");

            console.log(
                `🌐 ITEM RAW #${index + 1}`
            );

            console.log({
                ID:
                    item?.ID,

                TransID:
                    item?.TransID,

                RowOrder:
                    item?.RowOrder,

                ItemID:
                    item?.ItemID,

                ItemSKU:
                    item?.ItemSKU,

                Name:
                    item?.Name,

                Quantity:
                    item?.Quantity,

                CompletedQuantity:
                    item?.CompletedQuantity,

                UOMID:
                    item?.UOMID,

                UOMName:
                    item?.UOMName,

                UOMFactor:
                    item?.UOMFactor,

                SourceTransactionID:
                    item?.SourceTransactionID,

                SourceRowID:
                    item?.SourceRowID,

                SourceTransactionType:
                    item?.SourceTransactionType,

                SourceTransactionTypeName:
                    item?.SourceTransactionTypeName,

                SourceTransactionDocDate:
                    item?.SourceTransactionDocDate,

                SourceTransactionReference:
                    item?.SourceTransactionReference,

                Cost:
                    item?.Cost,

                Price:
                    item?.Price,

                DiscountPercent:
                    item?.DiscountPercent,

                RowType:
                    item?.RowType,

                EstimatedDeliveryDate:
                    item?.EstimatedDeliveryDate,

                ExchangeRate:
                    item?.ExchangeRate,

                WarrantyDays:
                    item?.WarrantyDays,

                WarrantyUnits:
                    item?.WarrantyUnits,

                TaxScheduleID:
                    item?.TaxScheduleID,

                TaxPercent:
                    item?.TaxPercent,

                LocationID:
                    item?.LocationID,

                LotID:
                    item?.LotID,

                BinID:
                    item?.BinID,

                ParentItemID:
                    item?.ParentItemID,

                AttributeOption1ID:
                    item?.AttributeOption1ID,

                AttributeOption2ID:
                    item?.AttributeOption2ID
            });
        }
    );
}

function logMappedLines(mapped) {
    console.log("");

    console.log(
        "🧩 ========================================================"
    );

    console.log(
        "🧩 DATOS MAPEADOS QUE SERÁN ENVIADOS A POSTGRESQL"
    );

    console.log(
        "🧩 TOTAL LÍNEAS:",
        mapped.length
    );

    console.log(
        "🧩 ========================================================"
    );

    mapped.forEach(
        (
            line,
            index
        ) => {

            console.log("");

            console.log(
                `🧩 LÍNEA MAPEADA #${index + 1}`
            );

            console.table(
                ERP_SYNC_COLUMNS.map(
                    column => ({
                        columna:
                            column,

                        valor:
                            line[column]
                    })
                )
            );
        }
    );
}

function logReturnSyncVerification({
    mapped,
    dbRows,
    documentType,
    documentGuid
}) {
    console.log("");

    console.log(
        "🔍 ========================================================"
    );

    console.log(
        "🔍 VERIFICACIÓN COMPLETA DE SINCRONIZACIÓN"
    );

    console.log(
        "🔍 TABLA: erp_inspection_lines"
    );

    console.log(
        "🔍 DOCUMENTO:",
        `${documentType}:${documentGuid}`
    );

    console.log(
        "🔍 COLUMNAS TOTALES DE LA TABLA:",
        ALL_TABLE_COLUMNS.length
    );

    console.log(
        "🔄 COLUMNAS ERP SINCRONIZADAS:",
        ERP_SYNC_COLUMNS.length
    );

    console.log(
        "🛡️ COLUMNAS WMS PRESERVADAS:",
        WMS_PRESERVED_COLUMNS.length
    );

    console.log(
        "⚙️ COLUMNAS DEL SISTEMA:",
        SYSTEM_COLUMNS.length
    );

    console.log(
        "🔍 ========================================================"
    );

    let totalCompared =
        0;

    let totalOk =
        0;

    let totalDifferent =
        0;

    let rowsWithoutMapping =
        0;

    const mappedByLineId =
        new Map(
            mapped.map(
                line => [
                    String(
                        line.erp_line_id
                    ).toLowerCase(),

                    line
                ]
            )
        );

    for (
        const row of dbRows
    ) {
        const lineId =
            String(
                row.erp_line_id ??
                ""
            ).toLowerCase();

        const source =
            mappedByLineId.get(
                lineId
            );

        console.log("");

        console.log(
            "📦 --------------------------------------------------------"
        );

        console.log(
            "📦 VERIFICANDO LÍNEA"
        );

        console.log(
            "📦 DB ID:",
            row.id
        );

        console.log(
            "📦 ERP LINE ID:",
            row.erp_line_id
        );

        console.log(
            "📦 SKU:",
            row.erp_item_sku
        );

        console.log(
            "📦 PRODUCTO:",
            row.erp_item_name
        );

        console.log(
            "📦 --------------------------------------------------------"
        );

        if (!source) {
            rowsWithoutMapping++;

            console.warn(
                "⚠️ No se encontró el mapeo ADM para esta fila."
            );

            continue;
        }

        const verificationRows =
            [];

        const differences =
            [];

        for (
            const column of ALL_TABLE_COLUMNS
        ) {
            if (
                ERP_SYNC_COLUMNS.includes(
                    column
                )
            ) {
                const expected =
                    source[column];

                const actual =
                    row[column];

                const equal =
                    valuesAreEqual(
                        expected,
                        actual
                    );

                totalCompared++;

                if (equal) {
                    totalOk++;
                } else {
                    totalDifferent++;
                }

                const result = {
                    columna:
                        column,

                    origen:
                        "ADM -> DB",

                    adm_mapeado:
                        expected,

                    postgres:
                        actual,

                    estado:
                        equal
                            ? "✅ OK"
                            : "❌ DIFERENTE"
                };

                verificationRows.push(
                    result
                );

                if (!equal) {
                    differences.push(
                        result
                    );
                }

                continue;
            }

            if (
                WMS_PRESERVED_COLUMNS.includes(
                    column
                )
            ) {
                verificationRows.push({
                    columna:
                        column,

                    origen:
                        "WMS PRESERVADO",

                    adm_mapeado:
                        "NO SE ACTUALIZA",

                    postgres:
                        row[column],

                    estado:
                        "🛡️ PRESERVADO"
                });

                continue;
            }

            verificationRows.push({
                columna:
                    column,

                origen:
                    "SISTEMA/DB",

                adm_mapeado:
                    "GENERADO",

                postgres:
                    row[column],

                estado:
                    "⚙️ SISTEMA"
            });
        }

        console.table(
            verificationRows
        );

        if (
            differences.length >
            0
        ) {
            console.log("");

            console.log(
                "❌ COLUMNAS CON DIFERENCIAS:"
            );

            console.table(
                differences
            );

        } else {

            console.log(
                "✅ Todas las columnas ERP de esta línea coinciden."
            );
        }
    }

    console.log("");

    console.log(
        "📊 ========================================================"
    );

    console.log(
        "📊 RESUMEN DE VERIFICACIÓN DE SINCRONIZACIÓN"
    );

    console.log(
        "📦 FILAS POSTGRESQL:",
        dbRows.length
    );

    console.log(
        "📦 FILAS ADM MAPEADAS:",
        mapped.length
    );

    console.log(
        "🔎 VALORES ERP COMPARADOS:",
        totalCompared
    );

    console.log(
        "✅ VALORES COINCIDENTES:",
        totalOk
    );

    console.log(
        "❌ VALORES DIFERENTES:",
        totalDifferent
    );

    console.log(
        "⚠️ FILAS SIN MAPEO ADM:",
        rowsWithoutMapping
    );

    if (
        totalDifferent === 0 &&
        rowsWithoutMapping === 0 &&
        dbRows.length === mapped.length
    ) {
        console.log(
            "✅ RESULTADO: TODAS LAS COLUMNAS ERP SE SINCRONIZARON CORRECTAMENTE."
        );
    } else {
        console.log(
            "⚠️ RESULTADO: REVISAR LAS DIFERENCIAS MOSTRADAS ARRIBA."
        );
    }

    console.log(
        "📊 ========================================================"
    );

    console.log("");
}

const UPSERT_LINES_SQL = `
    WITH incoming AS (

        SELECT *

        FROM jsonb_to_recordset(
            $1::jsonb
        ) AS x(

            document_type character varying,

            erp_document_id uuid,

            erp_line_id uuid,

            erp_trans_id uuid,

            erp_row_order integer,

            erp_item_id uuid,

            erp_item_sku character varying,

            erp_item_name text,

            completed_quantity numeric,

            erp_quantity numeric,

            erp_uom_id uuid,

            erp_uom_name character varying,

            erp_uom_factor numeric,

            erp_source_transaction_id uuid,

            erp_source_row_id uuid,

            erp_source_transaction_type character varying,

            erp_source_transaction_type_name character varying,

            erp_source_transaction_doc_date date,

            erp_source_transaction_reference text,

            erp_cost numeric,

            erp_price numeric,

            erp_discount_percent numeric,

            erp_row_type integer,

            erp_estimated_delivery_date date,

            erp_exchange_rate numeric,

            erp_warranty_days integer,

            erp_warranty_units integer,

            erp_tax_schedule_id uuid,

            erp_tax_percent numeric,

            erp_location_id uuid,

            erp_lot_id uuid,

            erp_bin_id uuid,

            erp_parent_item_id uuid,

            erp_attribute_option_1_id uuid,

            erp_attribute_option_2_id uuid
        )
    )


    INSERT INTO erp_inspection_lines (

        document_type,

        erp_document_id,

        erp_line_id,

        erp_trans_id,

        erp_row_order,

        erp_item_id,

        erp_item_sku,

        erp_item_name,

        completed_quantity,

        erp_quantity,

        erp_uom_id,

        erp_uom_name,

        erp_uom_factor,

        erp_source_transaction_id,

        erp_source_row_id,

        erp_source_transaction_type,

        erp_source_transaction_type_name,

        erp_source_transaction_doc_date,

        erp_source_transaction_reference,

        erp_cost,

        erp_price,

        erp_discount_percent,

        erp_row_type,

        erp_estimated_delivery_date,

        erp_exchange_rate,

        erp_warranty_days,

        erp_warranty_units,

        erp_tax_schedule_id,

        erp_tax_percent,

        erp_location_id,

        erp_lot_id,

        erp_bin_id,

        erp_parent_item_id,

        erp_attribute_option_1_id,

        erp_attribute_option_2_id,

        updated_at
    )


    SELECT

        document_type,

        erp_document_id,

        erp_line_id,

        erp_trans_id,

        erp_row_order,

        erp_item_id,

        erp_item_sku,

        erp_item_name,

        completed_quantity,

        erp_quantity,

        erp_uom_id,

        erp_uom_name,

        erp_uom_factor,

        erp_source_transaction_id,

        erp_source_row_id,

        erp_source_transaction_type,

        erp_source_transaction_type_name,

        erp_source_transaction_doc_date,

        erp_source_transaction_reference,

        erp_cost,

        erp_price,

        erp_discount_percent,

        erp_row_type,

        erp_estimated_delivery_date,

        erp_exchange_rate,

        erp_warranty_days,

        erp_warranty_units,

        erp_tax_schedule_id,

        erp_tax_percent,

        erp_location_id,

        erp_lot_id,

        erp_bin_id,

        erp_parent_item_id,

        erp_attribute_option_1_id,

        erp_attribute_option_2_id,

        NOW()

    FROM incoming


    ON CONFLICT (
        document_type,
        erp_document_id,
        erp_line_id
    )

    DO UPDATE SET

        erp_trans_id =
            EXCLUDED.erp_trans_id,

        erp_row_order =
            EXCLUDED.erp_row_order,

        erp_item_id =
            EXCLUDED.erp_item_id,

        erp_item_sku =
            EXCLUDED.erp_item_sku,

        erp_item_name =
            EXCLUDED.erp_item_name,

        completed_quantity =
            EXCLUDED.completed_quantity,

        erp_quantity =
            EXCLUDED.erp_quantity,

        erp_uom_id =
            EXCLUDED.erp_uom_id,

        erp_uom_name =
            EXCLUDED.erp_uom_name,

        erp_uom_factor =
            EXCLUDED.erp_uom_factor,

        erp_source_transaction_id =
            EXCLUDED.erp_source_transaction_id,

        erp_source_row_id =
            EXCLUDED.erp_source_row_id,

        erp_source_transaction_type =
            EXCLUDED.erp_source_transaction_type,

        erp_source_transaction_type_name =
            EXCLUDED.erp_source_transaction_type_name,

        erp_source_transaction_doc_date =
            EXCLUDED.erp_source_transaction_doc_date,

        erp_source_transaction_reference =
            EXCLUDED.erp_source_transaction_reference,

        erp_cost =
            EXCLUDED.erp_cost,

        erp_price =
            EXCLUDED.erp_price,

        erp_discount_percent =
            EXCLUDED.erp_discount_percent,

        erp_row_type =
            EXCLUDED.erp_row_type,

        erp_estimated_delivery_date =
            EXCLUDED.erp_estimated_delivery_date,

        erp_exchange_rate =
            EXCLUDED.erp_exchange_rate,

        erp_warranty_days =
            EXCLUDED.erp_warranty_days,

        erp_warranty_units =
            EXCLUDED.erp_warranty_units,

        erp_tax_schedule_id =
            EXCLUDED.erp_tax_schedule_id,

        erp_tax_percent =
            EXCLUDED.erp_tax_percent,

        erp_location_id =
            EXCLUDED.erp_location_id,

        erp_lot_id =
            EXCLUDED.erp_lot_id,

        erp_bin_id =
            EXCLUDED.erp_bin_id,

        erp_parent_item_id =
            EXCLUDED.erp_parent_item_id,

        erp_attribute_option_1_id =
            EXCLUDED.erp_attribute_option_1_id,

        erp_attribute_option_2_id =
            EXCLUDED.erp_attribute_option_2_id,

        updated_at =
            NOW()


    RETURNING id;
`;

async function recalculateReturnDocumentStatus(
    client,
    documentType,
    documentGuid
) {

    const summaryResult =
        await client.query(
            `
                SELECT

                    COUNT(*)::integer
                        AS total_lines,


                    COUNT(*) FILTER (
                        WHERE COALESCE(
                            returned_quantity,
                            0
                        ) = 0
                    )::integer
                        AS zero_lines,


                    COUNT(*) FILTER (
                        WHERE COALESCE(
                            returned_quantity,
                            0
                        ) > 0
                    )::integer
                        AS returned_lines,


                    COUNT(*) FILTER (

                        WHERE erp_quantity IS NOT NULL

                          AND COALESCE(
                              erp_quantity,
                              0
                          ) > 0

                          AND COALESCE(
                              returned_quantity,
                              0
                          ) >= erp_quantity

                    )::integer
                        AS completely_returned_lines,


                    COALESCE(
                        SUM(
                            erp_quantity
                        ),
                        0
                    )::numeric
                        AS total_document_quantity,


                    COALESCE(
                        SUM(
                            returned_quantity
                        ),
                        0
                    )::numeric
                        AS total_returned_quantity


                FROM erp_inspection_lines


                WHERE document_type =
                    $1


                  AND erp_document_id =
                    $2::uuid
            `,
            [
                documentType,
                documentGuid
            ]
        );


    const summary =
        summaryResult.rows[0];


    const totalLines =
        Number(
            summary.total_lines ??
            0
        );


    const zeroLines =
        Number(
            summary.zero_lines ??
            0
        );


    const returnedLines =
        Number(
            summary.returned_lines ??
            0
        );


    const completelyReturnedLines =
        Number(
            summary.completely_returned_lines ??
            0
        );


    const totalDocumentQuantity =
        Number(
            summary.total_document_quantity ??
            0
        );


    const totalReturnedQuantity =
        Number(
            summary.total_returned_quantity ??
            0
        );


    let returnStatus;


    if (
        totalLines === 0 ||
        zeroLines === totalLines
    ) {

        returnStatus =
            "DESPACHADO";


    } else if (
        completelyReturnedLines ===
        totalLines
    ) {

        returnStatus =
            "DEVUELTO_COMPLETAMENTE";


    } else {

        returnStatus =
            "DEVUELTO_PARCIALMENTE";

    }


    const headerTable =
        documentType ===
        "CONDUCE"

            ? "erp_dispatches"

            : "erp_invoices";


    const headerResult =
        await client.query(
            `
                UPDATE ${headerTable}


                SET

                    return_status =
                        $1,

                    updated_at =
                        NOW()


                WHERE erp_id =
                    $2::uuid


                RETURNING

                    erp_id,

                    return_status
            `,
            [
                returnStatus,
                documentGuid
            ]
        );


    if (
        headerResult.rowCount !==
        1
    ) {

        const error =
            new Error(
                `No existe el encabezado del ${documentType} ` +
                `${documentGuid} en ${headerTable}.`
            );


        error.httpStatus =
            404;


        throw error;

    }


    console.log("");

    console.log(
        "↩️ ========================================"
    );

    console.log(
        "📋 ESTADO GLOBAL DE DEVOLUCIÓN"
    );

    console.log(
        "📄 DOCUMENTO:",
        documentGuid
    );

    console.log(
        "📄 TIPO:",
        documentType
    );

    console.log(
        "📦 TOTAL LÍNEAS:",
        totalLines
    );

    console.log(
        "⚪ LÍNEAS SIN DEVOLUCIÓN:",
        zeroLines
    );

    console.log(
        "↩️ LÍNEAS CON DEVOLUCIÓN:",
        returnedLines
    );

    console.log(
        "✅ LÍNEAS COMPLETAMENTE DEVUELTAS:",
        completelyReturnedLines
    );

    console.log(
        "📦 CANTIDAD TOTAL DOCUMENTO:",
        totalDocumentQuantity
    );

    console.log(
        "↩️ CANTIDAD TOTAL DEVUELTA:",
        totalReturnedQuantity
    );

    console.log(
        "🏷️ ESTADO:",
        returnStatus
    );

    console.log(
        "↩️ ========================================"
    );


    return {

        return_status:
            returnStatus,


        total_lines:
            totalLines,


        zero_lines:
            zeroLines,


        returned_lines:
            returnedLines,


        completely_returned_lines:
            completelyReturnedLines,


        partially_returned_lines:
            totalLines -
            completelyReturnedLines -
            zeroLines,


        total_document_quantity:
            totalDocumentQuantity,


        total_returned_quantity:
            totalReturnedQuantity

    };
}

export async function syncReturnDocumentLinesController(
    req,
    res
) {

    const documentType =
        normalizeDocumentType(
            req.params.tipo
        );


    const documentGuid =
        String(
            req.params.guid ??
            ""
        )
            .trim()
            .toLowerCase();


    if (
        !documentType
    ) {

        return res
            .status(
                400
            )
            .json({

                success:
                    false,

                message:
                    "El tipo debe ser CONDUCE o FACTURA."

            });
    }


    if (
        !UUID_PATTERN.test(
            documentGuid
        )
    ) {

        return res
            .status(
                400
            )
            .json({

                success:
                    false,

                message:
                    "El GUID del documento es inválido."

            });
    }


    let client =
        null;


    let transactionStarted =
        false;


    try {

        console.log("");

        console.log(
            "🟦 ========================================================"
        );

        console.log(
            "🔄 INICIANDO SINCRONIZACIÓN PARA DEVOLUCIÓN"
        );

        console.log(
            "📄 TIPO:",
            documentType
        );

        console.log(
            "🆔 GUID:",
            documentGuid
        );

        console.log(
            "🟦 ========================================================"
        );


        let serviceResult;


        if (
            documentType ===
            "CONDUCE"
        ) {

            console.log(
                "🚚 CONSULTANDO CONDUCE EN ADM CLOUD..."
            );


            serviceResult =
                await getAdmCloudDispatchService({

                    id:
                        documentGuid

                });


        } else {


            console.log(
                "🧾 CONSULTANDO FACTURA EN ADM CLOUD..."
            );


            serviceResult =
                await getAdmCloudCreditInvoiceById(
                    documentGuid
                );

        }


        const erpDocument =
            unwrapDocument(
                serviceResult
            );


        const rawItems =
            erpDocument.Items ??
            erpDocument.items;


        if (
            !Array.isArray(
                rawItems
            )
        ) {

            throw new Error(
                "Adm Cloud no devolvió un arreglo Items válido. " +
                "Se canceló la sincronización para evitar eliminar líneas."
            );
        }


        const returnedGuid =
            erpDocument.ID ??
            erpDocument.Id ??
            erpDocument.id;


        if (
            !returnedGuid ||

            String(
                returnedGuid
            ).toLowerCase() !==
            documentGuid
        ) {

            throw new Error(
                "Adm Cloud no confirmó el GUID del documento solicitado. " +
                `GUID recibido: ${returnedGuid ?? "NINGUNO"}. ` +
                "No se modificaron las líneas."
            );
        }


        console.log(
            "📦 LÍNEAS RECIBIDAS:",
            rawItems.length
        );


        logRawAdmItems(
            rawItems
        );


        const physicalItems =
            rawItems.filter(
                item => {

                    const itemType =
                        String(
                            item?.ItemType ??
                            item?.itemType ??
                            ""
                        )
                            .trim()
                            .toUpperCase();


                    return (
                        itemType !==
                        "S"
                    );
                }
            );


        const excludedServices =
            rawItems.length -
            physicalItems.length;


        console.log("");

        console.log(
            "📦 ========================================================"
        );

        console.log(
            "📦 FILTRANDO PRODUCTOS Y SERVICIOS"
        );

        console.log(
            "📦 TOTAL ADM:",
            rawItems.length
        );

        console.log(
            "📦 PRODUCTOS A SINCRONIZAR:",
            physicalItems.length
        );

        console.log(
            "🚫 SERVICIOS IGNORADOS:",
            excludedServices
        );

        console.log(
            "📦 ========================================================"
        );


        const mapped =
            physicalItems.map(
                item =>
                    mapReturnSyncLine(
                        item,
                        documentType,
                        documentGuid
                    )
            );


        logMappedLines(
            mapped
        );


        const lineIds =
            mapped.map(
                line =>
                    line.erp_line_id
            );


        if (
            new Set(
                lineIds
            ).size !==
            lineIds.length
        ) {

            throw new Error(
                "Adm Cloud devolvió líneas duplicadas con el mismo ID."
            );
        }


        client =
            await db.connect();


        await client.query(
            "BEGIN"
        );


        transactionStarted =
            true;


        await client.query(
            `
                SELECT pg_advisory_xact_lock(

                    hashtext(
                        'erp_inspection_lines'
                    ),

                    hashtext(
                        $1::text
                    )

                )
            `,
            [
                `${documentType}:${documentGuid}`
            ]
        );


        console.log(
            "🔒 BLOQUEO DEL DOCUMENTO ADQUIRIDO"
        );


        let saved =
            0;


        for (
            let offset = 0;

            offset <
            mapped.length;

            offset +=
            BATCH_SIZE
        ) {

            const batch =
                mapped.slice(
                    offset,
                    offset +
                    BATCH_SIZE
                );


            console.log("");

            console.log(
                "💾 ========================================================"
            );

            console.log(
                "💾 EJECUTANDO UPSERT DEL LOTE:",
                `${offset + 1}-${offset + batch.length}`
            );

            console.log(
                "💾 COLUMNAS ERP:",
                ERP_SYNC_COLUMNS.length
            );

            console.log(
                "💾 ========================================================"
            );


            const result =
                await client.query(
                    UPSERT_LINES_SQL,
                    [
                        JSON.stringify(
                            batch
                        )
                    ]
                );


            if (
                result.rowCount !==
                batch.length
            ) {

                throw new Error(
                    "No se guardaron todas las líneas del lote."
                );
            }


            saved +=
                result.rowCount;


            console.log(
                "✅ LÍNEAS SINCRONIZADAS:",
                `${saved}/${mapped.length}`
            );
        }


        let deleteResult;


        if (
            lineIds.length >
            0
        ) {

            deleteResult =
                await client.query(
                    `
                        DELETE FROM erp_inspection_lines


                        WHERE document_type =
                            $1


                          AND erp_document_id =
                            $2::uuid


                          AND erp_line_id <>
                            ALL(
                                $3::uuid[]
                            )


                        RETURNING

                            id::text
                                AS id,

                            erp_line_id,

                            erp_item_sku
                    `,
                    [
                        documentType,
                        documentGuid,
                        lineIds
                    ]
                );


        } else {


            deleteResult =
                await client.query(
                    `
                        DELETE FROM erp_inspection_lines


                        WHERE document_type =
                            $1


                          AND erp_document_id =
                            $2::uuid


                        RETURNING

                            id::text
                                AS id,

                            erp_line_id,

                            erp_item_sku
                    `,
                    [
                        documentType,
                        documentGuid
                    ]
                );
        }


        const deletedLines =
            deleteResult.rowCount ??
            0;


        console.log("");

        console.log(
            "🗑️ ========================================================"
        );

        console.log(
            "🗑️ DEPURANDO LÍNEAS OBSOLETAS"
        );

        console.log(
            "🗑️ LÍNEAS ELIMINADAS:",
            deletedLines
        );


        if (
            deletedLines >
            0
        ) {

            console.table(
                deleteResult.rows
            );
        }


        console.log(
            "🗑️ ========================================================"
        );


        const linesResult =
            await client.query(
                `
                    SELECT

                        ${LINE_COLUMNS_SQL}


                    FROM erp_inspection_lines


                    WHERE document_type =
                        $1


                      AND erp_document_id =
                        $2::uuid


                    ORDER BY

                        erp_row_order
                            NULLS LAST,

                        id
                `,
                [
                    documentType,
                    documentGuid
                ]
            );


        logReturnSyncVerification({

            mapped,

            dbRows:
                linesResult.rows,

            documentType,

            documentGuid

        });


        const headerTable =
            documentType ===
            "CONDUCE"

                ? "erp_dispatches"

                : "erp_invoices";


        const headerResult =
            await client.query(
                `
                    SELECT

                        erp_numero,

                        erp_fecha,

                        erp_cliente,

                        erp_ubicacion,

                        erp_referencia,

                        inspection_status,

                        return_status


                    FROM ${headerTable}


                    WHERE erp_id =
                        $1::uuid


                    LIMIT 1
                `,
                [
                    documentGuid
                ]
            );


        const header =
            headerResult.rows[0] ??
            null;


        const document = {

            erp_id:
                documentGuid,


            tipo:
                documentType,


            numero:

                header?.erp_numero ??

                erpDocument.DocID ??

                null,


            fecha:

                header?.erp_fecha ??

                erpDocument.DocDate ??

                null,


            cliente:

                header?.erp_cliente ??

                erpDocument.RelationshipName ??

                null,


            ubicacion:

                header?.erp_ubicacion ??

                erpDocument.LocationName ??

                null,


            erp_referencia:

                header?.erp_referencia ??

                erpDocument.Reference ??

                null,


            inspeccion_status:

                header?.inspection_status ??

                "PENDIENTE",


            return_status:

                header?.return_status ??

                "DESPACHADO"

        };


        await client.query(
            "COMMIT"
        );


        transactionStarted =
            false;


        const lines =
            linesResult.rows.map(
                mapLineForFrontend
            );


        console.log("");

        console.log(
            "🟩 ========================================================"
        );

        console.log(
            "✅ SINCRONIZACIÓN DE DEVOLUCIÓN COMPLETADA"
        );

        console.log(
            "📄 DOCUMENTO:",
            document.numero
        );

        console.log(
            "📄 TIPO:",
            documentType
        );

        console.log(
            "🆔 GUID:",
            documentGuid
        );

        console.log(
            "📦 LÍNEAS ADM CLOUD:",
            rawItems.length
        );

        console.log(
            "📦 PRODUCTOS SINCRONIZADOS:",
            saved
        );

        console.log(
            "🚫 SERVICIOS IGNORADOS:",
            excludedServices
        );

        console.log(
            "🗑️ LÍNEAS ELIMINADAS:",
            deletedLines
        );

        console.log(
            "📦 LÍNEAS FINALES DB:",
            lines.length
        );

        console.log(
            "📋 COLUMNAS TABLA:",
            ALL_TABLE_COLUMNS.length
        );

        console.log(
            "🔄 COLUMNAS ERP ACTUALIZADAS:",
            ERP_SYNC_COLUMNS.length
        );

        console.log(
            "🛡️ COLUMNAS WMS PRESERVADAS:",
            WMS_PRESERVED_COLUMNS
        );

        console.log(
            "🏷️ RETURN STATUS:",
            document.return_status
        );

        console.log(
            "🟩 ========================================================"
        );


        return res
            .status(
                200
            )
            .json({

                success:
                    true,


                document,


                documentType,


                documentGuid,


                total:
                    lines.length,


                excludedServices,


                deletedLines,


                lines

            });


    } catch (
        error
    ) {


        if (
            client &&
            transactionStarted
        ) {

            try {

                await client.query(
                    "ROLLBACK"
                );


                console.log(
                    "↩️ TRANSACCIÓN REVERTIDA"
                );


            } catch (
                rollbackError
            ) {


                console.error(
                    "❌ ERROR EN ROLLBACK:",
                    rollbackError.message
                );
            }
        }


        console.log("");

        console.log(
            "🟥 ========================================================"
        );

        console.log(
            "❌ ERROR SINCRONIZANDO DEVOLUCIÓN"
        );

        console.log(
            "📄 MENSAJE:",
            error.message
        );

        console.log(
            "🗄️ PG CODE:",
            error.code ??
            null
        );

        console.log(
            "🗄️ PG DETAIL:",
            error.detail ??
            null
        );

        console.log(
            "🌐 HTTP STATUS:",
            error.status ??
            error.response?.status ??
            null
        );

        console.log(
            "🟥 ========================================================"
        );


        return res
            .status(

                error.response?.status ===
                404

                    ? 404

                    : 500

            )
            .json({

                success:
                    false,


                message:

                    error.message ??

                    "No se pudo sincronizar el documento."

            });


    } finally {


        if (
            client
        ) {

            client.release();

        }
    }
}

export async function updateReturnLineQuantity(
    req,
    res
) {

    const documentType =
        normalizeDocumentType(
            req.params.tipo
        );


    const documentGuid =
        String(
            req.params.guid ??
            ""
        )
            .trim()
            .toLowerCase();


    const lineId =
        String(
            req.params.lineId ??
            ""
        ).trim();


    const scannedCode =
        String(
            req.body?.scanned_code ??
            ""
        )
            .trim()
            .toUpperCase();


    const quantity =
        String(
            req.body?.returned_quantity ??
            ""
        ).trim();


    console.log("");

    console.log(
        "↩️ ========================================"
    );

    console.log(
        "📦 CONFIRMANDO LÍNEA DE DEVOLUCIÓN"
    );

    console.log(
        "📄 TIPO:",
        documentType
    );

    console.log(
        "🆔 GUID:",
        documentGuid
    );

    console.log(
        "🆔 LINE ID:",
        lineId
    );

    console.log(
        "📡 ERP SKU:",
        scannedCode
    );

    console.log(
        "🔢 CANTIDAD DEVUELTA:",
        quantity
    );

    console.log(
        "↩️ ========================================"
    );


    if (
        !documentType
    ) {

        return res
            .status(
                400
            )
            .json({

                success:
                    false,

                message:
                    "El tipo de documento debe ser CONDUCE o FACTURA."

            });
    }


    if (
        !UUID_PATTERN.test(
            documentGuid
        )
    ) {

        return res
            .status(
                400
            )
            .json({

                success:
                    false,

                message:
                    "El GUID del documento es inválido."

            });
    }


    if (
        !/^[1-9]\d*$/.test(
            lineId
        )
    ) {

        return res
            .status(
                400
            )
            .json({

                success:
                    false,

                message:
                    "El ID de la línea es inválido."

            });
    }


    if (
        !scannedCode
    ) {

        return res
            .status(
                400
            )
            .json({

                success:
                    false,

                message:
                    "Debe escanear y confirmar el producto antes de guardar la devolución."

            });
    }


    if (
        !/^\d+(?:\.\d{1,4})?$/.test(
            quantity
        ) ||

        Number(
            quantity
        ) >
        99999999999999
    ) {

        return res
            .status(
                400
            )
            .json({

                success:
                    false,

                message:
                    "La cantidad devuelta debe ser mayor o igual a cero y tener máximo 4 decimales."

            });
    }


    const returnedQuantity =
        Number(
            quantity
        );


    if (
        !Number.isFinite(
            returnedQuantity
        )
    ) {

        return res
            .status(
                400
            )
            .json({

                success:
                    false,

                message:
                    "La cantidad devuelta es inválida."

            });
    }


    let client =
        null;


    let transactionStarted =
        false;


    try {


        client =
            await db.connect();


        await client.query(
            "BEGIN"
        );


        transactionStarted =
            true;


        await client.query(
            `
                SELECT pg_advisory_xact_lock(

                    hashtext(
                        'erp_inspection_lines'
                    ),

                    hashtext(
                        $1::text
                    )

                )
            `,
            [
                `${documentType}:${documentGuid}`
            ]
        );


        console.log(
            "🔒 BLOQUEO DE DEVOLUCIÓN ADQUIRIDO"
        );


        const currentResult =
            await client.query(
                `
                    SELECT

                        id,

                        document_type,

                        erp_document_id,

                        erp_line_id,

                        erp_item_id,

                        erp_item_sku,

                        erp_item_name,

                        erp_quantity,

                        completed_quantity,

                        inspected_quantity,

                        returned_quantity,

                        inspection_status,

                        erp_uom_name,

                        erp_row_order


                    FROM erp_inspection_lines


                    WHERE id =
                        $1::bigint


                      AND document_type =
                        $2


                      AND erp_document_id =
                        $3::uuid


                    FOR UPDATE
                `,
                [
                    lineId,
                    documentType,
                    documentGuid
                ]
            );


        if (
            currentResult.rowCount !==
            1
        ) {

            const error =
                new Error(
                    "La línea no existe o no pertenece al documento indicado."
                );


            error.httpStatus =
                404;


            throw error;
        }


        const currentLine =
            currentResult.rows[0];


        const databaseSku =
            String(
                currentLine.erp_item_sku ??
                ""
            )
                .trim()
                .toUpperCase();


        if (
            databaseSku !==
            scannedCode
        ) {

            const error =
                new Error(
                    `El producto escaneado ${scannedCode} ` +
                    "no corresponde a la línea seleccionada " +
                    `(${databaseSku}).`
                );


            error.httpStatus =
                409;


            throw error;
        }


        const documentQuantity =
            Number(
                currentLine.erp_quantity ??
                0
            );


        const warning =
            returnedQuantity >
            documentQuantity

                ? (
                    "La cantidad devuelta supera " +
                    "la cantidad original del documento."
                )

                : null;


        const result =
            await client.query(
                `
                    UPDATE erp_inspection_lines


                    SET

                        returned_quantity =
                            $1::numeric,

                        updated_at =
                            NOW()


                    WHERE id =
                        $2::bigint


                      AND document_type =
                        $3


                      AND erp_document_id =
                        $4::uuid


                      AND UPPER(
                            BTRIM(
                                COALESCE(
                                    erp_item_sku,
                                    ''
                                )
                            )
                          ) =
                          $5


                    RETURNING

                        ${LINE_COLUMNS_SQL}
                `,
                [
                    quantity,
                    lineId,
                    documentType,
                    documentGuid,
                    scannedCode
                ]
            );


        if (
            result.rowCount !==
            1
        ) {

            const error =
                new Error(
                    "El producto escaneado no corresponde " +
                    "a la línea seleccionada o la línea " +
                    "no pertenece a este documento."
                );


            error.httpStatus =
                409;


            throw error;
        }


        const returnSummary =
            await recalculateReturnDocumentStatus(
                client,
                documentType,
                documentGuid
            );


        const line =
            mapLineForFrontend(
                result.rows[0]
            );


        await client.query(
            "COMMIT"
        );


        transactionStarted =
            false;


        console.log("");

        console.log(
            "🟩 ========================================"
        );

        console.log(
            "✅ DEVOLUCIÓN GUARDADA CORRECTAMENTE"
        );

        console.log(
            "📄 DOCUMENTO:",
            documentGuid
        );

        console.log(
            "📄 TIPO:",
            documentType
        );

        console.log(
            "📦 SKU:",
            line.sku
        );

        console.log(
            "🔢 CANTIDAD DOCUMENTO:",
            line.quantity
        );

        console.log(
            "↩️ CANTIDAD DEVUELTA:",
            line.returned_quantity
        );

        console.log(
            "🏷️ ESTADO DEVOLUCIÓN:",
            returnSummary.return_status
        );

        console.log(
            "📦 TOTAL LÍNEAS:",
            returnSummary.total_lines
        );

        console.log(
            "↩️ LÍNEAS CON DEVOLUCIÓN:",
            returnSummary.returned_lines
        );

        console.log(
            "✅ LÍNEAS COMPLETAMENTE DEVUELTAS:",
            returnSummary.completely_returned_lines
        );

        console.log(
            "📊 TOTAL CANTIDAD DOCUMENTO:",
            returnSummary.total_document_quantity
        );

        console.log(
            "📊 TOTAL CANTIDAD DEVUELTA:",
            returnSummary.total_returned_quantity
        );


        if (
            warning
        ) {

            console.log(
                "⚠️ WARNING:",
                warning
            );
        }


        console.log(
            "🟩 ========================================"
        );


        return res
            .status(
                200
            )
            .json({

                success:
                    true,


                message:
                    "Cantidad devuelta guardada correctamente.",


                warning,


                line,


                return_status:
                    returnSummary.return_status,


                return_summary:
                    returnSummary

            });


    } catch (
        error
    ) {


        if (
            client &&
            transactionStarted
        ) {

            try {


                await client.query(
                    "ROLLBACK"
                );


                console.log(
                    "↩️ TRANSACCIÓN DE DEVOLUCIÓN REVERTIDA"
                );


            } catch (
                rollbackError
            ) {


                console.error(
                    "❌ ERROR AL REVERTIR DEVOLUCIÓN:",
                    rollbackError
                );
            }
        }


        console.log("");

        console.log(
            "🟥 ========================================"
        );

        console.log(
            "❌ ERROR GUARDANDO DEVOLUCIÓN"
        );

        console.log(
            "📄 MENSAJE:",
            error.message
        );

        console.log(
            "🗄️ PG CODE:",
            error.code ??
            null
        );

        console.log(
            "🗄️ PG DETAIL:",
            error.detail ??
            null
        );

        console.log(
            "🟥 ========================================"
        );


        const status =
            [
                404,
                409
            ].includes(
                error.httpStatus
            )

                ? error.httpStatus

                : 500;


        return res
            .status(
                status
            )
            .json({

                success:
                    false,


                message:

                    status === 500

                        ? (
                            "No se pudo guardar la cantidad " +
                            "ni actualizar el estado de devolución."
                        )

                        : error.message

            });


    } finally {


        if (
            client
        ) {

            client.release();

        }
    }
}