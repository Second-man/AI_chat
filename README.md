# EchoMate

EchoMate 是一个本地优先的 Windows 对话辅助工具。用户可以主动粘贴、导入聊天记录，或在明确授权后读取当前前台微信窗口公开的无障碍文本，再结合本地知识库生成可编辑的沟通建议。

项目遵循“用户确认后才发送”的原则：不会读取微信或 QQ 私有数据库，不会代替用户发送消息。API Key、联系人、消息、导入资料和分析结果默认保存在本机。

这是开发中的个人项目，可用于源码展示和本地试用，不是已完成安全审计的生产产品。当前主要支持 Windows 11；Android 尚未完成可用版本。项目与微信、QQ 或腾讯无官方关联。

## 当前功能

- 联系人档案、聊天消息和模型建议的本地保存。
- OpenAI 兼容 API 配置，支持自定义 Base URL 和聊天模型。
- TXT、Markdown、PDF、DOCX 资料导入、文本分块、向量化和本地 RAG 检索。
- 微信/QQ 导出文本导入，并识别“我”和“对方”的消息角色。
- Windows 悬浮助手：可拖动、缩放、收起为常驻桌面悬浮球。
- 悬浮助手中可查看全部本地聊天消息，并逐条选择发送给模型的上下文。
- Windows 微信前台监听（实验性）：仅在用户授权后通过 UI Automation 读取当前窗口暴露的可访问文本。部分微信版本不暴露聊天文本，无法使用此功能；可改用手动粘贴或导入。

## 隐私与权限边界

- 微信监听只处理当前前台窗口，不读取微信数据库、聊天文件或隐藏窗口。
- 切换到其他应用时监听会暂停；悬浮助手处于前台时会继续处理已经确认的微信窗口。
- 当前微信窗口内容首次只建立基线，不会自动导入旧消息。
- 新聊天窗口需要用户确认关联到本地联系人后，新增文本才会保存。
- UI Automation 无法读取时会明确提示；当前版本不会自动截图或启用 OCR。
- API Key 优先保存到 Windows 凭据管理器，受限环境下使用本机加密保险库，不写入 SQLite。
- `.echomate/`、本地数据库、密钥文件、构建目录和依赖目录均已加入 Git 忽略规则。
- 点击模型分析时，当前消息、所选历史消息、双方档案、分析目标和检索到的资料摘录会发送到用户配置的模型 API。本地部署并不意味着模型请求完全离线，请确认服务商的数据处理政策及聊天参与者的授权。
- 人格、情绪和沟通倾向仅是基于文本的不确定推测，不代表真实心理状态，也不构成心理诊断。
- 本地聊天数据库未加密；API Key 的保险库兜底也不等同于系统凭据管理器的安全保护。请勿在共享电脑上存放敏感聊天或高权限密钥，详见 [安全说明](SECURITY.md)。

## Windows 使用

当前优先使用下方开发模式测试。安装包仅在另行构建后存在，仓库不包含可直接运行的安装程序。

首次打开后，在左侧设置中填写 OpenAI 兼容的 Base URL、聊天模型和 API Key。首次导入知识库时，向量模型 `BAAI/bge-small-zh-v1.5` 可能需要下载并缓存。

## 开发启动

需要 Node.js 22.12+（推荐当前 LTS）、pnpm、Python 3.11、Rust stable（满足 Cargo.toml 的 rust-version）、Visual Studio C++ Build Tools/Windows SDK，以及 WebView2 Runtime。

首次克隆后，在 CMD 中执行（目录可自行替换）：

```cmd
git clone https://github.com/Second-man/AI_chat.git
cd AI_chat
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
pnpm install --frozen-lockfile
set "ECHOMATE_PYTHON=%CD%\.venv\Scripts\python.exe"
node_modules\.bin\tauri.cmd dev
```

后续启动仍需设置 `ECHOMATE_PYTHON`，并确保 pnpm 和 Cargo 位于 PATH 中。后端由 Tauri 自动启动，无需单独启动。Python 依赖目前未锁定完整版本，跨环境复现可能需要适配。

启动后应看到本地 API 服务监听：

```text
Uvicorn running on http://127.0.0.1:8787
```

## 本地验证

```cmd
.venv\Scripts\python.exe -m unittest discover -s backend\tests -v
pnpm build
cd src-tauri
cargo check
cargo test
```

这些检查不会打包安装程序，也不能证明真实微信窗口读取成功。监听兼容性需在对应微信版本上单独验证。

后端测试覆盖本地加密 Key 兜底、联系人和消息持久化、聊天记录导入、文本提取与分块、向量化失败回滚、分析上下文选择、微信映射和同步去重。

## 技术栈

- React、TypeScript、Vite
- Tauri 2、Rust、Windows UI Automation
- Python、FastAPI、LangChain
- SQLite、ChromaDB、Sentence Transformers

## 开源协议

本项目使用 MIT License，详见 [LICENSE](LICENSE)。

MIT 协议适用于本项目自有代码；第三方依赖、模型和素材仍受各自许可约束。公开截图或演示请使用虚构联系人和聊天内容，不要上传 API Key、真实聊天、导入资料或本机数据目录。
