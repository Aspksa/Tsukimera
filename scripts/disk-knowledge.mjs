/**
 * Disk 20 — conservative, local, inspectable knowledge derived from the
 * existing, SHA-verified FTS5 text cache. No inference, network, writes to
 * source files, implicit moves, deletes or unverified identity matches.
 * Edges record their origin and are invalidated with their file SHA.
 */
const now=()=>new Date().toISOString();
const normalize=s=>String(s).normalize("NFKC").toLocaleLowerCase("ru-RU")
  .replaceAll("ё","е").replace(/\s+/g," ").trim();
const key=s=>normalize(s).replace(/[№#«»"'.,:;()]/g,"").replace(/\s+/g," ").slice(0,120);
const sample=(text,pos)=>text.slice(Math.max(0,pos-65),Math.min(text.length,pos+145))
  .replace(/\s+/g," ").trim().slice(0,200);
const cap=(v,max=12)=>[...new Map(v.map(x=>[x.key,x])).values()].slice(0,max);
export function extractDiskFacts(name,raw){
  const text=String(raw||"").slice(0,192000);
  const title=String(name||"").slice(0,200);
  const intro=title+"\n"+text;
  const facts=[];
  const put=(kind,value,at,certainty=.86)=>{
    if(!value||facts.length>180)return;
    const k=key(value);
    if(k.length<2||k.length>120)return;
    facts.push({kind,key:k,value:String(value).trim().slice(0,120),
      position:Math.max(0,at-title.length-1),
      evidence:sample(intro,at),certainty});
  };
  const match=(kind,pattern,group=1,confidence=.88,requireDigit=false)=>{
    for(const m of intro.matchAll(pattern)){
      const value=m[group]||"";
      if(requireDigit&&!/\d/.test(value))continue;
      put(kind,value,m.index||0,confidence);
    }
  };
  match("contract",/(?:договор(?:у|а|ом)?|контракт(?:у|а|ом)?)\s*(?:№|N|#|номер)?\s*([a-zа-я0-9][a-zа-я0-9/._-]{1,29}\d[a-zа-я0-9/._-]{0,12}|\d[a-zа-я0-9/._-]{1,35})/giu,1,.94,true);
  match("appendix",/(?:приложени[еяю]|дополнительное\s+соглашение)\s*(?:№|N|#)\s*([a-zа-я0-9][a-zа-я0-9/-]{0,20})/giu,1,.80,true);
  match("organization",/(?:^|[^\p{L}])(?:ООО|АО|ПАО|ОАО|ЗАО|ИП)\s*[«"']([^»"'\n]{3,80})[»"']/giu,1,.82);
  match("date",/\b((?:0?[1-9]|[12]\d|3[01])[./-](?:0?[1-9]|1[0-2])[./-](?:19|20)\d{2})\b/gu,1,.94);
  match("amount",/(?:сумма|стоимость|итого|к\s+оплате)\s*(?:составляет|в\s+размере|:|—|-)?\s*([\d][\d \u00a0]{0,14}(?:[.,]\d{1,2})?)\s*(?:руб(?:\.|лей|ля)?|₽)/giu,1,.8,true);
  match("account",/(?:сч[её]т(?:-фактура)?|акт)\s*(?:№|N|#)\s*([\d][a-zа-я0-9/_-]{0,28})/giu,1,.88,true);
  const type=/(?:договор|контракт)/i.test(title)?"contract":
    /(?:приложен|дополнительное соглашение)/i.test(title)?"appendix":
    /(?:акт)/i.test(title)?"act":
    /(?:сч[её]т|invoice)/i.test(title)?"invoice":
    /(?:письмо|служебн|записк)/i.test(title)?"letter":"other";
  const tokens=[...new Set(normalize(text).match(/[\p{L}\p{N}]{5,}/gu)||[])]
    .filter(w=>!/^(?:который|которая|договор|документ|согласно|сумма|номер|указанный)$/.test(w))
    .sort().slice(0,90);
  return {type,facts:cap(facts,130),tokens,summary:text.replace(/\s+/g," ").slice(0,180),
    chars:text.length,unreadable:text.length===0};
}
export function installDiskKnowledge(db){
  db.exec("CREATE TABLE IF NOT EXISTS disk_knowledge_docs (file_id TEXT PRIMARY KEY,sha TEXT NOT NULL,type TEXT NOT NULL,summary TEXT NOT NULL,tokens TEXT NOT NULL,processed_at TEXT NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS disk_knowledge_facts (file_id TEXT NOT NULL,kind TEXT NOT NULL,value_key TEXT NOT NULL,value TEXT NOT NULL,evidence TEXT NOT NULL,position INTEGER NOT NULL,certainty REAL NOT NULL,PRIMARY KEY(file_id,kind,value_key))");
  db.exec("CREATE INDEX IF NOT EXISTS disk_knowledge_facts_lookup ON disk_knowledge_facts(kind,value_key)");
  db.exec("CREATE TABLE IF NOT EXISTS disk_knowledge_links (left_id TEXT NOT NULL,right_id TEXT NOT NULL,kind TEXT NOT NULL,token TEXT NOT NULL,evidence TEXT NOT NULL,confidence REAL NOT NULL,PRIMARY KEY(left_id,right_id,kind,token))");
  db.exec("CREATE INDEX IF NOT EXISTS disk_knowledge_links_right ON disk_knowledge_links(right_id)");
}
export function invalidateDiskKnowledge(db,id){
  db.prepare("DELETE FROM disk_knowledge_docs WHERE file_id=?").run(id);
  db.prepare("DELETE FROM disk_knowledge_facts WHERE file_id=?").run(id);
  db.prepare("DELETE FROM disk_knowledge_links WHERE left_id=? OR right_id=?").run(id,id);
}
/** Resume automatically after process restart: unprocessed current-SHA files
 * that already have a durable FTS body are selected in bounded batches.
 */
export function pendingDiskKnowledge(db,limit=1){
  return db.prepare(
    "SELECT f.id,f.name,f.sha256,f.folder FROM disk_files f "+
    "JOIN disk_fts t ON t.file_id=f.id AND t.sha=f.sha256 "+
    "LEFT JOIN disk_knowledge_docs k ON k.file_id=f.id "+
    "WHERE f.deleted_at IS NULL AND (k.file_id IS NULL OR k.sha<>f.sha256) "+
    "ORDER BY f.uploaded_at DESC LIMIT ?"
  ).all(Math.max(1,Math.min(10,limit)));
}
function joinEvidence(a,b,kind){
  const label=kind==="contract"?"Одинаковый номер договора":
    kind==="organization"?"Одинаковое написание организации":"Общий реквизит";
  return label+": "+a.value+"; источники: «"+a.evidence.slice(0,88)+
    "» / «"+b.evidence.slice(0,88)+"»";
}
export function putDiskKnowledge(db,{id,sha,name,body}){
  const file=db.prepare("SELECT sha256,deleted_at FROM disk_files WHERE id=?").get(id);
  if(!file||file.deleted_at||file.sha256!==sha)return {stale:true};
  const extracted=extractDiskFacts(name,body);
  invalidateDiskKnowledge(db,id);
  db.prepare("INSERT INTO disk_knowledge_docs(file_id,sha,type,summary,tokens,processed_at) VALUES(?,?,?,?,?,?)")
    .run(id,sha,extracted.type,extracted.summary,JSON.stringify(extracted.tokens),now());
  const insert=db.prepare("INSERT OR IGNORE INTO disk_knowledge_facts(file_id,kind,value_key,value,evidence,position,certainty) VALUES(?,?,?,?,?,?,?)");
  for(const fact of extracted.facts){
    insert.run(id,fact.kind,fact.key,fact.value,fact.evidence,fact.position,fact.certainty);
  }
  const others=db.prepare(
    "SELECT k.file_id,k.kind,k.value_key,k.value,k.evidence,k.certainty "+
    "FROM disk_knowledge_facts k JOIN disk_files f ON f.id=k.file_id "+
    "WHERE k.kind=? AND k.value_key=? AND k.file_id<>? AND f.deleted_at IS NULL "+
    "LIMIT 24"
  );
  const create=db.prepare("INSERT OR REPLACE INTO disk_knowledge_links(left_id,right_id,kind,token,evidence,confidence) VALUES(?,?,?,?,?,?)");
  let links=0;
  // A company-name candidate is weaker than a matching explicit number.
  for(const fact of extracted.facts.filter(f=>f.kind==="contract"||f.kind==="organization")){
    for(const other of others.all(fact.kind,fact.key,id)){
      const [left,right]=[id,other.file_id].sort();
      create.run(left,right,fact.kind,fact.key,joinEvidence(fact,other,fact.kind),
        Math.min(fact.certainty,other.certainty,fact.kind==="contract"?.94:.79));
      links++;
    }
  }
  return {indexed:true,facts:extracted.facts.length,links,kind:extracted.type,unreadable:extracted.unreadable};
}
export function diskKnowledgeStatus(db){
  const rows=db.prepare(
    "SELECT (SELECT count(*) FROM disk_knowledge_docs) AS analyzed,"+
    "(SELECT count(*) FROM disk_knowledge_facts) AS facts,"+
    "(SELECT count(*) FROM disk_knowledge_links) AS links,"+
    "(SELECT count(*) FROM disk_knowledge_docs WHERE type='other') AS uncategorized,"+
    "(SELECT max(processed_at) FROM disk_knowledge_docs) AS lastAnalyzed"
  ).get();
  return {...rows,pending:db.prepare(
    "SELECT count(*) AS n FROM disk_files f JOIN disk_fts t ON t.file_id=f.id AND t.sha=f.sha256 "+
    "LEFT JOIN disk_knowledge_docs k ON k.file_id=f.id WHERE f.deleted_at IS NULL "+
    "AND (k.file_id IS NULL OR k.sha<>f.sha256)"
  ).get().n,mode:"local-verified-extraction"};
}
export function diskKnowledgeForFile(db,id){
  const row=db.prepare(
    "SELECT k.*,f.name,f.folder FROM disk_knowledge_docs k JOIN disk_files f ON f.id=k.file_id "+
    "WHERE k.file_id=? AND f.deleted_at IS NULL"
  ).get(id);
  if(!row)return {ready:false,facts:[],links:[],suggestions:[],alerts:[]};
  const facts=db.prepare(
    "SELECT kind,value,value_key,evidence,position,certainty FROM disk_knowledge_facts WHERE file_id=? "+
    "ORDER BY kind,value_key LIMIT 130").all(id);
  const links=db.prepare(
    "SELECT l.*,f.name AS other_name,f.folder AS other_folder FROM disk_knowledge_links l "+
    "JOIN disk_files f ON f.id=CASE WHEN l.left_id=? THEN l.right_id ELSE l.left_id END "+
    "WHERE (l.left_id=? OR l.right_id=?) AND f.deleted_at IS NULL "+
    "ORDER BY l.confidence DESC LIMIT 60").all(id,id,id).map(l=>({
      fileId:l.left_id===id?l.right_id:l.left_id,name:l.other_name,folder:l.other_folder,
      kind:l.kind,token:l.token,evidence:l.evidence,confidence:l.confidence
    }));
  const suggestions=[],alerts=[];
  // Explanations and review proposals are read-only, NOT commands.
  const folder=row.folder.toLocaleLowerCase("ru-RU");
  const target={contract:"Договоры",appendix:"Соглашения",act:"Акты",invoice:"Счета",letter:"Переписка"}[row.type];
  if(target&&!folder.includes(target.toLocaleLowerCase("ru-RU")))
    suggestions.push({kind:"folder",label:"Возможная папка «"+target+"»",target,
      reason:"Тип определён по названию файла: «"+row.name+"»",automatic:false});
  const copies=db.prepare(
    "SELECT id,name,folder FROM disk_files WHERE sha256=? AND id<>? AND deleted_at IS NULL LIMIT 10"
  ).all(row.sha,id);
  for(const file of copies)suggestions.push({kind:"duplicate",fileId:file.id,label:file.name,
    reason:"Идентичный SHA-256, удаление не предлагается",automatic:false});
  for(const f of facts.filter(x=>x.kind==="appendix")){
    const reference=db.prepare(
      "SELECT f.id,f.name FROM disk_knowledge_facts x JOIN disk_knowledge_docs d ON d.file_id=x.file_id "+
      "JOIN disk_files f ON f.id=d.file_id WHERE x.kind='appendix' AND x.value_key=? AND "+
      "d.type='appendix' AND x.file_id<>? AND f.deleted_at IS NULL LIMIT 1"
    ).get(f.value_key,id);
    if(!reference&&row.type!=="appendix")suggestions.push({
      kind:"missing-attachment",label:"Возможно отсутствует приложение №"+f.value,
      reason:"Есть упоминание «"+f.evidence+"», но отдельный индексированный документ с таким номером не найден",
      certainty:"candidate",automatic:false
    });
  }
  // A mismatch between two matching contract IDs is only a review signal:
  // different legitimate amounts can coexist in acts, bills and amendments.
  for(const link of links.filter(x=>x.kind==="contract").slice(0,20)){
    const own=new Set(facts.filter(x=>x.kind==="amount").map(x=>x.value_key));
    if(!own.size)continue;
    const other=db.prepare(
      "SELECT value_key,value,evidence FROM disk_knowledge_facts "+
      "WHERE file_id=? AND kind='amount' LIMIT 8"
    ).all(link.fileId);
    if(other.length&&other.some(x=>!own.has(x.value_key)))alerts.push({
      kind:"potential-amount-difference",fileId:link.fileId,otherName:link.name,
      contract:link.token,label:"Проверить возможное расхождение сумм",
      reason:"В документах с одним номером договора присутствуют разные суммы; "+
        "это может быть нормально, проверка человеком обязательна"
    });
  }
  return {ready:true,fileId:id,sha:row.sha,type:row.type,summary:row.summary,
    processedAt:row.processed_at,facts,links,suggestions:suggestions.slice(0,25),
    alerts:alerts.slice(0,15)};
}
/** Durable graph exposes exact source identities and explanatory evidence.
 * Each node/edge is still subject to the normal Canvas visibility limit.
 */
export function diskKnowledgeGraph(db,limit=240){
  const take=Math.max(1,Math.min(240,Number(limit)||140));
  const edges=db.prepare(
    "SELECT l.left_id,l.right_id,l.kind,l.token,l.evidence,l.confidence "+
    "FROM disk_knowledge_links l JOIN disk_files a ON a.id=l.left_id "+
    "JOIN disk_files b ON b.id=l.right_id WHERE a.deleted_at IS NULL "+
    "AND b.deleted_at IS NULL ORDER BY l.confidence DESC LIMIT ?"
  ).all(take);
  const nodes=[],links=[];
  for(const e of edges)links.push({source:"file:"+e.left_id,target:"file:"+e.right_id,
    kind:"reference",weight:e.confidence,evidence:e.evidence,
    confidence:e.confidence});
  const mentions=db.prepare(
    "SELECT x.kind,x.value_key,x.value,x.file_id,x.evidence,x.certainty "+
    "FROM disk_knowledge_facts x JOIN disk_files f ON f.id=x.file_id "+
    "WHERE f.deleted_at IS NULL AND x.kind IN ('contract','organization') "+
    "ORDER BY x.certainty DESC LIMIT ?"
  ).all(take);
  const seen=new Map();
  for(const m of mentions){
    const kind=m.kind==="contract"?"project":"organization";
    const id=kind+":"+m.value_key;
    const value=seen.get(id)||{id,kind,name:m.kind==="contract"?"Договор №"+m.value:m.value,count:0};
    value.count++;seen.set(id,value);
    links.push({source:id,target:"file:"+m.file_id,kind:"entity",
      weight:m.certainty,evidence:m.evidence,confidence:m.certainty});
  }
  nodes.push(...seen.values());
  return {records:{},nodes,links,processed:diskKnowledgeStatus(db).analyzed,
    unreadable:0,truncated:0};
}
export function rankedDiskSearch(db,query){
  const words=normalize(query).match(/[\p{L}\p{N}_]+/gu)||[];
  if(!words.length)return [];
  const expression=words.slice(0,12).map(w=>'"'+w.replaceAll('"','""')+'"*').join(" AND ");
  return db.prepare(
    "SELECT t.file_id,snippet(disk_fts,2,'«','»','…',14) AS excerpt,"+
    "bm25(disk_fts) AS rank FROM disk_fts t JOIN disk_files f "+
    "ON f.id=t.file_id WHERE disk_fts MATCH ? AND f.deleted_at IS NULL "+
    "ORDER BY rank ASC LIMIT 150"
  ).all(expression).map(x=>({id:x.file_id,excerpt:x.excerpt.slice(0,320),
    rank:Number(x.rank)}));
}
