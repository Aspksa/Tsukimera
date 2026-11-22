'use strict';
// UI structure, sections and visual language adapted from Aspksa/JUUNIBI.
// Tsukimera has an independent lightweight shell, not the JUUNIBI AI runtime.
const NAV = [
  {id:'chat',label:'Беседа',icon:'chat',group:'main'},
  {id:'tasks',label:'Дела',icon:'check',group:'main'},
  {id:'disk',label:'Диск',icon:'folder',group:'main'},
  {id:'brain',label:'Мозг',icon:'brain',group:'brain'},
  {id:'settings',label:'Настройки',icon:'settings',group:'system'}
];
const SECTIONS = [
  {id:'conn',label:'Подключение',icon:'cloud',hint:'Ключ API и соединение с Cloud.ru'},
  {id:'model',label:'Модель',icon:'spark',hint:'Основная и запасная модель, параметры ответа'},
  {id:'persona',label:'Инструкции',icon:'edit',hint:'О владельце и желаемом стиле общения'},
  {id:'memory',label:'Память',icon:'memory',hint:'Поиск, эмбеддинги, сводки'},
  {id:'tools',label:'Инструменты',icon:'puzzle',hint:'Интернет и разрешения на файлы'},
  {id:'quick',label:'Быстрые команды',icon:'plus',hint:'Личные шаблоны команд'},
  {id:'look',label:'Внешний вид',icon:'palette',hint:'Тема, цвет, скругления, масштаб'},
  {id:'chat',label:'Чат',icon:'chat',hint:'Плотность и отображение сообщений'},
  {id:'data',label:'Данные',icon:'archive',hint:'Экспорт и импорт локальных настроек'},
  {id:'about',label:'О программе',icon:'help',hint:'Tsukimera, JUUNIBI и сочетания клавиш'}
];
const ICONS = {
  chat:'M4 5h16v11H9l-5 4z',
  check:'M5 12l4 4L19 6',
  folder:'M3 6h6l2 2h10v11H3z',
  brain:'M3 6a3 3 0 0 1 6 0M15 6a3 3 0 0 1 6 0M9 18a3 3 0 0 1 6 0M7 8l4 7M17 8l-4 7M8 6h8',
  settings:'M4 7h9M17 7h3M4 17h3M11 17h9M15 4v6M9 14v6',
  cloud:'M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 9.5 4 4 0 0 1 17 18z',
  spark:'M12 3l2.2 6.3L21 12l-6.8 2.7L12 21l-2.2-6.3L3 12l6.8-2.7z',
  edit:'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  puzzle:'M9 4h4v2.5a1.5 1.5 0 1 0 3 0V4h4v5h-2.5a1.5 1.5 0 1 0 0 3H20v8h-5v-2.5a1.5 1.5 0 1 0-3 0V20H4v-5h2.5a1.5 1.5 0 1 0 0-3H4V4h5z',
  plus:'M12 5v14M5 12h14',
  palette:'M12 3a9 9 0 0 0-9 9c0 5 4 9 9 9h2c1.8 0 2.2-2.1 1-3.2-1-1-.8-2.8 1-2.8h2c4.7 0 5-12-6-12zM8 9h.01M12 7h.01M16 9h.01M8 14h.01',
  archive:'M3 4h18v5H3zM5 9v12h14V9M10 13h4',
  help:'M9.7 9a2.5 2.5 0 1 1 3.4 2.4c-1 .5-1.1 1.1-1.1 2.1M12 17h.01M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
  menu:'M4 6h16M4 12h16M4 18h16',
  search:'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.3-4.3',
  chevron:'M6 9l6 6 6-6',
  chevronLeft:'M15 6l-6 6 6 6',
  chevronRight:'M9 6l6 6-6 6',
  sun:'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM12 1v3M12 20v3M1 12h3M20 12h3',
  moon:'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z',
  x:'M6 6l12 12M18 6L6 18',
  more:'M5 12h.01M12 12h.01M19 12h.01',
  eye:'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  eyeOff:'M3 3l18 18M2 12s3.5-7 10-7a11 11 0 0 1 8 3.5M22 12s-3.5 7-10 7c-3.3 0-5.9-1.8-7.7-3.5',
  arrowUp:'M12 19V5M5 12l7-7 7 7',
  arrowDown:'M12 5v14M5 12l7 7 7-7',
  save:'M4 3h14l3 3v15H3V3zM7 3v7h10V3M7 21v-8h10v8',
  trash:'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3'
};
const IDS = NAV.map(item => item.id);
const KEY_NAV = 'tsukimera:nav:v1';
const KEY_UI = 'tsukimera:ui:v1';
const KEY_SETTINGS = 'tsukimera:settings:v1';
const KEY_NOTES = 'tsukimera:notes:v1';
const NOTE_DB_MARKER = 'tsukimera:notes:sqlite-instance:v1';
let noteDatabaseId = '';
const DISK_PREF_KEYS = [
  'tsukimera.disk.smart.v1','tsukimera.disk.columns.v1',
  'tsukimera.disk.layout.left.v1','tsukimera.disk.layout.right.v1',
  'tsukimera.disk.tiles.v1','tsukimera.disk.view','tsukimera.disk.sort',
  'tsukimera.disk.open','tsukimera.disk.tree','tsukimera.disk.life.group',
  'tsukimera.disk.mdRaw','juunibi.disk.view','juunibi.disk.sort',
  'juunibi.disk.open','juunibi.disk.tree','juunibi.disk.mdRaw',
  'juunibi.disk.life.group'
];
const SQLITE_PREF_KEYS=[KEY_NAV,KEY_UI,KEY_SETTINGS,...DISK_PREF_KEYS];
let prefsReady=false;
let preferenceQueue=Promise.resolve();
function savePrefChanges(changes){
  preferenceQueue=preferenceQueue.catch(()=>{}).then(async()=>{
    const response=await fetch('/api/preferences',{method:'PUT',
      headers:{'Content-Type':'application/json','X-Tsukimera-Request':'1'},
      body:JSON.stringify({changes})});
    if(!response.ok)throw Error((await response.json().catch(()=>({}))).error||'HTTP '+response.status);
    return true;
  });
  return preferenceQueue;
}
async function hydrateSqlitePrefs(){
  try{
    let response=await fetch('/api/preferences');
    if(!response.ok)throw Error('HTTP '+response.status);
    let result=await response.json();
    if(!result.initialized){
      const initial={};
      for(const key of SQLITE_PREF_KEYS){
        const value=localStorage.getItem(key);
        if(value!==null)initial[key]=value;
      }
      response=await fetch('/api/preferences/initialize',{
        method:'POST',headers:{'Content-Type':'application/json','X-Tsukimera-Request':'1'},
        body:JSON.stringify({preferences:initial})});
      result=await response.json();
      if(!response.ok)throw Error(result.error||'Не удалось перенести настройки');
    }
    // The database wins after the initial import. This ensures that opening
    // the same portable SSD in a new browser restores the same preferences.
    for(const key of SQLITE_PREF_KEYS){
      if(Object.hasOwn(result.preferences,key))localStorage.setItem(key,result.preferences[key]);
      else localStorage.removeItem(key);
    }
    menu=cleanMenu(readLocal(KEY_NAV,{collapsed:false,order:IDS,hidden:[]}));
    ui=cleanUi(readLocal(KEY_UI,DEFAULT_UI));
    sectionPrefs=readLocal(KEY_SETTINGS,{collapsed:[]});
    prefsReady=true;
  }catch(error){
    console.error('Tsukimera SQLite preferences:',error);
    toast('SQLite настройки недоступны. Пока используется локальная копия браузера.');
  }
}
const DEFAULT_CONFIG = {
  model:{primary:'',fallback:'',reasoning:false},
  instructions:{about:'',style:''},
  memory:{embeddings:false,summaries:false,suggestions:'off'},
  tools:{web:false,writeFiles:false},quickCommands:[]
};
const DEFAULT_UI = {theme:'dark',accent:'gold',radius:'normal',scale:'md',chatDensity:'comfortable',chatFont:'md'};
function readLocal(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v && typeof v === 'object' ? v : structuredClone(fallback); }
  catch { return structuredClone(fallback); }
}
function writeLocal(key, value) {
  const raw=JSON.stringify(value);
  try { localStorage.setItem(key,raw); }
  catch { toast('Браузер запретил локальное сохранение'); }
  if(prefsReady&&SQLITE_PREF_KEYS.includes(key)){
    void savePrefChanges({[key]:raw}).catch(error=>
      toast('Настройки не сохранены в SQLite: '+error.message));
  }
}
function cleanMenu(raw) {
  const order = Array.isArray(raw?.order) ? [...new Set(raw.order.filter(x => IDS.includes(x)))] : [];
  for (const id of IDS) if (!order.includes(id)) order.push(id);
  const hidden = Array.isArray(raw?.hidden) ? [...new Set(raw.hidden.filter(x => IDS.includes(x) && x !== 'settings'))] : [];
  return {collapsed:raw?.collapsed===true,order,hidden};
}
function cleanUi(raw) {
  const pick = (field, choices, fallback) => choices.includes(raw?.[field]) ? raw[field] : fallback;
  return {theme:pick('theme',['dark','light','auto'],'dark'),
    accent:pick('accent',['gold','teal','violet'],'gold'),
    radius:pick('radius',['normal','sharp','round'],'normal'),
    scale:pick('scale',['sm','md','lg'],'md'),
    chatDensity:pick('chatDensity',['comfortable','compact'],'comfortable'),
    chatFont:pick('chatFont',['sm','md','lg'],'md')};
}
let menu = cleanMenu(readLocal(KEY_NAV, {collapsed:false,order:IDS,hidden:[]}));
let ui = cleanUi(readLocal(KEY_UI, DEFAULT_UI));
let sectionPrefs = readLocal(KEY_SETTINGS, {collapsed:[]});
let notes = readLocal(KEY_NOTES, []);
if (!Array.isArray(notes)) notes = [];
notes = notes.filter(n => n && typeof n.id === 'string' && typeof n.text === 'string').slice(0,200);
let config = structuredClone(DEFAULT_CONFIG);
let serverAvailable = false;
let editing = false, drawer = false, route = 'settings', searchDialog = null, noteDialog = null;
let appNode, navNode, mainNode, bottomNode, scrim, topTitle;
let toastTimeout;
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = String(text);
  return node;
}
function icon(name, size=18) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.setAttribute('viewBox','0 0 24 24');
  svg.setAttribute('width',String(size));
  svg.setAttribute('height',String(size));
  svg.setAttribute('fill','none');
  svg.setAttribute('stroke','currentColor');
  svg.setAttribute('stroke-width','1.7');
  svg.setAttribute('stroke-linecap','round');
  svg.setAttribute('stroke-linejoin','round');
  svg.setAttribute('aria-hidden','true');
  const path = document.createElementNS('http://www.w3.org/2000/svg','path');
  path.setAttribute('d', ICONS[name] || ICONS.spark);
  svg.append(path);
  return svg;
}
function btn(label, onClick, cls='btn') {
  const b=el('button',cls,label);b.type='button';
  if (onClick) b.addEventListener('click',onClick);
  return b;
}
function iconBtn(name, title, onClick, cls='icon-btn sm') {
  const b=el('button',cls);b.type='button';b.title=title;
  b.setAttribute('aria-label',title);b.append(icon(name));
  b.addEventListener('click',onClick);return b;
}
function text(parent, copy, cls='muted') {
  const p=el('p',cls,copy);parent.append(p);return p;
}
function toast(message) {
  const older=document.getElementById('ts-toast');older?.remove();
  const bar=el('div','toast-ts',message);
  bar.id='ts-toast';bar.setAttribute('role','status');document.body.append(bar);
  clearTimeout(toastTimeout);toastTimeout=setTimeout(()=>bar.remove(),3200);
}
function applyUi() {
  const html=document.documentElement;
  html.dataset.theme=ui.theme;html.dataset.radius=ui.radius;html.dataset.scale=ui.scale;
  html.classList.toggle('nav-collapsed',menu.collapsed&&!editing);
  const colors={gold:'#d9a441',teal:'#66c4bd',violet:'#a68aef'};
  html.style.setProperty('--brand',colors[ui.accent]);
  document.querySelector('meta[name=theme-color]')?.setAttribute('content',ui.theme==='light'?'#ffffff':'#09090c');
}
function persistMenu(){menu=cleanMenu(menu);writeLocal(KEY_NAV,menu);applyUi();renderMenu();}
function persistUi(){ui=cleanUi(ui);writeLocal(KEY_UI,ui);applyUi();renderMenu();if(route==='settings')renderMain();}
function go(id) {
  if (!IDS.includes(id)) id='settings';
  drawer=false;
  route=id;
  const target='#/'+id;
  if (location.hash!==target) location.hash=target;
  renderMenu();renderMain();
  scrim.classList.remove('open');
}
function currentRoute() {
  const raw=location.hash.replace(/^#\/?/,'');
  const segment=raw.split('/')[0];
  return IDS.includes(segment)?segment:'settings';
}
function orderedItems(group, showHidden=false) {
  return menu.order.map(id=>NAV.find(n=>n.id===id))
    .filter(item=>item&&item.group===group&&(showHidden||!menu.hidden.includes(item.id)));
}
function navEntry(item, mobile=false) {
  const anchor=el('a',mobile?'bb-item':'nav-item');
  anchor.href='#/'+item.id;
  if(route===item.id) {
    anchor.classList.add('active');
    anchor.setAttribute('aria-current','page');
  }
  anchor.title=item.label;
  const ic=el('span','nav-ic');ic.append(icon(item.icon,mobile?18:19));
  anchor.append(ic,el('span',mobile?'':'nav-label',item.label));
  if(!mobile) {
    const n=menu.order.filter(id=>!menu.hidden.includes(id)).indexOf(item.id)+1;
    if(n>0&&n<10)anchor.append(el('span','nav-hotkey','Alt+'+n));
  }
  anchor.addEventListener('click',event=>{event.preventDefault();go(item.id);});
  return anchor;
}
function editReorder(id,direction) {
  const group=NAV.find(x=>x.id===id)?.group;
  const groupIds=orderedItems(group,true).map(x=>x.id);
  const index=groupIds.indexOf(id),next=index+direction;
  if(next<0||next>=groupIds.length)return;
  const other=groupIds[next],a=menu.order.indexOf(id),b=menu.order.indexOf(other);
  [menu.order[a],menu.order[b]]=[menu.order[b],menu.order[a]];
  persistMenu();
}
function renderEditMenu() {
  navNode.replaceChildren();
  const header=el('div','nav-head');
  header.append(el('div','brand','TSUKIMERA'),btn('Готово',()=>{editing=false;persistMenu();},'btn primary'));
  navNode.append(header,text(el('div','',''),'')); // replaced below with proper hint
  navNode.lastChild.remove();
  navNode.append(el('p','nav-edit-hint','Изменяйте порядок внутри группы и скрывайте разделы. Настройки нельзя скрыть.'));
  for(const group of ['main','brain','system']) {
    const div=el('div','nav-group');
    div.setAttribute('role','group');
    div.setAttribute('aria-label',group==='main'?'Главное':group==='brain'?'Помощница':'Система');
    for(const item of orderedItems(group,true)) {
      const row=el('div','nav-edit-row'+(menu.hidden.includes(item.id)?' is-hidden':''));
      const title=el('span','nav-edit-label grow',item.label);
      const up=iconBtn('arrowUp','Переместить вверх',()=>editReorder(item.id,-1));
      const down=iconBtn('arrowDown','Переместить вниз',()=>editReorder(item.id,1));
      const hide=iconBtn(menu.hidden.includes(item.id)?'eyeOff':'eye',item.id==='settings'?'Настройки всегда видны':'Изменить видимость',()=>{
        if(item.id==='settings')return;
        menu.hidden=menu.hidden.includes(item.id)?
          menu.hidden.filter(id=>id!==item.id):[...menu.hidden,item.id];
        persistMenu();
      });
      hide.disabled=item.id==='settings';
      row.append(icon(item.icon),title,up,down,hide);
      row.draggable=true;row.dataset.navId=item.id;
      row.addEventListener('dragstart',event=>event.dataTransfer?.setData('text/plain',item.id));
      row.addEventListener('dragover',event=>event.preventDefault());
      row.addEventListener('drop',event=>{
        event.preventDefault();
        const moving=event.dataTransfer?.getData('text/plain');
        if(!moving||moving===item.id||NAV.find(x=>x.id===moving)?.group!==item.group)return;
        const a=menu.order.indexOf(moving),b=menu.order.indexOf(item.id);
        menu.order.splice(a,1);menu.order.splice(menu.order.indexOf(item.id),0,moving);
        persistMenu();
      });
      div.append(row);
    }
    navNode.append(div);
  }
  const footer=el('div','nav-edit-foot');
  footer.append(btn('Сбросить меню',()=>{
    menu=cleanMenu({});persistMenu();
  }),btn('Готово',()=>{editing=false;persistMenu();},'btn primary'));
  navNode.append(footer);
}
function renderMenu() {
  if(!navNode)return;
  applyUi();
  navNode.classList.toggle('collapsed',menu.collapsed&&!editing);
  navNode.classList.toggle('editing',editing);
  navNode.classList.toggle('open',drawer);
  scrim.classList.toggle('open',drawer);
  if(editing){renderEditMenu();renderBottom();return;}
  navNode.replaceChildren();
  const header=el('div','nav-head');
  header.append(el('div','brand',menu.collapsed?'T':'TSUKIMERA'));
  if(!menu.collapsed)header.append(iconBtn('edit','Настроить меню',()=>{editing=true;renderMenu();}));
  header.append(iconBtn(menu.collapsed?'chevronRight':'chevronLeft',
    menu.collapsed?'Развернуть меню (Ctrl+B)':'Свернуть меню (Ctrl+B)',()=>{
      menu.collapsed=!menu.collapsed;persistMenu();
    },'icon-btn sm nav-collapse'));
  navNode.append(header);
  const tools=el('div','nav-tools');
  const add=btn('',openAddNote,'nav-add');
  add.append(icon('plus'),el('span','nav-label','Добавить'));
  tools.append(add,iconBtn('search','Поиск и команды (Ctrl+K)',openPalette,'nav-search'));
  navNode.append(tools);
  for(const group of ['main','brain','system']){
    const items=orderedItems(group);
    if(!items.length)continue;
    const wrapper=el('div','nav-group');wrapper.setAttribute('role','group');
    wrapper.setAttribute('aria-label',group==='main'?'Главное':group==='brain'?'Помощница':'Система');
    for(const item of items){
      wrapper.append(navEntry(item));
      if(item.id==='tasks'&&!menu.collapsed&&notes.length) {
        const link=el('a','nav-today');
        link.href='#/tasks';
        link.append(el('span','nav-today-time','Заметка'),el('span','nav-today-text',notes.at(-1).text.slice(0,40)));
        link.addEventListener('click',event=>{event.preventDefault();go('tasks');});
        wrapper.append(link);
      }
    }
    navNode.append(wrapper);
  }
  navNode.append(el('span','grow'));
  const footer=el('div','nav-foot');
  const plate=btn('','');
  plate.className='nav-me off';
  plate.title='Открыть настройки подключения';
  const av=el('span','nav-me-av','T'),dot=el('i','nav-me-dot');av.append(dot);
  const txt=el('span','nav-me-text');
  txt.append(el('strong','','TSUKIMERA'),el('small','',serverAvailable?'ИИ не подключён':'Сервер недоступен'));
  plate.append(av,txt);
  plate.addEventListener('click',()=>{go('settings');document.getElementById('set-conn')?.scrollIntoView({block:'start'});});
  footer.append(plate,iconBtn(ui.theme==='dark'?'sun':'moon','Переключить светлую/тёмную тему',()=>{
    ui.theme=ui.theme==='light'?'dark':'light';persistUi();
  },'icon-btn nav-theme'));
  navNode.append(footer);
  renderBottom();
}
function renderBottom() {
  if(!bottomNode)return;
  bottomNode.replaceChildren();
  const items=menu.order.map(id=>NAV.find(x=>x.id===id)).filter(n=>n&&!menu.hidden.includes(n.id));
  for(const item of items.slice(0,5))bottomNode.append(navEntry(item,true));
}
function createShell() {
  appNode=el('div','app');
  navNode=el('nav','nav');navNode.setAttribute('aria-label','Разделы');
  const content=el('div','content');
  const top=el('header','topbar');
  top.append(iconBtn('menu','Меню',()=>{drawer=!drawer;renderMenu();},'icon-btn burger'));
  topTitle=el('strong','topbar-title','Tsukimera');
  top.append(topTitle);
  mainNode=el('main','content-main');mainNode.id='main';mainNode.tabIndex=-1;
  content.append(top,mainNode);
  scrim=el('div','nav-scrim');scrim.addEventListener('click',()=>{drawer=false;renderMenu();});
  bottomNode=el('nav','bottom-bar');bottomNode.setAttribute('aria-label','Быстрые разделы');
  appNode.append(navNode,scrim,content,bottomNode);
  document.getElementById('app').replaceChildren(appNode);
}
function heading(label,lead,ic) {
  const head=el('header','pg-head');
  const badge=el('span','pg-head-icon');badge.append(icon(ic||'spark',24));
  const title=el('div','pg-head-text');
  title.append(el('h1','',label),el('p','',lead));
  head.append(badge,title);return head;
}
/** A note stores only the stable file ID and a fallback label. Resolve the
 * current name/status from the same catalog that powers the Disk. */
async function refreshNoteFileLinks(root) {
  const buttons=[...root.querySelectorAll('button[data-disk-file-id]')];
  if(!buttons.length)return;
  try {
    const [response,links]=await Promise.all([
      fetch('/api/disk'),import('/disk-built/web/api.js')
    ]);
    if(!response.ok)throw Error('HTTP '+response.status);
    const listing=await response.json();
    if(route!=='tasks'||!root.isConnected)return;
    for(const button of buttons){
      const result=links.resolveFileLink(
        {id:button.dataset.diskFileId,name:button.dataset.diskFileName},listing);
      button.textContent=(result.status==='trash'?'🗑 ':result.status==='missing'?'⚠ ':'📎 ')+
        result.name+(result.status==='trash'?' · в корзине':result.status==='missing'?' · отсутствует':'');
      button.disabled=result.status==='missing';
      button.title=result.status==='active'?'Открыть файл на Диске':
        result.status==='trash'?'Документ находится в корзине Диска':'Связанный файл отсутствует в этом Диске';
    }
  }catch(error){console.warn('Не удалось проверить ссылки заметок:',error);}
}
function renderMain() {
  if(!mainNode)return;
  mainNode.replaceChildren();mainNode.dataset.route=route;
  // Only Disk escapes the centered JUUNIBI page width. Other routes keep their layout.
  mainNode.classList.toggle('disk-workspace',route==='disk');
  const item=NAV.find(n=>n.id===route);
  topTitle.textContent='Tsukimera · '+(item?.label||'Настройки');
  if(route==='settings') return renderSettings();
  if(route==='disk'){
    mainNode.append(el('p','muted','Открываю Диск…'));
    void import('/disk-built/web/pages/disk.js').then(({diskPage})=>{
      if(route!=='disk'||mainNode.dataset.route!=='disk')return;
      mainNode.replaceChildren(diskPage());
    }).catch(error=>{
      console.error('Tsukimera Disk:',error);
      if(route==='disk')mainNode.replaceChildren(el('p','muted','Не удалось открыть Диск: '+error.message));
    });
    return;
  }
  const wrap=el('div','page');wrap.append(heading(item.label, 'Новое пространство Tsukimera на базе интерфейса JUUNIBI.',item.icon));
  if(route==='tasks') {
    const card=el('section','pg-card');
    card.append(el('h2','','Дела и заметки'));
    text(card,'Простые локальные заметки для проверки меню. Планировщик из JUUNIBI сюда не копировался.');
    card.append(btn('Добавить заметку',openAddNote,'btn primary'));
    if(!notes.length)text(card,'Заметок пока нет.');
    const list=el('ul','quick-list');
    for(const n of [...notes].reverse()){
      const li=el('li');li.append(el('span','grow',n.text));
      if(Array.isArray(n.files)&&n.files.length){
        const links=el('div','set-controls');
        for(const file of n.files){
          const open=btn('📎 '+file.name,()=>{location.hash='#/disk/'+encodeURIComponent(file.id);},'btn sm');
          open.dataset.diskFileId=file.id;
          open.dataset.diskFileName=file.name;
          open.title='Открыть Диск: '+file.name;
          links.append(open);
        }
        li.append(links);
      }
      li.append(iconBtn('trash','Удалить заметку',async()=>{
        try{
          const response=await fetch('/api/notes/'+encodeURIComponent(n.id),{
            method:'DELETE',headers:{'X-Tsukimera-Request':'1'}});
          const value=await response.json();
          if(!response.ok)throw Error(value.error||'Ошибка удаления');
          notes=notes.filter(x=>x.id!==n.id);
          writeLocal(KEY_NOTES,notes);renderMain();renderMenu();
        }catch(error){toast('Заметка не удалена: '+error.message);}
      }));
      list.append(li);
    }
    card.append(list);wrap.append(card);
  } else {
    const card=el('section','pg-card route-empty');
    if(route==='chat'){
      card.append(el('strong','','Чат пока не подключён'));
      text(card,'Перенесены оформление сайта, меню и настройки. Модель ИИ и потоковый чат будут реализованы отдельно.');
      const label=el('span','route-status');label.append(el('i','dot'),el('span','','Cloud.ru: нет соединения'));card.append(label);
      card.append(el('div','set-controls'));
      card.append(btn('Настройки модели',()=>go('settings')));
    } else {
      card.append(el('strong','','Раздел подготовлен'));
      text(card,'Меню и переходы работают. Сам модуль «'+item.label+'» не переносился, чтобы новый проект оставался независимым от JUUNIBI.');
      card.append(btn('Открыть настройки',()=>go('settings')));
    }
    wrap.append(card);
  }
  mainNode.append(wrap);
  if(route==='tasks')void refreshNoteFileLinks(wrap);
}
/** One-time import is keyed by the database identity: moving to another SSD
 * or a fresh database cannot silently discard earlier browser-only notes. */
async function loadDatabaseNotes(){
  try{
    let response=await fetch('/api/notes');
    if(!response.ok)throw Error('HTTP '+response.status);
    let value=await response.json();
    noteDatabaseId=value.instanceId;
    let migrated='';
    try{migrated=localStorage.getItem(NOTE_DB_MARKER)||'';}catch{}
    if(migrated!==noteDatabaseId && notes.length){
      response=await fetch('/api/notes/import',{
        method:'POST',headers:{'Content-Type':'application/json','X-Tsukimera-Request':'1'},
        body:JSON.stringify({notes})});
      value=await response.json();
      if(!response.ok)throw Error(value.error||'Ошибка переноса заметок');
    }
    notes=Array.isArray(value.notes)?value.notes:[];
    writeLocal(KEY_NOTES,notes);
    try{localStorage.setItem(NOTE_DB_MARKER,noteDatabaseId);}catch{}
  }catch(error){
    console.error('Tsukimera SQLite notes:',error);
    toast('Не удалось перенести заметки в SQLite. Исходные данные браузера сохранены.');
  }
}
async function loadConfig() {
  try{
    const response=await fetch('/api/settings');
    if(!response.ok)throw Error('HTTP '+response.status);
    const data=await response.json();
    if(!data.settings)throw Error('Пустой ответ');
    config=data.settings;serverAvailable=true;
  }catch(err){console.warn('Tsukimera settings:',err.message);serverAvailable=false;}
}
async function saveSettings(patch) {
  try {
    const response=await fetch('/api/settings',{method:'PUT',
      headers:{'Content-Type':'application/json','X-Tsukimera-Request':'1'},
      body:JSON.stringify(patch)});
    const json=await response.json();
    if(!response.ok)throw Error(json.error||'Ошибка сохранения');
    config=json.settings;serverAvailable=true;
    toast('Настройки сохранены локально');
    // Do not destroy unsaved edits elsewhere in the settings form.
    renderMenu();return true;
  }catch(err){toast('Не сохранено: '+err.message);return false;}
}
function field(label,value,type='text',max=200) {
  const wrap=el('label','beh-field');
  wrap.append(el('span','',label));
  const input=el(type==='textarea'?'textarea':'input');
  if(type!=='textarea')input.type=type;
  input.value=value||'';input.maxLength=max;
  input.autocomplete='off';
  wrap.append(input);return {wrap,input};
}
function line(title,detail,node) {
  const row=el('div','set-row');
  const heading=el('div','grow');heading.append(el('strong','',title),el('small','',detail));
  row.append(heading);
  if(node){const box=el('div','set-value');box.append(node);row.append(box);}
  return row;
}
function switcher(title,desc,checked,change) {
  const input=el('input');input.type='checkbox';input.checked=!!checked;
  input.setAttribute('role','switch');input.setAttribute('aria-label',title);
  input.addEventListener('change',()=>void change(input.checked));
  const label=el('label','set-row switch-row');
  const copy=el('span','grow');copy.append(el('strong','',title),el('small','',desc));
  label.append(copy,input);return label;
}
function choices(title,desc,options,value,onSelect) {
  const container=el('div','choice-cards');
  for(const option of options) {
    const pick=btn(option.label,()=>onSelect(option.id),'choice-card');
    pick.setAttribute('aria-pressed',String(option.id===value));
    container.append(pick);
  }
  return line(title,desc,container);
}
async function tsApi(path,options){
  const result=await fetch(path,options);
  const data=await result.json().catch(()=>({}));
  if(!result.ok)throw Error("HTTP "+result.status+" · "+(data.error||"Ошибка запроса"));
  return data;
}
function tsPost(path,record){
  return tsApi(path,{method:"POST",headers:{
    "Content-Type":"application/json","X-Tsukimera-Request":"1"},
    body:JSON.stringify(record)});
}
let cachedCloudModels=[];
function modelPicker(label,currentField){
  const box=el("div","set-model-chooser");
  const search=el("input","set-model-search");search.type="search";
  search.placeholder="Поиск по списку Cloud.ru";search.setAttribute("aria-label",label+": поиск модели");
  const select=el("select","set-model-list");select.setAttribute("aria-label",label+": выбрать модель");
  select.disabled=true;
  const status=el("small","set-note","Получаю список моделей только при наличии ключа.");
  const update=()=>{
    const q=search.value.trim().toLowerCase();
    const models=cachedCloudModels.filter(model=>model.toLowerCase().includes(q));
    select.replaceChildren();
    const placeholder=el("option","",models.length?"Выберите модель из "+models.length:"Нет совпадений");
    placeholder.value="";select.append(placeholder);
    for(const name of models){const opt=el("option","",name);opt.value=name;select.append(opt);}
    select.disabled=models.length===0;
    status.textContent=cachedCloudModels.length+" доступных моделей · "+models.length+" найдено";
  };
  search.addEventListener("input",update);
  select.addEventListener("change",()=>{if(select.value)currentField.input.value=select.value;});
  const refresh=btn("Обновить список",async()=>{
    refresh.disabled=true;
    try{
      const out=await tsApi("/api/cloud/models");
      cachedCloudModels=out.models||[];update();
    }catch(error){status.textContent=error.message;}
    finally{refresh.disabled=false;}
  },"btn");
  box.append(search,select,refresh,status);
  void tsApi("/api/cloud/status").then(info=>{
    if(!box.isConnected)return;
    if(info.configured)refresh.click();
    else status.textContent="Добавьте API-ключ в разделе «Подключение».";
  }).catch(()=>{status.textContent="Сервис Cloud.ru недоступен.";});
  return box;
}
function cloudConnectionPanel(body){
  const key=el("input","set-cloud-key");key.type="password";key.maxLength=4096;
  key.autocomplete="off";key.spellcheck=false;
  key.placeholder="Key Secret Cloud.ru (не сохраняется на диск)";
  key.setAttribute("aria-label","API-ключ Foundation Models");
  const status=el("p","set-connection-state","Проверяю Cloud.ru…");
  status.setAttribute("role","status");
  const check=btn("Проверить подключение",async()=>{
    check.disabled=true;status.textContent="Проверяю ключ по GET /v1/models…";
    try{
      if(key.value.trim()){await tsPost("/api/cloud/key",{key:key.value});key.value="";}
      const result=await tsApi("/api/cloud/models");
      cachedCloudModels=result.models;
      status.textContent="Подключено · Cloud.ru вернул "+result.models.length+
        " моделей · "+new Date(result.checkedAt).toLocaleString("ru-RU");
      status.dataset.state="ok";
    }catch(error){
      status.dataset.state="error";
      status.textContent=error.message+" · модель не вызывалась, расходы на генерацию не создавались.";
    }finally{check.disabled=false;}
  },"btn primary");
  const disconnect=btn("Отключить",async()=>{
    try{await tsPost("/api/cloud/clear",{});cachedCloudModels=[];
      status.dataset.state="off";status.textContent="Cloud.ru отключён от этого запуска.";}
    catch(error){status.textContent=error.message;}
  });
  const buttons=el("div","set-controls");buttons.append(check,disconnect);
  body.append(line("Foundation Models","Официальный endpoint: foundation-models.api.cloud.ru/v1",
    el("span","set-cloud-endpoint","Только чтение списка моделей")),
    line("Ключ API","Принимается только локальным сервером. Не записывается в SQLite, JSON или браузерное хранилище.",key),
    buttons,status);
  const help=el("p","set-note");
  const link=el("a","","Документация Cloud.ru");
  link.href="https://cloud.ru/docs/foundation-models/ug/topics/api-ref__authentication";
  link.target="_blank";link.rel="noopener noreferrer";
  help.append("Ключ также можно задать в переменной окружения CLOUD_RU_FOUNDATION_MODELS_API_KEY. ",link,
    ". Здесь нет платного тестового запроса к LLM.");
  body.append(help);
  void tsApi("/api/cloud/status").then(result=>{
    if(!status.isConnected)return;
    status.dataset.state=result.verified?"ok":result.lastError?"error":"off";
    status.textContent=result.verified?"Cloud.ru проверен · моделей: "+result.modelsCount:
      result.lastError?result.lastError.message:
        result.configured?"Ключ настроен ("+result.source+"), нажмите «Проверить подключение».":"Ключ не указан.";
  }).catch(()=>{if(status.isConnected)status.textContent="Локальный сервер Cloud.ru недоступен.";});
}
function memoryCenterPanel(body){
  const summary=el("div","set-health-grid");
  summary.append(el("p","set-note","Читаю реальное состояние SQLite и возможностей памяти…"));
  body.append(summary);
  const actions=el("div","set-controls");
  actions.append(btn("Открыть заметки",()=>go("tasks"),"btn primary"),
    btn("Перейти к диагностике",()=>{
      const node=document.getElementById("set-data");
      node?.classList.remove("collapsed");const inner=node?.querySelector(".set-card-body");
      if(inner)inner.hidden=false;
      node?.scrollIntoView({block:"start",behavior:"smooth"});
    }));
  body.append(actions);
  void tsApi("/api/capabilities").then(info=>{
    if(!summary.isConnected)return;
    summary.replaceChildren(
      line("Локальная память заметок",info.notes.stored+" сохранено в SQLite",el("span","set-state ready","Работает")),
      line("Семантический поиск",info.vectorSearch.reason,el("span","set-state pending","Не подключён")),
      line("Сводки длинных диалогов",info.summaries.reason,el("span","set-state pending","Не подключены")),
      line("Автосохранение фактов","Нет работающего движка извлечения и проверки фактов",
        el("span","set-state pending","Не подключено"))
    );
  }).catch(error=>{summary.textContent="Состояние памяти недоступно: "+error.message;});
  text(body,"Ранее сохранённые предпочтения памяти не стираются, но не исполняются до создания соответствующего модуля.","set-note");
}
function toolSafetyPanel(body){
  body.append(el("p","set-note","Ручные действия пользователя с Диском работают как раньше. Здесь указаны разрешения только для будущих действий ИИ — исполнитель инструментов пока не подключён."));
  const state=el("div","set-health-grid");body.append(state);
  void tsApi("/api/capabilities").then(info=>{
    if(!state.isConnected)return;
    state.replaceChildren(
      line("Интернет для ИИ",info.aiTools.reason,el("span","set-state pending","Запрещено")),
      line("Запись файлов от имени ИИ","Нет исполняющего модуля; настройка не выдаёт доступ к диску",el("span","set-state pending","Запрещено")),
      line("Предыдущие предпочтения","Интернет: "+(config.tools.web?"да":"нет")+
        " · запись: "+(config.tools.writeFiles?"да":"нет"),el("span","set-state","Не активны")));
  }).catch(error=>{state.textContent="Не удалось проверить разрешения: "+error.message;});
}
function saveButton(handler) {
  return btn('Сохранить',()=>void handler(),'btn primary');
}
function sectionCard(sec) {
  const section=el('section','pg-card set-card');section.id='set-'+sec.id;
  section.dataset.search=sec.label.toLowerCase()+' '+sec.hint.toLowerCase();
  const collapsed=Array.isArray(sectionPrefs.collapsed)&&sectionPrefs.collapsed.includes(sec.id);
  if(collapsed)section.classList.add('collapsed');
  const head=el('header','set-card-head');
  const ic=el('span','set-card-icon');ic.append(icon(sec.icon,19));
  const copy=el('div','grow');copy.append(el('h2','',sec.label),el('p','',sec.hint));
  const collapse=iconBtn('chevron',collapsed?'Развернуть':'Свернуть',()=>{
    const on=section.classList.toggle('collapsed');
    body.hidden=on;
    collapse.setAttribute('aria-expanded',String(!on));
    const set=new Set(sectionPrefs.collapsed||[]);
    if(on)set.add(sec.id);else set.delete(sec.id);
    sectionPrefs.collapsed=[...set];writeLocal(KEY_SETTINGS,sectionPrefs);
  },'icon-btn sm set-collapse');
  collapse.setAttribute('aria-expanded',String(!collapsed));
  const states={conn:['partial','Подключение без чата'],model:['partial','Модели без чата'],
    persona:['pending','Ожидает ИИ'],memory:['partial','Заметки работают'],
    tools:['pending','Инструменты недоступны'],quick:['partial','Сохраняет шаблоны'],
    look:['ready','Работает'],chat:['pending','Ожидает ИИ'],
    data:['ready','SQLite работает'],about:['ready','Информация']};
  const [state,label]=states[sec.id]||['pending','Не подключено'];
  const flag=el('small','set-cap-state '+state,label);
  flag.setAttribute('title','Функциональная доступность раздела');
  head.append(ic,copy,flag,collapse);
  const body=el('div','set-card-body');body.hidden=collapsed;
  section.append(head,body);
  return {section,body};
}
function setupCard(id,body) {
  if(id==='conn') {
    cloudConnectionPanel(body);
  } else if(id==='model') {
    const primary=field('Основная модель',config.model.primary,'text',120);
    const fallback=field('Запасная модель',config.model.fallback,'text',120);
    const reasoning=el('input');reasoning.type='checkbox';reasoning.checked=config.model.reasoning;
    reasoning.setAttribute('aria-label','Включить размышления');
    body.append(primary.wrap,modelPicker("Основная модель",primary),
      fallback.wrap,modelPicker("Запасная модель",fallback),
      line('Размышления','Предпочтение для будущего подключения чата.',reasoning));
    const act=el('div','set-controls');
    act.append(saveButton(()=>saveSettings({model:{primary:primary.input.value.trim(),
      fallback:fallback.input.value.trim(),reasoning:reasoning.checked}})));
    body.append(act);
    text(body,'Модели пока не вызываются. Изменение полей сохраняет конфигурацию, а не запускает платный запрос.','set-note');
  } else if(id==='persona') {
    const about=field('О себе',config.instructions.about,'textarea',1500);
    const style=field('Как отвечать',config.instructions.style,'textarea',1500);
    body.append(about.wrap,style.wrap);
    body.append(saveButton(()=>saveSettings({instructions:{about:about.input.value,style:style.input.value}})));
    text(body,'Инструкции пока не передаются модели: ИИ-движок в Tsukimera не установлен.','set-note');
  } else if(id==='memory') {
    memoryCenterPanel(body);
  } else if(id==='tools') {
    toolSafetyPanel(body);
  } else if(id==='quick') {
    const list=el('ul','quick-list');
    for(const item of config.quickCommands){
      const li=el('li');li.append(el('code','','/'+item.name),el('span','grow',item.text));
      li.append(iconBtn('trash','Удалить команду',async()=>{
        if(await saveSettings({quickCommands:config.quickCommands.filter(x=>x.name!==item.name)}))renderMain();
      }));
      list.append(li);
    }
    body.append(list);
    const name=field('Название команды, без /','','text',24);
    const value=field('Текст команды','','textarea',1500);
    body.append(name.wrap,value.wrap);
    body.append(saveButton(async()=>{
      const ok=await saveSettings({quickCommands:[...config.quickCommands,
        {name:name.input.value.trim(),text:value.input.value.trim()}]});
      if(ok)renderMain();
    }));
    text(body,'Шаблоны сохраняются локально. Выполнение команд будет доступно после подключения чата.','set-note');
  } else if(id==='look') {
    const option=(id,label)=>({id,label});
    body.append(choices('Тема','Настройка применяется сразу.',
      [option('auto','Системная'),option('light','Светлая'),option('dark','Тёмная')],ui.theme,v=>{ui.theme=v;persistUi();}));
    body.append(choices('Цвет акцента','JUUNIBI поддерживает смену цвета интерфейса.',
      [option('gold','Золото'),option('teal','Бирюза'),option('violet','Фиолетовый')],ui.accent,v=>{ui.accent=v;persistUi();}));
    body.append(choices('Скругление','От строгих углов до мягких форм.',
      [option('sharp','Строго'),option('normal','Обычно'),option('round','Кругло')],ui.radius,v=>{ui.radius=v;persistUi();}));
    body.append(choices('Размер интерфейса','Масштаб шрифтов и элементов.',
      [option('sm','Меньше'),option('md','Обычно'),option('lg','Больше')],ui.scale,v=>{ui.scale=v;persistUi();}));
  } else if(id==='chat') {
    const option=(id,label)=>({id,label});
    body.append(choices('Плотность сообщений','Подготовлено к будущему чату.',
      [option('comfortable','Удобная'),option('compact','Компактная')],ui.chatDensity,v=>{ui.chatDensity=v;persistUi();}));
    body.append(choices('Размер текста','Выбор запомнится для чата.',
      [option('sm','Маленький'),option('md','Обычный'),option('lg','Крупный')],ui.chatFont,v=>{ui.chatFont=v;persistUi();}));
    text(body,'Потоковая генерация и список диалогов ещё не подключены.','set-note');
  } else if(id==='data') {
    const storage=el('div','set-note','SQLite · Проверяю локальную базу данных…');
    body.append(storage);
    void fetch('/api/storage').then(async response=>{
      if(!response.ok)throw Error('HTTP '+response.status);
      return response.json();
    }).then(data=>{
      if(!storage.isConnected)return;
      storage.textContent='SQLite · '+data.file+' · файлов: '+data.counts.files+
        ' · заметок: '+data.counts.notes+' · версий: '+data.counts.versions+
        (data.backupCreated?' · исходная копия: '+data.backupCreated:'');
    }).catch(()=>{if(storage.isConnected)storage.textContent='Не удалось проверить SQLite';});
    text(body,'Экспорт включает настройки, заметки, их ссылки по ID и параметры просмотра Диска — без ключей API. Содержимое файлов и версии нужно сохранить отдельно в разделе «Диск».','set-note');
    const diagnostic=el('div','set-diagnostics');
    const inspect=btn('Проверить целостность SQLite',async()=>{
      inspect.disabled=true;
      diagnostic.textContent='Проверяю SQLite, размер и резервные копии…';
      try{
        const report=await tsApi('/api/storage/diagnostics');
        diagnostic.replaceChildren(
          line('Проверка базы',report.integrity==='ok'?'Ошибок не обнаружено':report.integrity,
            el('span','set-state '+(report.integrity==='ok'?'ready':'error'),report.integrity==='ok'?'Порядок':'Проверить')),
          line('Размер SQLite',Math.round(report.sizeBytes/1024).toLocaleString('ru-RU')+' КБ'),
          line('Схема / таблицы',report.schema+' / '+report.tables),
          line('Записей',report.counts.files+' файлов · '+report.counts.notes+
            ' заметок · '+report.counts.preferences+' настроек · '+report.counts.versions+' редакций'),
          line('Резервные копии',report.backups.length+' найдено в папке data/backups'),
          el('p','set-note',report.backups.slice(0,5).join(' · ')||'Резервных копий пока нет.')
        );
      }catch(error){diagnostic.textContent='Диагностика не завершена: '+error.message;}
      finally{inspect.disabled=false;}
    },'btn');
    body.append(inspect,diagnostic);
    const actions=el('div','section-actions');
    actions.append(btn('Скачать резервную копию',()=>void downloadBackup(),'btn primary'));
    const input=el('input');input.type='file';input.accept='application/json,.json';input.setAttribute('aria-label','Импорт файла резервной копии');
    input.addEventListener('change',async()=>{
      const f=input.files?.[0];if(!f)return;
      if(f.size>1024*1024){toast('Слишком большой файл');return;}
      try {await restoreBackup(JSON.parse(await f.text()));}
      catch(err){toast('Ошибка импорта: '+err.message);}
    });
    actions.append(input);
    actions.append(btn('Резервная копия файлов Диска',()=>go('disk')));
    body.append(actions);
    text(body,'Основное хранилище: data/tsukimera.db. Файлы и их версии остаются в data/disk/. Импорт создаёт копию SQLite перед изменением, но не переносит бинарные файлы. Ключ Cloud.ru не сохраняется.','set-note');
  } else if(id==='about') {
    body.append(line('Проект','Tsukimera',el('span','', 'Версия 0.1.0')));
    body.append(line('Образец интерфейса','Оформление и концепция меню — JUUNIBI.',
      el('a','', '')));
    const links=el('div','set-controls');
    const source=el('a','btn','Открыть JUUNIBI');source.href='https://github.com/Aspksa/JUUNIBI';source.target='_blank';source.rel='noopener noreferrer';
    const target=el('a','btn','Tsukimera на GitHub');target.href='https://github.com/Aspksa/Tsukimera';target.target='_blank';target.rel='noopener noreferrer';
    links.append(source,target);body.append(links);
    text(body,'Ctrl+K — поиск · Ctrl+B — свернуть меню · Ctrl+, — настройки · Alt+1…8 — разделы.','set-note');
  }
}
function renderSettings() {
  const page=el('div','page settings-page');
  const head=heading('Настройки','Локальные настройки Tsukimera · SQLite · реальные возможности помечены по состоянию.','settings');
  page.append(head);
  const search=el('div','set-search');
  search.append(icon('search'));
  const searchInput=el('input');searchInput.type='search';searchInput.placeholder='Поиск по настройкам';
  searchInput.setAttribute('aria-label','Поиск по настройкам');
  const results=el('small','set-search-results','Поиск по разделам и отдельным параметрам');
  results.setAttribute('role','status');
  search.append(searchInput,el('kbd','kbd','Ctrl+,'));
  page.append(search,results);
  const layout=el('div','set-layout');
  const left=el('aside','set-side'),toc=el('nav','set-toc');
  toc.setAttribute('aria-label','Разделы настроек');
  left.append(toc);
  const main=el('div','set-main');
  const cards=new Map(),links=new Map();
  for(const sec of SECTIONS) {
    const link=btn('',null,'set-toc-link');
    link.append(icon(sec.icon,17),el('span','grow',sec.label));
    const readiness={conn:'partial',model:'partial',persona:'pending',memory:'partial',
      tools:'pending',quick:'partial',look:'ready',chat:'pending',data:'ready',about:'ready'};
    link.dataset.readiness=readiness[sec.id];
    link.title=readiness[sec.id]==='ready'?'Работает':
      readiness[sec.id]==='partial'?'Часть возможностей работает':'Функционал пока не подключён';
    link.addEventListener('click',()=>{
      searchInput.value='';filter('');
      document.getElementById('set-'+sec.id)?.scrollIntoView({behavior:'smooth',block:'start'});
      for(const [id,l] of links)l.classList.toggle('active',id===sec.id);
    });
    toc.append(link);links.set(sec.id,link);
    const {section,body}=sectionCard(sec);setupCard(sec.id,body);
    main.append(section);cards.set(sec.id,section);
  }
  function filter(query) {
    const norm=value=>String(value||'').toLowerCase().replaceAll('ё','е');
    const terms=norm(query.trim()).split(/\s+/).filter(Boolean);
    let matches=0,sections=0;
    for(const sec of SECTIONS){
      const card=cards.get(sec.id),link=links.get(sec.id);
      const heading=norm(sec.label+' '+sec.hint),whole=norm(card.textContent);
      const full=terms.every(t=>heading.includes(t));
      const rowNodes=[...card.querySelector('.set-card-body').children];
      const hits=rowNodes.filter(node=>terms.every(t=>norm(node.textContent).includes(t)));
      const match=!terms.length||full||hits.length>0||terms.every(t=>whole.includes(t));
      card.hidden=!match;link.hidden=!match;
      if(match)sections++;
      if(terms.length&&match){
        card.classList.remove('collapsed');
        card.querySelector('.set-card-body').hidden=false;
        for(const node of rowNodes){
          // A section match keeps all fields; otherwise highlight the exact
          // matching controls while retaining context and surrounding hints.
          node.classList.toggle('set-search-hit',hits.includes(node));
        }
        matches+=full?rowNodes.length:hits.length||1;
      }else rowNodes.forEach(node=>node.classList.remove('set-search-hit'));
    }
    results.textContent=terms.length?sections+' разделов · '+matches+' совпадений':
      '10 разделов · работает / частично / не подключено';
    search.dataset.empty=String(terms.length>0&&sections===0);
  }
  searchInput.addEventListener('input',()=>filter(searchInput.value));
  searchInput.addEventListener('keydown',event=>{
    if(event.key==='Enter'){
      event.preventDefault();
      const first=[...cards.values()].find(card=>!card.hidden);
      first?.scrollIntoView({block:'start',behavior:'smooth'});
      first?.querySelector('input,button,textarea')?.focus({preventScroll:true});
    }
  });
  filter('');
  const controls=el('div','set-controls');
  controls.append(btn('Свернуть все',()=>{
    sectionPrefs.collapsed=SECTIONS.map(s=>s.id);writeLocal(KEY_SETTINGS,sectionPrefs);renderMain();
  }),btn('Развернуть все',()=>{
    sectionPrefs.collapsed=[];writeLocal(KEY_SETTINGS,sectionPrefs);renderMain();
  }));
  left.append(controls);
  layout.append(left,main);page.append(layout);mainNode.append(page);
}
async function downloadBackup(){
  try{
    const [pref,store,notesSaved]=await Promise.all([
      tsApi('/api/preferences'),tsApi('/api/settings'),tsApi('/api/notes')
    ]);
    const decoded=key=>{try{return JSON.parse(pref.preferences[key]||'null');}catch{return null;}};
    const diskPrefs={};
    for(const key of DISK_PREF_KEYS)if(Object.hasOwn(pref.preferences,key))
      diskPrefs[key]=pref.preferences[key];
    const payload={kind:'tsukimera-settings-v1',version:1,created:new Date().toISOString(),
      menu:decoded(KEY_NAV)||menu,ui:decoded(KEY_UI)||ui,
      sections:decoded(KEY_SETTINGS)||sectionPrefs,
      notes:notesSaved.notes,settings:store.settings,diskPrefs};
    const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});
    const href=URL.createObjectURL(blob);
    const a=el('a');a.href=href;a.download='Tsukimera-settings.json';
    document.body.append(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(href),5000);
    toast('Копия настроек и заметок скачана. Файлы Диска сохраняются отдельно.');
  }catch(error){toast('Не удалось создать копию: '+error.message);}
}
async function restoreBackup(payload){
  if(!payload||payload.kind!=='tsukimera-settings-v1'||payload.version!==1)
    throw Error('Это не резервная копия Tsukimera');
  if(!confirm('Восстановить настройки и заметки из копии? Перед изменениями будет создан снимок SQLite. Данные Диска и файлов не затрагиваются.'))
    return;
  const restored=await tsPost('/api/settings/restore',payload);
  config=restored.settings;
  notes=restored.notes;
  const prefs=restored.preferences;
  // Restore the browser mirror only after the whole SQLite transaction succeeds.
  for(const key of SQLITE_PREF_KEYS){
    if(Object.hasOwn(prefs,key))localStorage.setItem(key,prefs[key]);
    else localStorage.removeItem(key);
  }
  menu=cleanMenu(readLocal(KEY_NAV,{collapsed:false,order:IDS,hidden:[]}));
  ui=cleanUi(readLocal(KEY_UI,DEFAULT_UI));
  sectionPrefs=readLocal(KEY_SETTINGS,{collapsed:[]});
  writeLocal(KEY_NOTES,notes);
  applyUi();renderMenu();renderMain();
  toast('Восстановлено. Предыдущая SQLite сохранена: '+restored.backup);
}
function createModal(title) {
  const overlay=el('div','modal-ts');
  const card=el('section','modal-ts-card');card.setAttribute('role','dialog');
  card.setAttribute('aria-modal','true');card.setAttribute('aria-label',title);
  const head=el('header','modal-ts-head');
  head.append(el('h2','',title),iconBtn('x','Закрыть',()=>overlay.remove()));
  card.append(head);overlay.append(card);
  overlay.addEventListener('click',event=>{if(event.target===overlay)overlay.remove();});
  document.body.append(overlay);return {overlay,card};
}
function openAddNote() {
  document.querySelector('.modal-ts')?.remove();
  const {overlay,card}=createModal('Новая заметка');
  const input=field('Текст заметки','','textarea',3000);
  card.append(input.wrap);
  card.append(btn('Сохранить заметку',async()=>{
    const value=input.input.value.trim();if(!value){toast('Введите текст');return;}
    try{
      const response=await fetch('/api/notes',{
        method:'POST',headers:{'X-Tsukimera-Request':'1','Content-Type':'application/json'},
        body:JSON.stringify({id:crypto.randomUUID(),text:value})});
      const result=await response.json();
      if(!response.ok)throw Error(result.error||'Ошибка сохранения');
      notes.push(result.note);
      notes=notes.slice(-200);writeLocal(KEY_NOTES,notes);
      overlay.remove();renderMenu();go('tasks');
    }catch(error){toast('Заметка не сохранена: '+error.message);}
  },'btn primary'));
  input.input.focus();
}
function openPalette() {
  document.querySelector('.modal-ts')?.remove();
  const {overlay,card}=createModal('Поиск и команды');
  const input=el('input');input.type='search';input.className='pal-input';
  input.placeholder='Раздел, команда или заметка…';input.setAttribute('aria-label','Поиск по меню');
  const search=el('div','pal-head');search.append(icon('search'),input);
  const list=el('div','pal-list');
  card.append(search,list);
  function update() {
    list.replaceChildren();
    const query=input.value.toLowerCase().replaceAll('ё','е').trim();
    const sections=NAV.filter(x=>!query||x.label.toLowerCase().includes(query));
    for(const item of sections){
      const row=btn('',()=>{overlay.remove();go(item.id);},'pal-item');
      const ic=el('span','pal-ic');ic.append(icon(item.icon));
      const textNode=el('span','pal-text');textNode.append(el('span','pal-title',item.label),el('span','pal-sub','Перейти в раздел'));
      row.append(ic,textNode);list.append(row);
    }
    for(const command of config.quickCommands.filter(x=>query&&(x.name+' '+x.text).toLowerCase().includes(query)).slice(0,10)){
      const row=btn('/'+command.name,()=>{overlay.remove();toast('Текст: '+command.text.slice(0,95));},'pal-item');
      list.append(row);
    }
    if(!list.children.length)list.append(el('p','muted','Ничего не найдено'));
  }
  input.addEventListener('input',update);
  input.addEventListener('keydown',event=>{
    if(event.key==='Enter')list.querySelector('button')?.click();
  });
  update();input.focus();
}
function bindKeys(){
  document.addEventListener('keydown',event=>{
    const target=event.target;
    const inField=target instanceof HTMLInputElement||target instanceof HTMLTextAreaElement;
    if(event.key==='Escape'){
      document.querySelector('.modal-ts')?.remove();
      if(drawer){drawer=false;renderMenu();}return;
    }
    if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){
      event.preventDefault();
      const disk=document.querySelector('.disk-page');
      if(route==='disk'&&disk) disk.dispatchEvent(new Event('tsukimera:disk-command'));
      else openPalette();
      return;
    }
    if((event.ctrlKey||event.metaKey)&&event.key===','){
      event.preventDefault();go('settings');document.querySelector('.set-search input')?.focus();return;
    }
    if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='b'){
      event.preventDefault();menu.collapsed=!menu.collapsed;persistMenu();return;
    }
    if(event.altKey&&!event.ctrlKey&&!inField&&/^[1-8]$/.test(event.key)){
      const visible=menu.order.filter(x=>!menu.hidden.includes(x));
      const item=visible[Number(event.key)-1];
      if(item){event.preventDefault();go(item);}
    }
  });
}
async function init() {
  route=currentRoute();
  await hydrateSqlitePrefs();
  applyUi();
  createShell();
  bindKeys();
  await loadConfig();
  await loadDatabaseNotes();
  window.addEventListener('tsukimera:notes-changed',()=>{
    notes=readLocal(KEY_NOTES,[]);
    if(route==='tasks')renderMain();
  });
  renderMenu();renderMain();
  window.addEventListener('hashchange',()=>{
    const next=currentRoute();
    if(route!==next){route=next;drawer=false;renderMenu();renderMain();}
  });
}
void init();
