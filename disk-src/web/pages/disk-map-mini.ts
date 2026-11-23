/**
 * Compact, real-data Canvas navigator embedded beneath the Disk folder tree.
 * The full map in disk-map.ts remains the source of detailed exploration.
 * Render-on-change only: no endless animation loop, network, or dependencies.
 */
import {el} from "../dom";
import {human} from "./disk-model";
import {graphFromFiles,mapNodeRadius,type DiskGraph,type MapNode} from "./disk-map-layout";
import type {DiskFile} from "../api";

type MiniMapActions={
  openFull:()=>void;
  openFolder:(folder:string)=>void;
  openFile:(id:string)=>void;
};
export interface MiniDiskMap{
  root:HTMLElement;
  update:(files:DiskFile[],folders:string[],current:string)=>void;
}
const clamp=(n:number,min:number,max:number)=>Math.min(max,Math.max(min,n));
const EMPTY_GRAPH=graphFromFiles([],[]);
export function createMiniDiskMap(actions:MiniMapActions):MiniDiskMap{
  const canvas=el("canvas",{cls:"dk-mini-map-canvas",attrs:{
    tabindex:"0",role:"img",
    "aria-label":"Живая мини-карта папок и файлов. Выберите узел, нажмите Enter, чтобы открыть его."}});
  const open=el("button",{type:"button",cls:"dk-mini-map-open",
    attrs:{"aria-label":"Развернуть Живую карту Диска",title:"Открыть подробную Живую карту"}},
    "Развернуть карту ↗");
  open.addEventListener("click",actions.openFull);
  const count=el("small",{cls:"dk-mini-map-count",textContent:"0 файлов · 0 папок"});
  const status=el("small",{cls:"dk-mini-map-status",attrs:{"aria-live":"polite"},
    textContent:"Узлы отображают настоящие папки и документы"});
  const frame=el("div",{cls:"dk-mini-map-frame"},canvas);
  const root=el("section",{cls:"dk-mini-map",attrs:{"aria-label":"Живая карта Диска"}},
    el("div",{cls:"dk-mini-map-head"},el("strong",{textContent:"Живая карта Диска"}),open),
    count,frame,status);
  let graph:DiskGraph=EMPTY_GRAPH;
  let current="",active:MapNode|null=null,width=0,height=0;
  let points:{node:MapNode;x:number;y:number;r:number}[]=[];
  let queued=false;
  const paint=()=>{
    queued=false;
    if(!root.isConnected)return;
    const bounds=canvas.getBoundingClientRect();
    width=Math.max(1,Math.round(bounds.width));height=Math.max(1,Math.round(bounds.height));
    const ctx=canvas.getContext("2d");if(!ctx)return;
    const dpr=clamp(window.devicePixelRatio||1,1,2);
    const actualW=Math.round(width*dpr),actualH=Math.round(height*dpr);
    if(canvas.width!==actualW||canvas.height!==actualH){
      canvas.width=actualW;canvas.height=actualH;
    }
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.clearRect(0,0,width,height);
    const nodes=graph.nodes;
    const reach=Math.max(160,...nodes.map(node=>Math.max(Math.abs(node.x),Math.abs(node.y))+35));
    const scale=clamp(Math.min(width*.46,height*.46)/reach,.09,1);
    const centerX=width/2,centerY=height/2;
    points=nodes.map(node=>({
      node,x:centerX+node.x*scale,y:centerY+node.y*scale,
      r:clamp(mapNodeRadius(node,graph.bytes)*Math.sqrt(scale),3,14),
    }));
    const byId=new Map(points.map(x=>[x.node.id,x]));
    // Draw relationships with real types. Keep secondary links subtle at
    // thumbnail sizes so the structure remains readable.
    for(const edge of graph.edges){
      const from=byId.get(edge.from),to=byId.get(edge.to);
      if(!from||!to)continue;
      ctx.beginPath();
      ctx.moveTo(from.x,from.y);ctx.lineTo(to.x,to.y);
      ctx.strokeStyle=edge.kind==="duplicate"?"rgba(218,169,75,.36)":
        edge.kind==="tag"?"rgba(79,187,169,.3)":"rgba(176,187,205,.2)";
      ctx.lineWidth=edge.kind==="contains"?1:1.15;
      ctx.stroke();
    }
    for(const point of points){
      const {node,x,y,r}=point;
      const chosen=active?.id===node.id;
      const inPath=node.kind==="folder"&&(current===node.folder||
        current.startsWith(node.folder+"/"));
      if(chosen||inPath){
        ctx.beginPath();ctx.arc(x,y,r+(chosen?5:3),0,2*Math.PI);
        ctx.fillStyle=chosen?"rgba(223,173,80,.25)":"rgba(223,173,80,.12)";
        ctx.fill();
      }
      ctx.beginPath();ctx.arc(x,y,r,0,2*Math.PI);
      ctx.fillStyle=node.kind==="root"?"#D9A441":
        node.kind==="folder"?inPath?"#E9BA65":"#8CA8ED":"#CFD5E1";
      ctx.fill();
      if(chosen){
        ctx.beginPath();ctx.arc(x,y,r+3,0,2*Math.PI);
        ctx.strokeStyle="#E9BA65";ctx.lineWidth=1.5;ctx.stroke();
      }
    }
    if(nodes.length===1){
      ctx.fillStyle="rgba(206,207,211,.6)";
      ctx.textAlign="center";ctx.font="11px system-ui";
      ctx.fillText("Загрузите файлы, чтобы карта выросла",width/2,height-17);
    }
  };
  const invalidate=()=>{
    if(queued)return;queued=true;
    requestAnimationFrame(paint);
  };
  const detail=(node:MapNode)=>(
    (node.kind==="file"?"Файл: ":node.kind==="folder"?"Папка: ":"Диск: ")+node.name+
    " · "+node.count+" файлов · "+human(node.size));
  const find=(event:PointerEvent|MouseEvent)=>{
    const box=canvas.getBoundingClientRect();
    const x=event.clientX-box.left,y=event.clientY-box.top;
    let winner:{node:MapNode;distance:number}|null=null;
    for(const item of points){
      const distance=Math.hypot(x-item.x,y-item.y);
      if(distance>Math.max(item.r+7,11)||winner&&distance>=winner.distance)continue;
      winner={node:item.node,distance};
    }
    return winner?.node??null;
  };
  const select=(node:MapNode|null)=>{
    active=node;
    status.textContent=node?detail(node):
      "Клик по узлу — выбор, двойной клик — открыть";
    invalidate();
  };
  const navigate=(node:MapNode)=>{
    if(node.kind==="file")actions.openFile(node.id.slice(5));
    else actions.openFolder(node.folder);
  };
  canvas.addEventListener("pointermove",event=>{
    const node=find(event);
    canvas.style.cursor=node?"pointer":"default";
    canvas.title=node?detail(node):"";
  });
  canvas.addEventListener("click",event=>select(find(event)));
  canvas.addEventListener("dblclick",event=>{
    const node=find(event);if(node)navigate(node);
    else actions.openFull();
  });
  canvas.addEventListener("keydown",event=>{
    if(event.key==="Enter"){
      event.preventDefault();
      if(active)navigate(active);else actions.openFull();
    }else if(event.key==="Escape"&&active){
      event.preventDefault();select(null);
    }
  });
  if(typeof ResizeObserver!=="undefined"){
    const observer=new ResizeObserver(()=>{
      if(!root.isConnected){if(root.parentNode===null)return;}
      invalidate();
    });
    observer.observe(frame);
  }
  return {root,update(files,folders,folder){
    current=folder;
    graph=graphFromFiles(files,folders,70,40);
    if(active&&!graph.nodes.some(node=>node.id===active?.id))active=null;
    const sampled=graph.shownFiles<graph.totalFiles||graph.shownFolders<graph.totalFolders;
    count.textContent=graph.totalFiles+" файлов · "+graph.totalFolders+" папок"+
      (sampled?" · обзор":"");
    if(!active)status.textContent=sampled?
      "Обзор части узлов · подробности в большой карте":
      "Клик — выбор, двойной клик — открыть";
    invalidate();
  }};
}
