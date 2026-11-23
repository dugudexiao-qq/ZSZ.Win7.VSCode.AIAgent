import io, os, sys
base = r'C:/Users/dugud/WorkBuddy/2026-11-14-09-47-38/win7-agent'

def apply(rel, pairs):
    p = os.path.join(base, rel)
    s = io.open(p, encoding='utf-8', newline='').read()
    nl = '\r\n' if '\r\n' in s else '\n'
    for i, (old, new) in enumerate(pairs):
        o = old.replace('\n', nl); n = new.replace('\n', nl)
        c = s.count(o)
        if c != 1:
            print('FAIL', rel, 'pair', i, 'count=', c); sys.exit(1)
        s = s.replace(o, n)
    io.open(p, 'w', encoding='utf-8', newline='').write(s)
    print('OK  ', rel, '-', len(pairs), 'replacements')

apply('package.json', [
('  "version": "0.3.3",', '  "version": "0.3.4",'),
])

apply('README.md', [
("**作者：dugudexiao** · 扩展 ID `dugudexiao.win7-ai-agent` · v0.3.3 · MIT",
 "**作者：dugudexiao** · 扩展 ID `dugudexiao.win7-ai-agent` · v0.3.4 · MIT"),
("作者信息在三处可见：扩展详情页的 Publisher/Author、侧边栏第二行的 `by dugudexiao · v0.3.3`、命令面板的 `About / Author`。",
 "作者信息在三处可见：扩展详情页的 Publisher/Author、侧边栏第二行的 `by dugudexiao · v0.3.4`、命令面板的 `About / Author`。"),
("v0.3.3 新增**品牌图标体系**：活动栏单色图标（对话气泡 + 代码尖括号 + AI 星芒，随主题自动明暗）与 128×128 品牌图标（蓝紫渐变 + Win7 四格窗 + 对话气泡 + 星芒），详见第十节。",
 "v0.3.3 新增**品牌图标体系**；v0.3.4 把 **ZSZ 字母标**做成核心视觉：活动栏用首字母 `Z`，128×128 品牌图标用完整 `ZSZ`，详见第十节。"),
("npx --yes @vscode/vsce@3.2.1 package --allow-missing-repository --out zsz-win7-vscode-aiagent-0.3.3.vsix",
 "npx --yes @vscode/vsce@3.2.1 package --allow-missing-repository --out zsz-win7-vscode-aiagent-0.3.4.vsix"),
("code --install-extension zsz-win7-vscode-aiagent-0.3.3.vsix",
 "code --install-extension zsz-win7-vscode-aiagent-0.3.4.vsix"),
("| A. 直接装现有 VS Code | `code --install-extension zsz-win7-vscode-aiagent-0.3.3.vsix` → `Developer: Reload Window` → 点活动栏新图标（气泡 + `< >` + 星芒） |",
 "| A. 直接装现有 VS Code | `code --install-extension zsz-win7-vscode-aiagent-0.3.4.vsix` → `Developer: Reload Window` → 点活动栏新图标（气泡 + Z + 星芒） |"),
("| 活动栏 / 侧边栏视图 | `media/icon.svg` | 16×16 单色，用 `currentColor` 跟随明暗主题。主体是对话气泡（Agent 对话），内含 `< >` 代码尖括号（VS Code 编程），右上角四角星芒（AI） |",
 "| 活动栏 / 侧边栏视图 | `media/icon.svg` | 16×16 单色，用 `currentColor` 跟随明暗主题。主体是对话气泡（Agent 对话），内含首字母 `Z`（代表 ZSZ），右上角四角星芒（AI） |"),
("| 扩展详情页 / 市场图标 | `media/icon.png` | 128×128，清单 `icon` 字段指向它。蓝紫渐变底 + 左上角半透明 Win7 四格窗（平台身份）+ 白色对话气泡 + 蓝紫代码尖括号 + 金黄星芒 |",
 "| 扩展详情页 / 市场图标 | `media/icon.png` | 128×128，清单 `icon` 字段指向它。蓝紫渐变底 + 左上角半透明 Win7 四格窗（平台身份）+ 白色对话气泡 + **深蓝紫 `ZSZ` 字母标** + 金黄星芒 |"),
("设计取舍：活动栏图标只认「第一眼语义」——用户点它是要聊天，所以气泡是主体、代码与星芒是修饰；16×16 下绝不用渐变和细线，全部实心路径保证任何主题下清晰。品牌图标承载身份叙事，才把 Win7 四格窗放进去。想换方向，改完源 SVG 跑 `node scripts/render-icons.js`（依赖 `sharp`，仅开发期需要，不进 vsix）。",
 "设计取舍：**ZSZ 是核心识别元素**。活动栏只有 16×16，三个字母横排放不下、会糊成一团，所以用首字母 `Z` 代表 ZSZ——这是尺寸约束下的最优解；气泡与星芒做修饰。品牌图标有 128×128，完整放 `ZSZ` 字母标。**字母全部用矢量 path 手绘，不用 `<text>` 元素**，因此不依赖系统字体，Win7 老机器打开 SVG 也能稳定显示。想换方向，改完源 SVG 跑 `node scripts/render-icons.js`（依赖 `sharp`，仅开发期需要，不进 vsix）。"),
("| 备选方向 | `media/icon-brand-b.svg`、`icon-brand-c.svg` | B = 四格窗 + 星芒；C = 终端 + 机器人。要切换把对应 PNG 覆盖 `icon.png` 即可 |",
 "| 备选方向 | `media/icon-brand-b.svg`、`icon-brand-c.svg` | 三款都含 ZSZ：B = 四格窗 + 底部 ZSZ 条 + 星芒；C = 终端内 ZSZ + 星芒。要切换把对应 PNG 覆盖 `icon.png` 即可 |"),
])

