# EchoMate

本地优先的 Windows 对话辅助工具：将用户主动粘贴或手动选择导入的聊天内容保存到本机，结合本地知识库检索，为用户提供可编辑的沟通建议。不会自动读取微信或 QQ 的窗口、数据库，也不会替用户发送消息。

## Windows 安装

使用发行安装程序：

`src-tauri\target\release\bundle\nsis\EchoMate_0.1.0_x64-setup.exe`

首次启动后：

1. 点击左下角设置，填写 OpenAI 兼容的 Base URL、聊天模型与 API Key。
2. Key 优先保存至 Windows 凭据管理器；受限会话中会保存至本机加密保险库，不会写入 SQLite。
3. 首次导入知识库时，会下载并缓存 `BAAI/bge-small-zh-v1.5`；后续向量化可离线运行。

## 使用方式

- **联系人和消息**：新建联系人，手动粘贴消息，或点击“读取剪贴板”。剪贴板仅在用户点击按钮后读取。
- **微信/QQ 导出文本**：选择联系人后，在输入区选择“微信导出文本”或“QQ 导出文本”，点击“导入聊天 TXT”。支持 TXT/Markdown；`我：`、`对方：` 前缀会分别保存为双方消息，重复文件不会再次导入。
- **知识库**：侧边栏的文件按钮支持 TXT、Markdown、PDF、DOCX。资料会在本机提取、分块、向量化和检索。
- **悬浮助手**：点击顶部“呼出悬浮助手”；失焦后会自动收起。
- **远端请求**：只有在“确认并请求建议”后，当前消息、少量该联系人的历史消息和最多 4 条检索片段才会发送给你配置的模型服务。

## 开发启动

在 CMD 中：

```cmd
set "PATH=C:\Users\21766\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback;%PATH%"
cd /d D:\AI_\chat-companion
node_modules\.bin\tauri.cmd dev
```

## 验证

```cmd
D:\AI_\.venv\python.exe -m unittest discover -s backend\tests -v
node_modules\.bin\tauri.cmd build --bundles nsis
```

本地自动化测试覆盖加密 Key 兜底、联系人/消息持久化、TXT/DOCX 文本提取与分块、导出聊天记录角色识别和重复导入保护。
