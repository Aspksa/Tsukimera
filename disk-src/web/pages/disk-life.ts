import {writePreference} from "../preferences";
/**
 * Tsukimera · Жизнь Диска 4.0. All 150 original JUUNIBI metrics and their
 * 15 source groups stay intact; presentation is now a compact right-side
 * summary or an expanded full-width analytics canvas.
 */
import {api,type DiskLife,type DiskLifeMetric} from "../api";
import {el,icon,iconButton} from "../dom";
import {openSheet} from "./sheet";
import {lifeGlyph} from "./disk-life-icons";
import {barChart,miniChart,ringChart} from "./life-charts";
import {interactiveLifeChart} from "./life-interactive";
import {agoText} from "./project-life";
import {LIFE_AREAS,areaForGroup,methodology,tileClass,searchLifeMetrics,type LifeAvailability} from "./disk-life-layout";

const GROUP_KEY="juunibi.disk.life.group"; // existing saved-group preference
const HOURS_LABEL=["0","6","12","18","23"];
const prefersLessMotion=()=>typeof matchMedia==="function"&&matchMedia("(prefers-reduced-motion: reduce)").matches;
export const readyIn=(metrics:DiskLifeMetric[],group:string)=>metrics.filter(m=>m.group===group&&!m.empty).length;
const savedGroup=()=>{
  try{return localStorage.getItem(GROUP_KEY)??"";}catch{return "";}
};
const keepGroup=(id:string)=>{
  writePreference(GROUP_KEY,id);
};

function heat(series:number[]):HTMLElement{
  const max=Math.max(1,...series);
  return el("div",{cls:"life-heat dkl-heat",attrs:{"aria-hidden":"true"}},...series.map((v,i)=>{
    const dot=el("i",{title:String(v)});
    dot.style.setProperty("--a",v?String(.25+.75*v/max):"0");
    dot.style.setProperty("--d",String(i));return dot;
  }));
}
function chart(m:DiskLifeMetric):Element|null{
  if(m.empty)return null;
  if(m.kind==="hours"&&m.series)return el("div",{},
    barChart(m.series,m.series.map((_,h)=>h+":00"),"dkl-hours"),
    el("div",{cls:"life-axis"},...HOURS_LABEL.map(x=>el("span",{textContent:x}))));
  if(m.kind==="calendar"&&m.series)return heat(m.series);
  if(m.kind==="list")return m.list?.length?
    el("ul",{cls:"life-list"},...m.list.map(x=>el("li",{textContent:x}))):null;
  if(m.kind==="swatches"&&!m.list?.length)return null;
  if((m.kind==="spark"||m.kind==="line")&&m.series&&!m.series.some(Boolean))
    return el("div",{cls:"dkl-flat",textContent:"пока ровно"});
  return miniChart(m.kind,m.series,m.labels,m.list);
}
const BLANK_GLYPHS:[string,string][]=[
  ["kinds","#38bdf8"],["pulse","#22c55e"],["words","#6366f1"],
  ["links","#fb7185"],["media","#84cc16"],["fun","#ff6fa8"]
];

