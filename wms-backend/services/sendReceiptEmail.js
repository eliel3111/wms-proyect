import nodemailer from "nodemailer";


const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

/**
 * Envía la nota de recepción por correo con PDF adjunto
 */
export async function sendReceiptEmail({
  to,
  pdfBuffer,
  receiptCode,
  companyName,
}) {
  await transporter.sendMail({
    from: process.env.SMTP_FROM || '"WMS" <noreply@wms.com>',
    to,
    subject: `Nota de Recepción ${receiptCode}`,
    html: `
      <h3>Nota de Recepción</h3>
      <p>Se ha generado una nueva Nota de Recepción.</p>
      <p><strong>Código:</strong> ${receiptCode}</p>
      <p><strong>Empresa:</strong> ${companyName || ""}</p>
      <p>El PDF se encuentra adjunto a este correo.</p>
    `,
    attachments: [
      {
        filename: `Nota_Recepcion_${receiptCode}.pdf`,
        content: pdfBuffer,
        contentType: "application/pdf",
      },
    ],
  });
}


export async function sendTransferEmail({
  receiptEmail,
  pdfBuffer,
  transferCode,
  slug
}) {

  await transporter.sendMail({
    from: process.env.SMTP_FROM || '"WMS" <noreply@wms.com>',
    to: receiptEmail,
    subject: `Nota de Traslado ${transferCode}`,
    html: `
      <h3>Nota de Traslado</h3>
      <p>Se ha enviado un traslado de almacén.</p>
      <p><strong>Código:</strong> ${transferCode}</p>
      <p><strong>Empresa:</strong> ${slug || ""}</p>
      <p>El PDF se encuentra adjunto a este correo.</p>
    `,
    attachments: [
      {
        filename: `Nota_Traslado_${transferCode}.pdf`,
        content: pdfBuffer,
        contentType: "application/pdf",
      },
    ],
  });

}