"""Disk 22: exercise Python graph against actual SQLite tables, no dependencies."""
import os, sys, sqlite3, tempfile, unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from tsukimera_graph import sync, graph, shortest, impact, timeline, diagnosis, folder_node, file_node, knowledge_node
BASE = """
CREATE TABLE disk_files(
 id TEXT PRIMARY KEY,name TEXT NOT NULL,folder TEXT NOT NULL,
 size INTEGER NOT NULL,sha256 TEXT NOT NULL,deleted_at TEXT,uploaded_at TEXT NOT NULL);
CREATE TABLE disk_folders(name TEXT PRIMARY KEY,style_json TEXT);
CREATE TABLE disk_knowledge_docs(file_id TEXT PRIMARY KEY,sha TEXT NOT NULL,
 type TEXT NOT NULL,summary TEXT NOT NULL,tokens TEXT NOT NULL,processed_at TEXT NOT NULL);
CREATE TABLE disk_knowledge_facts(file_id TEXT NOT NULL,kind TEXT NOT NULL,
 value_key TEXT NOT NULL,value TEXT NOT NULL,evidence TEXT NOT NULL,
 position INTEGER NOT NULL,certainty REAL NOT NULL,
 PRIMARY KEY(file_id,kind,value_key));
CREATE TABLE disk_knowledge_links(left_id TEXT NOT NULL,right_id TEXT NOT NULL,
 kind TEXT NOT NULL,token TEXT NOT NULL,evidence TEXT NOT NULL,
 confidence REAL NOT NULL,PRIMARY KEY(left_id,right_id,kind,token));
"""
class Graph22(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.conn=sqlite3.connect(os.path.join(self.tmp.name,"disk.db"),
                                  isolation_level=None)
        self.conn.row_factory=sqlite3.Row
        self.conn.executescript(BASE)
        self.ids=["a"*36,"b"*36,"c"*36]
        self.sha=["1"*64,"2"*64,"1"*64]
        names=["Договор №57/2026.txt","Акт №2.txt","Копия договора.txt"]
        folders=["Договоры/2026","Акты","Договоры/2026"]
        for id,name,folder,sha in zip(self.ids,names,folders,self.sha):
            self.conn.execute("INSERT INTO disk_files VALUES(?,?,?,?,?,NULL,?)",
                (id,name,folder,100,sha,"2026-11-23"))
            self.conn.execute("INSERT INTO disk_knowledge_docs VALUES(?,?,?,?,?,?)",
                (id,sha,"contract" if id==self.ids[0] else "act",
                 "Содержит договор №57/2026","[]","2026-11-23"))
            self.conn.execute("INSERT INTO disk_knowledge_facts VALUES(?,?,?,?,?,?,?)",
                (id,"contract","57/2026","57/2026","Договор №57/2026",0,.94))
        self.conn.execute("INSERT INTO disk_knowledge_links VALUES(?,?,?,?,?,?)",
            (self.ids[0],self.ids[1],"contract","57/2026",
             "Одинаковый номер договора №57/2026",.94))
        self.conn.execute("INSERT INTO disk_knowledge_links VALUES(?,?,?,?,?,?)",
            (self.ids[0],self.ids[2],"organization","ромашка",
             "Совпадающее написание организации",.75))
        self.conn.execute("INSERT INTO disk_folders VALUES(?,NULL)",("Пустая",))
    def tearDown(self):
        self.conn.close();self.tmp.cleanup()
    def drain(self):
        for _ in range(8):
            result=sync(self.conn,1)
            if result["pending"]==0:return result
        self.fail("Graph queue failed to resume")
    def test_incremental_provenance_path_and_hierarchy(self):
        first=sync(self.conn,1)
        self.assertEqual(first["processed"],1)
        self.assertEqual(first["pending"],2)
        self.drain()
        d=diagnosis(self.conn)
        self.assertEqual(d["status"],"ok")
        self.assertEqual(d["pending"],0)
        nodes=graph(self.conn,limit=100)
        self.assertTrue(any(n["id"]==folder_node("Договоры/2026") for n in nodes["nodes"]))
        self.assertTrue(any(n["id"]==folder_node("Пустая") for n in nodes["nodes"]) or
                        any(n["id"]==folder_node("Договоры") for n in nodes["nodes"]))
        self.assertTrue(any(e["kind"]=="contract" and
                            e["evidence"].startswith("Одинаковый")
                            for e in nodes["links"]))
        hub=knowledge_node("contract","57/2026")
        evidence=shortest(self.conn,file_node(self.ids[0]),hub)
        self.assertTrue(evidence["found"])
        self.assertTrue(all(e["evidence"] for e in evidence["links"]))
        self.assertTrue(impact(self.conn,file_node(self.ids[0]))["connections"])
        history=timeline(self.conn)
        self.assertEqual(len(history),3)
        self.assertTrue(all(e["action"]=="added" for e in history))
        self.assertLessEqual(graph(self.conn,limit=1)["visible"],1)
        self.assertGreater(graph(self.conn,limit=1)["omitted"],0)
        self.assertEqual(graph(self.conn,limit=10,level="far")["level"],"far")
    def test_changes_invalidate_stale_links_and_recover_queue(self):
        self.drain()
        a,b,c=self.ids
        before=shortest(self.conn,file_node(a),file_node(b))
        self.assertTrue(before["found"])
        # Simulate a new revision arriving before its text has been indexed.
        self.conn.execute("UPDATE disk_files SET sha256=? WHERE id=?",("3"*64,b))
        self.conn.execute("DELETE FROM disk_knowledge_docs WHERE file_id=?",(b,))
        self.drain()
        direct=self.conn.execute("SELECT count(*) FROM graph22_edges WHERE "+
            "kind='contract' AND (source=? OR target=?)",
            (file_node(b),file_node(b))).fetchone()[0]
        self.assertEqual(direct,0)
        self.assertNotIn(file_node(b),[x["target"] for x in
            self.conn.execute("SELECT target FROM graph22_edges WHERE kind='contract'")])
        changed=timeline(self.conn)
        self.assertTrue(any(x["action"]=="updated" and x["file_id"]==b for x in changed))
        # Delete a user file; original disk_files remains untouched by graph.
        self.conn.execute("UPDATE disk_files SET deleted_at='2026-11-23' WHERE id=?",(c,))
        self.drain()
        self.assertEqual(self.conn.execute(
            "SELECT count(*) FROM graph22_nodes WHERE id=?",(file_node(c),)).fetchone()[0],0)
        self.assertEqual(self.conn.execute(
            "SELECT count(*) FROM disk_files WHERE id=?",(c,)).fetchone()[0],1)
    def test_no_fabricated_links_and_determinism(self):
        self.drain()
        result=graph(self.conn,folder="Акты",limit=60)
        self.assertTrue(all(n["folder"]=="Акты" or
          n["id"]==folder_node("Акты") for n in result["nodes"]))
        no=shortest(self.conn,"file:unknown","file:also-unknown")
        self.assertFalse(no["found"])
        initial=graph(self.conn,limit=50)
        later=graph(self.conn,limit=50)
        self.assertEqual([(n["id"],n["community"]) for n in initial["nodes"]],
                         [(n["id"],n["community"]) for n in later["nodes"]])
        self.assertEqual(sync(self.conn,20)["processed"],0)
    def test_stage2_sql_view_reserves_evidence_and_blocks_stale_hashes(self):
        self.drain()
        scene=graph(self.conn,limit=12,level="near")
        self.assertEqual(scene["queryMode"],"bounded-sql")
        self.assertLessEqual(scene["visible"],12)
        self.assertTrue(any(n["kind"]=="project" for n in scene["nodes"]))
        self.assertTrue(any(edge["kind"]=="reference" for edge in scene["links"]))
        # The disk changes before the background Python queue can reconcile it.
        # Old graph22_nodes still have the old SHA, which must NOT prove an edge.
        changed=self.ids[1]
        self.conn.execute("UPDATE disk_files SET sha256=? WHERE id=?",
                          ("9"*64,changed))
        stale=graph(self.conn,limit=16,level="near")
        self.assertFalse(any(e["source"]==file_node(changed) or
                             e["target"]==file_node(changed)
                             for e in stale["links"]))
        self.assertFalse(shortest(self.conn,file_node(changed),
                                  knowledge_node("contract","57/2026"))["found"])
        self.assertFalse(impact(self.conn,file_node(changed))["connections"])

    def test_stage2_scope_escapes_wildcards_and_pages_without_duplicates(self):
        self.drain()
        for i,folder in enumerate(("Про%цент","ПроXцент","Про_цент")):
            id=(str(i+1)*36)
            self.conn.execute("INSERT INTO disk_files VALUES(?,?,?,?,?,NULL,?)",
                              (id,"Файл "+str(i),folder,10,str(i+4)*64,"2026-11-23"))
        self.drain()
        filtered=graph(self.conn,folder="Про%цент",limit=24)
        file_ids=[n["id"] for n in filtered["nodes"] if n["kind"]=="file"]
        self.assertEqual(file_ids,[file_node("1"*36)])
        self.assertEqual(filtered["total"],2)  # file and its folder node
        # File pagination retains a stable folder scaffold and excludes a
        # previously visible document from later pages.
        first=graph(self.conn,limit=4,offset=0)
        second=graph(self.conn,limit=4,offset=3)
        first_files={n["id"] for n in first["nodes"] if n["kind"]=="file"}
        second_files={n["id"] for n in second["nodes"] if n["kind"]=="file"}
        self.assertFalse(first_files & second_files)

    def test_stage2_indexed_path_is_not_cut_off_by_unrelated_edges(self):
        self.drain()
        with self.conn:
            for i in range(1200):
                node="folder:лишнее/"+str(i)
                self.conn.execute("INSERT INTO graph22_nodes VALUES(?,?,?,?,?,?,?,?)",
                                  (node,"folder",str(i),"лишнее","",
                                   "fixture",1,"2026-11-23"))
                self.conn.execute("INSERT INTO graph22_edges VALUES(?,?,?,?,?,?,?,?,?)",
                                  ("folder:",node,"contains","folder-tree",
                                   "Отдельная проверочная ветка",1,"fixture","",""))
        path=shortest(self.conn,file_node(self.ids[0]),
                      knowledge_node("contract","57/2026"))
        self.assertTrue(path["found"])
        self.assertEqual(len(path["links"]),1)
        scene=graph(self.conn,limit=22)
        self.assertLessEqual(scene["visible"],22)
        self.assertGreater(scene["omitted"],1000)

if __name__=="__main__":
    unittest.main()
