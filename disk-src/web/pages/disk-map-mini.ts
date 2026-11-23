/**
 * Tsukimera Disk 13.0 — Obsidian-style connected graph, original HTML5 Canvas.
 * Replaces the former card/orbit scene completely. No Obsidian source code,
 * new packages, cloud inference, background process or filesystem mutation.
 */
import {el} from "../dom";
import {human} from "./disk-model";
import {api} from "../api";
import {extractDocument,semanticFromRecords,type SemanticIndex,type SemanticRecord} from "./disk-map-semantic";
import {graphFromCatalog,graphInitial,graphForceStep,type GraphNode,type GraphLink,
  type GraphScene,type GraphPoint,type LinkKind} from "./disk-map-graph";
import {normalizeMiniView,MINI_VIEW_KEY,clampView} from "./disk-map-mini-model";
import {SPATIAL_DENSITY_KEY,spatialFileType} from "./disk-map-spatial";
import {writePreference} from "../preferences";
import type {DiskFile} from "../api";

type Actions={openFolder:(folder:string)=>void;openFile:(id:string)=>void};
export interface MiniDiskMap{
  root:HTMLElement;update:(files:DiskFile[],folders:string[],current:string)=>void;
  highlightFile:(id:string|null)=>void;
}
const rgb={folder:"#dbad62",file:"#bbc6d9",tag:"#af8ce2",duplicate:"#dc9872"};
const label=(p:string)=>p?p.split("/").pop()||p:"Мой Диск";
const parentOf=(p:string)=>p.includes("/")?p.slice(0,p.lastIndexOf("/")):"";
const reduced=()=>window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const small=(n:number)=>Number.isFinite(n)?Math.round(n):0;
const button=(content:string,name:string,fn:()=>void,cls="dk-graph-btn")=>{
  const b=el("button",{type:"button",cls,title:name,attrs:{"aria-label":name},textContent:content});
  b.addEventListener("click",fn);return b;
};

