/**
 * A lightweight, navigable HTML5 Canvas graph of the actual local Disk.
 * No network, no force-layout library, no background animation while hidden.
 */
import {el} from "../dom";
import {openSheet} from "./sheet";
import {human} from "./disk-model";
import type {DiskFile} from "../api";
import {graphFromFiles,type MapNode} from "./disk-map-layout";

const clamp=(value:number,low:number,high:number)=>Math.min(high,Math.max(low,value));
const short=(name:string,max=24)=>name.length>max?name.slice(0,max-1)+"…":name;
const prefersReduced=()=>matchMedia("(prefers-reduced-motion: reduce)").matches;

export function openLiveDiskMap(files:DiskFile[],folders:string[],
  openFolder:(folder:string)=>void,openFile?:(id:string)=>void):void{
  const graph=graphFromFiles(files,folders);
  const byId=new Map(graph.nodes.map(node=>[node.id,node]));
  const panel=el("div",{cls:"dkx-live-map"});
  const top=el("div",{cls:"dkx-map-intro"},
    el("p",{cls:"muted",textContent:"Живая карта реальных папок, файлов и подтверждённых связей. Колесо — масштаб, перетаскивание — перемещение."}),
    el("strong",{textContent:graph.totalFiles+" файлов · "+graph.totalFolders+" папок · "+human(graph.bytes)}),
    el("small",{textContent:graph.shownFiles<graph.totalFiles||graph.shownFolders<graph.totalFolders
      ?"Для плавной работы показано "+graph.shownFiles+" из "+graph.totalFiles+" файлов и "+
        graph.shownFolders+" из "+graph.totalFolders+" папок. Всё остальное доступно в обычном Диске."
      :"Показаны все доступные узлы каталога."}));
  const search=el("input",{type:"search",cls:"dkx-map-search",placeholder:"Найти узел по имени…",
    attrs:{"aria-label":"Поиск файлов и папок на карте"}});
  const buttons=el("div",{cls:"dkx-map-controls"});
  const zoomOut=el("button",{type:"button",cls:"btn sm",textContent:"−",attrs:{"aria-label":"Уменьшить карту"}});
  const zoomIn=el("button",{type:"button",cls:"btn sm",textContent:"+",attrs:{"aria-label":"Увеличить карту"}});
  const reset=el("button",{type:"button",cls:"btn sm",textContent:"Вся карта"});
  const selected=el("span",{cls:"dkx-map-selected",attrs:{"aria-live":"polite"},textContent:"Наведите на узел, чтобы увидеть его сведения"});
  buttons.append(zoomOut,zoomIn,reset);
  const tools=el("div",{cls:"dkx-map-tools"},search,buttons);
  const frame=el("div",{cls:"dkx-map-frame"});
  const canvas=el("canvas",{cls:"dkx-map-canvas",attrs:{
    role:"img",tabindex:"0",
    "aria-label":"Граф папок и файлов. Вращайте колесо мыши для масштаба, перетаскивайте для перемещения. Список папок ниже доступен с клавиатуры."}});
  const tooltip=el("div",{cls:"dkx-map-tip",attrs:{role:"status"}});
  tooltip.hidden=true;
  const note=el("div",{cls:"dkx-map-legend"},
    el("span",{cls:"dkx-legend-root",textContent:"● Диск"}),
    el("span",{cls:"dkx-legend-folder",textContent:"● Папка"}),
    el("span",{cls:"dkx-legend-file",textContent:"● Файл"}),
    el("span",{cls:"dkx-legend-copy",textContent:"┄ Совпадает SHA-256"}),
    el("span",{cls:"dkx-legend-tag",textContent:"┄ Общая метка"}));
  frame.append(canvas,tooltip);
  const fallback=el("div",{cls:"dkx-map-folders"});
  const totals=new Map<string,{bytes:number;count:number}>();
  for(const f of files.filter(f=>!f.deletedAt)){
    const root=f.folder.split("/")[0]||"";
    const row=totals.get(root)||{bytes:0,count:0};
    row.bytes+=f.size;row.count++;
    totals.set(root,row);
  }
  for(const name of folders){
    const top=name.split("/")[0]||"";
    if(!totals.has(top))totals.set(top,{bytes:0,count:0});
  }
  const sorted=[...totals].sort((a,b)=>b[1].bytes-a[1].bytes || a[0].localeCompare(b[0],"ru"));
  fallback.append(el("strong",{textContent:"Открыть папку без карты"}),
    ...sorted.slice(0,40).map(([name,stats])=>{
      const button=el("button",{type:"button",cls:"dkx-map-folder-btn",
        textContent:(name||"Корень")+" · "+stats.count+" файлов · "+human(stats.bytes)});
      button.addEventListener("click",()=>{sheet.close();openFolder(name);});
      return button;
    }));
  if(!sorted.length)fallback.append(el("p",{textContent:"Загрузите первый документ, чтобы карта начала расти."}));
  panel.append(top,tools,selected,frame,note,fallback);
  const ctx=canvas.getContext("2d");
  let width=0,height=0,scale=1,panX=0,panY=0,hover:MapNode|null=null,query="";
  let progress=prefersReduced()?1:0,animation=0,dragging=false,moved=false;
  let startX=0,startY=0,lastX=0,lastY=0;
  const markerRadius=(n:MapNode)=>n.kind==="root"?13:n.kind==="folder"?8:4;
  const location=(n:MapNode)=>{
    const ease=1-Math.pow(1-progress,3);
    return {x:width/2+panX+n.x*scale*ease,y:height/2+panY+n.y*scale*ease};
  };
  const point=(event:PointerEvent|WheelEvent)=>{
    const rect=canvas.getBoundingClientRect();
    return {x:event.clientX-rect.left,y:event.clientY-rect.top};
  };
  const hit=(x:number,y:number)=>{
    for(let i=graph.nodes.length-1;i>=0;i--){
      const node=graph.nodes[i]!,pos=location(node),radius=markerRadius(node)+5;
      if((pos.x-x)**2+(pos.y-y)**2<=radius**2)return node;
    }
    return null;
  };
  const visible=(n:MapNode)=>!query||n.name.toLocaleLowerCase("ru").includes(query);
  const paint=()=>{
    if(!ctx||!width||!height)return;
    const dpr=clamp(window.devicePixelRatio||1,1,2);
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.clearRect(0,0,width,height);
    const brand=getComputedStyle(document.documentElement).getPropertyValue("--brand").trim()||"#d9a441";
    ctx.lineCap="round";
    for(const e of graph.edges){
      const a=byId.get(e.from),b=byId.get(e.to);
      if(!a||!b)continue;
      if(query&&!visible(a)&&!visible(b))continue;
      const from=location(a),to=location(b);
      ctx.beginPath();ctx.moveTo(from.x,from.y);ctx.lineTo(to.x,to.y);
      ctx.strokeStyle=e.kind==="duplicate"?"rgba(252,178,80,.66)":
        e.kind==="tag"?"rgba(83,210,180,.45)":"rgba(164,161,180,.17)";
      ctx.lineWidth=e.kind==="contains"?1:1.6;
      ctx.setLineDash(e.kind==="contains"?[]:[4,5]);ctx.stroke();
    }
    ctx.setLineDash([]);
    for(const n of graph.nodes){
      const pos=location(n),radius=markerRadius(n);
      if(pos.x<-30||pos.y<-30||pos.x>width+30||pos.y>height+30)continue;
      const highlighted=hover?.id===n.id;
      const muted=query&&!visible(n);
      ctx.globalAlpha=muted?.17:1;
      if(n.kind!=="file"||highlighted){
        ctx.beginPath();ctx.arc(pos.x,pos.y,radius+(highlighted?9:5),0,Math.PI*2);
        ctx.fillStyle=n.kind==="root"?"rgba(217,164,65,.13)":
          n.kind==="folder"?"rgba(120,147,239,.13)":"rgba(217,164,65,.16)";
        ctx.fill();
      }
      ctx.beginPath();ctx.arc(pos.x,pos.y,radius+(highlighted?2:0),0,Math.PI*2);
      ctx.fillStyle=n.kind==="root"?brand:n.kind==="folder"?"#8ca8ed":"#d7dde8";
      ctx.fill();
      if(highlighted||n.kind==="root"||(n.kind==="folder"&&scale>.53)){
        ctx.textAlign="center";ctx.textBaseline="top";
        ctx.font=(highlighted?"600 12px":"11px")+" system-ui";
        ctx.fillStyle=highlighted?"#f8dfa5":"#b6b3ba";
        ctx.fillText(short(n.name,highlighted?38:18),pos.x,pos.y+radius+8,145);
      }
      ctx.globalAlpha=1;
    }
  };
  const resize=()=>{
    const rect=canvas.getBoundingClientRect();
    width=Math.max(1,Math.round(rect.width));height=Math.max(1,Math.round(rect.height));
    const dpr=clamp(window.devicePixelRatio||1,1,2);
    canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);
    paint();
  };
  const fit=()=>{
    const reach=Math.max(180,...graph.nodes.map(n=>Math.max(Math.abs(n.x),Math.abs(n.y))+45));
    scale=clamp(Math.min(width,height)*.45/reach,.18,1.4);
    panX=0;panY=0;paint();
  };
  const zoom=(factor:number,x=width/2,y=height/2)=>{
    const before=scale;scale=clamp(scale*factor,.14,3.4);
    const change=scale/before;
    panX=x-width/2-(x-width/2-panX)*change;
    panY=y-height/2-(y-height/2-panY)*change;
    paint();
  };
  const showTip=(node:MapNode|null,p?:{x:number;y:number})=>{
    hover=node;
    if(!node){tooltip.hidden=true;selected.textContent="Наведите на узел, чтобы увидеть его сведения";}
    else{
      selected.textContent=(node.kind==="file"?"Файл · ":node.kind==="folder"?"Папка · ":"Диск · ")+
        node.name+" · "+human(node.size);
      tooltip.textContent=selected.textContent;
      tooltip.hidden=!p;
      if(p){
        tooltip.style.left=clamp(p.x+12,8,Math.max(8,width-220))+"px";
        tooltip.style.top=clamp(p.y-12,8,Math.max(8,height-46))+"px";
      }
    }
    paint();
  };
  const navigate=(node:MapNode)=>{
    if(node.kind==="file"&&openFile){sheet.close();openFile(node.id.slice(5));return;}
    sheet.close();openFolder(node.folder);
  };
  canvas.addEventListener("pointerdown",event=>{
    if(event.button!==0)return;
    dragging=true;moved=false;startX=lastX=point(event).x;startY=lastY=point(event).y;
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove",event=>{
    const p=point(event);
    if(dragging){
      if(Math.hypot(p.x-startX,p.y-startY)>5)moved=true;
      if(moved){panX+=p.x-lastX;panY+=p.y-lastY;paint();}
    }else showTip(hit(p.x,p.y),p);
    lastX=p.x;lastY=p.y;
  });
  canvas.addEventListener("pointerup",event=>{
    if(!dragging)return;
    dragging=false;
    if(!moved){
      const p=point(event),node=hit(p.x,p.y);
      if(node)navigate(node);
    }
  });
  canvas.addEventListener("pointercancel",()=>{dragging=false;});
  canvas.addEventListener("pointerleave",()=>{if(!dragging)showTip(null);});
  canvas.addEventListener("wheel",event=>{
    event.preventDefault();
    const p=point(event);zoom(event.deltaY>0?.86:1.16,p.x,p.y);
  },{passive:false});
  canvas.addEventListener("keydown",event=>{
    if(event.key==="+"||event.key==="="){zoom(1.2);event.preventDefault();}
    else if(event.key==="-"){zoom(.83);event.preventDefault();}
    else if(event.key==="ArrowLeft"){panX+=28;paint();event.preventDefault();}
    else if(event.key==="ArrowRight"){panX-=28;paint();event.preventDefault();}
    else if(event.key==="ArrowUp"){panY+=28;paint();event.preventDefault();}
    else if(event.key==="ArrowDown"){panY-=28;paint();event.preventDefault();}
    else if(event.key==="0"){fit();event.preventDefault();}
  });
  search.addEventListener("input",()=>{
    query=search.value.trim().toLocaleLowerCase("ru");
    const matches=graph.nodes.filter(n=>visible(n)&&n.kind!=="root");
    selected.textContent=query?"Найдено на карте: "+matches.length+
      (graph.shownFiles<graph.totalFiles?" · карта показывает часть файлов":""):
      "Наведите на узел, чтобы увидеть его сведения";
    paint();
  });
  zoomOut.addEventListener("click",()=>zoom(.8));
  zoomIn.addEventListener("click",()=>zoom(1.25));
  reset.addEventListener("click",fit);
  const resizeObserver=typeof ResizeObserver==="function"?new ResizeObserver(()=>resize()):null;
  const sheet=openSheet({title:"Живая карта Диска",icon:"folder",content:panel,
    onClose:()=>{cancelAnimationFrame(animation);resizeObserver?.disconnect();}});
  if(!ctx){
    canvas.hidden=true;
    selected.textContent="Canvas недоступен — папки можно открыть в списке ниже.";
  }else{
    resizeObserver?.observe(canvas);
    requestAnimationFrame(()=>{
      if(!sheet.open)return;
      resize();fit();
      if(progress<1){
        const start=performance.now(),duration=720;
        const tick=(now:number)=>{
          if(!sheet.open)return;
          progress=clamp((now-start)/duration,0,1);
          paint();
          if(progress<1)animation=requestAnimationFrame(tick);
        };
        animation=requestAnimationFrame(tick);
      }
    });
  }
}
