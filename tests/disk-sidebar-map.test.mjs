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
