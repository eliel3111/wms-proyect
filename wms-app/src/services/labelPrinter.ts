import { getPrinter, sendZpl } from "./zebra.ts";

import { printNiimbotLabel } from "./niimbot.ts";

export type PrinterKind = "zebra" | "niimbot";

const STORAGE_KEY = "sidial.labelPrinter";

// Cada equipo recuerda su impresora; no se comparte la preferencia entre PDA/PC.
export function getPrinterKind(): PrinterKind {
    try {
        return localStorage.getItem(STORAGE_KEY) === "niimbot" ? "niimbot" : "zebra";
    } catch {
        return "zebra";
    }
}

export function setPrinterKind(kind: PrinterKind): void {
    try {
        localStorage.setItem(STORAGE_KEY, kind);
    } catch {
        // Si el almacenamiento está deshabilitado, aún se puede imprimir.
    }
}

function getBarcodeX(sku: string): number {
    const labelWidth = 400;
    let x;

    if (sku.length <= 10) {
        const moduleWidth = 4;
        const estimatedWidth = sku.length * 7.5 * moduleWidth;
        x = (labelWidth - estimatedWidth) / 2;
    } else {
        const moduleWidth = 4;
        const estimatedWidth = sku.length * 6.5 * moduleWidth;
        x = (labelWidth - estimatedWidth) / 2;
    }

    return Math.max(Math.floor(x), 10);
}

function clean(text: string): string {
    return text.replace(/\^/g, "").replace(/~/g, "").replace(/\n/g, " ");
}

function cleanAndFormat(text: string): string {
    let cleaned = text
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\^|~/g, "")
        .toUpperCase()
        .trim();

    if (cleaned.length > 55) {
        cleaned = cleaned.slice(0, 52) + "...";
    }
    if (cleaned.length <= 20) return cleaned;

    const line1 = cleaned.slice(0, 18).trim();
    const line2 = cleaned.slice(20).trim();
    return `${line1}\n${line2}`;
}

function limitLabelText(i: string, d: string, maxChars = 48): string {
    const text = `${i} / ${d}`.trim();
    if (text.length <= maxChars) return text;
    return text.substring(0, maxChars - 3).trim() + "...";
}

// Misma plantilla ZPL que usa actualmente Barcode-main.tsx.
function buildOriginalZpl(
    description: string,
    sku: string,
    erp_name: string,
    erp_sku: string,
    qty: number
): string {
    const d = cleanAndFormat(description);
    const i = cleanAndFormat(erp_name);
    const p = cleanAndFormat(erp_sku);
    const s = clean(sku);
    const barcodeModuleWidth = s.length >= 15 ? 1 : 2;
    const x = s.length >= 15 ? 15 : getBarcodeX(s);
    const labelText = limitLabelText(i, d);

    return `
^XA

^PW400
^LL203
^LH0,0

^CF0,26

^FO0,17
^FB400,2,0,C,0
^FD${labelText}^FS

^BY${barcodeModuleWidth},2,50
^FO${x},72
^BCN,50,Y,N,N
^FD${s}^FS

^FO15,167
^A0N,21,23
^FDP/N ${p}^FS

^PQ${qty}
^XZ
`;
}

// Invocar directamente desde el click, sin un await de red anterior.
export async function printLabel(
    description: string,
    code: string,
    erp_name = "",
    erp_sku = "",
    qty = 1,
    kind: PrinterKind = getPrinterKind()
): Promise<void> {
    if (kind === "niimbot") {
        // B1: 50 × 25 mm; en Bluetooth se imprime el nombre + Code128.
        const title = [erp_name, description].filter(Boolean).join(" / ");
        await printNiimbotLabel(title, code, qty);
        return;
    }

    const printer = await getPrinter();
    await sendZpl(printer, buildOriginalZpl(description, code, erp_name, erp_sku, qty));
}
