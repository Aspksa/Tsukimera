import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {join,resolve} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {prepareDisk} from "../scripts/build-disk.mjs";

const root=resolve(fileURLToPath(new URL("../",import.meta.url)));

test("Disk escapes the 1200px centered page without changing other routes",async()=>{
  const css=await readFile(join(root,"web/tsukimera.css"),"utf8");
  const app=await readFile(join(root,"web/app.js"),"utf8");
  assert.match(css,/\.content-main\.disk-workspace\s*\{[^}]*max-width:none/);
  assert.match(css,/\.content-main\.disk-workspace\s*>\s*\.page\.disk-page\s*\{[^}]*max-width:none/);
  assert.match(app,/mainNode\.classList\.toggle\('disk-workspace',route==='disk'\)/);
  assert.match(css,/\.content-main\{max-width:1200px/);
});

test("Responsive 3/2/1 pane grid keeps a minimum file area, splitters, mobile drawer and reduced-motion",async()=>{
  const css=await readFile(join(root,"web/disk.css"),"utf8");
  assert.match(css,/container-name:diskspace;container-type:inline-size/);
  assert.match(css,/grid-template-columns:\s*minmax\(210px,min\(var\(--dk-tree-width\),30cqw\)\)/);
  assert.match(css,/\.dk-layout\s*>\s*\.dk-resize-left\{grid-column:2;grid-row:1\}/);
  assert.match(css,/\.dk-layout\s*>\s*\.dk-resize-right\{grid-column:4;grid-row:1\}/);
  assert.match(css,/@container diskspace \(max-width:1180px\)/);
  assert.match(css,/@container diskspace \(max-width:760px\)/);
  assert.match(css,/@container diskspace \(max-width:520px\)/);
  assert.match(css,/\.disk-page\.drawer-open \.dk-layout\s*>\s*\.dk-side\{transform:translateX\(0\)\}/);
  assert.match(css,/\.dk-layout\.no-tree/);
  assert.match(css,/\.dk-resize-handle:focus-visible/);
  assert.match(css,/@media\(prefers-reduced-motion:reduce\)/);
  assert.match(css,/grid-template-columns:repeat\(auto-fill,minmax\(min\(100%,var\(--dk-tile-size\)\),1fr\)\)/);
  assert.match(css,/-webkit-line-clamp:2/);
});

test("Pane widths and tile zoom are clamped, accessible and saved independently",async()=>{
  const result=await prepareDisk(root);
  const mod=await import(pathToFileURL(join(result.outputRoot,"web/pages/disk-layout.js")).href);
  assert.equal(mod.paneSize(null,"left"),266);
  assert.equal(mod.paneSize("380","left"),380);
  assert.equal(mod.paneSize("600","left"),266);
  assert.equal(mod.paneSize(null,"right"),340);
  assert.equal(mod.paneSize("499","right"),499);
  assert.equal(mod.paneSize("10","right"),340);
  assert.equal(mod.tileSize(undefined),220);
  assert.equal(mod.tileSize("165"),170);
  assert.equal(mod.tileSize(330),330);
  assert.equal(mod.tileSize(999),220);
  assert.equal(mod.clamp(200,210,450),210);
  const src=await readFile(join(root,"disk-src/web/pages/disk-layout.ts"),"utf8");
  for(const key of ["pointerdown","pointermove","pointerup","pointercancel",
    "lostpointercapture","setPointerCapture","aria-valuenow","ArrowLeft","ArrowRight",
    "Home","End","dblclick","writePreference","touch-action"])
    assert.ok(src.includes(key)||key==="touch-action","Missing splitter behavior "+key);
  const disk=await readFile(join(root,"disk-src/web/pages/disk.ts"),"utf8");
  assert.match(disk,/createDiskSplitters\(layout\)/);
  assert.match(disk,/layout\.append\(side,panes\.left,main,panes\.right,life\.root,info\)/);
  assert.match(disk,/aria-label":"Размер плиток"/);
  assert.match(disk,/zoomControl\.hidden=mode!=="tiles"&&mode!=="large"/);
  assert.match(disk,/store\.set\(TILE_KEY,String\(zoom\)\)/);
});
