import {
  ImageEncoder,
  LabelType,
  NiimbotBluetoothClient,
  PageColorType,
  type NiimbotBluetoothClientConnectOptions,
} from "@mmote/niimbluelib";
import JsBarcode from "jsbarcode";

// NIIMBOT B1: 203 dpi, cabezal de 384 puntos (48 mm), imprime de arriba hacia abajo.
// Etiqueta de 50 x 25 mm => 384 x 200 puntos (el ancho lo limita el cabezal).
const LABEL_WIDTH = 384;
const LABEL_HEIGHT = 200;
const QUIET_ZONE_MODULES = 10; // Code 128 exige 10 módulos en blanco a cada lado

let client: NiimbotBluetoothClient | null = null;

export function isWebBluetoothAvailable(): boolean {
  return typeof navigator !== "undefined" && "bluetooth" in navigator;
}

type AuthorizedDevice = NonNullable<NiimbotBluetoothClientConnectOptions["authorizedDevice"]>;
type BluetoothWithDevices = { getDevices?: () => Promise<AuthorizedDevice[]> };

async function findAuthorizedDevice(): Promise<AuthorizedDevice | undefined> {
  // getDevices() no existe en todos los Chrome; sin él se usa la lista normal.
  const bluetooth = (navigator as Navigator & { bluetooth?: BluetoothWithDevices }).bluetooth;
  if (typeof bluetooth?.getDevices !== "function") return undefined;
  try {
    // Solo devuelve equipos que el usuario ya eligió en este sitio, sea cual sea el modelo.
    const devices = await bluetooth.getDevices();
    return devices[0];
  } catch {
    return undefined;
  }
}

// Debe llamarse dentro del click del usuario: Chrome solo abre el selector
// de Bluetooth si la llamada viene directamente de un gesto.
async function getClient(): Promise<NiimbotBluetoothClient> {
  if (client?.isConnected()) return client;

  if (!isWebBluetoothAvailable()) {
    throw new Error(
      "Este navegador no soporta Bluetooth web. Use Google Chrome en la PDA."
    );
  }

  client = new NiimbotBluetoothClient();

  // Si Chrome ya autorizó una NIIMBOT en este equipo, se conecta sin mostrar la lista.
  const authorizedDevice = await findAuthorizedDevice();
  if (authorizedDevice) {
    try {
      await client.connect({ authorizedDevice });
      return client;
    } catch (error) {
      console.warn("NIIMBOT autorizada no disponible, se abre la lista:", error);
      client = new NiimbotBluetoothClient();
    }
  }

  await client.connect();
  return client;
}

export async function disconnectNiimbot() {
  if (client?.isConnected()) await client.disconnect();
  client = null;
}

function renderBarcode(code: string): HTMLCanvasElement {
  // Probamos el módulo más ancho que quepa, dejando la zona blanca de Code 128.
  for (const moduleWidth of [3, 2, 1]) {
    const canvas = document.createElement("canvas");
    JsBarcode(canvas, code, {
      format: "CODE128",
      width: moduleWidth,
      height: 80,
      margin: QUIET_ZONE_MODULES * moduleWidth,
      displayValue: true,
      font: "monospace",
      fontOptions: "bold",
      fontSize: 24,
      textMargin: 2,
      background: "#ffffff",
      lineColor: "#000000",
    });
    if (canvas.width <= LABEL_WIDTH) return canvas;
  }
  throw new Error(
    `El código "${code}" es demasiado largo para una etiqueta de 50 mm.`
  );
}

function wrapLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    current = word;
    if (lines.length === maxLines) break;
  }
  if (current && lines.length < maxLines) lines.push(current);

  if (lines.length === maxLines && words.join(" ") !== lines.join(" ")) {
    let last = lines[maxLines - 1];
    while (last.length > 1 && ctx.measureText(`${last}...`).width > maxWidth) {
      last = last.slice(0, -1);
    }
    lines[maxLines - 1] = `${last.trim()}...`;
  }
  return lines;
}

export function renderLabel(title: string, code: string): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = LABEL_WIDTH;
  canvas.height = LABEL_HEIGHT;

  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, LABEL_WIDTH, LABEL_HEIGHT);
  ctx.fillStyle = "#000000";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";

  let y = 8;
  if (title.trim()) {
    ctx.font = "bold 22px sans-serif";
    for (const line of wrapLines(ctx, title.trim(), LABEL_WIDTH - 24, 2)) {
      ctx.fillText(line, LABEL_WIDTH / 2, y);
      y += 26;
    }
  }

  const barcode = renderBarcode(code);
  const barcodeY = Math.max(y + 4, LABEL_HEIGHT - barcode.height - 4);
  ctx.drawImage(barcode, Math.floor((LABEL_WIDTH - barcode.width) / 2), barcodeY);

  return canvas;
}

export async function printNiimbotLabel(
  title: string,
  code: string,
  quantity: number = 1
) {
  // Se conecta primero para no perder el gesto del usuario.
  const printer = await getClient();
  const image = ImageEncoder.encodeCanvas(
    renderLabel(title, code),
    PageColorType.SingleColor,
    "top"
  );

  const task = printer.protocol.newPrintTask(
    printer.getPrintTaskType() ?? "B1",
    {
      totalPages: quantity,
      labelType: LabelType.WithGaps,
      density: 3,
    }
  );

  try {
    await task.printInit();
    await task.printPage(image, quantity);
    await task.waitForFinished();
  } finally {
    await printer.protocol.printEnd();
  }
}
