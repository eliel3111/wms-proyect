import ExcelJS from "exceljs";

function formatDate(date) {
  if (!date) return "";

  return new Date(date).toLocaleDateString("es-DO", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

export async function getInventoryFinalReportExcelService(client, sessionId) {
  const sessionResult = await client.query(
    `
    SELECT id, code, status, start_date, end_date
    FROM inventory_sessions
    WHERE id = $1
    LIMIT 1
    `,
    [sessionId]
  );

  if (sessionResult.rows.length === 0) {
    return {
      success: false,
      title: "Sesión no encontrada",
      message: "No se encontró la sesión de inventario.",
    };
  }

  const session = sessionResult.rows[0];

  const reportResult = await client.query(
    `
    SELECT
      erp_id,
      session_id,
      sku,
      erp_name,
      erp_sku,
      description,
      total_inventory_qty,
      erp_stock,
      unit_cost,
      difference,
      status,
      exist_erp,
      product_no_exist
    FROM inventory_erp_report
    WHERE session_id = $1
    ORDER BY status DESC, erp_name ASC
    `,
    [sessionId]
  );

  const rows = reportResult.rows;

  if (rows.length === 0) {
    return {
      success: false,
      title: "Reporte vacío",
      message: "No hay datos generados en inventory_erp_report para esta sesión.",
    };
  }

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Inventario Fisico");

  sheet.pageSetup = {
    orientation: "landscape",
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
  };

  sheet.mergeCells("A1:J1");
  sheet.getCell("A1").value = "INVENTARIO FISICO GENERAL";
  sheet.getCell("A1").font = { bold: true, size: 16 };
  sheet.getCell("A1").alignment = { horizontal: "center" };

  sheet.mergeCells("A2:J2");
  sheet.getCell("A2").value = "Garlas Control";
  sheet.getCell("A2").font = { size: 14 };
  sheet.getCell("A2").alignment = { horizontal: "center" };

  sheet.mergeCells("A4:J4");
  sheet.getCell("A4").value = `Fecha: ${formatDate(session.start_date)} a ${formatDate(session.end_date) || formatDate(new Date())}`;
  sheet.getCell("A4").font = { size: 13 };
  sheet.getCell("A4").alignment = { horizontal: "center" };

  const headerRowNumber = 7;

  sheet.columns = [
    { key: "inventory_date", width: 18 },
    { key: "product_code", width: 22 },
    { key: "description", width: 35 },
    { key: "name", width: 35 },
    { key: "sku", width: 18 },
    { key: "system_qty", width: 18 },
    { key: "physical_qty", width: 18 },
    { key: "unit_diff", width: 18 },
    { key: "unit_cost", width: 18 },
    { key: "positive_value", width: 22 },
    { key: "negative_value", width: 22 },
  ];

  const headerRow = sheet.getRow(headerRowNumber);

  headerRow.values = [
    "Fecha del inventario fisico",
    "Codigo del producto P/N",
    "Descripcion",
    "Nombre",
    "Sku",
    "Cantidad del sistema Citrus",
    "Inventario fisico",
    "Diferencias en unidades",
    "Costo unitario RD$",
    "Diferencias en valor Positivos RD$",
    "Diferencias en valor Negativas RD$",
  ];

  headerRow.eachCell((cell) => {
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "4472C4" },
    };

    cell.font = {
      color: { argb: "FFFFFF" },
      bold: true,
      size: 10,
    };

    cell.alignment = {
      horizontal: "center",
      vertical: "middle",
      wrapText: true,
    };

    cell.border = {
      top: { style: "thin" },
      left: { style: "thin" },
      bottom: { style: "thin" },
      right: { style: "thin" },
    };
  });

  headerRow.height = 45;

  let totalPositive = 0;
  let totalNegative = 0;
  let correctProducts = 0;
  let incorrectProducts = 0;

  rows.forEach((item, index) => {
    const difference = Number(item.difference ?? 0);
    const unitCost = Number(item.unit_cost ?? 0);
    const valueDifference = difference * unitCost;

    const positiveValue = valueDifference > 0 ? valueDifference : 0;
    const negativeValue = valueDifference < 0 ? valueDifference : 0;

    totalPositive += positiveValue;
    totalNegative += negativeValue;

    if (difference === 0) {
      correctProducts += 1;
    } else {
      incorrectProducts += 1;
    }

    const row = sheet.addRow({
      inventory_date: formatDate(session.start_date),
      product_code: item.erp_sku || item.erp_id,
      description: item.description,
      name: item.erp_name,
      sku: item.sku,
      system_qty: Number(item.erp_stock ?? 0),
      physical_qty: Number(item.total_inventory_qty ?? 0),
      unit_diff: difference,
      unit_cost: unitCost,
      positive_value: positiveValue,
      negative_value: negativeValue,
    });

    row.eachCell((cell) => {
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: index % 2 === 0 ? "D9E1F2" : "EDEFF7" },
      };

      cell.alignment = {
        horizontal: "center",
        vertical: "middle",
        wrapText: true,
      };

      cell.border = {
        top: { style: "thin", color: { argb: "FFFFFF" } },
        left: { style: "thin", color: { argb: "FFFFFF" } },
        bottom: { style: "thin", color: { argb: "FFFFFF" } },
        right: { style: "thin", color: { argb: "FFFFFF" } },
      };
    });

    row.getCell("unit_cost").numFmt = '#,##0.00';
    row.getCell("positive_value").numFmt = '#,##0.00';
    row.getCell("negative_value").numFmt = '#,##0.00';
  });

  const totalRow = sheet.addRow({});
  totalRow.getCell(9).value = "Total RD$";
  totalRow.getCell(10).value = totalPositive;
  totalRow.getCell(11).value = totalNegative;

  totalRow.eachCell((cell) => {
    cell.font = { bold: true };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "C8D1E8" },
    };
    cell.alignment = { horizontal: "center" };
    cell.border = {
      top: { style: "medium" },
      bottom: { style: "thin" },
    };
  });

  totalRow.getCell(10).numFmt = '#,##0.00';
  totalRow.getCell(11).numFmt = '#,##0.00';

  const balanceRow = sheet.addRow({});
  balanceRow.getCell(9).value = "Balance RD$";
  balanceRow.getCell(10).value = totalPositive + totalNegative;

  balanceRow.getCell(9).font = { bold: true };
  balanceRow.getCell(10).font = {
    bold: true,
    color: { argb: totalPositive + totalNegative < 0 ? "FF0000" : "008000" },
  };

  balanceRow.getCell(10).numFmt = '#,##0.00';

  const summaryStartRow = balanceRow.number + 2;
  const totalProducts = rows.length;
  const precisionPercent =
    totalProducts > 0 ? Number(((correctProducts / totalProducts) * 100).toFixed(2)) : 0;

  sheet.getCell(`B${summaryStartRow}`).value = "Resumen del inventario fisico general:";
  sheet.getCell(`B${summaryStartRow}`).font = { bold: true };

  sheet.getCell(`B${summaryStartRow + 1}`).value = `Cantidad de productos contados: ${totalProducts}`;
  sheet.getCell(`B${summaryStartRow + 2}`).value = `Cantidad de productos incorrectos: ${incorrectProducts}`;
  sheet.getCell(`B${summaryStartRow + 3}`).value = `Cantidad de productos correctos: ${correctProducts}`;
  sheet.getCell(`B${summaryStartRow + 4}`).value = `% de precision: ${precisionPercent}%`;

  sheet.views = [{ state: "frozen", ySplit: headerRowNumber }];

  const buffer = await workbook.xlsx.writeBuffer();

  return {
    success: true,
    buffer,
    fileName: `inventario-fisico-${session.code}.xlsx`,
    session,
    totals: {
      totalProducts,
      correctProducts,
      incorrectProducts,
      totalPositive,
      totalNegative,
      balance: totalPositive + totalNegative,
      precisionPercent,
    },
  };
}