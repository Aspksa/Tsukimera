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


test("Disk rail swaps Sections for an interactive, bounded source-backed mini Canvas",async()=>{
  const [page,mini,styles]=await Promise.all([
    readFile(join(root,"disk-src/web/pages/disk.ts"),"utf8"),
    readFile(join(root,"disk-src/web/pages/disk-map-mini.ts"),"utf8"),
    readFile(join(root,"web/disk.css"),"utf8"),
  ]);
  assert.match(page,/treePanel,miniMap\.root\)/);
  assert.match(page,/label: "Разделы и умные папки"/);
  assert.match(page,/const openSections=\(\)=>/);
  assert.match(page,/sectionsRegion\.hidden=false/);
  assert.match(page,/miniMap\.update\(all,folders,current\)/);
  assert.match(page,/title:"Разделы и умные папки"/);
  for(const wanted of ["miniGraphFromCatalog(files,folders,focus,detail)",
    "mapNodeRadius(n,graph.bytes)","canvas.addEventListener(\"wheel\"",
    "canvas.addEventListener(\"pointermove\"","canvas.addEventListener(\"click\"",
    "canvas.addEventListener(\"dblclick\"","canvas.addEventListener(\"keydown\"",
    "actions.openFull()","actions.openFile(node.id.slice(5))",
    "actions.openFolder(node.folder)"])
    assert.ok(mini.includes(wanted),"Mini map must keep real data and navigable nodes: "+wanted);
  assert.match(styles,/\.dk-mini-map-frame\{/);
  assert.match(styles,/\.dk-sections-dialog \.dk-sections\{/);
  assert.match(styles,/\.dk-mini-map-canvas:focus-visible/);
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

test("Disk 8.3 saved map viewport validates corrupt data and clamps scale/pan safely",async()=>{
  const built=await prepareDisk(root);
  const mod=await import(pathToFileURL(join(built.outputRoot,"web/pages/disk-map-mini-model.js")).href);
  assert.deepEqual(mod.normalizeMiniView(null),{zoom:1,panX:0,panY:0,focus:""});
  assert.deepEqual(mod.normalizeMiniView({zoom:Infinity,panX:"oops",panY:NaN,focus:4}),
    {zoom:1,panX:0,panY:0,focus:""});
  assert.deepEqual(mod.normalizeMiniView({zoom:99,panX:99999,panY:-99999,focus:"A/B"}),
    {zoom:9,panX:3000,panY:-3000,focus:"A/B"});
  assert.equal(mod.MINI_VIEW_KEY,"tsukimera.disk.minimap.view.v1");
  const source=await readFile(join(root,"disk-src/web/pages/disk-map-mini.ts"),"utf8");
  assert.match(source,/writePreference\(MINI_VIEW_KEY,JSON\.stringify\(view\)\)/);
  assert.match(source,/ctx\.roundRect\(/);
  assert.match(source,/for\(let k=0;k<6;k\+\+\)/);
  assert.match(source,/ctx\.lineTo\(x\+r,y\)/);
  assert.match(source,/if\(Math\.max\(from\.x,to\.x\)<-margin/);
  assert.match(source,/if\(queued\|\|!root\.isConnected\)return/);
});


test("Disk 8.3 SQLite and backup allowlists accept both section layout and persistent mini-map view",async()=>{
  const [db,server]=await Promise.all([
    readFile(join(root,"scripts/tsukimera-db.mjs"),"utf8"),
    readFile(join(root,"scripts/server.mjs"),"utf8"),
  ]);
  for(const key of ["tsukimera.disk.sections.v1","tsukimera.disk.minimap.view.v1"]){
    assert.ok(db.includes('"'+key+'"'),"SQLite must allow "+key);
    assert.ok(server.includes('"'+key+'"'),"Backup restore must allow "+key);
  }
});
