/**
 * Tsukimera Disk 15.0 — the graph IS the interface.
 * A single, borderless HTML5 Canvas with no permanent text, buttons, cards,
 * lists, legend, inputs or toolbars. File actions use the existing Disk APIs.
 * A context menu appears only on explicit secondary click, keeping access to
 * evidence-backed analysis without cluttering the visualization.
 */
import {el} from "../dom";
import {api,type DiskFile} from "../api";
import {human} from "./disk-model";
import {extractDocument,semanticFromRecords,type SemanticIndex,type SemanticRecord}
  from "./disk-map-semantic";
import {graphFromCatalog,graphInitial,graphForceStep,type GraphNode,type GraphPoint,
  type GraphScene,type GraphLink} from "./disk-map-graph";
import {normalizeMiniView,MINI_VIEW_KEY,clampView} from "./disk-map-mini-model";
import {SPATIAL_DENSITY_KEY} from "./disk-map-spatial";
import {graphRoute,graphNeighbors,graphEdgeAt,graphEdgeExplanation,type GraphRoute}
  from "./disk-map-explore";
import {graphArtLayout,artCommunityColor,artRgb,artDepth,artImportance,
  artBundleEdges,artCurve,artCurvePoint,artCurveHit,artClouds,artClusterStep,
  artEase,artLerp,artInertia,type ArtLayout,type ArtBundle}
  from "./disk-map-art";
import {graphScreen,graphBounds,graphCamera,anchoredZoom,graphMotionBudget,graphLerp,
  type GraphBounds,type GraphScreen} from "./disk-map-responsive";
import {writePreference} from "../preferences";

