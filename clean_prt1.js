const fs = require("fs");

const INPUT = "citrus_raw.csv";
const OUTPUT = "citrus_clean.csv";

// leer archivo
let input = fs.readFileSync(INPUT, "utf8");

// 🔥 limpiar \r (Windows / OneDrive)
input = input.replace(/\r/g, "");

// dividir líneas
const lines = input.split("\n");

let fixed = [];
let current = "";
let insideQuotes = false;

let errorLines = 0;
let totalLines = 0;

for (let i = 0; i < lines.length; i++) {
  let line = lines[i];

  const quoteCount = (line.match(/"/g) || []).length;

  // detectar apertura/cierre de comillas
  if (quoteCount % 2 !== 0) {
    insideQuotes = !insideQuotes;
  }

  // construir fila
  if (current === "") {
    current = line;
  } else {
    current += " " + line.trim();
  }

  // cuando la fila está completa
  if (!insideQuotes) {
    totalLines++;

    const cols = current.split(",");

    // 🔥 VALIDACIÓN FUERTE
    const isCorrupt =
      cols.length < 10 ||        // muy pocas columnas
      current.includes("�") ||   // caracter corrupto
      current.trim() === "";     // línea vacía

    if (isCorrupt) {
      console.log(`❌ Línea eliminada (${i}):`, current);
      errorLines++;
    } else {
      fixed.push(current);
    }

    current = "";
  }
}

// última línea (por si quedó abierta)
if (current) {
  const cols = current.split(",");

  if (cols.length >= 10 && !current.includes("�")) {
    fixed.push(current);
  } else {
    console.log(`❌ Última línea eliminada:`, current);
    errorLines++;
  }
}

// guardar archivo limpio
fs.writeFileSync(OUTPUT, fixed.join("\n"), "utf8");

// resumen
console.log("\n🔥 RESULTADO FINAL");
console.log("Total líneas procesadas:", totalLines);
console.log("Líneas limpias:", fixed.length);
console.log("Líneas eliminadas:", errorLines);
console.log("Archivo generado:", OUTPUT);