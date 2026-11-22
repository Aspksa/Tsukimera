import {el,iconButton,copyText} from "../dom";
import {btn} from "./kit";
import {openSheet} from "./sheet";
import {showToast} from "../toast";
import {kindOf,human} from "./disk-model";
import type {DiskFile} from "../api";

export type SmartRule={id:string;name:string;field:"name"|"folder"|"extension"|"tag";pattern:string};
const SMART_KEY="tsukimera.disk.smart.v1";
const COLUMN_KEY="tsukimera.disk.columns.v1";
export type TableColumns={size:boolean;date:boolean;folder:boolean};
export function readColumns():TableColumns{
  let value:Partial<TableColumns>={};
  try{value=JSON.parse(localStorage.getItem(COLUMN_KEY)||"{}");}catch{}
  return {size:value?.size!==false,date:value?.date!==false,folder:value?.folder===true};
}
export function writeColumns(columns:TableColumns){localStorage.setItem(COLUMN_KEY,JSON.stringify(columns));}
export function readSmartRules():SmartRule[]{
  try{
    const rows=JSON.parse(localStorage.getItem(SMART_KEY)||"[]");
    if(!Array.isArray(rows))return [];
    return rows.filter(r=>r&&typeof r.id==="string"&&typeof r.name==="string"&&typeof r.pattern==="string"&&
      r.name.length<=40&&r.pattern.length<=80&&["name","folder","extension","tag"].includes(r.field)).slice(0,30);
  }catch{return [];}
}
function saveSmartRules(rows:SmartRule[]){localStorage.setItem(SMART_KEY,JSON.stringify(rows));}
export function matchesSmartRule(file:DiskFile,rule:SmartRule):boolean{
  const hay=rule.field==="name"?file.name:rule.field==="folder"?file.folder:
    rule.field==="extension"?(file.name.split(".").pop()||""):((file.tags||[]).join(" "));
  return hay.toLocaleLowerCase("ru-RU").includes(rule.pattern.trim().toLocaleLowerCase("ru-RU"));
}
export type RenamePlan={id:string;folder:string;from:string;to:string;valid:boolean;why:string};
export function renamePlan(files:DiskFile[],all:DiskFile[],template:string,start=1):RenamePlan[]{
  if(!Number.isSafeInteger(start)||start<0||start>999999)return [];
  const occupied=new Set(all.filter(x=>!files.some(y=>y.id===x.id)).map(x=>x.folder.toLocaleLowerCase()+"/"+x.name.toLocaleLowerCase()));
  return files.map((file,i)=>{
    const index=file.name.lastIndexOf("."),base=index>0?file.name.slice(0,index):file.name;
    const ext=index>0?file.name.slice(index+1):"";
    let name=template.replaceAll("{name}",base).replaceAll("{ext}",ext).replaceAll("{n}",String(start+i).padStart(2,"0"));
    name=name.replace(/\.$/,"").trim();
    let why="";
    if(!name||name.length>180||name==="."||name===".."||/[\\\/\x00-\x1f]/.test(name))why="Недопустимое имя";
    else if(name===file.name)why="Без изменений";
    const key=file.folder.toLocaleLowerCase()+"/"+name.toLocaleLowerCase();
    if(!why&&occupied.has(key))why="Конфликт имён";
    if(!why)occupied.add(key);
    return {id:file.id,folder:file.folder,from:file.name,to:name,valid:!why,why};
  });
}
export function animateChange(action:()=>void){
  const supported=typeof document.startViewTransition==="function"&&
    !(typeof matchMedia==="function"&&matchMedia("(prefers-reduced-motion: reduce)").matches);
  if(supported)document.startViewTransition(action);else action();
}
export function openColumnSettings(current:TableColumns,onSave:(next:TableColumns)=>void){
  const wrapper=el("div",{cls:"dkx-stack"});
  const heading=el("p",{textContent:"Выберите дополнительные колонки режима «Таблица». Настройки останутся в этом браузере."});
  wrapper.append(heading);
  const inputs=new Map<keyof TableColumns,HTMLInputElement>();
  for(const [key,label] of [["size","Размер"],["date","Дата загрузки"],["folder","Папка"]] as const){
    const input=el("input",{type:"checkbox",checked:current[key]});
    inputs.set(key,input);
    wrapper.append(el("label",{cls:"dkx-check"},input,label));
  }
  const sheet=openSheet({title:"Колонки таблицы",icon:"table",content:wrapper});
  wrapper.append(btn("Сохранить",()=>{
    const next={size:inputs.get("size")!.checked,date:inputs.get("date")!.checked,folder:inputs.get("folder")!.checked};
    writeColumns(next);onSave(next);sheet.close();
  },{primary:true}));
}
export function openSmartManager({onApply,onChanged}:{onApply:(rule:SmartRule)=>void;onChanged:()=>void}){
  const panel=el("div",{cls:"dkx-stack"});
  const render=()=>{
    panel.replaceChildren(el("p",{cls:"muted",textContent:"Умные папки — сохранённые фильтры. Они не перемещают и не изменяют файлы."}));
    for(const rule of readSmartRules()){
      const row=el("div",{cls:"dkx-smart-row"},el("strong",{textContent:rule.name}),
        el("span",{cls:"muted",textContent:rule.field+" · "+rule.pattern}));
      row.append(btn("Открыть",()=>{sheet.close();onApply(rule);},{small:true}),
        btn("Удалить",()=>{
          saveSmartRules(readSmartRules().filter(x=>x.id!==rule.id));
          onChanged();render();
        },{small:true,danger:true}));
      panel.append(row);
    }
    if(readSmartRules().length>=30)return;
    const name=el("input",{type:"text",maxLength:40,placeholder:"Название умной папки",attrs:{"aria-label":"Имя умной папки"}});
    const match=el("input",{type:"text",maxLength:80,placeholder:"Содержит текст…",attrs:{"aria-label":"Условие"}}); 
    const field=el("select",{attrs:{"aria-label":"Искать в"}},
      ...([["name","Название"],["folder","Папка"],["extension","Расширение"],["tag","Метки"]] as const)
        .map(([id,label])=>el("option",{value:id,textContent:label})));
    const row=el("div",{cls:"dkx-stack"},name,field,match);
    row.append(btn("Добавить умную папку",()=>{
      const n=name.value.trim(),p=match.value.trim();
      if(!n||!p){showToast("Введите название и условие");return;}
      const rules=readSmartRules();
      if(rules.some(r=>r.name.toLocaleLowerCase()===n.toLocaleLowerCase())){showToast("Такая папка уже существует");return;}
      rules.push({id:crypto.randomUUID(),name:n,field:field.value as SmartRule["field"],pattern:p});
      saveSmartRules(rules);onChanged();render();
      showToast("Умная папка добавлена");
    },{primary:true}));
    panel.append(row);
  };
  const sheet=openSheet({title:"Умные папки",icon:"folder",content:panel});
  render();
}
export function openDiskMap(files:DiskFile[],onOpen:(folder:string)=>void){
  const groups=new Map<string,number>();
  for(const file of files) {
    const root=file.folder.split("/")[0]||"Корень";
    groups.set(root,(groups.get(root)||0)+file.size);
  }
  const sorted=[...groups].sort((a,b)=>b[1]-a[1]);
  const total=files.reduce((n,f)=>n+f.size,0);
  const panel=el("div",{cls:"dkx-stack"});
  panel.append(el("p",{cls:"muted",textContent:"Распределение места внутри Tsukimera. Это размеры сохранённых файлов, а не свободное место всего SSD."}),
    el("strong",{textContent:"Файлов: "+files.length+" · "+human(total)}));
  if(!sorted.length)panel.append(el("p",{textContent:"Диск пока пуст."}));
  for(const [folder,bytes] of sorted.slice(0,30)){
    const percent=total?Math.round(bytes/total*100):0;
    const meter=el("span",{cls:"dkx-map-fill"});
    meter.style.width=Math.max(.5,percent)+"%";
    const b=btn(folder+" · "+human(bytes)+" · "+percent+"%",()=>{
      sheet.close();onOpen(folder==="Корень"?"":folder);
    },{});
    b.classList.add("dkx-map-row");
    b.append(el("span",{cls:"dkx-map-track"},meter));panel.append(b);
  }
  const sheet=openSheet({title:"Карта пространства",icon:"folder",content:panel});
}
export function openBatchRename(files:DiskFile[],all:DiskFile[],onApply:(plan:RenamePlan[])=>Promise<void>){
  const panel=el("div",{cls:"dkx-stack"});
  panel.append(el("p",{cls:"muted",textContent:"Шаблон: {name} — имя без расширения; {ext} — расширение; {n} — номер. Сначала проверьте результат."}));
  const template=el("input",{type:"text",value:"{name}_{n}.{ext}",maxLength:180,attrs:{"aria-label":"Шаблон переименования"}});
  const start=el("input",{type:"number",min:0,max:999999,value:"1",attrs:{"aria-label":"Первый номер"}});
  const preview=el("div",{cls:"dkx-renames"});
  const controls=el("div",{cls:"dkx-actions"});
  const save=btn("Переименовать",async()=>{
    const rows=renamePlan(files,all,template.value,Number(start.value));
    if(rows.some(x=>!x.valid)){showToast("Исправьте ошибки в предварительном просмотре");return;}
    save.disabled=true;
    try{await onApply(rows);sheet.close();}
    catch(error){showToast(error instanceof Error?error.message:"Ошибка переименования");save.disabled=false;}
  },{primary:true});
  controls.append(save);
  const refresh=()=>{
    const rows=renamePlan(files,all,template.value,Number(start.value));
    preview.replaceChildren(...rows.slice(0,150).map(r=>el("div",{cls:"dkx-rename"+(!r.valid?" invalid":"")},
      el("span",{textContent:r.from}),el("span",{textContent:"→"}),el("span",{textContent:r.to||"—"}),
      el("small",{textContent:r.why}))));
    if(rows.length>150)preview.append(el("p",{cls:"muted",textContent:"Показаны первые 150 из "+rows.length}));
    save.disabled=!rows.length||rows.some(r=>!r.valid);
  };
  for(const input of [template,start])input.addEventListener("input",refresh);
  panel.append(template,start,preview,controls);
  const sheet=openSheet({title:"Массовое переименование · "+files.length,icon:"edit",content:panel});
  refresh();
}
export function openDiskCommands(items:{label:string;detail?:string;run:()=>void}[]){
  const field=el("input",{type:"search",cls:"mem-input",placeholder:"Команда, папка или файл",attrs:{"aria-label":"Поиск команд Диска"}});
  const list=el("div",{cls:"dkx-stack"});
  const panel=el("div",{cls:"dkx-stack"},field,list);
  const sheet=openSheet({title:"Команды Диска",icon:"search",content:panel});
  const update=()=>{
    const q=field.value.trim().toLocaleLowerCase();
    const shown=items.filter(it=>!q||(it.label+" "+(it.detail||"")).toLocaleLowerCase().includes(q)).slice(0,80);
    list.replaceChildren(...shown.map(item=>{
      const row=btn(item.label,()=>{sheet.close();item.run();},{});
      if(item.detail)row.append(el("small",{cls:"muted",textContent:item.detail}));
      row.classList.add("dkx-command");
      return row;
    }));
    if(!shown.length)list.append(el("p",{textContent:"Ничего не найдено"}));
  };
  field.addEventListener("input",update);
  field.addEventListener("keydown",e=>{
    if(e.key==="Enter"){e.preventDefault();list.querySelector<HTMLButtonElement>("button")?.click();}
  });
  update();
  requestAnimationFrame(()=>field.focus());
}
export function fileDeepLink(id:string){
  return location.origin+location.pathname+"#/disk/"+encodeURIComponent(id);
}
export async function copyDiskLink(file:DiskFile){
  if(await copyText(fileDeepLink(file.id)))showToast("Ссылка на файл скопирована. Она открывается в этой Tsukimera на локальном компьютере.");
  else showToast("Не удалось скопировать ссылку");
}
