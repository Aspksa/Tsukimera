/**
 * Disk 8.3: a bounded, on-demand Canvas navigator, with a zoom-dependent
 * detail layer and aggregate nodes for data outside the visible sample.
 * No continuous animation loop and no external graph dependencies.
 */
import {el} from "../dom";
import {human} from "./disk-model";
import {mapNodeRadius} from "./disk-map-layout";
import {miniGraphFromCatalog,normalizeMiniView,clampView,MINI_VIEW_KEY,
  type MiniGraph,type MiniNode,type MiniView} from "./disk-map-mini-model";
import {writePreference} from "../preferences";
import {orbitLayout,containmentTrail,adaptiveMapWeight} from "./disk-map-orbits";
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
type Point={node:MiniNode;x:number;y:number;r:number};
const reducedMotion=()=>window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const readView=():MiniView=>{
  try{return normalizeMiniView(JSON.parse(localStorage.getItem(MINI_VIEW_KEY)||"null"));}
  catch{return normalizeMiniView(null);}
};
const hashCatalog=(files:DiskFile[],folders:string[])=>{
  // Lightweight content fingerprint detects in-place edits too, without
  // serializing large documents or rebuilding the expensive graph on every go().
  let hash=2166136261;
  const add=(text:string)=>{
    for(let i=0;i<text.length;i++){hash^=text.charCodeAt(i);hash=Math.imul(hash,16777619);}
  };
  for(const file of files)
    add(file.id+"|"+file.folder+"|"+file.name+"|"+file.size+"|"+file.sha256+"|"+file.deletedAt+
      "|"+(file.tags||[]).join(",")+";");
  for(const folder of folders)add(folder+";");
  return hash>>>0;
};
export function createMiniDiskMap(actions:MiniMapActions):MiniDiskMap{
  const view=readView();
  const canvas=el("canvas",{cls:"dk-mini-map-canvas",attrs:{
    tabindex:"0",role:"img",
    "aria-label":"Живая карта папок и файлов. Колесо — масштаб, мышь — перемещение, Enter — открыть выбранное."}});
  const open=el("button",{type:"button",cls:"dk-mini-map-open",
    attrs:{"aria-label":"Развернуть Живую карту Диска",title:"Открыть подробную Живую карту"}},
    "Развернуть ↗");
  open.addEventListener("click",actions.openFull);
  const count=el("small",{cls:"dk-mini-map-count",textContent:"0 файлов · 0 папок"});
  const status=el("small",{cls:"dk-mini-map-status",attrs:{"aria-live":"polite"},
    textContent:"Нажмите на узел для выбора"});
  const frame=el("div",{cls:"dk-mini-map-frame"},canvas);
  const root=el("section",{cls:"dk-mini-map",attrs:{"aria-label":"Живая карта Диска"}},
    el("div",{cls:"dk-mini-map-head"},el("strong",{textContent:"Живая карта Диска"}),open),
    count,frame,status);
  const reset=el("button",{type:"button",cls:"dk-mini-map-reset",textContent:"Сбросить вид",
    attrs:{"aria-label":"Сбросить масштаб и положение карты"}});
  root.append(reset);
  let files:DiskFile[]=[],folders:string[]=[],current="";
  let graph:MiniGraph=miniGraphFromCatalog([],[]),hash=-1;
  let modeKey="",active:MiniNode|null=null,points:Point[]=[];
  let queued=false,raf=0,saveTimer=0,width=1,height=1;
  let revealStart=0,pulseStart=0;
  let revealFrom=new Map<string,Point>();
  let revealOrigin={x:0,y:0};
  let lastFolder="";
  let dragging=false,dragged=false,suppressClick=false,startX=0,startY=0,startPanX=0,startPanY=0;
  const save=()=>{
    clearTimeout(saveTimer);
    saveTimer=window.setTimeout(()=>writePreference(MINI_VIEW_KEY,JSON.stringify(view)),240);
  };
  const focusFolder=()=>{
    if(view.focus&&folders.some(f=>f===view.focus||f.startsWith(view.focus+"/")))return view.focus;
    return current;
  };
  const rebuild=()=>{
    const detail=view.zoom>=2.1;
    const focus=detail?focusFolder():"";
    const key=hash+":"+detail+":"+focus;
    if(key===modeKey)return;
    // Remember screen positions before replacing a cluster with its members.
    // Newly exposed nodes emerge from the prior selected cluster.
    const origin=points.find(p=>p.node.id===active?.id);
    if(points.length&&!reducedMotion()){
      revealFrom=new Map(points.map(p=>[p.node.id,p]));
      revealOrigin=origin?{x:origin.x,y:origin.y}:{x:width/2,y:height/2};
      revealStart=performance.now();
    }else{revealStart=0;revealFrom.clear();}
    graph=orbitLayout(miniGraphFromCatalog(files,folders,focus,detail,current));
    modeKey=key;
    canvas.dataset.layer=detail?"detail":"overview";
    canvas.dataset.nodes=String(graph.nodes.length);
    canvas.dataset.clusters=String(graph.nodes.filter(n=>n.kind==="cluster").length);
    const node=graph.nodes.find(n=>n.id===active?.id);
    active=node||graph.nodes.find(n=>n.kind==="folder"&&n.folder===current)||null;
  };
  const selectFolder=()=>{
    const exact=graph.nodes.find(n=>n.kind==="folder"&&n.folder===current);
    const ancestor=graph.nodes.filter(n=>n.kind==="folder"&&
      current.startsWith(n.folder+"/")).sort((a,b)=>b.folder.length-a.folder.length)[0];
    active=exact||ancestor||graph.nodes.find(n=>n.kind==="root")||null;
  };
  const getBaseScale=()=>{
    const reach=Math.max(160,...graph.nodes.map(n=>Math.max(Math.abs(n.x),Math.abs(n.y))+38));
    return clampView(Math.min(width*.46,height*.46)/reach,.07,1.1);
  };
  const project=(n:MiniNode,scale:number):Point=>({
    node:n,x:width/2+view.panX+n.x*scale,y:height/2+view.panY+n.y*scale,
    r:n.kind==="cluster"?clampView(6+Math.sqrt(n.count+n.hiddenFolders)*.8,6,15):
      clampView(mapNodeRadius(n,graph.bytes)*Math.sqrt(scale),3,16),
  });
  const centerOn=(node:MiniNode|null)=>{
    if(!node)return;
    const scale=getBaseScale()*view.zoom;
    view.panX=clampView(-node.x*scale,-3000,3000);
    view.panY=clampView(-node.y*scale,-3000,3000);
    save();
  };
  const drawShape=(ctx:CanvasRenderingContext2D,p:Point)=>{
    const {node,x,y,r}=p;
    ctx.beginPath();
    if(node.kind==="root")ctx.arc(x,y,r,0,Math.PI*2);
    else if(node.kind==="folder")ctx.roundRect(x-r,y-r,r*2,r*2,Math.max(2,r*.3));
    else if(node.kind==="file"){
      ctx.moveTo(x,y-r);ctx.lineTo(x+r,y);ctx.lineTo(x,y+r);ctx.lineTo(x-r,y);ctx.closePath();
    }else{
      for(let k=0;k<6;k++){
        const a=Math.PI/3*k-Math.PI/6;
        if(k===0)ctx.moveTo(x+Math.cos(a)*r,y+Math.sin(a)*r);
        else ctx.lineTo(x+Math.cos(a)*r,y+Math.sin(a)*r);
      }
      ctx.closePath();
    }
  };
  const paint=()=>{
    queued=false;raf=0;
    if(!root.isConnected)return;
    const rect=canvas.getBoundingClientRect();
    width=Math.max(1,Math.round(rect.width));height=Math.max(1,Math.round(rect.height));
    const ctx=canvas.getContext("2d");if(!ctx)return;
    const dpr=clampView(window.devicePixelRatio||1,1,2);
    const sw=Math.round(width*dpr),sh=Math.round(height*dpr);
    if(canvas.width!==sw||canvas.height!==sh){canvas.width=sw;canvas.height=sh;}
    ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,width,height);
    rebuild();
    const scale=getBaseScale()*view.zoom;
    const now=performance.now();
    const revealProgress=revealStart&&!reducedMotion()?
      clampView((now-revealStart)/420,0,1):1;
    const revealEase=1-Math.pow(1-revealProgress,3);
    const pulse=pulseStart&&!reducedMotion()?clampView(1-(now-pulseStart)/560,0,1):0;
    points=graph.nodes.map(n=>{
      const dest=project(n,scale);
      if(revealProgress>=1)return dest;
      const source=revealFrom.get(n.id)||{...dest,...revealOrigin,r:1};
      return {...dest,
        x:source.x+(dest.x-source.x)*revealEase,
        y:source.y+(dest.y-source.y)*revealEase,
        r:Math.max(1,source.r+(dest.r-source.r)*revealEase)};
    });
    canvas.dataset.transition=revealProgress<1?"revealing":"idle";
    const byId=new Map(points.map(p=>[p.node.id,p]));
    const centered=active?byId.get(active.id):null;
    canvas.dataset.centerError=centered?
      String(Math.round(Math.hypot(centered.x-width/2,centered.y-height/2))):"";
    const margin=22;
    const inside=(p:Point)=>p.x>=-margin&&p.y>=-margin&&p.x<=width+margin&&p.y<=height+margin;
    const trail=active?containmentTrail(graph,active.id):[];
    const trailIds=new Set(trail);
    const trailLinks=new Set(trail.slice(1).map((id,i)=>trail[i]+"|"+id));
    canvas.dataset.trail=trail.join(">");
    const relevant=new Set<string>(trailIds);
    if(active){
      relevant.add(active.id);
      for(const e of graph.edges){
        if(e.from===active.id)relevant.add(e.to);
        if(e.to===active.id)relevant.add(e.from);
      }
    }
    for(const edge of graph.edges){
      const from=byId.get(edge.from),to=byId.get(edge.to);
      if(!from||!to)continue;
      // Fast bounding-box rejection: lines wholly outside the visible frame
      // cost no Canvas stroke, even when the catalog is much larger.
      if(Math.max(from.x,to.x)<-margin||Math.min(from.x,to.x)>width+margin||
         Math.max(from.y,to.y)<-margin||Math.min(from.y,to.y)>height+margin)continue;
      const onPath=edge.kind==="contains"&&trailLinks.has(edge.from+"|"+edge.to);
      const selected=!!active&&(edge.from===active.id||edge.to===active.id);
      ctx.beginPath();ctx.moveTo(from.x,from.y);ctx.lineTo(to.x,to.y);
      ctx.strokeStyle=onPath?"rgba(247,198,105,.96)":
        selected?"rgba(241,191,92,.65)":
        edge.kind==="duplicate"?"rgba(218,169,75,.4)":
        edge.kind==="tag"?"rgba(79,187,169,.3)":"rgba(176,187,205,.22)";
      ctx.lineWidth=onPath?2.1+pulse*1.2:selected?1.6:edge.kind==="contains"?.8:1.1;
      ctx.stroke();
    }
    let paintedNodes=0;
    for(const p of points){
      if(!inside(p))continue;
      paintedNodes++;
      const {node,x,y,r}=p;
      const chosen=active?.id===node.id;
      const inPath=node.kind==="folder"&&(current===node.folder||
        current.startsWith(node.folder+"/"));
      if(chosen||inPath){
        ctx.beginPath();ctx.arc(x,y,r+(chosen?5:3),0,2*Math.PI);
        ctx.fillStyle=chosen?"rgba(223,173,80,.25)":"rgba(223,173,80,.12)";
        ctx.fill();
      }
      drawShape(ctx,p);
      const base=node.kind==="root"?"#D9A441":node.kind==="cluster"?"#C6A366":
        node.kind==="folder"?(inPath?"#E9BA65":"#8CA8ED"):"#CFD5E1";
      const dense=graph.nodes.length>160;
      // Faux 3D volume with bounded radial shading; a selective glow is
      // deliberately limited to active/ancestral nodes (no continuous GPU loop).
      const grad=!dense?ctx.createRadialGradient(x-r*.35,y-r*.4,.3,x,y,Math.max(3,r*1.4)):null;
      if(grad){grad.addColorStop(0,"#fff2cf");grad.addColorStop(.3,base);grad.addColorStop(1,"#292634");}
      ctx.fillStyle=grad||base;
      ctx.globalAlpha=active&&!relevant.has(node.id)&&!inPath?0.48:1;
      if(chosen||trailIds.has(node.id)){
        ctx.shadowColor="rgba(242,191,88,.7)";
        ctx.shadowBlur=chosen?10+pulse*9:5;
      }
      ctx.fill();
      ctx.shadowBlur=0;ctx.globalAlpha=1;
      if(chosen&&pulse>0){
        ctx.beginPath();ctx.arc(x,y,r+5+(1-pulse)*15,0,2*Math.PI);
        ctx.strokeStyle="rgba(248,199,93,"+(pulse*.66)+")";
        ctx.lineWidth=1.4+pulse*1.2;ctx.stroke();
      }
      if(chosen){
        drawShape(ctx,{...p,r:r+3});
        ctx.strokeStyle="#E9BA65";ctx.lineWidth=1.4;ctx.stroke();
      }
      if(node.kind==="cluster"&&r>=8){
        ctx.font="bold 9px system-ui";ctx.textAlign="center";ctx.textBaseline="middle";
        ctx.fillStyle="#15120D";
        ctx.fillText(node.count>999?"999+":String(node.count||node.hiddenFolders),x,y,2*r);
      }
    }
    canvas.dataset.paintedNodes=String(paintedNodes);
    canvas.dataset.pulse=pulse>0?"active":"idle";
    if((revealProgress<1||pulse>0)&&!document.hidden)invalidate();
    if(graph.nodes.length===1){
      ctx.fillStyle="rgba(206,207,211,.6)";ctx.textAlign="center";ctx.font="11px system-ui";
      ctx.fillText("Загрузите файлы, чтобы карта выросла",width/2,height-17);
    }
  };
  const invalidate=()=>{
    if(queued||!root.isConnected)return;
    queued=true;raf=requestAnimationFrame(paint);
  };
  const detail=(node:MiniNode)=>{
    if(node.kind==="cluster")
      return "Группа · "+node.hiddenFiles+" файлов · "+node.hiddenFolders+" папок · "+human(node.size)+
        " · увеличьте масштаб для подробностей";
    const prefix=node.kind==="file"?"Файл":node.kind==="folder"?"Папка":"Диск";
    return prefix+" · "+node.name+" · "+node.count+" файлов · "+human(node.size);
  };
  const locate=(x:number,y:number)=>{
    let best:{node:MiniNode;distance:number}|null=null;
    for(const p of points){
      const d=Math.hypot(x-p.x,y-p.y);
      if(d>Math.max(p.r+6,9)||best&&d>=best.distance)continue;
      best={node:p.node,distance:d};
    }
    return best?.node??null;
  };
  const choose=(node:MiniNode|null)=>{
    if(active?.id!==node?.id)pulseStart=performance.now();
    active=node;
    status.textContent=node?detail(node):"Клик — выбор, двойной клик — открыть";
    invalidate();
  };
  const navigate=(node:MiniNode)=>{
    if(node.kind==="cluster"){
      view.focus=node.folder;view.zoom=Math.max(2.5,view.zoom);
      view.panX=0;view.panY=0;
      modeKey="";rebuild();
      choose(graph.nodes.find(n=>n.kind==="folder"&&n.folder===node.folder)||null);
      centerOn(active);save();return;
    }
    if(node.kind==="file")actions.openFile(node.id.slice(5));
    else actions.openFolder(node.folder);
  };
  const point=(e:MouseEvent|PointerEvent|WheelEvent)=>{
    const rect=canvas.getBoundingClientRect();
    return {x:e.clientX-rect.left,y:e.clientY-rect.top};
  };
  const zoom=(factor:number,x=width/2,y=height/2)=>{
    const before=view.zoom,next=clampView(before*factor,.65,9);
    if(next===before)return;
    const r=next/before;
    view.panX=clampView(x-width/2-(x-width/2-view.panX)*r,-3000,3000);
    view.panY=clampView(y-height/2-(y-height/2-view.panY)*r,-3000,3000);
    view.zoom=next;
    modeKey="";rebuild();invalidate();save();
  };
  canvas.addEventListener("wheel",event=>{
    event.preventDefault();
    const p=point(event);zoom(event.deltaY>0?.86:1.17,p.x,p.y);
  },{passive:false});
  canvas.addEventListener("pointerdown",event=>{
    if(event.button!==0)return;
    dragging=true;dragged=false;suppressClick=false;
    startX=event.clientX;startY=event.clientY;
    startPanX=view.panX;startPanY=view.panY;
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove",event=>{
    if(dragging){
      if(Math.hypot(event.clientX-startX,event.clientY-startY)>4)dragged=true;
      if(dragged){
        view.panX=clampView(startPanX+event.clientX-startX,-3000,3000);
        view.panY=clampView(startPanY+event.clientY-startY,-3000,3000);
        invalidate();
      }
    }else{
      const p=point(event),node=locate(p.x,p.y);
      canvas.style.cursor=node?"pointer":"grab";canvas.title=node?detail(node):"";
    }
  });
  canvas.addEventListener("pointerup",()=>{
    if(!dragging)return;
    dragging=false;suppressClick=dragged;
    if(dragged)save();
  });
  canvas.addEventListener("pointercancel",()=>{dragging=false;suppressClick=true;});
  canvas.addEventListener("click",event=>{
    if(suppressClick){suppressClick=false;return;}
    const p=point(event);choose(locate(p.x,p.y));
  });
  canvas.addEventListener("dblclick",event=>{
    const p=point(event),node=locate(p.x,p.y);
    if(node)navigate(node);else actions.openFull();
  });
  canvas.addEventListener("keydown",event=>{
    if(event.key==="+"||event.key==="="){event.preventDefault();zoom(1.2);}
    else if(event.key==="-"){event.preventDefault();zoom(.83);}
    else if(event.key==="0"){event.preventDefault();reset.click();}
    else if(event.key==="Enter"){
      event.preventDefault();
      if(active)navigate(active);else actions.openFull();
    }else if(event.key==="Escape"&&active){
      event.preventDefault();choose(null);
    }
  });
  reset.addEventListener("click",()=>{
    view.zoom=1;view.panX=0;view.panY=0;view.focus="";
    modeKey="";rebuild();selectFolder();invalidate();save();
  });
  // Only visible, mounted pages draw. Disconnect observers after navigation
  // to prevent retained Canvas/tree instances from accumulating.
  let everConnected=false;
  if(typeof ResizeObserver!=="undefined"){
    const observer=new ResizeObserver(()=>{
      if(root.isConnected){everConnected=true;invalidate();}
      else if(everConnected){observer.disconnect();if(raf)cancelAnimationFrame(raf);}
    });
    observer.observe(frame);
  }
  return {root,update(nextFiles,nextFolders,folder){
    files=nextFiles;folders=nextFolders;current=folder;
    const nextHash=hashCatalog(files,folders);
    if(hash!==nextHash){hash=nextHash;modeKey="";}
    if(view.focus&&!folders.includes(view.focus))view.focus="";
    rebuild();selectFolder();
    // When navigating the folder tree, center the real matching node. The
    // same-folder refresh leaves the user's saved/manual pan untouched.
    if(lastFolder!==folder){
      centerOn(active);
      if(folder)pulseStart=performance.now();
    }
    lastFolder=folder;
    const sampled=graph.shownFiles<graph.totalFiles||graph.shownFolders<graph.totalFolders;
    root.style.setProperty("--dk9-map-weight",String(adaptiveMapWeight(folders.length)));
    count.textContent=files.filter(f=>!f.deletedAt).length+" файлов · "+folders.length+" папок"+
      (sampled?" · группы":"");
    status.textContent=sampled?"Кластеры: увеличение раскрывает детали":detail(active||graph.nodes[0]!);
    invalidate();
  }};
}
