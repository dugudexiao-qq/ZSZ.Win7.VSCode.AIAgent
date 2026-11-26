# ZSZ.Win7.VSCode.AIAgent

[![Version](https://img.shields.io/badge/version-1.11.16-blue)](https://github.com/dugudexiao-qq/ZSZ.Win7.VSCode.AIAgent) [![License: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE) ![Platform](https://img.shields.io/badge/platform-Windows%207%20SP1%20%2B%20VS%20Code%201.70.2-lightgrey)

让 **Windows 7 SP1 + VS Code 1.70.2** 这类无法升级的老机器也能用上 AI Agent 的扩展。对接任意 **OpenAI 兼容的 chat/completions 接口**（本地 llama.cpp / Ollama / LM Studio，或内网模型服务），模型跑在别处，插件负责对话、工具执行与安全约束。

- 扩展 ID：`dugudexiao.win7-ai-agent` · 作者：dugudexiao
- 源码：[github.com/dugudexiao-qq/ZSZ.Win7.VSCode.AIAgent](https://github.com/dugudexiao-qq/ZSZ.Win7.VSCode.AIAgent)（镜像：[GitCode](https://gitcode.com/dugudexiao/zsz.Win7.AIAgent)）
- 反馈：[GitHub Issues](https://github.com/dugudexiao-qq/ZSZ.Win7.VSCode.AIAgent/issues) 或 [dugudexiao@sina.com](mailto:dugudexiao@sina.com)
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

**方式一（推荐）：从 GitHub Releases 下载安装包**

每个版本都有对应的 Release（发行版），附件即离线安装包：

1. 打开 [Releases 页](https://github.com/dugudexiao-qq/ZSZ.Win7.VSCode.AIAgent/releases)，下载 **v1.11.16** 的附件 `zsz-win7-vscode-aiagent-1.11.16.vsix`（约 190 KB）
   （直链：[Releases/download/v1.11.16](https://github.com/dugudexiao-qq/ZSZ.Win7.VSCode.AIAgent/releases/download/v1.11.16/zsz-win7-vscode-aiagent-1.11.16.vsix)）
2. 安装：`code --install-extension zsz-win7-vscode-aiagent-1.11.16.vsix`（或在 VS Code 中 `Extensions: Install from VSIX`）
3. 重载窗口：`Developer: Reload Window`

> 国内访问 GitHub 不稳定时，可用 [GitCode 镜像](https://gitcode.com/dugudexiao/zsz.Win7.AIAgent)（源码与 dist/ 安装包同步，在文件页点「下载」）。

**方式二：从源码打包**

克隆仓库后在项目根目录执行 `vsce package`（或已有的打包脚本）生成 VSIX，再按上述方式安装。

> Win7 务必在 settings.json 中设置 `"update.mode": "none"`，防止 VS Code 被自动升级后无法启动。

## 快速开始

1. **配置模型地址**：`Ctrl+Shift+P` → `Set Server URL / Port`，填 `http://主机:端口/v1`（llama.cpp 常用 8080，Ollama 11434，LM Studio 1234）；模型名需与服务端别名完全一致
2. **（可选）填 API Key**：本地/内网站点可留空；面板菜单 → 设置 API Key
3. **诊断连接**：命令面板 → `Diagnose Connection`，确认能连通
4. 打开聊天：活动栏芯片图标，或命令面板 `Open Chat`

## 使用要点

- **4 个运行开关**（标题栏下方）：写入（只读/可写）、写入确认、命令确认、子任务
- **下拉菜单**：清空对话、API Key、长期要求（点开后在输入框里直接写，回车即记住）、经验记忆、模型配置、新面板打开、服务地址
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

- **v1.11.16**：修「长期要求」输入不进去。以前要先在列表里拉到「记住一条新要求」再回车，弹出第二层输入框；直接在列表里打字回车，要么没反应，要么把过滤命中的第一条旧要求删了。现在这个列表本身就是输入框：打字时第一行变成「记住：<你打的字>」，回车即新增；重复内容提示「已经记过」，不会重复添加。删除旧要求改为二次确认，避免空回车误删。同时去掉 `ignoreFocusOut`（老版本上会让输入框留着却收不到键盘），命令面板里也能直接搜到「长期要求」。
- **v1.11.15**：撤掉 v1.11.12 加进详情页的 4 张自绘示意图——排版和字形在 VS Code 的 Markdown 渲染里都不好看，反而干扰阅读。README 回到纯文字条目，自测加了反向用例（README 不许再嵌 `media/docs` 图片、该目录不许留残图），避免以后又混进来。
- **v1.11.14**：新增「检查设置（旧版本/同名插件残留）」命令。会去看 `settings.json` 里三类东西：已废弃、当前版本不认识的键、值还等于旧版内置默认值的项；另外扫描扩展目录里同一 ID 的其它版本目录（VS Code 只启用一个，但旧版的默认值会被合并进设置界面）。启动时只在发现新情况时提醒一次，清理必须你点一下才执行，绝不擅自改配置。
- **v1.11.13**：导入的文件在消息发出后就从输入框上方消失。之前那排「已导入 (n)」标签会一直挂着，回答完了还在，看着像附件没发出去、或者下一次还要重发一遍。文件内容其实在导入那一刻就已经进了对话历史，标签只是临时提示，发出去即收起（对话记录里仍留一行「已导入文件」）。
- **v1.11.12**：扩展详情页加了 4 张自绘示意图（SVG，随包分发、不联网加载）：任务执行循环、三层记忆、安全门禁、模型可替换。新装用户不用读一堆条目就能看懂它到底能做什么；自测里加了断链检查，图片路径或打包白名单出问题会直接失败。
- **v1.11.11**：写入开关收敛成两道门。删掉冗余的 `win7Agent.allowWrite`——它和 `constraints.readOnly` 永远同进同退，从不独立生效，只在设置界面里制造「勾了却不能写」的困惑；现在写入只由 `constraints.readOnly` 与 `constraints.deniedTools` 决定。升级时自动清理旧键，且若旧值是 `allowWrite=false` 会补上 `readOnly=true`，保证不会因为删掉它而意外放开写入。
- **v1.11.10**：顶部徽章不再显示无意义的「key ok」，改为直接显示当前在用的模型名（名字过长自动省略，完整值在悬停提示里，未配 Key 时显示「未配置 Key」）；四个运行开关取消「开=蓝、风险=黄」的着色，外观完全统一，状态只由文字表达——这样换机器或从旧版本升级上来，都不会再因为存下来的开关值不同而看着像样式坏了；顺手去掉「运行选项复位为默认」（视觉问题已从样式层解决，不需要它）。
- **v1.11.9**：修复 v1.11.8 漏项保护的一个盲点——模型常把「1) 2) 清单」和第一个 runSubtask 写在同一条回复里，原实现只在纯文字回复里记录清单，导致这类情况不会触发提醒；现在任何一轮都会识别清单，漏项时能正常补完（新增端到端用例覆盖）。
- **v1.11.8**：子任务模式不再「只开一个」：提示词改成先列编号清单、每项各调用一次 runSubtask，并明确「已委派过一次不等于任务结束」；子任务回执里带上「剩余额度 N 个」，模型知道还能继续；若列了 N 项却只完成 1 项就宣布收尾，会自动提醒一次并把剩余项补完（只提醒一次）。
- **v1.11.7**：一次完整回答结束与下一次提问之间加入横向分割线（居中细线 + 小圆点），长对话里「上一轮到哪结束、这一问从哪开始」一眼可见；重放历史时同样保留分割线，不会重复插入。
- **v1.11.6**：对话记录里用户输入与 AI 回答明显区分：用户气泡右侧缩进、蓝色左竖条并标注「你」，AI 回答贴左、淡底加灰色左竖条并标注「AI」，窄面板自动收窄缩进；菜单新增「运行选项复位为默认」，解决老版本升级后写入/确认开关颜色与新装不一致（那是设置项保留了旧值，不是样式问题）——该按钮已在 v1.11.10 移除，改为从样式层统一开关外观。
- **v1.11.5**：经验记忆更准：同一工具连续失败时保留每条不同的错误（不再只记第一条），修好后逐条总结；「上一轮没修好、下一轮才修好」也能沉淀；同类经验再次命中只累加命中次数，不再重复播报「已存入经验记忆」。
- **v1.11.4**：修复「关闭面板或切换对话后聊天记录消失」：面板重开与切换会话时自动把持久化的对话历史重放进新页面（长导入内容截断显示，完整内容仍在上下文），切换到新对话则清屏。
- **v1.11.3**：修复「贴入错误日志后模型只回分析就提示已完成」：粘贴长内容（错误日志/代码，≥400 字符）默认按任务处理，不再因日志里偶然的疑问词被误判为纯问答；「只说不做」自动重试从 1 次放宽到 2 次；模型只输出思考、无正文无工具调用时自动要求继续而不是静默结束。
- **v1.11.2**：导入 HTML 时自动转纯文本（移除脚本/样式/标签，保留标题与正文），不再把原始标签注入上下文；新增 .htm 与大写扩展名支持；不支持的类型给出明确原因。
- **v1.11.1**：经验记忆条目写入后，菜单按钮计数实时刷新（原先要等整轮结束）；提示文案改为「已存入经验记忆」，与「长期要求」明确区分。
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

改进意见与问题反馈：[GitHub Issues](https://github.com/dugudexiao-qq/ZSZ.Win7.VSCode.AIAgent/issues) 或邮件 [dugudexiao@sina.com](mailto:dugudexiao@sina.com)。