type Actions={openFolder:(folder:string)=>void;openFile:(id:string)=>void};
export interface MiniDiskMap{
  root:HTMLElement;
  update:(files:DiskFile[],folders:string[],current:string)=>void;
  highlightFile:(id:string|null)=>void;
}
type Mode="all"|"meaning"|"versions"|"entities";
const shades:Record<string,string>={
  folder:"#d8aa65",tag:"#b49ae3",topic:"#e4b76c",
  person:"#dba0c1",organization:"#82c9bb",date:"#adabd9",
  project:"#a1d3a7",revision:"#a7b1bd",image:"#79bde1",
  document:"#edd0a2",archive:"#b29adb",video:"#d7a0c7",
  audio:"#87ccbb",code:"#8aaed8",other:"#bbc5d3"
};
const relationColors:Record<string,string>={
  contains:"183,177,160",duplicate:"221,141,91",tag:"172,145,208",
  entity:"116,199,171",lexical:"113,163,224",reference:"237,185,104",
  revision:"173,184,190",co_mention:"229,159,196"
};
const parentOf=(p:string)=>p.includes("/")?p.slice(0,p.lastIndexOf("/")):"";
const reduced=()=>window.matchMedia("(prefers-reduced-motion:reduce)").matches;
const clamp=(x:number,a:number,b:number)=>Math.min(b,Math.max(a,x));
const clickItem=(label:string,run:()=>void)=>{
  const item=el("button",{type:"button",cls:"dk-graph-menu-action",textContent:label});
  item.addEventListener("click",run);return item;
};
export function createMiniDiskMap(actions:Actions):MiniDiskMap{
  const stored=normalizeMiniView((()=>{
    try{return JSON.parse(localStorage.getItem(MINI_VIEW_KEY)||"null");}catch{return null;}
  })());
  let zoom=clampView(stored.zoom,.65,4),panX=stored.panX,panY=stored.panY;
  const canvas=el("canvas",{cls:"dk-mini-map-canvas dk-graph-canvas",attrs:{
    tabindex:"0",role:"application",
    "aria-label":"Живая карта связей: точки и линии. Наведите для имени, нажмите для открытия, колесо — масштаб, перетащите — перемещение. Двойной щелчок на фоне — развернуть, Escape — свернуть. Контекстное меню — исследование и фильтры. Стрелки — выбор узла, Enter — открыть, 0 — центр."
  }});
  const frame=el("div",{cls:"dk-mini-map-frame dk-omni-stage dk-graph-stage"},canvas);
  const root=el("section",{cls:"dk-mini-map dk-omni-explorer dk-graph-view dk-graph-only",
    attrs:{"aria-label":"Граф связей файлов"}},frame);

  let files:DiskFile[]=[],folders:string[]=[],current="",depth=2;
  let scene:GraphScene=graphFromCatalog([],[],"");
  let mode:Mode="all",includeTags=true,includeDuplicates=true;
  let globalGraph=true,focusId:string|null=null;
  let routeStart:string|null=null,routeEnd:string|null=null,route:GraphRoute|null=null;
  let hoverEdge:GraphLink|null=null,hoverX=0,hoverY=0;
  let semantic:SemanticIndex|null=null,analysisGeneration=0;
  let coords=new Map<string,GraphPoint>(),appearing=new Map<string,number>();
  let art:ArtLayout=graphArtLayout(scene),renderBundles:ArtBundle[]=[];
  let hoverBundle:ArtBundle|null=null,routePulseUntil=0;
  let cameraRaf=0,inertiaRaf=0,dragVelocityX=0,dragVelocityY=0;
  let bounds:GraphBounds=graphBounds([]),screen:GraphScreen=graphScreen(320,280);
  let lastScreenKey="",highlightTimer=0,pointerInsideGraph=false;
  let fading:Array<{point:GraphPoint;node:GraphNode;until:number}>=[];
  let hovered:string|null=null,selected:string|null=null;
  let expanded=false,anchor:Node|null=null,nextSibling:Node|null=null,homePage:HTMLElement|null=null;
  let pointerDown=false,pointMoved=false,dragId:string|null=null;
  let lastX=0,lastY=0,originX=0,originY=0,prevMoveX=0,prevMoveY=0;
  let physicsFrame=0,raf=0,saveTimer=0,idleTimer=0,lastTap=0;
  let menu:HTMLElement|null=null,visible=false,analysisBusy=false;
  let repaintQueued=false;

  function persist(){
    clearTimeout(saveTimer);
    saveTimer=window.setTimeout(()=>{
      writePreference(MINI_VIEW_KEY,JSON.stringify({zoom,panX,panY,focus:""}));
    },220);
  }
  function measure():GraphScreen{
    const rect=frame.getBoundingClientRect();
    return graphScreen(rect.width||320,rect.height||280,window.devicePixelRatio||1,
      zoom,expanded);
  }
  function viewport(){
    screen=measure();
    const cam=graphCamera(bounds,screen,zoom,panX,panY);
    return {w:screen.width,h:screen.height,cx:cam.cx,cy:cam.cy,
      scale:cam.scale,dpr:screen.dpr,pxW:screen.pixelWidth,pxH:screen.pixelHeight,
      markerScale:screen.markerScale,lineScale:screen.lineScale,
      touchRadius:screen.touchRadius,labelSize:screen.labelSize};
  }
  function pointerHit(clientX:number,clientY:number):GraphNode|null{
    const bounds=canvas.getBoundingClientRect(),mx=clientX-bounds.left,my=clientY-bounds.top;
    const {scale,cx,cy}=viewport();
    let nearest:GraphNode|null=null,dist=Infinity;
    for(const n of scene.nodes){
      const p=coords.get(n.id);if(!p)continue;
      const d=Math.hypot(cx+p.x*scale-mx,cy+p.y*scale-my);
      if(d<Math.max(screen.touchRadius,(n.kind==="folder"?6:3.5)*screen.markerScale*Math.max(.65,scale)+7)&&d<dist){
        nearest=n;dist=d;
      }
    }
    return nearest;
  }
  function tint(n:GraphNode):string{
    return n.kind==="file"||n.kind==="folder"||n.kind==="revision"?
      artCommunityColor(art,n.id):
      shades[n.kind]||artCommunityColor(art,n.id);
  }
  function fileHighlight(node:GraphNode|null){
    const page=homePage||root.closest<HTMLElement>(".disk-page");
    if(!page)return;
    for(const e of page.querySelectorAll<HTMLElement>(".dk-file.dk-map-linked"))
      e.classList.remove("dk-map-linked");
    if(node?.fileId)for(const e of page.querySelectorAll<HTMLElement>(".dk-file[data-file-id]"))
      if(e.dataset.fileId===node.fileId)e.classList.add("dk-map-linked");
  }
  function highlightFile(id:string|null){
    const node=scene.nodes.find(n=>n.fileId===id);
    if(id&&!node)return;
    selected=node?.id||null;hovered=selected;
    fileHighlight(node||null);draw();
  }
  function cancelCamera(){
    if(cameraRaf)cancelAnimationFrame(cameraRaf);cameraRaf=0;
    if(inertiaRaf)cancelAnimationFrame(inertiaRaf);inertiaRaf=0;
  }
  function panTo(targetX:number,targetY:number,duration=280){
    if(cameraRaf)cancelAnimationFrame(cameraRaf);
    const toX=clamp(targetX,-1800,1800),toY=clamp(targetY,-1800,1800);
    if(reduced()||!root.isConnected||duration<=0){
      panX=toX;panY=toY;persist();draw();return;
    }
    const start=performance.now(),fromX=panX,fromY=panY;
    function step(now:number){
      cameraRaf=0;
      if(!root.isConnected||pointerDown)return;
      const t=artEase((now-start)/duration);
      panX=artLerp(fromX,toX,t);panY=artLerp(fromY,toY,t);
      draw();
      if(t<.999)cameraRaf=requestAnimationFrame(step);
      else {panX=toX;panY=toY;persist();draw();}
    }
    cameraRaf=requestAnimationFrame(step);
  }
  function centerNode(id:string,changeScale=true){
    const p=coords.get(id);if(!p)return;
    if(changeScale&&zoom<1.35){
      zoom=1.35;
      const next=measure();
      if(next.detail!==screen.detail)rebuild();
    }
    const point=coords.get(id);if(!point)return;
    const v=viewport();
    // Folder selection magnetises toward its actual community centroid.
    const n=scene.nodes.find(n=>n.id===id);
    const community=n?.kind==="folder"?
      art.communities.find(c=>c.id===art.membership.get(id)):null;
    const group=community?.members.map(key=>coords.get(key)).filter(
      (p):p is GraphPoint=>!!p);
    const target=group?.length?{
      x:group.reduce((sum,p)=>sum+p.x,0)/group.length,
      y:group.reduce((sum,p)=>sum+p.y,0)/group.length
    }:point;
    const targetX=panX+v.w/2-(v.cx+target.x*v.scale);
    const targetY=panY+v.h/2-(v.cy+target.y*v.scale);
    panTo(targetX,targetY);
  }
  function focusOnNode(id:string|null){
    if(id&&!scene.nodes.some(n=>n.id===id))return;
    focusId=id;route=null;routeStart=null;routeEnd=null;
    canvas.dataset.focusNode=focusId||"";
    selected=id;hovered=id;
    if(id)centerNode(id);else draw();
  }
  function startRoute(id:string|null){
    if(!id||!scene.nodes.some(n=>n.id===id))return;
    routeStart=id;routeEnd=null;route=null;focusId=null;
    selected=id;hovered=id;
    centerNode(id,false);
  }
  function finishRoute(id:string){
    if(!routeStart||!scene.nodes.some(n=>n.id===id))return;
    routeEnd=id;
    route=graphRoute(scene,routeStart,id);
    selected=id;hovered=id;
    if(route){
      routePulseUntil=reduced()?0:performance.now()+950;
      centerNode(id,false);schedule();
    }else draw();
    canvas.dataset.route=route?String(route.links.length):"unavailable";
  }
  function activate(n:GraphNode){
    if(n.kind==="folder")actions.openFolder(n.folder);
    else if(n.kind==="file"&&n.fileId)actions.openFile(n.fileId);
    else if(n.kind==="tag"||n.kind==="topic"||n.kind==="person"||
      n.kind==="organization"||n.kind==="date"||n.kind==="project"){
      // Selecting a concept highlights its actual neighbors, never a fake file.
      selected=n.id;hovered=n.id;draw();
    }
  }
  function focus(n:GraphNode){
    selected=n.id;hovered=n.id;fileHighlight(n);draw();
  }
  function changeZoom(factor:number,atX?:number,atY?:number){
    cancelCamera();
    const previous=viewport();
    const next=clampView(zoom*factor,.65,4);
    if(Math.abs(next-zoom)<.00001)return;
    const anchorX=atX===undefined?previous.w/2:clamp(atX,0,previous.w);
    const anchorY=atY===undefined?previous.h/2:clamp(atY,0,previous.h);
    const oldDetail=screen.detail;
    const afterScreen=graphScreen(previous.w,previous.h,window.devicePixelRatio||1,
      next,expanded);
    const camera=graphCamera(bounds,screen,zoom,panX,panY);
    const shift=anchoredZoom(camera,afterScreen,bounds,next,anchorX,anchorY);
    zoom=next;panX=clamp(shift.panX,-1800,1800);
    panY=clamp(shift.panY,-1800,1800);
    persist();
    // Only changes in actual level of detail require new graph nodes.
    if(oldDetail!==afterScreen.detail){
      // Replacing folded folder groups changes graph bounds. Preserve the
      // exact graph-space point under the cursor across this LOD transition.
      const anchorWorldX=(anchorX-camera.cx)/camera.scale;
      const anchorWorldY=(anchorY-camera.cy)/camera.scale;
      rebuild();
      const refreshed=graphCamera(bounds,measure(),zoom,0,0);
      panX=clamp(anchorX-refreshed.cx-anchorWorldX*refreshed.scale,-1800,1800);
      panY=clamp(anchorY-refreshed.cy-anchorWorldY*refreshed.scale,-1800,1800);
      persist();draw();
    }else draw();
  }
  function setExpanded(value:boolean){
    if(value===expanded)return;
    cancelCamera();
    dismissMenu();expanded=value;
    if(value){
      anchor=root.parentNode;nextSibling=root.nextSibling;
      homePage=root.closest<HTMLElement>(".disk-page");
      document.body.append(root);
      root.classList.add("dk-graph-expanded");
    }else{
      root.classList.remove("dk-graph-expanded");
      if(anchor){
        if(nextSibling?.parentNode===anchor)anchor.insertBefore(root,nextSibling);
        else anchor.appendChild(root);
      }
    }
    canvas.focus({preventScroll:true});
    requestAnimationFrame(()=>rebuild());
  }
  function dismissMenu(){menu?.remove();menu=null;}
  // A temporary context menu is the only optional chrome. None exists in
  // the default DOM: the ordinary view is literally just a Canvas.
  function openMenu(event:MouseEvent){
    event.preventDefault();dismissMenu();
    const context=el("div",{cls:"dk-graph-popover",attrs:{role:"menu","aria-label":"Действия графа"}});
    const option=(text:string,callback:()=>void)=>{
      const button=clickItem(text,()=>{dismissMenu();callback();});
      context.append(button);
    };
    option("Изучить тексты документов",()=>{void analyzeDocuments();});
    option("Все реальные связи",()=>{mode="all";rebuild();});
    option("Связи по содержанию",()=>{mode="meaning";rebuild();});
    option("Дубликаты и редакции",()=>{mode="versions";rebuild();});
    option("Общие сущности",()=>{mode="entities";rebuild();});
    option("Глубина "+(depth===3?1:depth+1),()=>{depth=depth===3?1:depth+1;rebuild();});
    option("Весь Диск: глобальный граф",()=>{
      globalGraph=true;focusId=null;route=null;routeStart=null;routeEnd=null;rebuild();
    });
    option("Только текущая папка",()=>{
      globalGraph=false;focusId=null;route=null;routeStart=null;routeEnd=null;rebuild();
    });
    const hit=pointerHit(event.clientX,event.clientY);
    if(hit){selected=hit.id;hovered=hit.id;}
    if(hit){
      option("Фокус на этом узле",()=>focusOnNode(hit.id));
      if(hit.kind==="file"){
        option("Начать путь от этого файла",()=>startRoute(hit.id));
        if(routeStart&&routeStart!==hit.id)
          option("Показать путь от выбранного файла",()=>finishRoute(hit.id));
      }
    }
    if(focusId)option("Сбросить фокус",()=>focusOnNode(null));
    if(routeStart)option("Очистить маршрут",()=>{
      routeStart=null;routeEnd=null;route=null;canvas.dataset.route="";draw();
    });
    option("Развернуть / свернуть",()=>setExpanded(!expanded));
    const rect=frame.getBoundingClientRect();
    context.style.maxHeight=Math.max(135,rect.height-8)+"px";
    frame.append(context);menu=context;
    // Keep the complete contextual action list scrollable and accessible
    // inside small laptop-sized graph areas, never clipped off-screen.
    const menuHeight=context.getBoundingClientRect().height;
    context.style.left=clamp(event.clientX-rect.left,3,Math.max(3,rect.width-205))+"px";
    context.style.top=clamp(event.clientY-rect.top,3,
      Math.max(3,rect.height-menuHeight-4))+"px";
  }
  async function analyzeDocuments(){
    const gen=++analysisGeneration;
    const eligible=scene.nodes.filter(n=>n.kind==="file"&&n.fileId).slice(0,24);
    const known=new Map(files.map(f=>[f.id,f]));
    const names=eligible.map(n=>n.name),records:SemanticRecord[]=[];
    let unreadable=0,truncated=0;
    analysisBusy=true;canvas.dataset.analysis="running";draw();
    for(const node of eligible){
      if(gen!==analysisGeneration)break;
      const f=node.fileId&&known.get(node.fileId);
      if(!f||f.deletedAt)continue;
      const response=await api.diskText(f.id);
      if(gen!==analysisGeneration)break;
      if(!response.ok||!response.value.text?.trim()){unreadable++;continue;}
      if(response.value.truncated)truncated++;
      records.push(extractDocument(f,response.value.text,names));
    }
    if(gen!==analysisGeneration)return;
    semantic=semanticFromRecords(records);
    semantic.unreadable=unreadable;semantic.truncated=truncated;
    analysisBusy=false;canvas.dataset.analysis="finished";rebuild();
  }
  function rebuild(){
    const oldNodes=new Map(scene.nodes.map(n=>[n.id,n]));
    const oldPositions=coords;
    screen=measure();
    const detailed=localStorage.getItem(SPATIAL_DENSITY_KEY)==="detailed";
    const detail=screen.detail;
    const areaBudget=Math.round(screen.maxNodes*(detailed?1.15:1));
    const limit=clamp(areaBudget,24,240);
    scene=graphFromCatalog(files,folders,current,{
      depth:detail==="detail"?3:detail==="overview"?Math.min(depth,2):depth,
      limit,perFolder:screen.perFolder,detailLevel:detail,
      includeTags,includeDuplicates,semantic,viewMode:mode,global:globalGraph
    });
    art=graphArtLayout(scene);
    const currentTime=performance.now();
    const next=new Map<string,GraphPoint>(),entering=new Map<string,number>();
    const currentIds=new Set(scene.nodes.map(n=>n.id));
    if(!reduced()){
      for(const [id,node] of oldNodes){
        const point=oldPositions.get(id);
        if(!currentIds.has(id)&&point)fading.push({node,point:{...point},until:currentTime+340});
      }
      fading=fading.filter(f=>f.until>currentTime).slice(-40);
    }else fading=[];
    for(const n of scene.nodes){
      next.set(n.id,oldPositions.get(n.id)||graphInitial(n));
      if(!reduced()&&!oldNodes.has(n.id))entering.set(n.id,currentTime);
      else if(appearing.has(n.id))entering.set(n.id,appearing.get(n.id)!);
    }
    coords=next;appearing=entering;physicsFrame=0;
    if(focusId&&!next.has(focusId))focusId=null;
    if(selected&&!next.has(selected))selected=null;
    if(routeStart&&routeEnd){
      route=graphRoute(scene,routeStart,routeEnd);
      canvas.dataset.route=route?String(route.links.length):"unavailable";
    }else if(routeStart&&!next.has(routeStart)){
      routeStart=null;routeEnd=null;route=null;canvas.dataset.route="";
    }
    hoverEdge=null;hoverBundle=null;renderBundles=[];
    // Freeze camera extents for each physics burst. Continual re-fitting
    // during every force tick would produce a nauseating zoom wobble.
    bounds=graphBounds(coords.values());
    lastScreenKey=screen.width+"x"+screen.height+":"+detail;
    canvas.dataset.detail=detail;
    canvas.dataset.capacity=String(limit);
    canvas.dataset.aspect=screen.ultrawide?"ultrawide":"standard";
    canvas.dataset.layer="graph";
    canvas.dataset.communities=String(art.communities.length);
    canvas.dataset.nodes=String(scene.nodes.length);
    canvas.dataset.links=String(scene.links.length);
    canvas.dataset.focus=current;
    canvas.dataset.mode=mode;
    canvas.dataset.scope=globalGraph?"global":"folder";
    canvas.dataset.focusNode=focusId||"";
    schedule();
  }
  // Rich glow and grouping are painted INSIDE the Canvas: never DOM cards.
  function draw(){
    if(!root.isConnected)return;
    const {w,h,scale,cx,cy,dpr,pxW:pw,pxH:ph,lineScale,markerScale,labelSize}=viewport();
    if(canvas.width!==pw||canvas.height!==ph){canvas.width=pw;canvas.height=ph;}
    const ctx=canvas.getContext("2d");if(!ctx)return;
    ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
    const now=performance.now();
    // A diffuse nebula makes real clusters legible without hard outlines.
    const groups=new Map<string,GraphPoint[]>();
    const folderCounts=new Map(scene.nodes.filter(n=>n.kind==="folder")
      .map(n=>[n.folder,n.count||0]));
    for(const n of scene.nodes){
      if(n.kind!=="file")continue;
      const p=coords.get(n.id);if(!p)continue;
      const a=groups.get(n.folder)||[];a.push(p);groups.set(n.folder,a);
    }
    let cloud=0;
    for(const positions of groups.values()){
      if(positions.length<3||cloud++>8)continue;
      const x=cx+positions.reduce((sum,p)=>sum+p.x,0)/positions.length*scale;
      const y=cy+positions.reduce((sum,p)=>sum+p.y,0)/positions.length*scale;
      const descendants=folderCounts.get([...groups.keys()].find(k=>groups.get(k)===positions)||"")||positions.length;
      const radius=clamp(positions.reduce((max,p)=>Math.max(max,Math.hypot(
        cx+p.x*scale-x,cy+p.y*scale-y)),0)+
        16+Math.sqrt(descendants)*2.5,28,Math.min(w,h)*.48);
      const grad=ctx.createRadialGradient(x,y,2,x,y,radius);
      grad.addColorStop(0,"rgba(219,166,83,.11)");
      grad.addColorStop(.44,"rgba(154,112,68,.045)");
      grad.addColorStop(1,"rgba(154,112,68,0)");
      ctx.fillStyle=grad;ctx.beginPath();ctx.arc(x,y,radius,0,Math.PI*2);ctx.fill();
    }
    const active=hovered||selected;
    const routeNodes=route?new Set(route.nodes):null;
    const routeEdges=route?new Set(route.links):null;
    const focusNodes=focusId?graphNeighbors(scene,focusId,2):null;
    const neighbor=new Set<string>(active?[active]:[]);
    if(active)for(const e of scene.links){
      if(e.source===active)neighbor.add(e.target);
      if(e.target===active)neighbor.add(e.source);
    }
    const rootPath=new Set<string>();
    if(active){
      let child=active;
      for(let i=0;i<14;i++){
        const up=scene.links.find(e=>e.kind==="contains"&&e.target===child);
        if(!up)break;
        rootPath.add(up.source+"|"+up.target);child=up.source;
      }
    }
    // Connections are factual; luminous routes reveal hierarchy/semantic ties.
    for(const e of scene.links){
      const p=coords.get(e.source),q=coords.get(e.target);
      if(!p||!q)continue;
      const sx=cx+p.x*scale,sy=cy+p.y*scale;
      const tx=cx+q.x*scale,ty=cy+q.y*scale;
      if((sx<0&&tx<0)||(sx>w&&tx>w)||(sy<0&&ty<0)||(sy>h&&ty>h))continue;
      const onRoute=routeEdges?.has(e)||false;
      const onFocus=focusNodes?focusNodes.has(e.source)&&focusNodes.has(e.target):false;
      const highlighted=onRoute||e===hoverEdge||
        !!active&&(e.source===active||e.target===active);
      const partOfPath=rootPath.has(e.source+"|"+e.target);
      const fade=routeNodes?!onRoute:
        focusNodes?!onFocus:
        !!active&&!highlighted&&!partOfPath;
      const rgb=relationColors[e.kind]||relationColors.contains;
      const activePulse=highlighted&&!reduced()?
        .08*Math.sin(now/230):0;
      const opacity=fade?.048:onRoute?.97:highlighted?.82+activePulse:
        partOfPath?.69:e.kind==="contains"?.18:.31;
      const strength=clamp(e.weight??1,.25,1.6);
      ctx.save();
      ctx.beginPath();ctx.moveTo(sx,sy);ctx.lineTo(tx,ty);
      ctx.strokeStyle="rgba("+rgb+","+opacity+")";
      ctx.lineWidth=((onRoute?2.3:highlighted?1.25:.45)+
        strength*(highlighted?1.1:.5))*lineScale;
      if(e.kind==="lexical"||e.kind==="entity")ctx.setLineDash([3.2,5.1]);
      if(highlighted||partOfPath){
        ctx.shadowColor="rgba("+rgb+",.75)";
        ctx.shadowBlur=expanded?12:6;
      }
      ctx.stroke();ctx.restore();
    }
    fading=fading.filter(x=>x.until>now);
    for(const ghost of fading){
      const x=cx+ghost.point.x*scale,y=cy+ghost.point.y*scale;
      if(x<0||x>w||y<0||y>h)continue;
      ctx.globalAlpha=(ghost.until-now)/340*.3;
      ctx.fillStyle=tint(ghost.node);ctx.beginPath();ctx.arc(x,y,2.6,0,Math.PI*2);ctx.fill();
    }
    ctx.globalAlpha=1;
    for(const n of scene.nodes){
      const p=coords.get(n.id);if(!p)continue;
      const x=cx+p.x*scale,y=cy+p.y*scale;
      if(x<-20||x>w+20||y<-20||y>h+20)continue;
      const isActive=n.id===active;
      const dim=routeNodes?!routeNodes.has(n.id):
        focusNodes?!focusNodes.has(n.id):
        !!active&&!neighbor.has(n.id);
      const entered=appearing.get(n.id);
      const shown=entered===undefined||reduced()?1:clamp((now-entered)/350,0,1);
      const importance=n.id===scene.focus?6.3:
        n.kind==="folder"?5.1:n.kind==="file"?
        2.8+Math.min(1.6,Math.log10(1+Math.max(0,n.size))*.18):4.3;
      const countFactor=n.kind==="folder"?1+Math.min(.75,Math.log2(1+(n.count||0))/10):1;
      const radius=clamp(importance*Math.sqrt(Math.max(.46,scale))*
        markerScale*countFactor,2,16);
      if(isActive){
        const halo=ctx.createRadialGradient(x,y,radius,x,y,radius+22);
        const hex=tint(n);
        halo.addColorStop(0,"rgba(235,188,116,.29)");
        halo.addColorStop(.25,"rgba(230,177,93,.15)");
        halo.addColorStop(1,"rgba(230,177,93,0)");
        ctx.fillStyle=halo;ctx.beginPath();ctx.arc(x,y,radius+22,0,Math.PI*2);ctx.fill();
        ctx.strokeStyle=hex;ctx.globalAlpha=.75;
        ctx.lineWidth=.8;ctx.beginPath();ctx.arc(x,y,radius+4,0,Math.PI*2);ctx.stroke();
      }
      ctx.globalAlpha=(dim?.19:1)*shown;
      ctx.fillStyle=tint(n);ctx.beginPath();ctx.arc(x,y,radius,0,Math.PI*2);
      if(isActive||n.id===scene.focus||routeNodes?.has(n.id)){
        ctx.shadowBlur=isActive?16:7;ctx.shadowColor=tint(n);
      }
      ctx.fill();ctx.shadowBlur=0;ctx.globalAlpha=1;
    }
    // Names are not permanent UI. Only the actively examined node gets
    // a legible on-canvas label, with a bounded dark vignette behind it.
    const chosen=scene.nodes.find(n=>n.id===active);
    const point=chosen&&coords.get(chosen.id);
    if(chosen&&point){
      const x=cx+point.x*scale,y=cy+point.y*scale;
      const text=chosen.name.length>(expanded?70:31)?
        chosen.name.slice(0,expanded?69:30)+"…":chosen.name;
      ctx.font="500 "+Math.round(labelSize)+"px system-ui,sans-serif";
      const tw=ctx.measureText(text).width,pad=7;
      const px=clamp(x+12,4,Math.max(4,w-tw-pad*2-4));
      const py=clamp(y-25,5,Math.max(5,h-26));
      ctx.fillStyle="rgba(8,10,16,.80)";
      ctx.beginPath();ctx.roundRect(px,py,tw+pad*2,23,7);ctx.fill();
      ctx.fillStyle="#e9dcc8";ctx.fillText(text,px+pad,py+15);
    }
    // The chosen path is temporarily legible on the Canvas itself: never a
    // duplicate document list or a persistent overlay panel.
    if(route&&route.nodes.length>1){
      const count=Math.min(route.nodes.length,9);
      for(const id of route.nodes.slice(0,count)){
        const n=scene.nodes.find(node=>node.id===id),p=coords.get(id);
        if(!n||!p||n.id===active)continue;
        const x=cx+p.x*scale,y=cy+p.y*scale;
        if(x<12||x>w-12||y<12||y>h-12)continue;
        const name=n.name.length>26?n.name.slice(0,25)+"…":n.name;
        ctx.font="500 "+Math.round(Math.max(10,labelSize-1))+"px system-ui,sans-serif";
        ctx.fillStyle="rgba(236,215,181,.87)";
        ctx.fillText(name,clamp(x+8,6,w-160),clamp(y-7,12,h-8));
      }
    }
    // Evidence appears ONLY while hovering the actual line. The explanation
    // always says what was observed, never infers personal acquaintance.
    if(hoverEdge&&!hovered){
      const raw=graphEdgeExplanation(hoverEdge,scene.nodes);
      const message=raw.length>170?raw.slice(0,169)+"…":raw;
      const maxWidth=Math.max(110,Math.min(360,w-24));
      ctx.font="500 "+Math.round(Math.max(10,labelSize-1))+"px system-ui,sans-serif";
      const words=message.split(/\s+/),lines:string[]=[];
      let current="";
      for(const word of words){
        const joined=current?current+" "+word:word;
        if(ctx.measureText(joined).width>maxWidth-20&&current){
          lines.push(current);current=word;
          if(lines.length===3)break;
        }else current=joined;
      }
      if(current&&lines.length<3)lines.push(current);
      const boxWidth=Math.min(maxWidth,Math.max(110,
        ...lines.map(line=>ctx.measureText(line).width+20)));
      const boxHeight=lines.length*17+12;
      const x=clamp(hoverX+11,4,Math.max(4,w-boxWidth-4));
      const y=clamp(hoverY+11,4,Math.max(4,h-boxHeight-4));
      ctx.fillStyle="rgba(9,11,17,.94)";
      ctx.beginPath();ctx.roundRect(x,y,boxWidth,boxHeight,8);ctx.fill();
      ctx.strokeStyle="rgba(214,174,111,.44)";ctx.lineWidth=.7;ctx.stroke();
      ctx.fillStyle="#f0ddc2";
      for(let i=0;i<lines.length;i++)ctx.fillText(lines[i]!,x+10,y+19+i*17);
    }
    if(analysisBusy){
      const x=w-16,y=16;
      ctx.beginPath();ctx.arc(x,y,5,Math.PI*.15,Math.PI*1.55);
      ctx.lineWidth=1.6;ctx.strokeStyle="rgba(226,177,100,.8)";ctx.stroke();
    }
    canvas.dataset.selected=selected||"";
    canvas.dataset.paintedNodes=String(scene.nodes.length);
  }
  function schedule(){
    if(raf)cancelAnimationFrame(raf);
    const budget=graphMotionBudget(scene.nodes.length,reduced(),document.visibilityState==="visible");
    const step=()=>{
      raf=0;if(!root.isConnected)return;
      const kinetic=physicsFrame<budget?
        graphForceStep(scene.nodes,scene.links,coords,Math.max(.27,1-physicsFrame/budget*.65)):0;
      physicsFrame++;
      // Ease the viewport toward the stable post-physics bounds. This uses
      // real node positions and prevents clipping after the graph grows.
      if(physicsFrame%10===0||kinetic<.04){
        const target=graphBounds(coords.values());
        const rate=kinetic<.04?.18:.07;
        bounds={
          minX:graphLerp(bounds.minX,target.minX,rate),
          maxX:graphLerp(bounds.maxX,target.maxX,rate),
          minY:graphLerp(bounds.minY,target.minY,rate),
          maxY:graphLerp(bounds.maxY,target.maxY,rate)
        };
      }
      draw();
      const now=performance.now();
      const transitions=!reduced()&&([...appearing.values()].some(t=>now-t<360)||
        fading.some(t=>t.until>now));
      if(physicsFrame<budget&&(kinetic>.04||transitions))
        raf=requestAnimationFrame(step);
    };
    raf=requestAnimationFrame(step);
  }
  function repaint(){if(repaintQueued)return;repaintQueued=true;
    requestAnimationFrame(()=>{repaintQueued=false;draw();});}
  // An 8 fps highlight shimmer only while a pointer is actually over the
  // graph. No perpetual idle animation and no extra Canvas/DOM.
  function highlightPulse(){
    clearTimeout(highlightTimer);
    if(!pointerInsideGraph||(!hovered&&!hoverEdge)||reduced()||
      document.visibilityState!=="visible"||!root.isConnected)return;
    highlightTimer=window.setTimeout(()=>{
      repaint();highlightPulse();
    },120);
  }
  canvas.addEventListener("pointerenter",()=>{pointerInsideGraph=true;highlightPulse();});
  // UI is exclusively direct-manipulation. Never create permanent controls.
  canvas.addEventListener("pointerdown",e=>{
    if(e.button!==0)return;
    dismissMenu();
    pointerDown=true;pointMoved=false;
    const hit=pointerHit(e.clientX,e.clientY);
    dragId=hit?.id||null;
    lastX=e.clientX;lastY=e.clientY;
    prevMoveX=e.clientX;prevMoveY=e.clientY;
    originX=panX;originY=panY;
    if(raf)cancelAnimationFrame(raf);
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove",e=>{
    if(!pointerDown){
      const hit=pointerHit(e.clientX,e.clientY);
      const next=hit?.id||null;
      const rect=canvas.getBoundingClientRect();
      hoverX=e.clientX-rect.left;hoverY=e.clientY-rect.top;
      const camera=viewport();
      const line=hit?null:graphEdgeAt(scene,coords,camera,hoverX,hoverY,8);
      if(next!==hovered||line!==hoverEdge){
        hovered=next;hoverEdge=line;
        canvas.style.cursor=next?"pointer":line?"help":"grab";
        repaint();highlightPulse();
      }
      return;
    }
    const dx=e.clientX-lastX,dy=e.clientY-lastY;
    if(Math.hypot(dx,dy)>5)pointMoved=true;
    if(!pointMoved)return;
    if(dragId){
      const p=coords.get(dragId);
      if(p){
        const k=Math.max(.02,viewport().scale);
        p.x=clamp(p.x+(e.clientX-prevMoveX)/k,-920,920);
        p.y=clamp(p.y+(e.clientY-prevMoveY)/k,-920,920);
        p.vx=0;p.vy=0;p.pinned=true;
      }
    }else{
      panX=clamp(originX+dx,-1800,1800);
      panY=clamp(originY+dy,-1800,1800);
    }
    prevMoveX=e.clientX;prevMoveY=e.clientY;
    repaint();
  });
  canvas.addEventListener("pointerup",e=>{
    if(!pointerDown)return;
    const hit=dragId,wasMoved=pointMoved;
    pointerDown=false;dragId=null;pointMoved=false;
    if(wasMoved){persist();return;}
    if(hit){
      const n=scene.nodes.find(n=>n.id===hit);
      if(n){
        if(e.shiftKey&&routeStart&&n.kind==="file")finishRoute(n.id);
        else if(e.altKey&&n.kind==="file")startRoute(n.id);
        else {focus(n);activate(n);}
      }
    }else{
      selected=null;hovered=null;hoverEdge=null;draw();
      if(e.pointerType==="touch"){
        const now=Date.now();
        if(now-lastTap<370)setExpanded(!expanded);
        lastTap=now;
      }
    }
  });
  canvas.addEventListener("pointercancel",()=>{
    pointerDown=false;dragId=null;pointMoved=false;
  });
  canvas.addEventListener("pointerleave",()=>{
    pointerInsideGraph=false;clearTimeout(highlightTimer);
    if(!pointerDown){hovered=null;hoverEdge=null;draw();}
  });
  canvas.addEventListener("dblclick",e=>{
    if(!pointerHit(e.clientX,e.clientY))setExpanded(!expanded);
  });
  canvas.addEventListener("contextmenu",openMenu);
  window.addEventListener("pointerdown",e=>{
    if(menu&&!menu.contains(e.target as Node)&&e.target!==canvas)dismissMenu();
  });
  frame.addEventListener("wheel",e=>{
    e.preventDefault();
    const rect=frame.getBoundingClientRect();
    const x=e.clientX-rect.left,y=e.clientY-rect.top;
    const valid=x>=0&&x<=rect.width&&y>=0&&y<=rect.height;
    changeZoom(e.deltaY>0?.88:1.14,
      valid?x:undefined,valid?y:undefined);
  },{passive:false});
  let pinch=0;
  frame.addEventListener("touchmove",e=>{
    if(e.touches.length!==2){pinch=0;return;}
    const a=e.touches[0]!,b=e.touches[1]!;
    const d=Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY);
    if(pinch>0&&d){
      const rect=frame.getBoundingClientRect();
      changeZoom(d/pinch,(a.clientX+b.clientX)/2-rect.left,
        (a.clientY+b.clientY)/2-rect.top);
    }
    pinch=d;e.preventDefault();
  },{passive:false});
  frame.addEventListener("touchend",()=>{pinch=0;});
  canvas.addEventListener("keydown",e=>{
    if(e.key==="Escape"){
      if(menu)dismissMenu();else if(expanded)setExpanded(false);
      e.preventDefault();return;
    }
    if(e.key==="+"||e.key==="="){changeZoom(1.16);e.preventDefault();}
    else if(e.key==="-"){changeZoom(.86);e.preventDefault();}
    else if(e.key==="0"){zoom=1;panX=0;panY=0;persist();draw();e.preventDefault();}
    else if(e.key==="Enter"&&selected){
      const n=scene.nodes.find(n=>n.id===selected);
      if(n)activate(n);e.preventDefault();
    }else if(e.key===" "){
      setExpanded(!expanded);e.preventDefault();
    }else if(e.key==="Backspace"||e.key==="ArrowUp"&&e.altKey){
      if(current)actions.openFolder(parentOf(current));e.preventDefault();
    }else if(e.key.toLowerCase()==="g"){
      globalGraph=!globalGraph;focusId=null;route=null;routeStart=null;routeEnd=null;
      rebuild();e.preventDefault();
    }else if(e.key.toLowerCase()==="f"){
      focusOnNode(focusId?null:selected);e.preventDefault();
    }else if(e.key.toLowerCase()==="p"){
      if(routeStart&&selected&&selected!==routeStart)finishRoute(selected);
      else startRoute(selected);
      e.preventDefault();
    }else if(e.key.toLowerCase()==="a"){
      void analyzeDocuments();e.preventDefault();
    }else if(e.key.toLowerCase()==="m"){
      mode=mode==="all"?"meaning":mode==="meaning"?"versions":mode==="versions"?"entities":"all";
      rebuild();e.preventDefault();
    }else if(["1","2","3"].includes(e.key)){depth=Number(e.key);rebuild();e.preventDefault();}
    else if(["ArrowRight","ArrowDown","ArrowLeft","ArrowUp"].includes(e.key)){
      const i=scene.nodes.findIndex(n=>n.id===selected);
      const shift=e.key==="ArrowRight"||e.key==="ArrowDown"?1:-1;
      const j=(i+shift+scene.nodes.length)%Math.max(1,scene.nodes.length);
      if(scene.nodes[j])focus(scene.nodes[j]!);
      e.preventDefault();
    }
  });
  document.addEventListener("keydown",e=>{
    if(e.key==="Escape"&&expanded&&root.isConnected)setExpanded(false);
  });
  if(typeof ResizeObserver!=="undefined"){
    const observer=new ResizeObserver(()=>{
      if(!root.isConnected)return;
      const next=measure();
      const key=next.width+"x"+next.height+":"+next.detail;
      if(key!==lastScreenKey)rebuild();
      else repaint();
    });
    observer.observe(frame);
  }
  return {root,highlightFile,update(newFiles,newFolders,folder){
    if(files!==newFiles){
      analysisGeneration++;semantic=null;analysisBusy=false;
    }
    files=newFiles;folders=newFolders;
    if(folder!==current){
      current=folder;
      if(!globalGraph){selected=null;panX=0;panY=0;focusId=null;}
      hovered=null;hoverEdge=null;
      clearTimeout(highlightTimer);
    }
    rebuild();
  }};
}
