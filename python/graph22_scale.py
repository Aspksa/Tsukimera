"""Bounded SQL graph queries for Tsukimera 22 stage 2.

Only source-backed edges are displayed. The disk catalogue remains authoritative
for live file hashes, including changes not yet consumed by the background queue.
Node/edge payloads are capped before leaving SQLite; no full graph is copied
into Python per viewport change. No external packages or cloud calls.
"""
from __future__ import annotations
from collections import Counter, deque
import math

MAX_VISIBLE = 320
MAX_VIEW_EDGES = 3600
MAX_VISITED = 16000
MAX_NEIGHBORS = 256
COLUMNS = "n.id,n.kind,n.name,n.folder,n.sha,n.origin,n.confidence"


def _scope(folder, alias="n"):
    if not folder:
        return "1=1", []
    # Escape user folder names: % and _ must never match other directories.
    esc = folder.replace("!", "!!").replace("%", "!%").replace("_", "!_")
    return ("(" + alias + ".folder=? OR " + alias + ".folder LIKE ? ESCAPE '!')",
            [folder, esc + "/%"])


def _select_kind(conn, kind, folder, limit, offset=0):
    if limit <= 0:
        return []
    clause, args = _scope(folder)
    return [dict(row) for row in conn.execute(
        "SELECT " + COLUMNS + " FROM graph22_nodes n "
        "WHERE n.kind=? AND " + clause + " ORDER BY n.id LIMIT ? OFFSET ?",
        [kind, *args, limit, offset])]


def _actual_file_sha(conn, node, cache):
    if not node.startswith("file:"):
        return None
    if node not in cache:
        row = conn.execute(
            "SELECT sha256 FROM disk_files WHERE id=? AND deleted_at IS NULL",
            (node[5:],)).fetchone()
        cache[node] = row[0] if row else None
    return cache[node]


def _valid_edge(conn, edge, cache):
    # The real disk_files table wins even while an old graph job is pending.
    for node, sha in ((edge["source"], edge["source_sha"]),
                      (edge["target"], edge["target_sha"])):
        if node.startswith("file:") and (
                not sha or _actual_file_sha(conn, node, cache) != sha):
            return False
    return True


def _degree(conn, node):
    outgoing = conn.execute(
        "SELECT count(*) FROM graph22_edges WHERE source=?", (node,)).fetchone()[0]
    incoming = conn.execute(
        "SELECT count(*) FROM graph22_edges WHERE target=?", (node,)).fetchone()[0]
    return outgoing + incoming


def _community(node):
    folder = node["folder"]
    return "folder:" + folder.split("/", 1)[0] if folder else "root"


