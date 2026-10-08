# EchoMate

EchoMate 是一个本地优先的 Windows 对话辅助工具。用户可以主动粘贴、导入聊天记录，或在明确授权后读取当前前台微信窗口公开的无障碍文本，再结合本地知识库生成可编辑的沟通建议。

项目遵循“用户确认后才发送”的原则：不会读取微信或 QQ 私有数据库，不会代替用户发送消息。API Key、联系人、消息、导入资料和分析结果默认保存在本机。

## 当前功能

- 联系人档案、聊天消息和模型建议的本地保存。
- OpenAI 兼容 API 配置，支持自定义 Base URL 和聊天模型。
- TXT、Markdown、PDF、DOCX 资料导入、文本分块、向量化和本地 RAG 检索。
- 微信/QQ 导出文本导入，并识别“我”和“对方”的消息角色。
- Windows 悬浮助手：可拖动、缩放、收起为常驻桌面悬浮球。
- 悬浮助手中可查看全部本地聊天消息，并逐条选择发送给模型的上下文。
- Windows 微信前台监听：仅在用户授权后通过 UI Automation 读取当前窗口暴露的可访问文本。

## 隐私与权限边界

- 微信监听只处理当前前台窗口，不读取微信数据库、聊天文件或隐藏窗口。
- 切换到其他应用时监听会暂停；悬浮助手处于前台时会继续处理已经确认的微信窗口。
- 当前微信窗口内容首次只建立基线，不会自动导入旧消息。
- 新聊天窗口需要用户确认关联到本地联系人后，新增文本才会保存。
- UI Automation 无法读取时会明确提示；当前版本不会自动截图或启用 OCR。
- API Key 优先保存到 Windows 凭据管理器，受限环境下使用本机加密保险库，不写入 SQLite。
- `.echomate/`、本地数据库、密钥文件、构建目录和依赖目录均已加入 Git 忽略规则。

## Windows 使用

使用发行安装程序：

`src-tauri\\target\\release\\bundle\\nsis\\EchoMate_0.1.0_x64-setup.exe`

首次打开后，在左侧设置中填写 OpenAI 兼容的 Base URL、聊天模型和 API Key。首次导入知识库时，向量模型 `BAAI/bge-small-zh-v1.5` 可能需要下载并缓存。

## 开发启动

在 CMD 中执行：

```cmd
set "PATH=C:\Users\21766\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback;%PATH%"
cd /d D:\AI_\chat-companion
node_modules\.bin\tauri.cmd dev
```

启动后应看到本地 API 服务监听：

```text
Uvicorn running on http://127.0.0.1:8787
```

## 本地验证

```cmd
D:\AI_\.venv\python.exe -m unittest discover -s backend\tests -v
node_modules\.bin\tauri.cmd build --bundles nsis
```

后端测试覆盖本地加密 Key 兜底、联系人和消息持久化、聊天记录导入、文本提取与分块、向量化失败回滚、分析上下文选择、微信映射和同步去重。

## 技术栈

- React、TypeScript、Vite
- Tauri 2、Rust、Windows UI Automation
- Python、FastAPI、LangChain
- SQLite、ChromaDB、Sentence Transformers

## 开源协议

本项目使用 MIT License，详见 [LICENSE](LICENSE)。
