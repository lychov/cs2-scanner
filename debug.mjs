// Временный скрипт: сохраняет образцы исходных данных, чтобы проверить их формат.
import { mkdir, writeFile } from "node:fs/promises";

const SRC = {
  skins: "https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/skins_not_grouped.json",
  crates: "https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/crates.json",
  collections: "https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/collections.json",
  prices: "https://api.skinport.com/v1/items?app_id=730&currency=USD&tradable=0",
};

await mkdir("debug-out", { recursive: true });
const report = {};
for (const [k, url] of Object.entries(SRC)) {
  try {
    const res = await fetch(url, { headers: k === "prices" ? { "Accept-Encoding": "br" } : {} });
    const text = await res.text();
    report[k] = { status: res.status, bytes: text.length };
    let data;
    try { data = JSON.parse(text); } catch { report[k].notJson = text.slice(0, 500); continue; }
    const arr = Array.isArray(data) ? data : Object.values(data);
    report[k].isArray = Array.isArray(data);
    report[k].count = arr.length;
    const pick = arr.filter((x) => JSON.stringify(x).includes("Asiimov")).slice(0, 3);
    await writeFile(`debug-out/${k}-sample.json`, JSON.stringify({ first: arr.slice(0, 2), asiimov: pick }, null, 1));
  } catch (e) {
    report[k] = { error: String(e) };
  }
}
await writeFile("debug-out/report.json", JSON.stringify(report, null, 1));
console.log(report);
