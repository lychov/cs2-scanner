/* Закладка «Цены CS2 → сканер». Запускается на steamcommunity.com.
   Берёт список скинов из адреса (#cs2scan=...), спрашивает у Steam цены в гривнах
   и отправляет их обратно на сайт сканера. Исходник; в закладку кладётся сжатая версия. */
(async () => {
  const SITE = "https://lychov.github.io";
  if (!location.hostname.endsWith("steamcommunity.com")) { alert("Открой эту закладку на сайте Steam (кнопкой со сканера)"); return; }
  const m = location.hash.match(/cs2scan=([^&]+)/);
  if (!m) { alert("Сначала нажми «Обновить цены Steam» на сайте сканера"); return; }
  const names = JSON.parse(decodeURIComponent(m[1]));
  const box = document.createElement("div");
  box.style.cssText = "position:fixed;z-index:99999;top:16px;right:16px;background:#171a21;color:#e8eaef;padding:14px 18px;border-radius:10px;font:15px system-ui;box-shadow:0 6px 30px #0008;max-width:320px";
  document.body.append(box);
  const parse = (s) => (s ? parseFloat(s.replace(/[^\d,.\s]/g, "").replace(/\s/g, "").replace(",", ".")) : null);
  const out = {};
  let i = 0;
  for (const n of names) {
    i++;
    box.textContent = `Цены Steam: ${i} / ${names.length}… Не закрывай вкладку.`;
    for (let a = 0; a < 4; a++) {
      const r = await fetch("/market/priceoverview/?appid=730&currency=18&market_hash_name=" + encodeURIComponent(n));
      if (r.status === 429) { box.textContent = "Steam просит подождать минуту…"; await new Promise((x) => setTimeout(x, 60000)); continue; }
      let j = null; try { j = await r.json(); } catch {}
      out[n] = j && j.success
        ? { low: parse(j.lowest_price), med: parse(j.median_price), vol: j.volume ? parseInt(j.volume.replace(/\D/g, "")) : 0, at: Date.now() }
        : { none: true, at: Date.now() };
      break;
    }
    if (i % 10 === 0 && window.opener) window.opener.postMessage({ cs2scan: out }, SITE);
    await new Promise((x) => setTimeout(x, 3200));
  }
  if (window.opener) window.opener.postMessage({ cs2scan: out, done: true }, SITE);
  box.textContent = `Готово: ${names.length} цен отправлено на сайт. Вкладку можно закрыть.`;
})();
