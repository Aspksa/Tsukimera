import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {join,resolve} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {DatabaseSync} from "node:sqlite";
import {prepareDisk} from "../scripts/build-disk.mjs";
import {installDiskKnowledge,diskTileInsights,invalidateDiskKnowledge} from "../scripts/disk-knowledge.mjs";
const root=resolve(fileURLToPath(new URL("../",import.meta.url)));
test("Disk 21 contract chain orders actual source-backed documents without invented lines",async()=>{
  const built=await prepareDisk(root);
  const {graphDocumentChain,graphEntryPoint}=await import(pathToFileURL(join(built.outputRoot,"web/pages/disk-map-chain.js")).href);
  const project={id:"project:57",name:"Договор №57/2026",kind:"project"};
  const files=["Договор поставки.txt","Акт выполненных работ.pdf","Счёт на оплату.txt"].map((name,i)=>({
    id:"file:"+i,name,kind:"file",folder:"Работа",size:100,depth:1
  }));
  const links=files.map(f=>({kind:"entity",source:project.id,target:f.id,
    confidence:.94,weight:.94,evidence:"Договор №57/2026 найден в тексте «"+f.name+"»"}));
  const scene={nodes:[project,...files],links};
  const chain=graphDocumentChain(scene,"file:1");
  assert.ok(chain,"Verified contract references should form a chain");
  assert.deepEqual(chain.nodes.slice(0,3),["file:0","file:1","file:2"]);
  assert.ok(chain.nodes.includes("project:57"));
  assert.equal(chain.links.length,3);
  assert.ok(chain.links.every(edge=>links.includes(edge)),
    "Every drawn chain segment must be a pre-existing source edge");
  assert.equal(graphDocumentChain(scene,"project:57"),null);
  const unrelated={nodes:[...scene.nodes],links:links.map(e=>({...e,
    confidence:.6}))};
  assert.equal(graphDocumentChain(unrelated,"file:1"),null,
    "An uncertain candidate never becomes a confirmed contract chain");
  const unproved={nodes:[...scene.nodes],links:links.map(e=>({...e,
    evidence:"Совпадает организация, не договор"}))};
  assert.equal(graphDocumentChain(unproved,"file:1"),null,
    "Shared company spelling must not be presented as a contract");
  const coords=new Map([["folder:Работа",{x:100,y:200,vx:0,vy:0,pinned:true}]]);
  const file=files[0];
  const near=graphEntryPoint(file,[{kind:"contains",source:"folder:Работа",target:file.id}],
    coords,{x:-2000,y:-2000,vx:0,vy:0});
  assert.ok(Math.hypot(near.x-100,near.y-200)<50,
    "New verified file enters beside its true parent folder");
  assert.equal(coords.get("folder:Работа").x,100);
  assert.equal(coords.get("folder:Работа").pinned,true);
  const again=graphEntryPoint(file,[{kind:"contains",source:"folder:Работа",target:file.id}],
    coords,{x:-2000,y:-2000,vx:0,vy:0});
  assert.deepEqual(near,again,"The graph should not jump after rebuilding");
  const orphan=graphEntryPoint(files[2],[],coords,{x:12,y:22,vx:0,vy:0});
  assert.deepEqual(orphan,{x:12,y:22,vx:0,vy:0});
});
test("Disk 21 tile insights are exact, SHA scoped, bounded and read-only",()=>{
  const db=new DatabaseSync(":memory:");
  try{
    db.exec("CREATE TABLE disk_files(id TEXT PRIMARY KEY,sha256 TEXT,deleted_at TEXT)");
    db.exec("CREATE VIRTUAL TABLE disk_fts USING fts5(file_id UNINDEXED,sha UNINDEXED,body)");
    installDiskKnowledge(db);
    const ids=["a","b","c","d"].map(x=>x.repeat(36));
    const sha="1".repeat(64);
    for(const id of ids)db.prepare("INSERT INTO disk_files VALUES(?,?,NULL)").run(id,sha);
    db.prepare("INSERT INTO disk_fts(file_id,sha,body) VALUES(?,?,?)").run(ids[0],sha,"Договор №57");
    db.prepare("INSERT INTO disk_fts(file_id,sha,body) VALUES(?,?,?)").run(ids[1],sha,"Акт №57");
    db.prepare("INSERT INTO disk_knowledge_docs VALUES(?,?,?,?,?,?)").run(ids[0],sha,"contract","Договор","[]",new Date().toISOString());
    const insert=db.prepare("INSERT INTO disk_knowledge_links VALUES(?,?,?,?,?,?)");
    insert.run(ids[0],ids[1],"contract","57","Договор №57",.94);
    insert.run(ids[0],ids[1],"organization","компания","ООО",.79);
    insert.run(ids[0],ids[2],"contract","58","Договор №58",.94);
    const before=db.prepare("SELECT count(*) n FROM disk_knowledge_links").get().n;
    const result=diskTileInsights(db,[ids[0],ids[1],ids[2],ids[3],"invalid"]);
    assert.equal(result.items.length,4);
    const map=new Map(result.items.map(x=>[x.id,x]));
    assert.deepEqual([map.get(ids[0]).links,map.get(ids[1]).links,
      map.get(ids[2]).links,map.get(ids[3]).links],[2,1,1,0],
      "Counts mean unique linked files, not the number of evidence rows");
    assert.equal(map.get(ids[0]).state,"ready");
    assert.equal(map.get(ids[1]).state,"text-indexed");
    assert.equal(map.get(ids[2]).state,"waiting");
    assert.equal(db.prepare("SELECT count(*) n FROM disk_knowledge_links").get().n,before);
    db.prepare("UPDATE disk_files SET deleted_at=? WHERE id=?").run(new Date().toISOString(),ids[3]);
    assert.equal(diskTileInsights(db,[ids[3]]).items.length,0);
    invalidateDiskKnowledge(db,ids[1]);
    assert.equal(diskTileInsights(db,[ids[0]]).items[0].links,1,
      "Source change removes stale link counts");
    assert.deepEqual(diskTileInsights(db,["not-id"]),{items:[],coverage:"requested-files"});
  }finally{db.close();}
});
test("Disk 21 keeps graph canvas borderless, 150 Life metrics, folder actions, splitters and reduced-motion",async()=>{
  const [disk,mini,css,layout,life,api]=await Promise.all([
    readFile(join(root,"disk-src/web/pages/disk.ts"),"utf8"),
    readFile(join(root,"disk-src/web/pages/disk-map-mini.ts"),"utf8"),
    readFile(join(root,"web/disk.css"),"utf8"),
    readFile(join(root,"disk-src/web/pages/disk-layout.ts"),"utf8"),
    readFile(join(root,"disk-src/web/pages/disk-life.ts"),"utf8"),
    readFile(join(root,"disk-src/web/api.ts"),"utf8")
  ]);
  for(const needle of ["graphDocumentChain(scene,active)","graphEntryPoint(n,scene.links,next",
    "highlightFolder:(folder:string|null)=>void","hoverEdge.confidence",
    "canvas.dataset.knowledge="])
    assert.ok(mini.includes(needle),"Graph feature missing: "+needle);
  for(const needle of ["diskTileInsights(ids)","dk21-link-count","dk21-index-state",
    "miniMap.highlightFolder(folder)","dk21-enter","justOpenedFolder",
    "Избранное","Корзина","Сведения"])
    assert.ok(disk.includes(needle),"File manager feature missing: "+needle);
  assert.ok(api.includes("diskTileInsights:(ids:readonly string[])"));
  assert.ok(layout.includes("manualLeft")&&layout.includes("manualRight"));
  assert.ok(css.includes("--dk21-indent:14px"));
  assert.ok(css.includes("grid-auto-rows:minmax(108px,1fr)"));
  assert.ok(css.includes("@media (prefers-reduced-motion:reduce)"));
  assert.ok(css.includes("dk21-folder-enter"));
  assert.ok(css.includes(".dk-graph-only"));
  assert.ok(!mini.includes('el("aside"')&&!mini.includes('el("header"'));
  assert.ok(life.includes("150")||disk.includes("150"),"Existing Life analytics must remain");
  assert.ok(disk.includes('iconButton("maximize","Развернуть все папки"'));
  assert.ok(disk.includes('iconButton("minimize","Свернуть все папки"'));
  assert.ok(disk.includes("const folderMenu"));
  assert.ok(disk.includes("const renderFiles"));
  assert.ok(disk.includes("function openInfo"));
});
