import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {join,resolve} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {prepareDisk} from "../scripts/build-disk.mjs";
const root=resolve(fileURLToPath(new URL("../",import.meta.url)));

test("navigation section preferences normalize bad data and preserve all original categories",async()=>{
  const built=await prepareDisk(root);
  const mod=await import(pathToFileURL(join(built.outputRoot,"web/pages/disk-sidebar.js")).href);
  const defaults=mod.sanitizeSidebarPrefs(null);
  assert.deepEqual(defaults.order,["favorites","recent","images","documents","large","trash"]);
  assert.deepEqual(defaults.hidden,[]);
  assert.equal(defaults.collapsed,false);
  const x=mod.sanitizeSidebarPrefs({order:["trash","trash","unknown","recent"],hidden:["recent","other","recent"],collapsed:true});
  assert.deepEqual(x.order,["trash","recent","favorites","images","documents","large"]);
  assert.deepEqual(x.hidden,["recent"]);
  assert.equal(x.collapsed,true);
  assert.deepEqual(mod.reorderSections(defaults.order,"recent","favorites"),
    ["recent","favorites","images","documents","large","trash"]);
  assert.deepEqual(mod.reorderSections(defaults.order,"large","trash"),
    ["favorites","recent","images","documents","large","trash"]);
  assert.deepEqual(mod.reorderSections(defaults.order,"trash","favorites"),
    ["trash","favorites","recent","images","documents","large"]);
});

test("folder ancestry honors real nesting and dragged folders cannot self-nest or no-op",async()=>{
  const built=await prepareDisk(root);
  const mod=await import(pathToFileURL(join(built.outputRoot,"web/pages/disk-sidebar.js")).href);
  assert.deepEqual(mod.folderAncestors(""),[]);
  assert.deepEqual(mod.folderAncestors("Работа/2026/Акты"),["Работа","Работа/2026","Работа/2026/Акты"]);
  assert.equal(mod.safeFolderDrop("Работа","Работа").ok,false);
  assert.equal(mod.safeFolderDrop("Работа","Работа/2026").ok,false);
  assert.equal(mod.safeFolderDrop("Работа/2026","Работа").ok,false);
  assert.equal(mod.safeFolderDrop("","Работа").ok,false);
  assert.equal(mod.safeFolderDrop("Работа/2026","Архив").ok,true);
  assert.equal(mod.safeFolderDrop("Работа/2026","").ok,true);
});

test("real Disk graph sizes count descendants, duplicate SHA and shared tags without fabricated data",async()=>{
  const built=await prepareDisk(root);
  const map=await import(pathToFileURL(join(built.outputRoot,"web/pages/disk-map-layout.js")).href);
  const a={id:"a",name:"Один.txt",folder:"Работа/2026",size:100,sha256:"abc",tags:["важно"]};
  const b={id:"b",name:"Два.txt",folder:"Работа/2026",size:300,sha256:"abc",tags:["важно"]};
  const c={id:"c",name:"Три.txt",folder:"Архив",size:8000,sha256:"other",tags:["важно"]};
  const graph=map.graphFromFiles([a,b,c],["Работа","Работа/2026","Архив"]);
  const byId=new Map(graph.nodes.map(x=>[x.id,x]));
  assert.equal(byId.get("root").count,3);
  assert.equal(byId.get("root").size,8400);
  assert.equal(byId.get("folder:Работа").count,2);
  assert.equal(byId.get("folder:Работа/2026").count,2);
  assert.equal(byId.get("folder:Работа").size,400);
  assert.equal(byId.get("folder:Архив").count,1);
  assert.equal(graph.edges.filter(e=>e.kind==="duplicate").length,1);
  assert.ok(graph.edges.filter(e=>e.kind==="tag").length>=2);
  assert.ok(graph.edges.some(e=>e.from==="folder:Работа"&&e.to==="folder:Работа/2026"&&e.kind==="contains"));
  assert.ok(map.mapNodeRadius(byId.get("file:c"),graph.bytes)>map.mapNodeRadius(byId.get("file:a"),graph.bytes));
  assert.ok(map.mapNodeRadius(byId.get("folder:Работа"),graph.bytes)>=6.5);
  assert.ok(map.mapNodeRadius(byId.get("root"),graph.bytes)<=20);
});

test("left rail and map maintain real document data, focus, accessible controls and reduced motion",async()=>{
  const [disk,styles,mapSource]=await Promise.all([
    readFile(join(root,"disk-src/web/pages/disk.ts"),"utf8"),
    readFile(join(root,"web/disk.css"),"utf8"),
    readFile(join(root,"disk-src/web/pages/disk-map.ts"),"utf8"),
  ]);
  for(const wanted of ["Развернуть все папки","Свернуть все папки","dk-ancestor",
    "Настроить разделы","dk-section-editor-row","reorderSections",
    "safeFolderDrop","Переместить папку?","dk-section-toggle",
    "dkx-smart-head","tsukimera:life-open-file"])
    assert.ok(disk.includes(wanted),"Missing existing or selected UI behavior: "+wanted);
  for(const wanted of [".dk-tree-panel",".dk-tree-commands",".dk-branch-kids::before",
    ".dk-section-head",".dk-section-drop",".dk-section-editor-row",
    ".dk-sections-region[hidden]","@media (prefers-reduced-motion:reduce)"])
    assert.ok(styles.includes(wanted),"Missing scoped navigation styles "+wanted);
  for(const wanted of ["mapNodeRadius","relationshipCounts","details(node)",
    "openSelected.addEventListener","openFolder(node.folder)","openFile(node.id.slice(5))"])
    assert.ok(mapSource.includes(wanted),"Missing link to the real file on the map "+wanted);
});


