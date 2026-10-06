#!/usr/bin/env python3
"""
换形象功能的自检 —— 真的把窗口开起来、真的切一次。

要证明的事：
  1. 形象库扫描能把 skins/ 里的东西列出来
  2. 菜单里确实出现了这些形象（含"当前"标记）
  3. switch_skin 之后：帧、尺寸、菜单、config.json 全部跟着变
  4. 尺寸不同的形象也能换（换完窗口要重新贴合，不能错位或超出屏幕）
  5. 换到坏素材时：明确失败、保留原形象、不崩

用法：python test-skins.py
退出码：0 通过 / 1 断言失败 / 2 环境不支持（开不了窗口）
"""

import json
import os
import shutil
import struct
import sys
import time
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

PASSED = 0
FAILURES = []
WORK = os.path.join(HERE, ".skin-test")
SKIN_BACKUP = os.path.join(WORK, "skins-backup")


def check(name, fn):
    global PASSED
    try:
        detail = fn()
        if detail == "SKIP":
            print(f"  ⤳ {name}：跳过")
            return
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


def make_png(path, width, height, color):
    """造一张指定尺寸的纯色 PNG（用来验证"换个尺寸的形象"）。"""
    def chunk(kind, payload):
        return (struct.pack(">I", len(payload)) + kind + payload
                + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF))

    rows = bytearray()
    for _y in range(height):
        rows.append(0)                                  # 过滤器类型
        rows.extend(bytes(color) * width)               # RGBA
    data = (png.PNG_SIGNATURE
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(rows), 6))
            + chunk(b"IEND", b""))
    with open(path, "wb") as handle:
        handle.write(data)
    return path


