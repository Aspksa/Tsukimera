/**
 * Tsukimera Disk 11 — folder-centered spatial map inspired by OmniBrille's
 * public UX concepts. Original TypeScript/Canvas implementation; no .NET,
 * native binaries, added dependencies, new services or additional cloud calls.
 *
 * Center = current folder; immediate children are visible and legible.
 * Overflow is reversible paging, and the accessible side list is in sync.
 */
import {el,icon} from "../dom";
import {human} from "./disk-model";
import {spatialScene,spatialSlots,type SpatialItem,type SpatialScene} from "./disk-map-spatial";
import {normalizeMiniView,MINI_VIEW_KEY,clampView} from "./disk-map-mini-model";
import {writePreference} from "../preferences";
import type {DiskFile} from "../api";

type MapActions={openFolder:(folder:string)=>void;openFile:(id:string)=>void};
export interface MiniDiskMap{
  root:HTMLElement;
  update:(files:DiskFile[],folders:string[],current:string)=>void;
}
const reduced=()=>window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const btn=(name:string,label:string,click:()=>void)=>{
  const b=el("button",{type:"button",cls:"dk-omni-tool",title:label,attrs:{"aria-label":label}},el("span",{attrs:{"aria-hidden":"true"},textContent:name}));
  b.addEventListener("click",click);
  return b;
};
const shortName=(folder:string)=>folder?folder.split("/").pop()||folder:"Мой Диск";

