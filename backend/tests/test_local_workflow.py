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
            for table in ("analyses", "chat_imports", "messages", "contacts", "documents"):
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
