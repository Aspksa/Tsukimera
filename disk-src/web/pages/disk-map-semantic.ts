/**
 * Disk 14: source-backed text evidence; user-initiated only.
 * No new services, inference calls, persisted raw text or external libraries.
 */
import type {DiskFile} from "../api";
export type SemanticKind="topic"|"person"|"organization"|"date"|"project";
export type SemanticNode={id:string;kind:SemanticKind;name:string;count:number};
export type SemanticLink={source:string;target:string;kind:"lexical"|"entity"|"reference";weight:number;evidence:string;confidence:number};
export type SemanticRecord={id:string;name:string;preview:string;keywords:string[];people:string[];organizations:string[];dates:string[];projects:string[];references:string[]};
export type SemanticIndex={records:Record<string,SemanticRecord>;nodes:SemanticNode[];links:SemanticLink[];processed:number;unreadable:number;truncated:number};
const common=new Set(("и в на по с со к а но за из от до для или это что как не да те " +
 "the and for with from then this that have was are were will into your their " +
 "при без между после перед такой также если больше меньше все всех его ее " +
 "будет были было есть когда которые который которая которых может уже очень " +
 "документ документы файл файлы текст страница номер год годы дата").split(/\s+/));
const norm=(s:string)=>s.normalize("NFKC").toLocaleLowerCase("ru-RU").replace(/ё/g,"е");
const tokens=(s:string)=>norm(s).match(/[a-zа-я][a-zа-я0-9-]{3,}/g)?.filter(w=>!common.has(w))||[];
const unique=(v:string[],max=20)=>[...new Set(v.map(x=>x.trim()).filter(Boolean))].slice(0,max);
const id=(t:SemanticKind,s:string)=>t+":"+norm(s);
const fileId=(s:string)=>"file:"+s;
/** Person-like strings are candidates only; explicit quoted companies & projects. */
export function extractDocument(file:Pick<DiskFile,"id"|"name">,raw:string,names:readonly string[]):SemanticRecord{
 const text=raw.slice(0,24000);
 const counts=new Map<string,number>();
 for(const w of tokens(text))counts.set(w,(counts.get(w)||0)+1);
 const keywords=[...counts].filter(([w,n])=>n>=2&&w.length>=4)
  .sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0],"ru"))
  .slice(0,18).map(([w])=>w);
 const organizations=unique([...text.matchAll(/\b(?:ООО|АО|ПАО|ОАО|ЗАО|ИП)\s*[«"']([^»"'\n]{3,70})[»"']/g)]
  .map(m=>m[1]||""),12);
 const dates=unique([...text.matchAll(/\b(?:0?[1-9]|[12]\d|3[01])[./-](?:0?[1-9]|1[0-2])[./-](?:19|20)\d{2}\b/g)]
  .map(m=>m[0]),12);
 const people=unique([...text.matchAll(/\b([А-ЯЁ][а-яё]{2,}\s+[А-ЯЁ][а-яё]{2,}(?:\s+[А-ЯЁ][а-яё]{2,})?)\b/g)]
  .map(m=>m[1]||"").filter(x=>!["Российская Федерация","Санкт Петербург"].includes(x)),12);
 const projects=unique([...text.matchAll(/\b(?:проект|project)\s*[«"']([^»"'\n]{3,64})[»"']/gi)]
  .map(m=>m[1]||""),12);
 const lower=norm(text);
 const references=unique(names.filter(n=>n.length>=8&&n!==file.name&&lower.includes(norm(n))),12);
 return {id:file.id,name:file.name,preview:text.replace(/\s+/g," ").slice(0,210),
   keywords,people,organizations,dates,projects,references};
}
/** Uses shared explicit words, date/people/org mentions and exact filenames.
 * There is no unsupported claim of LLM semantic understanding.
 */
export function semanticFromRecords(records:readonly SemanticRecord[]):SemanticIndex{
 const docs=records.slice(0,36);
 const byId=Object.fromEntries(docs.map(r=>[r.id,r])) as Record<string,SemanticRecord>;
 const nodes:SemanticNode[]=[],links:SemanticLink[]=[],seen=new Set<string>();
 const edge=(source:string,target:string,kind:SemanticLink["kind"],weight:number,evidence:string,confidence:number)=>{
  if(source===target||links.length>=320)return;
  const sig=kind+"|"+[source,target].sort().join("|");
  if(seen.has(sig))return;seen.add(sig);links.push({source,target,kind,weight,evidence,confidence});
 };
 const dimensions:[SemanticKind,keyof SemanticRecord,string][]=[
  ["topic","keywords","Общее слово"],
  ["person","people","Возможное упоминание имени"],
  ["organization","organizations","Упоминание организации"],
  ["date","dates","Совпадающая дата"],
  ["project","projects","Упоминание проекта"]
 ];
 for(const [kind,property,explain] of dimensions){
  const groups=new Map<string,{name:string;members:string[]}>();
  for(const rec of docs)for(const value of (rec[property] as string[]).slice(0,kind==="topic"?10:12)){
   const key=id(kind,value),entry=groups.get(key)||{name:value,members:[]};
   if(!entry.members.includes(rec.id))entry.members.push(rec.id);
   groups.set(key,entry);
  }
  for(const [name,group] of [...groups].filter(([,g])=>g.members.length>=2)
   .sort((a,b)=>b[1].members.length-a[1].members.length).slice(0,kind==="topic"?10:8)){
   nodes.push({id:name,kind,name:group.name,count:group.members.length});
   for(const member of group.members)edge(name,fileId(member),"entity",kind==="topic"?.45:.85,
    explain+": "+group.name,kind==="person"?.52:.89);
  }
 }
 for(let i=0;i<docs.length;i++)for(let j=i+1;j<docs.length;j++){
  const a=docs[i]!,b=docs[j]!;
  const left=new Set(a.keywords),right=new Set(b.keywords);
  const overlap=[...left].filter(w=>right.has(w));
  const score=overlap.length/Math.max(1,new Set([...left,...right]).size);
  if(overlap.length>=3&&score>=.30)
   edge(fileId(a.id),fileId(b.id),"lexical",score,
    "Общая лексика: "+overlap.slice(0,5).join(", "),Math.min(.82,score));
 }
 const nameMap=new Map<string,string[]>();
 for(const rec of docs){const k=norm(rec.name),ids=nameMap.get(k)||[];ids.push(rec.id);nameMap.set(k,ids);}
 for(const rec of docs)for(const name of rec.references){
  const targets=nameMap.get(norm(name))||[];
  if(targets.length===1&&targets[0]!==rec.id)edge(fileId(rec.id),fileId(targets[0]!),
   "reference",.96,"Прямое упоминание файла: "+name,.99);
 }
 return {records:byId,nodes,links,processed:docs.length,unreadable:0,truncated:0};
}
