/**
 * Tsukimera Disk 12.0 — compact spatial explorer UNDER the folder hierarchy.
 * Inspired by OmniBrille / Circle Explorer interactions; original TypeScript
 * implementation using existing Canvas, DOM, SQLite preferences and Disk API.
 * Data is read-only here; file operations remain in disk.ts and the server.
 */
import {el,icon} from "../dom";
import {api,diskRawUrl,type DiskFile} from "../api";
import {human} from "./disk-model";
import {
  spatialScene,spatialSlots,spatialChanges,spatialNeighbor,spatialFileType,
  spatialAge,SPATIAL_DENSITY_KEY,type SpatialItem,type SpatialScene
} from "./disk-map-spatial";
import {normalizeMiniView,MINI_VIEW_KEY,clampView} from "./disk-map-mini-model";
import {writePreference} from "../preferences";

type MapActions={openFolder:(folder:string)=>void;openFile:(id:string)=>void};
export interface MiniDiskMap{
  root:HTMLElement;
  update:(files:DiskFile[],folders:string[],current:string)=>void;
  highlightFile:(id:string|null)=>void;
}
const parentOf=(p:string)=>p.includes("/")?p.slice(0,p.lastIndexOf("/")):"";
const shortName=(p:string)=>p?p.split("/").pop()||p:"Мой Диск";
const sortRu=(a:string,b:string)=>a.localeCompare(b,"ru",{numeric:true,sensitivity:"base"});
const getFile=(files:readonly DiskFile[],id:string)=>files.find(f=>f.id===id&&!f.deletedAt);
const colours:Record<ReturnType<typeof spatialFileType>|"folder",string>={
  folder:"#dfb873",image:"#76bee0",document:"#dfb873",archive:"#aa96d6",
  video:"#d99ac4",audio:"#77c5af",code:"#91afdb",other:"#9b9eac"
};
const button=(content:string,label:string,run:()=>void,cls="dk-omni-tool")=>{
  const b=el("button",{type:"button",cls,title:label,attrs:{"aria-label":label},textContent:content});
  b.addEventListener("click",run);
  return b;
};

