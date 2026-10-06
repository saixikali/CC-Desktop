#!/usr/bin/env python3
"""
GUI 冒烟测试 —— 真的把桌宠窗口开起来，验证它在真机上不炸。

为什么必须有这一层：test_pet.py 只证明"解码和缩放算得对"（纯函数），
完全不碰 tkinter。而桌宠最容易出事的恰恰是窗口部分 ——
`-transparentcolor` 在某些 Windows/显卡组合上会整窗不显示或整块黑，
这类问题只有真的创建窗口才暴露。

用法：python test_gui.py
退出码：0 通过 / 1 断言失败 / 2 环境不支持（无显示环境）
"""

import io
import json
import os
import shutil
import struct
import subprocess
import sys
import time
import traceback
import zlib

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import png          # noqa: E402
import pet as pet_module   # noqa: E402

# 可选：用真实动图跑一次窗口测试（验证动画计时器真的在推进）
_ARGS = None
_SAMPLE = None
for _candidate in (sys.argv[1:], []):
    for _item in _candidate:
        if _item.startswith("--sample="):
            _SAMPLE = _item.split("=", 1)[1]
        elif _item == "--sample" and _candidate.index(_item) + 1 < len(_candidate):
            _SAMPLE = _candidate[_candidate.index(_item) + 1]
if not _SAMPLE:
    _default = os.path.join(HERE, "pet.gif")
    if os.path.exists(_default):
        _SAMPLE = _default


def make_test_image(path, width=120, height=160):
    """
    造一张"像桌宠"的测试图：一个带透明背景的圆角方块 + 抗锯齿边缘。
    刻意用**黑色**填透明区（真实素材最常见的情况），这样能顺带验证投影与
    透明色键有没有把边缘弄脏。
    """
    def chunk(kind, payload):
        return (struct.pack(">I", len(payload)) + kind + payload
                + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF))

    rows = []
    cx, cy, radius = width / 2, height / 2, min(width, height) / 2 - 8
    for y in range(height):
        row = bytearray()
        for x in range(width):
            dx, dy = x - cx + 0.5, y - cy + 0.5
            dist = (dx * dx + dy * dy) ** 0.5
            if dist < radius - 1:
                alpha = 255
            elif dist < radius + 1:
                alpha = int(255 * (radius + 1 - dist) / 2)
            else:
                alpha = 0
            if alpha == 0:
                row.extend((0, 0, 0, 0))          # 透明区用黑，模拟真实素材
            else:
                shade = int(80 + 120 * (y / height))
                row.extend((shade, 180, 255 - shade // 2, alpha))
        rows.append(bytes(row))

    raw = bytearray()
    for row in rows:
        raw.append(0)
        raw.extend(row)
    data = (png.PNG_SIGNATURE
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(raw), 6))
            + chunk(b"IEND", b""))
    with open(path, "wb") as handle:
        handle.write(data)
    return width, height