def main():
    try:
        import tkinter as tk
    except ImportError as err:
        print(f"[skin-test] 没有 tkinter：{err}")
        return 2

    shutil.rmtree(WORK, ignore_errors=True)
    os.makedirs(WORK)

    # ---- 备份用户现有形象库，测完还原（别把人家放进去的图弄丢）
    had_skins = os.path.isdir(pet_module.SKIN_DIR)
    if had_skins:
        shutil.copytree(pet_module.SKIN_DIR, SKIN_BACKUP)
    os.makedirs(pet_module.SKIN_DIR, exist_ok=True)

    # 测试用两个形象：一个小的、一个宽高比明显不同的
    small = make_png(os.path.join(pet_module.SKIN_DIR, "测试-小.png"), 40, 40, (255, 80, 80, 255))
    wide = make_png(os.path.join(pet_module.SKIN_DIR, "测试-宽.png"), 200, 60, (80, 200, 255, 255))
    # 一个坏素材：不是合法 PNG，用来验证"换到坏图不崩"
    bad = os.path.join(pet_module.SKIN_DIR, "测试-坏.png")
    with open(bad, "wb") as handle:
        handle.write(b"this is not a png")

    print(f"[skin-test] 形象库：{pet_module.SKIN_DIR}")
    print(f"[skin-test] 造了 3 个测试素材（小/宽/坏）")

    # 把状态文件与缓存挪到工作区，别动用户的
    real_state, real_cache, real_config = (pet_module.STATE_PATH,
                                           pet_module.CACHE_PATH,
                                           pet_module.CONFIG_PATH)
    pet_module.STATE_PATH = os.path.join(WORK, "state.json")
    pet_module.CACHE_PATH = os.path.join(WORK, "cache.bin")
    test_config = os.path.join(WORK, "config.json")
    if os.path.exists(real_config):
        shutil.copy2(real_config, test_config)
    # 必须把模块的 CONFIG_PATH 也指向测试副本：
    # 否则 save_image_choice / load_config 会去写**用户真实的 config.json**，
    # 测试就把人家的配置改了（本插件第一版就这么干的，测试自己抓到 width 被改）。
    pet_module.CONFIG_PATH = test_config

    config = dict(pet_module.DEFAULTS)
    config.update({"image": small, "width": 120, "poll_ms": 60000,
                   "bubble_timeout_ms": 60000, "breath": False, "shadow": True})

    app = None
    try:
        app = pet_module.Pet(config)

        def pump(seconds):
            deadline = time.time() + seconds
            while time.time() < deadline:
                try:
                    app.root.update()
                except tk.TclError:
                    return
                time.sleep(0.02)

        pump(0.5)

        def case_scan():
            names = [name for name, _path in pet_module.list_skins()]
            for want in ("测试-小", "测试-宽", "测试-坏"):
                assert_true(any(want in n for n in names), f"形象库扫描漏了 {want}：{names}")
            return f"{len(names)} 个：{', '.join(names[:4])}…"

        check("形象库扫描", case_scan)

        def case_menu():
            app.refresh_skin_menu()
            pump(0.2)
            entries = []
            for index in range(app.skin_menu.index("end") + 1):
                try:
                    entries.append(app.skin_menu.entrycget(index, "label"))
                except tk.TclError:
                    continue
            for want in ("测试-小", "测试-宽", "打开形象库文件夹", "浏览…"):
                assert_true(any(want in e for e in entries),
                            f"菜单里没有「{want}」：{entries}")
            marked = [e for e in entries if e.startswith("●")]
            eq(len(marked), 1, "应当只有一个「当前」标记 ")
            assert_true("测试-小" in marked[0], f"标记的不是当前形象：{marked}")
            return f"{len(entries)} 项，当前={marked[0].strip()}"

        check("菜单列出形象并标出当前", case_menu)

        def case_switch():
            before = (app.width, app.height)
            ok = app.switch_skin(wide)
            assert_true(ok, "switch_skin 返回失败")
            pump(0.5)
            after = (app.width, app.height)
            assert_true(after != before, f"换了宽高比不同的形象，画布尺寸却没变：{after}")
            eq(app.image_path, os.path.abspath(wide), "当前素材 ")
            assert_true(len(app.frame_images) >= 1, "换了之后没有帧")
            assert_true(app.canvas.winfo_width() > 0 or app.canvas.winfo_reqwidth() > 0,
                        "画布没有重建")
            # 窗口几何应与新尺寸相符（允许 +1 的边框误差）
            pump(0.2)
            geometry = app.root.winfo_geometry()
            size = geometry.split("+")[0]
            w, h = (int(v) for v in size.split("x"))
            assert_true(abs(w - app.width) <= 2 and abs(h - app.height) <= 2,
                        f"窗口尺寸 {w}x{h} 与新形象 {app.width}x{app.height} 不符")
            return f"{before} → {after}"

        check("换成尺寸不同的形象（画布与窗口跟着变）", case_switch)

        def case_persist():
            with open(test_config, "r", encoding="utf-8") as handle:
                saved = json.load(handle)
            eq(os.path.abspath(saved.get("image", "")), os.path.abspath(wide),
               "config.json 里记住的素材 ")
            # 关键：换装只该改 "image" 这一个字段，别的键（可能来自用户手改）
            # 一个都不能丢。注意这里比的是**配置文件里原有的值**，不是运行时的
            # 覆盖值 —— 代码里的 config["width"] 是测试调进来的参数，
            # 它本来就不会被写回文件。
            with open(real_config, "r", encoding="utf-8-sig") as handle:
                original = json.load(handle)
            for key, want in original.items():
                if key == "image" or key.startswith("_"):
                    continue
                eq(saved.get(key), want, f"换装把配置项「{key}」改了 ")
            return f"已写入 image，其余 {len(original) - 1} 项原样保留"

        check("换装结果写回 config.json（且不碰其它键）", case_persist)

        def case_menu_marks_new():
            app.refresh_skin_menu()
            pump(0.2)
            entries = []
            for index in range(app.skin_menu.index("end") + 1):
                try:
                    entries.append(app.skin_menu.entrycget(index, "label"))
                except tk.TclError:
                    continue
            marked = [e for e in entries if e.startswith("●")]
            eq(len(marked), 1, "「当前」标记数 ")
            assert_true("测试-宽" in marked[0], f"换完之后标记没跟着走：{marked}")
            return f"当前={marked[0].strip()}"

        check("换装后菜单标记跟着更新", case_menu_marks_new)

        def case_bad_image():
            keep_path = app.image_path
            keep_size = (app.width, app.height)
            ok = app.switch_skin(bad)
            pump(0.5)
            assert_true(ok is False, "换到坏素材竟然报告成功")
            eq(app.image_path, keep_path, "坏素材之后应当保留原形象 ")
            eq((app.width, app.height), keep_size, "坏素材之后尺寸不该变 ")
            assert_true(len(app.frame_images) >= 1, "坏素材之后帧没了")
            return "明确失败并保留原形象"

        check("换到坏素材：失败但不崩、保留原形象", case_bad_image)

        def case_switch_back():
            ok = app.switch_skin(small)
            pump(0.4)
            assert_true(ok, "切回小图失败")
            eq(app.image_path, os.path.abspath(small), "切回的素材 ")
            return f"{app.width}x{app.height}"

        check("再切回去（反复切换）", case_switch_back)

        print("\n[3] 生命周期：--watch-app")

        def case_watch_app():
            """
            验证 --watch-app：CC Desktop 不在了就自己退出。

            做法是把 cc_desktop_running 换掉，而不是真去关掉用户的 CC Desktop ——
            那会把这个会话一起打死。这里要测的正是"判定为 False 时会不会退出"，
            所以替换判定函数就是最直接的测法。
            """
            original = pet_module.cc_desktop_running
            try:
                pet_module.cc_desktop_running = lambda *a, **k: False
                # watch_app 必须在**构造时**传：监视器是在 __init__ 里启动的
                # （第一版写成构造后再置位，于是根本没启动监视器，断言当然失败）
                watched = pet_module.Pet(dict(config, image=small), watch_app=True)
                deadline = time.time() + 12          # 首次判定在 5 秒后
                while time.time() < deadline and not watched.closing:
                    try:
                        watched.root.update()
                    except tk.TclError:
                        break
                    time.sleep(0.05)
                assert_true(getattr(watched, "closing", False),
                            "CC Desktop 判定为不在跑，桌宠却没有退出")
                try:
                    watched.root.destroy()
                except tk.TclError:
                    pass
            finally:
                pet_module.cc_desktop_running = original
            return "判定为不在跑 → 桌宠自行退出"

        check("--watch-app：应用不在时桌宠退出", case_watch_app)

        def case_watch_unknown_keeps_alive():
            """
            反面：判定返回 None（查不到进程列表）时**必须活着**。
            受限环境里 tasklist 会 "Access denied"，那时若当成 False，
            桌宠会在几秒后自己消失（本插件踩过这个方向）。
            """
            original = pet_module.cc_desktop_running
            try:
                pet_module.cc_desktop_running = lambda *a, **k: None
                watched = pet_module.Pet(dict(config, image=small), watch_app=True)
                deadline = time.time() + 7           # 越过一次 5 秒判定
                while time.time() < deadline:
                    try:
                        watched.root.update()
                    except tk.TclError:
                        break
                    time.sleep(0.05)
                assert_true(not getattr(watched, "closing", False),
                            "判定未知（None）时桌宠不该退出 —— 那会被误杀")
                watched.closing = True
                try:
                    watched.root.destroy()
                except tk.TclError:
                    pass
            finally:
                pet_module.cc_desktop_running = original
            return "判定未知 → 保持存活"

        check("--watch-app：判定未知时不误杀", case_watch_unknown_keeps_alive)

        def case_open_folder_exists():
            target = pet_module.ensure_skin_dir()
            assert_true(os.path.isdir(target), f"形象目录不存在：{target}")
            return target

        check("形象目录可创建", case_open_folder_exists)

        app.quit()
        pump(0.3)
    except Exception as err:                           # noqa: BLE001
        import traceback
        print(f"\n[异常] {err}\n{traceback.format_exc()}")
        FAILURES.append(f"运行时异常：{err}")
        try:
            if app is not None:
                app.root.destroy()
        except Exception:                              # noqa: BLE001
            pass
    finally:
        # ---- 还原：形象库、状态/缓存/配置路径
        pet_module.STATE_PATH = real_state
        pet_module.CACHE_PATH = real_cache
        pet_module.CONFIG_PATH = real_config
        for name in ("测试-小.png", "测试-宽.png", "测试-坏.png"):
            target = os.path.join(pet_module.SKIN_DIR, name)
            if os.path.exists(target):
                os.unlink(target)
        if had_skins:
            # 把备份里用户自己的素材放回去（只补不删）
            for name in os.listdir(SKIN_BACKUP):
                src = os.path.join(SKIN_BACKUP, name)
                dst = os.path.join(pet_module.SKIN_DIR, name)
                if not os.path.exists(dst):
                    shutil.copy2(src, dst)
        shutil.rmtree(WORK, ignore_errors=True)

    print(f"\n通过 {PASSED} 项，失败 {len(FAILURES)} 项")
    if FAILURES:
        print("\n失败明细：")
        for item in FAILURES:
            print(f"  - {item}")
        return 1
    print("全部通过。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
