import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {join,resolve} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {prepareDisk} from "../scripts/build-disk.mjs";

const root=resolve(fileURLToPath(new URL("../",import.meta.url)));

test("UX8 automatic sidebars adapt before manual choice; saved widths remain compatible",async()=>{
  const built=await prepareDisk(root);
  const layout=await import(pathToFileURL(join(built.outputRoot,"web/pages/disk-layout.js")).href);
  assert.equal(layout.paneSize(null,"left"),266);
  assert.equal(layout.paneSize("380","left"),380);
  assert.equal(layout.paneSize("340","right"),340);
  assert.equal(layout.autoPaneSize(1920,"left"),360);
  assert.equal(layout.autoPaneSize(1920,"right"),440);
  assert.equal(layout.autoPaneSize(1200,"left"),228);
  assert.equal(layout.autoPaneSize(1200,"right"),282);
  assert.equal(layout.autoPaneSize(500,"left"),210);
  assert.equal(layout.autoPaneSize(500,"right"),260);
  const source=await readFile(join(root,"disk-src/web/pages/disk-layout.ts"),"utf8");
  assert.match(source,/if\(!manualLeft\)/);
  assert.match(source,/if\(!manualRight\)/);
  assert.match(source,/writePreference/);
  assert.match(source,/watcher\.disconnect/);
});

test("UX8 focus remains reversible and UI respects user file actions, navigation and reduced motion",async()=>{
  const source=await readFile(join(root,"disk-src/web/pages/disk.ts"),"utf8");
  const css=await readFile(join(root,"web/disk.css"),"utf8");
  assert.match(source,/dk-focus-btn/);
  assert.match(source,/page\.classList\.toggle\("dk-focus",focus\)/);
  assert.match(source,/focusBtn\.setAttribute\("aria-pressed",String\(focus\)\)/);
  assert.match(source,/dk-experience-v8/);
  assert.match(source,/dk-file-labels/);
  assert.match(source,/dk-move-hint/);
  assert.match(source,/draggingCount/);
  assert.match(source,/role:"status","aria-live":"polite"/);
  assert.match(source,/const panes=createDiskSplitters\(layout\)/);
  assert.match(source,/layout\.append\(side,panes\.left,main,panes\.right,life\.root,info\)/);
  assert.match(source,/fileWindow\(shown\.length/);
  assert.match(source,/renderTree\(\)/);
  assert.match(source,/showLinked\(\)/);
  assert.match(source,/openViewer\(file\)/);
  assert.match(css,/\.dk-experience-v8 \.dk-head\{\s*position:sticky/);
  assert.match(css,/\.dk-experience-v8\.dk-focus \.dk-layout > \.dk-side/);
  assert.match(css,/\.dk-experience-v8\.dk-focus \.dk-layout > \.dk-main/);
  assert.match(css,/\.dk-experience-v8 \.dk-kind-label/);
  assert.match(css,/\.dk-experience-v8 \.dk-move-hint/);
  assert.match(css,/@media\(prefers-reduced-motion:reduce\)/);
  assert.match(css,/\.dk-experience-v8 \.dk-file:hover/);
  assert.match(css,/\.dk-experience-v8 \.dkl-compact \.dkl-areas/);
  assert.match(css,/\.dk-experience-v8 \.dkl-all-toggle/);
  assert.match(css,/\.dkx-live-map \.dkx-map-open/);
});

test("UX8 Life preserves original 150-metric computations and supports all-at-once browsing",async()=>{
  const life=await readFile(join(root,"disk-src/web/pages/disk-life.ts"),"utf8");
  const source=await readFile(join(root,"disk-src/server/disk-life.ts"),"utf8");
  assert.match(life,/showAll&&expanded\?searchLifeMetrics\(d.metrics/);
  assert.match(life,/textContent:"Открыть аналитику · все 150 показателей"/);
  assert.match(life,/cls:"dkl-all-toggle"/);
  assert.match(life,/allBtn\.setAttribute\("aria-pressed",String\(showAll\)\)/);
  assert.match(source,/150/);
});

test("UX8 map provides zoom animation, selected path highlighting and keyboard open",async()=>{
  const source=await readFile(join(root,"disk-src/web/pages/disk-map.ts"),"utf8");
  assert.match(source,/active:MapNode\|null=null/);
  assert.match(source,/const connected=new Set<string>\(\)/);
  assert.match(source,/const choose=\(node:MapNode\|null\)/);
  assert.match(source,/requestAnimationFrame\(frame\)/);
  assert.match(source,/if\(event\.key==="Enter"&&active\)/);
  assert.match(source,/openSelected\.addEventListener\("click"/);
  assert.match(source,/cancelAnimationFrame\(zoomFrame\)/);
  assert.match(source,/prefersReduced\(\)/);
});
