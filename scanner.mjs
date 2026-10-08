#!/usr/bin/env node
// CS2 Trade-Up Scanner
// Собирает данные о скинах (ByMykel/CSGO-API) и цены (Skinport public API),
// перебирает все контракты внутри одной коллекции и пишет public/data.json.
//
// Запуск:            node scanner.mjs
// Офлайн-тест:       node scanner.mjs --skins skins.json --crates crates.json --prices prices.json
// Node 18+ (нужен встроенный fetch), без зависимостей.

import { readFile, writeFile, mkdir } from "node:fs/promises";

const SKINS_URL =
  "https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/skins_not_grouped.json";
const CRATES_URL =
  "https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/crates.json";
const PRICES_URL = "https://api.skinport.com/v1/items?app_id=730&currency=USD&tradable=0";

const WEARS = [
  { name: "Factory New", short: "FN", lo: 0.0, hi: 0.07 },
  { name: "Minimal Wear", short: "MW", lo: 0.07, hi: 0.15 },
  { name: "Field-Tested", short: "FT", lo: 0.15, hi: 0.38 },
  { name: "Well-Worn", short: "WW", lo: 0.38, hi: 0.45 },
  { name: "Battle-Scarred", short: "BS", lo: 0.45, hi: 1.0 },
];

// Порядок редкостей. Ключ — нормализованное название.
const TIERS = ["consumer", "industrial", "mil-spec", "restricted", "classified", "covert"];
const TIER_RU = {
  consumer: "Ширпотреб",
  industrial: "Промышленное",
  "mil-spec": "Армейское (синие)",
  restricted: "Запрещённое (фиолетовые)",
  classified: "Засекреченное (розовые)",
  covert: "Тайное (красные)",
  knife: "Нож / перчатки",
};

// Ниже этого (EV / стоимость) контракт не попадает в выдачу — чтобы файл был лёгким.
const KEEP_RATIO = 0.85;

// ---------- utils ----------
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1]]);
    return acc;
  }, [])
);

async function loadJson(urlOrFile, opts = {}) {
  if (!/^https?:/.test(urlOrFile)) return JSON.parse(await readFile(urlOrFile, "utf8"));
  const res = await fetch(urlOrFile, opts);
  if (!res.ok) throw new Error(`${urlOrFile} -> HTTP ${res.status}`);
  return res.json();
}

function tierOf(skin) {
  const n = (skin.rarity?.name || "").toLowerCase();
  if (n.includes("consumer")) return "consumer";
  if (n.includes("industrial")) return "industrial";
  if (n.includes("mil-spec")) return "mil-spec";
  if (n.includes("restricted")) return "restricted";
  if (n.includes("classified")) return "classified";
  if (n.includes("covert")) return "covert";
  return null; // contraband, extraordinary и т.д.
}

const isGold = (skin) => {
  const c = (skin.category?.name || "").toLowerCase();
  const n = skin.market_hash_name || skin.name || "";
  return c.includes("knive") || c.includes("glove") || n.startsWith("★");
};

