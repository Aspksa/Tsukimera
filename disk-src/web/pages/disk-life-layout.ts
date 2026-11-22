import type { DiskLife, DiskLifeMetric } from "../api";

/** The original fifteen JUUNIBI groups are preserved verbatim.
 * These five headings change navigation only, never the server data or counting.
 */
export const LIFE_AREAS = [
  {id:"files",title:"Файлы",groups:["core","kinds","folders","marks"]},
  {id:"activity",title:"Активность",groups:["pulse","time","moves","versions"]},
  {id:"content",title:"Содержимое",groups:["words","style","inside","media"]},
  {id:"relations",title:"Связи и рекорды",groups:["links","fun"]},
  {id:"health",title:"Состояние",groups:["health"]},
] as const;

export function areaForGroup(group:string):string {
  return LIFE_AREAS.find(area=>(area.groups as readonly string[]).includes(group))?.id??LIFE_AREAS[0].id;
}
export function allGroupIds():string[]{
  return LIFE_AREAS.flatMap(area=>[...area.groups]);
}
/** For rendering only; the original 150 metrics are never filtered from API data. */
export function tileClass(m:DiskLifeMetric):"small"|"medium"|"large" {
  if(m.kind==="list"||m.kind==="calendar"||m.kind==="hours"||
     (m.value?.length??0)>36)return "large";
  if(m.kind==="line"||m.kind==="split"||m.kind==="spark"||
     (m.series?.length??0)>3)return "medium";
  return "small";
}
export function findMetric(data:DiskLife,id:string):DiskLifeMetric|undefined{
  return data.metrics.find(m=>m.id===id);
}
/** Sources reflect what the actual LocalDisk buildLife() computes, not citations
 * invented by the interface. A source file is linked only via the backend ID. */
export const LIFE_SOURCES:Record<string,string> = {
  core:"Каталог файлов Диска, объёмы текущих файлов, сохранённых редакций и корзины",
  kinds:"Типы и размеры файлов из локального каталога",
  folders:"Локальное дерево папок и журнал действий с ними",
  marks:"Избранное, метки и цвета, сохранённые в каталоге",
  pulse:"Временные метки загрузок файлов из локального каталога",
  time:"Даты загрузок, редакции и исторические записи локального Диска",
  moves:"Локальный журнал переименований и перемещений",
  versions:"Сохранённые версии файлов и время изменений",
  words:"Извлечённый текст поддерживаемых документов (не все PDF допускают извлечение)",
  style:"Статистический анализ извлечённого текста доступных документов",
  inside:"Текст и распознанные структуры поддерживаемых документов",
  media:"Заголовки изображений и структура доступных PDF",
  links:"Частотные слова прочитанных документов; похожесть по общим словам",
  fun:"Статистика, рассчитанная из локальных файлов, дат и размеров",
  health:"Каталог, корзина, дубликаты и результаты проверок файлов",
};
/** Exact methodology only where independently verified against server source.
 * All other figures show the original hint, without pretending it is a formula. */
export const VERIFIED_METHODS:Record<string,string> = {
  "core.files":"Количество активных файлов в каталоге, без корзины.",
  "core.used":"Размеры действующих файлов + сохранённых редакций + файлов в корзине.",
  "core.median":"Медиана размеров действующих файлов: половина меньше неё.",
  "core.average":"Суммарный размер действующих файлов / количество действующих файлов.",
  "core.biggest":"Максимальный размер среди действующих файлов.",
  "core.smallest":"Минимальный размер среди действующих файлов.",
  "pulse.activedays":"Количество разных дней с загрузками за последние 30 дней.",
  "style.richness":"Среднее отношение разных слов к объёму выборки первой тысячи слов по документам с доступным текстом.",
  "style.topwords":"Частоты слов суммируются по извлечённому тексту документов и сортируются по убыванию.",
  "style.longword":"Самое длинное извлечённое слово среди прочитанных документов.",
  "style.wordlen":"Число букв в словах / число слов, содержащих буквы.",
  "style.alphabet":"Доли кириллицы и латиницы относительно общего числа букв кириллицы и латиницы; цифры отдельно.",
  "style.questions":"Количество вопросительных знаков; частота = количество / число слов × 1000.",
  "style.exclaims":"Количество восклицательных знаков; частота = количество / число слов × 1000.",
  "style.longsent":"Максимальная длина извлечённого предложения в знаках.",
  "style.numbers":"Число числовых элементов; частота = количество / число слов × 1000.",
  "style.ellipses":"Количество многоточий в извлечённом тексте.",
  "links.pairs":"Пары прочитанных документов, имеющие не менее пяти общих слов и коэффициент Жаккара от 20%.",
};
export function methodology(m:DiskLifeMetric):{method:string;verified:boolean;source:string}{
  const exact=VERIFIED_METHODS[m.group+"."+m.id];
  return {method:exact||m.hint,verified:!!exact,source:LIFE_SOURCES[m.group]||"Локальные данные Диска"};
}
