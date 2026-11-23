/**
 * Tsukimera portable SQLite storage, using Node's built-in node:sqlite.
 * Database remains in data/tsukimera.db next to the existing Disk objects.
 * No npm packages, network services, Python runtime or migration deletion.
 */
import { DatabaseSync, backup as sqliteBackup } from "node:sqlite";
import { statSync, readdirSync } from "node:fs";
import { cp, copyFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import {installDiskIndex,readDiskState,saveDiskState,textIndexTargets,cachedText,indexText,indexedSearch,indexStatus,auditTarget,recordAudit,auditStatus} from "./disk-index.mjs";
import {installDiskKnowledge,pendingDiskKnowledge,putDiskKnowledge,diskKnowledgeStatus,diskKnowledgeForFile,diskKnowledgeGraph,rankedDiskSearch,diskTileInsights} from "./disk-knowledge.mjs";

const exists = async path => { try { await stat(path); return true; } catch (error) {
  if (error.code === "ENOENT") return false;
  throw error;
} };
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const parse = text => JSON.parse(text);
export const PREF_KEYS = new Set([
  "tsukimera:nav:v1", "tsukimera:ui:v1", "tsukimera:settings:v1",
  "tsukimera.disk.smart.v1", "tsukimera.disk.columns.v1",
  "tsukimera.disk.layout.left.v1", "tsukimera.disk.layout.right.v1",
  "tsukimera.disk.tiles.v1", "tsukimera.disk.view", "tsukimera.disk.sort",
  "tsukimera.disk.open", "tsukimera.disk.tree", "tsukimera.disk.life.group",
  "tsukimera.disk.mdRaw", "tsukimera.disk.sections.v1",
  "tsukimera.disk.minimap.view.v1",
  "tsukimera.disk.spatial.density.v1",
  "juunibi.disk.view", "juunibi.disk.sort", "juunibi.disk.open",
  "juunibi.disk.tree", "juunibi.disk.mdRaw", "juunibi.disk.life.group",
]);

const aliases = Object.fromEntries(["view","sort","open","tree","mdRaw","life.group"].map(x=>
  ["juunibi.disk."+x,"tsukimera.disk."+x]));
const cleanPrefs = (input, allowDelete = false) => {
  if (!record(input) || Object.keys(input).length > PREF_KEYS.size)
    throw fail("Некорректные параметры интерфейса");
  for (const [key, value] of Object.entries(input)) {
    if (!PREF_KEYS.has(key)) throw fail("Неизвестная настройка интерфейса: " + key);
    if (allowDelete && value === null) continue;
    if (typeof value !== "string" || value.length > 16000 || value.includes("\0"))
      throw fail("Слишком длинная или некорректная настройка");
  }
  const output={};
  for (const [key,value] of Object.entries(input)){
    const canonical=aliases[key]||key;
    if(key===canonical || !(canonical in input)) output[canonical]=value;
  }
  return output;
};
const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS app_settings (id INTEGER PRIMARY KEY CHECK (id=1), data TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS disk_state (id INTEGER PRIMARY KEY CHECK (id=1), data TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS disk_files (id TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, deleted_at TEXT, uploaded_at TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS disk_files_folder_idx ON disk_files(folder, deleted_at)",
  "CREATE INDEX IF NOT EXISTS disk_files_name_idx ON disk_files(name)",
  "CREATE TABLE IF NOT EXISTS disk_versions (file_id TEXT NOT NULL, revision INTEGER NOT NULL, object_id TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(file_id, revision), FOREIGN KEY(file_id) REFERENCES disk_files(id) ON DELETE CASCADE)",
  "CREATE TABLE IF NOT EXISTS disk_folders (name TEXT PRIMARY KEY, style_json TEXT)",
  "CREATE TABLE IF NOT EXISTS user_preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL)", 
  "CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS note_file_links (note_id TEXT NOT NULL, file_id TEXT NOT NULL, name TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY (note_id,file_id), FOREIGN KEY(note_id) REFERENCES notes(id) ON DELETE CASCADE)",
  "CREATE INDEX IF NOT EXISTS note_file_links_file_idx ON note_file_links(file_id)",
];

function normalizedNote(raw) {
  if (!record(raw) || typeof raw.id !== "string" || raw.id.length > 100 ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(raw.id) ||
      typeof raw.text !== "string" || !raw.text.trim() || raw.text.length > 3000)
    throw fail("Недопустимая заметка");
  const createdAt = typeof raw.createdAt === "string" && Number.isFinite(Date.parse(raw.createdAt))
    ? raw.createdAt : new Date().toISOString();
  if (raw.files !== undefined && !Array.isArray(raw.files)) throw fail("Недопустимые ссылки заметки");
  const files = [];
  for (const link of raw.files ?? []) {
    if (!record(link) || typeof link.id !== "string" || !/^[0-9a-f-]{36}$/i.test(link.id) ||
        typeof link.name !== "string" || link.name.length > 180 ||
        !link.name || files.some(item => item.id === link.id))
      throw fail("Недопустимая ссылка на документ");
    if (files.length >= 60) throw fail("Максимум 60 ссылок на заметку");
    files.push({ id: link.id, name: link.name });
  }
  return {
    id: raw.id, text: raw.text, kind: raw.kind === "todo" ? "todo" : "note",
    done: raw.done === true, createdAt, files,
    ...(typeof raw.project === "string" && raw.project.length <= 120 ? { project: raw.project } : {}),
    ...(raw.priority === "low" || raw.priority === "normal" || raw.priority === "high"
      ? { priority: raw.priority } : {}),
  };
}

export async function initializeDatabase(dataDir) {
  await mkdir(dataDir, { recursive: true });
  const filename = join(dataDir, "tsukimera.db");
  let backupPath = null;
  // An actual, complete copy is made before opening the database the first time.
  // The original data files, their index and unfinished uploads are NOT removed.
  if (!(await exists(filename))) {
    const legacy = ["settings.json", "disk", "uploads"];
    const found = [];
    for (const item of legacy) if (await exists(join(dataDir, item))) found.push(item);
    if (found.length) {
      const dest = join(dataDir, "backups", "before-sqlite-" +
        new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 8));
      await mkdir(dest, { recursive: true });
      try {
        for (const item of found) {
          const source = join(dataDir, item), target = join(dest, item);
          const metadata = await stat(source);
          if (metadata.isDirectory()) await cp(source, target, { recursive: true, force: false, errorOnExist: true });
          else await copyFile(source, target);
        }
        await writeFile(join(dest, "manifest.json"), JSON.stringify({
          format: 1, createdAt: new Date().toISOString(), files: found,
          note: "Complete pre-SQLite safety copy. Browser localStorage stays unchanged until explicitly imported.",
        }, null, 2));
        backupPath = dest;
      } catch (error) {
        await rm(dest, { recursive: true, force: true }).catch(() => {});
        throw new Error("SQLite не запущена: резервная копия исходных файлов не создана: " + error.message);
      }
    }
  }
  // A copy of the existing SQLite file is made before altering its schema;
  // browser-only preferences are imported later, never silently deleted.
  if (await exists(filename)) {
    const old = new DatabaseSync(filename, { readOnly: true });
    let needsUpgrade = false, needsDiskUpgrade = false;
    try {
      needsUpgrade = !old.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='user_preferences'").get();
      needsDiskUpgrade = !old.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='disk_meta'").get();
    } finally { old.close(); }
    if (needsUpgrade || needsDiskUpgrade) {
      const folder = join(dataDir, "backups");
      await mkdir(folder, {recursive:true});
      // Online SQLite backup avoids copies of partial journal/WAL data.
      const destination=join(folder,(needsUpgrade?"before-preferences-":"before-disk-index-")+
        new Date().toISOString().replace(/[:.]/g, "-")+"-"+randomUUID().slice(0,8)+".db");
      const oldReadOnly=new DatabaseSync(filename,{readOnly:true});
      try{await sqliteBackup(oldReadOnly,destination);}finally{oldReadOnly.close();}
    }
  }
  function withDb(fn) {
    const db = new DatabaseSync(filename, { timeout: 5000 });
    try {
      db.exec("PRAGMA foreign_keys=ON");
      db.exec("PRAGMA busy_timeout=5000");
      db.exec("PRAGMA synchronous=FULL");
      return fn(db);
    } finally { db.close(); }
  }
  withDb(db => {
    for (const sql of SCHEMA) db.exec(sql);
    installDiskIndex(db);
    installDiskKnowledge(db);
    db.prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES('instance_id',?)").run(randomUUID());
    db.prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES('schema_version','1')").run();
    db.prepare("UPDATE metadata SET value='3' WHERE key='schema_version'").run();
    if (backupPath) db.prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES('pre_migration_backup',?)")
      .run(relative(dataDir,backupPath));
    // Collapse obsolete JUUNIBI preference names into the canonical Tsukimera
    // keys, but do not replace a value that was already migrated.
    const names=db.prepare("SELECT key,value FROM user_preferences").all();
    for(const row of names){
      const target=aliases[row.key];if(!target)continue;
      db.prepare("INSERT OR IGNORE INTO user_preferences(key,value) VALUES(?,?)").run(target,row.value);
      db.prepare("DELETE FROM user_preferences WHERE key=?").run(row.key);
    }
    const integrity = db.prepare("PRAGMA quick_check").get();
    if (integrity.quick_check !== "ok") throw new Error("Повреждена база SQLite");
  });
  const transaction = operation => withDb(db => {
    db.exec("BEGIN IMMEDIATE");
    try { const result = operation(db); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  });
  const writeNote = (db, raw, skipExisting = false) => {
    const note = normalizedNote(raw);
    const command = skipExisting ? "INSERT OR IGNORE" : "INSERT OR REPLACE";
    const result = db.prepare(command + " INTO notes(id,data,created_at) VALUES(?,?,?)")
      .run(note.id, JSON.stringify(note), note.createdAt);
    if (skipExisting && !result.changes) return;
    db.prepare("DELETE FROM note_file_links WHERE note_id=?").run(note.id);
    const insert = db.prepare("INSERT INTO note_file_links(note_id,file_id,name,position) VALUES(?,?,?,?)");
    note.files.forEach((link, i) => insert.run(note.id, link.id, link.name, i));
  };
  const allNotes = db => db.prepare("SELECT data FROM notes ORDER BY created_at,id")
    .all().map(row => parse(row.data));
  const instanceId = withDb(db => db.prepare("SELECT value FROM metadata WHERE key='instance_id'").get().value);
  const previousBackup = withDb(db => db.prepare("SELECT value FROM metadata WHERE key='pre_migration_backup'").get()?.value ?? null);
  return {
    path: filename, backupPath: previousBackup ? join(dataDir,previousBackup) : null, instanceId,
    diagnostics: () => withDb(db => {
      const integrity=db.prepare("PRAGMA quick_check").get().quick_check;
      const schema=db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get()?.value??"unknown";
      const tables=db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get().n;
      const backups=(() => {try{return readdirSync(join(dataDir,"backups"),{withFileTypes:true});}
        catch(error){if(error.code==="ENOENT")return [];throw error;}})()
        .filter(x=>x.name.startsWith("before-")||x.name.startsWith("settings-restore-"))
        .map(x=>x.name).sort().reverse().slice(0,20);
      return {engine:"sqlite",integrity,schema,tables,file:"data/tsukimera.db",
        sizeBytes:statSync(filename).size,backups,search:indexStatus(db),audit:auditStatus(db),counts:{
          files:db.prepare("SELECT count(*) AS n FROM disk_files WHERE deleted_at IS NULL").get().n,
          notes:db.prepare("SELECT count(*) AS n FROM notes").get().n,
          versions:db.prepare("SELECT count(*) AS n FROM disk_versions").get().n,
          preferences:db.prepare("SELECT count(*) AS n FROM user_preferences").get().n,
        }};
    }),
    backupSettingsRestore: async () => {
      const dir=join(dataDir,"backups");await mkdir(dir,{recursive:true});
      const destination=join(dir,"settings-restore-"+new Date().toISOString().replace(/[:.]/g,"-")+"-"+randomUUID().slice(0,8)+".db");
      const db=new DatabaseSync(filename,{readOnly:true});
      try{await sqliteBackup(db,destination);}finally{db.close();}
      return relative(dataDir,destination).replaceAll("\\","/");
    },
    restoreSettingsBundle: ({settings,preferences,notes}) => {
      const prefs=cleanPrefs(preferences),valid=notes.map(normalizedNote);
      if(valid.length>200||new Set(valid.map(n=>n.id)).size!==valid.length)
        throw fail("Недопустимый набор заметок");
      return transaction(db=>{
        db.prepare("INSERT INTO app_settings(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(JSON.stringify(settings));
        db.prepare("DELETE FROM user_preferences").run();
        const insert=db.prepare("INSERT INTO user_preferences(key,value) VALUES(?,?)");
        for(const [key,value] of Object.entries(prefs))insert.run(key,value);
        db.prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES('preferences_initialized','1')").run();
        db.prepare("DELETE FROM notes").run();
        for(const note of valid)writeNote(db,note);
        return {notes:valid,preferences:prefs};
      });
    },
    readPreferences: () => withDb(db => ({
      instanceId,
      initialized: !!db.prepare("SELECT 1 FROM metadata WHERE key='preferences_initialized'").get(),
      preferences: Object.fromEntries(db.prepare("SELECT key,value FROM user_preferences").all().map(row=>[row.key,row.value])),
    })),
    initializePreferences: input => {
      const prefs=cleanPrefs(input);
      return transaction(db => {
        if (!db.prepare("SELECT 1 FROM metadata WHERE key='preferences_initialized'").get()) {
          const insert=db.prepare("INSERT OR IGNORE INTO user_preferences(key,value) VALUES(?,?)");
          for (const [key,value] of Object.entries(prefs)) insert.run(key,value);
          db.prepare("INSERT INTO metadata(key,value) VALUES('preferences_initialized','1')").run();
        }
        return {instanceId, initialized:true,
          preferences:Object.fromEntries(db.prepare("SELECT key,value FROM user_preferences").all().map(row=>[row.key,row.value]))};
      });
    },
    writePreferences: input => {
      const prefs=cleanPrefs(input,true);
      return transaction(db => {
        const update=db.prepare("INSERT INTO user_preferences(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
        const del=db.prepare("DELETE FROM user_preferences WHERE key=?");
        for (const [key,value] of Object.entries(prefs)) {
          if (value===null) del.run(key);
          else update.run(key,value);
        }
        db.prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES('preferences_initialized','1')").run();
        return {saved:Object.keys(prefs).length};
      });
    },
    readSettings: () => withDb(db => { const row = db.prepare("SELECT data FROM app_settings WHERE id=1").get(); return row ? parse(row.data) : null; }),
    writeSettings: config => transaction(db => {
      db.prepare("INSERT INTO app_settings(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(JSON.stringify(config));
    }),
    readDisk: () => withDb(readDiskState),
    writeDisk: state => transaction(db => saveDiskState(db,state)),
    pendingTextIndex: (limit=8) => withDb(db => textIndexTargets(db,limit)),
    getTextCache: sha => withDb(db => cachedText(db,sha)),
    putTextIndex: row => transaction(db => indexText(db,row)),
    searchTextIndex: query => withDb(db => indexedSearch(db,query)),
    indexStats: () => withDb(indexStatus),
    pendingKnowledge: (limit=1) => withDb(db => pendingDiskKnowledge(db,limit)),
    putKnowledge: row => transaction(db => putDiskKnowledge(db,row)),
    knowledgeStats: () => withDb(diskKnowledgeStatus),
    knowledgeForFile: id => withDb(db => diskKnowledgeForFile(db,id)),
    knowledgeGraph: (limit=240) => withDb(db => diskKnowledgeGraph(db,limit)),
    diskTileInsights: ids => withDb(db => diskTileInsights(db,ids)),
    rankedSearch: query => withDb(db => rankedDiskSearch(db,query)),
    auditNext: () => withDb(auditTarget),
    auditRecord: (target,status) => transaction(db => recordAudit(db,target,status)),
    auditStats: () => withDb(auditStatus),
    optimize: () => withDb(db => {
      // PRAGMA optimize is opportunistic and never vacuums or deletes originals.
      db.exec("PRAGMA optimize");
      return {integrity:db.prepare("PRAGMA quick_check").get().quick_check,
        at:new Date().toISOString()};
    }),
    listNotes: () => withDb(allNotes),
    importNotes: notes => {
      if (!Array.isArray(notes) || notes.length > 200) throw fail("Не больше 200 заметок");
      // Validate the entire collection before starting the transaction.
      const clean = notes.map(normalizedNote);
      if (new Set(clean.map(x => x.id)).size !== clean.length) throw fail("Повторяющиеся заметки");
      return transaction(db => { for (const n of clean) writeNote(db, n, true); return allNotes(db); });
    },
    replaceNotes: notes => {
      if (!Array.isArray(notes) || notes.length > 200) throw fail("Не больше 200 заметок");
      const clean = notes.map(normalizedNote);
      if (new Set(clean.map(x => x.id)).size !== clean.length) throw fail("Повторяющиеся заметки");
      return transaction(db => {
        db.prepare("DELETE FROM notes").run();
        for (const note of clean) writeNote(db,note);
        return allNotes(db);
      });
    },
    addNote: raw => transaction(db => {
      const note = normalizedNote(raw);
      if (db.prepare("SELECT id FROM notes WHERE id=?").get(note.id)) throw fail("Такая заметка уже есть",409);
      if (db.prepare("SELECT count(*) AS total FROM notes").get().total >= 200) throw fail("Лимит 200 заметок",409);
      writeNote(db,note);
      return note;
    }),
    deleteNote: id => transaction(db => {
      const result = db.prepare("DELETE FROM notes WHERE id=?").run(id);
      if (!result.changes) throw fail("Заметка не найдена",404);
      return {ok:true};
    }),
    attachNoteFiles: (id,files) => transaction(db => {
      const row = db.prepare("SELECT data FROM notes WHERE id=?").get(id);
      if (!row) throw fail("Заметка не найдена",404);
      const note = normalizedNote({...parse(row.data),files});
      writeNote(db,note);
      return note;
    }),
    counts: () => withDb(db => ({
      files:db.prepare("SELECT count(*) AS n FROM disk_files WHERE deleted_at IS NULL").get().n,
      notes:db.prepare("SELECT count(*) AS n FROM notes").get().n,
      versions:db.prepare("SELECT count(*) AS n FROM disk_versions").get().n,
    })),
  };
}