apply('ui-preview.html', [
("<title>ZSZ.Win7.VSCode.AIAgent · 界面预览 v0.3.3</title>",
 "<title>ZSZ.Win7.VSCode.AIAgent · 界面预览 v0.3.4</title>"),
('<span class="sub">v0.3.3 · by dugudexiao · 目标 VS Code 1.70.2 / Windows 7</span>',
 '<span class="sub">v0.3.4 · by dugudexiao · 目标 VS Code 1.70.2 / Windows 7</span>'),
('<button id="author" class="author" title="About / author" type="button">by dugudexiao · v0.3.3</button>',
 '<button id="author" class="author" title="About / author" type="button">by dugudexiao · v0.3.4</button>'),
('<code>dugudexiao.win7-ai-agent@0.3.3</code> 已装到本机 VS Code <strong>1.146.0</strong>。',
 '<code>dugudexiao.win7-ai-agent@0.3.4</code> 已装到本机 VS Code <strong>1.146.0</strong>。'),
('<div class="foot">ZSZ.Win7.VSCode.AIAgent v0.3.3 · 作者 dugudexiao · MIT · 目标平台 Windows 7 SP1 + VS Code 1.70.2</div>',
 '<div class="foot">ZSZ.Win7.VSCode.AIAgent v0.3.4 · 作者 dugudexiao · MIT · 目标平台 Windows 7 SP1 + VS Code 1.70.2</div>'),
("toast('ZSZ.Win7.VSCode.AIAgent v0.3.3 · 作者 dugudexiao · MIT');",
 "toast('ZSZ.Win7.VSCode.AIAgent v0.3.4 · 作者 dugudexiao · MIT');"),
])

apply('scripts/selftest.js', [
("  check('manifest: new name, 0.3.3, 1000 s timeout, 13 commands, all activation events', function () {",
 "  check('manifest: new name, 0.3.4, 1000 s timeout, 13 commands, all activation events', function () {"),
("    assert.strictEqual(manifest.version, '0.3.3');",
 "    assert.strictEqual(manifest.version, '0.3.4');"),
])

apply('scripts/smoke-host.js', [
("  assert.strictEqual(info.version, '0.3.3');",
 "  assert.strictEqual(info.version, '0.3.4');"),
("  assert.strictEqual(state.version, '0.3.3');",
 "  assert.strictEqual(state.version, '0.3.4');"),
])
