/**
 * Accessible chart exploration for real Disk Life metric series.
 * It never synthesizes samples: labels and values come from collectLife().
 */
import {el} from "../dom";
import type {DiskLifeMetric} from "../api";

export type ChartWindow={start:number;count:number};
const clamp=(n:number,min:number,max:number)=>Math.max(min,Math.min(max,n));
export const chartViewport=(total:number,start=0,count=40):ChartWindow=>{
  const n=Math.max(0,Math.floor(total));
  if(!n)return {start:0,count:0};
  const size=clamp(Math.floor(count),Math.min(n,2),n);
  return {start:clamp(Math.floor(start),0,Math.max(0,n-size)),count:size};
};
export function zoomViewport(total:number,current:ChartWindow,zoomIn:boolean,pivot=.5):ChartWindow{
  if(total<=1)return chartViewport(total,0,1);
  const size=clamp(Math.round(current.count*(zoomIn?.65:1.55)),2,total);
  const anchor=current.start+current.count*clamp(pivot,0,1);
  return chartViewport(total,Math.round(anchor-size*clamp(pivot,0,1)),size);
}
const fmt=(n:number)=>Number.isFinite(n)?n.toLocaleString("ru-RU",{maximumFractionDigits:2}):"—";
const makeSvg=(tag:string,attrs:Record<string,string|number>)=>{
  const element=document.createElementNS("http://www.w3.org/2000/svg",tag);
  for(const [key,value] of Object.entries(attrs))element.setAttribute(key,String(value));
  return element;
};

