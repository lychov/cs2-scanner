/* Закладка «CS2 сканер». Работает на steamcommunity.com, открывается кнопками с сайта сканера.
   #cs2scan=[...]  — собрать реальные цены Steam (₴) и отправить их на сайт.
   #cs2watch=[...] — следить за новыми лотами: флоат ≤ порога и цена ≤ лимита → звук + уведомление. */
(async () => {
  const SITE = "https://lychov.github.io";
  if (!location.hostname.endsWith("steamcommunity.com")) { alert("Открой эту закладку на сайте Steam (кнопкой со сканера)"); return; }
  const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
  const parseUAH = (s) => (s ? parseFloat(s.replace(/[^\d,.\s]/g, "").replace(/\s/g, "").replace(",", ".")) : null);
  const box = document.createElement("div");
  box.style.cssText = "position:fixed;z-index:99999;top:16px;right:16px;background:#171a21;color:#e8eaef;padding:14px 18px;border-radius:10px;font:14px/1.45 system-ui;box-shadow:0 6px 30px #0008;width:360px;max-height:80vh;overflow:auto";
  document.body.append(box);

  const scan = location.hash.match(/cs2scan=([^&]+)/);
  const watch = location.hash.match(/cs2watch=([^&]+)/);
  if (!scan && !watch) { box.textContent = "Сначала нажми кнопку на сайте сканера («Обновить цены» или «Слежка»)."; return; }

  // ---------- Сбор цен ----------
  if (scan) {
    const names = JSON.parse(decodeURIComponent(scan[1]));
    const out = {};
    let i = 0;
    for (const n of names) {
      i++;
      box.textContent = `Цены Steam: ${i} / ${names.length}… Не закрывай вкладку.`;
      for (let a = 0; a < 4; a++) {
        const r = await fetch("/market/priceoverview/?appid=730&currency=18&market_hash_name=" + encodeURIComponent(n));
        if (r.status === 429) { box.textContent = "Steam просит подождать минуту…"; await sleep(60000); continue; }
        let j = null; try { j = await r.json(); } catch {}
        out[n] = j && j.success
          ? { low: parseUAH(j.lowest_price), med: parseUAH(j.median_price), vol: j.volume ? parseInt(j.volume.replace(/\D/g, "")) : 0, at: Date.now() }
          : { none: true, at: Date.now() };
        break;
      }
      if (i % 10 === 0 && window.opener) window.opener.postMessage({ cs2scan: out }, SITE);
      await sleep(3200);
    }
    if (window.opener) window.opener.postMessage({ cs2scan: out, done: true }, SITE);
    box.textContent = `Готово: ${names.length} цен отправлено на сайт. Вкладку можно закрыть.`;
    return;
  }

  // ---------- Слежка ----------
  const items = JSON.parse(decodeURIComponent(watch[1])); // [{name, maxFloat, maxPrice}]
  const seen = new Set();
  const found = [];
  let checks = 0, lastNote = "", floatMode = "?";
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

  // Флоат из данных Steam: ищем float_value в свойствах предмета или «износ: 0.xxx» в описании
  const floatFromAsset = (asset) => {
    if (!asset) return null;
    for (const p of asset.asset_properties || []) {
      if (p.float_value != null) return parseFloat(p.float_value);
    }
    const txt = JSON.stringify(asset.descriptions || []);
    const m = txt.match(/(?:Wear Rating|Float|износ[а-я]*|Степень износа)[^0-9]{0,20}(0\.\d{3,})/i);
    return m ? parseFloat(m[1]) : null;
  };
  // Запасной путь: спросить флоат у CSFloat по ссылке осмотра
  const floatFromInspect = async (link) => {
    try {
      const r = await fetch("https://api.csfloat.com/?url=" + encodeURIComponent(link));
      const j = await r.json();
      return j?.iteminfo?.floatvalue ?? null;
    } catch { return null; }
  };

  const draw = () => {
    box.innerHTML = "";
    const h = document.createElement("div");
    h.innerHTML = `<b>👁 Слежка за флоатом</b> — проверок: ${checks}<br><span style="color:#8b93a3">Флоат берётся: ${floatMode}. ${lastNote}</span>`;
    box.append(h);
    for (const it of items) {
      const d = document.createElement("div");
      d.style.cssText = "margin-top:8px;padding-top:8px;border-top:1px solid #262b35";
      d.textContent = `${it.name} — флоат ≤ ${it.maxFloat}, цена ≤ ${it.maxPrice} ₴`;
      box.append(d);
    }
    for (const f of found.slice(-20).reverse()) {
      const a = document.createElement("a");
      a.href = f.url; a.target = "_blank";
      a.style.cssText = "display:block;margin-top:8px;padding:8px;border-radius:8px;background:#1f3a2c;color:#3ecf8e;text-decoration:none";
      a.textContent = `🔥 ${f.name}: флоат ${f.float.toFixed(4)} за ${f.price} ₴ — открыть`;
      box.append(a);
    }
  };

  const checkItem = async (it) => {
    const url = `/market/listings/730/${encodeURIComponent(it.name)}/render/?query=&start=0&count=50&country=UA&language=russian&currency=18`;
    const r = await fetch(url);
    if (r.status === 429) { lastNote = "Steam попросил паузу, жду…"; await sleep(90000); return; }
    const j = await r.json().catch(() => null);
    if (!j || !j.listinginfo) { lastNote = "Steam не отдал лоты"; return; }
    const assets = j.assets?.["730"]?.["2"] || {};
    for (const [lid, l] of Object.entries(j.listinginfo)) {
      if (seen.has(lid)) continue;
      seen.add(lid);
      const price = ((l.converted_price || l.price || 0) + (l.converted_fee || l.fee || 0)) / 100;
      if (!(price > 0) || price > it.maxPrice) continue;
      const aid = l.asset?.id;
      const asset = assets[aid];
      let fl = floatFromAsset(asset);
      if (fl != null) floatMode = "из данных Steam ✓";
      if (fl == null) {
        const act = (l.asset?.market_actions || asset?.market_actions || [])[0];
        if (act) {
          const link = act.link.replace("%listingid%", lid).replace("%assetid%", aid);
          fl = await floatFromInspect(link);
          if (fl != null) floatMode = "через CSFloat ✓";
          await sleep(1200);
        }
      }
      if (fl == null) { if (floatMode === "?") floatMode = "не удалось ✗ (скажи Claude)"; continue; }
      if (fl <= it.maxFloat) {
        const buyUrl = `https://steamcommunity.com/market/listings/730/${encodeURIComponent(it.name)}#buylisting|${lid}|730|2|${aid}`;
        found.push({ name: it.name, float: fl, price, url: buyUrl });
        beep();
        try { new Notification("🔥 Нашёл лот для крафта", { body: `${it.name}\nфлоат ${fl.toFixed(4)} за ${price} ₴` }); } catch {}
        document.title = "🔥 НАЙДЕН ЛОТ — " + document.title.replace(/^🔥.*? — /, "");
      }
    }
  };

  for (;;) {
    for (const it of items) {
      try { await checkItem(it); } catch (e) { lastNote = "Ошибка: " + e.message; }
      checks++;
      draw();
      await sleep(4000);
    }
    lastNote = "Следующая проверка через 2 мин. Вкладку не закрывай.";
    draw();
    await sleep(120000);
  }
})();
