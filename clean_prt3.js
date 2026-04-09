const fs = require("fs");

const input = fs.readFileSync("citrus_fixed.csv", "utf8");

const lines = input.split("\n");

let fixed = [];
let current = "";
let insideQuotes = false;

for (let line of lines) {
   
  // contar comillas en la línea
  const quoteCount = (line.match(/"/g) || []).length;
 console.log(quoteCount);
  // si hay número impar de comillas → estamos dentro de texto multilínea
  if (quoteCount % 2 !== 0) {
    insideQuotes = !insideQuotes;
  }

  // agregar línea
  if (current === "") {
    current = line;
  } else {
    current += " " + line.trim();
  }

  // si ya cerramos comillas → fila completa
  if (!insideQuotes) {
    fixed.push(current);
    current = "";
  }
}

// guardar
fs.writeFileSync("citrus.csv", fixed.join("\n"));

console.log("🔥 CSV 100% limpio");