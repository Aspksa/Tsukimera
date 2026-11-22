import { createServer } from "node:http";
import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { resolve, join } from "node:path";

const FILES = new Map([
  ["/", ["web/index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["web/app.js", "text/javascript; charset=utf-8"]],
  ["/tsukimera.css", ["web/tsukimera.css", "text/css; charset=utf-8"]],
  ["/juunibi-style.css", ["web/juunibi-style.css", "text/css; charset=utf-8"]],
  ["/juunibi-nav.css", ["web/juunibi-nav.css", "text/css; charset=utf-8"]],
  ["/juunibi-design.css", ["web/juunibi-design.css", "text/css; charset=utf-8"]],
]);

export const DEFAULTS = {
  model: { primary: "", fallback: "", reasoning: false },
  instructions: { about: "", style: "" },
  memory: { embeddings: false, summaries: false, suggestions: "off" },
  tools: { web: false, writeFiles: false },
  quickCommands: [],
};

function isRecord(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
const allowed = (value, options) => typeof value === "string" && options.includes(value);
const str = (value, max) => typeof value === "string" && value.length <= max && !value.includes("\0");
const model = (v) => str(v, 120) && (v === "" || /^[a-zA-Z0-9_.:/@+-]{2,120}$/.test(v));
function bad(reason) {
  const error = new Error(reason);
  error.status = 400;
  throw error;
}
function fields(patch, known) {
  if (!isRecord(patch)) bad("Ожидался объект настроек");
  for (const key of Object.keys(patch)) if (!known.includes(key)) bad("Неизвестное поле: " + key);
}
export function patchSettings(current, patch) {
  fields(patch, Object.keys(DEFAULTS));
  const next = structuredClone(current);
  if (patch.model !== undefined) {
    fields(patch.model, ["primary", "fallback", "reasoning"]);
    const p = patch.model;
    if (p.primary !== undefined) {
      if (!model(p.primary)) bad("Неверное имя основной модели");
      next.model.primary = p.primary;
    }
    if (p.fallback !== undefined) {
      if (!model(p.fallback)) bad("Неверное имя запасной модели");
      next.model.fallback = p.fallback;
    }
    if (p.reasoning !== undefined) {
      if (typeof p.reasoning !== "boolean") bad("Неверный флаг размышлений");
      next.model.reasoning = p.reasoning;
    }
    if (next.model.fallback && next.model.fallback === next.model.primary) bad("Запасная модель должна отличаться от основной");
  }
  if (patch.instructions !== undefined) {
    fields(patch.instructions, ["about", "style"]);
    for (const key of ["about", "style"]) if (patch.instructions[key] !== undefined) {
      if (!str(patch.instructions[key], 1500)) bad("Инструкция должна быть не длиннее 1500 символов");
      next.instructions[key] = patch.instructions[key];
    }
  }
  if (patch.memory !== undefined) {
    fields(patch.memory, ["embeddings", "summaries", "suggestions"]);
    for (const key of ["embeddings", "summaries"]) if (patch.memory[key] !== undefined) {
      if (typeof patch.memory[key] !== "boolean") bad("Неверный переключатель памяти");
      next.memory[key] = patch.memory[key];
    }
    if (patch.memory.suggestions !== undefined) {
      if (!allowed(patch.memory.suggestions, ["off", "rules", "smart"])) bad("Неверный режим предложений");
      next.memory.suggestions = patch.memory.suggestions;
    }
  }
  if (patch.tools !== undefined) {
    fields(patch.tools, ["web", "writeFiles"]);
    for (const key of ["web", "writeFiles"]) if (patch.tools[key] !== undefined) {
      if (typeof patch.tools[key] !== "boolean") bad("Неверный переключатель инструментов");
      next.tools[key] = patch.tools[key];
    }
  }
  if (patch.quickCommands !== undefined) {
    if (!Array.isArray(patch.quickCommands) || patch.quickCommands.length > 30) bad("Не больше 30 быстрых команд");
    const names = new Set();
    next.quickCommands = patch.quickCommands.map(item => {
      fields(item, ["name", "text"]);
      if (!str(item.name, 24) || !/^[a-zA-Zа-яА-ЯёЁ0-9_-]{1,24}$/.test(item.name) ||
        !str(item.text, 1500) || !item.text.trim() || names.has(item.name.toLowerCase())) bad("Некорректная быстрая команда");
      names.add(item.name.toLowerCase());
      return { name: item.name, text: item.text };
    });
  }
  return next;
}
export function createAppServer({ root, dataDir = join(root, "data") }) {
  let config = structuredClone(DEFAULTS);
  const file = join(dataDir, "settings.json");
  let writeQueue = Promise.resolve();

  async function load() {
    try {
      const parsed = JSON.parse(await readFile(file, "utf8"));
      config = patchSettings(DEFAULTS, parsed);
    } catch (error) {
      if (error.code !== "ENOENT") console.error("Настройки не загружены: ", error.message);
    }
  }
  async function save() {
    await mkdir(dataDir, { recursive: true });
    const tmp = join(dataDir, "settings.tmp-" + process.pid);
    await writeFile(tmp, JSON.stringify(config, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    await rename(tmp, file);
  }
  const headers = {
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  };
  function json(res, status, body) {
    res.writeHead(status, { ...headers, "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  }
  async function body(req) {
    if (!req.headers["content-type"]?.startsWith("application/json")) bad("Требуется application/json");
    let size = 0, raw = "";
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 65536) bad("Слишком большой запрос");
      raw += chunk;
    }
    try { return JSON.parse(raw); } catch { bad("Некорректный JSON"); }
  }
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, "http://localhost").pathname;
      if (pathname === "/api/status" && req.method === "GET") {
        return json(res, 200, { project: "Tsukimera", ready: true, aiConnected: false, version: "0.1.0" });
      }
      if (pathname === "/api/settings" && req.method === "GET") return json(res, 200, { settings: config });
      if (pathname === "/api/settings" && req.method === "PUT") {
        if (req.headers["x-tsukimera-request"] !== "1") return json(res, 403, { error: "Недопустимый запрос" });
        const incoming = await body(req);
        const next = patchSettings(config, incoming);
        await (writeQueue = writeQueue.catch(() => {}).then(async () => {
          config = next;
          await save();
        }));
        return json(res, 200, { settings: config });
      }
      if (pathname.startsWith("/api/")) return json(res, 404, { error: "API не реализован" });
      const asset = FILES.get(pathname);
      if (req.method !== "GET" && req.method !== "HEAD" || !asset)
        return json(res, 404, { error: "Не найдено" });
      const data = await readFile(resolve(root, asset[0]));
      res.writeHead(200, { ...headers, "Content-Type": asset[1] });
      res.end(req.method === "HEAD" ? undefined : data);
    } catch (error) {
      json(res, error.status || 500, { error: error.status ? error.message : "Внутренняя ошибка сервера" });
    }
  });
  return { server, load, getSettings: () => structuredClone(config) };
}
