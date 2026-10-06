#!/usr/bin/env python3
"""
把"启动 CC Desktop 时同时拉起桌宠"注入到应用主进程里。

为什么要改 app.asar：CC Desktop 的插件系统只认 `mcp` 与 `hooks`，而 hooks 只支持
Claude Code 的那些事件（Stop / PreToolUse …），**没有"应用启动"这个事件**。
所以"应用一起来就出现桌宠"在插件体系里没有钩子可用，只能改主进程。

注入的代码只有一件事：spawn 一次 `pythonw pet.py --wait-for-app`，然后不管它。
  - 平台是 Windows 时才做；其他平台直接跳过
  - 用的是 pet.py 里已经测过的单实例锁：已有的桌宠会让新进程立刻退出，
    所以重复注入、重复启动都不会出现两个窗口
  - `--wait-for-app` 也让 pet.py 自己等窗口就绪，这里不需要额外的延时逻辑
  - `detached: true` + `unref()`：桌宠独立于应用生命周期，不会因为应用重启而消失
  - 出错只写一行日志，绝不干扰应用启动

用法：
    python inject-pet-autostart.py --dump          # 只打印将注入的代码块
    python inject-pet-autostart.py --inject 输入.js 输出.js
    python inject-pet-autostart.py --revert 输入.js 输出.js
    python inject-pet-autostart.py --check 文件.js
退出码：0 成功 / 1 失败（例如锚点找不到，说明应用版本变了）
"""

import argparse
import os
import sys

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

HERE = os.path.dirname(os.path.abspath(__file__))

BEGIN = "/* >>> cc-desktop-pet-autostart (injected) >>> */"
END = "/* <<< cc-desktop-pet-autostart <<< */"

# 应用启动的锚点。挑 `app.whenReady().then(async () => {` 这一行：
# 它出现在主进程里一次，且是"窗口即将创建"的位置 —— 比 package.json 顶部更安全
# （顶部可能早于 Electron 初始化完成）。
ANCHOR = "app.whenReady().then(async () => {"


def build_snippet(pet_dir=None):
    """
    生成注入块。

    必须是 **ESM** 写法：`resources/app.asar` 的 package.json 是 `"type": "module"`，
    主进程里 `require(` 出现 0 次、`__dirname` 0 次、14 行 `import` —— 纯 ES module。
    第一版写成了 CommonJS（`require("node:fs")`），结果运行时抛
    `require is not defined`，而它被我自己的 try/catch 吞掉：
    应用照常启动、桌宠永远不出现、日志里什么都没有。
    （这个 bug 是把注入块抽出来用真 node 跑一遍才抓到的，光做字节校验发现不了。）

    所以这里只用主进程顶部已经 import 进来的绑定：
      fileURLToPath、join、dirname、existsSync、spawn —— 不依赖任何全局。
    """
    # 覆盖插入嘴里的 $(...) 会失效，这里避免出现美元符号
    return f"""
{BEGIN}
// 启动 CC Desktop 时同时拉起桌宠。详细说明见 pet/inject-pet-autostart.py。
// 注意：本文件是 ES module（package.json 里 "type": "module"），
// 所以只能用 import 进来的绑定，**不能用 require / __dirname**。
// 这段是"尽力而为"：任何失败都只写一行日志，绝不影响应用本身启动。
try {{
  if (process.platform === "win32") {{
    // __dirname 的 ESM 等价物
    const _petMainDir = dirname(fileURLToPath(import.meta.url));
    const _petResources = dirname(_petMainDir);
    const _petInstall = dirname(_petResources);
    const _petDir = join(_petInstall, "pet");
    const _petScript = join(_petDir, "pet.py");

    if (existsSync(_petScript)) {{
      const _petExe = join(_petInstall, "CC Desktop.exe");
      const _petBin = existsSync(_petExe) ? _petExe : "pythonw.exe";

      const _petEnv = Object.assign({{}}, process.env, {{ ELECTRON_RUN_AS_NODE: "1" }});
      delete _petEnv.ELECTRON_NO_ATTACH_CONSOLE;

      // --wait-for-app：等窗口就绪再显示（这里不需要额外的延时逻辑）
      // --watch-app   ：CC Desktop 退出时桌宠跟着退出 —— 桌宠的生命周期完全
      //                 跟着应用走，应用关掉之后不会留一个孤儿窗口在桌面上
      const _pet = spawn(
        _petBin,
        [_petScript, "--wait-for-app", "--watch-app"],
        {{ cwd: _petDir, detached: true, stdio: "ignore", env: _petEnv }},
      );
      // detached + unref：不让父进程等它、也不把应用的生命周期绑在它身上
      // （"随应用退出"由 pet.py 的 --watch-app 自己轮询判断，更可靠）
      _pet.unref();
      _pet.on("error", (err) => {{
        console.error("pet autostart failed:", err && err.message);
      }});
    }}
  }}
}} catch (err) {{
  console.error("pet autostart threw:", err && err.message);
}}
{END}
"""


def read(path):
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read()


def write(path, text):
    with open(path, "w", encoding="utf-8", newline="") as handle:
        handle.write(text)


def main():
    parser = argparse.ArgumentParser(description="注入/回退桌宠自启")
    parser.add_argument("--dump", action="store_true", help="打印将注入的代码块")
    parser.add_argument("--check", metavar="FILE", help="检查文件是否已注入")
    parser.add_argument("--inject", nargs=2, metavar=("IN", "OUT"), help="注入并写出")
    parser.add_argument("--revert", nargs=2, metavar=("IN", "OUT"), help="移除注入并写出")
    parser.add_argument("--pet-dir", help="桌宠目录（默认脚本所在目录）")
    args = parser.parse_args()

    snippet = build_snippet(args.pet_dir)

    if args.dump:
        print(snippet)
        return 0

    if args.check:
        text = read(args.check)
        has = BEGIN in text and END in text
        print(f"{args.check}: {'已注入' if has else '未注入'}")
        if has:
            print(f"  代码块长度 {len(snippet)} 字节（当前注入版本）")
        return 0

    if args.revert:
        src, dst = args.revert
        text = read(src)
        if BEGIN not in text:
            print("输入文件里没有注入块，无需回退", file=sys.stderr)
            return 1
        start = text.index(BEGIN)
        end = text.index(END) + len(END)
        # 连同前后各一个换行一起清掉，尽量还原原貌
        while start > 0 and text[start - 1] in "\r\n":
            start -= 1
        while end < len(text) and text[end] in "\r\n":
            end += 1
        write(dst, text[:start] + "\n" + text[end:])
        print(f"已移除注入：{dst}")
        return 0

    if args.inject:
        src, dst = args.inject
        text = read(src)

        if BEGIN in text:
            print("输入文件已经注入过了（幂等，不重复插）", file=sys.stderr)
            return 1

        at = text.find(ANCHOR)
        if at < 0:
            print(f"找不到锚点：{ANCHOR!r}\n"
                  f"说明应用版本变了。请人工确认新的启动位置后再注入。", file=sys.stderr)
            return 1
        if text.find(ANCHOR, at + 1) >= 0:
            print(f"锚点出现多次（{ANCHOR!r}）—— 无法确定唯一的注入位置，中止。",
                  file=sys.stderr)
            return 1

        insert_at = at + len(ANCHOR)
        write(dst, text[:insert_at] + "\n" + snippet + text[insert_at:])
        print(f"已注入：{dst}")
        print(f"  锚点位于原文第 {text[:at].count(chr(10)) + 1} 行")
        print(f"  新增 {len(snippet)} 字节")
        return 0

    parser.print_help()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
