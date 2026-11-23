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


test("Disk 11 keeps one spatial map above the existing file manager and connects real actions",async()=>{
 const [page,mini,css]=await Promise.all([
  readFile(join(root,"disk-src/web/pages/disk.ts"),"utf8"),
  readFile(join(root,"disk-src/web/pages/disk-map-mini.ts"),"utf8"),
  readFile(join(root,"web/disk.css"),"utf8"),
 ]);
 assert.match(page,/bar,miniMap\.root,filesHeading,layout,/);
 assert.match(page,/miniMap\.update\(all,folders,current\)/);
 assert.match(page,/createMiniDiskMap/);
 assert.doesNotMatch(page,/openDiskMap/,"The retired graph must not be exposed as a second map");
 for(const x of ["spatialScene(files,folders,current,page,limit,filter)",
  "actions.openFile(item.id.slice(5))","actions.openFolder(folder)",
  "dk-omni-trail","dk-omni-workspace","dk-omni-list","dk-omni-search",
  "touchmove","pointermove","canvas.dataset.layer=\"spatial\""])
   assert.ok(mini.includes(x),"Missing spatial navigation contract "+x);
 assert.match(css,/\.dk-omni-explorer/);
 assert.match(css,/@media\(prefers-reduced-motion:reduce\)/);
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

test("Disk 11 retains validated SQLite viewport and browser gestures safely",async()=>{
  const built=await prepareDisk(root);
  const mod=await import(pathToFileURL(join(built.outputRoot,"web/pages/disk-map-mini-model.js")).href);
  assert.deepEqual(mod.normalizeMiniView(null),{zoom:1,panX:0,panY:0,focus:""});
  assert.deepEqual(mod.normalizeMiniView({zoom:Infinity,panX:"oops",panY:NaN,focus:4}),
    {zoom:1,panX:0,panY:0,focus:""});
  assert.deepEqual(mod.normalizeMiniView({zoom:99,panX:99999,panY:-99999,focus:"A/B"}),
    {zoom:9,panX:3000,panY:-3000,focus:"A/B"});
  assert.equal(mod.MINI_VIEW_KEY,"tsukimera.disk.minimap.view.v1");
  const source=await readFile(join(root,"disk-src/web/pages/disk-map-mini.ts"),"utf8");
  for(const item of ["writePreference(MINI_VIEW_KEY,JSON.stringify(view))",
   "frame.addEventListener(\"wheel\"","frame.addEventListener(\"touchmove\"",
   "frame.addEventListener(\"pointerdown\"","if(queued||!root.isConnected)return",
   "ctx.ellipse(cx,cy"])
    assert.ok(source.includes(item),"Missing viewport safety behavior "+item);
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

test("Disk 11 replaces orbit lines with focus-centered controls, bounded painting and accessibility",async()=>{
 const source=await readFile(join(root,"disk-src/web/pages/disk-map-mini.ts"),"utf8");
 for(const token of ["dk-omni-focus","dk-omni-node","dk-omni-row",
  "stepBack()","navigate(parentOf(current))","scene.items.forEach",
  "ctx.moveTo(cx,cy)","canvas.dataset.nodes",
  "aria-label","role:\"status\"","reduced","ResizeObserver"])
   assert.ok(source.includes(token),"Missing spatial explorer behavior: "+token);
 assert.ok(!source.includes("orbitLayout("),"Previous orbital layout must not render");
});

test("Disk 11 all Disk entry points use the replacement spatial map without changing files",async()=>{
 const [page,css,mini]=await Promise.all([
   readFile(join(root,"disk-src/web/pages/disk.ts"),"utf8"),
   readFile(join(root,"web/disk.css"),"utf8"),
   readFile(join(root,"disk-src/web/pages/disk-map-mini.ts"),"utf8"),
 ]);
 assert.match(page,/page\.append\(el\("h1"[\s\S]*?bar,miniMap\.root,filesHeading,layout,/);
 assert.match(page,/layout\.append\(side,panes\.left,main,panes\.right,life\.root,info\)/);
 assert.match(page,/miniMap\.update\(all,folders,current\)/);
 assert.doesNotMatch(page,/openDiskMap/);
 assert.match(page,/miniMap\.root\.scrollIntoView/);
 assert.match(mini,/actions\.openFile\(item\.id\.slice\(5\)\)/);
 assert.match(css,/\.dk-omni-workspace\{display:grid/);
 assert.match(css,/\.dk-map-first\.dk-focus>.dk-omni-explorer/);
 assert.match(css,/@container diskspace \(max-width:720px\)/);
});
