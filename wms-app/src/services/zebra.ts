declare global {
  interface Window {
    BrowserPrint: {
      getDefaultDevice: (
        type: string,
        success: (device: ZebraPrinter) => void,
        error: (err: any) => void
      ) => void;
    };
  }

  interface ZebraPrinter {
    send: (
      data: string,
      success?: () => void,
      error?: (err: any) => void
    ) => void;
  }
}

export function getPrinter(): Promise<ZebraPrinter> {
  return new Promise((resolve, reject) => {
    if (!window.BrowserPrint) {
      reject(new Error("BrowserPrint no disponible"));
      return;
    }

    window.BrowserPrint.getDefaultDevice(
      "printer",
      (printer: ZebraPrinter) => {
        if (!printer) {
          reject(new Error("No hay impresora configurada"));
        } else {
          resolve(printer);
        }
      },
      (error) => reject(error)
    );
  });
}

export function sendZpl(
  printer: ZebraPrinter,
  zpl: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    printer.send(zpl, resolve, reject);
  });
}