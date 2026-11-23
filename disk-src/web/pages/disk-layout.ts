import {writePreference} from "../preferences";
/** Tsukimera Disk — independent responsive pane layout.
 * Pointer + keyboard resizing without dependencies or changing JUUNIBI storage.
 * Widths are browser-local preferences, safely bounded at every viewport size.
 */
const LEFT_KEY="tsukimera.disk.layout.left.v1";
const RIGHT_KEY="tsukimera.disk.layout.right.v1";
export const TILE_KEY="tsukimera.disk.tiles.v1";

export function clamp(value:number,min:number,max:number):number {
  return Math.max(min,Math.min(max,value));
}
export function tileSize(value:unknown):number {
  const n=Number(value);
  return Number.isFinite(n)&&n>=160&&n<=360?Math.round(n/10)*10:220;
}
export function paneSize(value:unknown,kind:"left"|"right"):number {
  const min=kind==="left"?210:260,max=kind==="left"?460:500;
  const fallback=kind==="left"?266:340;
  const n=Number(value);
  return Number.isFinite(n)&&n>=min&&n<=max?Math.round(n):fallback;
}
/** Automatically balance sidebars while no manual width has been saved. */
export function autoPaneSize(available:number,kind:"left"|"right"):number{
  const space=Number.isFinite(available)?Math.max(320,available):1400;
  const base=kind==="left"?space*.19:space*.235;
  return clamp(Math.round(base),kind==="left"?210:260,kind==="left"?360:440);
}
const read=(key:string):string|null=>{
  try{return localStorage.getItem(key);}catch{return null;}
};
const write=(key:string,value:number):void=>{
  writePreference(key,String(Math.round(value)));
};

export interface DiskSplitters{
  left:HTMLDivElement;right:HTMLDivElement;reset:()=>void;
}
export function createDiskSplitters(layout:HTMLElement):DiskSplitters{
  const savedLeft=read(LEFT_KEY),savedRight=read(RIGHT_KEY);
  const available=()=>layout.parentElement?.getBoundingClientRect().width||window.innerWidth||1400;
  let manualLeft=savedLeft!==null,manualRight=savedRight!==null;
  let left=manualLeft?paneSize(savedLeft,"left"):autoPaneSize(available(),"left");
  let right=manualRight?paneSize(savedRight,"right"):autoPaneSize(available(),"right");
  const update=()=>{
    layout.style.setProperty("--dk-tree-width",left+"px");
    layout.style.setProperty("--dk-right-width",right+"px");
    leftHandle.setAttribute("aria-valuenow",String(left));
    rightHandle.setAttribute("aria-valuenow",String(right));
  };
  const make=(kind:"left"|"right"):HTMLDivElement=>{
    const handle=document.createElement("div");
    handle.className="dk-resize-handle dk-resize-"+kind;
    handle.tabIndex=0;
    handle.setAttribute("role","separator");
    handle.setAttribute("aria-orientation","vertical");
    handle.setAttribute("aria-label",kind==="left"?"Изменить ширину панели папок":"Изменить ширину правой панели");
    handle.setAttribute("aria-valuemin",String(kind==="left"?210:260));
    handle.setAttribute("aria-valuemax",String(kind==="left"?460:500));
    handle.setAttribute("title","Перетащите для изменения ширины. Стрелки — шаг 16 px, двойной щелчок — сброс.");
    handle.append(document.createElement("span"));
    return handle;
  };
  const leftHandle=make("left"),rightHandle=make("right");
  const limit=(kind:"left"|"right",value:number):number=>{
    const width=layout.getBoundingClientRect().width||1400;
    const other=kind==="left"?right:left;
    const min=kind==="left"?210:260;
    // Reserve at least 380px for the file grid plus 12px for both splitters.
    const max=Math.min(kind==="left"?460:500,width*.30,width-other-392);
    return clamp(Math.round(value),min,Math.max(min,max));
  };
  const set=(kind:"left"|"right",width:number,persist:boolean)=>{
    const value=limit(kind,width);
    if(kind==="left")left=value;else right=value;
    update();
    if(persist){
      if(kind==="left")manualLeft=true;else manualRight=true;
      write(kind==="left"?LEFT_KEY:RIGHT_KEY,value);
    }
  };
  for(const [kind,handle] of [["left",leftHandle],["right",rightHandle]] as const){
    let startX=0,startWidth=0,active=false;
    handle.addEventListener("pointerdown",event=>{
      if(event.button!==0||getComputedStyle(handle).display==="none")return;
      event.preventDefault();
      active=true;startX=event.clientX;startWidth=kind==="left"?left:right;
      layout.classList.add("dk-resizing");
      handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener("pointermove",event=>{
      if(!active)return;
      set(kind,startWidth+(kind==="left"?1:-1)*(event.clientX-startX),false);
    });
    const done=()=>{
      if(!active)return;
      active=false;layout.classList.remove("dk-resizing");
      if(kind==="left")manualLeft=true;else manualRight=true;
      write(kind==="left"?LEFT_KEY:RIGHT_KEY,kind==="left"?left:right);
    };
    handle.addEventListener("pointerup",done);
    handle.addEventListener("pointercancel",done);
    handle.addEventListener("lostpointercapture",done);
    handle.addEventListener("keydown",event=>{
      if(getComputedStyle(handle).display==="none")return;
      const old=kind==="left"?left:right;
      let next=old;
      if(event.key==="Home")next=kind==="left"?210:260;
      else if(event.key==="End")next=kind==="left"?460:500;
      else if(event.key==="ArrowLeft"||event.key==="ArrowRight"){
        const step=event.shiftKey?32:16;
        next=old+(event.key==="ArrowRight"?1:-1)*(kind==="left"?1:-1)*step;
      }else return;
      event.preventDefault();set(kind,next,true);
    });
    handle.addEventListener("dblclick",()=>{
      set(kind,kind==="left"?266:340,true);
    });
  }
  update();
  // Automatic widths never overwrite the user's explicit drag/keyboard setting.
  // Observe the parent, not the grid itself, to avoid resize feedback loops.
  if(typeof ResizeObserver!=="undefined"&&layout.parentElement){
    const watcher=new ResizeObserver(()=>{
      if(!layout.isConnected){watcher.disconnect();return;}
      const space=available();
      if(!manualLeft)left=autoPaneSize(space,"left");
      if(!manualRight)right=autoPaneSize(space,"right");
      update();
    });
    watcher.observe(layout.parentElement);
  }
  return {
    left:leftHandle,right:rightHandle,
    reset:()=>{set("left",266,true);set("right",340,true);}
  };
}
