/** The upload panel: one row per file with its progress, a cancel, then ✓ or the reason it failed. */
import type { DiskUploaded } from "../api";
import { el, iconButton } from "../dom";
import { fileBadge } from "./disk-icons";
import { human } from "./disk-model";

const LIMIT = 500 * 1024 * 1024;
type Row = { file: File; folder: string; root: HTMLElement; bar: HTMLElement; note: HTMLElement; state: "wait" | "run" | "ok" | "fail" | "off"; xhr?: XMLHttpRequest; abort?: AbortController };

export interface Uploader {
  readonly root: HTMLElement;
  add(files: File[], folder: string): void;
  /** One batch with a folder per file (a dropped folder tree). */
  addMany(items: { file: File; folder: string }[]): void;
  readonly busy: boolean;
}
export function createUploader(o: { onUploaded: (f: DiskUploaded) => void; onIdle: () => void }): Uploader {
  const rows: Row[] = [];
  const title = el("strong", { textContent: "Загрузка" });
  const sub = el("small", { cls: "muted" });
  const list = el("div", { cls: "dk-up-list" });
  const close = iconButton("x", "Скрыть", () => { if (!running()) { rows.length = 0; list.replaceChildren(); root.hidden = true; } }, "icon-btn sm");
  const cancelAll = el("button", { type: "button", cls: "btn sm", textContent: "Отменить всё" });
  cancelAll.addEventListener("click", () => { for (const r of rows) stop(r); });
  const root = el("section", { cls: "dk-up", attrs: { "aria-label": "Загрузка файлов", "aria-live": "polite" } },
    el("header", {}, el("div", { cls: "dk-up-title" }, title, sub), cancelAll, close), list);
  root.hidden = true;
  let active = false;
  const running = () => rows.some((r) => r.state === "wait" || r.state === "run");
  const summary = () => {
    const ok = rows.filter((r) => r.state === "ok").length, fail = rows.filter((r) => r.state === "fail").length;
    const left = rows.filter((r) => r.state === "wait" || r.state === "run").length;
    title.textContent = left ? "Загружается " + (rows.length - left + 1) + " из " + rows.length : fail ? "Готово с ошибками" : "Готово";
    sub.textContent = [ok ? "✓ " + ok : "", fail ? "ошибок: " + fail : ""].filter(Boolean).join(" · ");
    cancelAll.hidden = !left;
    close.disabled = !!left;
    root.classList.toggle("done", !left);
  };
  const mark = (r: Row, state: Row["state"], note: string) => {
    r.state = state; r.note.textContent = note;
    r.root.className = "dk-up-row " + state;
    summary();
  };
  const stop = (r: Row) => {
    if (r.state === "wait") mark(r, "off", "Отменено");
    else if (r.state === "run") { r.xhr?.abort();r.abort?.abort(); }
  };
  /** Files above 8 MiB use persisted 4 MiB chunks. Re-selecting the exact same
   * local file after an interruption resumes from the server-confirmed offset.
   * The file is not available in the catalog until the last chunk is committed. */
  const resumableKey=(r:Row)=>"tsukimera.upload."+
    [r.folder,r.file.name,r.file.size,r.file.lastModified].map(encodeURIComponent).join("|");
  /** A bounded fingerprint rejects a different file with the same name, size
   * and timestamp. The browser never stores file bytes or uploads the sample. */
  const fileFingerprint=async(file:File):Promise<string>=>{
    const sample=64*1024;
    const first=new Uint8Array(await file.slice(0,sample).arrayBuffer());
    const last=new Uint8Array(await file.slice(Math.max(0,file.size-sample)).arrayBuffer());
    const input=new Uint8Array(first.length+last.length);
    input.set(first);input.set(last,first.length);
    const hash=new Uint8Array(await crypto.subtle.digest("SHA-256",input));
    return Array.from(hash,b=>b.toString(16).padStart(2,"0")).join("");
  };
  const sendResumable=async(r:Row):Promise<void>=>{
    const ctl=new AbortController();r.abort=ctl;
    const key=resumableKey(r);
    const headers={"X-Tsukimera-Request":"1"};
    const readJson=async(res:Response)=>{
      const value=await res.json().catch(()=>({}));
      if(!res.ok)throw new Error(value.error||"HTTP "+res.status);
      return value;
    };
    mark(r,"run","Подготовка загрузки…");
    try{
      const fingerprint=await fileFingerprint(r.file);
      let id="";
      try {
        const saved=JSON.parse(localStorage.getItem(key)||"null");
        if(saved&&typeof saved.id==="string"&&saved.fingerprint===fingerprint)id=saved.id;
      }catch{}
      let status:{id:string;offset:number;size:number;name:string;folder:string}|null=null;
      if(id){
        const response=await fetch("/api/disk/uploads/"+encodeURIComponent(id),{signal:ctl.signal});
        if(response.ok){
          const data=await response.json();
          if(data.size===r.file.size&&data.name===r.file.name&&data.folder===r.folder)status=data;
        }
      }
      if(!status){
        const response=await fetch("/api/disk/uploads",{
          method:"POST",headers:{...headers,"Content-Type":"application/json"},
          body:JSON.stringify({name:r.file.name,folder:r.folder,size:r.file.size}),signal:ctl.signal
        });
        status=await readJson(response);
        id=status.id;
        try{localStorage.setItem(key,JSON.stringify({id,fingerprint}));}catch{}
      }
      let offset=status.offset;
      const CHUNK_SIZE=4*1024*1024;
      while(offset<r.file.size){
        if(ctl.signal.aborted)throw new DOMException("Отменено","AbortError");
        const part=r.file.slice(offset,Math.min(r.file.size,offset+CHUNK_SIZE));
        const response=await fetch("/api/disk/uploads/"+encodeURIComponent(id),{
          method:"PATCH",headers:{...headers,"Content-Type":"application/octet-stream",
            "X-Upload-Offset":String(offset)},
          body:part,signal:ctl.signal
        });
        const updated=await readJson(response);
        if(updated.offset<=offset||updated.offset>r.file.size)throw new Error("Неверный ответ сервера о позиции файла");
        offset=updated.offset;
        const pct=Math.round(offset/r.file.size*100);
        r.bar.style.width=pct+"%";
        r.note.textContent=pct+"% · "+human(offset)+" из "+human(r.file.size);
      }
      const finish=await fetch("/api/disk/uploads/"+encodeURIComponent(id)+"/complete",{
        method:"POST",headers:headers,signal:ctl.signal
      });
      const result=await readJson(finish) as DiskUploaded;
      try{localStorage.removeItem(key);}catch{}
      r.bar.style.width="100%";
      mark(r,"ok",human(r.file.size));
      o.onUploaded(result);
    }catch(error){
      if(ctl.signal.aborted){mark(r,"off","Остановлено. Выберите тот же файл снова для продолжения.");}
      else mark(r,"fail",(error instanceof Error?error.message:"Ошибка")+
        ". Выберите тот же файл снова для продолжения.");
    }finally{r.abort=undefined;}
  };
  const send = (r: Row) => r.file.size>8*1024*1024 ? sendResumable(r) : new Promise<void>((resolve) => {
    const xhr = new XMLHttpRequest();
    r.xhr = xhr;
    xhr.open("POST", "/api/disk/files/binary?name=" + encodeURIComponent(r.file.name) + "&folder=" + encodeURIComponent(r.folder));
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) { const p = Math.round((e.loaded / e.total) * 100); r.bar.style.width = p + "%"; r.note.textContent = p + "%"; } };
    xhr.onload = () => {
      if (xhr.status === 201) {
        r.bar.style.width = "100%";
        mark(r, "ok", human(r.file.size));
        try { o.onUploaded(JSON.parse(xhr.responseText) as DiskUploaded); } catch { /* listed on the next refresh */ }
      } else {
        let why = "Не загрузилось";
        try { why = (JSON.parse(xhr.responseText) as { error?: string }).error ?? why; } catch { /* keep the default */ }
        mark(r, "fail", why);
      }
      resolve();
    };
    xhr.onerror = () => { mark(r, "fail", "Нет связи с Tsukimera"); resolve(); };
    xhr.onabort = () => { mark(r, "off", "Отменено"); resolve(); };
    mark(r, "run", "0%");
    xhr.send(r.file);
  });
  const pump = async () => {
    if (active) return;
    active = true;
    try { for (let r = rows.find((x) => x.state === "wait"); r; r = rows.find((x) => x.state === "wait")) await send(r); }
    finally {
      active = false; o.onIdle();
      // a clean batch tidies itself away; errors stay until the owner reads them
      if (rows.every((r) => r.state === "ok")) setTimeout(() => { if (!running() && rows.every((r) => r.state === "ok")) root.hidden = true; }, 4000);
    }
  };
  return {
    root,
    get busy() { return running(); },
    add(files, folder) { this.addMany(files.map((file) => ({ file, folder }))); },
    addMany(items) {
      if (!items.length) return;
      if (!running()) { rows.length = 0; list.replaceChildren(); }
      for (const { file, folder } of items) {
        const bar = el("i");
        const note = el("small", { cls: "muted" });
        const row: Row = { file, folder, bar, note, state: "wait", root: el("div", { cls: "dk-up-row wait" }) };
        const x = iconButton("x", "Отменить " + file.name, () => stop(row), "icon-btn sm dk-up-stop");
        row.root.append(fileBadge(file.name, 28), el("div", { cls: "dk-up-info" },
          el("span", { cls: "dk-up-name", textContent: file.name, title: (folder ? folder + "/" : "") + file.name }), el("span", { cls: "dk-up-bar" }, bar), note), x);
        rows.push(row); list.append(row.root);
        if (!file.size) mark(row, "fail", "Пустой файл");
        else if (file.size > LIMIT) mark(row, "fail", "Больше 500 МБ");
        else note.textContent = "В очереди";
      }
      root.hidden = false;
      summary();
      void pump();
    },
  };
}

/** Every file of dropped folders with its path inside them («Фото/2024/a.jpg»); stops after `max` files, so a caller seeing `max` knows the folder is bigger. */
export async function readDropped(items: DataTransferItem[], max = 10001): Promise<{ file: File; path: string }[]> {
  const out: { file: File; path: string }[] = [];
  const entries = items.map((it) => it.webkitGetAsEntry?.()).filter((x): x is FileSystemEntry => !!x);
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (out.length >= max) return;
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      out.push({ file, path: prefix + file.name });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries hands out a batch at a time (100 in Chrome) until it returns none
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const child of batch) await walk(child, prefix + entry.name + "/");
      }
    }
  };
  for (const e of entries) await walk(e, "");
  return out;
}