export function createMiniDiskMap(actions:Actions):MiniDiskMap{
  const storage=normalizeMiniView((()=>{try{return JSON.parse(localStorage.getItem(MINI_VIEW_KEY)||"null");}catch{return null;}})());
  let zoomLevel=clampView(storage.zoom,.7,3.2),panX=storage.panX,panY=storage.panY;
  const canvas=el("canvas",{cls:"dk-mini-map-canvas dk-graph-canvas",attrs:{
    tabindex:"0",role:"application",
    "aria-label":"Граф файлов как Obsidian: точки и реальные связи. Нажмите точку для открытия. Колесо — масштаб; перемещение — сдвиг или закрепление точки. Стрелки — выбор, Enter — открыть, Esc — закрыть расширенный граф."}});
  const frame=el("div",{cls:"dk-mini-map-frame dk-omni-stage dk-graph-stage"},canvas);
  const search=el("input",{type:"search",cls:"dk-omni-search dk-graph-search",placeholder:"Поиск узла…",attrs:{"aria-label":"Найти объект на графе"}});
  const total=el("small",{cls:"dk-mini-map-count dk-graph-count"});
  const status=el("div",{cls:"dk-mini-map-status dk-omni-status dk-graph-status",textContent:"Связи папок и документов",attrs:{role:"status","aria-live":"polite"}});
  const breadcrumb=el("nav",{cls:"dk-omni-trail dk-graph-trail",attrs:{"aria-label":"Текущая папка карты"}});
  const list=el("div",{cls:"dk-omni-list dk-graph-list",attrs:{role:"group","aria-label":"Доступный список узлов"}});
  const listPanel=el("details",{cls:"dk-graph-list-panel"},el("summary",{textContent:"Список узлов"}),list);
  const mode=el("select",{cls:"dk-graph-mode",attrs:{"aria-label":"Тип связей"}},
    el("option",{value:"all",textContent:"Все связи"}),
    el("option",{value:"meaning",textContent:"Содержание"}),
    el("option",{value:"versions",textContent:"Дубликаты и редакции"}),
    el("option",{value:"entities",textContent:"Люди · компании · проекты"}));
  const analyze=button("Изучить","Прочитать доступные тексты документов для графа",()=>{void analyzeDocuments();},"dk-graph-analyze dk-graph-btn");
  const inspect=el("aside",{cls:"dk-graph-inspect",attrs:{"aria-label":"Сведения об узле и основания связей","aria-live":"polite"}},
    el("strong",{textContent:"Выберите точку графа"}),
    el("small",{textContent:"Здесь появятся свойства и объяснения реальных связей"}));
  const depthLabel=el("span",{cls:"dk-graph-depth-label",textContent:"2 уровня"});
  const depthBtn=button("2","Глубина графа: изменить количество уровней",()=>{
    depth=depth===3?1:depth+1;
    depthLabel.textContent=depth+" ур.";
    rebuild();
  });
  const tagBtn=button("#","Показать или скрыть связи по меткам",()=>{
    tagsEnabled=!tagsEnabled;tagBtn.setAttribute("aria-pressed",String(tagsEnabled));rebuild();
  });
  tagBtn.setAttribute("aria-pressed","true");
  const dupBtn=button("≡","Показать или скрыть дубликаты SHA-256",()=>{
    duplicatesEnabled=!duplicatesEnabled;dupBtn.setAttribute("aria-pressed",String(duplicatesEnabled));rebuild();
  });
  dupBtn.setAttribute("aria-pressed","true");
  const zoomOut=button("−","Уменьшить граф",()=>changeZoom(.84));
  const zoomIn=button("+","Увеличить граф",()=>changeZoom(1.18));
  const reset=button("⌖","Центрировать граф",()=>{panX=0;panY=0;zoomLevel=1;saveViewport();draw();},"dk-mini-map-reset dk-graph-btn");
  const expand=button("⤢","Развернуть граф связей",()=>setExpanded(!expanded),"dk-graph-expand dk-graph-btn");
  const close=button("×","Закрыть большой граф",()=>setExpanded(false),"dk-graph-close dk-graph-btn");
  const up=button("↑","На уровень выше",()=>{if(current)actions.openFolder(parentOf(current));});
  const root=el("section",{cls:"dk-mini-map dk-omni-explorer dk-graph-view",attrs:{"aria-label":"Живая карта связей файлов"}},
    el("header",{cls:"dk-graph-head"},
      el("div",{cls:"dk-graph-title"},el("strong",{textContent:"Граф связей"}),total),
      el("div",{cls:"dk-graph-actions"},up,expand,close)),
    el("div",{cls:"dk-graph-utility"},
      breadcrumb,
      el("div",{cls:"dk-graph-search-wrap"},search)),
    el("div",{cls:"dk-graph-controls"},mode,analyze,depthBtn,depthLabel,tagBtn,dupBtn,
      el("span",{cls:"dk-graph-zoom"},zoomOut,zoomIn,reset)),
    frame,inspect,
    el("footer",{cls:"dk-graph-footer"},status,
      el("div",{cls:"dk-graph-legend"},
        el("span",{textContent:"● Папки",cls:"dk-graph-legend-folder"}),
        el("span",{textContent:"● Файлы",cls:"dk-graph-legend-file"}),
        el("span",{textContent:"● Метки",cls:"dk-graph-legend-tag"}))),
    listPanel);
  let files:DiskFile[]=[],folders:string[]=[],current="",depth=2;
  let tagsEnabled=true,duplicatesEnabled=true;
  let semantic:SemanticIndex|null=null,analyzeToken=0;
  let graphMode:"all"|"meaning"|"versions"|"entities"="all";
  mode.addEventListener("change",()=>{
    graphMode=mode.value as typeof graphMode;
    rebuild();
  });
  let scene:GraphScene=graphFromCatalog([],[],"");
  let coords=new Map<string,GraphPoint>();
  let frameNumber=0,raf=0,resizeObserver:ResizeObserver|null=null;
  let hovered:string|null=null,selected:string|null=null,query="";
  let expanded=false,originalParent:Node|null=null,originalNext:Node|null=null;
  let saveTimer=0,dragTarget:string|null=null,dragStarted=false,moveTarget=false;
  let startX=0,startY=0,startPanX=0,startPanY=0;
  let homePage:HTMLElement|null=null;
  let lastFocusFolder="";
  let tooltip=el("div",{cls:"dk-graph-tooltip",hidden:true});
  frame.append(tooltip);
  function saveViewport(){
    clearTimeout(saveTimer);
    saveTimer=window.setTimeout(()=>writePreference(MINI_VIEW_KEY,JSON.stringify({
      zoom:zoomLevel,panX,panY,focus:""
    })),280);
  }
  function setExpanded(value:boolean){
    if(value===expanded)return;
    expanded=value;
    if(value){
      originalParent=root.parentNode;originalNext=root.nextSibling;
      homePage=root.closest<HTMLElement>(".disk-page");
      document.body.append(root);
      root.classList.add("dk-graph-expanded");
      expand.textContent="⤡";expand.setAttribute("aria-label","Свернуть граф связей");
      canvas.focus({preventScroll:true});
    }else{
      root.classList.remove("dk-graph-expanded");
      expand.textContent="⤢";expand.setAttribute("aria-label","Развернуть граф связей");
      if(originalParent){
        if(originalNext&&originalNext.parentNode===originalParent)
          originalParent.insertBefore(root,originalNext);
        else originalParent.appendChild(root);
      }
      canvas.focus({preventScroll:true});
    }
    requestAnimationFrame(()=>{rebuild();});
  }
  function changeZoom(factor:number){
    zoomLevel=clampView(zoomLevel*factor,.7,3.2);
    saveViewport();draw();
  }
  function navigate(node:GraphNode){
    if(node.kind==="folder")actions.openFolder(node.folder);
    else if(node.kind==="file"&&node.fileId)actions.openFile(node.fileId);
    else if(node.kind==="tag"||node.kind==="topic"||node.kind==="person"||
      node.kind==="organization"||node.kind==="date"||node.kind==="project"){
      query=node.name.slice(1);search.value=query;updateSearch();
    }
  }
  function moveTo(node:GraphNode){
    selected=node.id;hovered=node.id;
    status.textContent=node.name+(node.kind==="file"?" · "+human(node.size):"");
    highlightFileCards(node);
    renderInspector(node);
    draw();
  }
  function highlightFileCards(node:GraphNode|null){
    const page=homePage||root.closest<HTMLElement>(".disk-page");
    if(!page)return;
    for(const e of page.querySelectorAll<HTMLElement>(".dk-file.dk-map-linked"))
      e.classList.remove("dk-map-linked");
    if(node?.fileId)
      for(const e of page.querySelectorAll<HTMLElement>(".dk-file[data-file-id]"))
        if(e.dataset.fileId===node.fileId)e.classList.add("dk-map-linked");
  }
  function highlightFile(id:string|null){
    const node=scene.nodes.find(n=>n.fileId===id);
    if(id&&!node)return;
    selected=node?.id||null;
    hovered=selected;highlightFileCards(node||null);renderInspector(node||null);draw();
  }
  function rebuild(){
    const limit=expanded?(localStorage.getItem(SPATIAL_DENSITY_KEY)==="detailed"?200:150):
      (localStorage.getItem(SPATIAL_DENSITY_KEY)==="detailed"?80:54);
    scene=graphFromCatalog(files,folders,current,{depth,limit,
      includeTags:tagsEnabled,includeDuplicates:duplicatesEnabled,
      semantic,viewMode:graphMode});
    const updated=new Map<string,GraphPoint>();
    for(const n of scene.nodes)updated.set(n.id,coords.get(n.id)||graphInitial(n));
    coords=updated;
    frameNumber=0;
    total.textContent=scene.nodes.length+" узлов · "+scene.links.length+" связей"+
      (scene.hidden?" · +"+scene.hidden:"");
    canvas.dataset.layer="graph";
    canvas.dataset.nodes=String(scene.nodes.length);
    canvas.dataset.links=String(scene.links.length);
    canvas.dataset.focus=current;
    drawBreadcrumb();
    renderAccessibleList();
    renderInspector(scene.nodes.find(n=>n.id===selected)||null);
    schedule();
  }

  /** Read a small visible sample only after an explicit click, using the
   * existing local text endpoint and no persistent cache or cloud LLM.
   * Stale results are discarded if the user changes folders or the catalog.
   */
  async function analyzeDocuments(){
    const generation=++analyzeToken;
    const eligible=scene.nodes.filter(n=>n.kind==="file"&&n.fileId)
      .slice(0,24);
    const catalog=new Map(files.map(f=>[f.id,f]));
    const names=eligible.map(n=>n.name);
    const records:SemanticRecord[]=[];
    let unreadable=0,truncated=0;
    analyze.disabled=true;
    for(const [i,n] of eligible.entries()){
      if(generation!==analyzeToken)break;
      const file=n.fileId&&catalog.get(n.fileId);
      if(!file||file.deletedAt)continue;
      status.textContent="Анализ текста "+(i+1)+" / "+eligible.length;
      const answer=await api.diskText(file.id);
      if(generation!==analyzeToken)break;
      if(!answer.ok||!answer.value.text?.trim()){
        unreadable++;continue;
      }
      if(answer.value.truncated)truncated++;
      records.push(extractDocument(file,answer.value.text,names));
    }
    if(generation!==analyzeToken){analyze.disabled=false;return;}
    semantic=semanticFromRecords(records);
    semantic.unreadable=unreadable;
    semantic.truncated=truncated;
    analyze.disabled=false;
    status.textContent="Изучено "+semantic.processed+" документов · "+
      semantic.links.length+" текстовых связей"+
      (unreadable?" · недоступно "+unreadable:"")+
      (truncated?" · усечено "+truncated:"");
    rebuild();
  }
  function renderInspector(node:GraphNode|null){
    inspect.replaceChildren();
    if(!node){
      inspect.append(el("strong",{textContent:"Выберите точку графа"}),
        el("small",{textContent:"Покажу основание каждой связи. Для анализа содержимого нажмите «Изучить»."}));
      return;
    }
    const kind=node.kind==="folder"?"Папка":node.kind==="file"?"Документ":
      node.kind==="revision"?"Текущая редакция":"Связанный объект";
    inspect.append(el("strong",{textContent:node.name}),
      el("small",{textContent:kind+(node.kind==="file"?" · "+human(node.size):"")}));
    const record=node.fileId&&semantic?.records[node.fileId];
    if(record){
      if(record.preview)inspect.append(el("p",{cls:"dk-graph-summary",textContent:record.preview}));
      if(record.keywords.length)inspect.append(el("small",{
        textContent:"Ключевые слова: "+record.keywords.slice(0,7).join(", ")}));
    }
    const links=scene.links.filter(e=>e.source===node.id||e.target===node.id);
    if(!links.length)inspect.append(el("small",{textContent:"Связи не обнаружены в выбранном режиме"}));
    for(const edge of links.slice(0,12)){
      const other=scene.nodes.find(n=>n.id===(edge.source===node.id?edge.target:edge.source));
      if(!other)continue;
      const proof=edge.evidence||(edge.kind==="contains"?"Подтверждённая вложенность":
        edge.kind==="duplicate"?"Совпадает SHA-256":edge.kind==="tag"?"Метка из каталога":
        edge.kind==="revision"?"Номер редакции из каталога":"Подтверждённая связь");
      inspect.append(el("div",{cls:"dk-graph-inspect-link"},
        el("span",{textContent:other.name}),
        el("small",{textContent:proof})));
    }
  }
  function drawBreadcrumb(){
    breadcrumb.replaceChildren();
    breadcrumb.append(button("⌂","Корень Диска",()=>actions.openFolder(""),"dk-graph-crumb"));
    const parts=current?current.split("/"):[];
    for(let i=0;i<parts.length;i++){
      const p=parts.slice(0,i+1).join("/");
      breadcrumb.append(el("span",{textContent:"/"}));
      breadcrumb.append(button(parts[i]!,"Перейти к "+p,()=>actions.openFolder(p),"dk-graph-crumb"));
    }
  }
  function renderAccessibleList(){
    list.replaceChildren();
    for(const n of scene.nodes){
      const b=button((n.kind==="folder"?"▸ ":n.kind==="tag"?"# ":"• ")+n.name,
        "Открыть "+n.name,()=>navigate(n),"dk-omni-row dk-graph-row");
      b.dataset.nodeId=n.id;
      b.addEventListener("focus",()=>moveTo(n));
      b.addEventListener("pointerenter",()=>moveTo(n));
      list.append(b);
    }
  }
  function updateSearch(){
    query=search.value.trim().toLocaleLowerCase("ru");
    const matching=scene.nodes.filter(n=>n.name.toLocaleLowerCase("ru").includes(query));
    if(query&&matching.length){
      moveTo(matching[0]!);
      status.textContent="Найдено "+matching.length+": "+matching[0]!.name;
    }else if(query)status.textContent="Совпадений нет";
    else status.textContent=scene.nodes.length+" реальных узлов";
    draw();
  }
  search.addEventListener("input",updateSearch);
  function projection(){
    const bounds=frame.getBoundingClientRect(),w=Math.max(1,bounds.width),h=Math.max(1,bounds.height);
    const fit=Math.min(w/(expanded?1150:650),h/(expanded?850:700));
    const scale=fit*zoomLevel;
    return {w,h,scale,cx:w/2+panX,cy:h/2+panY};
  }
  function nodeAt(clientX:number,clientY:number):GraphNode|null{
    const rect=canvas.getBoundingClientRect(),x=clientX-rect.left,y=clientY-rect.top;
    const {cx,cy,scale}=projection();
    let best:GraphNode|null=null,bd=Infinity;
    for(const node of scene.nodes){
      const p=coords.get(node.id);if(!p)continue;
      const d=Math.hypot(x-(cx+p.x*scale),y-(cy+p.y*scale));
      if(d<Math.max(10,(node.kind==="folder"?6:4)*Math.max(1,scale)+5)&&d<bd){best=node;bd=d;}
    }
    return best;
  }
  function color(node:GraphNode):string{
    return node.kind==="folder"?rgb.folder:node.kind==="tag"?rgb.tag:rgb.file;
  }
  function draw(){
    if(!root.isConnected)return;
    const {w,h,cx,cy,scale}=projection();
    const dpr=Math.min(2,window.devicePixelRatio||1);
    const pw=Math.round(w*dpr),ph=Math.round(h*dpr);
    if(canvas.width!==pw||canvas.height!==ph){canvas.width=pw;canvas.height=ph;}
    const ctx=canvas.getContext("2d");if(!ctx)return;
    ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
    ctx.fillStyle="#08090e";ctx.fillRect(0,0,w,h);
    const active=hovered||selected;
    const neighborhood=new Set<string>(active?[active]:[]);
    if(active)for(const e of scene.links){
      if(e.source===active)neighborhood.add(e.target);
      if(e.target===active)neighborhood.add(e.source);
    }
    const searchMatches=new Set(query?scene.nodes.filter(n=>n.name.toLocaleLowerCase("ru").includes(query)).map(n=>n.id):[]);
    for(const edge of scene.links){
      const a=coords.get(edge.source),b=coords.get(edge.target);if(!a||!b)continue;
      const isActive=!!active&&(edge.source===active||edge.target===active);
      const dim=!!active&&!isActive||!!query&&!searchMatches.has(edge.source)&&!searchMatches.has(edge.target);
      ctx.beginPath();ctx.moveTo(cx+a.x*scale,cy+a.y*scale);ctx.lineTo(cx+b.x*scale,cy+b.y*scale);
      ctx.strokeStyle=dim?"rgba(141,151,166,.065)":
        isActive?(edge.kind==="duplicate"?"rgba(232,151,100,.92)":"rgba(230,185,112,.74)"):
        edge.kind==="duplicate"?"rgba(216,142,94,.43)":
        edge.kind==="tag"?"rgba(164,139,200,.32)":"rgba(164,171,190,.22)";
      ctx.lineWidth=isActive?1.7:edge.kind==="contains"?.8:1;
      ctx.stroke();
    }
    const drawLabels=new Set<string>();
    if(active)for(const id of neighborhood)drawLabels.add(id);
    else if(expanded){
      for(const node of scene.nodes)if(node.kind==="folder"&&node.depth<=1)drawLabels.add(node.id);
    }else drawLabels.add(scene.focus);
    if(query)for(const id of searchMatches)drawLabels.add(id);
    for(const node of scene.nodes){
      const p=coords.get(node.id);if(!p)continue;
      const x=cx+p.x*scale,y=cy+p.y*scale;
      if(x<-32||x>w+32||y<-32||y>h+32)continue;
      const chosen=node.id===active,match=searchMatches.has(node.id);
      const faded=active&&!neighborhood.has(node.id)||query&&!match;
      const size=node.id===scene.focus?6.5:node.kind==="folder"?5.2:node.kind==="tag"?4.1:3.1;
      const radius=Math.max(2.2,Math.min(12,size*Math.sqrt(Math.max(.55,scale))));
      ctx.globalAlpha=faded?.17:1;
      if(chosen||match){
        ctx.beginPath();ctx.arc(x,y,radius+7,0,Math.PI*2);
        ctx.fillStyle="rgba(228,180,103,.10)";ctx.fill();
        ctx.beginPath();ctx.arc(x,y,radius+3,0,Math.PI*2);
        ctx.strokeStyle="rgba(244,200,133,.75)";ctx.lineWidth=1;ctx.stroke();
      }
      ctx.beginPath();ctx.arc(x,y,radius,0,Math.PI*2);
      ctx.fillStyle=color(node);ctx.fill();
      ctx.globalAlpha=1;
      if(drawLabels.has(node.id)&&(!faded||chosen)){
        const text=node.name.length>28?node.name.slice(0,27)+"…":node.name;
        ctx.font=(chosen?"600 ":"400 ")+(expanded?12:10)+"px system-ui,sans-serif";
        const len=ctx.measureText(text).width;
        const tx=Math.min(w-len-7,Math.max(5,x+radius+4));
        const ty=Math.max(14,Math.min(h-6,y-5));
        ctx.fillStyle=chosen?"#f8dbac":"#bfc5d0";
        ctx.fillText(text,tx,ty);
      }
    }
    canvas.dataset.selected=selected||"";
    canvas.dataset.paintedNodes=String(scene.nodes.length);
    tooltip.hidden=!hovered;
    if(hovered){
      const n=scene.nodes.find(n=>n.id===hovered);
      if(n){
        tooltip.textContent=n.name+" · "+(n.kind==="file"?human(n.size):n.kind==="tag"?"метка":"папка");
      }
    }
  }
  function schedule(){
    if(raf)cancelAnimationFrame(raf);
    const budget=reduced()?1:Math.min(120,scene.nodes.length>140?50:100);
    const step=()=>{
      raf=0;if(!root.isConnected)return;
      if(frameNumber<budget){
        const energy=graphForceStep(scene.nodes,scene.links,coords,Math.max(.28,1-frameNumber/budget*.65));
        frameNumber++;draw();
        if(energy>.035&&frameNumber<budget){raf=requestAnimationFrame(step);return;}
      }
      draw();
    };
    raf=requestAnimationFrame(step);
  }
  // Mouse and touch: drag nodes without dragging files or mutating their position on disk.
  canvas.addEventListener("pointerdown",event=>{
    if(event.button!==0)return;
    const hit=nodeAt(event.clientX,event.clientY);
    dragTarget=hit?.id||null;dragStarted=true;moveTarget=false;
    startX=event.clientX;startY=event.clientY;startPanX=panX;startPanY=panY;
    if(raf)cancelAnimationFrame(raf);
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove",event=>{
    const hit=nodeAt(event.clientX,event.clientY);
    if(!dragStarted){
      const next=hit?.id||null;
      if(hovered!==next){hovered=next;status.textContent=hit?.name||"Связи файлов и папок";draw();}
      return;
    }
    const dx=event.clientX-startX,dy=event.clientY-startY;
    if(Math.hypot(dx,dy)>4)moveTarget=true;
    if(!moveTarget)return;
    if(dragTarget){
      const p=coords.get(dragTarget);
      if(p){
        const k=Math.max(.02,projection().scale);
        p.x+=event.movementX/k;p.y+=event.movementY/k;p.vx=0;p.vy=0;p.pinned=true;
      }
    }else{
      panX=Math.max(-1800,Math.min(1800,startPanX+dx));
      panY=Math.max(-1800,Math.min(1800,startPanY+dy));
    }
    draw();
  });
  canvas.addEventListener("pointerup",event=>{
    if(!dragStarted)return;
    const target=dragTarget;const moved=moveTarget;
    dragStarted=false;moveTarget=false;dragTarget=null;
    if(moved){saveViewport();return;}
    const node=target?scene.nodes.find(n=>n.id===target):undefined;
    if(node){moveTo(node);navigate(node);}
    else {selected=null;hovered=null;draw();}
  });
  canvas.addEventListener("pointercancel",()=>{dragStarted=false;dragTarget=null;moveTarget=false;});
  canvas.addEventListener("pointerleave",()=>{if(!dragStarted){hovered=null;draw();}});
  frame.addEventListener("wheel",e=>{e.preventDefault();changeZoom(e.deltaY>0?.89:1.12);},{passive:false});
  let pinch=0;
  frame.addEventListener("touchmove",e=>{
    if(e.touches.length!==2){pinch=0;return;}
    const a=e.touches[0]!,b=e.touches[1]!;
    const distance=Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY);
    if(pinch>0&&distance)changeZoom(distance/pinch);
    pinch=distance;e.preventDefault();
  },{passive:false});
  frame.addEventListener("touchend",()=>{pinch=0;});
  canvas.addEventListener("keydown",event=>{
    if(event.key==="Escape"&&expanded){setExpanded(false);event.preventDefault();}
    else if(event.key==="+"||event.key==="="){changeZoom(1.16);event.preventDefault();}
    else if(event.key==="-"){changeZoom(.86);event.preventDefault();}
    else if(event.key==="0"){panX=0;panY=0;zoomLevel=1;draw();event.preventDefault();}
    else if(event.key==="Backspace"){if(current)actions.openFolder(parentOf(current));event.preventDefault();}
    else if(event.key==="Enter"&&selected){
      const n=scene.nodes.find(n=>n.id===selected);if(n)navigate(n);event.preventDefault();
    }else if(["ArrowRight","ArrowDown","ArrowLeft","ArrowUp"].includes(event.key)){
      const here=scene.nodes.findIndex(n=>n.id===selected);
      const next=(here+(event.key==="ArrowRight"||event.key==="ArrowDown"?1:-1)+scene.nodes.length)%Math.max(1,scene.nodes.length);
      if(scene.nodes[next])moveTo(scene.nodes[next]!);event.preventDefault();
    }
  });
  document.addEventListener("keydown",event=>{
    if(event.key==="Escape"&&expanded&&root.isConnected){setExpanded(false);}
  });
  // A single ResizeObserver is shared by the compact and expanded form.
  if(typeof ResizeObserver!=="undefined"){
    resizeObserver=new ResizeObserver(()=>{if(root.isConnected)draw();});
    resizeObserver.observe(frame);
  }
  return {root,highlightFile,update(newFiles,newFolders,folder){
    // Invalidate the in-memory text analysis on any catalogue refresh; no
    // stale evidence can survive file revisions, renames or deletions.
    if(files!==newFiles){semantic=null;analyzeToken++;}
    files=newFiles;folders=newFolders;
    if(folder!==current){
      current=folder;hovered=null;selected=null;panX=0;panY=0;
      lastFocusFolder=folder;
    }
    rebuild();
  }};
}