export function interactiveLifeChart(m:DiskLifeMetric):HTMLElement|null{
  if(!m.series?.length||m.kind==="dots"||m.kind==="swatches")return null;
  const values=m.series.filter(Number.isFinite);
  if(values.length!==m.series.length)return null;
  const total=values.length;
  let viewport=chartViewport(total,0,40),pointerIndex:number|null=null;
  const labelAt=(i:number)=>m.labels?.[i]??(m.kind==="hours"?i+":00":"№ "+(i+1));
  const panel=el("section",{cls:"dkl-explorer",attrs:{"aria-label":"Интерактивный график "+m.title}});
  const title=el("div",{cls:"dkl-explorer-title"},
    el("strong",{textContent:"Интерактивный график"}),
    el("small",{textContent:total+" реальных точек"}));
  const buttons=el("div",{cls:"dkl-explorer-actions"});
  const prev=el("button",{type:"button",cls:"btn sm",textContent:"←",attrs:{"aria-label":"Сместиться к предыдущим точкам"}});
  const plus=el("button",{type:"button",cls:"btn sm",textContent:"+",attrs:{"aria-label":"Приблизить график"}});
  const minus=el("button",{type:"button",cls:"btn sm",textContent:"−",attrs:{"aria-label":"Отдалить график"}});
  const next=el("button",{type:"button",cls:"btn sm",textContent:"→",attrs:{"aria-label":"Сместиться к следующим точкам"}});
  const all=el("button",{type:"button",cls:"btn sm",textContent:"Все"});
  buttons.append(prev,plus,minus,next,all);
  const graph=el("div",{cls:"dkl-explorer-plot"});
  const svg=makeSvg("svg",{viewBox:"0 0 800 270",preserveAspectRatio:"none",
    role:"img","aria-label":"График "+m.title+", управляйте стрелками и кнопками масштаба"});
  svg.setAttribute("tabindex","0");
  const tip=el("div",{cls:"dkl-explorer-tip",attrs:{role:"status"}});
  tip.hidden=true;
  graph.append(svg,tip);
  const range=el("small",{cls:"dkl-explorer-range",attrs:{"aria-live":"polite"}});
  const foot=el("p",{cls:"muted",textContent:"Наведите на точку для значения. Колесо и кнопки меняют масштаб, перетаскивание — область просмотра. Стрелки работают с клавиатуры."});
  panel.append(title,buttons,graph,range,foot);
  const W=800,H=270,left=52,right=18,top=20,bottom=40;
  const plotWidth=W-left-right,plotHeight=H-top-bottom;
  const bar=m.kind==="spark"||m.kind==="hours"||m.kind==="calendar"||m.kind==="split";
  const show=(index:number,mouseX?:number,mouseY?:number)=>{
    pointerIndex=index;
    if(index<0||index>=total){tip.hidden=true;return;}
    tip.textContent=labelAt(index)+": "+fmt(values[index]!);
    tip.hidden=false;
    const width=graph.clientWidth;
    tip.style.left=clamp(mouseX??width/2,8,Math.max(8,width-200))+"px";
    tip.style.top=clamp((mouseY??35)-38,4,200)+"px";
  };
  const render=()=>{
    viewport=chartViewport(total,viewport.start,viewport.count);
    const slice=values.slice(viewport.start,viewport.start+viewport.count);
    const minimum=Math.min(0,...slice),maximum=Math.max(1,...slice);
    const span=Math.max(1e-9,maximum-minimum),n=slice.length;
    const x=(i:number)=>left+(n===1?.5:i/(n-1))*plotWidth;
    const y=(value:number)=>top+(maximum-value)/span*plotHeight;
    const zero=y(0);
    const children:Element[]=[];
    for(let tick=0;tick<=4;tick++){
      const value=minimum+span*tick/4,yy=y(value);
      children.push(makeSvg("line",{x1:left,x2:W-right,y1:yy,y2:yy,class:"dkl-explorer-grid"}));
      const label=makeSvg("text",{x:left-10,y:yy+4,"text-anchor":"end",class:"dkl-explorer-axis"});
      label.textContent=fmt(value);children.push(label);
    }
    for(let tick=0;tick<Math.min(5,n);tick++){
      const idx=Math.round((n-1)*tick/Math.max(1,Math.min(4,n-1)));
      const label=makeSvg("text",{x:x(idx),y:H-10,"text-anchor":"middle",class:"dkl-explorer-axis"});
      label.textContent=labelAt(viewport.start+idx).slice(0,15);
      children.push(label);
    }
    const coords=slice.map((value,i)=>[x(i),y(value)] as const);
    if(bar){
      const width=Math.max(2,Math.min(34,plotWidth/Math.max(2,n)*.68));
      for(let i=0;i<n;i++){
        const px=coords[i]![0],py=coords[i]![1],h=Math.abs(zero-py);
        const rect=makeSvg("rect",{x:px-width/2,y:Math.min(py,zero),
          width,height:Math.max(1,h),rx:2,class:"dkl-explorer-bar"});
        const current=viewport.start+i;
        rect.addEventListener("pointerenter",event=>show(current,event.offsetX,event.offsetY));
        children.push(rect);
      }
    }else{
      const path=makeSvg("path",{d:coords.map(([xx,yy],i)=>(i?"L":"M")+xx.toFixed(2)+" "+yy.toFixed(2)).join(" "),
        class:"dkl-explorer-line"});
      children.push(path);
      if(n<=70)for(let i=0;i<n;i++){
        const [px,py]=coords[i]!,current=viewport.start+i;
        const dot=makeSvg("circle",{cx:px,cy:py,r:4,class:"dkl-explorer-dot"});
        dot.addEventListener("pointerenter",event=>show(current,event.offsetX,event.offsetY));
        children.push(dot);
      }
    }
    svg.replaceChildren(...children);
    prev.disabled=viewport.start===0;
    next.disabled=viewport.start+viewport.count>=total;
    plus.disabled=viewport.count<=Math.min(2,total);
    minus.disabled=viewport.count>=total;
    range.textContent=labelAt(viewport.start)+" — "+labelAt(viewport.start+viewport.count-1)+
      " · показано "+viewport.count+" из "+total;
    tip.hidden=true;
  };
  const move=(step:number)=>{
    viewport=chartViewport(total,viewport.start+step,viewport.count);render();
  };
  const zoom=(inside:boolean,pivot=.5)=>{
    viewport=zoomViewport(total,viewport,inside,pivot);render();
  };
  prev.addEventListener("click",()=>move(-Math.max(1,Math.floor(viewport.count/3))));
  next.addEventListener("click",()=>move(Math.max(1,Math.floor(viewport.count/3))));
  plus.addEventListener("click",()=>zoom(true));
  minus.addEventListener("click",()=>zoom(false));
  all.addEventListener("click",()=>{viewport=chartViewport(total,0,total);render();});
  svg.addEventListener("pointermove",event=>{
    const rect=svg.getBoundingClientRect();
    const location=(event.clientX-rect.left)/Math.max(1,rect.width)*W;
    const position=clamp((location-left)/plotWidth,0,1);
    const index=viewport.start+Math.round(position*Math.max(0,viewport.count-1));
    show(index,event.clientX-rect.left,event.clientY-rect.top);
  });
  svg.addEventListener("pointerleave",()=>{tip.hidden=true;pointerIndex=null;});
  svg.addEventListener("wheel",event=>{
    event.preventDefault();
    const rect=svg.getBoundingClientRect();
    const pivot=clamp((event.clientX-rect.left)/rect.width,0,1);
    zoom(event.deltaY<0,pivot);
  },{passive:false});
  let pointerStartX=0,windowStart=0,dragging=false;
  svg.addEventListener("pointerdown",event=>{
    if(event.button!==0)return;
    dragging=true;pointerStartX=event.clientX;windowStart=viewport.start;
    svg.setPointerCapture(event.pointerId);
  });
  svg.addEventListener("pointermove",event=>{
    if(!dragging)return;
    const w=svg.getBoundingClientRect().width||1;
    viewport=chartViewport(total,windowStart+
      Math.round((pointerStartX-event.clientX)/w*viewport.count),viewport.count);
    render();
  });
  svg.addEventListener("pointerup",()=>{dragging=false;});
  svg.addEventListener("pointercancel",()=>{dragging=false;});
  svg.addEventListener("keydown",event=>{
    if(event.key==="ArrowLeft"){move(-1);event.preventDefault();}
    else if(event.key==="ArrowRight"){move(1);event.preventDefault();}
    else if(event.key==="+"||event.key==="="){zoom(true);event.preventDefault();}
    else if(event.key==="-"){zoom(false);event.preventDefault();}
    else if(event.key==="Home"){viewport=chartViewport(total,0,viewport.count);render();event.preventDefault();}
    else if(event.key==="End"){viewport=chartViewport(total,total-viewport.count,viewport.count);render();event.preventDefault();}
  });
  render();
  return panel;
}
