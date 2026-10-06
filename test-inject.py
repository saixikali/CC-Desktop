#!/usr/bin/env python3
"""
注入片段的自检 —— 不碰线上 app.asar，也不需要 CC Desktop 在跑。

要证明的事：把 inject-pet-autostart.py 生成的代码拿去执行时，它**确实会以正确的
参数 spawn 桌宠**，并且各种异常情况下都不会把应用带崩。

做法：把注入块抽出来，套进一段"会自动跑一遍"的包装里（末尾补一个立即执行的调用，
因为原片段是"语句"而不是函数），再把 spawn / require 换成记录用的假实现，
丢给 node 跑，最后断言记录下来的调用参数。

用法：python test-inject.py
退出码：0 通过 / 1 断言失败 / 2 环境不支持（起不了 node 子进程）
"""

import json
import re
import os
import subprocess
import sys
import tempfile

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import importlib.util  # noqa: E402

spec = importlib.util.spec_from_file_location(
    "injector", os.path.join(HERE, "inject-pet-autostart.py"))
injector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(injector)

PASSED = 0
FAILURES = []


def check(name, fn):
    global PASSED
    try:
        detail = fn()
        PASSED += 1
        print(f"  ✓ {name}" + (f"  → {detail}" if detail else ""))
    except Exception as err:                      # noqa: BLE001
        FAILURES.append(f"{name}: {err}")
        print(f"  ✗ {name}  → {err}")


def assert_true(cond, message):
    if not cond:
        raise AssertionError(message)


def eq(actual, expected, label=""):
    if actual != expected:
        raise AssertionError(f"{label}期望 {expected!r}，实际 {actual!r}")
    return str(actual)


WRAPPER = """
// 模拟主进程的执行环境：ES module。
// 第一版这里是 CommonJS 的假 require，结果把真 bug 放过去了 ——
// 注入块里写了 require()，在真 ESM 下会抛 "require is not defined"。
// 所以现在**必须按 ESM 跑**，跟线上一致。
import { existsSync as realExistsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn as realSpawn } from "node:child_process";

const __calls = [];
const __exists = new Set(%(exists)s);

// 注意：ES module 里 import 绑定会遮蔽外层同名变量，所以不能靠"外面定义个同名的"
// 来替换 existsSync / spawn —— 第一版就这么写的，结果注入块照样用真实现，
// 两个降级分支根本测不到（表现为"脚本不存在时不 spawn"和"降级到 pythonw"都失败）。
// 这里改成**直接声明**假的同名绑定：它们与注入块同处一个模块作用域，正好遮蔽 import。
const spawn = (cmd, args, opts) => {
  __calls.push({ cmd, args, opts });
  return { unref() { __calls[__calls.length - 1].unref = true; }, on() {} };
};
const existsSync = (p) => __exists.has(p);

process.env.__TEST_MARKER = "kept";
process.env.ELECTRON_NO_ATTACH_CONSOLE = "1";

// ---- 被测代码：原样嵌入，不做任何替换 ----
%(snippet)s

const out = {
  calls: __calls.map((c) => ({
    cmd: c.cmd,
    args: c.args,
    cwd: c.opts && c.opts.cwd,
    detached: c.opts && c.opts.detached,
    stdio: c.opts && c.opts.stdio,
    envRunAsNode: c.opts && c.opts.env && c.opts.env.ELECTRON_RUN_AS_NODE,
    envMarker: c.opts && c.opts.env && c.opts.env.__TEST_MARKER,
    envNoAttach: c.opts && c.opts.env && ("ELECTRON_NO_ATTACH_CONSOLE" in c.opts.env),
    unref: !!c.unref,
  })),
  here: fileURLToPath(import.meta.url),
  // 顺便证明假件确实生效了（否则降级分支的断言测的是真 existsSync）
  fakeWorks: realExistsSync !== existsSync && realSpawn !== spawn,
};
console.log("__RESULT__" + JSON.stringify(out));
"""


