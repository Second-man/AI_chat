from __future__ import annotations

import hashlib
import io
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated

import chromadb
import keyring
from chromadb.utils.embedding_functions import SentenceTransformerEmbeddingFunction
from docx import Document
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI
from langchain_text_splitters import RecursiveCharacterTextSplitter
from pydantic import BaseModel, Field
from pypdf import PdfReader


APP_NAME = "EchoMate"
DATA_DIR = Path(os.environ.get("ECHOMATE_DATA_DIR", Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")) / APP_NAME))
try:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
except PermissionError:
    # Useful for portable installs and restricted developer environments.
    DATA_DIR = Path.cwd() / ".echomate"
    DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "echomate.db"
CHROMA_DIR = DATA_DIR / "chroma"
KEYRING_SERVICE = "EchoMate"


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


@contextmanager
def db():
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    try:
        yield connection
        connection.commit()
    finally:
        connection.close()


def initialize_database() -> None:
    with db() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS settings (
              id INTEGER PRIMARY KEY CHECK (id = 1), base_url TEXT NOT NULL,
              chat_model TEXT NOT NULL, embedding_model TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            INSERT OR IGNORE INTO settings VALUES (1, 'https://api.openai.com/v1', 'gpt-4o-mini', 'BAAI/bge-small-zh-v1.5', '');
            CREATE TABLE IF NOT EXISTS contacts (
              id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, relationship TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS messages (
              id INTEGER PRIMARY KEY AUTOINCREMENT, contact_id INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'manual', created_at TEXT NOT NULL,
              FOREIGN KEY(contact_id) REFERENCES contacts(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS documents (
              id INTEGER PRIMARY KEY AUTOINCREMENT, file_name TEXT NOT NULL, content_hash TEXT NOT NULL UNIQUE, chunk_count INTEGER NOT NULL, created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS analyses (
              id INTEGER PRIMARY KEY AUTOINCREMENT, contact_id INTEGER NOT NULL, prompt TEXT NOT NULL, response TEXT NOT NULL, citations TEXT NOT NULL, created_at TEXT NOT NULL,
              FOREIGN KEY(contact_id) REFERENCES contacts(id) ON DELETE CASCADE
            );
            """
        )


def rows(query: str, values: tuple = ()) -> list[dict]:
    with db() as connection:
        return [dict(row) for row in connection.execute(query, values).fetchall()]


def settings() -> dict:
    return rows("SELECT base_url, chat_model, embedding_model, updated_at FROM settings WHERE id = 1")[0]


def collection():
    client = chromadb.PersistentClient(path=str(CHROMA_DIR))
    embedding = SentenceTransformerEmbeddingFunction(model_name=settings()["embedding_model"])
    return client.get_or_create_collection("knowledge", embedding_function=embedding)


def extract_text(file_name: str, content: bytes) -> str:
    suffix = Path(file_name).suffix.lower()
    if suffix in {".txt", ".md"}:
        return content.decode("utf-8", errors="replace")
    if suffix == ".pdf":
        return "\n".join(page.extract_text() or "" for page in PdfReader(io.BytesIO(content)).pages)
    if suffix == ".docx":
        return "\n".join(paragraph.text for paragraph in Document(io.BytesIO(content)).paragraphs)
    raise HTTPException(415, "仅支持 TXT、Markdown、PDF 和 DOCX 文件")


class SettingsPayload(BaseModel):
    base_url: str = "https://api.openai.com/v1"
    chat_model: str = "gpt-4o-mini"
    embedding_model: str = "BAAI/bge-small-zh-v1.5"
    api_key: str = ""


class ContactPayload(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    relationship: str = Field(default="", max_length=80)
    notes: str = Field(default="", max_length=3000)


class MessagePayload(BaseModel):
    contact_id: int
    content: str = Field(min_length=1, max_length=12000)
    role: str = "received"
    source: str = "manual"


class AnalyzePayload(BaseModel):
    contact_id: int
    content: str = Field(min_length=1, max_length=12000)
    goal: str = Field(default="自然回应并保持边界", max_length=300)


app = FastAPI(title="EchoMate Local API")
# Tauri 2 uses `http(s)://tauri.localhost` for its WebView.  Keep this list
# explicit: the service is loopback-only and should not be callable by arbitrary
# web pages, while both development and packaged desktop builds can use it.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "tauri://localhost",
        "http://tauri.localhost",
        "https://tauri.localhost",
    ],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def startup() -> None:
    initialize_database()


@app.get("/health")
def health():
    return {"status": "ok", "data_dir": str(DATA_DIR)}


@app.get("/settings")
def get_settings():
    return {**settings(), "api_key_configured": bool(keyring.get_password(KEYRING_SERVICE, "api_key"))}


@app.put("/settings")
def update_settings(payload: SettingsPayload):
    if not payload.base_url.startswith(("http://", "https://")):
        raise HTTPException(400, "Base URL 必须以 http:// 或 https:// 开头")
    with db() as connection:
        connection.execute("UPDATE settings SET base_url=?, chat_model=?, embedding_model=?, updated_at=? WHERE id=1", (payload.base_url.rstrip("/"), payload.chat_model, payload.embedding_model, now()))
    if payload.api_key.strip():
        keyring.set_password(KEYRING_SERVICE, "api_key", payload.api_key.strip())
    return get_settings()


@app.get("/contacts")
def list_contacts():
    return rows("SELECT id, name, relationship, notes, created_at FROM contacts ORDER BY created_at DESC")


@app.post("/contacts")
def create_contact(payload: ContactPayload):
    with db() as connection:
        cursor = connection.execute("INSERT INTO contacts(name, relationship, notes, created_at) VALUES (?, ?, ?, ?)", (payload.name.strip(), payload.relationship.strip(), payload.notes.strip(), now()))
        return dict(connection.execute("SELECT * FROM contacts WHERE id=?", (cursor.lastrowid,)).fetchone())


@app.get("/contacts/{contact_id}/messages")
def list_messages(contact_id: int):
    return rows("SELECT id, role, content, source, created_at FROM messages WHERE contact_id=? ORDER BY id ASC", (contact_id,))


@app.post("/messages")
def save_message(payload: MessagePayload):
    if payload.role not in {"received", "sent"}:
        raise HTTPException(400, "role 只能是 received 或 sent")
    with db() as connection:
        cursor = connection.execute("INSERT INTO messages(contact_id, role, content, source, created_at) VALUES (?, ?, ?, ?, ?)", (payload.contact_id, payload.role, payload.content.strip(), payload.source, now()))
        return dict(connection.execute("SELECT * FROM messages WHERE id=?", (cursor.lastrowid,)).fetchone())


@app.post("/documents/import")
async def import_document(file: Annotated[UploadFile, File(...)]):
    content = await file.read()
    if len(content) > 20 * 1024 * 1024:
        raise HTTPException(413, "文件超过 20MB 限制")
    text = extract_text(file.filename or "document.txt", content).strip()
    if not text:
        raise HTTPException(400, "文件中没有可提取的文本；扫描版 PDF 暂不支持 OCR")
    content_hash = hashlib.sha256(content).hexdigest()
    with db() as connection:
        duplicate = connection.execute("SELECT id FROM documents WHERE content_hash=?", (content_hash,)).fetchone()
        if duplicate:
            return {"id": duplicate["id"], "duplicate": True}
    chunks = RecursiveCharacterTextSplitter(chunk_size=700, chunk_overlap=100, separators=["\n\n", "\n", "。", " ", ""]).split_text(text)
    with db() as connection:
        cursor = connection.execute("INSERT INTO documents(file_name, content_hash, chunk_count, created_at) VALUES (?, ?, ?, ?)", (file.filename or "document", content_hash, len(chunks), now()))
        document_id = cursor.lastrowid
    try:
        store = collection()
        store.add(ids=[f"doc-{document_id}-{index}" for index in range(len(chunks))], documents=chunks, metadatas=[{"document_id": str(document_id), "file_name": file.filename or "document", "chunk_index": index} for index in range(len(chunks))])
    except Exception as error:
        raise HTTPException(503, f"本地向量模型初始化失败：{error}") from error
    return {"id": document_id, "file_name": file.filename, "chunks": len(chunks), "duplicate": False}


@app.post("/analyze")
def analyze(payload: AnalyzePayload):
    api_key = keyring.get_password(KEYRING_SERVICE, "api_key")
    if not api_key:
        raise HTTPException(400, "请先在设置中保存 API Key")
    contact = rows("SELECT name, relationship, notes FROM contacts WHERE id=?", (payload.contact_id,))
    if not contact:
        raise HTTPException(404, "未找到联系人")
    recent_messages = rows("SELECT role, content FROM messages WHERE contact_id=? ORDER BY id DESC LIMIT 12", (payload.contact_id,))[::-1]
    citations: list[dict] = []
    try:
        result = collection().query(query_texts=[payload.content], n_results=4, include=["documents", "metadatas"])
        for document, metadata in zip(result.get("documents", [[]])[0], result.get("metadatas", [[]])[0]):
            citations.append({"file_name": metadata.get("file_name", "知识库"), "excerpt": document[:180]})
    except Exception:
        pass
    transcript = "\n".join(f"{'对方' if item['role'] == 'received' else '我'}：{item['content']}" for item in recent_messages)
    knowledge = "\n".join(f"[{item['file_name']}] {item['excerpt']}" for item in citations) or "无匹配的参考资料。"
    system = """你是本地聊天辅助工具。只根据给出的文本提出沟通假设，不作心理诊断，不声称知道对方真实想法，不提供操控或欺骗建议。用简体中文输出：1) 沟通线索（含不确定性） 2) 可考虑的回应策略 3) 三条可直接编辑的回复草案。"""
    user = f"联系人：{contact[0]['name']}，关系：{contact[0]['relationship']}。用户备注：{contact[0]['notes']}。\n近期聊天：\n{transcript}\n\n当前需要回应：{payload.content}\n目标：{payload.goal}\n\n可参考知识库：\n{knowledge}"
    model_settings = settings()
    try:
        response = ChatOpenAI(model=model_settings["chat_model"], api_key=api_key, base_url=model_settings["base_url"], temperature=0.5).invoke([SystemMessage(content=system), HumanMessage(content=user)])
    except Exception as error:
        raise HTTPException(502, f"模型请求失败：{error}") from error
    answer = str(response.content)
    with db() as connection:
        cursor = connection.execute("INSERT INTO analyses(contact_id, prompt, response, citations, created_at) VALUES (?, ?, ?, ?, ?)", (payload.contact_id, payload.content, answer, str(citations), now()))
    return {"id": cursor.lastrowid, "answer": answer, "citations": citations, "sent_preview": {"current_message": payload.content, "history_count": len(recent_messages), "retrieval_count": len(citations)}}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8787)
