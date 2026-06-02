import fs from "fs";
import path from "path";

export function buildReceiptHtml(headerPDF, lines) {
  const templatePath = path.join(
    process.cwd(),
    "templates",
    "nota-recepcion.html"
  );
/*console.log(1);
for (const line of lines) {
  console.log("DESCRIPTION:", line.description);
  console.log("TYPE:", typeof line.description);
}*/

  let html = fs.readFileSync(templatePath, "utf-8");

  const rows = lines.map(line => `
    <tr>
      <td>${line.line_no}</td>
      <td>${line.erp_sku}</td>
      <td>
  ${line.erp_name || ""}
  /
  ${line.description?.description || ""}
</td>
      <td>${line.ordered_qty}</td>
      <td>${line.received_qty}</td>
      <td>${line.difference_qty}</td>
    </tr>
  `).join("");

  html = html
    .replace("{{date}}", new Date().toLocaleDateString())
    .replace("{{receiptCode}}", headerPDF.receiptCode)
    .replace("{{userName}}", headerPDF.userName)
    .replace("{{poNumber}}", headerPDF.poNumber)
    .replace("{{invoice}}", headerPDF.invoice)
    .replace("{{supplierName}}", headerPDF.supplierName)
    .replace("{{rows}}", rows);

  return html;
}




export function buildTransferHtml(headerPDF, lines) {
  const templatePath = path.join(
    process.cwd(),
    "templates",
    "transfer-template.html"
  );

  let html = fs.readFileSync(templatePath, "utf-8");

  const rows = lines.map(line => `
  <tr>
    <td>${line.sku}</td>
    <td>${line.description || ""}</td>
    <td style="text-align:center;">${line.qty}</td>
    <td></td>
    <td></td>
  </tr>
`).join("");

  html = html
    .replace("{{transferNo}}", headerPDF.transferNo)
    .replace("{{origin}}", headerPDF.origin)
    .replace("{{destination}}", headerPDF.destination)
    .replace("{{date}}", new Date(headerPDF.date).toLocaleString())
    .replace("{{createdBy}}", headerPDF.createdBy)
    .replace("{{rows}}", rows);

  return html;
}