def run_snippet(extra_exists=(), snippet=None):
    """
    在一个真实的 ESM 文件里跑注入块。

    注入块用 `import.meta.url` 往上数三级得到"安装目录"：
        main 目录 → 上一级 resources → 再上一级 install → install/pet/pet.py
    所以测试文件必须摆在 **比"模拟安装目录"深三级** 的位置。这里落在
    `<petDir>/.pathsim/`（深一级），于是推导出的 install 是 `<petDir>`，
    pet 目录就成了 `<petDir>/pet` —— 正好和断言里的期望对应。
    """
    snippet = snippet or injector.build_snippet()
    # 注入块用 import.meta.url 往上数三级得到"安装目录"：
    #   main 目录 → 上一级 resources → 再上一级 install → install/pet/pet.py
    # 测试文件放在 <petDir>/.pathsim/（比 simulate 出来的 main 目录深三级），
    # 于是推导出的 install 恰好是 <petDir> 的父目录 —— 和线上布局同构。
    target_dir = os.path.join(HERE, ".pathsim")
    os.makedirs(target_dir, exist_ok=True)
    harness = os.path.join(target_dir, f".inject-harness-{os.getpid()}.mjs")

    exists = set(extra_exists)
    code = WRAPPER % {"exists": json.dumps(sorted(exists)), "snippet": snippet}
    with open(harness, "w", encoding="utf-8", newline="") as handle:
        handle.write(code)
    try:
        result = subprocess.run(["node", harness], capture_output=True, text=True,
                                encoding="utf-8", errors="replace",
                                timeout=60, cwd=target_dir)
    finally:
        try:
            os.unlink(harness)
        except OSError:
            pass
    if result.returncode != 0:
        raise AssertionError(f"node 执行失败（rc={result.returncode}）："
                             f"{(result.stderr or result.stdout or '')[:400]}")
    for line in (result.stdout or "").splitlines():
        if line.startswith("__RESULT__"):
            return json.loads(line[len("__RESULT__"):])
    raise AssertionError(f"没拿到结果：{(result.stdout or '')[:400]}")


# 测试里"安装目录"就是 pet 的父目录（与线上 <install>/pet/ 同构）
EXPECTED_INSTALL = os.path.dirname(HERE)
EXPECTED_PET_DIR = os.path.join(EXPECTED_INSTALL, "pet")
EXPECTED_PET_SCRIPT = os.path.join(EXPECTED_PET_DIR, "pet.py")
EXPECTED_EXE = os.path.join(EXPECTED_INSTALL, "CC Desktop.exe")


print("\n[1] 正常路径：按真实 ESM 环境执行注入块")

def case_normal():
    data = run_snippet(extra_exists=[EXPECTED_PET_SCRIPT, EXPECTED_EXE])
    assert_true(data.get("fakeWorks"), "测试假件没有生效（import 遮蔽问题）—— 断言会失真")
    calls = data["calls"]
    eq(len(calls), 1, "spawn 调用次数 ")
    call = calls[0]
    eq(call["cmd"], EXPECTED_EXE, "启动命令（用应用自带 Electron，不依赖系统 PATH） ")
    eq(call["args"][0], EXPECTED_PET_SCRIPT, "第一个参数（推导出的桌宠脚本路径） ")
    # 两个开关都要在：--wait-for-app 等应用就绪；--watch-app 随应用退出。
    # 少了后者，应用关掉之后桌宠会变成留在桌面上的孤儿窗口。
    eq(list(call["args"][1:]), ["--wait-for-app", "--watch-app"],
       "后续参数（等应用 + 随应用退出） ")
    eq(call["cwd"], EXPECTED_PET_DIR, "工作目录 ")
    eq(call["detached"], True, "detached ")
    eq(call["stdio"], "ignore", "stdio ")
    eq(call["envRunAsNode"], "1", "ELECTRON_RUN_AS_NODE ")
    eq(call["envMarker"], "kept", "应继承原环境变量 ")
    eq(call["envNoAttach"], False, "应删掉 ELECTRON_NO_ATTACH_CONSOLE ")
    eq(call["unref"], True, "应 unref ")
    return f"cmd={os.path.basename(call['cmd'])} args={call['args'][1:]}"

check("ESM 环境下以正确参数 spawn 桌宠（路径推导正确）", case_normal)


print("\n[2] 降级与容错")

def case_no_pet_script():
    """桌宠脚本不存在（用户删了 pet 目录）→ 什么都不做，不能崩。"""
    data = run_snippet(extra_exists=[EXPECTED_EXE])
    eq(len(data["calls"]), 0, "不该 spawn ")
    return "静默跳过"

check("桌宠脚本不存在时不 spawn", case_no_pet_script)