export function createMiniDiskMap(actions:MapActions):MiniDiskMap{
  const saved=normalizeMiniView((()=>{try{return JSON.parse(localStorage.getItem(MINI_VIEW_KEY)||"null");}catch{return null;}})());
  const view={...saved,zoom:clampView(saved.zoom,.75,1.65)};
  const count=el("small",{cls:"dk-mini-map-count",textContent:"0 папок · 0 файлов"});
  const canvas=el("canvas",{cls:"dk-mini-map-canvas",attrs:{
    tabindex:"0",role:"application",
    "aria-label":"Живая карта: стрелки — выбор ближайшего объекта, Enter — открыть, клавиши + и - — масштаб, Backspace — назад, ввод имени — поиск."}});
  const nodes=el("div",{cls:"dk-omni-nodes"});
  const frame=el("div",{cls:"dk-mini-map-frame dk-omni-stage"},canvas,nodes);
  const list=el("div",{cls:"dk-omni-list",attrs:{role:"group","aria-label":"Содержимое текущей папки"}});
  const trail=el("nav",{cls:"dk-omni-trail",attrs:{"aria-label":"Путь папки"}});
  const siblings=el("div",{cls:"dk-omni-neighbors",hidden:true,attrs:{"aria-label":"Соседние папки"}});
  const search=el("input",{type:"search",cls:"dk-omni-search",placeholder:"Найти файл или папку",
    attrs:{"aria-label":"Поиск внутри текущей папки"}});
  const status=el("div",{cls:"dk-mini-map-status dk-omni-status",attrs:{role:"status","aria-live":"polite"},textContent:"Выберите папку или файл"});
  const pageLabel=el("small",{cls:"dk-omni-page-label"});
  const zoomLabel=el("span",{cls:"dk-omni-zoom-label",textContent:"100%"});
  const back=button("←","Назад по истории карты",()=>backHistory());
  const up=button("↑","На уровень выше",()=>navigate(parentOf(current)));
  const home=button("⌂","В корень Диска",()=>navigate(""));
  const prev=button("‹","Предыдущая группа файлов",()=>changePage(-1));
  const next=button("›","Следующая группа файлов",()=>changePage(1));
  const zoomOut=button("−","Уменьшить карту",()=>zoom(.88));
  const zoomIn=button("+","Увеличить карту",()=>zoom(1.12));
  const reset=button("Центр","Сбросить масштаб карты",()=>resetView(),"dk-mini-map-reset dk-omni-tool");
  const preview=el("section",{cls:"dk-omni-preview",hidden:true,attrs:{"aria-label":"Закреплённый предпросмотр файла"}});
  const previewName=el("strong");
  const previewClose=button("×","Открепить предпросмотр",()=>{pinnedId=null;preview.hidden=true;},"dk-omni-inline-btn");
  const previewBody=el("div",{cls:"dk-omni-preview-body"});
  preview.append(el("div",{cls:"dk-omni-preview-head"},previewName,previewClose),previewBody);
  const root=el("section",{cls:"dk-mini-map dk-omni-explorer",attrs:{"aria-label":"Живая карта Диска"}},
    el("header",{cls:"dk-omni-head"},
      el("div",{cls:"dk-omni-titles"},el("strong",{textContent:"Живая карта"}),count),
      el("div",{cls:"dk-omni-nav"},back,up,home)),
    el("div",{cls:"dk-omni-utility"},
      trail,siblings,
      el("div",{cls:"dk-omni-search-wrap"},icon("search",15),search)),
    el("div",{cls:"dk-omni-workspace"},
      frame,
      el("aside",{cls:"dk-omni-panel",attrs:{"aria-label":"Список объектов карты"}},
        el("div",{cls:"dk-omni-list-head"},el("strong",{textContent:"Рядом с папкой"}),el("small",{textContent:"Нажмите, чтобы открыть"})),
        list,el("div",{cls:"dk-omni-pager"},prev,pageLabel,next))),
    preview,
    el("footer",{cls:"dk-omni-foot"},status,
      el("div",{cls:"dk-omni-zoom"},zoomOut,zoomLabel,zoomIn,reset)));

  let files:DiskFile[]=[],folders:string[]=[],current="",filter="",page=0;
  let scene:SpatialScene=spatialScene([],[],"");
  let history:string[]=[];
  let pendingNav:string|null=null;
  let selected=-1,positions:Array<{x:number;y:number}>=[];
  let savedSnapshot:DiskFile[]|null=null;
  let changed=new Map<string,"added"|"modified"|"removed">();
  let peekFolder:string|null=null,pinnedId:string|null=null,previewGen=0;
  let renderLimit=0,queued=false,raf=0,saveTimer=0,mounted=false;
  let dragging=false,moved=false,startX=0,startY=0,startPanX=0,startPanY=0;
  let typed="",typedAt=0;
  const limitForWidth=()=>frame.clientWidth<560?6:frame.clientWidth<760?8:
    (localStorage.getItem(SPATIAL_DENSITY_KEY)==="detailed"?12:8);
  const save=()=>{
    clearTimeout(saveTimer);
    saveTimer=window.setTimeout(()=>writePreference(MINI_VIEW_KEY,JSON.stringify(view)),250);
  };
  function navigate(folder:string,record=true){
    if(folder===current)return;
    if(record)history.push(current);
    history=history.slice(-32);
    pendingNav=folder;
    actions.openFolder(folder);
  }
  function backHistory(){
    const destination=history.pop();
    if(destination!==undefined)navigate(destination,false);
  }
  function changePage(delta:number){
    page=Math.max(0,Math.min(scene.pages-1,page+delta));
    selected=-1;peekFolder=null;render();
  }
  function zoom(multiplier:number){
    view.zoom=clampView(view.zoom*multiplier,.75,1.65);
    save();schedulePaint();
  }
  function resetView(){
    view.zoom=1;view.panX=0;view.panY=0;view.focus="";
    save();schedulePaint();
  }
  function markFileCards(id:string|null){
    const pageRoot=root.closest(".disk-page");
    if(!pageRoot)return;
    for(const element of pageRoot.querySelectorAll<HTMLElement>(".dk-file.dk-map-linked"))
      element.classList.remove("dk-map-linked");
    if(!id)return;
    for(const element of pageRoot.querySelectorAll<HTMLElement>(".dk-file[data-file-id]"))
      if(element.dataset.fileId===id)element.classList.add("dk-map-linked");
  }
  function highlightFile(id:string|null){
    const index=id===null?-1:scene.items.findIndex(it=>it.id==="file:"+id);
    if(index===selected)return;
    selected=index;
    highlight();
  }
  function selectItem(item:SpatialItem,index:number){
    selected=index;
    status.textContent=(item.kind==="folder"?"Папка · ":"Файл · ")+item.name+
      " · "+human(item.size)+(item.duplicates?" · совпадений SHA-256: "+item.duplicates:"");
    highlight();
  }
  function highlight(){
    for(const element of root.querySelectorAll<HTMLElement>("[data-index]"))
      element.classList.toggle("is-selected",Number(element.dataset.index)===selected);
    const item=scene.items[selected];
    markFileCards(item?.kind==="file"?item.id.slice(5):null);
    canvas.dataset.selected=item?.id||"";
    schedulePaint();
  }
  function activate(item:SpatialItem){
    if(item.kind==="folder")navigate(item.folder);
    else actions.openFile(item.id.slice(5));
  }
  function settingsFor(item:SpatialItem):{kind:string;type:string;age:string;color:string}{
    const type=item.kind==="folder"?"folder":spatialFileType(item.name);
    return {kind:item.kind,type,age:spatialAge(item.uploadedAt),color:colours[type]};
  }
  function makeItem(item:SpatialItem,index:number,graphic:boolean):HTMLButtonElement{
    const style=settingsFor(item);
    const b=el("button",{type:"button",cls:(graphic?"dk-omni-node":"dk-omni-row")+
      " kind-"+item.kind,attrs:{"data-index":String(index),"data-id":item.id,
      "data-type":style.type,
      "data-age":style.age,
      "data-changed":item.kind==="file"?(changed.get(item.id.slice(5))||""):"",
      "aria-label":(item.kind==="folder"?"Открыть папку ":"Открыть файл ")+item.name}});
    b.style.setProperty("--dk-type",style.color);
    b.style.setProperty("--dk-age",style.age==="today"?"#77c5af":style.age==="week"?"#7eaed7":"transparent");
    const name=el("span",{cls:"dk-omni-item-name",textContent:item.name,title:item.name});
    const meta=el("small",{cls:"dk-omni-item-meta",textContent:item.kind==="folder"?
      item.count+" файлов":human(item.size)+(item.duplicates?" · SHA ×"+(item.duplicates+1):"")});
    const track=el("div",{cls:"dk-omni-size-track",attrs:{"aria-hidden":"true"}},
      el("div",{cls:"dk-omni-size-bar"}));
    const fraction=scene.items.reduce((largest,it)=>Math.max(largest,it.size),0);
    (track.firstElementChild as HTMLElement).style.width=
      Math.round(item.size/Math.max(1,fraction)*100)+"%";
    b.append(el("span",{cls:"dk-omni-glyph",attrs:{"aria-hidden":"true"}},
        icon(item.kind==="folder"?"folder":style.type==="image"?"image":
          style.type==="code"?"file-code":"file",graphic?17:16)),
      el("span",{cls:"dk-omni-item-copy"},name,meta,track),
      el("span",{cls:"dk-omni-age",title:"Добавлено: "+(item.uploadedAt||"неизвестно"),attrs:{"aria-hidden":"true"}}));
    if(item.kind==="file"&&item.duplicates)
      b.title=item.name+" · подтверждено SHA-256: "+item.duplicates+" других файлов";
    else b.title=item.name;
    b.addEventListener("pointerenter",()=>{if(!dragging)selectItem(item,index);});
    b.addEventListener("focus",()=>selectItem(item,index));
    b.addEventListener("click",()=>activate(item));
    return b;
  }
  function renderPeek(host:HTMLElement,item:SpatialItem){
    if(peekFolder!==item.folder)return;
    const near=spatialScene(files,folders,item.folder,0,4);
    const body=el("div",{cls:"dk-omni-folder-peek",attrs:{"aria-label":"Предпросмотр папки "+item.name}});
    body.append(el("small",{textContent:near.total+" объектов внутри"}));
    for(const child of near.items){
      const open=button((child.kind==="folder"?"▸ ":"· ")+child.name,
        "Открыть "+child.name,()=>activate(child),"dk-omni-peek-item");
      body.append(el("div",{cls:"dk-omni-peek-row"},open));
    }
    if(near.total>near.items.length)body.append(el("small",{textContent:"Ещё "+(near.total-near.items.length)}));
    host.append(body);
  }
  function renderListItem(item:SpatialItem,index:number){
    const unit=el("div",{cls:"dk-omni-list-unit"});
    const actionsRow=el("div",{cls:"dk-omni-list-actions"});
    actionsRow.append(makeItem(item,index,false));
    if(item.kind==="folder"){
      const peek=button(peekFolder===item.folder?"−":"▸","Показать содержимое папки "+item.name,()=>{
        peekFolder=peekFolder===item.folder?null:item.folder;
        render();
      },"dk-omni-inline-btn");
      peek.setAttribute("aria-expanded",String(peekFolder===item.folder));
      actionsRow.append(peek);
    }else{
      const pin=button(pinnedId===item.id.slice(5)?"★":"☆",
        "Закрепить предпросмотр "+item.name,()=>{
          pinnedId=pinnedId===item.id.slice(5)?null:item.id.slice(5);
          void updatePreview();render();
        },"dk-omni-inline-btn");
      pin.setAttribute("aria-pressed",String(pinnedId===item.id.slice(5)));
      actionsRow.append(pin);
    }
    unit.append(actionsRow);
    if(item.kind==="folder")renderPeek(unit,item);
    return unit;
  }
  async function updatePreview(){
    const id=pinnedId;
    const file=id?getFile(files,id):undefined;
    const generation=++previewGen;
    if(!file){preview.hidden=true;pinnedId=null;return;}
    preview.hidden=false;previewName.textContent=file.name;previewName.title=file.name;
    const extension=file.name.split(".").pop()?.toLowerCase()||"";
    const previewNode=el("div",{textContent:"Предпросмотр загружается…"});
    previewBody.replaceChildren(previewNode);
    if(["png","jpg","jpeg","gif","webp","bmp","svg"].includes(extension)){
      previewBody.replaceChildren(el("img",{src:diskRawUrl(file),alt:file.name,loading:"lazy"}));
    }else if(extension==="pdf"){
      const iframe=el("iframe",{src:diskRawUrl(file),title:"PDF: "+file.name,
        attrs:{"sandbox":"","referrerpolicy":"no-referrer"}});
      previewBody.replaceChildren(iframe);
    }else if(["txt","md","csv","json","ts","js","css","html","py","log"].includes(extension)){
      const response=await api.diskText(file.id);
      if(generation!==previewGen||pinnedId!==id)return;
      previewBody.replaceChildren(response.ok?
        el("pre",{textContent:response.value.text.slice(0,3600)}):
        el("p",{textContent:"Не удалось прочитать файл: "+response.error.message}));
    }else{
      previewBody.replaceChildren(el("p",{textContent:"Для этого формата используйте основную панель сведений."}));
    }
  }
  function renderTrail(){
    trail.replaceChildren();
    const parts=current?current.split("/"):[];
    const parents=["",...parts.map((_,i)=>parts.slice(0,i+1).join("/"))].slice(-4);
    for(let i=0;i<parents.length;i++){
      const folder=parents[i]!;
      if(i)trail.append(el("span",{cls:"dk-omni-slash",textContent:"/"}));
      const crumb=button(shortName(folder),"Перейти: "+(folder||"Корень"),()=>navigate(folder),"dk-omni-crumb"+(folder===current?" is-current":""));
      crumb.title=folder||"Мой Диск";
      if(folder===current)crumb.setAttribute("aria-current","page");
      trail.append(crumb);
      if(folder===current){
        const switcher=button("⌄","Показать соседние папки",()=>renderSiblings(),"dk-omni-inline-btn");
        trail.append(switcher);
      }
    }
  }
  function renderSiblings(){
    siblings.hidden=!siblings.hidden;
    if(siblings.hidden)return;
    const peerFolder=parentOf(current);
    const names=new Set<string>(folders);
    for(const file of files){
      if(!file.deletedAt&&file.folder)names.add(file.folder);
    }
    const peerNames=[...names].filter(name=>parentOf(name)===peerFolder).sort(sortRu);
    siblings.replaceChildren();
    if(!peerNames.length){siblings.textContent="Нет соседних папок";return;}
    for(const folder of peerNames.slice(0,40)){
      const item=button(shortName(folder),"Перейти к "+folder,()=>{
        siblings.hidden=true;navigate(folder);
      });
      if(folder===current)item.setAttribute("aria-current","page");
      siblings.append(item);
    }
    if(peerNames.length>40)siblings.append(el("small",{textContent:"Показаны первые 40 из "+peerNames.length}));
  }
  function render(){
    const limit=limitForWidth();
    renderLimit=limit;
    scene=spatialScene(files,folders,current,page,limit,filter);
    page=scene.page;
    selected=-1;
    const numChanged=[...changed.values()].filter(x=>x!=="removed").length;
    count.textContent=scene.folders+" папок · "+scene.files+" файлов"+(numChanged?" · "+numChanged+" измен.":"");
    back.disabled=history.length===0;up.disabled=!current;home.disabled=!current;
    prev.disabled=page===0;next.disabled=page===scene.pages-1;
    pageLabel.textContent=scene.total?((page+1)+" / "+scene.pages):"Пусто";
    status.textContent=filter?"Найдено: "+scene.total:(current||"Корень")+" · "+scene.total+" объектов";
    renderTrail();
    siblings.hidden=true;
    nodes.replaceChildren();list.replaceChildren();
    if(!scene.items.length){
      nodes.append(el("p",{cls:"dk-omni-empty",textContent:filter?"Ничего не найдено":"Папка пустая"}));
      list.append(el("p",{cls:"dk-omni-list-empty",textContent:"Нет элементов"}));
    }else{
      scene.items.forEach((item,i)=>{
        nodes.append(makeItem(item,i,true));
        list.append(renderListItem(item,i));
      });
    }
    const remaining=scene.total-(page+1)*limit;
    if(remaining>0){
      const more=button("Ещё "+remaining+" элементов","Показать следующую группу",()=>changePage(1),"dk-omni-overflow");
      nodes.append(more);
    }
    ensureFocus();
    schedulePaint();
  }
  function ensureFocus(){
    let focus=nodes.querySelector<HTMLElement>(".dk-omni-focus");
    if(focus)return;
    focus=el("button",{type:"button",cls:"dk-omni-focus",
      title:current?"Открыть родительскую папку":"Корень Диска",
      attrs:{"aria-label":current?"Подняться из "+current+" на уровень выше":"Корень Диска"}},
      el("span",{cls:"dk-omni-focus-symbol",attrs:{"aria-hidden":"true"}},icon("folder-open",23)),
      el("strong",{textContent:shortName(current),title:current||"Корень"}),
      el("small",{textContent:current?"Нажмите: вверх":"Текущая папка"}));
    focus.addEventListener("click",()=>{if(current)navigate(parentOf(current));else canvas.focus();});
    nodes.append(focus);
  }
  function paint(){
    queued=false;raf=0;
    if(!root.isConnected)return;
    const rect=frame.getBoundingClientRect();
    const w=Math.max(1,rect.width),h=Math.max(1,rect.height);
    const dpr=Math.min(2,window.devicePixelRatio||1);
    if(canvas.width!==Math.round(w*dpr)||canvas.height!==Math.round(h*dpr)){
      canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);
    }
    const ctx=canvas.getContext("2d");
    if(!ctx)return;
    ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
    const compact=w<560;
    const cx=w/2+(compact?0:view.panX),cy=compact?43:h/2+view.panY;
    const radiusX=Math.max(55,w/2-100)*view.zoom;
    const radiusY=Math.max(65,h/2-65)*view.zoom;
    positions=compact?scene.items.map((_,i)=>({
      x:Math.max(48,Math.min(w-48,w*(i%2?.74:.26))),
      y:126+Math.floor(i/2)*51
    })):spatialSlots(scene.items.length).map(p=>({
      x:cx+(p.x-50)/38*radiusX,y:cy+(p.y-50)/39*radiusY
    }));
    ctx.save();ctx.lineCap="round";
    if(!compact){
      ctx.beginPath();ctx.ellipse(cx,cy,Math.min(radiusX,w*.49),Math.min(radiusY,h*.49),0,0,2*Math.PI);
      ctx.strokeStyle="rgba(203,161,86,.12)";ctx.lineWidth=1;ctx.stroke();
    }
    positions.forEach((p,i)=>{
      const picked=i===selected;
      ctx.beginPath();ctx.moveTo(cx,cy);ctx.lineTo(p.x,p.y);
      ctx.strokeStyle=picked?"rgba(241,190,104,.9)":"rgba(197,168,119,.22)";
      ctx.lineWidth=picked?2.2:1;ctx.stroke();
      const node=nodes.querySelector<HTMLElement>('[data-index="'+i+'"]');
      if(node){node.style.left=p.x+"px";node.style.top=p.y+"px";}
    });
    ctx.beginPath();ctx.arc(cx,cy,compact?43:64,0,2*Math.PI);
    ctx.strokeStyle="rgba(218,170,89,.28)";ctx.lineWidth=1;ctx.stroke();ctx.restore();
    const focus=nodes.querySelector<HTMLElement>(".dk-omni-focus");
    if(focus){
      focus.style.left=cx+"px";focus.style.top=cy+"px";
      focus.style.setProperty("--dk-focus-scale",String(view.zoom));
    }
    zoomLabel.textContent=Math.round(view.zoom*100)+"%";
    canvas.dataset.layer="spatial";
    canvas.dataset.nodes=String(scene.items.length+1);
    canvas.dataset.paintedNodes=String(scene.items.length+1);
    canvas.dataset.focus=current;
    canvas.dataset.page=String(scene.page);
  }
  function schedulePaint(){
    ensureFocus();
    if(queued||!root.isConnected)return;
    queued=true;raf=requestAnimationFrame(paint);
  }
  search.addEventListener("input",()=>{
    filter=search.value;page=0;peekFolder=null;render();
  });
  frame.addEventListener("wheel",event=>{event.preventDefault();zoom(event.deltaY>0?.9:1.11);},{passive:false});
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
      view.panX=clampView(startPanX+event.clientX-startX,-120,120);
      view.panY=clampView(startPanY+event.clientY-startY,-100,100);
      schedulePaint();
    }
  });
  frame.addEventListener("pointerup",()=>{if(dragging&&moved)save();dragging=false;});
  frame.addEventListener("pointercancel",()=>{dragging=false;});
  let pinchDistance=0;
  frame.addEventListener("touchmove",event=>{
    if(event.touches.length!==2){pinchDistance=0;return;}
    const a=event.touches[0]!,b=event.touches[1]!;
    const distance=Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY);
    if(pinchDistance>0&&distance>0)zoom(distance/pinchDistance);
    pinchDistance=distance;event.preventDefault();
  },{passive:false});
  frame.addEventListener("touchend",()=>{pinchDistance=0;});
  canvas.addEventListener("keydown",event=>{
    if(event.key==="+"||event.key==="="){event.preventDefault();zoom(1.12);}
    else if(event.key==="-"){event.preventDefault();zoom(.88);}
    else if(event.key==="0"){event.preventDefault();resetView();}
    else if(event.key==="Backspace"&&filter){event.preventDefault();search.value="";filter="";render();}
    else if(event.key==="Backspace"||(event.key==="ArrowLeft"&&event.altKey)){
      event.preventDefault();backHistory();
    }else if(event.key==="ArrowUp"&&event.altKey){event.preventDefault();navigate(parentOf(current));}
    else if(["ArrowUp","ArrowDown","ArrowLeft","ArrowRight"].includes(event.key)){
      event.preventDefault();
      const direction=event.key==="ArrowUp"?"up":event.key==="ArrowDown"?"down":
        event.key==="ArrowLeft"?"left":"right";
      const nearest=spatialNeighbor(positions,selected,direction);
      if(nearest>=0){selected=nearest;highlight();
        status.textContent=scene.items[nearest]!.name;}
    }else if(event.key==="Enter"&&scene.items[selected]){
      event.preventDefault();activate(scene.items[selected]!);
    }else if(event.key==="Escape"&&filter){
      search.value="";filter="";render();
    }else if(!event.ctrlKey&&!event.altKey&&!event.metaKey&&event.key.length===1&&/\S/.test(event.key)){
      event.preventDefault();
      if(Date.now()-typedAt>1200)typed="";
      typed+=event.key;typedAt=Date.now();
      search.value=typed;filter=typed;page=0;render();
      search.focus();
    }
  });
  let everMounted=false;
  if(typeof ResizeObserver!=="undefined"){
    const observer=new ResizeObserver(()=>{
      if(root.isConnected){
        if(!mounted){mounted=true;render();}
        else if(limitForWidth()!==renderLimit)render();
        else schedulePaint();
        everMounted=true;
      }else if(everMounted){
        observer.disconnect();if(raf)cancelAnimationFrame(raf);
      }
    });
    observer.observe(frame);
  }
  return {root,highlightFile,update(nextFiles,nextFolders,folder){
    changed=spatialChanges(savedSnapshot,nextFiles);
    savedSnapshot=nextFiles.slice();
    files=nextFiles;folders=nextFolders;
    if(folder!==current){
      if(pendingNav!==folder)history.push(current);
      pendingNav=null;history=history.slice(-32);
      current=folder;filter="";search.value="";page=0;peekFolder=null;
      view.panX=0;view.panY=0;
    }
    render();
    if(pinnedId&&!getFile(files,pinnedId)){pinnedId=null;preview.hidden=true;}
  }};
}