const WEAR_RE = / \((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$/;
const baseName = (skin) =>
  (skin.market_hash_name || skin.name || "")
    .replace(WEAR_RE, "")
    .replace("StatTrak™ ", "")
    .replace("Souvenir ", "")
    .trim();

function priceName(base, wear, st) {
  let n = base;
  if (st) n = base.startsWith("★ ") ? base.replace("★ ", "★ StatTrak™ ") : "StatTrak™ " + base;
  return wear ? `${n} (${wear})` : n;
}

const wearOf = (f) => WEARS.find((w) => f < w.hi || w.hi === 1) || WEARS[4];

// Нормализованная формула CS2: средняя "доля" флоата входов внутри их диапазонов,
// переложенная на диапазон выходного скина.
const outFloat = (normAvg, out) => out.min + normAvg * (out.max - out.min);

// ---------- main ----------
async function main() {
  const t0 = Date.now();
  const [skinsRaw, crates, pricesRaw] = await Promise.all([
    loadJson(args.skins || SKINS_URL),
    loadJson(args.crates || CRATES_URL),
    loadJson(args.prices || PRICES_URL, { headers: { "Accept-Encoding": "br" } }),
  ]);

  // Цены: market_hash_name -> { p: min listing, q: кол-во лотов }
  const prices = new Map();
  for (const it of pricesRaw) {
    const p = it.min_price ?? it.suggested_price;
    if (p) prices.set(it.market_hash_name, { p, q: it.quantity ?? 0 });
  }

  // Уникальные скины (по базовому имени, без износа/ST/фаз)
  const skins = new Map();
  for (const s of skinsRaw) {
    if (s.souvenir) continue;
    const b = baseName(s);
    if (!b || skins.has(b)) {
      if (skins.has(b) && s.stattrak) skins.get(b).st = true;
      continue;
    }
    skins.set(b, {
      base: b,
      tier: isGold(s) ? "gold" : tierOf(s),
      gold: isGold(s),
      min: Number(s.min_float ?? 0),
      max: Number(s.max_float ?? 1),
      st: !!s.stattrak,
      vanilla: !b.includes("|"),
      collections: (s.collections || []).map((c) => c.name),
      crates: (s.crates || []).map((c) => c.name),
    });
  }

  // Ножи/перчатки по кейсу
  const goldByCrate = new Map();
  for (const c of crates) {
    const rare = (c.contains_rare || []).map((r) => baseName(r)).filter(Boolean);
    if (rare.length) goldByCrate.set(c.name, [...new Set(rare)]);
  }

  // Коллекция -> tier -> [скины]
  const byCol = new Map();
  for (const s of skins.values()) {
    if (s.gold || !s.tier) continue;
    for (const col of s.collections) {
      if (!byCol.has(col)) byCol.set(col, {});
      (byCol.get(col)[s.tier] ||= []).push(s);
    }
  }

  // Цена выходного скина при заданном "нормализованном" флоате
  function outcomeAt(skin, norm, st) {
    if (skin.vanilla) {
      const pr = prices.get(priceName(skin.base, null, st));
      return pr ? { wear: "—", float: null, price: pr.p } : null;
    }
    const f = outFloat(norm, skin);
    const w = wearOf(f);
    const pr = prices.get(priceName(skin.base, w.name, st));
    return pr ? { wear: w.short, float: +f.toFixed(4), price: pr.p } : null;
  }

  const contracts = [];

  for (const [col, tiers] of byCol) {
    for (let ti = 0; ti < TIERS.length; ti++) {
      const tier = TIERS[ti];
      const inputs = tiers[tier];
      if (!inputs?.length) continue;

      let outSkins, count, outTier;
      if (tier === "covert") {
        // 5 красных -> нож/перчатки из кейса этой коллекции
        const crateNames = [...new Set(inputs.flatMap((s) => s.crates))];
        const gold = [...new Set(crateNames.flatMap((c) => goldByCrate.get(c) || []))];
        outSkins = gold.map((g) => skins.get(g)).filter(Boolean);
        count = 5;
        outTier = "knife";
      } else {
        outSkins = tiers[TIERS[ti + 1]] || [];
        count = 10;
        outTier = TIERS[ti + 1];
      }
      if (!outSkins.length) continue;

      for (const st of [false, true]) {
        if (st && !inputs.some((s) => s.st)) continue;
        for (const w of WEARS) {
          // Самый дешёвый вход в этом износе, которого хватает на контракт
          let best = null;
          for (const s of inputs) {
            if (st && !s.st) continue;
            const lo = Math.max(w.lo, s.min);
            const hi = Math.min(w.hi, s.max);
            if (lo >= hi) continue;
            const pr = prices.get(priceName(s.base, w.name, st));
            if (!pr || pr.q < count) continue;
            if (!best || pr.p < best.price)
              best = { skin: s, price: pr.p, qty: pr.q, fLo: lo, fHi: hi };
          }
          if (!best) continue;

          const s = best.skin;
          const range = s.max - s.min || 1;
          const normWorst = (best.fHi - s.min) / range; // худший флоат в этом износе
          const normBest = (best.fLo - s.min) / range; // лучший флоат в этом износе

          const outcomes = [];
          let complete = true;
          for (const o of outSkins) {
            if (st && !o.st) continue;
            const worst = outcomeAt(o, normWorst, st);
            const bestO = outcomeAt(o, normBest, st);
            if (!worst) {
              complete = false;
              break;
            }
            outcomes.push({
              name: o.base,
              wear: worst.wear,
              price: worst.price,
              wearBest: bestO?.wear ?? worst.wear,
              priceBest: bestO?.price ?? worst.price,
            });
          }
          if (!complete || !outcomes.length) continue;

          const cost = best.price * count;
          const ev = outcomes.reduce((a, o) => a + o.price, 0) / outcomes.length;
          const evBest = outcomes.reduce((a, o) => a + o.priceBest, 0) / outcomes.length;
          if (Math.max(ev, evBest) < cost * KEEP_RATIO) continue;

          contracts.push({
            col,
            tier,
            outTier,
            st,
            count,
            input: {
              name: priceName(s.base, w.name, st),
              price: best.price,
              qty: best.qty,
              fMin: +best.fLo.toFixed(4),
              fMax: +best.fHi.toFixed(4),
            },
            outcomes,
          });
        }
      }
    }
  }

  await mkdir("public", { recursive: true });
  const out = {
    updated: new Date().toISOString(),
    source: "Skinport (min listing), ByMykel/CSGO-API",
    tiers: TIER_RU,
    contracts,
  };
  await writeFile("public/data.json", JSON.stringify(out));
  console.log(
    `OK: ${contracts.length} контрактов, ${prices.size} цен, ${skins.size} скинов, ${((Date.now() - t0) / 1000).toFixed(1)}s`
  );
}

main().catch((e) => {
  console.error("Ошибка:", e.message);
  process.exit(1);
});