def case_no_exe():
    """应用 EXE 找不到（非标准安装）→ 退回 PATH 里的 pythonw.exe。"""
    data = run_snippet(extra_exists=[EXPECTED_PET_SCRIPT])
    calls = data["calls"]
    eq(len(calls), 1, "spawn 调用次数 ")
    eq(calls[0]["cmd"], "pythonw.exe", "降级命令 ")
    return "降级到 pythonw.exe"

check("应用 EXE 找不到时降级到 pythonw.exe", case_no_exe)


print("\n[3] 注入块的形状")

def case_syntax_and_marks():
    snippet = injector.build_snippet()
    assert_true(snippet.count(injector.BEGIN) == 1, "开始标记应只有一个")
    assert_true(snippet.count(injector.END) == 1, "结束标记应只有一个")
    handle = tempfile.NamedTemporaryFile("w", suffix=".mjs", delete=False,
                                         dir=HERE, encoding="utf-8")
    handle.write(snippet)
    handle.close()
    try:
        result = subprocess.run(["node", "--check", handle.name],
                                capture_output=True, text=True,
                                encoding="utf-8", errors="replace", timeout=60)
    finally:
        os.unlink(handle.name)
    eq(result.returncode, 0, f"node --check 应通过：{(result.stderr or '')[:200]} ")
    return f"{len(snippet)} 字节，语法合法"

check("注入块语法合法、标记唯一", case_syntax_and_marks)


def case_no_commonjs():
    """
    这条是回归测试：注入块**绝不能真的用** require / __dirname / module.exports。
    主进程是 ES module，用了它们会抛 "require is not defined"，
    而且会被注入块自己的 try/catch 吞掉 —— 应用照常启动、桌宠永远不出现、
    日志里什么都没有（这个 bug 真发生过，是把注入块抽出来用真 node 跑才抓到的）。

    注意只扫**代码**、不扫注释：注释里提到这些名字是解释用的，
    第一版没排除注释，结果被自己的说明文字误报了一次。
    """
    snippet = injector.build_snippet()
    # 去掉行注释与块注释后再扫
    code_only = re.sub(r"/\*.*?\*/", "", snippet, flags=re.S)
    code_only = re.sub(r"//[^\n]*", "", code_only)

    banned = ["require(", "__dirname", "module.exports", "__filename"]
    found = [token for token in banned if token in code_only]
    assert_true(not found, f"注入块代码里出现了 CommonJS 的东西：{found}（主进程是 ESM）")
    for needed in ("import.meta.url", "fileURLToPath", "existsSync", "spawn"):
        assert_true(needed in code_only, f"注入块代码里缺少 {needed}")
    return "代码只用 ESM 绑定，无 require/__dirname（注释不算）"

check("注入块不含 CommonJS 写法（ESM 回归）", case_no_commonjs)


def case_inject_revert_roundtrip():
    """注入 → 回退 应当能拿回原文（"改坏了能退回去"的保证）。"""
    source = injector.ANCHOR + "\n  createWindow();\n});\n"
    src = os.path.join(HERE, ".t-src.js")
    mid = os.path.join(HERE, ".t-mid.js")
    back = os.path.join(HERE, ".t-back.js")
    with open(src, "w", encoding="utf-8", newline="") as handle:
        handle.write(source)
    try:
        for args in (["--inject", src, mid], ["--revert", mid, back]):
            result = subprocess.run(
                [sys.executable, os.path.join(HERE, "inject-pet-autostart.py")] + args,
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
            eq(result.returncode, 0, f"{args[0]} 应当成功：{(result.stderr or '')[:200]} ")
        with open(mid, "r", encoding="utf-8") as handle:
            middle = handle.read()
        with open(back, "r", encoding="utf-8") as handle:
            restored = handle.read()
        assert_true(injector.BEGIN in middle, "注入后应包含标记")
        assert_true(injector.BEGIN not in restored, "回退后不该还有标记")
        assert_true(injector.ANCHOR in restored, "回退后应保留锚点")
        assert_true("createWindow();" in restored, "回退后应保留后续代码")
    finally:
        for path in (src, mid, back):
            if os.path.exists(path):
                os.unlink(path)
    return "注入↔回退可逆"

check("注入与回退可逆", case_inject_revert_roundtrip)


print(f"\n通过 {PASSED} 项，失败 {len(FAILURES)} 项")
if FAILURES:
    print("\n失败明细：")
    for item in FAILURES:
        print(f"  - {item}")
    sys.exit(1)
print("全部通过。")
sys.exit(0)