export function createMiniDiskMap(actions:MapActions):MiniDiskMap{
  const persisted=normalizeMiniView((()=>{try{return JSON.parse(localStorage.getItem(MINI_VIEW_KEY)||"null");}catch{return null;}})());
  const view={...persisted,zoom:clampView(persisted.zoom,.75,1.65)};
  const count=el("small",{cls:"dk-mini-map-count",textContent:"0 файлов · 0 папок"});
  const canvas=el("canvas",{cls:"dk-mini-map-canvas",attrs:{
    tabindex:"0",role:"application",
    "aria-label":"Пространственная карта файлов. Стрелки — выбор, Enter — открыть, плюс и минус — масштаб, Backspace — назад."}});
  const nodes=el("div",{cls:"dk-omni-nodes",attrs:{"aria-label":"Объекты текущей папки"}});
  const frame=el("div",{cls:"dk-mini-map-frame dk-omni-stage"},canvas,nodes);
  const list=el("div",{cls:"dk-omni-list",attrs:{role:"group","aria-label":"Список элементов текущей папки"}});
  const path=el("nav",{cls:"dk-omni-trail",attrs:{"aria-label":"Путь папки"}});
  const search=el("input",{cls:"dk-omni-search",type:"search",placeholder:"Найти в папке…",
    attrs:{"aria-label":"Поиск файлов и папок в текущем каталоге"}});
  const status=el("div",{cls:"dk-mini-map-status dk-omni-status",attrs:{role:"status","aria-live":"polite"},textContent:"Выберите папку или файл"});
  const pageText=el("small",{cls:"dk-omni-page-label"});
  const zoomText=el("span",{cls:"dk-omni-zoom-label",textContent:"100%"});
  const back=btn("←","Назад",()=>stepBack());
  const up=btn("↑","На уровень выше",()=>navigate(parentOf(current)));
  const home=btn("⌂","В корень Диска",()=>navigate(""));
  const minus=btn("−","Уменьшить карту",()=>zoom(.88));
  const plus=btn("+","Увеличить карту",()=>zoom(1.12));
  const reset=el("button",{type:"button",cls:"dk-mini-map-reset dk-omni-tool",
    textContent:"Центр",attrs:{"aria-label":"Сбросить масштаб и положение карты"}});
  const prev=btn("‹","Предыдущая группа файлов",()=>changePage(-1));
  const next=btn("›","Следующая группа файлов",()=>changePage(1));
  const root=el("section",{cls:"dk-mini-map dk-omni-explorer",attrs:{"aria-label":"Живая карта Диска — пространственный проводник"}},
    el("header",{cls:"dk-omni-head"},
      el("div",{cls:"dk-omni-titles"},el("strong",{textContent:"Живая карта Диска"}),count),
      el("div",{cls:"dk-omni-nav"},back,up,home)),
    el("div",{cls:"dk-omni-utility"},path,
      el("div",{cls:"dk-omni-search-wrap"},icon("search",16),search)),
    el("div",{cls:"dk-omni-workspace"},
      frame,
      el("aside",{cls:"dk-omni-panel",attrs:{"aria-label":"Синхронизированный список файлов"}},
        el("div",{cls:"dk-omni-list-head"},el("strong",{textContent:"Содержимое папки"}),el("small",{textContent:"Один клик — открыть"})),
        list,
        el("div",{cls:"dk-omni-pager"},prev,pageText,next))),
    el("footer",{cls:"dk-omni-foot"},status,
      el("div",{cls:"dk-omni-zoom"},minus,zoomText,plus,reset)));
  let files:DiskFile[]=[],folders:string[]=[],current="",filter="",page=0;
  let scene:SpatialScene=spatialScene([],[],"");
  let history:string[]=[];
  let selected=-1;
  let pendingNav:string|null=null;
  let renderLimit=0;
  let mounted=false,queued=false,raf=0,saveTimer=0;
  let dragging=false,startX=0,startY=0,startPanX=0,startPanY=0,moved=false;
  const parentOf=(p:string)=>p.includes("/")?p.slice(0,p.lastIndexOf("/")):"";
  const save=()=>{
    clearTimeout(saveTimer);
    saveTimer=window.setTimeout(()=>writePreference(MINI_VIEW_KEY,JSON.stringify(view)),260);
  };
  function navigate(folder:string,record=true){
    if(folder===current)return;
    if(record)history.push(current);
    history=history.slice(-32);
    pendingNav=folder;
    actions.openFolder(folder);
  }
  function stepBack(){
    const dest=history.pop();
    if(dest!==undefined)navigate(dest,false);
  }
  function changePage(d:number){
    page=Math.max(0,Math.min(scene.pages-1,page+d));
    selected=-1;render();
  }
  function zoom(factor:number){
    view.zoom=clampView(view.zoom*factor,.75,1.65);
    save();schedulePaint();
  }
  function resetView(){
    view.zoom=1;view.panX=0;view.panY=0;view.focus="";
    save();schedulePaint();
  }
  reset.addEventListener("click",resetView);
  function selectItem(item:SpatialItem,index:number){
    selected=index;
    status.textContent=(item.kind==="folder"?"Папка · ":"Файл · ")+item.name+" · "+human(item.size);
    highlight();
  }
  function activate(item:SpatialItem){
    if(item.kind==="folder")navigate(item.folder);
    else actions.openFile(item.id.slice(5));
  }
  function highlight(){
    for(const element of nodes.querySelectorAll<HTMLElement>("[data-index]"))
      element.classList.toggle("is-selected",Number(element.dataset.index)===selected);
    for(const element of list.querySelectorAll<HTMLElement>("[data-index]"))
      element.classList.toggle("is-selected",Number(element.dataset.index)===selected);
    schedulePaint();
  }
  function makeItem(item:SpatialItem,index:number,graphic:boolean):HTMLButtonElement{
    const name=el("span",{cls:"dk-omni-item-name",textContent:item.name,title:item.name});
    const meta=el("small",{cls:"dk-omni-item-meta",textContent:item.kind==="folder"?
      item.count+" файлов":human(item.size)});
    const b=el("button",{type:"button",cls:(graphic?"dk-omni-node":"dk-omni-row")+
      " kind-"+item.kind,attrs:{"data-index":String(index),"data-id":item.id,
      "aria-label":(item.kind==="folder"?"Открыть папку ":"Открыть файл ")+item.name}},
      el("span",{cls:"dk-omni-glyph",attrs:{"aria-hidden":"true"}},icon(item.kind==="folder"?"folder":"file",graphic?19:17)),
      el("span",{cls:"dk-omni-item-copy"},name,meta));
    b.title=item.name;
    b.addEventListener("focus",()=>selectItem(item,index));
    b.addEventListener("pointerenter",()=>{if(!dragging)selectItem(item,index);});
    b.addEventListener("click",()=>activate(item));
    return b;
  }
  function renderTrail(){
    path.replaceChildren();
    const parts=current?current.split("/"):[];
    const paths=["",...parts.map((_,i)=>parts.slice(0,i+1).join("/"))];
    const crumbs=paths.slice(-5);
    for(let i=0;i<crumbs.length;i++){
      const folder=crumbs[i]!;
      if(i)path.append(el("span",{cls:"dk-omni-slash",textContent:"/"}));
      const crumb=el("button",{type:"button",cls:"dk-omni-crumb"+
        (folder===current?" is-current":""),textContent:shortName(folder),title:folder||"Мой Диск"});
      if(folder===current)crumb.setAttribute("aria-current","page");
      crumb.addEventListener("click",()=>navigate(folder));
      path.append(crumb);
    }
  }
  function render(){
    const limit=frame.clientWidth<480?6:frame.clientWidth<760?8:12;
    renderLimit=limit;
    scene=spatialScene(files,folders,current,page,limit,filter);
    page=scene.page;
    selected=-1;
    count.textContent=scene.folders+" папок · "+scene.files+" файлов · "+human(scene.bytes);
    back.disabled=history.length===0;
    up.disabled=!current;
    home.disabled=!current;
    prev.disabled=page===0;next.disabled=page>=scene.pages-1;
    pageText.textContent=scene.total?("Группа "+(page+1)+" из "+scene.pages):"Пустая папка";
    status.textContent=filter?
      "Найдено "+scene.total+" в текущей папке":
      (current||"Мой Диск")+" · "+scene.total+" элементов";
    renderTrail();
    nodes.replaceChildren();
    list.replaceChildren();
    if(!scene.items.length){
      nodes.append(el("div",{cls:"dk-omni-empty",textContent:filter?
        "Ничего не найдено":"Здесь пока нет файлов и папок"}));
      list.append(el("p",{cls:"dk-omni-list-empty",textContent:filter?"Нет совпадений":"Папка пустая"}));
    }else{
      scene.items.forEach((item,i)=>{
        nodes.append(makeItem(item,i,true));
        list.append(makeItem(item,i,false));
      });
    }
    schedulePaint();
  }
  function paint(){
    queued=false;raf=0;
    if(!root.isConnected)return;
    const rect=frame.getBoundingClientRect();
    const w=Math.max(1,rect.width),h=Math.max(1,rect.height);
    const dpr=Math.min(2,window.devicePixelRatio||1);
    const pw=Math.round(w*dpr),ph=Math.round(h*dpr);
    if(canvas.width!==pw||canvas.height!==ph){canvas.width=pw;canvas.height=ph;}
    const ctx=canvas.getContext("2d");
    if(!ctx)return;
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.clearRect(0,0,w,h);
    const cx=w/2+view.panX,cy=h/2+view.panY;
    const radiusX=Math.max(55,w/2-100)*view.zoom;
    const radiusY=Math.max(65,h/2-65)*view.zoom;
    const positions=spatialSlots(scene.items.length).map(p=>({
      x:cx+(p.x-50)/38*radiusX,y:cy+(p.y-50)/39*radiusY}));
    ctx.save();
    ctx.lineCap="round";
    ctx.beginPath();ctx.ellipse(cx,cy,Math.min(radiusX,w*.49),Math.min(radiusY,h*.49),0,0,2*Math.PI);
    ctx.strokeStyle="rgba(203,161,86,.10)";ctx.lineWidth=1;ctx.stroke();
    positions.forEach((p,i)=>{
      const picked=i===selected;
      ctx.beginPath();ctx.moveTo(cx,cy);ctx.lineTo(p.x,p.y);
      ctx.strokeStyle=picked?"rgba(238,185,89,.78)":"rgba(174,161,133,.20)";
      ctx.lineWidth=picked?2:1;ctx.stroke();
      const item=nodes.querySelector<HTMLElement>('[data-index="'+i+'"]');
      if(item){item.style.left=p.x+"px";item.style.top=p.y+"px";}
    });
    ctx.beginPath();ctx.arc(cx,cy,65,0,2*Math.PI);
    ctx.fillStyle="rgba(202,154,73,.045)";ctx.fill();
    ctx.strokeStyle="rgba(212,169,95,.29)";ctx.lineWidth=1.3;ctx.stroke();
    ctx.restore();
    const focus=nodes.querySelector<HTMLElement>(".dk-omni-focus");
    if(focus){focus.style.left=cx+"px";focus.style.top=cy+"px";}
    zoomText.textContent=Math.round(view.zoom*100)+"%";
    canvas.dataset.layer="spatial";
    canvas.dataset.nodes=String(scene.items.length+1);
    canvas.dataset.paintedNodes=String(scene.items.length+1);
    canvas.dataset.focus=current;
    canvas.dataset.page=String(scene.page);
  }
  function ensureFocus(){
    let node=nodes.querySelector<HTMLElement>(".dk-omni-focus");
    if(node)return;
    node=el("button",{type:"button",cls:"dk-omni-focus",title:current||"Мой Диск",
      attrs:{"aria-label":"Текущая папка: "+shortName(current)}},
      el("span",{cls:"dk-omni-focus-symbol",attrs:{"aria-hidden":"true"}},icon("folder-open",25)),
      el("strong",{textContent:shortName(current),title:current||"Мой Диск"}),
      el("small",{textContent:"Текущая папка"}));
    node.addEventListener("click",()=>{status.textContent=current||"Мой Диск";canvas.focus();});
    nodes.append(node);
  }
  function schedulePaint(){
    ensureFocus();
    if(queued||!root.isConnected)return;
    queued=true;
    raf=requestAnimationFrame(paint);
  }
  search.addEventListener("input",()=>{
    filter=search.value;page=0;render();
  });
  const wheel=(event:WheelEvent)=>{
    event.preventDefault();zoom(event.deltaY>0?.9:1.11);
  };
  frame.addEventListener("wheel",wheel,{passive:false});
  frame.addEventListener("pointerdown",event=>{
    if(event.button!==0||event.target!==canvas)return;
    dragging=true;moved=false;startX=event.clientX;startY=event.clientY;
    startPanX=view.panX;startPanY=view.panY;
    canvas.setPointerCapture(event.pointerId);
  });
  frame.addEventListener("pointermove",event=>{
    if(!dragging)return;
    if(Math.hypot(event.clientX-startX,event.clientY-startY)>4)moved=true;
    if(moved){
      view.panX=clampView(startPanX+event.clientX-startX,-160,160);
      view.panY=clampView(startPanY+event.clientY-startY,-100,100);
      schedulePaint();
    }
  });
  frame.addEventListener("pointerup",()=>{if(dragging&&moved)save();dragging=false;});
  frame.addEventListener("pointercancel",()=>{dragging=false;});
  // Two-finger pinch does not interfere with tapping native HTML buttons.
  let pinchDistance=0;
  frame.addEventListener("touchmove",event=>{
    if(event.touches.length!==2){pinchDistance=0;return;}
    const a=event.touches[0]!,b=event.touches[1]!;
    const d=Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY);
    if(pinchDistance>0&&Number.isFinite(d)&&d>0)zoom(d/pinchDistance);
    pinchDistance=d;
    event.preventDefault();
  },{passive:false});
  frame.addEventListener("touchend",()=>{pinchDistance=0;});
  canvas.addEventListener("keydown",event=>{
    if(event.key==="+"||event.key==="="){event.preventDefault();zoom(1.12);}
    else if(event.key==="-"){event.preventDefault();zoom(.88);}
    else if(event.key==="0"){event.preventDefault();resetView();}
    else if(event.key==="Backspace"||event.key==="ArrowLeft"&&event.altKey){
      event.preventDefault();stepBack();
    }else if(event.key==="ArrowUp"&&event.altKey){event.preventDefault();navigate(parentOf(current));}
    else if(event.key==="ArrowRight"||event.key==="ArrowDown"){
      event.preventDefault();selected=(selected+1)%Math.max(1,scene.items.length);highlight();
    }else if(event.key==="ArrowLeft"||event.key==="ArrowUp"){
      event.preventDefault();selected=(selected+Math.max(1,scene.items.length)-1)%Math.max(1,scene.items.length);highlight();
    }else if(event.key==="Enter"&&scene.items[selected]){
      event.preventDefault();activate(scene.items[selected]!);
    }else if(event.key==="Escape"&&filter){
      search.value="";filter="";render();
    }
  });
  let everMounted=false;
  if(typeof ResizeObserver!=="undefined"){
    const observer=new ResizeObserver(()=>{
      if(root.isConnected){
        if(!mounted){mounted=true;render();}
        else if((frame.clientWidth<480?6:frame.clientWidth<760?8:12)!==renderLimit)render();
        else schedulePaint();
        everMounted=true;
      }else if(everMounted){observer.disconnect();if(raf)cancelAnimationFrame(raf);}
    });
    observer.observe(frame);
  }
  return {root,update(nextFiles,nextFolders,folder){
    files=nextFiles;folders=nextFolders;
    if(folder!==current){
      if(pendingNav!==folder)history.push(current);
      pendingNav=null;
      history=history.slice(-32);
      current=folder;
      view.panX=0;view.panY=0;
      filter="";search.value="";page=0;
    }
    render();
  }};
}
