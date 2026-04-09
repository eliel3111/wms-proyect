const fs = require("fs");

let input = fs.readFileSync("citrus_raw.csv", "utf8");

// 🔥 FIX WINDOWS
input = input.replace(/\r/g, "");

const lines = input.split("\n");

let fixed = [];
let current = "";
let insideQuotes = false;

for (let line of lines) {
  const quoteCount = (line.match(/"/g) || []).length;

  if (quoteCount % 2 !== 0) {
    insideQuotes = !insideQuotes;
  }

  if (current === "") {
    current = line;
  } else {
    current += " " + line.trim();
  }

  if (!insideQuotes) {
    fixed.push(current);
    current = "";
  }
}

// 🔥 IMPORTANTE (evita perder última fila)
if (current) {
  fixed.push(current);
}

fs.writeFileSync("citrus_fixed.csv", fixed.join("\n"));

console.log("🔥 CSV limpio listo");