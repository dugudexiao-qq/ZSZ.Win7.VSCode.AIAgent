import io, os, sys
base = r'C:/Users/dugud/WorkBuddy/2026-11-14-09-47-38/win7-agent'

# version bump 0.3.5 -> 0.3.6 everywhere
for rel in ['package.json', 'README.md', 'ui-preview.html', 'scripts/selftest.js', 'scripts/smoke-host.js']:
    p = os.path.join(base, rel)
    s = io.open(p, encoding='utf-8', newline='').read()
    c = s.count('0.3.5')
    s = s.replace('0.3.5', '0.3.6')
    io.open(p, 'w', encoding='utf-8', newline='').write(s)
    print('VER ', rel, '-', c, 'bumped')

def apply(rel, pairs):
    p = os.path.join(base, rel)
    s = io.open(p, encoding='utf-8', newline='').read()
    nl = '\r\n' if '\r\n' in s else '\n'
    for i, pair in enumerate(pairs):
        old, new = pair[0], pair[1]
        expect = pair[2] if len(pair) > 2 else 1
        o = old.replace('\n', nl); n = new.replace('\n', nl)
        c = s.count(o)
        if c != expect:
            print('FAIL', rel, 'pair', i, 'count=', c, 'expect=', expect); sys.exit(1)
        s = s.replace(o, n)
    io.open(p, 'w', encoding='utf-8', newline='').write(s)
    print('OK  ', rel, '-', len(pairs), 'replacements')

apply('README.md', [
("| 🎨 **科技感品牌图标** | 活动栏「取景框 + 锐利 Z」，详情页「霓虹渐变 ZSZ + 星轨 + 电路走线」 |",
 "| 🎨 **电路板品牌图标** | 活动栏「芯片 + Z 走线 + 焊盘」，详情页「ZSZ 由 PCB 走线构成 + 芯片引脚 + 金焊盘/过孔」 |"),
("点活动栏的**取景框 Z 图标**，或命令面板跑 `Open Chat`。",
 "点活动栏的**芯片 Z 图标**，或命令面板跑 `Open Chat`。"),
("""活动栏 `media/icon.svg`（16×16 单色，`currentColor` 跟随主题）：**四角取景框 + 锐利 `Z`**——取景框表达对焦/定位，Z 代表 ZSZ，极简几何在 16px 下也清晰。详情页 `media/icon.png`（128×128）：**深紫黑径向底 + 品红→青霓虹渐变的发光 `ZSZ` + 星轨虚线环与轨道节点 + 角落电路走线**，v0.3.5 起改用这套科技感视觉，取代旧版的气泡/四格窗/黄星芒（消费级 App 风）。字母全部用矢量 path 手绘、**不用 `<text>`**，不依赖系统字体，Win7 上稳定显示。备选方向：`icon-brand-b.svg`（霓虹电路·七段式字母）、`icon-brand-c.svg`（赛博终端），都含 ZSZ；要切换把对应 PNG 覆盖 `icon.png`。改源文件后跑 `node scripts/render-icons.js` 重新导出（依赖 `sharp`，仅开发期用）。""",
 """活动栏 `media/icon.svg`（16×16 单色，`currentColor` 跟随主题）：**芯片方框 + 12 引脚 + `Z` 走线 + 两端焊盘**。详情页 `media/icon.png`（128×128）：v0.3.6 起 **ZSZ 字母本身就是 PCB 电路走线**——深绿 PCB 板 + 中央芯片封装与金色引脚，ZSZ 由青绿渐变走线画成（S 用圆弧避免读成 5），走线端点有金色焊盘（带孔）、拐角有浅蓝过孔，信号线从字母焊盘引到芯片引脚，真正"长在电路板上"。背景还有低调的走线网络与过孔。字母全部用矢量 path 手绘、**不用 `<text>`**，不依赖系统字体，Win7 上稳定显示。演进：v0.3.4 气泡/ZSZ 字母标 → v0.3.5 星轨霓虹 → v0.3.6 电路板走线。备选方向 `icon-brand-b.svg`（霓虹电路）、`icon-brand-c.svg`（赛博终端）也含 ZSZ；要切换把对应 PNG 覆盖 `icon.png`。改源文件后跑 `node scripts/render-icons.js` 重新导出（依赖 `sharp`，仅开发期用）。"""),
])

apply('ui-preview.html', [
("<li>点活动栏取景框 Z 图标 → 侧边栏 Chat</li>",
 "<li>点活动栏芯片 Z 图标 → 侧边栏 Chat</li>"),
])
