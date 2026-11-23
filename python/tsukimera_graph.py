"""Tsukimera Graph 22: stdlib-only, bounded, source-backed SQLite graph engine.

This is the first stage of migrating graph computation to Python. The legacy
Node HTTP/Disk API is intentionally kept intact until all mutating endpoints,
settings, uploads and Windows launch parity can be safely ported.
"""
from __future__ import annotations
import argparse
import collections
import hashlib
import json
import math
import os
import sqlite3
import sys
import time
from datetime import datetime, timezone

MAX_BATCH = 100
MAX_VISIBLE = 320
MAX_BFS = 16000
EVIDENCE_LIMIT = 320
ALLOWED_KINDS = {"contains", "contract", "organization", "duplicate", "reference"}
SCHEMA = """
CREATE TABLE IF NOT EXISTS graph22_processed (
 file_id TEXT PRIMARY KEY, stamp TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS graph22_nodes (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL,
 folder TEXT NOT NULL DEFAULT '', sha TEXT NOT NULL DEFAULT '',
 origin TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 1,
 updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS graph22_edges (
 source TEXT NOT NULL, target TEXT NOT NULL, kind TEXT NOT NULL,
 token TEXT NOT NULL, evidence TEXT NOT NULL, confidence REAL NOT NULL,
 origin TEXT NOT NULL, source_sha TEXT NOT NULL DEFAULT '',
 target_sha TEXT NOT NULL DEFAULT '',
 PRIMARY KEY(source,target,kind,token)
);
CREATE INDEX IF NOT EXISTS graph22_edge_target ON graph22_edges(target);
CREATE INDEX IF NOT EXISTS graph22_node_kind ON graph22_nodes(kind,folder);
CREATE INDEX IF NOT EXISTS graph22_node_folder_kind ON graph22_nodes(folder,kind,id);
CREATE INDEX IF NOT EXISTS graph22_edge_kind_target ON graph22_edges(kind,target);
CREATE TABLE IF NOT EXISTS graph22_journal (
 id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, file_id TEXT NOT NULL,
 action TEXT NOT NULL, previous_stamp TEXT, new_stamp TEXT
);
CREATE TABLE IF NOT EXISTS graph22_queue (
 file_id TEXT PRIMARY KEY, stamp TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending',
 attempts INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
);
"""
def utc():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")
def digest(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()
def json_safe(value):
    return json.dumps(value, ensure_ascii=False, separators=(",",":"))
def connect(db_path, *, readonly=False):
    if not os.path.isfile(db_path):
        raise FileNotFoundError("SQLite archive does not exist")
    if readonly:
        conn=sqlite3.connect("file:"+__import__("urllib.parse", fromlist=["quote"]).quote(
            os.path.abspath(db_path), safe="/:\\") + "?mode=ro",uri=True,timeout=3)
    else:
        conn=sqlite3.connect(db_path,timeout=5,isolation_level=None)
    conn.row_factory=sqlite3.Row
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA foreign_keys=ON")
    if not readonly:
        conn.execute("PRAGMA journal_mode=WAL")
    return conn
def tables_ready(conn):
    names={r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type IN ('table','view')")}
    needed={"disk_files","disk_knowledge_docs","disk_knowledge_facts","disk_knowledge_links"}
    return needed.issubset(names)
def init(conn):
    if not tables_ready(conn):
        raise RuntimeError("Disk catalogue is not initialized; open Tsukimera first")
    conn.executescript(SCHEMA)
    # Recover a job abandoned by a process crash.
    conn.execute("UPDATE graph22_queue SET status='pending' WHERE status='running'")
def source_rows(conn):
    sql="""SELECT f.id,f.name,f.folder,f.sha256 AS sha,
      coalesce(k.processed_at,'') AS analyzed
      FROM disk_files f LEFT JOIN disk_knowledge_docs k
        ON k.file_id=f.id AND k.sha=f.sha256
      WHERE f.deleted_at IS NULL ORDER BY f.id"""
    return {r["id"]:dict(r) for r in conn.execute(sql)}
def stamp(row):
    return digest(json_safe([row["sha"],row["name"],row["folder"],row["analyzed"]]))
def file_node(id):
    return "file:"+id
def folder_node(path):
    return "folder:"+path
def knowledge_node(kind,token):
    return ("project:" if kind=="contract" else "organization:")+digest(token)[:24]
def upsert_node(conn,id,kind,name,folder="",sha="",origin="catalog",confidence=1):
    conn.execute("""INSERT INTO graph22_nodes VALUES(?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,name=excluded.name,
       folder=excluded.folder,sha=excluded.sha,origin=excluded.origin,
       confidence=excluded.confidence,updated_at=excluded.updated_at
       WHERE graph22_nodes.kind<>excluded.kind OR
         graph22_nodes.name<>excluded.name OR
         graph22_nodes.folder<>excluded.folder OR
         graph22_nodes.sha<>excluded.sha OR
         graph22_nodes.origin<>excluded.origin OR
         graph22_nodes.confidence<>excluded.confidence""",
       (id,kind,name[:180],folder,sha,origin,confidence,utc()))
def canonical_edge(source,target,kind,token,evidence,confidence,origin,sha1="",sha2=""):
    # Direction is meaningful for folder->file, file->entity, not duplicates.
    if kind=="duplicate" and source>target:
        source,target=target,source
        sha1,sha2=sha2,sha1
    return (source,target,kind,token[:120],evidence[:EVIDENCE_LIMIT],
            max(0.,min(1.,float(confidence))),origin,sha1,sha2)
def insert_edge(conn,*edge):
    conn.execute("""INSERT INTO graph22_edges VALUES(?,?,?,?,?,?,?,?,?)
        ON CONFLICT(source,target,kind,token) DO UPDATE SET
        evidence=excluded.evidence,confidence=excluded.confidence,
        origin=excluded.origin,source_sha=excluded.source_sha,target_sha=excluded.target_sha
        WHERE graph22_edges.evidence<>excluded.evidence OR
         graph22_edges.confidence<>excluded.confidence OR
         graph22_edges.source_sha<>excluded.source_sha OR
         graph22_edges.target_sha<>excluded.target_sha""",edge)
def folder_paths(path):
    seg=path.split("/") if path else []
    return ["/".join(seg[:i]) for i in range(1,len(seg)+1)]
def invalidate(conn,id):
    node=file_node(id)
    conn.execute("DELETE FROM graph22_edges WHERE source=? OR target=?",(node,node))
    conn.execute("DELETE FROM graph22_nodes WHERE id=?",(node,))
def reconcile_queue(conn,live):
    processed={r["file_id"]:r["stamp"] for r in conn.execute(
        "SELECT file_id,stamp FROM graph22_processed")}
    obsolete=set(processed)-set(live)
    for id in sorted(obsolete):
        invalidate(conn,id)
        conn.execute("DELETE FROM graph22_processed WHERE file_id=?",(id,))
        conn.execute("DELETE FROM graph22_queue WHERE file_id=?",(id,))
        conn.execute("INSERT INTO graph22_journal(at,file_id,action,previous_stamp,new_stamp) VALUES(?,?,?,?,?)",
                     (utc(),id,"removed",processed[id],None))
    for id,row in live.items():
        new=stamp(row)
        if new==processed.get(id):
            conn.execute("DELETE FROM graph22_queue WHERE file_id=? AND stamp<>?",(id,new))
            continue
        conn.execute("""INSERT INTO graph22_queue(file_id,stamp,status,attempts,updated_at)
          VALUES(?,?,'pending',0,?) ON CONFLICT(file_id) DO UPDATE SET
          stamp=excluded.stamp,status='pending',attempts=0,updated_at=excluded.updated_at
          WHERE graph22_queue.stamp<>excluded.stamp""",(id,new,utc()))
def _edges_for(conn,row,live):
    fid=file_node(row["id"])
    # Containment always comes from the actual file folder.
    parent=folder_node(row["folder"])
    insert_edge(conn,*canonical_edge(parent,fid,"contains","folder",
        "Реальное расположение в папке: "+(row["folder"] or "Корень"),
        1,"disk_files","",row["sha"]))
    for link in conn.execute("""SELECT l.left_id,l.right_id,l.kind,l.token,l.evidence,l.confidence
      FROM disk_knowledge_links l WHERE l.left_id=? OR l.right_id=?
      ORDER BY l.confidence DESC LIMIT 200""",(row["id"],row["id"])):
        a=live.get(link["left_id"]);b=live.get(link["right_id"])
        if not a or not b or a["analyzed"]=="" or b["analyzed"]=="":
            continue
        # Only explicitly evidenced pair edges; no co-mention inference.
        kind=link["kind"]
        if kind not in ("contract","organization"):
            continue
        first,second=sorted((a["id"],b["id"]))
        label=("Одинаковый номер договора: " if kind=="contract" else
               "Совпадающее написание организации (не идентификация): ")
        insert_edge(conn,*canonical_edge(file_node(first),file_node(second),
            kind,link["token"],label+link["evidence"],
            min(float(link["confidence"]),.94 if kind=="contract" else .79),
            "disk_knowledge_links",a["sha"] if first==a["id"] else b["sha"],
            b["sha"] if second==b["id"] else a["sha"]))
    facts=conn.execute("""SELECT kind,value_key,value,evidence,certainty
     FROM disk_knowledge_facts WHERE file_id=? AND kind IN ('contract','organization')
     ORDER BY kind,value_key LIMIT 70""",(row["id"],)).fetchall()
    for f in facts:
        id=knowledge_node(f["kind"],f["value_key"])
        kind="project" if f["kind"]=="contract" else "organization"
        label=("Договор №" if kind=="project" else "Организация: ")+f["value"]
        upsert_node(conn,id,kind,label,origin="disk_knowledge_facts",
                    confidence=float(f["certainty"]))
        insert_edge(conn,*canonical_edge(fid,id,"reference",f["value_key"],
            f["evidence"],f["certainty"],"disk_knowledge_facts",row["sha"],""))
    # Exact duplicates require matching hashes; ignore shared vocabulary.
    for peer in conn.execute("""SELECT id FROM disk_files WHERE sha256=?
      AND id<>? AND deleted_at IS NULL ORDER BY id LIMIT 30""",(row["sha"],row["id"])):
        other=live.get(peer["id"])
        if other:
            insert_edge(conn,*canonical_edge(fid,file_node(other["id"]),
                "duplicate",row["sha"],
                "Совпадает SHA-256 оригинального содержимого",1,"disk_files",
                row["sha"],other["sha"]))
def sync(conn,batch=25):
    init(conn)
    live=source_rows(conn)
    conn.execute("BEGIN IMMEDIATE")
    try:
        reconcile_queue(conn,live)
        # Complete parent hierarchy is a virtual structure from real names.
        names={""}
        for row in live.values():
            names.update(folder_paths(row["folder"]))
        names.update(r[0] for r in conn.execute("SELECT name FROM disk_folders"))
        active_folders={folder_node(path) for path in names}
        for old in conn.execute("SELECT id FROM graph22_nodes WHERE kind='folder'"):
            if old["id"] not in active_folders:
                conn.execute("DELETE FROM graph22_edges WHERE source=? OR target=?",
                             (old["id"],old["id"]))
                conn.execute("DELETE FROM graph22_nodes WHERE id=?",(old["id"],))
        for path in sorted(names):
            upsert_node(conn,folder_node(path),"folder",
                path.rsplit("/",1)[-1] if path else "Диск",path,origin="disk_folders")
        for path in sorted(names):
            if path:
                parent=path.rpartition("/")[0]
                insert_edge(conn,*canonical_edge(folder_node(parent),folder_node(path),
                    "contains","folder-tree","Реальная иерархия папок",1,"disk_folders"))
        selected=conn.execute("""SELECT file_id,stamp FROM graph22_queue
          WHERE status='pending' ORDER BY updated_at,file_id LIMIT ?""",
          (max(1,min(MAX_BATCH,int(batch))),)).fetchall()
        done=0
        for job in selected:
            id=job["file_id"];row=live.get(id)
            if not row:
                conn.execute("DELETE FROM graph22_queue WHERE file_id=?",(id,))
                continue
            conn.execute("UPDATE graph22_queue SET status='running',attempts=attempts+1 WHERE file_id=?",(id,))
            previous=conn.execute("SELECT stamp FROM graph22_processed WHERE file_id=?",(id,)).fetchone()
            invalidate(conn,id)
            upsert_node(conn,file_node(id),"file",row["name"],row["folder"],row["sha"])
            _edges_for(conn,row,live)
            conn.execute("INSERT INTO graph22_processed VALUES(?,?,?) "+
                "ON CONFLICT(file_id) DO UPDATE SET stamp=excluded.stamp,updated_at=excluded.updated_at",
                (id,job["stamp"],utc()))
            conn.execute("DELETE FROM graph22_queue WHERE file_id=?",(id,))
            if previous is None or previous["stamp"]!=job["stamp"]:
                conn.execute("INSERT INTO graph22_journal(at,file_id,action,previous_stamp,new_stamp) VALUES(?,?,?,?,?)",
                    (utc(),id,"added" if previous is None else "updated",
                     previous["stamp"] if previous else None,job["stamp"]))
            done+=1
        # Prune knowledge nodes and orphaned old folder nodes safely.
        conn.execute("""DELETE FROM graph22_nodes WHERE kind IN ('project','organization')
          AND id NOT IN (SELECT target FROM graph22_edges WHERE kind='reference')""")
        conn.execute("""DELETE FROM graph22_nodes WHERE kind='folder'
          AND id NOT IN (SELECT source FROM graph22_edges UNION SELECT target FROM graph22_edges)
          AND id <> 'folder:'""")
        pending=conn.execute("SELECT count(*) FROM graph22_queue WHERE status='pending'").fetchone()[0]
        conn.execute("COMMIT")
        return {"processed":done,"pending":pending,"files":len(live),"at":utc()}
    except Exception:
        conn.execute("ROLLBACK")
        raise
def graph(conn,*,focus="",folder="",limit=120,level="medium",offset=0):
    # Stage 2 SQL-backed visibility; no Python-side full table/edge scans.
    from graph22_scale import graph_view
    return graph_view(conn,focus=focus,folder=folder,limit=limit,
                      level=level,offset=offset)


def shortest(conn,source,target,max_hops=8):
    from graph22_scale import shortest_path
    return shortest_path(conn,source,target,max_hops)


def diagnosis(conn):
    orphan=conn.execute("""SELECT count(*) FROM graph22_nodes n WHERE n.kind='file'
      AND NOT EXISTS(SELECT 1 FROM graph22_edges e WHERE
         (e.source=n.id OR e.target=n.id) AND e.kind<>'contains')""").fetchone()[0]
    broken=conn.execute("""SELECT count(*) FROM graph22_edges e
      LEFT JOIN graph22_nodes a ON a.id=e.source LEFT JOIN graph22_nodes b ON b.id=e.target
      WHERE a.id IS NULL OR b.id IS NULL""").fetchone()[0]
    count=conn.execute("SELECT count(*) FROM graph22_nodes").fetchone()[0]
    edge_count=conn.execute("SELECT count(*) FROM graph22_edges").fetchone()[0]
    queued=conn.execute("SELECT count(*) FROM graph22_queue").fetchone()[0]
    return {"nodes":count,"edges":edge_count,"pending":queued,
            "isolatedSemanticFiles":orphan,"danglingEdges":broken,
            "status":"ok" if not broken else "needs-repair"}
def timeline(conn,limit=40):
    return [dict(x) for x in conn.execute(
      "SELECT at,file_id,action FROM graph22_journal ORDER BY id DESC LIMIT ?",
      (max(1,min(200,int(limit))),))]
def impact(conn,id):
    from graph22_scale import direct_impact
    return direct_impact(conn,id)


def contradictions(conn,limit=35):
    """Review candidates only, never certified legal contradictions."""
    rows=conn.execute("""SELECT f.file_id,f.value_key,f.value,
       f.evidence, c.value_key AS contract
       FROM disk_knowledge_facts f
       JOIN disk_knowledge_facts c ON c.file_id=f.file_id
       JOIN disk_files d ON d.id=f.file_id AND d.deleted_at IS NULL
       WHERE f.kind='amount' AND c.kind='contract'
       ORDER BY c.value_key,f.file_id LIMIT 2200""").fetchall()
    by_contract=collections.defaultdict(list)
    for r in rows:
        by_contract[r["contract"]].append(dict(r))
    suggestions=[]
    for contract in sorted(by_contract):
        files=by_contract[contract]
        by_amount=collections.defaultdict(list)
        for f in files:by_amount[f["value_key"]].append(f)
        if len(by_amount)<2:continue
        different=list(by_amount.values())
        if different[0][0]["file_id"]==different[1][0]["file_id"]:
            continue
        first,second=different[0][0],different[1][0]
        suggestions.append({
          "kind":"possible-amount-conflict","contract":contract,
          "documentIds":[first["file_id"],second["file_id"]],
          "values":[first["value"],second["value"]],
          "evidence":[first["evidence"],second["evidence"]],
          "confidence":"review-only",
          "explanation":"Разные суммы с общим номером договора; допустимы разные акты и редакции"
        })
        if len(suggestions)>=max(1,min(100,int(limit))):break
    return {"candidates":suggestions,"confirmed":0,"automaticChanges":0}

def command(db_path,action,**opts):
    conn=connect(db_path)
    try:
        if action=="sync":
            return sync(conn,opts.get("batch",25))
        if action=="view":
            # Reconcile a bounded batch for cold start and newly changed files.
            progress=sync(conn,opts.get("batch",20))
            value=graph(conn,focus=opts.get("focus",""),
                folder=opts.get("folder",""),limit=opts.get("limit",120),
                level=opts.get("level","medium"),offset=opts.get("offset",0))
            value["progress"]=progress
            return value
        init(conn)
        if action=="path":return shortest(conn,opts.get("source",""),opts.get("target",""))
        if action=="impact":return impact(conn,opts.get("source",""))
        if action=="timeline":return {"events":timeline(conn,opts.get("limit",40))}
        if action=="diagnose":return diagnosis(conn)
        if action=="contradictions":return contradictions(conn,opts.get("limit",35))
        raise ValueError("unsupported operation")
    finally:conn.close()
def main():
    parser=argparse.ArgumentParser(description="Local source-backed Tsukimera graph engine")
    parser.add_argument("--db",required=True)
    parser.add_argument("--action",choices=["sync","view","path","impact","timeline","diagnose","contradictions"],
                        default="view")
    parser.add_argument("--batch",type=int,default=20)
    parser.add_argument("--limit",type=int,default=120)
    parser.add_argument("--offset",type=int,default=0)
    parser.add_argument("--level",choices=["far","medium","near"],default="medium")
    parser.add_argument("--folder",default="")
    parser.add_argument("--focus",default="")
    parser.add_argument("--source",default="")
    parser.add_argument("--target",default="")
    args=parser.parse_args()
    try:
        kwargs=vars(args).copy();kwargs.pop('db');kwargs.pop('action')
        result=command(args.db,args.action,**kwargs)
        print(json_safe({"ok":True,"data":result}))
    except (OSError,sqlite3.Error,ValueError,RuntimeError) as ex:
        print(json_safe({"ok":False,"error":type(ex).__name__+": "+str(ex)[:180]}))
        sys.exit(1)
if __name__=="__main__":main()