def main():
    try:
        import tkinter as tk
    except ImportError as err:
        print(f"[gui-test] 没有 tkinter：{err}")
        return 2

    # 临时目录放在脚本旁边：受限环境里 %TEMP% 可能是只读的（本机就踩到了
    # PermissionError），而工作区一定可写。
    work = os.path.join(HERE, ".gui-test-work")
    shutil.rmtree(work, ignore_errors=True)
    os.makedirs(work, exist_ok=True)

    if _SAMPLE and os.path.exists(_SAMPLE):
        image_path = _SAMPLE
        print(f"[gui-test] 使用真实素材：{image_path}")
    else:
        image_path = os.path.join(work, "pet.png")
        width, height = make_test_image(image_path)
        print(f"[gui-test] 测试图：{width}x{height} → {image_path}")

    # 把 stderr 也录下来：tkinter 的 Tcl 错误是异步打印的，不会变成异常，
    # 只能靠"stderr 必须是干净的"来断言。退出时未取消的 after 回调就是这样被抓到的。
    real_stderr = sys.stderr
    captured = io.StringIO()

    class Tee:
        def write(self, text):
            captured.write(text)
            return real_stderr.write(text)

        def flush(self):
            real_stderr.flush()

        def __getattr__(self, name):
            return getattr(real_stderr, name)

    sys.stderr = Tee()

    result = {"error": None, "info": {}}

    config = dict(pet_module.DEFAULTS)
    config.update({
        "image": image_path,
        "width": 90,
        "shadow": True,
        "breath": True,
        "poll_ms": 60000,
        "bubble_timeout_ms": 60000,
    })
    # 别去动用户真实的 pet-state.json
    pet_module.STATE_PATH = os.path.join(work, "pet-state.json")
    pet_module.CACHE_PATH = os.path.join(work, "cache.bin")

    # 单实例用例要用独立进程起第二个实例，给它一份同样的配置。
    # 用 utf-8-sig 写并显式不带 BOM：config.json 若带 BOM，json.load 会报
    # "Unexpected UTF-8 BOM" —— 本插件踩过，表现为子进程"退出码 3 之外的值"。
    second_config = os.path.join(work, "config.json")
    with open(second_config, "w", encoding="utf-8") as handle:
        json.dump(config, handle, ensure_ascii=False)
    result["info"]["single_instance_expected"] = True

    # 本进程要**显式持有单实例锁**：测试是 import pet 后直接建 Pet 的，
    # 不会走 main()，所以默认没有锁 —— 那样单实例用例测的就是空气
    # （本插件踩过：用例时过时不过，最后发现"本进程锁句柄 = None"）。
    if not pet_module.claim_single_instance():
        print("\n[单实例] 跳过：本进程拿不到锁（可能已经有桌宠在跑）")
        result["info"]["single_instance_expected"] = False

    app = None
    try:
        app = pet_module.Pet(config)
        root = app.root
        result["info"]["window_size"] = (app.width, app.height)
        result["info"]["transparent"] = bool(config.get("transparent"))
        result["info"]["frame_count"] = len(app.frame_images)
        result["info"]["animated"] = bool(app.animated)
        result["info"]["frame_delays"] = list(app.frame_delays)

        # 注意：这里**不用 mainloop**，而是自己跑 update() 循环。
        # 原因：单实例用例要在"第一个实例仍然活着"的前提下起第二个进程 ——
        # mainloop 会阻塞住主线程，没法做这件事；而先 quit 再起第二个，
        # 锁已经释放，第二个当然能正常启动，用例就成了假的
        # （本插件第一版就这么写的，表现为第二个实例 60 秒超时）。
        def pump(seconds):
            deadline = time.time() + seconds
            while time.time() < deadline:
                try:
                    root.update()
                except tk.TclError:
                    return
                time.sleep(0.02)

        pump(0.6)
        result["info"]["geometry"] = root.winfo_geometry()
        result["info"]["mapped"] = bool(root.winfo_ismapped())
        result["info"]["position"] = app.pos

        # 让动画跑一会儿，确认帧真的在切换
        seen = set()
        deadline = time.time() + 1.0
        while time.time() < deadline:
            seen.add(getattr(app, "frame_index", 0))
            pump(0.04)
        result["info"]["frames_seen"] = len(seen)

        # 泡泡也开一次，验证 Toplevel 能建
        app.show_bubble()
        pump(0.15)
        result["info"]["bubble_size"] = (
            app.bubble.winfo_reqwidth(), app.bubble.winfo_reqheight())
        result["info"]["bubble_text"] = app.bubble_label.cget("text")
        app.hide_bubble()
        result["info"]["bubble_after_hide"] = app.bubble is None
    except Exception as err:                               # noqa: BLE001
        result["error"] = f"构造/运行阶段失败：{err}\n{traceback.format_exc()}"
        try:
            if app is not None:
                app.root.destroy()
        except Exception:                                  # noqa: BLE001
            pass

    print("\n[结果]")
    sys.stderr = real_stderr
    stderr_text = captured.getvalue().strip()
    if stderr_text:
        print("  stderr 输出（不该有）：")
        for line in stderr_text.splitlines():
            print(f"    {line}")
    if result["error"]:
        print("  ✗ " + result["error"])
        shutil.rmtree(work, ignore_errors=True)
        return 1

    info = result["info"]
    problems = []
    for key in ("geometry", "mapped", "position", "frame_count", "animated",
                "frames_seen", "bubble_size", "bubble_text", "bubble_after_hide"):
        print(f"  {key}: {info.get(key)}")

    # ---- 断言：这些是"窗口没真的出来"的典型症状
    if not info.get("mapped"):
        problems.append("窗口没有映射（winfo_ismapped 为假）—— 桌宠根本不可见")
    geometry = info.get("geometry") or ""
    if "x" not in geometry or "+" not in geometry:
        problems.append(f"geometry 异常：{geometry}")
    else:
        try:
            size = geometry.split("+")[0]
            w, h = (int(v) for v in size.split("x"))
            if (w, h) != info["window_size"]:
                problems.append(f"窗口尺寸 {w}x{h} 与预期 {info['window_size']} 不符")
        except ValueError:
            problems.append(f"geometry 无法解析：{geometry}")
    if not info.get("frame_count"):
        problems.append("没有生成任何图像帧")
    if info.get("animated") and (info.get("frames_seen") or 0) < 2:
        problems.append(
            f"动图只见到 {info.get('frames_seen')} 帧 —— 动画没在推进（定时器没跑起来？）")
    if info.get("bubble_after_hide") is not True:
        problems.append("泡泡没能正常关闭")
    if not (info.get("bubble_text") or "").strip():
        problems.append("泡泡文本为空")
    # 注意：**不要**在这里检查 quit_completed —— 退出路径要等单实例用例跑完
    # 才会执行（那时第一个实例必须还活着）。本插件在这一版之前就先检查了，
    # 结果断言永远为假，白白失败一轮。

    print()
    early_failed = bool(problems)
    if early_failed:
        for item in problems:
            print(f"  ✗ {item}")
    else:
        print("  ✓ 窗口创建、映射、几何、图像帧、泡泡生命周期都正常")

    # ---------------------------------------------------------------- 单实例
    # 桌宠会被启动器 / 开机自启 / 你自己双击重复拉起，两个窗口叠在一起很难发现。
    # 关键：**必须在第一个实例仍然持有锁的时候**去起第二个 —— 先退出再测就是自欺欺人。
    print("\n[单实例]")
    second_ok = False
    if app is not None and not result["error"] and info.get("single_instance_expected"):
        print(f"  本进程锁句柄 = {pet_module._mutex_handle}")
        try:
            second = subprocess.run(
                [sys.executable, os.path.join(HERE, "pet.py"),
                 "--config", os.path.join(work, "config.json")],
                capture_output=True, text=True, timeout=30, cwd=HERE,
            )
            second_ok = (second.returncode == 3)
            print(f"  第二个实例退出码 {second.returncode}（期望 3）")
            out = (second.stdout or "").strip()
            if out:
                print(f"  它的输出：{out.splitlines()[0]}")
            if not second_ok:
                print(f"  ✗ 第二个实例没有认输（stderr: {(second.stderr or '').strip()[:200]}）")
        except subprocess.TimeoutExpired:
            print("  ✗ 第二个实例 30 秒没退出 —— 单实例锁没生效，它开了第二个窗口")
    else:
        print("  ⤳ 跳过（窗口没建起来）")

    # ---------------------------------------------------------------- 退出路径
    # 现在才退：这时验证"定时器都被取消、没有异步 Tcl 报错"才有意义。
    print("\n[退出路径]")
    if app is not None and not result["error"]:
        try:
            app.quit()
            finished = time.time()
            while time.time() - finished < 2.0:
                try:
                    app.root.update()
                except Exception:                  # noqa: BLE001  窗口已销毁
                    break
                time.sleep(0.05)
            info["quit_completed"] = True
            print("  ✓ 退出干净（定时器已取消，stderr 无异步报错）")
        except Exception as err:                   # noqa: BLE001
            info["quit_completed"] = False
            print(f"  ✗ 退出路径异常：{err}")
    else:
        print("  ⤳ 跳过（窗口没建起来）")

    # ---------------------------------------------------------------- 汇总
    sys.stderr = real_stderr
    late_stderr = captured.getvalue().strip()
    if late_stderr and not stderr_text:
        print("\n  退出后才出现的 stderr（典型的未取消定时器）：")
        for line in late_stderr.splitlines():
            print(f"    {line}")

    if not info.get("quit_completed") and app is not None and not result["error"]:
        problems.append("退出路径没有正常走完")
    if late_stderr:
        problems.append(f"stderr 不干净（{len(late_stderr)} 字符）—— 多半是退出后仍被触发的 after 回调")
    if app is not None and not result["error"] and info.get("single_instance_expected") and not second_ok:
        problems.append("单实例锁没生效：第二个实例没有退出")
    pet_module.release_single_instance()

    print()
    if problems:
        print("失败明细：")
        for item in problems:
            print(f"  - {item}")
        shutil.rmtree(work, ignore_errors=True)
        return 1
    print("全部通过。")
    shutil.rmtree(work, ignore_errors=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
