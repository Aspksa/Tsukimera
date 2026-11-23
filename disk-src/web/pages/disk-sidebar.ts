/**
 * Disk left rail: bounded user preferences, folder ancestry and guarded moves.
 * Contains only presentation preferences; never touches Disk objects or SQLite schema.
 */
import {writePreference} from "../preferences";

export const SECTION_IDS=["favorites","recent","images","documents","large","trash"] as const;
export type SectionId=(typeof SECTION_IDS)[number];
export type SidebarPrefs={order:SectionId[];hidden:SectionId[];collapsed:boolean};
export const SIDEBAR_KEY="tsukimera.disk.sections.v1";
const set=new Set<string>(SECTION_IDS);

export function sanitizeSidebarPrefs(raw:unknown):SidebarPrefs{
  const source:Partial<SidebarPrefs>=raw&&typeof raw==="object"?raw as Partial<SidebarPrefs>:{};
  const order=Array.isArray(source.order)?source.order.filter((id):id is SectionId=>typeof id==="string"&&set.has(id)):[];
  const unique=[...new Set(order)];
  for(const id of SECTION_IDS)if(!unique.includes(id))unique.push(id);
  const hidden=Array.isArray(source.hidden)
    ?[...new Set(source.hidden.filter((id):id is SectionId=>typeof id==="string"&&set.has(id)))]:[];
  return {order:unique,hidden,collapsed:source.collapsed===true};
}
export function readSidebarPrefs():SidebarPrefs{
  try{return sanitizeSidebarPrefs(JSON.parse(localStorage.getItem(SIDEBAR_KEY)||"null"));}
  catch{return sanitizeSidebarPrefs(null);}
}
export function writeSidebarPrefs(value:SidebarPrefs):SidebarPrefs{
  const safe=sanitizeSidebarPrefs(value);
  writePreference(SIDEBAR_KEY,JSON.stringify(safe));
  return safe;
}
export function reorderSections(order:readonly SectionId[],source:SectionId,dest:SectionId):SectionId[]{
  const safe=sanitizeSidebarPrefs({order:[...order]}).order;
  if(source===dest||!safe.includes(source)||!safe.includes(dest))return safe;
  const next=safe.filter(id=>id!==source);
  next.splice(next.indexOf(dest),0,source);
  return next;
}
export function folderAncestors(path:string):string[]{
  if(!path)return [];
  const parts=path.split("/").filter(Boolean);
  return parts.map((_,i)=>parts.slice(0,i+1).join("/"));
}
export function safeFolderDrop(source:string,destination:string):{ok:boolean;reason:string}{
  if(!source)return {ok:false,reason:"Нельзя переместить корень Диска."};
  if(source===destination)return {ok:false,reason:"Папка уже находится здесь."};
  if(destination.startsWith(source+"/"))return {ok:false,reason:"Нельзя переместить папку внутрь самой себя."};
  const parent=source.includes("/")?source.slice(0,source.lastIndexOf("/")):"";
  if(parent===destination)return {ok:false,reason:"Папка уже находится в этой папке."};
  return {ok:true,reason:""};
}
