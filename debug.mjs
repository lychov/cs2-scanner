// Временный скрипт: проверяем, отдаёт ли Steam цены торговой площадки с серверов GitHub.
import { mkdir, writeFile } from "node:fs/promises";

await mkdir("debug-out", { recursive: true });
const report = { pages: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let first = null;
for (let i = 0; i < 6; i++) {
  const url = `https://steamcommunity.com/market/search/render/?appid=730&norender=1&count=100&start=${i * 100}&sort_column=name&sort_dir=asc`;
  const t = Date.now();
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const text = await res.text();
    let j = null;
    try { j = JSON.parse(text); } catch {}
    report.pages.push({ i, status: res.status, ms: Date.now() - t, total: j?.total_count, got: j?.results?.length, raw: j ? undefined : text.slice(0, 200) });
    if (j?.results && !first) first = j.results.slice(0, 3);
  } catch (e) {
    report.pages.push({ i, error: String(e) });
  }
  await sleep(3000);
}
// Одна цена в гривнах через priceoverview (currency=18 — UAH)
try {
  const r = await fetch("https://steamcommunity.com/market/priceoverview/?appid=730&currency=18&market_hash_name=" + encodeURIComponent("P90 | Asiimov (Field-Tested)"));
  report.priceoverview = { status: r.status, body: (await r.text()).slice(0, 300) };
} catch (e) { report.priceoverview = { error: String(e) }; }
report.sample = first;
await writeFile("debug-out/report.json", JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1));
