// Временный скрипт: ищем доступный источник цен Steam.
import { mkdir, writeFile } from "node:fs/promises";

await mkdir("debug-out", { recursive: true });
const report = {};
const tries = {
  csgotrader_steam: "https://prices.csgotrader.app/latest/steam.json",
  csgotrader_v6: "https://prices.csgotrader.app/latest/prices_v6.json",
};
for (const [k, url] of Object.entries(tries)) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const text = await res.text();
    report[k] = { status: res.status, bytes: text.length };
    try {
      const j = JSON.parse(text);
      const keys = Object.keys(j);
      report[k].count = keys.length;
      const want = ["P90 | Asiimov (Field-Tested)", "G3SG1 | Dream Glade (Well-Worn)", "SSG 08 | Dezastre (Well-Worn)", "★ Butterfly Knife | Fade (Factory New)"];
      report[k].sample = Object.fromEntries(want.map((n) => [n, j[n]]));
      report[k].firstKey = keys[0];
      report[k].first = j[keys[0]];
    } catch {
      report[k].head = text.slice(0, 300);
    }
  } catch (e) {
    report[k] = { error: String(e) };
  }
}
await writeFile("debug-out/report.json", JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1));
