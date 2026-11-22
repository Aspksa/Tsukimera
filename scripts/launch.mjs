import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { createAppServer } from "./server.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = x => argv.includes(x);
const index = argv.indexOf("--port");
const requested = index >= 0 ? Number(argv[index + 1]) : 4173;
if (!Number.isInteger(requested) || requested < 1024 || requested > 65535) {
  console.error("[Tsukimera] Неверный порт"); process.exit(2);
}
if (flag("--help")) {
  console.log("Tsukimera: node scripts/launch.mjs [--no-open] [--port N]");
  process.exit(0);
}
const urlFor = port => "http://127.0.0.1:" + port + "/";
function openBrowser(url) {
  if (flag("--no-open")) return;
  try {
    let proc;
    if (process.platform === "win32") {
      proc = spawn("cmd.exe", ["/d", "/s", "/c", 'start "" "' + url + '"'], { detached: true, stdio: "ignore", windowsHide: true });
    } else if (process.platform === "darwin") {
      proc = spawn("open", [url], { detached: true, stdio: "ignore" });
    } else {
      proc = spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
    }
    proc.on("error", () => console.log("Откройте вручную:", url));
    proc.unref();
  } catch { console.log("Откройте вручную:", url); }
}
function isRunning(port) {
  return new Promise(resolve => {
    const req = http.get(urlFor(port) + "api/status", { timeout: 400, agent: false }, response => {
      let result = "";
      response.setEncoding("utf8");
      response.on("data", x => { result += x.slice(0, 1024); });
      response.on("end", () => {
        try { resolve(JSON.parse(result).project === "Tsukimera"); }
        catch { resolve(false); }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
  });
}
const app = createAppServer({ root });
await app.load();
let port = requested, server = app.server, started = false;
for (let n = 0; n < 60 && port <= 65535; n++, port++) {
  if (await isRunning(port)) {
    console.log("[Tsukimera] Уже запущена:", urlFor(port));
    openBrowser(urlFor(port));
    process.exit(0);
  }
  const bound = await new Promise(resolve => {
    const fail = e => { server.off("listening", listen); resolve(e); };
    const listen = () => { server.off("error", fail); resolve(null); };
    server.once("error", fail);
    server.once("listening", listen);
    server.listen(port, "127.0.0.1");
  });
  if (!bound) { started = true; break; }
  if (!["EADDRINUSE", "EACCES"].includes(bound.code)) throw bound;
}
if (!started) {
  console.error("Нет свободного порта"); process.exit(1);
}
console.log("\nTsukimera · JUUNIBI-style shell");
console.log("Локальный адрес:", urlFor(port));
console.log("Настройки: data/settings.json (ключи Cloud.ru не сохраняются)");
console.log("Ctrl+C — завершить");
openBrowser(urlFor(port));
const stop = () => server.close(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