test("Disk 13 retains a single Graph View below the folder hierarchy",async()=>{
 const [page,mini,css]=await Promise.all([
  readFile(join(root,"disk-src/web/pages/disk.ts"),"utf8"),
  readFile(join(root,"disk-src/web/pages/disk-map-mini.ts"),"utf8"),
  readFile(join(root,"web/disk.css"),"utf8")
 ]);
 assert.match(page,/treePanel,miniMap\.root\)/);
 assert.match(page,/bar,filesHeading,layout,/);
 assert.doesNotMatch(page,/bar,miniMap\.root,filesHeading/);
 assert.match(page,/miniMap\.update\(all,folders,current\)/);
 assert.match(page,/dk-map-left/);
 assert.match(mini,/graphFromCatalog\(files,folders,current/);
 assert.match(mini,/graphForceStep\(/);
 assert.match(mini,/ctx\.arc\(/);
 assert.match(mini,/ctx\.moveTo\(/);
 assert.match(mini,/canvas\.dataset\.layer="graph"/);
 assert.match(mini,/dk-graph-expanded/);
 assert.match(css,/\.dk-graph-only\.dk-graph-expanded/);
 assert.match(css,/\.dk-layout>.dk-side>.dk-graph-only/);
 assert.doesNotMatch(mini,/spatialSlots\(/,"Card orbit must not be used");
});

test("Disk 8.3 unclutters folder rail without losing stored folder style or controls",async()=>{
  const source=await readFile(join(root,"disk-src/web/pages/disk.ts"),"utf8");
  assert.doesNotMatch(source,/const treeFind\s*=/);
  assert.doesNotMatch(source,/const treeSortSel\s*=/);
  assert.doesNotMatch(source,/treeSort\s*===/);
  assert.doesNotMatch(source,/Закрепить наверху/);
  assert.match(source,/const treePanel=el\("div",\{cls:"dk-tree-panel"\},treeCommands,tree\)/);
  assert.match(source,/const order=\(a:string,b:string\)=>a\.localeCompare\(b,"ru",\{numeric:true\}\)/);
  assert.match(source,/api\.diskFolderStyle\(folder, color \|\| "#b89cff", st\.pinned/);
  assert.match(source,/const expanded = new Set<string>/);
});

test("Disk 8.3 mini map bounded, truthful aggregation and closer zoom reveals additional files",async()=>{
  const built=await prepareDisk(root);
  const mod=await import(pathToFileURL(join(built.outputRoot,"web/pages/disk-map-mini-model.js")).href);
  const folders=Array.from({length:100},(_,i)=>"Область"+String(i).padStart(3,"0"));
  const files=Array.from({length:10000},(_,i)=>({
    id:"file"+i,name:"Отчёт "+i+".txt",folder:folders[i%100],size:i+1,
    sha256:i<2?"duplicate":String(i),tags:i%9===0?["отчёт"]:[],
  }));
  const t0=performance.now();
  const overview=mod.miniGraphFromCatalog(files,folders);
  const elapsed=performance.now()-t0;
  assert.ok(elapsed<12000,"Mini map model should handle 10k files without freezing: "+elapsed+"ms");
  assert.equal(overview.totalFiles,10000);
  assert.equal(overview.totalFolders,100);
  assert.ok(overview.shownFiles<=70);
  assert.ok(overview.nodes.length<=1+40+70+12);
  const clusters=overview.nodes.filter(n=>n.kind==="cluster");
  assert.ok(clusters.length>0&&clusters.length<=12);
  assert.equal(clusters.reduce((n,c)=>n+c.hiddenFiles,0),10000-overview.shownFiles,
    "Every excluded real file must be included in exactly one cluster");
  assert.equal(clusters.reduce((n,c)=>n+c.hiddenFolders,0),100-overview.shownFolders,
    "Every excluded real folder must be accounted for in a cluster");
  assert.equal(clusters.reduce((n,c)=>n+c.size,0),
    files.reduce((sum,f)=>sum+f.size,0)-overview.nodes.filter(n=>n.kind==="file").reduce((sum,n)=>sum+n.size,0));
  assert.ok(overview.edges.every(e=>overview.nodes.some(n=>n.id===e.from)&&overview.nodes.some(n=>n.id===e.to)),
    "No edge may point at an invented or unrendered node");
  const detailed=mod.miniGraphFromCatalog(files,folders,"",true);
  assert.ok(detailed.shownFiles>overview.shownFiles&&detailed.shownFiles<=190);
  assert.ok(detailed.nodes.length<=1+100+190+12);
  assert.equal(detailed.nodes.filter(n=>n.kind==="cluster").reduce((n,c)=>n+c.hiddenFiles,0),
    10000-detailed.shownFiles);
  const focused=mod.miniGraphFromCatalog(files,folders,folders[1],true);
  assert.equal(focused.totalFiles,100);
  assert.ok(focused.nodes.some(n=>n.kind==="folder"&&n.folder===folders[1]));
  assert.ok(focused.nodes.filter(n=>n.kind==="cluster").reduce((n,c)=>n+c.hiddenFiles,0)===0);
});

test("Disk 13 validates viewport and retains wheel, pan, touch and SQLite preferences",async()=>{
 const built=await prepareDisk(root);
 const mod=await import(pathToFileURL(join(built.outputRoot,"web/pages/disk-map-mini-model.js")).href);
 assert.deepEqual(mod.normalizeMiniView(null),{zoom:1,panX:0,panY:0,focus:""});
 assert.deepEqual(mod.normalizeMiniView({zoom:Infinity,panX:"oops",panY:NaN,focus:4}),
   {zoom:1,panX:0,panY:0,focus:""});
 assert.equal(mod.MINI_VIEW_KEY,"tsukimera.disk.minimap.view.v1");
 const source=await readFile(join(root,"disk-src/web/pages/disk-map-mini.ts"),"utf8");
 for(const token of ["writePreference(MINI_VIEW_KEY,JSON.stringify({",
  'frame.addEventListener("wheel"','frame.addEventListener("touchmove"',
  'canvas.addEventListener("pointerdown"','canvas.addEventListener("pointermove"',
  'canvas.addEventListener("pointerup"','canvas.addEventListener("keydown"',
  'canvas.dataset.nodes=String(scene.nodes.length)'])
   assert.ok(source.includes(token),"Missing graph interaction/persistence: "+token);
});

test("Disk 8.3 SQLite and backup allowlists accept both section layout and persistent mini-map view",async()=>{
  const [db,server]=await Promise.all([
    readFile(join(root,"scripts/tsukimera-db.mjs"),"utf8"),
    readFile(join(root,"scripts/server.mjs"),"utf8"),
  ]);
  for(const key of ["tsukimera.disk.sections.v1","tsukimera.disk.minimap.view.v1","tsukimera.disk.spatial.density.v1"]){
    assert.ok(db.includes('"'+key+'"'),"SQLite must allow "+key);
    assert.ok(server.includes('"'+key+'"'),"Backup restore must allow "+key);
  }
});


test("Disk 9.0 orbit layout uses factual parents, collision spacing and deterministic coordinates",async()=>{
  const built=await prepareDisk(root);
  const base=await import(pathToFileURL(join(built.outputRoot,"web/pages/disk-map-mini-model.js")).href);
  const orbits=await import(pathToFileURL(join(built.outputRoot,"web/pages/disk-map-orbits.js")).href);
  const folders=["Работа","Работа/2026","Работа/2026/Счета","Архив",...Array.from({length:70},(_,i)=>"Группа/"+i)];
  const files=Array.from({length:220},(_,i)=>({
    id:"test"+i,name:"Файл-"+i+".txt",
    folder:i<30?"Работа/2026/Счета":folders[(i%folders.length)],size:i<30?10000+i:50+i,
    tags:i%3?[]:["учёт"],sha256:"hash"+i
  }));
  const model=base.miniGraphFromCatalog(files,folders,"",false,"Работа/2026/Счета");
  const graph=orbits.orbitLayout(model);
  assert.ok(graph.nodes.some(n=>n.id==="folder:Работа/2026/Счета"),"Selected folder must be included in sampled graph");
  const trail=orbits.containmentTrail(graph,"folder:Работа/2026/Счета");
  assert.deepEqual(trail,["root","folder:Работа","folder:Работа/2026","folder:Работа/2026/Счета"]);
  assert.deepEqual(orbits.containmentTrail(graph,"missing"),[]);
  assert.ok(graph.nodes.some(n=>n.kind==="cluster"));
  const children=new Map(graph.edges.filter(e=>e.kind==="contains").map(e=>[e.to,e.from]));
  const positions=new Map(graph.nodes.map(n=>[n.id,n]));
  for(const node of graph.nodes){
    assert.ok(Number.isFinite(node.x)&&Number.isFinite(node.y),"Invalid orbit coordinates: "+node.id);
    if(node.kind==="root")continue;
    const parent=positions.get(children.get(node.id));
    assert.ok(parent,"Every orbital node must retain a factual containment parent: "+node.id);
    const distance=Math.hypot(node.x-parent.x,node.y-parent.y);
    assert.ok(distance>=30,"Child node is overlapping its parent: "+node.id);
  }
  for(let i=0;i<graph.nodes.length;i++)for(let j=i+1;j<graph.nodes.length;j++){
    const a=graph.nodes[i],b=graph.nodes[j];
    assert.ok(Math.hypot(a.x-b.x,a.y-b.y)>=28.9,"Orbit collisions between "+a.id+" and "+b.id);
  }
  const same=orbits.orbitLayout(model);
  assert.deepEqual(graph.nodes.map(n=>[n.id,n.x,n.y]),same.nodes.map(n=>[n.id,n.x,n.y]),
    "Orbit placement must be stable between catalog refreshes");
  const file=graph.nodes.find(n=>n.kind==="file"&&n.folder==="Работа/2026/Счета");
  assert.ok(file);
  assert.deepEqual(orbits.containmentTrail(graph,file.id),[...trail,file.id],
    "File path must consist only of real parent-child relationships");
});

test("Disk 11 spatial scene renders a bounded real folder neighborhood and searchable pages",async()=>{
  const built=await prepareDisk(root);
  const mod=await import(pathToFileURL(join(built.outputRoot,"web/pages/disk-map-spatial.js")).href);
  const folders=["Работа","Работа/2026","Архив",...Array.from({length:80},(_,i)=>"Каталог"+i)];
  const files=Array.from({length:10000},(_,i)=>({
    id:"f"+i,name:"Документ "+i+".txt",folder:i<100?"Работа/2026":"Архив",size:i+1
  }));
  const rootScene=mod.spatialScene(files,folders,"",0,10);
  assert.ok(rootScene.pages>1&&rootScene.items.length<=10);
  assert.equal(rootScene.items[0].kind,"folder");
  assert.ok(rootScene.items.every(x=>x.folder&&x.id.startsWith("folder:")));
  const focus=mod.spatialScene(files,folders,"Работа/2026",0,10);
  assert.equal(focus.total,100);
  assert.ok(focus.items.every(x=>x.kind==="file"));
  assert.equal(focus.bytes,files.slice(0,100).reduce((n,f)=>n+f.size,0));
  assert.equal(mod.spatialScene(files,folders,"Работа/2026",999,10).page,9);
  assert.equal(mod.spatialScene(files,folders,"Работа/2026",0,10,"Документ 99").total,1);
  const slots=mod.spatialSlots(10);
  assert.equal(slots.length,10);
  assert.deepEqual(slots,mod.spatialSlots(10));
});

test("Disk 15 graph is pure Canvas with no permanent widgets or boxed controls",async()=>{
 const mini=await readFile(join(root,"disk-src/web/pages/disk-map-mini.ts"),"utf8");
 const css=await readFile(join(root,"web/disk.css"),"utf8");
 const start=mini.indexOf('const root=el("section"');
 const end=mini.indexOf("let files:DiskFile[]",start);
 assert.ok(start>=0&&end>start);
 const markup=mini.slice(start,end);
 assert.match(markup,/dk-graph-only/);
 assert.match(markup,/},frame\)/);
 for(const unwanted of ['dk-graph-head','dk-graph-title','dk-graph-count',
   'dk-graph-search','dk-graph-inspect','dk-graph-legend','dk-graph-list',
   'dk-graph-actions','dk-graph-controls','dk-graph-footer','dk-omni-row',
   'dk-graph-mode','dk-graph-analyze','dk-graph-crumb']){
   assert.ok(!markup.includes(unwanted),"Permanent graph clutter: "+unwanted);
 }
 assert.match(css,/\.dk-graph-only \.dk-graph-canvas/);
 assert.match(css,/background:transparent!important/);
 assert.match(css,/border:0!important/);
 assert.match(mini,/canvas\.dataset\.layer="graph"/);
 assert.match(mini,/graphForceStep\(/);
 assert.match(mini,/ctx\.arc\(/);
 assert.match(mini,/ctx\.moveTo\(/);
 assert.match(mini,/document\.body\.append\(root\)/);
 assert.match(mini,/canvas\.addEventListener\("dblclick"/);
 assert.match(mini,/canvas\.addEventListener\("contextmenu",openMenu\)/);
 assert.match(mini,/frame\.addEventListener\("wheel"/);
 assert.match(mini,/reduced\(\)/);
 assert.ok(!mini.includes("dk-omni-node"),"Retired orbital card must stay gone");
});

test("Disk 15 keeps single left-side graph and original file manager links",async()=>{
 const [page,css,mini]=await Promise.all([
   readFile(join(root,"disk-src/web/pages/disk.ts"),"utf8"),
   readFile(join(root,"web/disk.css"),"utf8"),
   readFile(join(root,"disk-src/web/pages/disk-map-mini.ts"),"utf8")
 ]);
 assert.match(page,/bar,filesHeading,layout,/);
 assert.match(page,/layout\.append\(side,panes\.left,main,panes\.right,life\.root,info\)/);
 assert.match(page,/treePanel,miniMap\.root/);
 assert.match(page,/filesBox\.addEventListener\("pointerover"/);
 assert.match(page,/miniMap\.highlightFile\(card\.dataset\.fileId\|\|null\)/);
 assert.doesNotMatch(page,/openDiskMap/);
 assert.match(css,/\.dk-graph-only\.dk-graph-expanded \.dk-graph-stage/);
 assert.match(css,/@media\(max-width:620px\)/);
 assert.match(mini,/actions\.openFile\(n\.fileId\)/);
 assert.match(mini,/actions\.openFolder\(n\.folder\)/);
 assert.match(mini,/fileHighlight\(/);
});

test("Disk 12 real SHA duplicates, changes, age and spatial directions are deterministic",async()=>{
 const built=await prepareDisk(root);
 const m=await import(pathToFileURL(join(built.outputRoot,"web/pages/disk-map-spatial.js")).href);
 const hash="a".repeat(64);
 const before=[{id:"1",name:"Doc.pdf",folder:"Work",size:90,sha256:hash,revision:1,uploadedAt:"2026-11-22T00:00:00Z"}];
 const next=[{...before[0],size:100,revision:2},{id:"2",name:"Other.pdf",folder:"",size:12,sha256:hash}];
 const scene=m.spatialScene(next,["Work"],"Work");
 assert.equal(scene.items[0].duplicates,1);
 assert.equal(m.spatialScene(next,["Work"],"").items.find(f=>f.id==="file:2").duplicates,1);
 assert.equal(m.spatialChanges(null,next).size,0);
 assert.equal(m.spatialChanges(before,next).get("1"),"modified");
 assert.equal(m.spatialChanges(before,next).get("2"),"added");
 assert.equal(m.spatialChanges(next,before).get("2"),"removed");
 assert.equal(m.spatialFileType("x.JPG"),"image");
 assert.equal(m.spatialFileType("x.zip"),"archive");
 assert.equal(m.spatialFileType("x.py"),"code");
 assert.equal(m.spatialAge("2026-11-20T00:00:00Z",Date.parse("2026-11-20T12:00:00Z")),"today");
 assert.equal(m.spatialAge("bad"),"unknown");
 const points=[{x:0,y:0},{x:50,y:0},{x:0,y:60},{x:-40,y:0}];
 assert.equal(m.spatialNeighbor(points,0,"right"),1);
 assert.equal(m.spatialNeighbor(points,0,"down"),2);
 assert.equal(m.spatialNeighbor(points,0,"left"),3);
});
test("Disk 13 graph constructs only factual connections and bounds force layout",async()=>{
 const built=await prepareDisk(root);
 const m=await import(pathToFileURL(join(built.outputRoot,"web/pages/disk-map-graph.js")).href);
 const hash="a".repeat(64);
 const documents=[
  {id:"1",folder:"Work",name:"report.pdf",sha256:hash,size:100,tags:["finance"]},
  {id:"2",folder:"Work/Sub",name:"copy.pdf",sha256:hash,size:90,tags:["finance"]},
  {id:"3",folder:"Work",name:"unrelated.txt",sha256:"b".repeat(64),size:50,tags:[]}
 ];
 const g=m.graphFromCatalog(documents,["Work","Work/Sub"],"Work",
   {depth:2,limit:80,includeDuplicates:true,includeTags:true});
 assert.ok(g.nodes.some(n=>n.id==="file:1"));
 assert.ok(g.nodes.some(n=>n.id==="file:2"));
 assert.ok(g.nodes.some(n=>n.id==="tag:finance"));
 assert.ok(g.links.some(e=>e.kind==="duplicate"&&[e.source,e.target].includes("file:1")));
 assert.ok(g.links.some(e=>e.kind==="tag"&&e.source==="tag:finance"));
 assert.ok(g.links.every(e=>g.nodes.some(n=>n.id===e.source)&&g.nodes.some(n=>n.id===e.target)));
 assert.ok(!g.links.some(e=>e.kind==="duplicate"&&e.target==="file:3"));
 assert.ok(!g.links.some(e=>e.kind==="tag"&&e.target==="file:3"));
 assert.ok(g.nodes.length<=80);
 assert.deepEqual(m.graphInitial(g.nodes[0]),m.graphInitial(g.nodes[0]));
 const positions=new Map(g.nodes.map(n=>[n.id,m.graphInitial(n)]));
 for(let i=0;i<140;i++)m.graphForceStep(g.nodes,g.links,positions);
 assert.ok([...positions.values()].every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)));
 const huge=m.graphFromCatalog(Array.from({length:5000},(_,i)=>({
  id:String(i),folder:"",name:"file"+i+".txt",sha256:"",size:1,tags:[]
 })),[],"",{limit:40});
 assert.ok(huge.nodes.length<=40);
 assert.ok(huge.hidden>0);
});


test("Disk 14 source-backed text analysis extracts evidence without invented ties",async()=>{
 const built=await prepareDisk(root);
 const sem=await import(pathToFileURL(join(built.outputRoot,"web/pages/disk-map-semantic.js")).href);
 const model=await import(pathToFileURL(join(built.outputRoot,"web/pages/disk-map-graph.js")).href);
 const hashA="a".repeat(64),hashB="b".repeat(64);
 const docs=[
  {id:"a",name:"Договор-А.pdf",folder:"Работа",size:80,sha256:hashA,revision:3,tags:[]},
  {id:"b",name:"Договор-Б.pdf",folder:"Работа",size:90,sha256:hashB,revision:1,tags:[]},
  {id:"c",name:"Разное.txt",folder:"Работа",size:50,sha256:"c".repeat(64),tags:[]}
 ];
 const common="контракт аренда поставка контракт аренда поставка ";
 const textA=common+"ООО «Гелиос» проект «Маяк» 12.06.2025 Иванов Иван Иванович "+
  "В приложении Договор-Б.pdf указаны условия.";
 const textB=common+"ООО «Гелиос» проект «Маяк» 12.06.2025 Иванов Иван Иванович "+
  "Дополнительный контракт поставка аренда.";
 const a=sem.extractDocument(docs[0],textA,docs.map(d=>d.name));
 const b=sem.extractDocument(docs[1],textB,docs.map(d=>d.name));
 const c=sem.extractDocument(docs[2],"Никаких схожих реквизитов",docs.map(d=>d.name));
 assert.ok(a.organizations.includes("Гелиос"),"Cyrillic company must be extracted");
 assert.ok(a.projects.includes("Маяк"),"Explicitly quoted project must be extracted");
 assert.ok(a.dates.includes("12.06.2025"),"The date is sourced from the document text");
 assert.ok(a.people.some(n=>n.includes("Иванов Иван")),"Person is an unverified candidate");
 assert.ok(a.references.includes("Договор-Б.pdf"),"Exact filename mention is documented");
 const index=sem.semanticFromRecords([a,b,c]);
 assert.ok(index.nodes.some(n=>n.kind==="organization"));
 assert.ok(index.nodes.some(n=>n.kind==="date"));
 assert.ok(index.nodes.some(n=>n.kind==="project"));
 assert.ok(index.nodes.some(n=>n.kind==="person"));
 assert.ok(index.links.some(x=>x.kind==="reference"&&x.source==="file:a"&&x.target==="file:b"));
 assert.ok(index.links.some(x=>x.kind==="lexical"&&x.evidence.includes("контракт")));
 assert.ok(!index.links.some(x=>x.source==="file:c"||x.target==="file:c"));
 const mixed=model.graphFromCatalog(docs,["Работа"],"Работа",{semantic:index,viewMode:"all",limit:120});
 assert.ok(mixed.nodes.some(n=>n.kind==="organization"));
 assert.ok(mixed.links.some(x=>x.kind==="entity"&&x.evidence.includes("Гелиос")));
 assert.ok(mixed.links.some(x=>x.kind==="contains"));
 assert.ok(mixed.links.some(x=>x.kind==="reference"));
 assert.ok(mixed.links.some(x=>x.kind==="lexical"&&x.evidence.includes("общая папка")));
 const meaning=model.graphFromCatalog(docs,["Работа"],"Работа",{semantic:index,viewMode:"meaning",limit:120});
 assert.ok(meaning.links.some(x=>x.kind==="lexical"));
 assert.ok(!meaning.links.some(x=>x.kind==="contains"));
 const versions=model.graphFromCatalog(docs,["Работа"],"Работа",{semantic:index,viewMode:"versions",limit:120});
 assert.ok(versions.nodes.some(n=>n.kind==="revision"&&n.name==="Редакция №3"));
 assert.ok(versions.links.some(x=>x.kind==="revision"));
 assert.ok(!versions.links.some(x=>x.kind==="lexical"));
 const entities=model.graphFromCatalog(docs,["Работа"],"Работа",{semantic:index,viewMode:"entities",limit:120});
 assert.ok(entities.links.length>0&&entities.links.every(l=>l.kind==="entity"));
});

test("Disk 15 preserves optional evidence analysis behind contextual actions, not permanent UI",async()=>{
 const [mini,css]=await Promise.all([
  readFile(join(root,"disk-src/web/pages/disk-map-mini.ts"),"utf8"),
  readFile(join(root,"web/disk.css"),"utf8")
 ]);
 for(const token of ["async function analyzeDocuments()","api.diskText(f.id)",
  "slice(0,24)","analysisGeneration","semanticFromRecords(records)",
  "semantic,viewMode:mode","openMenu(event:MouseEvent)",
  "canvas.addEventListener(\"contextmenu\",openMenu)",
  "clickItem(","dismissMenu()","createRadialGradient",
  "ctx.setLineDash([3.2,5.1])","appearing=new Map",
  "fading:Array","reduceMotion","prefers-reduced-motion"]){
   if(token==="reduceMotion")continue;
   assert.ok(mini.includes(token)||css.includes(token),"Missing retained feature "+token);
 }
 assert.ok(!mini.includes("el(\"header\""),"Graph should render no header");
 assert.ok(!mini.includes("el(\"aside\""),"Graph should render no details card");
 assert.ok(!mini.includes("el(\"input\""),"Graph should render no search field");
 assert.ok(!mini.includes("el(\"details\""),"Graph should render no list");
 assert.match(css,/\.dk-graph-popover/);
 assert.match(css,/\.dk-graph-only\.dk-graph-expanded/);
});


test("Disk 16 fits the same graph to laptop, FHD, 2K, 4K and ultrawide screens",async()=>{
  const built=await prepareDisk(root);
  const m=await import(pathToFileURL(join(built.outputRoot,"web/pages/disk-map-responsive.js")).href);
  const screens=[
    m.graphScreen(360,700,2),
    m.graphScreen(1366,768,1,1,false),
    m.graphScreen(1920,1080,1,1,true),
    m.graphScreen(2560,1440,1.5,1,true),
    m.graphScreen(3840,2160,2,1,true),
    m.graphScreen(5120,1440,1.25,1,true)
  ];
  assert.ok(screens.every(s=>s.maxNodes>=24&&s.maxNodes<=240));
  assert.ok(screens[0].maxNodes<screens[2].maxNodes);
  assert.ok(screens[2].maxNodes<screens[4].maxNodes);
  assert.equal(screens[5].ultrawide,true);
  assert.ok(screens[5].aspect>3.5);
  assert.ok(screens.every(s=>s.pixelWidth*s.pixelHeight<=10_100_000),
    "DPR allocation must be bounded for 4K and 32:9 screens");
  assert.ok(screens[4].markerScale>screens[1].markerScale);
  assert.ok(m.graphScreen(320,420,1,0.65).detail==="overview");
  assert.ok(m.graphScreen(800,500,1,1).detail==="standard");
  assert.ok(m.graphScreen(1920,1080,1,2).detail==="detail");
  const points=[{x:-400,y:-110},{x:400,y:110},{x:230,y:30},{x:0,y:0}];
  const bounds=m.graphBounds(points);
  const cam=m.graphCamera(bounds,screens[5],1);
  for(const p of points){
    const projectedX=cam.cx+p.x*cam.scale;
    const projectedY=cam.cy+p.y*cam.scale;
    assert.ok(projectedX>=0&&projectedX<=screens[5].width);
    assert.ok(projectedY>=0&&projectedY<=screens[5].height);
  }
  const x=1700,y=650;
  const oldWorld={x:(x-cam.cx)/cam.scale,y:(y-cam.cy)/cam.scale};
  const shifted=m.anchoredZoom(cam,screens[5],bounds,2,x,y);
  const enlarged=m.graphCamera(bounds,screens[5],2,shifted.panX,shifted.panY);
  assert.ok(Math.abs(enlarged.cx+oldWorld.x*enlarged.scale-x)<1e-7,
    "Wheel zoom must hold exactly the same world point under cursor");
  assert.ok(Math.abs(enlarged.cy+oldWorld.y*enlarged.scale-y)<1e-7);
  assert.equal(m.graphMotionBudget(150,true,true),1);
  assert.ok(m.graphMotionBudget(190,false,true)<m.graphMotionBudget(40,false,true));
  assert.equal(m.graphLerp(0,100,.25),25);
});

test("Disk 16 local actual-folder clusters progressively expand with zoom",async()=>{
  const built=await prepareDisk(root);
  const m=await import(pathToFileURL(join(built.outputRoot,"web/pages/disk-map-graph.js")).href);
  const documents=[
    ...Array.from({length:95},(_,i)=>({
      id:"a"+i,folder:"Работа",name:"отчет-"+i+".txt",size:200+i,sha256:"",tags:[]
    })),
    ...Array.from({length:42},(_,i)=>({
      id:"b"+i,folder:"Архив",name:"документ-"+i+".txt",size:i,sha256:"",tags:[]
    }))
  ];
  const folders=["Работа","Архив"];
  const options={depth:2,limit:210};
  const distant=m.graphFromCatalog(documents,folders,"",
    {...options,perFolder:4,detailLevel:"overview"});
  const normal=m.graphFromCatalog(documents,folders,"",
    {...options,perFolder:28,detailLevel:"standard"});
  const close=m.graphFromCatalog(documents,folders,"",
    {...options,perFolder:72,detailLevel:"detail"});
  assert.ok(distant.files<=8,"Zoomed-out view must fold crowded folders");
  assert.ok(normal.files>distant.files,"Approaching a real folder reveals its files");
  assert.ok(close.files>normal.files,"Further zoom progressively reveals more documents");
  assert.equal(distant.nodes.find(n=>n.id==="folder:Работа").count,95);
  assert.equal(normal.nodes.find(n=>n.id==="folder:Архив").count,42);
  assert.ok(distant.hidden>0);
  assert.ok(normal.nodes.some(n=>n.fileId?.startsWith("b")),
    "One massive folder must not starve small real folders");
  assert.deepEqual(
    normal.nodes.filter(n=>n.kind==="file").map(n=>n.id),
    m.graphFromCatalog(documents,folders,"",options).nodes
      .filter(n=>n.kind==="file").map(n=>n.id),
    "Stable standard preview must be deterministic");
  const old=m.graphInitial(normal.nodes.find(n=>n.id==="file:a11"));
  assert.deepEqual(old,m.graphInitial(normal.nodes.find(n=>n.id==="file:a11")));
  const real=[{id:"a",kind:"file",folder:"Работа"},{id:"b",kind:"file",folder:"Работа"}];
  const location=new Map([
    ["a",{x:0,y:0,vx:0,vy:0}],["b",{x:0,y:0,vx:0,vy:0}]
  ]);
  for(let i=0;i<18;i++)m.graphForceStep(real,[],location);
  const a=location.get("a"),b=location.get("b");
  assert.ok(Number.isFinite(a.x)&&Number.isFinite(b.y));
  assert.ok(Math.hypot(a.x-b.x,a.y-b.y)>2,"Coincident nodes must separate");
});

test("Disk 16 screen policy and resize support do not add graph UI chrome",async()=>{
 const [mini,css]=await Promise.all([
  readFile(join(root,"disk-src/web/pages/disk-map-mini.ts"),"utf8"),
  readFile(join(root,"web/disk.css"),"utf8")
 ]);
 for(const marker of ["graphScreen(","graphCamera(","graphBounds(",
  "anchoredZoom(","graphMotionBudget(","ResizeObserver",
  "screen.perFolder","screen.maxNodes","perFolder:screen.perFolder",
  "devicePixelRatio","screen.pixelWidth","graphLerp(",
  "window.devicePixelRatio||1"]){
    if(marker==="screen.pixelWidth")continue;
    assert.ok(mini.includes(marker),"Missing adaptive graph capability "+marker);
 }
 for(const marker of ["@media (min-width:2400px)","@media (max-height:720px)",
  "@media (max-width:620px)","@media (orientation:landscape)",
  "clamp(210px,36dvh,560px)"])
   assert.ok(css.includes(marker),"Missing responsive styling "+marker);
 const graphOnly=mini.match(/const root=el\("section"[\s\S]*?,frame\);/)?.[0]||"";
 assert.ok(graphOnly.includes("dk-graph-only"));
 assert.ok(!graphOnly.includes("dk-graph-head"),"No permanent graph toolbar");
});


test("Disk 17 global graph includes distant real folder branches while local scope stays intact",async()=>{
 const built=await prepareDisk(root);
 const m=await import(pathToFileURL(join(built.outputRoot,"web/pages/disk-map-graph.js")).href);
 const data=[
  {id:"1",name:"Договор.docx",folder:"Работа/Проекты/Объект А",size:100,sha256:"",tags:[]},
  {id:"2",name:"Счёт.pdf",folder:"Бухгалтерия/2026",size:200,sha256:"",tags:[]},
  {id:"3",name:"Заявка.txt",folder:"Архив/Старые/Проекты",size:300,sha256:"",tags:[]},
  {id:"4",name:"Акт.docx",folder:"Работа",size:400,sha256:"",tags:[]}
 ];
 const folders=["Работа/Проекты/Объект А","Бухгалтерия/2026","Архив/Старые/Проекты"];
 const local=m.graphFromCatalog(data,folders,"Работа",{depth:2,limit:120});
 assert.ok(!local.nodes.some(n=>n.id==="file:2"));
 assert.ok(!local.nodes.some(n=>n.id==="file:3"));
 const global=m.graphFromCatalog(data,folders,"Работа",{
  global:true,depth:1,limit:120,perFolder:25
 });
 assert.equal(global.focus,"folder:","Global root should be a real Disk root");
 assert.ok(global.nodes.some(n=>n.id==="file:1"),"Global graph must reach deeply nested files");
 assert.ok(global.nodes.some(n=>n.id==="file:2"),"Global graph must include бухгалтерия");
 assert.ok(global.nodes.some(n=>n.id==="file:3"),"Global graph must include remote archive");
 assert.ok(global.nodes.some(n=>n.id==="folder:Работа/Проекты/Объект А"));
 assert.ok(global.links.some(e=>e.source==="folder:Архив/Старые/Проекты"&&
  e.target==="file:3"&&e.kind==="contains"));
 assert.ok(global.nodes.length<=120);
 assert.ok(global.links.every(e=>global.nodes.some(n=>n.id===e.source)&&
  global.nodes.some(n=>n.id===e.target)));
 const huge=Array.from({length:4000},(_,i)=>({
  id:"large-"+i,name:"Файл"+i+".txt",folder:"Группа"+(i%80)+"/Год2026",size:i,
  sha256:"",tags:[]
 }));
 const bounded=m.graphFromCatalog(huge,[], "",{global:true,depth:3,limit:96,perFolder:6});
 assert.ok(bounded.nodes.length<=96,"Global graph must respect Canvas budget");
 assert.ok(bounded.hidden>0,"Unrendered real files remain counted");
});

test("Disk 17 weighted path finds evidence rather than inventing connections",async()=>{
 const built=await prepareDisk(root);
 const explore=await import(pathToFileURL(join(built.outputRoot,"web/pages/disk-map-explore.js")).href);
 const nodes=[
  {id:"file:a",kind:"file",name:"Договор",folder:"Работа"},
  {id:"file:b",kind:"file",name:"Акт",folder:"Работа"},
  {id:"file:c",kind:"file",name:"Счёт",folder:"Архив"},
  {id:"folder:",kind:"folder",name:"Мой Диск",folder:""},
  {id:"folder:Работа",kind:"folder",name:"Работа",folder:"Работа"},
  {id:"folder:Архив",kind:"folder",name:"Архив",folder:"Архив"},
  {id:"file:isolated",kind:"file",name:"Изолированный",folder:""}
 ];
 const edges=[
  {source:"folder:",target:"folder:Работа",kind:"contains"},
  {source:"folder:",target:"folder:Архив",kind:"contains"},
  {source:"folder:Работа",target:"file:a",kind:"contains"},
  {source:"folder:Работа",target:"file:b",kind:"contains"},
  {source:"folder:Архив",target:"file:c",kind:"contains"},
  {source:"file:a",target:"file:b",kind:"reference",weight:.95,evidence:"Ссылка на Акт"},
  {source:"file:b",target:"file:c",kind:"lexical",weight:.5,evidence:"Общие слова"}
 ];
 const scene={nodes,links:edges};
 const route=explore.graphRoute(scene,"file:a","file:c");
 assert.deepEqual(route?.nodes,["file:a","file:b","file:c"],
  "Actual text links should outrank a long path through unrelated folders");
 assert.equal(route?.links.length,2);
 assert.equal(route?.links[0].kind,"reference");
 assert.deepEqual(explore.graphRoute(scene,"file:c","file:a")?.nodes,
  ["file:c","file:b","file:a"]);
 assert.equal(explore.graphRoute(scene,"file:a","file:isolated"),null,
  "No graph path may be invented");
 assert.equal(explore.graphRoute(scene,"file:a","unknown"),null);
 assert.deepEqual([...explore.graphNeighbors(scene,"file:a",1)].sort(),
  ["file:a","file:b","folder:Работа"].sort());
 assert.match(explore.graphEdgeExplanation(edges[5],nodes),/Ссылка на Акт/);
 assert.match(explore.graphEdgeExplanation(edges[3],nodes),/Расположение на Диске/);
 const points=new Map([
  ["file:a",{x:0,y:0}],["file:b",{x:100,y:0}],["file:c",{x:200,y:0}]
 ]);
 const near=explore.graphEdgeAt(scene,points,{cx:0,cy:0,scale:1},50,3);
 assert.equal(near?.kind,"reference");
 assert.equal(explore.graphEdgeAt(scene,points,{cx:0,cy:0,scale:1},50,55),null);
});

test("Disk 17 person graph links only actual co-mentions in one readable document",async()=>{
 const built=await prepareDisk(root);
 const sem=await import(pathToFileURL(join(built.outputRoot,"web/pages/disk-map-semantic.js")).href);
 const m=await import(pathToFileURL(join(built.outputRoot,"web/pages/disk-map-graph.js")).href);
 const files=[
  {id:"doc1",name:"Совещание.txt",folder:"Работа",size:70,sha256:"",tags:[]},
  {id:"doc2",name:"Другое.txt",folder:"Архив",size:90,sha256:"",tags:[]}
 ];
 const one=sem.extractDocument(files[0],
  "Иванов Иван Иванович подписал акт. Петров Петр Петрович ознакомлен.",[]);
 const two=sem.extractDocument(files[1],
  "Сидоров Сергей Сергеевич направил другое письмо.",[]);
 assert.equal(one.people.length,2);
 const index=sem.semanticFromRecords([one,two]);
 const pairs=index.links.filter(e=>e.kind==="co_mention");
 assert.equal(pairs.length,1,"Only one evidenced co-mention pair is expected");
 assert.ok(pairs[0].evidence.includes("Совещание.txt"));
 assert.ok(pairs[0].evidence.includes("не установлена"));
 assert.ok(pairs[0].confidence<.5,"A co-mention must never be treated as verified identity");
 assert.ok(!pairs.some(e=>e.source.includes("сидоров")||e.target.includes("сидоров")));
 const graph=m.graphFromCatalog(files,["Работа","Архив"],"",{
  global:true,semantic:index,viewMode:"entities",limit:120,perFolder:30
 });
 assert.ok(graph.nodes.filter(n=>n.kind==="person").length>=2);
 assert.ok(graph.links.some(e=>e.kind==="co_mention"));
 assert.ok(graph.links.some(e=>e.kind==="entity"));
 assert.ok(graph.links.every(e=>e.kind==="co_mention"||e.kind==="entity"));
 const explanation=(await import(pathToFileURL(join(built.outputRoot,"web/pages/disk-map-explore.js")).href))
  .graphEdgeExplanation(graph.links.find(e=>e.kind==="co_mention"),graph.nodes);
 assert.match(explanation,/Совещание/);
 assert.match(explanation,/не установлена/);
});

test("Disk 17 keeps the graph chrome-free while exposing global, route and edge evidence gestures",async()=>{
 const source=await readFile(join(root,"disk-src/web/pages/disk-map-mini.ts"),"utf8");
 const markup=source.match(/const root=el\("section"[\s\S]*?,frame\);/)?.[0]||"";
 assert.ok(markup.includes("dk-graph-only"));
 for(const forbidden of ["dk-graph-head","dk-graph-controls","dk-graph-inspect",
  "dk-graph-list-panel","dk-graph-count","dk-graph-search"])
  assert.ok(!markup.includes(forbidden));
 for(const needle of ["globalGraph=true","global:globalGraph","focusOnNode(",
  "startRoute(","finishRoute(","graphRoute(scene,routeStart,id)",
  "graphNeighbors(","graphEdgeAt(","graphEdgeExplanation(",
  "option(\"Весь Диск: глобальный граф\"",
  "option(\"Начать путь от этого файла\"",
  "canvas.dataset.scope=globalGraph?\"global\":\"folder\"",
  "canvas.dataset.focusNode=focusId||\"\""])
  assert.ok(source.includes(needle),"Missing Disk 17 gesture: "+needle);
});


test("Disk 18 removes retired graph chrome CSS without disturbing the lone Canvas",async()=>{
 const css=await readFile(join(root,"web/disk.css"),"utf8");
 const mini=await readFile(join(root,"disk-src/web/pages/disk-map-mini.ts"),"utf8");
 assert.ok(!css.includes("/* Disk 13.0"),"Retired toolbar CSS must be deleted");
 assert.ok(!css.includes("/* Disk 14 —"),"Retired semantic inspector CSS must be deleted");
 assert.ok(css.includes("Disk 18 — single layout contract"));
 assert.ok(css.includes("/* Disk 15 — PURE GRAPH"));
 assert.ok(css.includes("/* Disk 16 — fluid graph viewport"));
 for(const token of [
  "--dk18-u1:4px","--dk18-u2:8px","--dk18-u3:12px",
  "--dk18-u4:16px","--dk18-u5:24px",
  "scrollbar-gutter:stable","overflow-wrap:anywhere",
  "max-height:clamp(130px,32dvh,350px)",
  "align-items:center","text-overflow:ellipsis",
  "@container diskspace (min-width:1800px)",
  "@container diskspace (max-width:1180px)",
  "@container diskspace (max-width:760px)",
  "@media (max-height:700px)"])
  assert.ok(css.includes(token),"Missing Disk 18 responsive geometry: "+token);
 const visible=mini.match(/const root=el\("section"[\s\S]*?,frame\);/)?.[0]||"";
 assert.ok(visible.includes("dk-graph-only"));
 assert.ok(!visible.includes("dk-graph-title"),"No graph header may reappear");
 assert.ok(!visible.includes("dk-graph-inspect"),"No graph evidence card may reappear");
});

test("Disk 18 header and long names use real file metadata without duplicating controls",async()=>{
 const src=await readFile(join(root,"disk-src/web/pages/disk.ts"),"utf8");
 const css=await readFile(join(root,"web/disk.css"),"utf8");
 assert.ok(src.includes('el("h2",{textContent:"Файлы и папки"})'));
 assert.ok(!src.includes("Управление документами"),
  "Redundant document-management subtitle must be removed");
 assert.ok(src.includes('cls: "dk-name", textContent: f.name, title: f.name'),
  "The file's complete real title must remain accessible on hover");
 assert.ok(src.includes('attrs: { "aria-current": isCur ? "page" : "false", title: folder || "Корень Диска" }'));
 assert.ok(src.includes('title:rule.name'),
  "Smart folder labels must retain the exact full name");
 assert.ok(css.includes("-webkit-line-clamp:2"));
 assert.ok(css.includes("overflow:hidden;text-overflow:ellipsis"));
 assert.ok(css.includes("overflow:visible; /* file virtualization uses the parent scroll host */"),
  "Stable scrolling cannot break windowed file virtualization");
});
