/* Закладка «CS2 сканер». Работает на steamcommunity.com, открывается кнопками с сайта сканера.
   #cs2scan=[...]  — собрать реальные цены Steam (₴) и отправить их на сайт.
       строка "Name (Wear)"                     → обычная цена (самый дешёвый лот, медиана)
       объект {key, name, maxFloat}             → средняя цена 10 самых дешёвых лотов с флоатом ≤ maxFloat
   #cs2watch=[{name, maxFloat, maxPrice}]       → слежка: лот с флоатом ≤ maxFloat дешевле maxPrice → звук + уведомление.
   Флоат и цены берутся прямо из новой торговой площадки Steam (она сама фильтрует лоты по флоату). */
(async () => {
  const SITE = "https://lychov.github.io";
  if (!location.hostname.endsWith("steamcommunity.com")) { alert("Открой эту закладку на сайте Steam (кнопкой со сканера)"); return; }
  const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
  const parseUAH = (s) => (s ? parseFloat(s.replace(/[^\d,.\s]/g, "").replace(/\s/g, "").replace(",", ".")) : null);
  const box = document.createElement("div");
  box.style.cssText = "position:fixed;z-index:99999;top:16px;right:16px;background:#171a21;color:#e8eaef;padding:14px 18px;border-radius:10px;font:14px/1.45 system-ui;box-shadow:0 6px 30px #0008;width:360px;max-height:80vh;overflow:auto";
  document.body.append(box);

  // Фильтр по флоату в адресе Steam: protobuf {1: 2 (свойство «флоат»), 2: min (float32), 3: max (float32)} в base64
  const floatFilter = (min, max) => {
    const b = new Uint8Array(12), dv = new DataView(b.buffer);
    b[0] = 0x08; b[1] = 0x02; b[2] = 0x15; dv.setFloat32(3, min, true); b[7] = 0x1d; dv.setFloat32(8, max, true);
    return btoa(String.fromCharCode(...b));
  };
  // Лоты предмета (самые дешёвые сначала) с флоатом и паттерном — разбираем данные, которые Steam встраивает в страницу
  const listings = async (name, minF, maxF) => {
    let url = "/market/listings/730/" + encodeURIComponent(name);
    if (maxF != null) url += "?appid=730&assetproperty=" + encodeURIComponent(floatFilter(minF || 0, maxF));
    const r = await fetch(url);
    if (r.status === 429) return { rateLimited: true, list: [] };
    const doc = new DOMParser().parseFromString(await r.text(), "text/html");
    const sc = [...doc.querySelectorAll("script")].map((s) => s.textContent).find((t) => t.includes('"loaderData"'));
    if (!sc) return { list: [], pageUrl: r.url };
    const found = [], seen = new Set();
    const walk = (o, d = 0) => {
      if (d > 40) return;
      if (typeof o === "string") {
        const t = o.trim();
        if ((t[0] === "{" || t[0] === "[") && t.length > 50) { try { walk(JSON.parse(t), d + 1); } catch {} }
        return;
      }
      if (!o || typeof o !== "object") return;
      if (o.listingid && o.asset && !seen.has(o.listingid)) { seen.add(o.listingid); found.push(o); }
      for (const v of Object.values(o)) walk(v, d + 1);
    };
    try { walk(JSON.parse(sc.trim().replace(/^[^{]*/, "").replace(/;?\s*$/, ""))); } catch {}
    const list = found.map((l) => {
      const props = l.asset.asset_properties || [];
      return {
        id: l.listingid,
        price: ((l.unPricePerUnit || 0) + (l.unFeePerUnit || 0)) / 100,
        float: props.find((p) => p.propertyid === 2)?.float_value ?? null,
        seed: props.find((p) => p.propertyid === 1)?.int_value ?? null,
      };
    }).filter((x) => x.price > 0).sort((a, b) => a.price - b.price);
    return { list, pageUrl: r.url };
  };

  const scan = location.hash.match(/cs2scan=([^&]+)/);
  const watch = location.hash.match(/cs2watch=([^&]+)/);
  if (!scan && !watch) { box.textContent = "Сначала нажми кнопку на сайте сканера («Обновить цены» или «Слежка»)."; return; }

  // ---------- Сбор цен ----------
  if (scan) {
    const items = JSON.parse(decodeURIComponent(scan[1]));
    const out = {};
    let i = 0;
    for (const it of items) {
      i++;
      box.textContent = `Цены Steam: ${i} / ${items.length}… Не закрывай вкладку.`;
      for (let a = 0; a < 4; a++) {
        if (typeof it === "string") {
          const r = await fetch("/market/priceoverview/?appid=730&currency=18&market_hash_name=" + encodeURIComponent(it));
          if (r.status === 429) { box.textContent = "Steam просит подождать минуту…"; await sleep(60000); continue; }
          let j = null; try { j = await r.json(); } catch {}
          out[it] = j && j.success
            ? { low: parseUAH(j.lowest_price), med: parseUAH(j.median_price), vol: j.volume ? parseInt(j.volume.replace(/\D/g, "")) : 0, at: Date.now() }
            : { none: true, at: Date.now() };
        } else {
          const res = await listings(it.name, 0, it.maxFloat);
          if (res.rateLimited) { box.textContent = "Steam просит подождать минуту…"; await sleep(60000); continue; }
          const top = res.list.slice(0, 10);
          out[it.key] = top.length
            ? { low: top.reduce((s, x) => s + x.price, 0) / top.length, first: top[0].price, cnt: res.list.length, avgFloat: top.reduce((s, x) => s + (x.float || 0), 0) / top.length, at: Date.now() }
            : { none: true, at: Date.now() };
        }
        break;
      }
      if (i % 10 === 0 && window.opener) window.opener.postMessage({ cs2scan: out }, SITE);
      await sleep(3200);
    }
    if (window.opener) window.opener.postMessage({ cs2scan: out, done: true }, SITE);
    box.textContent = `Готово: ${items.length} цен отправлено на сайт. Вкладку можно закрыть.`;
    return;
  }

  // ---------- Слежка ----------
  const items = JSON.parse(decodeURIComponent(watch[1])); // [{name, maxFloat, maxPrice}]
  const seen = new Set();
  const found = [];
  let checks = 0, lastNote = "";
  if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();

  const beep = () => {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.25, 0.5].forEach((t) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = 880; g.gain.value = 0.15; o.connect(g); g.connect(ctx.destination);
        o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.15);
      });
    } catch {}
  };

  const draw = () => {
    box.innerHTML = "";
    const h = document.createElement("div");
    h.innerHTML = `<b>👁 Слежка за флоатом</b> — проверок: ${checks}<br><span style="color:#8b93a3">${lastNote}</span>`;
    box.append(h);
    for (const it of items) {
      const d = document.createElement("div");
      d.style.cssText = "margin-top:8px;padding-top:8px;border-top:1px solid #262b35";
      d.textContent = `${it.name} — флоат ≤ ${it.maxFloat}, цена ≤ ${it.maxPrice} ₴` + (it.cheapest ? ` · сейчас самый дешёвый: ${it.cheapest} ₴` : "");
      box.append(d);
    }
    for (const f of found.slice(-20).reverse()) {
      const a = document.createElement("a");
      a.href = f.url; a.target = "_blank";
      a.style.cssText = "display:block;margin-top:8px;padding:8px;border-radius:8px;background:#1f3a2c;color:#3ecf8e;text-decoration:none";
      a.textContent = `🔥 ${f.name}: флоат ${f.float.toFixed(5)}, паттерн ${f.seed}, ${f.price} ₴ — открыть`;
      box.append(a);
    }
  };

  const checkItem = async (it) => {
    const res = await listings(it.name, 0, it.maxFloat);
    if (res.rateLimited) { lastNote = "Steam попросил паузу, жду…"; await sleep(90000); return; }
    it.cheapest = res.list[0]?.price ?? null;
    for (const l of res.list) {
      if (l.price > it.maxPrice) break;
      if (seen.has(l.id)) continue;
      seen.add(l.id);
      found.push({ name: it.name, float: l.float ?? 0, seed: l.seed, price: l.price, url: res.pageUrl });
      beep();
      try { new Notification("🔥 Нашёл лот для крафта", { body: `${it.name}\nфлоат ${(l.float ?? 0).toFixed(5)} за ${l.price} ₴` }); } catch {}
      document.title = "🔥 НАЙДЕН ЛОТ — " + document.title.replace(/^🔥.*? — /, "");
    }
  };

  for (;;) {
    for (const it of items) {
      try { await checkItem(it); } catch (e) { lastNote = "Ошибка: " + e.message; }
      checks++;
      draw();
      await sleep(5000);
    }
    lastNote = "Следующая проверка через 2 мин. Вкладку не закрывай.";
    draw();
    await sleep(120000);
  }
})();
