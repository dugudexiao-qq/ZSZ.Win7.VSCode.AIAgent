# ZSZ.Win7.VSCode.AIAgent

[![Version](https://img.shields.io/badge/version-1.11.0-blue)](https://gitcode.com/dugudexiao/zsz.Win7.AIAgent) [![License: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE) ![Platform](https://img.shields.io/badge/platform-Windows%207%20SP1%20%2B%20VS%20Code%201.70.2-lightgrey)

让 **Windows 7 SP1 + VS Code 1.70.2** 这类无法升级的老机器也能用上 AI Agent 的扩展。对接任意 **OpenAI 兼容的 chat/completions 接口**（本地 llama.cpp / Ollama / LM Studio，或内网模型服务），模型跑在别处，插件负责对话、工具执行与安全约束。

- 扩展 ID：`dugudexiao.win7-ai-agent` · 作者：dugudexiao
- 源码：[gitcode.com/dugudexiao/zsz.Win7.AIAgent](https://gitcode.com/dugudexiao/zsz.Win7.AIAgent)
- 反馈：[Issues](https://gitcode.com/dugudexiao/zsz.Win7.AIAgent/issues) 或 [dugudexiao@sina.com](mailto:dugudexiao@sina.com)
- 零依赖（CommonJS，无 npm 包），离线 VSIX 安装，MIT 开源

## 核心特性

**Agent 能力**

- 侧边栏聊天，Markdown 渲染；思考过程与工具调用按发生顺序穿插显示，默认折叠一行
- 工具集：读/写/建文件、插入编辑器、列目录、导入导出、本机命令、子任务委派
- 子任务模式：复杂任务拆给独立子代理逐项执行（最多 6 个/轮、2 层嵌套，默认关闭）
- @ 引用工作区文件，拖拽/粘贴自动转为引用

**记忆与上下文**

- 长期要求：一句话永久生效（如「注释用中文」），存 globalState
- 自动经验：工具报错被修好后自动总结成经验并注入后续提示词，可逐条删除
- 自动上下文压缩：历史超限时旧对话自动摘要成一条，长任务不再「忘记」开头
- 多模型配置（profiles）：多套「地址 + 模型 + Key」命名保存，菜单一键切换
- 工作区文件清单随提示词提供；支持项目根目录 **AGENTS.md** 注入

**安全与控制**

- 代码级硬约束：只读模式、路径白名单、工具黑名单、命令白名单、Shell 总开关
- 写入确认 / 命令确认逐条弹窗（可关），弹窗超时自动取消，任务不挂死
- 每轮写入前自动快照，回复下方可「↩ 撤回本轮改动」（保留最近 5 轮）
- 完成自检：按真实工具调用判定本轮是否真做了事，判为没动手时自动重试

**Windows 7 适配**

- runCommand 支持 **PowerShell 5.1 / CMD / Git Bash** 三种 shell，默认自动选优
- 系统提示词按当前 shell 注入语法规则；命令失败自动识别「shell 语法错配」并给出纠正提示
- PowerShell 子进程自带 UTF-8 输出、TLS 1.2、进度静音、`-ExecutionPolicy Bypass`
- 输出上限 + 双超时（墙钟/空闲）+ 进程树强杀，命令不会挂死扩展

## 安装

1. 将 `zsz-win7-vscode-aiagent-<版本>.vsix` 拷贝到目标机器
2. 安装：`code --install-extension zsz-win7-vscode-aiagent-1.11.0.vsix`（或在 VS Code 中 `Extensions: Install from VSIX`）
3. 重载窗口：`Developer: Reload Window`

> Win7 务必在 settings.json 中设置 `"update.mode": "none"`，防止 VS Code 被自动升级后无法启动。

## 快速开始

1. **配置模型地址**：`Ctrl+Shift+P` → `Set Server URL / Port`，填 `http://主机:端口/v1`（llama.cpp 常用 8080，Ollama 11434，LM Studio 1234）；模型名需与服务端别名完全一致
2. **（可选）填 API Key**：本地/内网站点可留空；面板菜单 → 设置 API Key
3. **诊断连接**：命令面板 → `Diagnose Connection`，确认能连通
4. 打开聊天：活动栏芯片图标，或命令面板 `Open Chat`

## 使用要点

- **4 个运行开关**（标题栏下方）：写入（只读/可写）、写入确认、命令确认、子任务
- **下拉菜单**：清空对话、API Key、长期要求、经验记忆、模型配置、新面板打开、服务地址
- **多会话**：底部「切换对话 ▾」新建/切换/删除对话，各自独立上下文
- **输入队列**：回复未结束可继续输入，队列可编辑、撤回、调序
- **过程展示**：工具调用默认折叠一行（如 `✎ 查看文件：src/agent.js · 0.8 s`），失败行直接写中文原因，点标题展开详情
- **绿色「已完成」≠ 事情真做成了**：以回答下方的自检行为准

## 配置速查

所有设置项前缀 `win7Agent`，设置界面有中文说明。

| 设置 | 默认 | 说明 |
|---|---|---|
| `baseUrl` / `model` | 空 | 服务地址（`http://主机:端口/v1`）与模型别名，必填 |
| `preferShell` | auto | 默认 Shell：auto=有 Git Bash 用 bash，否则 PowerShell |
| `constraints.readOnly` | true | 只读模式（写入工具被拦截） |
| `constraints.confirmWrite` / `confirmShell` | true | 写入 / 命令逐条确认 |
| `constraints.allowShell` / `allowedShellCommands` | true / 空 | Shell 总开关 / 命令白名单（前缀匹配） |
| `constraints.deniedTools` | insertText | 工具黑名单 |
| `maxHistoryMessages` / `maxContextChars` | 100 / 8000 | 历史条数 / 上下文字符预算（8k 模型建议 6000–8000，16k 以上 14000） |
| `maxToolRounds` / `timeoutMs` | 20 / 1000000 | 工具轮数 / 请求超时 |
| `subtaskMode` / `taskCheck` | false / true | 子任务模式 / 完成自检 |
| `stream` / `confirmTimeoutMs` | false / 120000 | 打字机显示（本地回放）/ 确认弹窗超时 |
| `sessions` / `autoLearn` | - / true | 会话保留配置 / 自动经验学习 |

## 排错速查

| 现象 | 处理 |
|---|---|
| 连不上模型 | 确认服务已启动；先跑 `Diagnose Connection` |
| HTTP 404 | baseUrl 漏了 `/v1`，或模型名与服务端别名不一致 |
| 不能写文件 | 默认只读：菜单切「写入：可写」，再检查写入确认开关 |
| 写文件报 Target directory does not exist | saveText 不建目录；新建文件（含多层目录）用 createFile |
| 读文件报 File too large | readFile 上限 200 KB；更大文本用 importFile（8 MB） |
| npm.ps1 报 UnauthorizedAccess | 扩展已用 `-ExecutionPolicy Bypass` 启动子进程；仍失败说明域组策略强制 Restricted，改用 `shell:"cmd"` |
| 升级后界面没变化 | 所有 VS Code 窗口完全关闭再启动（仅重载窗口不够） |
| 命令报「疑似 shell 语法错配」 | 按报错里 HINT 的提示换对应 shell 语法重发即可 |

<details>
<summary>各版本更新内容</summary>

- **v1.11.0**：runCommand 支持 Git Bash（`preferShell: auto/powershell/cmd/bash`，检测 bash.exe 自动选优）；系统提示词按可用 shell 注入语法规则；命令失败自动识别 shell 语法错配并给纠正提示；支持工作区 AGENTS.md 注入。
- **v1.10.0**：多模型配置（profiles）一键切换；自动上下文压缩；每轮写入快照 + 一键撤回。
- **v1.9.x**：过程展示重构（思考与工具穿插、默认折叠）；webview 缓存穿透；修复变形调用 JSON 漏显。
- **v1.9.3**：版权信息补全，仓库地址、反馈邮箱写入扩展元数据。
- **v1.8.x**：自动经验记忆；导入文件以标签形式展示并只显示文件名；清除全部 emoji 依赖（Win7 无彩色 emoji 字体）。
- **v1.7.x**：@ 文件引用、拖拽引用、DSML 模板多形态兜底解析、尾逗号容忍、空参数报错带重发示例、超长写入报错带拆分指引。
- **v1.6.x**：本地流式回放、上下文字符预算、429/5xx 自动退避重试、Qwen 模板解析、混合思考模型兼容、CMD UTF-8、TLS 1.2、进度静音。
- **v1.5.x**：完成自检、失败跳过与合并、args 容错、`-ExecutionPolicy Bypass`。
- **v1.0–v1.4**：首个正式版（对话/长期要求/硬约束/导入导出/子任务/输入队列/写入确认/确认超时）。

</details>

## 卸载

```
code --uninstall-extension dugudexiao.win7-ai-agent
```

---

Copyright (c) 2026 dugudexiao · 以 [MIT 许可证](./LICENSE) 开源发布。

改进意见与问题反馈：[Issues](https://gitcode.com/dugudexiao/zsz.Win7.AIAgent/issues) 或邮件 [dugudexiao@sina.com](mailto:dugudexiao@sina.com)。
