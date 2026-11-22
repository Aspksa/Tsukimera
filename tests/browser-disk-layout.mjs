import {spawn} from "node:child_process";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import assert from "node:assert/strict";

// Inspect the real browser layout using CDP, without Playwright or npm packages.
const origin=process.argv[2];
if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin||""))throw Error("Supply loopback server origin");
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
  async function device(width,height=960){
    await send("Emulation.setDeviceMetricsOverride",{
      width,height,deviceScaleFactor:1,mobile:width<600
    });
    await pause(300);
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
  await device(390,844);
  const mobile=await evaluate(metrics);
  assert.equal(mobile.leftDisplay,"none","Folder divider should disappear on mobile");
  assert.ok(mobile.files.width>300,"Mobile file grid too narrow: "+JSON.stringify(mobile));
  assert.ok(mobile.scrollWidth<=mobile.width+3,"Unexpected horizontal scroll: "+JSON.stringify(mobile));
  assert.equal(mobile.sidePosition,"fixed","Folders should become a mobile drawer");
  console.log("Disk layout verified at 1920, 1366 and 390px; pointer drag and tile zoom persist.");
}finally{
  socket?.close();
  chrome.kill("SIGTERM");
  await pause(300);
  await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:250});
}
