import {openLiveDiskMap} from "./disk-map";
import {writePreference} from "../preferences";
import {el,iconButton,copyText} from "../dom";
import {btn} from "./kit";
import {openSheet} from "./sheet";
import {showToast} from "../toast";
import {kindOf,human} from "./disk-model";
import type {DiskFile} from "../api";

export type SmartField="name"|"folder"|"extension"|"tag"|"size"|"date"|"favorite";
export type SmartOperator="contains"|"equals"|"min"|"max"|"before"|"after"|"is";
export type SmartCondition={field:SmartField;operator:SmartOperator;value:string};
/** Old rules with field/pattern are still accepted without modification. */
export type SmartRule={
  id:string;name:string;field?:SmartField;pattern?:string;
  mode?:"all"|"any";conditions?:SmartCondition[];
};
const SMART_KEY="tsukimera.disk.smart.v1";
const COLUMN_KEY="tsukimera.disk.columns.v1";
const smartFields:SmartField[]=["name","folder","extension","tag","size","date","favorite"];
const operators:Record<SmartField,SmartOperator[]>={
  name:["contains","equals"],folder:["contains","equals"],
  extension:["contains","equals"],tag:["contains","equals"],
  size:["min","max"],date:["before","after"],favorite:["is"],
};
export type TableColumns={size:boolean;date:boolean;folder:boolean};
export function readColumns():TableColumns{
  let value:Partial<TableColumns>={};
  try{value=JSON.parse(localStorage.getItem(COLUMN_KEY)||"{}");}catch{}
  return {size:value?.size!==false,date:value?.date!==false,folder:value?.folder===true};
}
export function writeColumns(columns:TableColumns){writePreference(COLUMN_KEY,JSON.stringify(columns));}
export function isConditionValid(c:unknown):c is SmartCondition{
  if(!c||typeof c!=="object")return false;
  const v=c as Partial<SmartCondition>;
  if(!smartFields.includes(v.field as SmartField)||typeof v.value!=="string"||v.value.length>80||
    !operators[v.field as SmartField]?.includes(v.operator as SmartOperator))return false;
  if(v.field==="size")return /^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/.test(v.value)&&Number(v.value)<=500000;
  if(v.field==="date")return /^\d{4}-\d{2}-\d{2}$/.test(v.value)&&
    !Number.isNaN(Date.parse(v.value+"T00:00:00Z"));
  if(v.field==="favorite")return ["yes","no"].includes(v.value);
  return !!v.value.trim();
}
export function readSmartRules():SmartRule[]{
  try{
    const rows=JSON.parse(localStorage.getItem(SMART_KEY)||"[]");
    if(!Array.isArray(rows))return [];
    return rows.filter(r=>r&&typeof r.id==="string"&&typeof r.name==="string"&&
      r.name.length>0&&r.name.length<=40&&
      ((typeof r.field==="string"&&smartFields.includes(r.field)&&
        typeof r.pattern==="string"&&r.pattern.length<=80)||
       (Array.isArray(r.conditions)&&r.conditions.length>=1&&r.conditions.length<=4&&
        r.conditions.every(isConditionValid))))
      .slice(0,30).map(r=>({
        id:r.id,name:r.name,
        ...(typeof r.field==="string"?{field:r.field,pattern:r.pattern}:{}),
        ...(Array.isArray(r.conditions)&&r.conditions.every(isConditionValid)
          ?{mode:r.mode==="any"?"any":"all",conditions:r.conditions}:{}),
      }));
  }catch{return [];}
}
function saveSmartRules(rows:SmartRule[]):boolean{
  const serialized=JSON.stringify(rows);
  if(serialized.length>15500){
    showToast("Достигнут предел хранения правил SQLite. Удалите ненужные правила.");return false;
  }
  writePreference(SMART_KEY,serialized);
  return true;
}
export function matchesSmartRule(file:DiskFile,rule:SmartRule):boolean{
  const conditions=rule.conditions?.length?rule.conditions:[
    {field:rule.field??"name",operator:"contains",value:rule.pattern??""} as SmartCondition];
  const check=(c:SmartCondition)=>{
    if(!isConditionValid(c))return false;
    if(c.field==="size"){
      const amount=Number(c.value)*1024*1024;
      return c.operator==="min"?file.size>=amount:file.size<=amount;
    }
    if(c.field==="date"){
      const day=file.uploadedAt.slice(0,10);
      return c.operator==="before"?day<=c.value:day>=c.value;
    }
    if(c.field==="favorite")return !!file.favorite===(c.value==="yes");
    const content=c.field==="name"?file.name:c.field==="folder"?file.folder:
      c.field==="extension"?(file.name.split(".").pop()||""):(file.tags||[]).join(" ");
    const left=content.toLocaleLowerCase("ru-RU");
    const right=c.value.trim().toLocaleLowerCase("ru-RU");
    return c.operator==="equals"?left===right:left.includes(right);
  };
  return rule.mode==="any"?conditions.some(check):conditions.every(check);
}
export type RenamePlan={id:string;folder:string;from:string;to:string;valid:boolean;why:string};
export function renamePlan(files:DiskFile[],all:DiskFile[],template:string,start=1):RenamePlan[]{
  if(!Number.isSafeInteger(start)||start<0||start>999999)return [];
  const selected=new Set(files.map(x=>x.id));
  const occupied=new Set(all.filter(x=>!selected.has(x.id)).map(x=>x.folder.toLocaleLowerCase()+"/"+x.name.toLocaleLowerCase()));
  const originalNames=new Map(all.map(x=>[x.folder.toLocaleLowerCase()+"/"+x.name.toLocaleLowerCase(),x.id]));
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
    if(!why&&originalNames.has(key)&&originalNames.get(key)!==file.id)why="Имя пока занято другим файлом";
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
  const heading=el("p",{textContent:"Выберите дополнительные колонки режима «Таблица». Настройки сохраняются в локальной базе SQLite."});
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
  const descriptions:Record<SmartField,string>={
    name:"Название",folder:"Папка",extension:"Расширение",tag:"Метка",
    size:"Размер (МБ)",date:"Дата загрузки",favorite:"Избранное",
  };
  const opText:Record<SmartOperator,string>={
    contains:"Содержит",equals:"Равно",min:"Не меньше",max:"Не больше",
    before:"До даты включительно",after:"Начиная с даты",is:"Да / нет",
  };
  let conditions:SmartCondition[]=[{field:"name",operator:"contains",value:""}];
  let matchMode:"all"|"any"="all";
  const conditionsBox=el("div",{cls:"dkx-smart-conditions"});
  const drawConditions=()=>{
    conditionsBox.replaceChildren();
    for(const [i,c] of conditions.entries()){
      const field=el("select",{attrs:{"aria-label":"Поле условия "+(i+1)}},
        ...smartFields.map(name=>el("option",{value:name,textContent:descriptions[name]})));
      field.value=c.field;
      const op=el("select",{attrs:{"aria-label":"Операция "+(i+1)}},
        ...operators[c.field].map(name=>el("option",{value:name,textContent:opText[name]})));
      op.value=c.operator;
      const val=c.field==="favorite"
        ?el("select",{attrs:{"aria-label":"Значение "+(i+1)}},
          el("option",{value:"yes",textContent:"Да"}),
          el("option",{value:"no",textContent:"Нет"}))
        :el("input",{type:c.field==="date"?"date":c.field==="size"?"number":"text",
          maxLength:80,placeholder:c.field==="size"?"Например: 5":c.field==="extension"?"pdf, txt…":"Текст условия",
          attrs:{"aria-label":"Значение "+(i+1)},...(c.field==="size"?{min:0,max:500000,step:0.01}:{})});
      val.value=c.value;
      field.addEventListener("change",()=>{
        const next=field.value as SmartField;
        conditions[i]={field:next,operator:operators[next][0]!,value:next==="favorite"?"yes":""};
        drawConditions();
      });
      op.addEventListener("change",()=>{c.operator=op.value as SmartOperator;});
      val.addEventListener("input",()=>{c.value=val.value;});
      val.addEventListener("change",()=>{c.value=val.value;});
      const remove=btn("Убрать",()=>{
        if(conditions.length<=1){showToast("Нужно хотя бы одно условие");return;}
        conditions.splice(i,1);drawConditions();
      },{small:true});
      const row=el("div",{cls:"dkx-smart-condition"},field,op,val,remove);
      conditionsBox.append(row);
    }
  };
  const render=()=>{
    panel.replaceChildren(el("p",{cls:"muted",textContent:"Умные папки — сохранённые фильтры, они не двигают и не изменяют оригиналы. Можно задать до четырёх условий И/ИЛИ."}));
    for(const rule of readSmartRules()){
      const count=rule.conditions?.length??1;
      const row=el("div",{cls:"dkx-smart-row"},el("strong",{textContent:rule.name}),
        el("span",{cls:"muted",textContent:count+" условий · "+(rule.mode==="any"?"любое":"все")}));
      row.append(btn("Открыть",()=>{sheet.close();onApply(rule);},{small:true}),
        btn("Удалить",()=>{
          if(!saveSmartRules(readSmartRules().filter(x=>x.id!==rule.id)))return;
          onChanged();render();
        },{small:true,danger:true}));
      panel.append(row);
    }
    if(readSmartRules().length>=30)return;
    const name=el("input",{type:"text",maxLength:40,
      placeholder:"Название умной папки",attrs:{"aria-label":"Имя умной папки"}});
    const mode=el("select",{attrs:{"aria-label":"Как объединять условия"}},
      el("option",{value:"all",textContent:"Все условия (И)"}),
      el("option",{value:"any",textContent:"Любое условие (ИЛИ)"}));
    mode.value=matchMode;
    mode.addEventListener("change",()=>{matchMode=mode.value as "all"|"any";});
    drawConditions();
    const add=btn("+ Условие",()=>{
      if(conditions.length>=4){showToast("Не больше четырёх условий");return;}
      conditions.push({field:"name",operator:"contains",value:""});
      drawConditions();
    },{small:true});
    const row=el("div",{cls:"dkx-stack"},name,mode,conditionsBox,add);
    row.append(btn("Добавить умную папку",()=>{
      const n=name.value.trim();
      if(!n||!conditions.every(isConditionValid)){showToast("Укажите название и заполните условия");return;}
      const rules=readSmartRules();
      if(rules.some(r=>r.name.toLocaleLowerCase("ru-RU")===n.toLocaleLowerCase("ru-RU"))){
        showToast("Такая папка уже существует");return;
      }
      const saved={id:crypto.randomUUID(),name:n,mode:matchMode,
        conditions:conditions.map(c=>({...c}))};
      rules.push(saved);
      if(!saveSmartRules(rules))return;
      conditions=[{field:"name",operator:"contains",value:""}];matchMode="all";
      onChanged();render();showToast("Умная папка добавлена");
    },{primary:true}));
    panel.append(row);
  };
  const sheet=openSheet({title:"Умные папки 3.0",icon:"folder",content:panel});
  render();
}
/** Keep the existing entry point while the map becomes an interactive Canvas view. */
export function openDiskMap(files:DiskFile[],folders:string[],
  onOpen:(folder:string)=>void,onFile?:(id:string)=>void){
  openLiveDiskMap(files,folders,onOpen,onFile);
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
