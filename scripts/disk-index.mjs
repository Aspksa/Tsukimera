/**
 * Disk v3: incremental normalized SQLite catalogue, durable text cache, FTS5.
 * No third party dependency and no background execution outside the local app.
 * The v2 disk_state JSON is migration-only; do not overwrite it on every edit.
 */
import {invalidateDiskKnowledge} from "./disk-knowledge.mjs";
const parse=row=>JSON.parse(row.data);
const iso=()=>new Date().toISOString();

export function installDiskIndex(db){
  db.exec("CREATE TABLE IF NOT EXISTS disk_entries (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS disk_meta (id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS disk_text_cache (sha TEXT PRIMARY KEY,body TEXT NOT NULL,created_at TEXT NOT NULL)");
  db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS disk_fts USING fts5(file_id UNINDEXED,sha UNINDEXED,body,tokenize='unicode61 remove_diacritics 2')");
  db.exec("CREATE TABLE IF NOT EXISTS disk_audit (target TEXT PRIMARY KEY,sha TEXT NOT NULL,status TEXT NOT NULL,checked_at TEXT NOT NULL)");
  db.exec("CREATE INDEX IF NOT EXISTS disk_audit_checked_idx ON disk_audit(checked_at)");
  // Only migrate when the old single-object format has data and the new
  // normalized catalogue is uninitialised. A failure rolls back completely.
  const hasMeta=db.prepare("SELECT 1 FROM disk_meta WHERE id=1").get();
  const legacy=db.prepare("SELECT data FROM disk_state WHERE id=1").get();
  if(!hasMeta&&legacy){
    db.exec("BEGIN IMMEDIATE");
    try{
      saveDiskState(db,JSON.parse(legacy.data));
      db.exec("COMMIT");
    }catch(error){db.exec("ROLLBACK");throw error;}
  }
  db.prepare("UPDATE metadata SET value='3' WHERE key='schema_version'").run();
}
export function readDiskState(db){
  const row=db.prepare("SELECT data FROM disk_meta WHERE id=1").get();
  if(!row){
    const legacy=db.prepare("SELECT data FROM disk_state WHERE id=1").get();
    return legacy?JSON.parse(legacy.data):null;
  }
  const data=parse(row);
  const entries=db.prepare("SELECT data FROM disk_entries ORDER BY rowid").all().map(parse);
  const versions={};
  for(const r of db.prepare("SELECT file_id,revision,object_id,size,sha256,at FROM disk_versions ORDER BY file_id,revision").all()){
    (versions[r.file_id]??=[]).push({revision:r.revision,objectId:r.object_id,
      size:r.size,sha256:r.sha256,at:r.at});
  }
  return {...data,entries,versions};
}
const value=(x)=>JSON.stringify(x);
export function saveDiskState(db,state){
  const input=Array.isArray(state.entries)?state.entries:[];
  const next=new Map(input.map(e=>[e.id,value(e)]));
  if(next.size!==input.length)throw Error("Повторяющиеся идентификаторы файлов");
  const old=new Map(db.prepare("SELECT id,data FROM disk_entries").all().map(x=>[x.id,x.data]));
  const entryUp=db.prepare("INSERT INTO disk_entries(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data");
  const fileUp=db.prepare("INSERT INTO disk_files(id,name,folder,size,sha256,deleted_at,uploaded_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,folder=excluded.folder,size=excluded.size,sha256=excluded.sha256,deleted_at=excluded.deleted_at,uploaded_at=excluded.uploaded_at");
  const fileDelete=db.prepare("DELETE FROM disk_files WHERE id=?");
  const entryDelete=db.prepare("DELETE FROM disk_entries WHERE id=?");
  const ftsDelete=db.prepare("DELETE FROM disk_fts WHERE file_id=?");
  let changed=0,deleted=0;
  for(const e of input){
    const serialized=next.get(e.id);
    if(old.get(e.id)===serialized)continue;
    const before=old.get(e.id)?JSON.parse(old.get(e.id)):null;
    entryUp.run(e.id,serialized);
    fileUp.run(e.id,e.name,e.folder,e.size,e.sha256,e.deletedAt??null,e.uploadedAt);
    // Revision replacement or trash must never leave stale search hits.
    if(!before||before.sha256!==e.sha256||!!before.deletedAt!==!!e.deletedAt){
      ftsDelete.run(e.id);
      invalidateDiskKnowledge(db,e.id);
      db.prepare("DELETE FROM disk_audit WHERE target=?").run("file:"+e.id);
    }
    changed++;
  }
  for(const id of old.keys()){
    if(next.has(id))continue;
    ftsDelete.run(id);invalidateDiskKnowledge(db,id);fileDelete.run(id);entryDelete.run(id);deleted++;
    db.prepare("DELETE FROM disk_audit WHERE target=? OR target LIKE ?").run("file:"+id,"version:"+id+":%");
  }
  const previous=new Map();
  for(const r of db.prepare("SELECT file_id,revision,object_id,size,sha256,at FROM disk_versions ORDER BY file_id,revision").all()){
    const a=previous.get(r.file_id)??[];
    a.push({revision:r.revision,objectId:r.object_id,size:r.size,sha256:r.sha256,at:r.at});
    previous.set(r.file_id,a);
  }
  const histories=state.versions??{};
  const removeHistory=db.prepare("DELETE FROM disk_versions WHERE file_id=?");
  const addHistory=db.prepare("INSERT INTO disk_versions(file_id,revision,object_id,size,sha256,at) VALUES(?,?,?,?,?,?)");
  for(const id of new Set([...previous.keys(),...Object.keys(histories)])){
    const wanted=histories[id]??[];
    if(value(previous.get(id)??[])===value(wanted))continue;
    removeHistory.run(id);
    db.prepare("DELETE FROM disk_audit WHERE target LIKE ?").run("version:"+id+":%");
    for(const v of wanted)addHistory.run(id,v.revision,v.objectId,v.size,v.sha256,v.at);
  }
  const folders=new Map(db.prepare("SELECT name,style_json FROM disk_folders").all().map(x=>[x.name,x.style_json]));
  const nextFolders=new Map((state.folders??[]).map(name=>[name,value(state.folderStyles?.[name]??null)]));
  const folderUp=db.prepare("INSERT INTO disk_folders(name,style_json) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET style_json=excluded.style_json");
  for(const [name,style] of nextFolders)if(folders.get(name)!==style)folderUp.run(name,style);
  const folderDelete=db.prepare("DELETE FROM disk_folders WHERE name=?");
  for(const name of folders.keys())if(!nextFolders.has(name))folderDelete.run(name);
  const meta={
    folders:state.folders??[],folderStyles:state.folderStyles??{},
    folderActions:state.folderActions??[],fileActions:state.fileActions??[],
    deletedFolders:state.deletedFolders??[],trashDays:state.trashDays??30,
  };
  const raw=value(meta);
  if(db.prepare("SELECT data FROM disk_meta WHERE id=1").get()?.data!==raw)
    db.prepare("INSERT INTO disk_meta(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(raw);
  return {changed,deleted};
}

export function textIndexTargets(db,limit=8){
  return db.prepare(
    "SELECT f.id,f.name,f.sha256,f.size FROM disk_files f LEFT JOIN disk_fts t ON t.file_id=f.id "+
    "WHERE f.deleted_at IS NULL AND t.file_id IS NULL AND f.size<=? AND "+
    "(lower(f.name) LIKE '%.txt' OR lower(f.name) LIKE '%.md' OR lower(f.name) LIKE '%.csv' OR "+
    "lower(f.name) LIKE '%.json' OR lower(f.name) LIKE '%.log' OR lower(f.name) LIKE '%.js' OR "+
    "lower(f.name) LIKE '%.ts' OR lower(f.name) LIKE '%.css' OR lower(f.name) LIKE '%.html' OR "+
    "lower(f.name) LIKE '%.pdf' OR lower(f.name) LIKE '%.docx' OR lower(f.name) LIKE '%.xlsx' OR "+
    "lower(f.name) LIKE '%.pptx') ORDER BY f.uploaded_at DESC LIMIT ?"
  ).all(20*1024*1024,limit);
}
export function cachedText(db,sha){
  return db.prepare("SELECT body FROM disk_text_cache WHERE sha=?").get(sha)?.body??null;
}
export function indexText(db,{id,sha,body}){
  const row=db.prepare("SELECT sha256,deleted_at FROM disk_files WHERE id=?").get(id);
  if(!row||row.sha256!==sha||row.deleted_at)return {stale:true};
  // Empty string marks an unreadable/unsupported extraction so it will not
  // be retried indefinitely. A changed SHA automatically invalidates it.
  const text=String(body).slice(0,192000);
  db.prepare("INSERT OR IGNORE INTO disk_text_cache(sha,body,created_at) VALUES(?,?,?)").run(sha,text,iso());
  db.prepare("DELETE FROM disk_fts WHERE file_id=?").run(id);
  db.prepare("INSERT INTO disk_fts(file_id,sha,body) VALUES(?,?,?)").run(id,sha,text);
  return {indexed:true,characters:text.length};
}
export function indexedSearch(db,query){
  // FTS5 queries are always built from safely quoted Unicode word prefixes.
  // No user-supplied FTS5 operators can execute.
  const words=query.toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu)??[];
  if(!words.length)return [];
  const statement=words.slice(0,12).map(w=>'"'+w.replaceAll('"','""')+'"*').join(" AND ");
  return db.prepare("SELECT file_id FROM disk_fts WHERE disk_fts MATCH ? LIMIT 10000").all(statement)
    .map(r=>r.file_id);
}
export function indexStatus(db){
  const count=db.prepare("SELECT count(*) AS n FROM disk_fts").get().n;
  const pending=db.prepare("SELECT count(*) AS n FROM disk_files f LEFT JOIN disk_fts t ON t.file_id=f.id WHERE f.deleted_at IS NULL AND t.file_id IS NULL AND f.size<=20971520 AND "+
    "(lower(f.name) GLOB '*.txt' OR lower(f.name) GLOB '*.md' OR lower(f.name) GLOB '*.pdf' OR lower(f.name) GLOB '*.docx' OR lower(f.name) GLOB '*.xlsx' OR lower(f.name) GLOB '*.pptx')").get().n;
  return {indexed:count,pending};
}
export function auditTarget(db){
  const row=db.prepare(
    "SELECT 'file:'||f.id AS target,f.id AS file_id, COALESCE(json_extract(e.data,'$.objectId'),f.id) AS object_id,"+
    "f.sha256 AS sha,f.size AS size FROM disk_files f JOIN disk_entries e ON e.id=f.id "+
    "LEFT JOIN disk_audit a ON a.target='file:'||f.id "+
    "WHERE f.deleted_at IS NULL AND (a.target IS NULL OR a.sha<>f.sha256 OR a.checked_at<?) "+
    "ORDER BY COALESCE(a.checked_at,'') ASC LIMIT 1"
  ).get(new Date(Date.now()-7*86400000).toISOString());
  if(row)return row;
  return db.prepare(
    "SELECT 'version:'||v.file_id||':'||v.revision AS target,v.file_id,v.object_id,v.sha256 AS sha,v.size "+
    "FROM disk_versions v LEFT JOIN disk_audit a ON a.target='version:'||v.file_id||':'||v.revision "+
    "WHERE a.target IS NULL OR a.sha<>v.sha256 OR a.checked_at<? ORDER BY COALESCE(a.checked_at,'') ASC LIMIT 1"
  ).get(new Date(Date.now()-7*86400000).toISOString())??null;
}
export function recordAudit(db,target,status){
  // Do not save a stale audit result after another operation replaces the file.
  const row=target.target.startsWith("file:")
    ?db.prepare("SELECT sha256 AS sha FROM disk_files WHERE id=?").get(target.file_id)
    :db.prepare("SELECT sha256 AS sha FROM disk_versions WHERE file_id=? AND revision=?").get(
      target.file_id,Number(target.target.split(":").at(-1)));
  if(row?.sha!==target.sha)return false;
  db.prepare("INSERT INTO disk_audit(target,sha,status,checked_at) VALUES(?,?,?,?) "+
    "ON CONFLICT(target) DO UPDATE SET sha=excluded.sha,status=excluded.status,checked_at=excluded.checked_at")
    .run(target.target,target.sha,status,iso());
  return true;
}
export function auditStatus(db){
  return db.prepare("SELECT count(*) AS checked, "+
    "sum(CASE WHEN status='ok' THEN 1 ELSE 0 END) AS ok,"+
    "sum(CASE WHEN status='missing' THEN 1 ELSE 0 END) AS missing,"+
    "sum(CASE WHEN status='corrupt' THEN 1 ELSE 0 END) AS corrupt,"+
    "max(checked_at) AS lastCheckedAt FROM disk_audit").get();
}
