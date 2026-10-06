"""Offline acceptance tests for EchoMate's local workflow.

Run with: `D:\\AI_\\.venv\\python.exe -m unittest discover -s backend/tests -v`
These tests use an isolated temporary data directory and never contact an LLM.
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from io import BytesIO
from pathlib import Path

from fastapi.testclient import TestClient


class LocalWorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.temp_dir = tempfile.TemporaryDirectory()
        os.environ["ECHOMATE_DATA_DIR"] = cls.temp_dir.name
        sys.path.insert(0, str(Path(__file__).parents[1]))
        import main

        cls.app = main
        cls.app.initialize_database()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.temp_dir.cleanup()

    def setUp(self) -> None:
        with self.app.db() as connection:
            for table in ("analyses", "chat_imports", "cleared_message_batches", "wechat_mappings", "messages", "contacts", "documents"):
                connection.execute(f"DELETE FROM {table}")

    def test_settings_fall_back_to_an_encrypted_local_vault(self) -> None:
        original_set = self.app.keyring.set_password
        original_get = self.app.keyring.get_password
        self.app.keyring.set_password = lambda *_: (_ for _ in ()).throw(OSError("credential manager unavailable"))
        self.app.keyring.get_password = lambda *_: None
        try:
            result = self.app.update_settings(
                self.app.SettingsPayload(
                    base_url="https://example.invalid/v1",
                    chat_model="test-model",
                    embedding_model="test-embedding",
                    api_key="a-local-test-secret",
                    user_name="本地测试用户",
                    user_notes="偏好温和、简洁的表达",
                )
            )
            self.assertTrue(result["api_key_configured"])
            self.assertEqual(result["api_key_storage"], "本机加密保险库")
            self.assertEqual(result["user_name"], "本地测试用户")
            self.assertEqual(result["user_notes"], "偏好温和、简洁的表达")
            self.assertEqual(self.app.read_api_key()[0], "a-local-test-secret")
            self.assertNotIn(b"a-local-test-secret", self.app.VAULT_FILE.read_bytes())
            self.assertNotIn("api_key", self.app.settings())
        finally:
            self.app.keyring.set_password = original_set
            self.app.keyring.get_password = original_get

    def test_development_ipv4_origin_passes_cors_preflight(self) -> None:
        client = TestClient(self.app.app)
        response = client.options(
            "/settings",
            headers={
                "Origin": "http://127.0.0.1:5173",
                "Access-Control-Request-Method": "GET",
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers.get("access-control-allow-origin"), "http://127.0.0.1:5173")

    def test_contact_and_message_are_saved_locally(self) -> None:
        contact = self.app.create_contact(
            self.app.ContactPayload(name="验收联系人", relationship="朋友", traits="习惯直接表达")
        )
        message = self.app.save_message(
            self.app.MessagePayload(contact_id=contact["id"], content="这是一条本地测试消息", source="手动粘贴")
        )
        self.assertEqual(self.app.list_contacts()[0]["name"], "验收联系人")
        self.assertEqual(self.app.list_messages(contact["id"])[0]["id"], message["id"])
        self.assertEqual(self.app.list_messages(contact["id"])[0]["content"], "这是一条本地测试消息")
        self.assertEqual(self.app.list_contacts()[0]["traits"], "习惯直接表达")
        updated = self.app.update_contact(
            contact["id"], self.app.ContactPayload(name="更新后的联系人", relationship="同事", traits="表达谨慎")
        )
        self.assertEqual(updated["name"], "更新后的联系人")
        self.assertEqual(updated["traits"], "表达谨慎")

    def test_messages_can_be_deleted_and_a_conversation_cleared(self) -> None:
        contact = self.app.create_contact(self.app.ContactPayload(name="会话删除联系人"))
        first = self.app.save_message(self.app.MessagePayload(contact_id=contact["id"], content="对方内容", role="received"))
        self.app.save_message(self.app.MessagePayload(contact_id=contact["id"], content="我的回复", role="sent"))
        self.app.delete_message(first["id"])
        remaining = self.app.list_messages(contact["id"])
        self.assertEqual(len(remaining), 1)
        self.assertEqual(remaining[0]["role"], "sent")
        result = self.app.clear_contact_messages(contact["id"])
        self.assertEqual(result["deleted"], 1)
        self.assertEqual(self.app.list_messages(contact["id"]), [])
        self.assertIsNotNone(result["undo_batch_id"])
        restored = self.app.undo_clear_contact_messages(contact["id"], result["undo_batch_id"])
        self.assertEqual(restored["restored"], 1)
        self.assertEqual(self.app.list_messages(contact["id"])[0]["content"], "我的回复")

    def test_deleting_a_contact_removes_its_entire_local_conversation_space(self) -> None:
        contact = self.app.create_contact(self.app.ContactPayload(name="待删除会话"))
        self.app.save_message(self.app.MessagePayload(contact_id=contact["id"], content="本地消息"))
        self.app.save_wechat_mapping(self.app.WeChatMappingPayload(chat_title="待删除会话", contact_id=contact["id"]))
        result = self.app.delete_contact_and_conversation(contact["id"])
        self.assertEqual(result["deleted"], contact["id"])
        self.assertEqual(self.app.rows("SELECT * FROM contacts WHERE id=?", (contact["id"],)), [])
        self.assertEqual(self.app.rows("SELECT * FROM messages WHERE contact_id=?", (contact["id"],)), [])
        self.assertEqual(self.app.rows("SELECT * FROM wechat_mappings WHERE contact_id=?", (contact["id"],)), [])

    def test_local_model_reply_history_is_listed_per_contact(self) -> None:
        contact = self.app.create_contact(self.app.ContactPayload(name="建议历史联系人"))
        other = self.app.create_contact(self.app.ContactPayload(name="其他联系人"))
        with self.app.db() as connection:
            connection.execute(
                "INSERT INTO analyses(contact_id, prompt, response, citations, created_at) VALUES (?, ?, ?, ?, ?)",
                (contact["id"], "当前消息", "第一条本地模型建议", "[]", self.app.now()),
            )
            connection.execute(
                "INSERT INTO analyses(contact_id, prompt, response, citations, created_at) VALUES (?, ?, ?, ?, ?)",
                (other["id"], "其他消息", "不应出现", "[]", self.app.now()),
            )
        history = self.app.list_analyses(contact["id"])
        self.assertEqual(len(history), 1)
        self.assertEqual(history[0]["response"], "第一条本地模型建议")

    def test_analysis_uses_only_user_selected_message_context(self) -> None:
        contact = self.app.create_contact(self.app.ContactPayload(name="上下文联系人"))
        excluded = self.app.save_message(self.app.MessagePayload(contact_id=contact["id"], content="不要发送给模型的内容", role="received"))
        selected = self.app.save_message(self.app.MessagePayload(contact_id=contact["id"], content="选中的上下文", role="sent"))
        original_key, original_model, original_collection = self.app.read_api_key, self.app.ChatOpenAI, self.app.collection
        captured: list[str] = []

        class FakeModel:
            def __init__(self, **_kwargs): pass
            def invoke(self, messages):
                captured.append(str(messages[-1].content))
                return type("Response", (), {"content": "本地测试建议"})()

        self.app.read_api_key = lambda: ("test-key", "test")
        self.app.ChatOpenAI = FakeModel
        self.app.collection = lambda: (_ for _ in ()).throw(RuntimeError("no vectors for test"))
        try:
            result = self.app.analyze(self.app.AnalyzePayload(contact_id=contact["id"], content="当前我发出的回复", current_role="sent", message_ids=[selected["id"]]))
            self.assertEqual(result["sent_preview"]["history_count"], 1)
            self.assertIn("选中的上下文", captured[0])
            self.assertNotIn("不要发送给模型的内容", captured[0])
            self.assertNotEqual(excluded["id"], selected["id"])
        finally:
            self.app.read_api_key, self.app.ChatOpenAI, self.app.collection = original_key, original_model, original_collection

    def test_analysis_can_include_all_user_selected_messages(self) -> None:
        contact = self.app.create_contact(self.app.ContactPayload(name="全部消息联系人"))
        first = self.app.save_message(self.app.MessagePayload(contact_id=contact["id"], content="导入的早期消息", role="received"))
        visible = self.app.save_message(self.app.MessagePayload(contact_id=contact["id"], content="最近可见消息", role="sent"))
        original_key, original_model, original_collection = self.app.read_api_key, self.app.ChatOpenAI, self.app.collection
        captured: list[str] = []

        class FakeModel:
            def __init__(self, **_kwargs): pass
            def invoke(self, messages):
                captured.append(str(messages[-1].content))
                return type("Response", (), {"content": "本地测试建议"})()

        self.app.read_api_key = lambda: ("test-key", "test")
        self.app.ChatOpenAI = FakeModel
        self.app.collection = lambda: (_ for _ in ()).throw(RuntimeError("no vectors for test"))
        try:
            result = self.app.analyze(self.app.AnalyzePayload(
                contact_id=contact["id"], content="当前内容", current_role="received",
                message_ids=[first["id"], visible["id"]],
            ))
            self.assertEqual(result["sent_preview"]["history_count"], 2)
            self.assertIn(first["content"], captured[0])
            self.assertIn(visible["content"], captured[0])
        finally:
            self.app.read_api_key, self.app.ChatOpenAI, self.app.collection = original_key, original_model, original_collection

    def test_database_migration_is_safe_on_a_second_start(self) -> None:
        # A packaged app opens the same database on every launch. The migration
        # must therefore be idempotent after adding profile columns.
        self.app.initialize_database()
        current = self.app.settings()
        self.assertIn("user_name", current)
        self.assertIn("user_notes", current)

    def test_text_and_docx_extract_to_local_chunks(self) -> None:
        text = "第一段。\n\n第二段包含足够的内容用于检验文本分块。" * 30
        self.assertEqual(self.app.extract_text("guide.txt", text.encode()), text)

        from docx import Document

        document = Document()
        document.add_paragraph("DOCX 本地内容")
        docx_path = Path(self.temp_dir.name) / "guide.docx"
        document.save(docx_path)
        self.assertEqual(self.app.extract_text("guide.docx", docx_path.read_bytes()), "DOCX 本地内容")
        chunks = self.app.RecursiveCharacterTextSplitter(chunk_size=120, chunk_overlap=20).split_text(text)
        self.assertGreater(len(chunks), 1)
        self.assertTrue(all(len(chunk) <= 120 for chunk in chunks))

    def test_failed_vectorization_does_not_leave_a_document_record(self) -> None:
        import asyncio
        from fastapi import HTTPException
        from starlette.datastructures import UploadFile

        original_collection = self.app.collection
        self.app.collection = lambda: (_ for _ in ()).throw(RuntimeError("embedding unavailable"))
        try:
            with self.assertRaises(HTTPException) as raised:
                asyncio.run(
                    self.app.import_document(
                        UploadFile(filename="will-rollback.txt", file=BytesIO("本地资料".encode()))
                    )
                )
            self.assertEqual(raised.exception.status_code, 503)
            self.assertEqual(self.app.rows("SELECT * FROM documents"), [])
        finally:
            self.app.collection = original_collection

    def test_exported_chat_text_is_imported_once_with_roles(self) -> None:
        import asyncio
        from starlette.datastructures import UploadFile

        contact = self.app.create_contact(self.app.ContactPayload(name="导入联系人"))
        exported = "对方：周末有空吗？\n我：周日下午可以。\n对方：那就这样定。".encode()

        def upload() -> UploadFile:
            return UploadFile(filename="wechat-export.txt", file=BytesIO(exported))

        result = asyncio.run(self.app.import_chat_messages(contact["id"], upload(), "微信导出文本", "received"))
        self.assertFalse(result["duplicate"])
        self.assertEqual(result["messages"], 3)
        messages = self.app.list_messages(contact["id"])
        self.assertEqual([message["role"] for message in messages], ["received", "sent", "received"])
        duplicate = asyncio.run(self.app.import_chat_messages(contact["id"], upload(), "微信导出文本", "received"))
        self.assertTrue(duplicate["duplicate"])
        self.assertEqual(len(self.app.list_messages(contact["id"])), 3)

    def test_user_authorized_wechat_sync_is_deduplicated_and_mapped_locally(self) -> None:
        contact = self.app.create_contact(self.app.ContactPayload(name="微信联系人"))
        mapping = self.app.save_wechat_mapping(
            self.app.WeChatMappingPayload(chat_title="微信联系人", contact_id=contact["id"])
        )
        self.assertEqual(mapping["contact_id"], contact["id"])
        self.assertEqual(self.app.get_wechat_mapping("微信联系人")["chat_title"], "微信联系人")

        payload = self.app.SyncedMessagePayload(
            contact_id=contact["id"], content="这条来自前台可见聊天窗口", role="received",
            source="微信前台窗口（用户授权）", source_key="a" * 64,
        )
        first = self.app.save_synced_message(payload)
        duplicate = self.app.save_synced_message(payload)
        self.assertFalse(first["duplicate"])
        self.assertTrue(duplicate["duplicate"])
        self.assertEqual(len(self.app.list_messages(contact["id"])), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
