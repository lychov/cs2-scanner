// Служебный скрипт: воркфлоу debug.yml запускает сканер и кладёт data.json в ветку debug для проверки.
import { mkdir, writeFile } from "node:fs/promises";
await mkdir("debug-out", { recursive: true });
await writeFile("debug-out/report.json", JSON.stringify({ at: new Date().toISOString() }));
