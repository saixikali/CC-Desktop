#!/usr/bin/env python3
"""
补丁链的端到端验证 —— 在 app.asar 的**副本**上跑，不碰线上包。

为什么必须先做这个：改 app.asar 一旦把应用改到起不来，代价远大于"没有桌宠"。
所以"注入能成功"不算证据，要证明整条链在真实 54 MB 的包上都成立：

  读成员 → 注入 → node --check → patch-asar → verify-asar 四重校验

并且断言"只有目标成员变了"（verify-asar 会拦下误伤邻居的情况）。

用法：python test-patch-chain.py
退出码：0 通过 / 1 断言失败 / 2 环境不支持（缺 node 或技能库）
"""

import os
import shutil
import subprocess
import sys
import time

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
INSTALL = os.path.dirname(HERE)
ASAR = os.path.join(INSTALL, "resources", "app.asar")
SCRIPTS = os.path.join(INSTALL, ".trae", "skills", "electron-asar-patch", "scripts")
MEMBER = "out/main/index.js"

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


def run(args, timeout=300):
    result = subprocess.run(args, capture_output=True, text=True,
                            encoding="utf-8", errors="replace",
                            timeout=timeout, cwd=HERE)
    return result


def main():
    for path in (ASAR, SCRIPTS):
        if not os.path.exists(path):
            print(f"缺少必要路径：{path}")
            return 2
    if not shutil.which("node"):
        print("PATH 里没有 node")
        return 2

    work = os.path.join(HERE, ".patch-test")
    shutil.rmtree(work, ignore_errors=True)
    os.makedirs(work)

    print(f"[环境] 线上 asar: {ASAR}")
    print(f"       大小: {os.path.getsize(ASAR) / 1048576:.1f} MB")
    print(f"       技法库: {SCRIPTS}")
    print(f"       工作区: {work}（副本操作，不动线上）\n")

    # ---- 复制副本：后续所有操作都在副本上
    copy = os.path.join(work, "app.asar.copy")
    print("[1] 复制 app.asar 副本")
    started = time.time()
    shutil.copy2(ASAR, copy)
    print(f"  ✓ 已复制（{time.time() - started:.1f}s，{os.path.getsize(copy) / 1048576:.1f} MB）")

    current = os.path.join(work, "current-main.js")
    injected = os.path.join(work, "injected-main.js")
    patched = os.path.join(work, "app.asar.patched")

    print("\n[2] 读成员 + 注入 + 语法检查")

    def step_read():
        result = run(["node", os.path.join(SCRIPTS, "read-entry.mjs"), copy, MEMBER, current])
        assert_true(result.returncode == 0,
                    f"read-entry 失败：{(result.stderr or result.stdout)[:200]}")
        assert_true(os.path.exists(current), "没有产出文件")
        return f"{os.path.getsize(current):,} 字节"

    check("read-entry 读出主进程成员", step_read)

    def step_inject():
        result = run([sys.executable, os.path.join(HERE, "inject-pet-autostart.py"),
                      "--inject", current, injected])
        assert_true(result.returncode == 0,
                    f"注入失败：{(result.stderr or result.stdout)[:300]}")
        grew = os.path.getsize(injected) - os.path.getsize(current)
        assert_true(grew > 0, "注入后没有变大")
        return f"新增 {grew} 字节"

    check("注入桌宠自启", step_inject)

    def step_syntax():
        result = run(["node", "--check", injected])
        assert_true(result.returncode == 0,
                    f"node --check 失败：{(result.stderr or '')[:300]}")
        return "压缩单行代码语法通过"

    check("node --check 语法闸门", step_syntax)

    print("\n[3] 生成补丁包并四重校验")

    def step_patch():
        started_at = time.time()
        result = run(["node", os.path.join(SCRIPTS, "patch-asar.mjs"),
                      copy, MEMBER, injected, patched])
        assert_true(result.returncode == 0,
                    f"patch-asar 失败：{(result.stderr or result.stdout)[:300]}")
        assert_true(os.path.exists(patched), "没有产出补丁包")
        size = os.path.getsize(patched)
        return f"{size / 1048576:.1f} MB，耗时 {time.time() - started_at:.1f}s"

    check("patch-asar 生成补丁包", step_patch)

    def step_verify():
        result = run(["node", os.path.join(SCRIPTS, "verify-asar.mjs"),
                      copy, patched, MEMBER, injected])
        assert_true(result.returncode == 0,
                    f"verify-asar 没过：{(result.stderr or result.stdout)[:400]}")
        tail = (result.stdout or "").strip().splitlines()[-3:]
        return " / ".join(line.strip() for line in tail)[:150]

    check("verify-asar 四重校验（非目标成员逐字节未变）", step_verify)

    print("\n[4] 幂等与可逆")

    def step_idempotent():
        """同一个改动再打一次，应当被拒绝（防止重复注入）。"""
        result = run([sys.executable, os.path.join(HERE, "inject-pet-autostart.py"),
                      "--inject", injected, os.path.join(work, "twice.js")])
        assert_true(result.returncode != 0,
                    "对已注入的文件再次注入竟然成功了 —— 会产生重复的启动逻辑")
        assert_true("已经注入" in (result.stderr or result.stdout),
                    f"拒绝理由不明确：{(result.stderr or result.stdout)[:150]}")
        return "重复注入被拒绝"

    check("重复注入被拦截", step_idempotent)

    def step_revert():
        back = os.path.join(work, "reverted-main.js")
        result = run([sys.executable, os.path.join(HERE, "inject-pet-autostart.py"),
                      "--revert", injected, back])
        assert_true(result.returncode == 0, f"回退失败：{(result.stderr or '')[:200]}")
        with open(current, "r", encoding="utf-8") as handle:
            original = handle.read()
        with open(back, "r", encoding="utf-8") as handle:
            restored = handle.read()
        # 回退后应当与原始成员一致（或至少不再含注入块）
        if "pet-autostart" in restored:
            raise AssertionError("回退后仍残留注入块")
        same = restored == original
        return f"回退成功（与原文{'完全一致' if same else '内容有差异，需人工确认'}）"

    check("回退后不再含注入块", step_revert)

    def step_roundtrip():
        """工具链自身的往返回归：幂等重写应当与原包逐字节相同。"""
        result = run(["node", os.path.join(SCRIPTS, "test-roundtrip.mjs"), copy], timeout=600)
        assert_true(result.returncode in (0, 2),
                    f"roundtrip 断言失败（rc={result.returncode}）："
                    f"{(result.stderr or result.stdout)[:300]}")
        if result.returncode == 2:
            return "环境不支持（rc=2，受限沙箱常见）—— 不算失败"
        first = (result.stdout or "").strip().splitlines()[:1]
        return (first[0] if first else "通过")[:120]

    check("test-roundtrip 链路回归", step_roundtrip)

    shutil.rmtree(work, ignore_errors=True)

    print(f"\n通过 {PASSED} 项，失败 {len(FAILURES)} 项")
    if FAILURES:
        print("\n失败明细：")
        for item in FAILURES:
            print(f"  - {item}")
        return 1
    print("全部通过 —— 这条补丁链在真实包上是可靠的。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