export function diskLifePanel(isEmpty:()=>boolean=()=>false):{
  root:HTMLElement;refresh:()=>void;reveal:()=>void
}{
  const root=el("section",{cls:"dkl dkl-compact",attrs:{id:"disk-life","aria-label":"Жизнь документов"}});
  let data:DiskLife|null=null,error="",loading=false,stale=true,visible=false,timer=0;
  let group=savedGroup(),expanded=false,showAll=false;
  let query="",availability:LifeAvailability="all";
  let chartObserver:IntersectionObserver|null=null;
  const body=el("div",{cls:"dkl-body"});
  const refreshBtn=iconButton("refresh","Пересчитать показатели",()=>void load(),"icon-btn dkl-refresh");
  const expandBtn=iconButton("maximize","Развернуть аналитику на всю ширину",()=>expand(!expanded),"icon-btn dkl-expand");
  const allBtn=el("button",{type:"button",cls:"dkl-all-toggle",hidden:true,
    attrs:{"aria-pressed":"false","aria-label":"Показать все 150 показателей"}}, "Все 150");
  allBtn.addEventListener("click",()=>{
    showAll=!showAll;query="";search.value="";render();
  });
  const status=el("small",{cls:"dkl-tally",textContent:"150 показателей · 15 разделов"});
  const heading=el("div",{cls:"dkl-toolbar"},
    el("div",{cls:"dkl-toolbar-text"},
      el("strong",{textContent:"Жизнь Диска"}),
      status),
    el("div",{cls:"dkl-toolbar-actions"},allBtn,refreshBtn,expandBtn));
  const search=el("input",{type:"search",cls:"dkl-search",attrs:{
    placeholder:"Найти показатель из 150…","aria-label":"Поиск по всем показателям Жизни Диска"}});
  const searchBox=el("div",{cls:"dkl-discover"},
    el("label",{cls:"dkl-search-label"},icon("search",17),search));
  const filters=el("div",{cls:"dkl-filters",attrs:{"aria-label":"Фильтр полноты показателей"}});
  const filterButtons:{value:LifeAvailability;button:HTMLButtonElement}[]=[];
  for(const [value,label] of [["all","Все"],["ready","С данными"],["empty","Без данных"]] as const){
    const button=el("button",{type:"button",cls:"dkl-filter",textContent:label,
      attrs:{"aria-pressed":String(value===availability)}});
    button.addEventListener("click",()=>{availability=value;render();});
    filterButtons.push({value,button});filters.append(button);
  }
  searchBox.append(filters);
  const coverage=el("p",{cls:"dkl-coverage"});
  searchBox.hidden=true;
  coverage.hidden=true;
  search.addEventListener("input",()=>{query=search.value;render();});
  root.append(heading,searchBox,coverage,body);

  function expand(value:boolean):void{
    expanded=value;
    if(!value)showAll=false;
    root.classList.toggle("dkl-expanded",value);
    root.classList.toggle("dkl-compact",!value);
    searchBox.hidden=!value;
    coverage.hidden=!value;
    root.closest(".disk-page")?.classList.toggle("dk-life-expanded",value);
    expandBtn.title=value?"Вернуться к файлам":"Развернуть аналитику на всю ширину";
    expandBtn.setAttribute("aria-label",expandBtn.title);
    expandBtn.replaceChildren(icon(value?"minimize":"maximize",18));
    render();
    if(value)root.scrollIntoView({block:"start",behavior:prefersLessMotion()?"auto":"smooth"});
    else document.querySelector<HTMLElement>(".dk-main")?.scrollIntoView({
      block:"nearest",behavior:prefersLessMotion()?"auto":"smooth"});
  }
  function navigate(id:string){
    if(!data?.groups.some(g=>g.id===id))return;
    group=id;keepGroup(id);
    showAll=false;
    query="";search.value="";
    render();
  }
  function openDetails(m:DiskLifeMetric){
    const meta=methodology(m);
    const info=el("div",{cls:"dkl-detail-sheet"});
    const label=(title:string,value:string)=>
      el("section",{cls:"dkl-detail-section"},
        el("strong",{textContent:title}),el("p",{textContent:value}));
    info.append(
      el("div",{cls:"dkl-detail-number",textContent:m.value}),
      label("Как рассчитывается",meta.method||"Способ подсчёта не описан"),
      !meta.verified?el("p",{cls:"dkl-detail-caveat",textContent:
        "Это описание из данных метрики. Отдельная точная формула не предоставлена."}):null,
      label("Источник данных",meta.source),
      label("Что означает",m.empty?"Пока недостаточно данных: "+m.hint:
        m.detail||m.hint||"Показатель вычислен локально по доступным данным."),
      label("Дата расчёта",data?new Date(data.generatedAt).toLocaleString("ru-RU"):"Неизвестно")
    );
    const explorer=interactiveLifeChart(m);
    if(explorer)info.append(explorer);
    if(m.list?.length){
      info.append(el("strong",{textContent:"Состав показателя"}),
        el("ul",{cls:"dkl-detail-list"},...m.list.slice(0,100).map(line=>el("li",{textContent:line}))));
    }
    if(m.labels?.length&&m.series?.length){
      info.append(el("strong",{textContent:"Точки графика"}),
        el("ol",{cls:"dkl-detail-list"},
          ...m.series.slice(0,90).map((v,i)=>
            el("li",{textContent:(m.labels?.[i]??"№ "+(i+1))+" — "+v}))));
    }
    if(m.sourceFileId&&!m.empty){
      const open=el("button",{type:"button",cls:"btn primary",
        textContent:"Открыть подтверждённый файл-источник"});
      open.addEventListener("click",()=>{
        sheet.close();
        expand(false);
        root.dispatchEvent(new CustomEvent("tsukimera:life-open-file",{
          bubbles:true,detail:{id:m.sourceFileId}
        }));
      });
      info.append(open);
    }else{
      info.append(el("p",{cls:"dkl-detail-caveat",textContent:
        "Это агрегированный показатель или ссылка на конкретный исходный файл в расчёте отсутствует."}));
    }
    const sheet=openSheet({title:m.title,icon:"book",sub:"Подробности показателя",content:info});
  }
  function flash(id:string){
    const tile=body.querySelector<HTMLElement>('.dkl-tile[data-id="'+CSS.escape(id)+'"]');
    if(!tile)return;
    tile.scrollIntoView({block:"nearest",behavior:prefersLessMotion()?"auto":"smooth"});
    tile.classList.add("flash");
    tile.focus({preventScroll:true});
  }
  function drawLazy(tile:HTMLElement,m:DiskLifeMetric){
    const placeholder=el("div",{cls:"dkl-chart",attrs:{"aria-label":"График показателя"}});
    tile.append(placeholder);
    const hydrate=()=>{
      const figure=chart(m);
      const ring=typeof m.ring==="number"&&!m.empty?ringChart(m.ring):null;
      placeholder.replaceChildren(...[figure,ring].filter((x):x is Element=>!!x));
      if(!figure&&!ring)placeholder.remove();
    };
    if(!chartObserver)hydrate();
    else{
      (placeholder as HTMLElement & {hydrate?:()=>void}).hydrate=hydrate;
      chartObserver.observe(placeholder);
    }
  }
  function makeTile(m:DiskLifeMetric,color:string,index:number,brief=false){
    const size=tileClass(m);
    const t=el("article",{cls:"dkl-tile dkl-tile-"+size+(m.empty?" is-empty":""),
      title:m.hint,attrs:{tabindex:"0",role:"button","data-id":m.id,
        "aria-label":m.title+": "+m.value+". Подробнее"}},
      el("div",{cls:"dkl-tile-top"},
        el("span",{cls:"dkl-ic"},lifeGlyph(m.icon,m.group,22)),
        el("div",{cls:"dkl-name"},el("strong",{textContent:m.title}),
          el("small",{textContent:m.hint}))),
      el("div",{cls:"dkl-value-row"},
        el("div",{cls:"dkl-value",textContent:m.value})),
      m.detail&&!m.empty&&!brief?el("p",{cls:"dkl-detail",textContent:m.detail}):null);
    t.style.setProperty("--g",color);
    t.style.setProperty("--i",String(index));
    t.addEventListener("click",()=>openDetails(m));
    t.addEventListener("keydown",event=>{
      if(event.key==="Enter"||event.key===" "){
        event.preventDefault();openDetails(m);
      }
    });
    if(!brief)drawLazy(t,m);
    return t;
  }
  function render(){
    chartObserver?.disconnect();
    chartObserver=null;
    refreshBtn.classList.toggle("spin",loading);
    refreshBtn.disabled=loading;
    allBtn.hidden=!expanded;
    allBtn.setAttribute("aria-pressed",String(showAll));
    allBtn.textContent=showAll?"Вернуться к разделам":"Все 150";
    for(const {value,button} of filterButtons)button.setAttribute("aria-pressed",String(availability===value));
    if(isEmpty()){
      body.replaceChildren(el("div",{cls:"dkl-blank"},
        el("span",{cls:"dkl-ic lg"},lifeGlyph("pulse","core",26)),
        el("div",{cls:"dkl-blank-text"},
          el("b",{textContent:"Жизнь документов начнётся с первого файла"}),
          el("small",{textContent:"150 показателей, 15 разделов: загрузите первый файл, чтобы открыть аналитику"})),
        el("div",{cls:"dkl-blank-glyphs",attrs:{"aria-hidden":"true"}},
          ...BLANK_GLYPHS.map(([name,color])=>{
            const glyph=el("span",{cls:"dkl-ic sm"},lifeGlyph(name,"core",18));
            glyph.style.setProperty("--g",color);return glyph;
          }))));
      return;
    }
    if(!data){
      body.replaceChildren(error?
        el("div",{cls:"life-empty dkl-empty"},
          el("span",{},icon("alert",26)),el("p",{textContent:error})):
        el("div",{cls:"dkl-skeleton",attrs:{"aria-label":"Считаю показатели"}},
          ...Array.from({length:6},()=>el("i"))));
      return;
    }
    const d=data;
    const a=d.analysis;
    coverage.textContent="Текст прочитан: "+a.read+" из "+a.documents+
      " учтённых документов · PDF-сканов: "+a.scans+
      " · Измерено изображений: "+a.measured+" из "+a.images+
      ". Анализ содержимого ограничен 500 документами и 3000 изображениями; OCR нет.";
    refreshBtn.title=["Пересчитать показатели","посчитано "+agoText(d.generatedAt),
      a.documents?"прочитано "+a.read+" из "+a.documents+" документов":"",
      a.images?"измерено "+a.measured+" из "+a.images+" изображений":""].filter(Boolean).join(" · ");
    status.textContent=d.metrics.length+" показателей · "+d.groups.length+" разделов";
    if(!d.groups.some(g=>g.id===group))group=d.groups[0]?.id??"core";
    const byId=new Map(d.metrics.map(m=>[m.id,m]));
    const highlights=el("div",{cls:"dkl-hl"},
      ...d.highlights.map(id=>byId.get(id))
        .filter((m):m is DiskLifeMetric=>!!m).map((m,i)=>{
          const g=d.groups.find(g=>g.id===m.group);
          const card=el("button",{type:"button",
            cls:"dkl-hl-card"+(m.empty?" is-empty":""),
            title:m.hint+" — открыть показатель"},
            el("span",{cls:"dkl-ic"},lifeGlyph(m.icon,m.group,21)),
            el("b",{textContent:m.value}),el("small",{textContent:m.title}));
          card.style.setProperty("--g",g?.color??"var(--brand)");
          card.style.setProperty("--i",String(i));
          card.addEventListener("click",()=>{
            group=m.group;keepGroup(group);
            if(!expanded)expand(true);else render();
            flash(m.id);
          });
          return card;
        }));
    const activeArea=areaForGroup(group);
    const areas=el("div",{cls:"dkl-areas",attrs:{
      role:"group","aria-label":"Направления аналитики"}},
      ...LIFE_AREAS.map(area=>{
        const present=area.groups.filter(id=>d.groups.some(g=>g.id===id));
        const b=el("button",{type:"button",
          cls:"dkl-area"+(area.id===activeArea?" selected":""),
          attrs:{"aria-pressed":String(area.id===activeArea)}},
          el("strong",{textContent:area.title}),
          el("small",{textContent:present.length+" раздел."}));
        b.addEventListener("click",()=>navigate(present[0]??group));
        return b;
      }));
    const itemsOfArea=LIFE_AREAS.find(a=>a.id===activeArea)?.groups??[];
    const tabs=el("div",{cls:"dkl-tabs",attrs:{"aria-label":"Разделы аналитики"}},
      ...itemsOfArea.map(id=>d.groups.find(g=>g.id===id))
        .filter((g):g is DiskLife["groups"][number]=>!!g).map(g=>{
          const ready=readyIn(d.metrics,g.id),total=d.metrics.filter(m=>m.group===g.id).length;
          const b=el("button",{type:"button",cls:"dkl-tab",
            title:g.note+" · с данными "+ready+" из "+total,
            attrs:{"aria-pressed":String(g.id===group)}},
            el("span",{cls:"dkl-ic"},lifeGlyph(g.icon,g.id,17)),
            el("span",{cls:"dkl-tab-name",textContent:g.title}),
            el("small",{cls:"dkl-tab-count",textContent:ready+"/"+total}));
          b.style.setProperty("--g",g.color);
          b.addEventListener("click",()=>navigate(g.id));
          return b;
        }));
    const g=d.groups.find(g=>g.id===group)!;
    const groupMetrics=d.metrics.filter(m=>m.group===group);
    const searching=expanded&&!!query.trim();
    const scoped=searching
      ?searchLifeMetrics(d.metrics,d.groups,query,availability)
      :showAll&&expanded?searchLifeMetrics(d.metrics,d.groups,"",availability)
      :searchLifeMetrics(groupMetrics,d.groups,"",availability);
    const shown=expanded?scoped:groupMetrics.slice(0,3);
    const groupHeader=el("div",{cls:"dkl-group-head"},
      el("span",{cls:"dkl-ic lg"},lifeGlyph(searching?"search":g.icon,g.id,24)),
      el("div",{cls:"dkl-group-text"},
        el("h3",{textContent:searching?"Поиск по всем разделам":showAll?"Все 150 показателей":g.title}),
        el("p",{textContent:searching?"Показатели из любых 15 разделов, исходные данные не изменяются":
          showAll?"15 разделов · все показатели в одной ленте, исходные расчёты без изменений":g.note})),
      el("small",{cls:"dkl-group-count",textContent:shown.length+" из "+((searching||showAll)?d.metrics.length:groupMetrics.length)}));
    groupHeader.style.setProperty("--g",g.color);
    if(expanded&&typeof IntersectionObserver==="function"){
      chartObserver=new IntersectionObserver(entries=>{
        for(const entry of entries){
          if(!entry.isIntersecting)continue;
          const node=entry.target as HTMLElement & {hydrate?:()=>void};
          chartObserver?.unobserve(node);
          node.hydrate?.();delete node.hydrate;
        }
      },{rootMargin:"220px"});
    }
    const grid=shown.length
      ?el("div",{cls:"dkl-grid"},...shown.map((m,i)=>{
        const origin=d.groups.find(source=>source.id===m.group);
        return makeTile(m,origin?.color??g.color,i,!expanded);
      }))
      :el("div",{cls:"dkl-blank dkl-no-results"},
        el("b",{textContent:"Показателей не найдено"}),
        el("small",{textContent:"Измените запрос или выберите фильтр «Все»."}));
    body.replaceChildren(highlights,areas,tabs,groupHeader,grid);
    if(!expanded){
      const more=el("button",{type:"button",cls:"dkl-show-all",
        textContent:"Открыть аналитику · все 150 показателей"});
      more.addEventListener("click",()=>expand(true));
      body.append(more);
    }
  }
  async function load(){
    if(loading)return;
    if(isEmpty()){render();return;}
    loading=true;stale=false;render();
    const response=await api.diskLife();
    loading=false;
    if(response.ok&&response.value.groups?.length){data=response.value;error="";}
    else error=data?"":"Не удалось посчитать: "+(response.ok?"пустой ответ":response.error.message);
    render();
  }
  const io=typeof IntersectionObserver==="function"?
    new IntersectionObserver(entries=>{
      visible=entries.some(e=>e.isIntersecting);
      if(visible&&stale)void load();
    },{rootMargin:"300px"}):null;
  if(io)io.observe(root);else visible=true;
  root.addEventListener("keydown",event=>{
    if(expanded&&event.key==="Escape"){
      event.stopPropagation();expand(false);expandBtn.focus();
    }
  });
  render();
  return {
    root,
    refresh:()=>{
      stale=true;clearTimeout(timer);
      if(isEmpty()){render();return;}
      if(visible)timer=window.setTimeout(()=>void load(),data?1200:0);
    },
    reveal:()=>{
      if(!expanded)expand(true);
      root.scrollIntoView({block:"start",behavior:prefersLessMotion()?"auto":"smooth"});
      if(stale)void load();
    }
  };
}
