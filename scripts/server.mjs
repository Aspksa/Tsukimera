import { createServer } from "node:http";
import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareDisk } from "./build-disk.mjs";
import { createDiskRouter } from "./disk-routes.mjs";
import { initializeDatabase } from "./tsukimera-db.mjs";
import { createDiskAutomation } from "./disk-background.mjs";
import { createCloudConnection } from "./cloudru.mjs";

const FILES = new Map([
  ["/", ["web/index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["web/app.js", "text/javascript; charset=utf-8"]],
  ["/tsukimera.css", ["web/tsukimera.css", "text/css; charset=utf-8"]],
  ["/disk.css", ["web/disk.css", "text/css; charset=utf-8"]],
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
const model = (v) => str(v, 120) && (v === "" || (v.length >= 2 && !v.includes("..") && !v.startsWith("/") && !v.includes("//") && /^[a-zA-Z0-9_.:@+-]+(?:\/[a-zA-Z0-9_.:@+-]+)*$/.test(v)));
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
export function createAppServer({root,dataDir=join(root,"data"),cloudRequest,cloudKey}={}) {
  let config = structuredClone(DEFAULTS);
  const file = join(dataDir, "settings.json");
  let writeQueue = Promise.resolve();
  let diskRouter = null;
  let diskStore = null;
  let automation = null;
  let database = null;
  const cloud=createCloudConnection({request:cloudRequest??globalThis.fetch,
    envKey:cloudKey??process.env.CLOUD_RU_FOUNDATION_MODELS_API_KEY??""});

  async function load() {
    // The migration copies the complete old vault before creating SQLite.
    database = await initializeDatabase(dataDir);
    const sqliteSettings = database.readSettings();
    try {
      const parsed = sqliteSettings ?? JSON.parse(await readFile(file, "utf8"));
      config = patchSettings(DEFAULTS, parsed);
    } catch (error) {
      if (error.code !== "ENOENT") console.error("Настройки не загружены: ", error.message);
    }
    if (sqliteSettings === null) database.writeSettings(config);
    await prepareDisk(root);
    const built=join(root,".runtime","disk-built","server");
    const [{LocalDisk},{zipStream,zipLength},{collectLife}]=await Promise.all([
      import(pathToFileURL(join(built,"local-disk.js")).href),
      import(pathToFileURL(join(built,"zip-write.js")).href),
      import(pathToFileURL(join(built,"disk-life.js")).href),
    ]);
    diskStore=new LocalDisk(join(dataDir,"disk"),database,()=>automation?.wake());
    await diskStore.load();
    automation=createDiskAutomation({
      database,diskRoot:join(dataDir,"disk"),
      readText:(id,limit)=>diskStore.readText(id,limit),
    });
    diskRouter=createDiskRouter({disk:diskStore,zipStream,zipLength,collectLife,
      uploadDir:join(dataDir,"uploads"),automation});
    await diskRouter.initUploads();
    automation.start();
  }
    // No background service or separate port: disk lives in this same loopback app.
  async function save() {
    // The DB is the committed source of truth. settings.json is kept as an
    // optional, readable compatibility copy for existing backups and tools.
    database.writeSettings(config);
    try {
      await mkdir(dataDir, { recursive: true });
      const tmp = join(dataDir, "settings.tmp-" + process.pid);
      await writeFile(tmp, JSON.stringify(config, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
      await rename(tmp, file);
    } catch (error) {
      console.error("Не удалось обновить дополнительный settings.json:", error);
    }
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
  async function body(req, maximum = 65536) {
    if (!req.headers["content-type"]?.startsWith("application/json")) bad("Требуется application/json");
    let size = 0, raw = "";
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maximum) bad("Слишком большой запрос");
      raw += chunk;
    }
    try { return JSON.parse(raw); } catch { bad("Некорректный JSON"); }
  }
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const pathname = url.pathname;
      const host=String(req.headers.host||"");
      if(!/^(127\.0\.0\.1|localhost|\[::1\]):[0-9]{1,5}$/.test(host))
        return json(res,403,{error:"Доступ разрешён только через локальный адрес"});
      if(req.headers.origin&&req.headers.origin!=="http://"+host)
        return json(res,403,{error:"Запрещён запрос с другого сайта"});
      if(req.headers["sec-fetch-site"]==="cross-site")
        return json(res,403,{error:"Межсайтовый запрос запрещён"});
      if (pathname.startsWith("/api/disk")) {
        if(!diskRouter)return json(res,503,{error:"Диск не запущен"});
        return diskRouter.handle(req,res,url);
      }
      if(pathname.startsWith("/disk-built/")){
        if((req.method!=="GET"&&req.method!=="HEAD")||
          !/^\/disk-built\/web\/(?:pages\/)?[a-z0-9-]+\.js$/.test(pathname))
          return json(res,404,{error:"Нет такого модуля"});
        const file=join(root,".runtime","disk-built",pathname.slice("/disk-built/".length));
        const body=await readFile(file);
        res.writeHead(200,{...headers,"Content-Type":"text/javascript; charset=utf-8"});
        return res.end(req.method==="HEAD"?undefined:body);
      }
      if (pathname === "/api/status" && req.method === "GET") {
        return json(res, 200, { project: "Tsukimera", ready: true, aiConnected: false,
          version: "0.1.0", storage: "sqlite" });
      }
      if (pathname === "/api/storage/diagnostics" && req.method === "GET") {
        return json(res,200,database.diagnostics());
      }
      if (pathname === "/api/cloud/status" && req.method === "GET") {
        return json(res,200,cloud.status());
      }
      if (pathname === "/api/cloud/models" && req.method === "GET") {
        return json(res,200,await cloud.list());
      }
      if (pathname === "/api/cloud/key" && req.method === "POST") {
        if(req.headers["x-tsukimera-request"]!=="1")return json(res,403,{error:"Недопустимый запрос"});
        const input=await body(req,8192);
        if(!isRecord(input)||typeof input.key!=="string"||Object.keys(input).some(k=>k!=="key"))bad("Неверный ключ");
        return json(res,200,cloud.changeKey(input.key));
      }
      if (pathname === "/api/cloud/clear" && req.method === "POST") {
        if(req.headers["x-tsukimera-request"]!=="1")return json(res,403,{error:"Недопустимый запрос"});
        return json(res,200,cloud.clear());
      }
      if (pathname === "/api/storage" && req.method === "GET") {
        return json(res, 200, { engine: "sqlite", file: "data/tsukimera.db",
          instanceId: database.instanceId, counts: database.counts(),
          backupCreated: database.backupPath ? "data/" + database.backupPath.split(/[\\/]/).slice(-2).join("/") : null });
      }
      if (pathname === "/api/preferences" && req.method === "GET") {
        return json(res,200,database.readPreferences());
      }
      if (pathname === "/api/preferences/initialize" && req.method === "POST") {
        if (req.headers["x-tsukimera-request"] !== "1")return json(res,403,{error:"Недопустимый запрос"});
        const input=await body(req,262144);
        if(!isRecord(input) || !isRecord(input.preferences) ||
          Object.keys(input).some(key=>key!=="preferences"))bad("Некорректный импорт настроек");
        return json(res,200,database.initializePreferences(input.preferences));
      }
      if (pathname === "/api/preferences" && req.method === "PUT") {
        if (req.headers["x-tsukimera-request"] !== "1")return json(res,403,{error:"Недопустимый запрос"});
        const input=await body(req,262144);
        if(!isRecord(input)||!isRecord(input.changes)||
          Object.keys(input).some(key=>key!=="changes"))bad("Некорректное изменение настроек");
        return json(res,200,database.writePreferences(input.changes));
      }
      if (pathname === "/api/notes" && req.method === "GET") {
        return json(res, 200, { notes: database.listNotes(), instanceId: database.instanceId });
      }
      if (pathname === "/api/notes/import" && req.method === "POST") {
        if (req.headers["x-tsukimera-request"] !== "1") return json(res, 403, {error:"Недопустимый запрос"});
        const input = await body(req, 1024 * 1024);
        if (!isRecord(input) || !["notes","replace"].includes(input.action ?? "notes") ||
          Object.keys(input).some(key => !["notes","action"].includes(key))) bad("Неверный импорт заметок");
        const notes = input.action === "replace"
          ? database.replaceNotes(input.notes) : database.importNotes(input.notes);
        return json(res, 200, {notes, instanceId:database.instanceId});
      }
      if (pathname === "/api/notes" && req.method === "POST") {
        if (req.headers["x-tsukimera-request"] !== "1") return json(res, 403, {error:"Недопустимый запрос"});
        const input = await body(req);
        const note = database.addNote(input);
        return json(res, 201, {note});
      }
      const noteFiles = /^\/api\/notes\/([a-zA-Z0-9_-]{1,100})\/files$/.exec(pathname);
      if (noteFiles && req.method === "PATCH") {
        if (req.headers["x-tsukimera-request"] !== "1") return json(res,403,{error:"Недопустимый запрос"});
        const input = await body(req);
        if (!isRecord(input) || Object.keys(input).some(key=>key!=="files")) bad("Неверные ссылки");
        const note = database.attachNoteFiles(noteFiles[1],input.files);
        return json(res,200,{note});
      }
      const noteDelete = /^\/api\/notes\/([a-zA-Z0-9_-]{1,100})$/.exec(pathname);
      if (noteDelete && req.method === "DELETE") {
        if (req.headers["x-tsukimera-request"] !== "1") return json(res,403,{error:"Недопустимый запрос"});
        return json(res,200,database.deleteNote(noteDelete[1]));
      }
      if (pathname === "/api/capabilities" && req.method === "GET"){
        return json(res,200,{
          notes:{available:true,engine:"sqlite",stored:database.counts().notes},
          vectorSearch:{available:false,reason:"Индекс смыслового поиска пока не реализован"},
          summaries:{available:false,reason:"Нет работающего чат-движка"},
          aiTools:{available:false,reason:"ИИ-инструменты не подключены"},
          cloud:cloud.status(),
          policies:{web:config.tools.web,writeFiles:config.tools.writeFiles,
            effectiveWeb:false,effectiveWriteFiles:false,
            note:"Политики сохранены; ИИ не может вызывать инструменты без исполняющего модуля."},
        });
      }
      if (pathname === "/api/settings/restore" && req.method === "POST"){
        if(req.headers["x-tsukimera-request"]!=="1")return json(res,403,{error:"Недопустимый запрос"});
        const input=await body(req,1048576);
        if(!isRecord(input)||input.kind!=="tsukimera-settings-v1"||input.version!==1||
          !isRecord(input.settings)||!Array.isArray(input.notes)||!isRecord(input.diskPrefs))bad("Некорректный архив настроек");
        const next=patchSettings(DEFAULTS,input.settings);
        if(input.notes.length>200||!isRecord(input.menu)||!isRecord(input.ui)||!isRecord(input.sections))bad("Некорректный архив настроек");
        const allowedPrefs=new Set([..."tsukimera:nav:v1|tsukimera:ui:v1|tsukimera:settings:v1".split("|"),
          ...Object.keys(database.readPreferences().preferences),
          "tsukimera.disk.smart.v1","tsukimera.disk.columns.v1",
          "tsukimera.disk.layout.left.v1","tsukimera.disk.layout.right.v1",
          "tsukimera.disk.tiles.v1","tsukimera.disk.view","tsukimera.disk.sort",
          "tsukimera.disk.open","tsukimera.disk.tree","tsukimera.disk.life.group",
          "tsukimera.disk.mdRaw"]);
        if(Object.entries(input.diskPrefs).some(([k,v])=>!allowedPrefs.has(k)||typeof v!=="string"||v.length>16000))bad("Недопустимые настройки Диска");
        const prefs={...input.diskPrefs,
          "tsukimera:nav:v1":JSON.stringify(input.menu),
          "tsukimera:ui:v1":JSON.stringify(input.ui),
          "tsukimera:settings:v1":JSON.stringify(input.sections)};
        // Serialise against ongoing server setting updates, and snapshot the
        // *whole database* before committing all restored values at once.
        const output=await (writeQueue=writeQueue.catch(()=>{}).then(async()=>{
          const backup=await database.backupSettingsRestore();
          const saved=database.restoreSettingsBundle({settings:next,preferences:prefs,notes:input.notes});
          config=next;
          await save();
          return {backup:"data/"+backup,notes:saved.notes,preferences:saved.preferences,
            settings:structuredClone(next)};
        }));
        return json(res,200,output);
      }
            if (pathname === "/api/settings" && req.method === "GET") return json(res, 200, { settings: config });
      if (pathname === "/api/settings" && req.method === "PUT") {
        if (req.headers["x-tsukimera-request"] !== "1") return json(res, 403, { error: "Недопустимый запрос" });
        const incoming = await body(req);
        // Apply each patch to the latest committed configuration. Calculating
        // next before entering the queue loses fields under concurrent PUTs.
        const saved = await (writeQueue = writeQueue.catch(() => {}).then(async () => {
          const next = patchSettings(config, incoming);
          const previous = config;
          config = next;
          try {
            await save();
          } catch (error) {
            config = previous;
            throw error;
          }
          return structuredClone(next);
        }));
        return json(res, 200, { settings: saved });
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
  server.on("close",()=>automation?.stop());
  return { server, load, getSettings: () => structuredClone(config), getDisk:()=>diskStore };
}
