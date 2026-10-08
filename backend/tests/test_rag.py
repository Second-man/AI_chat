"""RAG acceptance tests: isolated SQLite, fake vectors/model, no network or real keys."""
import asyncio
import hashlib
import os
import sqlite3
import sys
import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from starlette.datastructures import UploadFile


class Vectors:
    def __init__(self):
        self.items = {}
        self.fail_add = False
        self.fail_delete = False
        self.request = None

    def add(self, ids, documents, metadatas):
        for key, document, metadata in zip(ids, documents, metadatas):
            self.items[key] = (document, metadata, [0.1, 0.2])
            if self.fail_add:
                raise RuntimeError("partial embedding failure")

    def get(self, where, include):
        ids = [key for key, value in self.items.items() if value[1]["document_id"] == where["document_id"]]
        return {"ids": ids, "documents": [self.items[key][0] for key in ids],
                "metadatas": [self.items[key][1] for key in ids],
                "embeddings": [self.items[key][2] for key in ids]}

    def delete(self, ids):
        for key in ids:
            self.items.pop(key, None)
            if self.fail_delete:
                self.fail_delete = False
                raise RuntimeError("partial deletion failure")

    def upsert(self, ids, documents, metadatas, embeddings):
        for key, document, metadata, embedding in zip(ids, documents, metadatas, embeddings):
            self.items[key] = (document, metadata, embedding)

    def count(self):
        return len(self.items)

    def query(self, **kwargs):
        self.request = kwargs
        values = list(self.items.values())[:kwargs["n_results"]]
        return {"documents": [[item[0] for item in values]], "metadatas": [[item[1] for item in values]]}


class RagTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        os.environ.setdefault("ECHOMATE_DATA_DIR", self.temp.name)
        sys.path.insert(0, str(Path(__file__).parents[1]))
        import main
        self.api = main
        self.db_patch = patch.object(main, "DB_PATH", Path(self.temp.name) / "test.db")
        self.db_patch.start()
        main.initialize_database()
        self.store = Vectors()
        self.vector_patch = patch.object(main, "collection", return_value=self.store)
        self.vector_patch.start()

    def tearDown(self):
        self.vector_patch.stop()
        self.db_patch.stop()
        self.temp.cleanup()

    def upload(self, text):
        return asyncio.run(self.api.import_document(UploadFile(filename="guide.txt", file=BytesIO(text.encode()))))

    def legacy(self, text):
        with self.api.db() as connection:
            cursor = connection.execute("INSERT INTO documents(file_name, content_hash, chunk_count, created_at) VALUES (?, ?, 1, ?)",
                                        ("guide.txt", hashlib.sha256(text.encode()).hexdigest(), self.api.now()))
            doc_id = cursor.lastrowid
        self.store.add([f"doc-{doc_id}-0"], [text], [{"document_id": str(doc_id), "file_name": "guide.txt", "chunk_index": 0}])
        return doc_id

    def test_chunk_size_overlap_and_duplicate(self):
        text = "".join(chr(0x4e00 + i) for i in range(900))
        result = self.upload(text)
        chunks = [item[0] for item in self.store.items.values()]
        self.assertTrue(all(len(chunk) <= 280 for chunk in chunks))
        self.assertEqual(chunks[0][-60:], chunks[1][:60])
        self.assertFalse(result["updated"])
        self.assertTrue(self.upload(text)["duplicate"])
        self.assertEqual(len(self.store.items), result["chunks"])

    def test_legacy_reimport_replaces_vectors(self):
        text = "旧资料的完整文本。" * 90
        doc_id = self.legacy(text)
        result = self.upload(text)
        self.assertEqual(result["id"], doc_id)
        self.assertTrue(result["updated"])
        self.assertNotIn(f"doc-{doc_id}-0", self.store.items)
        row = self.api.rows("SELECT * FROM documents")[0]
        self.assertEqual(row["chunk_version"], self.api.RAG_CHUNK_VERSION)
        self.assertEqual(row["chunk_count"], len(self.store.items))

    def test_failed_update_preserves_old_data(self):
        text = "旧资料。" * 90
        self.legacy(text)
        before = dict(self.store.items)
        self.store.fail_add = True
        with self.assertRaises(HTTPException):
            self.upload(text)
        self.assertEqual(before, self.store.items)
        self.assertEqual(self.api.rows("SELECT * FROM documents")[0]["chunk_version"], "legacy")

    def test_partial_delete_restores_old_vectors(self):
        text = "旧资料。" * 90
        self.legacy(text)
        before = dict(self.store.items)
        self.store.fail_delete = True
        with self.assertRaises(HTTPException):
            self.upload(text)
        self.assertEqual(before, self.store.items)

    def run_analysis(self, payload):
        captured = []
        class Model:
            def __init__(self, **kwargs): pass
            def invoke(self, messages):
                captured.extend(messages)
                return type("Response", (), {"content": "测试建议"})()
        with patch.object(self.api, "read_api_key", return_value=("test", "test")), patch.object(self.api, "ChatOpenAI", Model):
            result = self.api.analyze(payload)
        return result, captured[-1].content

    def test_last_four_selected_messages_and_complete_chunks(self):
        contact = self.api.create_contact(self.api.ContactPayload(name="甲"))
        other = self.api.create_contact(self.api.ContactPayload(name="乙"))
        ids = []
        for i in range(6):
            ids.append(self.api.save_message(self.api.MessagePayload(contact_id=contact["id"], role="sent" if i % 2 else "received", content=f"选中历史{i}"))["id"])
        excluded = self.api.save_message(self.api.MessagePayload(contact_id=contact["id"], content="未勾选内容"))
        foreign = self.api.save_message(self.api.MessagePayload(contact_id=other["id"], content="另一个联系人内容"))
        excerpts = [f"资料{i}" + "完整片段" * 50 + "末尾关键建议" for i in range(5)]
        self.store.add([str(i) for i in range(5)], excerpts, [{"file_name": "指南"} for _ in range(5)])
        result, prompt = self.run_analysis(self.api.AnalyzePayload(contact_id=contact["id"], content="当前内容", current_role="sent", goal="温和拒绝", message_ids=list(reversed(ids)) + [foreign["id"], ids[0]]))
        query = self.store.request["query_texts"][0]
        self.assertEqual(self.store.request["n_results"], 3)
        self.assertNotIn("选中历史0", query)
        self.assertNotIn("选中历史1", query)
        self.assertIn("对方：选中历史2", query)
        self.assertIn("我：选中历史5", query)
        self.assertLess(query.index("选中历史2"), query.index("选中历史5"))
        self.assertIn("当前消息（我）：当前内容", query)
        self.assertIn("温和拒绝", query)
        self.assertNotIn(f"{excluded['content']}", query + prompt)
        self.assertNotIn(foreign["content"], query + prompt)
        for i in range(6): self.assertIn(f"选中历史{i}", prompt)
        self.assertEqual(result["sent_preview"]["history_count"], 6)
        self.assertEqual([item["excerpt"] for item in result["citations"]], excerpts[:3])
        for excerpt in excerpts[:3]: self.assertIn(excerpt, prompt)
        historical = self.api.list_analyses(contact["id"])
        self.assertEqual(historical[0]["citations"], result["citations"])

    def test_no_history_and_fewer_than_three_vectors(self):
        contact = self.api.create_contact(self.api.ContactPayload(name="甲"))
        self.store.add(["one"], ["唯一资料"], [{"file_name": "指南"}])
        result, _ = self.run_analysis(self.api.AnalyzePayload(contact_id=contact["id"], content="你好"))
        self.assertEqual(self.store.request["n_results"], 1)
        self.assertIn("当前消息（对方）：你好", self.store.request["query_texts"][0])
        self.assertEqual(len(result["citations"]), 1)
        self.store.items.clear()
        result, _ = self.run_analysis(self.api.AnalyzePayload(contact_id=contact["id"], content="你好"))
        self.assertEqual(result["citations"], [])

    def test_migration_marks_existing_documents_legacy(self):
        path = Path(self.temp.name) / "old.db"
        with sqlite3.connect(path) as connection:
            connection.execute("CREATE TABLE documents (id INTEGER PRIMARY KEY, file_name TEXT NOT NULL, content_hash TEXT NOT NULL UNIQUE, chunk_count INTEGER NOT NULL, created_at TEXT NOT NULL)")
            connection.execute("INSERT INTO documents VALUES (1, 'old.txt', 'hash', 4, 'date')")
        connection.close()
        with patch.object(self.api, "DB_PATH", path):
            self.api.initialize_database()
            self.api.initialize_database()
            row = self.api.rows("SELECT * FROM documents")[0]
            self.assertEqual(row["chunk_version"], "legacy")
            self.assertEqual(row["chunk_count"], 4)


if __name__ == "__main__": unittest.main()
