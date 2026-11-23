import {spawn} from "node:child_process";
import {mkdtemp,readFile,rm,mkdir,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import assert from "node:assert/strict";

// Inspect the real browser layout using CDP, without Playwright or npm packages.
const origin=process.argv[2];
if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin||""))throw Error("Supply loopback server origin");
// The headless browser sees a real local document: analytics must be tested
// against server calculations, not mocked cards or made-up numbers.
const fixture=Buffer.from(("Документ Tsukimera содержит слова и предложения. Повторяем текст для локального анализа. ").repeat(40),"utf8");
const uploaded=await fetch(origin+"/api/disk/files/binary?name="+encodeURIComponent("Тест-жизни-Диска.txt")+"&folder=",{
  method:"POST",headers:{"X-Tsukimera-Request":"1","Content-Type":"application/octet-stream"},body:fixture
});
assert.equal(uploaded.status,201,"Could not seed Disk Life browser fixture: "+await uploaded.text());
for(const name of ["Работа","Работа/2026"]){
  const folder=await fetch(origin+"/api/disk/folders",{
    method:"POST",headers:{"X-Tsukimera-Request":"1","Content-Type":"application/json"},
    body:JSON.stringify({name})
  });
  assert.equal(folder.status,201,"Could not seed hierarchical Disk folder: "+name+" / "+await folder.text());
}
const dir=await mkdtemp(join(tmpdir(),"tsukimera-layout-chrome-"));
const chrome=spawn("google-chrome",[
  "--headless=new","--no-sandbox","--disable-gpu","--disable-dev-shm-usage",
  "--no-first-run","--no-default-browser-check","--remote-allow-origins=*",
  "--remote-debugging-port=0","--user-data-dir="+dir,origin+"/#/disk"
],{stdio:"ignore"});
const pause=ms=>new Promise(ok=>setTimeout(ok,ms));
let socket;
try{
  let port;
  for(let n=0;n<90;n++){
    try{
      const lines=(await readFile(join(dir,"DevToolsActivePort"),"utf8")).split("\n");
      port=Number(lines[0]);if(Number.isInteger(port)&&port>0)break;
    }catch{}
    if(chrome.exitCode!==null)throw Error("Chrome failed to start");
    await pause(200);
  }
  if(!port)throw Error("Chrome debugging endpoint unavailable");
  const pages=await(await fetch("http://127.0.0.1:"+port+"/json/list")).json();
  const tab=pages.find(page=>page.type==="page"&&page.webSocketDebuggerUrl);
  if(!tab)throw Error("No Chrome tab");
  socket=new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{
    socket.addEventListener("open",resolve,{once:true});
    socket.addEventListener("error",reject,{once:true});
  });
  let seq=0;const calls=new Map();
  socket.addEventListener("message",event=>{
    const message=JSON.parse(event.data.toString());
    if(!message.id)return;
    const pending=calls.get(message.id);
    if(!pending)return;
    calls.delete(message.id);
    if(message.error)pending.reject(Error(message.error.message));
    else pending.resolve(message.result);
  });
  function send(method,params={}){
    const id=++seq;
    return new Promise((resolve,reject)=>{
      calls.set(id,{resolve,reject});
      socket.send(JSON.stringify({id,method,params}));
    });
  }
  async function evaluate(expression){
    const result=await send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});
    if(result.exceptionDetails)throw Error(result.exceptionDetails.text||JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  }
  async function device(width,height=960,dpr=1){
    await send("Emulation.setDeviceMetricsOverride",{
      width,height,deviceScaleFactor:dpr,mobile:width<600
    });
    await pause(300);
  }
  // Disk 18: real Chrome PNGs and measurable alignment on every viewport.
  const screenshotFolder=join(process.cwd(),".runtime","disk-ui-screenshots");
  async function screenshot(label){
    const captured=await send("Page.captureScreenshot",{format:"png",fromSurface:true});
    const bytes=Buffer.from(captured.data||"","base64");
    assert.equal(bytes.subarray(0,8).toString("hex"),"89504e470d0a1a0a");
    assert.ok(bytes.length>6000,"Empty screenshot: "+label);
    const w=bytes.readUInt32BE(16),h=bytes.readUInt32BE(20);
    assert.ok(w>240&&h>200,"Invalid PNG dimensions: "+label);
    await mkdir(screenshotFolder,{recursive:true});
    await writeFile(join(screenshotFolder,label+".png"),bytes);
    return {width:w,height:h,bytes:bytes.length};
  }
  const diskAlignment="("+(()=>{
    const r=q=>{const rect=document.querySelector(q)?.getBoundingClientRect();
      return rect?{x:rect.x,y:rect.y,right:rect.right,bottom:rect.bottom,
        width:rect.width,height:rect.height}:null;};
    const search=r(".dk-search"),actions=r(".dk-bar-actions"),side=r(".dk-side"),
      tree=r(".dk-tree-panel"),graph=r(".dk-graph-stage"),files=r(".dk-main");
    const overlaps=(a,b)=>!!(a&&b&&a.x<b.right-1&&b.x<a.right-1&&
      a.y<b.bottom-1&&b.y<a.bottom-1);
    const element=document.querySelector(".dk-graph-stage");
    return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,
      dpr:devicePixelRatio,filesWidth:files?.width,sideWidth:side?.width,
      searchActionOverlap:overlaps(search,actions),
      folderGraphOverlap:overlaps(tree,graph),
      border:element?getComputedStyle(element).borderTopWidth:null,
      background:element?getComputedStyle(element).backgroundColor:null,
      canvasCount:document.querySelectorAll(".dk-graph-only canvas").length};
  }).toString()+")()";
  async function assertAlignment(label,withDrawer=false){
    const a=await evaluate(diskAlignment);
    assert.ok(!a.searchActionOverlap,"Toolbar collision "+label+": "+JSON.stringify(a));
    if(withDrawer)assert.ok(!a.folderGraphOverlap,
      "Folder / graph overlap "+label+": "+JSON.stringify(a));
    assert.ok(a.scrollWidth<=a.width+4,
      "Unexpected page overflow "+label+": "+JSON.stringify(a));
    assert.equal(a.border,"0px","Graph stage must remain borderless");
    assert.equal(a.background,"rgba(0, 0, 0, 0)");
    assert.equal(a.canvasCount,1);
    return a;
  }
  const metrics="("+(()=> {
    const q=x=>document.querySelector(x);
    const rect=x=>{const r=x?.getBoundingClientRect();return r?{x:r.x,y:r.y,width:r.width,height:r.height}:null};
    const left=q(".dk-resize-left"),right=q(".dk-resize-right"),main=q(".dk-main");
    return {
      ready:!!(q(".dk-layout")&&left&&right&&main&&q(".dk-tile-scale")),
      width:innerWidth,content:rect(q(".content-main")),layout:rect(q(".dk-layout")),
      side:rect(q(".dk-side")),files:rect(main),life:rect(q(".dkl")),
      left:rect(left),right:rect(right),
      leftDisplay:left?getComputedStyle(left).display:null,
      rightDisplay:right?getComputedStyle(right).display:null,
      sidePosition:q(".dk-side")?getComputedStyle(q(".dk-side")).position:null,
      treeWidth:left?.getAttribute("aria-valuenow"),
      tile:q(".disk-page")?.style.getPropertyValue("--dk-tile-size"),
      scrollWidth:document.documentElement.scrollWidth,
      workspace:q(".content-main")?.classList.contains("disk-workspace")
    };
  }).toString()+")()";
  await device(1920,1080);
  let wide;
  for(let i=0;i<65;i++){
    wide=await evaluate(metrics);
    if(wide?.ready&&wide.content?.width>1200)break;
    await pause(200);
  }
  assert.ok(wide?.ready,"Disk JS did not render splitters and tile slider");
  assert.ok(wide.workspace,"Disk workspace class was not applied");
  assert.ok(wide.content.width>1200,"Old centered max-width is still active");
  assert.ok(wide.side.x<wide.files.x&&wide.files.x<wide.life.x,"Pane ordering is wrong");
  assert.ok(wide.files.width>490,"File grid too narrow: "+JSON.stringify(wide));
  assert.equal(wide.leftDisplay,"flex");
  assert.equal(wide.rightDisplay,"flex");
  const fullHdGeometry=await assertAlignment("Full HD 1920");
  assert.ok(fullHdGeometry.filesWidth>490);
  const fullHdScreenshot=await screenshot("disk-full-hd-1920x1080");
  assert.ok(fullHdScreenshot.width>=1800);
  const x=wide.left.x+wide.left.width/2,y=wide.left.y+Math.min(100,wide.left.height/2);
  await send("Input.dispatchMouseEvent",{type:"mouseMoved",x,y});
  await send("Input.dispatchMouseEvent",{type:"mousePressed",x,y,button:"left",clickCount:1});
  await send("Input.dispatchMouseEvent",{type:"mouseMoved",x:x+55,y,button:"left",buttons:1});
  await send("Input.dispatchMouseEvent",{type:"mouseReleased",x:x+55,y,button:"left",clickCount:1});
  await pause(180);
  const after=await evaluate(metrics);
  assert.ok(Number(after.treeWidth)>Number(wide.treeWidth),"Dragging left divider failed");
  assert.equal(await evaluate("localStorage.getItem('tsukimera.disk.layout.left.v1')"),after.treeWidth);
  await evaluate("(()=>{const r=document.querySelector('.dk-tile-scale input');r.value='300';r.dispatchEvent(new Event('input',{bubbles:true}));})()");
  assert.equal(await evaluate("document.querySelector('.disk-page').style.getPropertyValue('--dk-tile-size')"),"300px");
  assert.equal(await evaluate("localStorage.getItem('tsukimera.disk.tiles.v1')"),"300");
  await device(1366,900);
  const middle=await evaluate(metrics);
  assert.equal(middle.rightDisplay,"none","Right divider should disappear on a laptop");
  assert.ok(middle.files.width>390,"Laptop file grid too narrow: "+JSON.stringify(middle));
  await assertAlignment("Laptop 1366");
  await screenshot("disk-laptop-1366x900");
  await device(390,844);
  const mobile=await evaluate(metrics);
  assert.equal(mobile.leftDisplay,"none","Folder divider should disappear on mobile");
  assert.ok(mobile.files.width>300,"Mobile file grid too narrow: "+JSON.stringify(mobile));
  assert.ok(mobile.scrollWidth<=mobile.width+3,"Unexpected horizontal scroll: "+JSON.stringify(mobile));
  assert.equal(mobile.sidePosition,"fixed","Folders should become a mobile drawer");
  await screenshot("disk-mobile-files-390x844");

  // Disk 12: mobile files remain immediately visible; the map lives INSIDE
  // the folders drawer, directly below the hierarchy, not above documents.
  await evaluate("document.querySelector('.dk-drawer-btn').click()");
  await pause(260);
  const mobileFlow=await evaluate("(()=>{const side=document.querySelector('.dk-side'),tree=side.querySelector('.dk-tree-panel'),map=side.querySelector('.dk-omni-explorer'),frame=map?.querySelector('.dk-mini-map-frame');return {mapInside:!!map,topMap:!!document.querySelector('.disk-page > .dk-mini-map'),mapWidth:map?.getBoundingClientRect().width,sideWidth:side.getBoundingClientRect().width,below:map.getBoundingClientRect().top>=tree.getBoundingClientRect().top,frameHeight:frame?.getBoundingClientRect().height,drawer:document.querySelector('.disk-page').classList.contains('drawer-open')}})()");
  assert.ok(mobileFlow.mapInside&&!mobileFlow.topMap&&mobileFlow.drawer&&mobileFlow.below,
    "Mobile map must be accessible from the folder drawer: "+JSON.stringify(mobileFlow));
  assert.ok(mobileFlow.mapWidth<=mobileFlow.sideWidth+3&&mobileFlow.frameHeight>=300&&mobileFlow.frameHeight<=440,
    "Compact mobile map should fit the folder drawer: "+JSON.stringify(mobileFlow));
  await assertAlignment("Mobile drawer",true);
  await screenshot("disk-mobile-drawer-390x844");
  await evaluate("document.querySelector('.dk-side-close').click()");

  // Disk 8.0: reversible Focus mode, sticky path, real file cards and no
  // overwriting of the panel widths explicitly chosen by the user.
  await device(1920,1080);
  const beforeFocus=await evaluate("(()=>({left:localStorage.getItem('tsukimera.disk.layout.left.v1'),side:getComputedStyle(document.querySelector('.dk-side')).display,sticky:getComputedStyle(document.querySelector('.dk-head')).position,kind:!!document.querySelector('.dk-file .dk-kind-label'),focus:!!document.querySelector('.dk-focus-btn')}))()");
  assert.ok(beforeFocus.focus&&beforeFocus.kind,"File kind badges and Focus control must render");
  assert.equal(beforeFocus.sticky,"sticky","Breadcrumb path must remain fixed while scrolling");
  assert.notEqual(beforeFocus.side,"none","Folder panel should initially be visible");
  await evaluate("document.querySelector('.dk-focus-btn').click()");
  await pause(200);
  const focused=await evaluate("(()=>({enabled:document.querySelector('.disk-page').classList.contains('dk-focus'),button:document.querySelector('.dk-focus-btn').getAttribute('aria-pressed'),sidebar:getComputedStyle(document.querySelector('.dk-side')).display,life:getComputedStyle(document.querySelector('.dkl')).display,main:document.querySelector('.dk-main').getBoundingClientRect().width}))()");
  assert.equal(focused.enabled,true);
  assert.equal(await evaluate("document.querySelector('.disk-page > .dk-mini-map')===null"),true,
    "The old top map must never be mounted");
  assert.equal(focused.button,"true");
  assert.equal(focused.sidebar,"none");
  assert.equal(focused.life,"none");
  assert.ok(focused.main>1000,"Focus workspace must give file list substantially more room");
  await evaluate("document.querySelector('.dk-focus-btn').click()");
  await pause(180);
  const restored=await evaluate("(()=>({enabled:document.querySelector('.disk-page').classList.contains('dk-focus'),side:getComputedStyle(document.querySelector('.dk-side')).display,left:localStorage.getItem('tsukimera.disk.layout.left.v1')}))()");
  assert.equal(restored.enabled,false);
  assert.notEqual(restored.side,"none");
  assert.equal(restored.left,beforeFocus.left,"Focus mode must not override manual panel sizes");

  // Disk 8.1: new folder hierarchy and section configuration controls must be
  // usable in a real Chrome page and must not mutate the original Disk files.
  const initialTree=await evaluate("(()=>({actions:document.querySelectorAll('.dk-tree-all').length,hasSidebarSections:!!document.querySelector('.dk-side .dk-sections'),hasMap:!!document.querySelector('.dk-side > .dk-omni-explorer'),map:document.querySelector('.dk-side .dk-mini-map-canvas')?.getBoundingClientRect().width}))()");
  assert.equal(initialTree.actions,2,"Expand/collapse folder hierarchy controls missing");
  assert.equal(initialTree.hasSidebarSections,false,"Sections must stay in their separate dialog");
  assert.equal(initialTree.hasMap,true,"Live Map must be INSIDE the left rail below the folder tree");
  assert.ok(initialTree.map>160,"Compact map must fit the sidebar: "+JSON.stringify(initialTree));

  // DOM order and wide-screen position: tree, map, then the rest of the
  // file manager on the same page. Never render a second map above files.
  const ordering=await evaluate("(()=>{const page=document.querySelector('.disk-page'),layout=page.querySelector(':scope > .dk-layout'),side=layout.querySelector('.dk-side'),tree=side.querySelector('.dk-tree-panel'),map=side.querySelector(':scope > .dk-omni-explorer'),files=layout.querySelector('.dk-main'),heading=page.querySelector(':scope > .dk-files-section-head');return {onlyOne:page.querySelectorAll('.dk-omni-explorer').length===1,top:!!page.querySelector(':scope > .dk-mini-map'),afterTree:!!(tree.compareDocumentPosition(map)&Node.DOCUMENT_POSITION_FOLLOWING),sideWidth:side.getBoundingClientRect().width,mapWidth:map.getBoundingClientRect().width,sideX:side.getBoundingClientRect().x,filesX:files.getBoundingClientRect().x,hasFilesHeading:!!heading}})()");
  assert.ok(ordering.onlyOne&&!ordering.top&&ordering.afterTree&&ordering.hasFilesHeading,
    "One spatial map must follow the hierarchy in the sidebar: "+JSON.stringify(ordering));
  assert.ok(ordering.mapWidth>150&&ordering.mapWidth<=ordering.sideWidth+3&&ordering.sideX<ordering.filesX,
    "Live Map should not push file cards below a full-width top panel: "+JSON.stringify(ordering));

  // Disk 11: a real focus-centered, accessible spatial workspace, not the
  // former orbit mini-map. Canvas edges and native HTML nodes share one scene.
  const clean=await evaluate("(()=>({search:!!document.querySelector('.dk-tree-find'),sort:!!document.querySelector('.dk-tree-sort'),pinned:!!document.querySelector('.dk-tree .dk-pin'),control:document.querySelector('.dk-tree-panel')?.textContent.includes('Закреплённые')}))()");
  assert.deepEqual(clean,{search:false,sort:false,pinned:false,control:false});
  await pause(240);
  const graphOnly=await evaluate("(()=>{const root=document.querySelector('.dk-side > .dk-graph-only'),stage=root?.querySelector('.dk-graph-stage'),canvas=root?.querySelector('canvas');return {present:!!root,children:root?.children.length,stageChildren:stage?.children.length,visibleText:root?.textContent.trim(),nodes:Number(canvas?.dataset.nodes),links:Number(canvas?.dataset.links),layer:canvas?.dataset.layer,focus:canvas?.dataset.focus,stageHeight:stage?.getBoundingClientRect().height,border:getComputedStyle(stage).borderTopWidth,background:getComputedStyle(stage).backgroundColor,clutter:!!root?.querySelector('.dk-graph-head,.dk-graph-controls,.dk-graph-search,.dk-graph-inspect,.dk-graph-list,.dk-graph-legend,.dk-graph-footer,.dk-graph-count')}})()");
  assert.ok(graphOnly.present&&graphOnly.children===1&&graphOnly.stageChildren===1,
    "Only one Canvas stage may exist below folders: "+JSON.stringify(graphOnly));
  assert.equal(graphOnly.layer,"graph");
  assert.ok(graphOnly.nodes>1&&graphOnly.links>0&&graphOnly.stageHeight>=280,
    "Real graph must still render links and nodes: "+JSON.stringify(graphOnly));
  assert.equal(graphOnly.visibleText,"","Pure graph must have no surrounding text");
  assert.equal(graphOnly.border,"0px","The Canvas must have no frame");
  assert.equal(graphOnly.background,"rgba(0, 0, 0, 0)","Graph stage should be transparent");
  assert.equal(graphOnly.clutter,false,"All static controls, panels and legends must be absent");

  // Disk 17: the entire Disk is the default graph scope; no permanent UI
  // appears when a user toggles scope or focuses a selected real node.
  assert.equal(await evaluate("document.querySelector('.dk-graph-canvas')?.dataset.scope"),
    "global","Graph should cover the whole Disk by default");
  await evaluate("document.querySelector('.dk-graph-canvas').dispatchEvent(new KeyboardEvent('keydown',{key:'g',bubbles:true,cancelable:true}))");
  await pause(90);
  assert.equal(await evaluate("document.querySelector('.dk-graph-canvas')?.dataset.scope"),
    "folder","G should restrict the view to the real current folder");
  await evaluate("document.querySelector('.dk-graph-canvas').dispatchEvent(new KeyboardEvent('keydown',{key:'g',bubbles:true,cancelable:true}))");
  await pause(90);
  assert.equal(await evaluate("document.querySelector('.dk-graph-canvas')?.dataset.scope"),
    "global","G should restore the full Disk graph");
  await evaluate("document.querySelector('.dk-graph-canvas').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}))");
  await evaluate("document.querySelector('.dk-graph-canvas').dispatchEvent(new KeyboardEvent('keydown',{key:'f',bubbles:true,cancelable:true}))");
  await pause(100);
  const focusedGraph=await evaluate("(()=>({selected:document.querySelector('.dk-graph-canvas')?.dataset.selected,focus:document.querySelector('.dk-graph-canvas')?.dataset.focusNode,children:document.querySelector('.dk-graph-only')?.children.length}))()");
  assert.ok(focusedGraph.focus&&focusedGraph.selected===focusedGraph.focus&&focusedGraph.children===1,
    "F should focus the selected real graph node without panels: "+JSON.stringify(focusedGraph));
  await evaluate("document.querySelector('.dk-graph-canvas').dispatchEvent(new KeyboardEvent('keydown',{key:'f',bubbles:true,cancelable:true}))");
  assert.equal(await evaluate("document.querySelector('.dk-graph-canvas')?.dataset.focusNode"),"",
    "Repeating F should leave document focus without another widget");


  // Disk 16: real layout tests across laptop, 4K and 21:9 workspaces.
  // CDP changes monitor resolution; graph adapts without remounting itself.
  await device(1366,768);
  const laptopGraph=await evaluate("(()=>{const stage=document.querySelector('.dk-graph-stage'),c=stage?.querySelector('canvas'),r=stage?.getBoundingClientRect();return {width:r?.width,height:r?.height,capacity:Number(c?.dataset.capacity),detail:c?.dataset.detail,layer:c?.dataset.layer}})()");
  assert.ok(laptopGraph.width>180&&laptopGraph.height>=200&&laptopGraph.height<=295,
    "Laptop graph should not consume the entire viewport: "+JSON.stringify(laptopGraph));
  assert.equal(laptopGraph.detail,"standard");
  await device(3840,2160);
  const fourK=await evaluate("(()=>{const stage=document.querySelector('.dk-graph-stage'),c=stage?.querySelector('canvas'),r=stage?.getBoundingClientRect();return {width:r?.width,height:r?.height,capacity:Number(c?.dataset.capacity),nodes:Number(c?.dataset.nodes),pixelWidth:c?.width,pixelHeight:c?.height}})()");
  assert.ok(fourK.height>=420&&fourK.capacity>=laptopGraph.capacity,
    "4K layout must show a larger responsive scene: "+JSON.stringify(fourK));
  assert.ok(fourK.pixelWidth*fourK.pixelHeight<=10100000,
    "4K Canvas allocation must remain bounded: "+JSON.stringify(fourK));
  await device(3440,1440);
  await evaluate("document.querySelector('.dk-mini-map-canvas').dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true,cancelable:true}))");
  await pause(350);
  const ultrawideGraph=await evaluate("(()=>{const root=document.querySelector('.dk-graph-only'),stage=root?.querySelector('.dk-graph-stage'),c=stage?.querySelector('canvas'),r=stage?.getBoundingClientRect();return {expanded:root?.classList.contains('dk-graph-expanded'),aspect:c?.dataset.aspect,width:r?.width,height:r?.height,canvasCount:document.querySelectorAll('.dk-graph-only canvas').length,pixels:c?.width*c?.height,detail:c?.dataset.detail}})()");
  assert.ok(ultrawideGraph.expanded&&ultrawideGraph.aspect==="ultrawide"&&
    ultrawideGraph.width>=3200&&ultrawideGraph.height>=1350&&
    ultrawideGraph.canvasCount===1&&ultrawideGraph.pixels<=10100000,
    "Ultrawide graph must use all available width without allocating unlimited pixels: "+JSON.stringify(ultrawideGraph));
  await evaluate("document.querySelector('.dk-mini-map-canvas').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))");
  await device(1920,1080);
  assert.ok(await evaluate("!!document.querySelector('.dk-side > .dk-graph-only')"),
    "Resizing must restore the same graph under the folder hierarchy");

  // Disk 18: browser-level visual geometry across 100–200% Windows scaling.
  for(const dpr of [1,1.25,1.5,1.75,2]){
    await device(1920,1080,dpr);
    const layout=await assertAlignment("DPI "+dpr);
    assert.ok(Math.abs(layout.dpr-dpr)<.03,"DPI mismatch "+dpr);
    const pixels=await evaluate("(()=>{const c=document.querySelector('.dk-graph-canvas');return c.width*c.height})()");
    assert.ok(pixels>0&&pixels<=10100000,
      "Canvas DPR pixel budget overflow: "+dpr+" / "+pixels);
  }
  await screenshot("disk-windows-200pct");
  await device(2560,1440,1.5);
  const twoK=await assertAlignment("2K 150%");
  assert.ok(twoK.filesWidth>600,"2K must leave enough file workspace");
  await screenshot("disk-2k-2560x1440");
  await device(3440,1440,1);
  await assertAlignment("Ultrawide 3440");
  await screenshot("disk-ultrawide-3440x1440");
  await device(1920,1080,1);
  const longName=await evaluate("(()=>{const e=document.querySelector('.dk-file .dk-name');if(!e)return null;const old=e.textContent,title=e.title;e.textContent='Сверхдлинное-название-договора-'.repeat(12)+'.docx';e.title=e.textContent;const c=getComputedStyle(e);return {old,title,hasFullTitle:e.title.length>100,overflow:c.overflow,width:e.getBoundingClientRect().width}})()");
  assert.ok(longName?.hasFullTitle&&longName.overflow==="hidden"&&longName.width>0,
    "Long document names must remain visually clipped with full tooltips: "+JSON.stringify(longName));
  await screenshot("disk-long-document-name");
  await evaluate("(()=>{const e=document.querySelector('.dk-file .dk-name');if(e){e.textContent="+JSON.stringify(longName.old)+";e.title="+JSON.stringify(longName.title)+";}})()");
  await assertAlignment("Restored Full HD");

  await evaluate("(()=>{const c=document.querySelector('.dk-mini-map-canvas');for(let i=0;i<3;i++)c.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:-110}));})()");
  await pause(490);
  const zoomedMap=await evaluate("JSON.parse(localStorage.getItem('tsukimera.disk.minimap.view.v1')||'null')");
  assert.ok(zoomedMap?.zoom>1.2&&zoomedMap?.zoom<=4,
    "Direct wheel zoom must persist: "+JSON.stringify(zoomedMap));
  let sqliteView=null;
  for(let i=0;i<28;i++){
    const prefs=(await(await fetch(origin+"/api/preferences")).json()).preferences||{};
    try{sqliteView=JSON.parse(prefs["tsukimera.disk.minimap.view.v1"]||"null");}catch{}
    if(sqliteView?.zoom>1.2)break;
    await pause(120);
  }
  assert.ok(sqliteView?.zoom>1.2,"Pure graph must retain SQLite zoom preferences");
  await evaluate("document.querySelector('.dk-mini-map-canvas').dispatchEvent(new KeyboardEvent('keydown',{key:'0',bubbles:true,cancelable:true}))");
  await pause(360);
  const centered=await evaluate("JSON.parse(localStorage.getItem('tsukimera.disk.minimap.view.v1')||'null')");
  assert.equal(centered?.zoom,1,"Keyboard zero must reset zoom without visible controls");
  await evaluate("document.querySelector('.dk-mini-map-canvas').dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true,cancelable:true}))");
  await pause(250);
  const graphExpansion=await evaluate("(()=>({expanded:document.querySelector('.dk-graph-view').classList.contains('dk-graph-expanded'),count:document.querySelectorAll('.dk-graph-view').length,width:document.querySelector('.dk-graph-stage').getBoundingClientRect().width,children:document.querySelector('.dk-graph-view').children.length}))()");
  assert.ok(graphExpansion.expanded&&graphExpansion.count===1&&graphExpansion.width>850&&graphExpansion.children===1,
    "One and only one borderless graph should expand via keyboard: "+JSON.stringify(graphExpansion));
  await evaluate("document.querySelector('.dk-mini-map-canvas').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))");
  await pause(240);
  assert.ok(await evaluate("!!document.querySelector('.dk-side > .dk-graph-only')"),
    "Escape must return the same Canvas beneath the folder hierarchy");
  const contextMenu=await evaluate("(()=>{const c=document.querySelector('.dk-mini-map-canvas'),r=c.getBoundingClientRect();c.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:r.left+40,clientY:r.top+40}));return {menu:!!document.querySelector('.dk-graph-popover'),actions:document.querySelectorAll('.dk-graph-menu-action').length}})()");
  assert.ok(contextMenu.menu&&contextMenu.actions>=6,
    "Optional functions must be reachable only on deliberate secondary click");
  await evaluate("document.querySelectorAll('.dk-graph-menu-action')[1].click()");
  // The second menu choice restores all factual edges without starting a scan.
  await pause(500);
  assert.ok(await evaluate("document.querySelector('.dk-graph-popover')===null"),
    "Menu must disappear after choosing an action");
  await evaluate("document.querySelector('.dk-tree-all[aria-label=\"Развернуть все папки\"]').click()");
  assert.ok(await evaluate("!!document.querySelector('.dk-node[data-folder=\"Работа/2026\"]')"),
    "Full folder hierarchy must remain operable");
  await evaluate("document.querySelector('.dk-node[data-folder=\"Работа/2026\"] .dk-node-label').click()");
  await pause(300);
  const hierarchy=await evaluate("(()=>({selected:document.querySelector('.dk-node.current')?.dataset.folder,ancestors:[...document.querySelectorAll('.dk-node.dk-ancestor')].map(x=>x.dataset.folder),mapFocus:document.querySelector('.dk-mini-map-canvas')?.dataset.focus,graphChildren:document.querySelector('.dk-side > .dk-graph-only')?.children.length,links:Number(document.querySelector('.dk-mini-map-canvas')?.dataset.links)}))()");
  assert.equal(hierarchy.selected,"Работа/2026");
  assert.ok(hierarchy.ancestors.includes("Работа")&&hierarchy.ancestors.includes("Работа/2026"));
  assert.equal(hierarchy.mapFocus,"Работа/2026");
  assert.ok(hierarchy.graphChildren===1&&hierarchy.links>0,
    "Navigation must keep a real graph without reappearing panels: "+JSON.stringify(hierarchy));
  await evaluate("document.querySelector('.dk-tree-all[aria-label=\"Свернуть все папки\"]').click()");
  assert.equal(await evaluate("document.querySelector('.dk-node[data-folder=\"Работа/2026\"]')===null"),true,
    "Collapse all should hide descendants without deleting folder data");
  await evaluate("document.querySelector('.dk-node[data-folder=\"\"] .dk-node-label').click()");
  const openSections=async()=>await evaluate("(()=>{document.querySelector('.dk-more-btn').click();const row=[...document.querySelectorAll('.dk-menu-item')].find(x=>x.textContent.includes('Разделы и умные папки'));if(!row)return false;row.click();return !!document.querySelector('.dk-sections-dialog .dk-sections')})()");
  assert.equal(await openSections(),true,"Sections and smart folders must be accessible through the existing More menu");
  assert.equal(await evaluate("document.querySelectorAll('.dk-sections-dialog .dk-section:not(.dkx-smart)').length"),6,
    "All six navigation categories should survive relocation");
  assert.ok(await evaluate("!!document.querySelector('.dk-sections-dialog .dkx-smart-head')"),
    "Smart folder manager must remain accessible");
  await evaluate("document.querySelector('.dk-sections-dialog>.btn').click()");
  assert.equal(await evaluate("document.querySelectorAll('.dk-section-editor-row').length"),6);
  await evaluate("document.querySelector('.dk-section-editor-row button:last-child').click()");
  await evaluate("(()=>{const row=[...document.querySelectorAll('.dk-section-editor-row')].find(x=>x.textContent.includes('Крупные файлы'));row.querySelector('input').click();document.querySelector('.dk-section-editor .dk-form-actions .btn.primary').click()})()");
  assert.equal(await openSections(),true);
  const configured=await evaluate("(()=>({items:[...document.querySelectorAll('.dk-sections-dialog .dk-section:not(.dkx-smart)')].map(x=>x.textContent),saved:JSON.parse(localStorage.getItem('tsukimera.disk.sections.v1'))}))()");
  assert.ok(configured.items[0].includes("Недавние"),"Section order must be retained in the relocated dialog: "+JSON.stringify(configured));
  assert.ok(!configured.items.some(x=>x.includes("Крупные файлы")),"Hidden section still rendered");
  assert.equal(configured.saved.order[0],"recent");
  assert.ok(configured.saved.hidden.includes("large"));
  await evaluate("document.querySelector('.dk-sections-dialog>.btn').click()");
  await evaluate("(()=>{const options=[...document.querySelectorAll('.dk-section-editor .dk-form-actions button')];options.find(x=>x.textContent.includes('По умолчанию')).click();options.find(x=>x.textContent.includes('Сохранить')).click()})()");
  assert.equal(await openSections(),true);
  assert.equal(await evaluate("document.querySelectorAll('.dk-sections-dialog .dk-section:not(.dkx-smart)').length"),6,
    "Restoring default sections should make all categories available in their new home");
  await evaluate("document.querySelector('.mod-sheet button[aria-label=\"Закрыть\"]').click()");
  assert.equal(await evaluate("document.querySelector('.dk-mini-map-open')===null"),true,
    "The retired secondary map must not be available");



  // Life 4.0: verify six real highlight cards, 15 original groups in five areas,
  // the expanded full-width layout, a method dialog and a real-file source link.
  await device(1920,1080);
  let life;
  for(let i=0;i<75;i++){
    life=await evaluate("(()=>({h:document.querySelectorAll('.dkl-hl-card').length,areas:document.querySelectorAll('.dkl-area').length,groups:document.querySelectorAll('.dkl-tab').length}))()");
    if(life?.h===6&&life?.areas===5)break;
    await pause(300);
  }
  assert.equal(life?.h,6,"Six real Disk Life highlights failed to render");
  assert.equal(life?.areas,5,"Five analytics directions missing");
  const groupsCount=await evaluate("(()=>{let sum=0;const areas=[...document.querySelectorAll('.dkl-area')];for(const a of areas){a.click();sum+=document.querySelectorAll('.dkl-tab').length;}return sum;})()");
  assert.equal(groupsCount,15,"All original fifteen groups must be reachable");
  await evaluate("document.querySelector('.dkl-area').click()");
  await evaluate("document.querySelector('.dkl-expand').click()");
  await pause(350);
  const expanded=await evaluate("(()=>({flag:document.querySelector('.disk-page').classList.contains('dk-life-expanded'),count:document.querySelectorAll('.dkl-tile').length,files:getComputedStyle(document.querySelector('.dk-main')).display,life:document.querySelector('.dkl').getBoundingClientRect().width,areas:document.querySelectorAll('.dkl-area').length}))()");
  assert.equal(expanded.flag,true,"Full-width analytics did not activate");
  assert.equal(expanded.count,10,"Expanded group must show all its ten metrics");

  const compactLife=await evaluate("getComputedStyle(document.querySelector('.dkl-compact .dkl-areas')).display").catch(()=>null);
  const allToggle=await evaluate("(()=>{const button=document.querySelector('.dkl-all-toggle');if(!button||button.hidden)return false;button.click();return true;})()");
  assert.ok(allToggle,"All-150 analytics toggle must be visible in full mode");
  const allCards=await evaluate("document.querySelectorAll('.dkl-tile').length");
  assert.equal(allCards,150,"Full analytics must expose all 150 original metrics");
  await evaluate("document.querySelector('.dkl-all-toggle').click()");
  assert.equal(await evaluate("document.querySelectorAll('.dkl-tile').length"),10,
    "Returning from 150 metrics must restore the previous group");

  assert.equal(expanded.files,"none","File workspace must yield its width to analytics");
  assert.ok(expanded.life>1200,"Analytics remained constrained inside the right sidebar");
  const details=await evaluate("(()=>{document.querySelector('.dkl-tile[data-id=\"biggest\"]').click();return {dialog:!!document.querySelector('.dkl-detail-sheet'),method:document.querySelector('.dkl-detail-sheet')?.textContent.includes('Как рассчитывается'),source:!!document.querySelector('.dkl-detail-sheet .btn.primary')};})()");
  assert.ok(details.dialog&&details.method&&details.source,
    "A verified metric must show methodology and its real source link: "+JSON.stringify(details));
  await evaluate("document.querySelector('.dkl-detail-sheet .btn.primary').click()");
  let linked;
  for(let attempt=0;attempt<25;attempt++){
    linked=await evaluate("(()=>({panel:!!document.querySelector('.dk-info:not([hidden])'),expanded:document.querySelector('.disk-page').classList.contains('dk-life-expanded'),infoHidden:document.querySelector('.dk-info')?.hidden,layoutClasses:document.querySelector('.dk-layout')?.className,visibleCards:document.querySelectorAll('.dk-file').length,toast:document.querySelector('.toast-ts')?.textContent,files:document.querySelector('.dk-count')?.textContent,catalogStage:document.querySelector('.disk-page')?.dataset.catalogStage}))()");
    if(linked?.panel&&!linked.expanded)break;
    await pause(120);
  }
  if(!linked.panel){
    const probe=await evaluate("(async()=>{const paths=['/api/disk','/api/disk/folders/styles','/api/disk/trash','/api/disk/automation'];return await Promise.all(paths.map(async p=>{try{const r=await fetch(p,{signal:AbortSignal.timeout(4000)});const data=await r.json();return {path:p,status:r.status,files:data.files?.length,folders:data.folders?.length,error:data.error,body:JSON.stringify(data).slice(0,180)};}catch(e){return {path:p,error:String(e)};}}))})()");
    console.log("Disk catalog browser fetch diagnostics:",JSON.stringify(probe));
  }
  console.log("Verified life-file navigation:",JSON.stringify(linked));
  assert.ok(linked.panel&&!linked.expanded,"Verified source document did not open in the Disk inspector: "+JSON.stringify(linked));
  await evaluate("document.querySelector('.dkl-expand').click()");
  // Life 5.0: search all groups, filter missing data and keep the source untouched.
  const hits=await evaluate("(()=>{const x=document.querySelector('.dkl-search');x.value='слова';x.dispatchEvent(new Event('input',{bubbles:true}));return {shown:document.querySelectorAll('.dkl-tile').length,open:!document.querySelector('.dkl-discover').hidden,coverage:document.querySelector('.dkl-coverage').textContent.includes('500 документами')}})()");
  assert.ok(hits.open&&hits.coverage&&hits.shown>0&&hits.shown<150,
    "Search across Disk Life metrics must work in the real browser: "+JSON.stringify(hits));
  const emptyFilter=await evaluate("(()=>{const x=document.querySelector('.dkl-search');x.value='';x.dispatchEvent(new Event('input',{bubbles:true}));document.querySelectorAll('.dkl-filter')[2].click();return {cards:[...document.querySelectorAll('.dkl-tile')].every(e=>e.classList.contains('is-empty')),active:document.querySelectorAll('.dkl-filter')[2].getAttribute('aria-pressed'),total:document.querySelectorAll('.dkl-tile').length}})()");
  assert.ok(emptyFilter.cards&&emptyFilter.active==='true',
    "Missing-data filter must only show incomplete metrics: "+JSON.stringify(emptyFilter));
  // The mobile geometry test needs a real grid, not the intentional empty state.
  await evaluate("document.querySelectorAll('.dkl-filter')[0].click()");
  await device(390,844);
  const narrow=await evaluate("(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,grid:getComputedStyle(document.querySelector('.dkl-grid')).gridTemplateColumns}))()");
  assert.ok(narrow.scroll<=narrow.width+3,"Expanded mobile analytics scrolls horizontally");
  console.log("Disk Life 4.0 verified: 6 highlights, 5 directions, 15 groups, 10 metrics per group, full-width layout, source link.");


  // The analytics explorer must render real samples in an actual Chrome window.
  await device(1920,1080);
  const source=await(await fetch(origin+"/api/disk/life")).json();
  const metric=source.metrics.find(m=>!m.empty&&Array.isArray(m.series)&&m.series.length>=3&&
    ["line","spark","hours","calendar","split"].includes(m.kind));
  assert.ok(metric,"The seeded Disk must expose a real chart series for exploration");
  const group=source.groups.find(g=>g.id===metric.group);
  const navigated=await evaluate("(()=>{for(const area of [...document.querySelectorAll('.dkl-area')]){area.click();const tab=[...document.querySelectorAll('.dkl-tab')].find(x=>x.textContent.includes("+JSON.stringify(group.title)+"));if(tab){tab.click();return true;}}return false;})()");
  assert.ok(navigated,"Could not navigate to the verified chart group");
  const interactive=await evaluate("(()=>{const tile=document.querySelector('.dkl-tile[data-id="+JSON.stringify(metric.id)+"]');if(!tile)return {found:false};tile.click();const plot=document.querySelector('.dkl-explorer-plot svg');const counter=document.querySelector('.dkl-explorer-range');return {found:true,plot:!!plot,points:plot?.querySelectorAll('rect,circle,path').length||0,range:counter?.textContent,buttons:document.querySelectorAll('.dkl-explorer-actions button').length};})()");
  assert.ok(interactive.found&&interactive.plot&&interactive.points&&interactive.buttons===5,
    "The metric detail must contain a working real-data explorer: "+JSON.stringify(interactive));
  const zoomed=await evaluate("(()=>{const before=document.querySelector('.dkl-explorer-range').textContent;document.querySelector('.dkl-explorer-actions button[aria-label=\"Приблизить график\"]').click();const after=document.querySelector('.dkl-explorer-range').textContent;return {before,after,changed:before!==after};})()");
  assert.ok(zoomed.changed,"The chart zoom control did not change its real-data window");
  await evaluate("document.querySelector('.mod-sheet button[aria-label=\"Закрыть\"]').click()");
  await evaluate("document.querySelector('.dkl-expand').click()");
  const opened=await evaluate("(()=>{document.querySelector('.dk-more-btn').click();const row=[...document.querySelectorAll('.dk-menu-item')].find(x=>x.textContent.includes('Живая карта'));if(!row)return false;row.click();return true;})()");
  assert.ok(opened,"The Disk menu must return to the one spatial map");
  await pause(280);
  assert.ok(await evaluate("document.activeElement?.classList.contains('dk-mini-map-canvas')"),
    "The map menu should focus the actual embedded explorer");
  assert.equal(await evaluate("document.querySelector('.dkx-map-canvas')===null"),true,
    "Old orbit sheet should not open");
  let savedSettings;
  for(let i=0;i<25;i++){
    savedSettings=(await(await fetch(origin+"/api/preferences")).json()).preferences;
    if(savedSettings["tsukimera.disk.tiles.v1"]==="300")break;
    await pause(120);
  }
  assert.equal(savedSettings["tsukimera.disk.tiles.v1"],"300",
    "The browser Disk tile size was not persisted to SQLite");
  console.log("SQLite Disk preferences, live Canvas map and interactive real-data charts verified in Chrome.");

  console.log("Disk layout verified at 1920, 1366 and 390px; pointer drag and tile zoom persist.");

  // Real-browser migration from the older localStorage-only notes. This runs
  // through web/app.js, not just the notes HTTP API used by the unit tests.
  await evaluate("(()=>{localStorage.setItem('tsukimera:notes:v1',JSON.stringify([{id:'browser-legacy-note',text:'Старая заметка из браузера'}]));localStorage.removeItem('tsukimera:notes:sqlite-instance:v1');})()");
  await send("Page.reload",{ignoreCache:true});
  let imported=false;
  for(let i=0;i<40;i++){
    const reply=await fetch(origin+"/api/notes");
    if(reply.ok){
      const value=await reply.json();
      if(value.notes.some(note=>note.id==="browser-legacy-note")){imported=true;break;}
    }
    await pause(150);
  }
  assert.ok(imported,"Legacy browser-only notes were not safely imported into SQLite");
  const savedCopy=await evaluate("localStorage.getItem('tsukimera:notes:v1')");
  assert.ok(savedCopy.includes('browser-legacy-note'),"Migration must retain the browser safety copy");
  console.log("SQLite browser migration verified: old note survived in DB and local backup.");

  // Settings 3.0: real Chrome exercises new controls without a paid Cloud.ru
  // inference call or a privileged tool operation.
  await evaluate("location.hash='#/settings'");
  let settingsReady=false;
  for(let n=0;n<30;n++){
    settingsReady=await evaluate("!!document.querySelector('#set-data .set-diagnostics')");
    if(settingsReady)break;
    await pause(140);
  }
  assert.ok(settingsReady,"New settings were not rendered in the browser");
  const home=await evaluate("(()=>({cards:document.querySelectorAll('.set-card').length, model:!!document.querySelector('#set-model .set-model-browser'), cloud:!!document.querySelector('#set-conn .set-cloud-key'), ready:document.querySelectorAll('.set-cap-state').length, categories:document.querySelectorAll('.set-toc-link').length, visible:document.querySelectorAll('.set-card:not([hidden])').length}))()");
  assert.equal(home.cards,10,"All 10 settings sections must remain");
  assert.equal(home.ready,10,"All settings must disclose their capability status");
  assert.ok(home.cloud&&home.model,"Cloud.ru key and real model selector must render");

  assert.equal(home.categories,6,"Settings 4.0 must show six clear navigation categories");
  assert.equal(home.visible,2,"Only one selected category should be visible at a time");
  const spatialSetting=await evaluate("(()=>({look:document.querySelector('#set-look')?.textContent?.includes('Плотность Живой карты Диска'),options:[...document.querySelectorAll('#set-look .choice-card')].map(b=>b.textContent)}))()");
  assert.ok(spatialSetting.look&&spatialSetting.options.includes('Просторная')&&
    spatialSetting.options.includes('Больше объектов'),"Spatial density must be configurable in Settings");
  await evaluate("([...document.querySelectorAll('#set-look .choice-card')].find(b=>b.textContent==='Больше объектов')).click()");
  let densitySaved=false;
  for(let n=0;n<24;n++){
    await pause(120);
    const prefs=(await(await fetch(origin+"/api/preferences")).json()).preferences||{};
    if(prefs['tsukimera.disk.spatial.density.v1']==='detailed'){densitySaved=true;break;}
  }
  assert.ok(densitySaved,"Spatial density must be persisted in SQLite");
  await evaluate("([...document.querySelectorAll('#set-look .choice-card')].find(b=>b.textContent==='Просторная')).click()");
  await evaluate("document.querySelector('[data-settings-group=\"cloud\"]').click()");
  const cloudPanel=await evaluate("(()=>({category:document.querySelector('.set-toc-link.active')?.dataset.settingsGroup,visible:[...document.querySelectorAll('.set-card:not([hidden])')].map(x=>x.id),browsers:document.querySelectorAll('.set-model-browser').length,search:document.querySelectorAll('.set-model-search').length}))()");
  assert.equal(cloudPanel.category,"cloud");
  assert.deepEqual(cloudPanel.visible,["set-conn","set-model"]);
  assert.equal(cloudPanel.browsers,1,"Primary and fallback must share one real Cloud model browser");
  assert.equal(cloudPanel.search,1,"Duplicate Cloud model search fields must be removed");
  await evaluate("(()=>{const f=document.querySelector('#set-model .beh-field input');f.value='browser/autosave';f.dispatchEvent(new Event('input',{bubbles:true}));})()");
  let autosaved=false;
  for(let n=0;n<35;n++){
    await pause(110);
    const response=await fetch(origin+"/api/settings");
    if(response.ok&&(await response.json()).settings.model.primary==="browser/autosave"){
      autosaved=true;break;
    }
  }
  assert.ok(autosaved,"Normal model preferences should autosave to SQLite without Save button");
  let saveStateReady=false;
  for(let i=0;i<24;i++){
    saveStateReady=await evaluate("document.querySelector('.set-save-state')?.dataset.state==='saved'");
    if(saveStateReady)break;
    await pause(100);
  }
  assert.ok(saveStateReady,
    "Visual save state must confirm completion after the server persisted the settings");
  await evaluate("document.querySelector('[data-settings-group=\"general\"]').click()");
  await evaluate("document.querySelector('[data-settings-group=\"cloud\"]').click()");
  assert.equal(await evaluate("document.querySelector('#set-model .beh-field input')?.value"),
    "browser/autosave","Switching settings category must not reset model input");

  await evaluate("(()=>{const q=document.querySelector('.set-search input'); q.value='SQLite';q.dispatchEvent(new Event('input',{bubbles:true}));})()");
  const found=await evaluate("(()=>({count:document.querySelectorAll('.set-card:not([hidden])').length, result:document.querySelector('.set-search-results').textContent}))()");
  assert.ok(found.count>0&&found.count<10&&found.result.includes("совпадений"),
    "Settings search must find individual parameters");
  await evaluate("(()=>{const q=document.querySelector('.set-search input'); q.value='';q.dispatchEvent(new Event('input',{bubbles:true}));})()");
  const checkButton=await evaluate("(()=>{const b=[...document.querySelectorAll('#set-data button')].find(x=>x.textContent.includes('Проверить целостность'));if(!b)return false;b.click();return true;})()");
  assert.ok(checkButton,"SQLite diagnosis button missing");
  let diagnosed=false;
  for(let n=0;n<35;n++){
    diagnosed=await evaluate("document.querySelector('#set-data .set-diagnostics')?.textContent.includes('Ошибок не обнаружено')");
    if(diagnosed)break;
    await pause(120);
  }
  assert.ok(diagnosed,"Real SQLite integrity diagnosis failed in Chrome");

  const backupHealth=await evaluate("document.querySelector('#set-data .set-40-sqlite-health')?.textContent||''");
  assert.match(backupHealth,/Автокопирование/,"SQLite center must show actual backup scheduling status");
  assert.match(backupHealth,/Хранилище копий/,"SQLite center must show backup storage budget");

  // Saving Persona must not erase a draft in the unrelated Model form.
  await evaluate("(()=>{document.querySelector('#set-model .beh-field input').value='draft-do-not-erase'; document.querySelector('#set-persona .beh-field textarea').value='Сохраняемый текст'; document.querySelector('#set-persona button.btn.primary').click();})()");
  let persisted=false;
  for(let n=0;n<30;n++){
    const response=await fetch(origin+"/api/settings");
    if(response.ok&&((await response.json()).settings.instructions.about)==="Сохраняемый текст"){
      persisted=true;break;
    }
    await pause(120);
  }
  assert.ok(persisted,"Persona server-side settings were not saved");
  assert.equal(await evaluate("document.querySelector('#set-model .beh-field input').value"),
    "draft-do-not-erase","An unrelated successful save destroyed the pending model draft");
  console.log("Settings 3.0 verified: 10 sections, Cloud.ru selectors, diagnosis, search and no-loss editing.");

}finally{
  socket?.close();
  chrome.kill("SIGTERM");
  await pause(300);
  await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:250});
}
