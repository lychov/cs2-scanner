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
const COLLECTIONS_URL =
  "https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/collections.json";
// Цены продаж в Steam (средние за 24ч/7д/30д/90д, $) — фид расширения CSGO Trader.
// Steam сам не пускает запросы с серверов GitHub, поэтому берём отсюда.
const STEAM_URL = "https://prices.csgotrader.app/latest/steam.json";
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
  const [skinsRaw, crates, collectionsRaw, pricesRaw, steamRaw] = await Promise.all([
    loadJson(args.skins || SKINS_URL),
    loadJson(args.crates || CRATES_URL),
    loadJson(args.collections || COLLECTIONS_URL),
    loadJson(args.prices || PRICES_URL, { headers: { "Accept-Encoding": "br" } }),
    loadJson(args.steam || STEAM_URL).catch((e) => {
      console.error("Steam-цены недоступны:", e.message);
      return {};
    }),
  ]);

  // Steam: покупка — по большей из средних за 24ч/7д (осторожно), только если скин продавался за неделю.
  // Продажа — по меньшей из 24ч/7д, для редких вещей (ножи) допускаем среднюю за 30д.
  const steamBuy = (name) => {
    const r = steamRaw[name];
    if (!r) return null;
    const recent = [r.last_24h, r.last_7d].filter((x) => x > 0);
    return recent.length ? Math.max(...recent) : null;
  };
  const steamSell = (name) => {
    const r = steamRaw[name];
    if (!r) return null;
    const recent = [r.last_24h, r.last_7d].filter((x) => x > 0);
    if (recent.length) return Math.min(...recent);
    return r.last_30d > 0 ? r.last_30d : null;
  };

  // Цены Skinport: min_price — самый дешёвый лот (бывает null), suggested_price — оценка рынка.
  // Для одного имени может быть несколько записей (фазы Doppler) — берём самую дешёвую, это осторожнее.
  const prices = new Map();
  for (const it of pricesRaw) {
    const min = it.min_price ?? null;
    const sug = it.suggested_price ?? null;
    if (min == null && sug == null) continue;
    const cur = prices.get(it.market_hash_name);
    const rec = { min, sug, q: it.quantity ?? 0 };
    const val = (r) => Math.min(r.min ?? Infinity, r.sug ?? Infinity);
    if (!cur || val(rec) < val(cur)) prices.set(it.market_hash_name, rec);
  }
  // Цена покупки входа: если лотов хватает — по минимальному лоту, иначе по рыночной оценке.
  const buyPrice = (name, count) => {
    const r = prices.get(name);
    if (!r) return null;
    // Берём только то, что реально можно купить в нужном количестве
    if (r.q < count || r.min == null) return null;
    return { p: r.min, q: r.q };
  };
  // Цена продажи выхода: осторожно — меньшая из минимального лота и оценки.
  const sellPrice = (name) => {
    const r = prices.get(name);
    if (!r) return null;
    const p = Math.min(r.min ?? Infinity, r.sug ?? Infinity);
    return Number.isFinite(p) && p > 0 ? p : null;
  };

  // Коллекции и кейсы скинов (в файле скинов их нет — берём из collections.json)
  const colOf = new Map(); // base name -> Set(collection)
  const crateOf = new Map(); // base name -> Set(crate)
  for (const col of collectionsRaw) {
    const crateNames = (col.crates || []).map((c) => c.name);
    for (const it of col.contains || []) {
      const b = (it.name || "").replace(WEAR_RE, "").trim();
      if (!colOf.has(b)) colOf.set(b, new Set());
      colOf.get(b).add(col.name);
      if (!crateOf.has(b)) crateOf.set(b, new Set());
      crateNames.forEach((c) => crateOf.get(b).add(c));
    }
  }

  // Уникальные скины (по базовому имени, без износа/ST/фаз)
  const skins = new Map();
  for (const s of skinsRaw) {
    if (s.souvenir) continue;
    const b = baseName(s);
    if (!b || skins.has(b)) {
      if (skins.has(b) && s.stattrak) skins.get(b).st = true;
      if (skins.has(b) && !skins.get(b).img && s.image) skins.get(b).img = s.image;
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
      img: s.image || null,
      collections: [...(colOf.get(b) || [])],
      crates: [...(crateOf.get(b) || [])],
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
    let name, wear, float = null;
    if (skin.vanilla) {
      name = priceName(skin.base, null, st);
      wear = "—";
    } else {
      const f = outFloat(norm, skin);
      const w = wearOf(f);
      name = priceName(skin.base, w.name, st);
      wear = w.short;
      float = +f.toFixed(4);
    }
    const sp = sellPrice(name);
    const stp = steamSell(name);
    return sp || stp ? { wear, float, price: sp, steam: stp } : null;
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
          // Самый дешёвый вход в этом износе — отдельно по Skinport и по Steam
          let bestSp = null, bestSt = null;
          for (const s of inputs) {
            if (st && !s.st) continue;
            const lo = Math.max(w.lo, s.min);
            const hi = Math.min(w.hi, s.max);
            if (lo >= hi) continue;
            const name = priceName(s.base, w.name, st);
            const sp = buyPrice(name, count);
            const stp = steamBuy(name);
            const cand = { skin: s, name, sp, stp, fLo: lo, fHi: hi };
            if (sp && (!bestSp || sp.p < bestSp.sp.p)) bestSp = cand;
            if (stp && (!bestSt || stp < bestSt.stp)) bestSt = cand;
          }
          const chosen = [bestSp, bestSt].filter(Boolean);
          if (chosen.length === 2 && chosen[0].skin === chosen[1].skin) chosen.pop();

          for (const best of chosen) {
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
                steam: worst.steam,
                wearBest: bestO?.wear ?? worst.wear,
                priceBest: bestO?.price ?? worst.price,
                steamBest: bestO?.steam ?? worst.steam,
              });
            }
            if (!complete || !outcomes.length) continue;

            // Оставляем, если хоть в одной комбинации «где купил / где продал» контракт близок к нулю или в плюсе
            const avg = (k) =>
              outcomes.every((o) => o[k] > 0) ? outcomes.reduce((a, o) => a + o[k], 0) / outcomes.length : 0;
            const evMax = Math.max(avg("price"), avg("priceBest"), avg("steam") / 1.15, avg("steamBest") / 1.15);
            const costs = [best.sp?.p, best.stp].filter((x) => x > 0).map((x) => x * count);
            if (!costs.length || evMax < Math.min(...costs) * KEEP_RATIO) continue;

            contracts.push({
              col,
              tier,
              outTier,
              st,
              count,
              input: {
                base: s.base,
                name: best.name,
                price: best.sp?.p ?? null,
                qty: best.sp?.q ?? 0,
                steam: best.stp ?? null,
                fMin: +best.fLo.toFixed(4),
                fMax: +best.fHi.toFixed(4),
              },
              outcomes,
            });
          }
        }
      }
    }
  }

  await mkdir("public", { recursive: true });
  // Картинки только для скинов, которые реально есть в выдаче (ключ — базовое имя)
  const images = {};
  const addImg = (base) => {
    const sk = skins.get(base);
    if (sk?.img) images[base] = sk.img;
  };
  for (const c of contracts) {
    addImg(c.input.base);
    c.outcomes.forEach((o) => addImg(o.name));
  }

  const out = {
    updated: new Date().toISOString(),
    source: "Skinport (min listing), Steam (CSGO Trader feed), ByMykel/CSGO-API",
    tiers: TIER_RU,
    stats: {
      prices: prices.size,
      steamPrices: Object.keys(steamRaw).length,
      skins: skins.size,
      collections: byCol.size,
      cratesWithGold: goldByCrate.size,
      byTier: contracts.reduce((a, c) => ((a[c.tier] = (a[c.tier] || 0) + 1), a), {}),
    },
    images,
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