def graph_view(conn, *, focus="", folder="", limit=120, level="medium", offset=0):
    limit = max(1, min(MAX_VISIBLE, int(limit)))
    offset = max(0, min(2000000, int(offset)))
    level = level if level in ("far", "medium", "near") else "medium"
    clause, args = _scope(folder)
    base_count = conn.execute(
        "SELECT count(*) FROM graph22_nodes n WHERE n.kind IN ('folder','file') AND "
        + clause, args).fetchone()[0]
    if folder:
        scoped, scoped_args = _scope(folder, "f")
        semantic_total = conn.execute(
            "SELECT count(DISTINCT e.target) FROM graph22_edges e "
            "JOIN graph22_nodes f ON f.id=e.source AND f.kind='file' "
            "JOIN graph22_nodes t ON t.id=e.target "
            "WHERE e.kind='reference' AND t.kind IN ('project','organization') "
            "AND " + scoped, scoped_args).fetchone()[0]
    else:
        semantic_total = conn.execute(
            "SELECT count(*) FROM graph22_nodes WHERE kind IN ('project','organization')"
        ).fetchone()[0]
    total = base_count + semantic_total

    # Stable folder scaffolding, real files and evidenced concepts all receive
    # screen space. offset paginates files, never shifts the folder scaffold.
    folder_budget = min(36, max(1, limit // 5))
    entity_budget = min(48, limit // 5)
    folders = _select_kind(conn, "folder", folder, folder_budget)
    file_budget = max(0, limit - len(folders) - entity_budget)
    files = _select_kind(conn, "file", folder, file_budget, offset)
    remaining = limit - entity_budget - len(folders) - len(files)
    if remaining > 0:
        extra_folders = _select_kind(conn, "folder", folder, remaining, len(folders))
        folders.extend(extra_folders)
        remaining -= len(extra_folders)
    if remaining > 0:
        files.extend(_select_kind(conn, "file", folder, remaining,
                                  offset + len(files)))

    entities = []
    file_ids = [item["id"] for item in files]
    if entity_budget and file_ids:
        marks = ",".join("?" for _ in file_ids)
        entities = [dict(row) for row in conn.execute(
            "SELECT DISTINCT " + COLUMNS + " FROM graph22_nodes n "
            "JOIN graph22_edges e ON e.target=n.id "
            "WHERE e.kind='reference' AND e.source IN (" + marks + ") "
            "AND n.kind IN ('project','organization') "
            "ORDER BY n.id LIMIT ?", [*file_ids, entity_budget])]
    selected = folders + files + entities

    # No empty space on a disk with no relevant semantic nodes.
    spare = limit - len(selected)
    if spare > 0:
        additional = _select_kind(conn, "file", folder, spare,
                                  offset + len(files))
        selected.extend(additional)
        spare -= len(additional)
    if spare > 0:
        selected.extend(_select_kind(conn, "folder", folder, spare, len(folders)))

    # Focused nodes are included only if they really exist. A focus outside
    # the visible slice replaces one slot, rather than bypassing the cap.
    ids = {item["id"] for item in selected}
    if focus and focus not in ids:
        hit = conn.execute(
            "SELECT " + COLUMNS + " FROM graph22_nodes n WHERE n.id=?",
            (focus,)).fetchone()
        if hit:
            if len(selected) >= limit:
                selected.pop()
            selected.append(dict(hit))
        else:
            focus = ""
    ids = {item["id"] for item in selected}
    if not ids:
        return {"nodes": [], "links": [], "clusters": [], "total": total,
                "visible": 0, "omitted": total, "level": level,
                "focus": focus, "folder": folder, "offset": offset,
                "truncated": False, "source": "sqlite-python-22",
                "queryMode": "bounded-sql"}
    marks = ",".join("?" for _ in ids)
    ordered_ids = sorted(ids)
    marks = ",".join("?" for _ in ordered_ids)
    raw_edges = [dict(row) for row in conn.execute(
        "SELECT * FROM graph22_edges WHERE source IN (" + marks +
        ") AND target IN (" + marks + ") "
        "ORDER BY confidence DESC,source,target,kind LIMIT ?",
        [*ordered_ids, *ordered_ids, MAX_VIEW_EDGES + 1])]
    truncated_edges = len(raw_edges) > MAX_VIEW_EDGES
    sha_cache = {}
    edges = [edge for edge in raw_edges[:MAX_VIEW_EDGES]
             if _valid_edge(conn, edge, sha_cache)]
    if level == "far":
        edges = [edge for edge in edges
                 if edge["kind"] in ("contains", "contract", "duplicate")]

    memberships = {item["id"]: _community(item) for item in selected}
    votes = {}
    for edge in edges:
        for src, dst in ((edge["source"], edge["target"]),
                         (edge["target"], edge["source"])):
            if not (src.startswith("project:") or src.startswith("organization:")):
                continue
            if dst.startswith("file:"):
                votes.setdefault(src, Counter())[memberships.get(dst, "root")] += 1
    for node, tally in votes.items():
        memberships[node] = sorted(tally.items(), key=lambda x: (-x[1], x[0]))[0][0]
    for item in selected:
        degree = _degree(conn, item["id"])
        item["degree"] = degree
        item["community"] = memberships.get(item["id"], "root")
        item["importance"] = min(3, round(1 + math.log1p(degree) / 3, 3))

    # Aggregate in SQLite: do not transfer the entire catalogue to Python.
    clusters = [dict(row) for row in conn.execute(
        "SELECT CASE WHEN instr(n.folder,'/')>0 "
        "THEN 'folder:'||substr(n.folder,1,instr(n.folder,'/')-1) "
        "WHEN n.folder='' THEN 'root' ELSE 'folder:'||n.folder END AS id, "
        "count(*) AS count FROM graph22_nodes n "
        "WHERE n.kind IN ('folder','file') AND " + clause +
        " GROUP BY 1 ORDER BY count DESC,1 LIMIT 80", args)]
    visual = [{"source": e["source"], "target": e["target"],
               "kind": e["kind"], "weight": e["confidence"],
               "confidence": e["confidence"], "evidence": e["evidence"],
               "origin": e["origin"]} for e in edges]
    return {"nodes": selected, "links": visual, "clusters": clusters,
            "total": total, "visible": len(selected),
            "omitted": max(0, total - len(selected)),
            "level": level, "focus": focus, "folder": folder, "offset": offset,
            "truncated": truncated_edges, "source": "sqlite-python-22",
            "queryMode": "bounded-sql"}


def shortest_path(conn, source, target, max_hops=8):
    max_hops = max(1, min(12, int(max_hops)))
    if not source or not target or len(source) > 180 or len(target) > 180:
        return {"found": False, "reason": "invalid-node"}
    exists = conn.execute("SELECT count(*) FROM graph22_nodes WHERE id IN (?,?)",
                          (source, target)).fetchone()[0]
    if exists < (1 if source == target else 2):
        return {"found": False, "reason": "unknown-node"}
    if source == target:
        return {"found": True, "nodes": [source], "links": []}
    queue = deque([(source, [])])
    seen = {source}
    sha_cache = {}
    incomplete = False
    while queue:
        node, path = queue.popleft()
        if len(path) >= max_hops:
            continue
        choices = conn.execute(
            "SELECT * FROM graph22_edges WHERE source=? OR target=? "
            "ORDER BY confidence DESC,source,target LIMIT ?",
            (node, node, MAX_NEIGHBORS + 1)).fetchall()
        if len(choices) > MAX_NEIGHBORS:
            incomplete = True
        for edge in choices[:MAX_NEIGHBORS]:
            if not _valid_edge(conn, edge, sha_cache):
                continue
            nxt = edge["target"] if edge["source"] == node else edge["source"]
            if nxt in seen:
                continue
            if not conn.execute("SELECT 1 FROM graph22_nodes WHERE id=?",
                                (nxt,)).fetchone():
                continue
            new_path = path + [(nxt, edge)]
            if nxt == target:
                return {"found": True,
                        "nodes": [source] + [item for item, _ in new_path],
                        "links": [{"source": e["source"], "target": e["target"],
                                   "kind": e["kind"], "evidence": e["evidence"],
                                   "confidence": e["confidence"]}
                                  for _, e in new_path]}
            seen.add(nxt)
            if len(seen) >= MAX_VISITED:
                return {"found": False, "reason": "search-limit",
                        "visited": len(seen)}
            queue.append((nxt, new_path))
    return {"found": False,
            "reason": "search-limit" if incomplete else "no-evidenced-path",
            "visited": len(seen)}


def direct_impact(conn, node):
    if not node or len(node) > 180:
        return {"node": node, "connections": [], "truncated": False}
    rows = conn.execute(
        "SELECT * FROM graph22_edges WHERE source=? OR target=? "
        "ORDER BY confidence DESC,source,target LIMIT 81",
        (node, node)).fetchall()
    sha_cache = {}
    connections = [dict(edge) for edge in rows[:80]
                   if _valid_edge(conn, edge, sha_cache)]
    return {"node": node, "connections": connections,
            "truncated": len(rows) > 80}
