#!/usr/bin/env python3
"""
CC Desktop 桌宠 —— 用你自己的图片（静态图或 GIF 动图），贴在桌面上显示
DeepSeek 余额与今日消耗。

设计要点（都是取舍，写下来免得以后自己踩）：

1. **它是独立进程，不是 CC Desktop 插件。** CC Desktop 的插件系统只认 mcp 与 hooks
   两个键，没有任何往界面注入 HTML/脚本的能力，所以"壳内挂件"这条路走不通。
   独立窗口反而更好：不碰 app.asar、应用升级不影响、随时能关。

2. **真透明靠分层窗口（WS_EX_LAYERED + tkinter 的 -transparentcolor）。**
   零第三方依赖（不需要 Pillow / Electron）。代价是透明只能按"颜色键"来：
   图片边缘的抗锯齿半透明像素会被二值化，所以默认给桌宠垫一层**柔和投影**，
   视觉上就是"浮在桌面上"，而不是贴了张剪贴画。

3. **支持 GIF 动图。** 用自带的 gif.py 解码（LZW + 局部色表 + 透明索引 +
   帧处置），逐帧预缩放到目标尺寸后按各自时长播放。静态图则用"呼吸起伏"代替动画。

4. **只读账本，不写。** 账本归插件（MCP + Stop hook）管，桌宠只读文件显示，
   两边互不干扰；插件没装也只是显示"暂无数据"。

用法：
    python pet.py                          # 用 config.json 里的设置
    python pet.py --image D:\\my\\pet.gif   # 临时换图
    python pet.py --transparent-key none   # 关掉透明（排查显示问题时用）
"""

import argparse
import ctypes
import json
import os
import shutil
import subprocess
import sys
import time
import tkinter as tk
from tkinter import messagebox

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import gif                      # noqa: E402  纯 Python GIF 解码
import png                      # noqa: E402  纯 Python PNG 解码/缩放
import ledger_data              # noqa: E402  账本读取

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, "config.json")
STATE_PATH = os.path.join(HERE, "pet-state.json")
CACHE_PATH = os.path.join(HERE, ".frames-cache.bin")
LOG_PATH = os.path.join(HERE, "pet.log")

# 启动日志。为什么需要它：pythonw 没有 stdout/stderr，桌宠一旦启动失败
# 就**什么提示都没有**（本插件真踩过：用 pythonw 启动直接秒退，看不到任何原因）。
# 默认开；PET_LOG=0 可以关掉。
LOG_ENABLED = os.environ.get("PET_LOG", "1") != "0"


def log(message):
    if not LOG_ENABLED:
        return
    try:
        # 日志留着排查用，但不能无限长：超过 1 MB 就只留最后 200 行
        if os.path.exists(LOG_PATH) and os.path.getsize(LOG_PATH) > 1_000_000:
            with open(LOG_PATH, "r", encoding="utf-8", errors="replace") as handle:
                tail = handle.readlines()[-200:]
            with open(LOG_PATH, "w", encoding="utf-8") as handle:
                handle.writelines(tail)
        with open(LOG_PATH, "a", encoding="utf-8") as handle:
            handle.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {message}\n")
    except OSError:
        pass

MAX_FRAMES = 120                # 动图帧数上限：内存和启动时间都要有底

DEFAULTS = {
    "image": os.path.join(HERE, "pet.png"),
    "width": 220,
    "cutout": None,
    "shadow": True,
    "shadow_offset": 4,
    "shadow_blur": 3,
    "shadow_strength": 0.45,
    "shadow_color": "#000000",
    "transparent": True,
    "animate": True,
    "breath": True,
    "breath_period_ms": 2600,
    "breath_amount": 0.03,
    "poll_ms": 5000,
    "bubble_on_click": True,
    "bubble_timeout_ms": 8000,
    "bubble_bg": "#1e1e22",
    "bubble_fg": "#f0f0f2",
    # ---- 与 DSH 挂件对齐的功能开关
    "bubble_show_peak": True,          # 泡泡里显示峰谷时段与倒计时
    "balance_alert": None,             # 余额低于此值时提醒（None = 关闭）
    "daily_budget": None,              # 今日用量达到此值时提醒（None = 关闭）
    "alert_cooldown_min": 30,          # 同一类提醒的最短间隔（分钟）
    "refresh_on_click": True,          # 点一下就去后台问一次余额（等同 DSH 的点鲸鱼刷新）
    "detail_window_font": 10,
}

# 透明色：选一个"几乎不可能出现在素材里"的颜色。
# 它只是填充底、会被整块扣成透明；投影画在它之上，所以仍然可见。
TRANSPARENT_KEY = "#ff00fe"

# 单实例锁。为什么要它：桌宠会被启动器、开机自启、甚至你自己双击重复拉起，
# 而两个同样的窗口叠在一起很难看出来（看起来只是"有点模糊"）。
#
# 用 Local\ 命名空间而不是 Global\：Global 需要 SeCreateGlobalPrivilege，
# 普通用户下 CreateMutexW 会直接失败（返回 0），那样锁形同虚设 ——
# 本插件第一版就这么写的，自检里"第二个实例应当认输"当场挂了 60 秒超时。
MUTEX_NAME = "Local\\CCDesktopPetSingleInstance"
ERROR_ALREADY_EXISTS = 183
_mutex_handle = None


def claim_single_instance():
    """
    抢单实例锁。已经被占用则返回 False。

    用命名互斥体而不是 PID 文件：进程崩了内核会自动释放，不会留下"死锁文件"
    让桌宠再也起不来（PID 文件方案必须自己处理"进程已消失但文件还在"）。
    """
    global _mutex_handle
    try:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_wchar_p]
        kernel32.CreateMutexW.restype = ctypes.c_void_p
        kernel32.CloseHandle.argtypes = [ctypes.c_void_p]

        ctypes.set_last_error(0)
        handle = kernel32.CreateMutexW(None, False, MUTEX_NAME)
        last_error = ctypes.get_last_error()
        if os.environ.get("PET_DEBUG_MUTEX"):
            print(f"[pet] mutex handle={handle} err={last_error} name={MUTEX_NAME}", file=sys.stderr)
        if not handle:
            print(f"[pet] 单实例锁不可用（错误码 {last_error}），本次不做互斥", file=sys.stderr)
            return True
        if last_error == ERROR_ALREADY_EXISTS:
            kernel32.CloseHandle(handle)
            return False
        _mutex_handle = handle
        return True
    except (OSError, AttributeError) as err:
        print(f"[pet] 单实例锁异常（{err}），本次不做互斥", file=sys.stderr)
        return True


def release_single_instance():
    global _mutex_handle
    if _mutex_handle:
        try:
            ctypes.WinDLL("kernel32", use_last_error=True).CloseHandle(_mutex_handle)
        except (OSError, AttributeError):
            pass
        _mutex_handle = None


# --------------------------------------------------------------------- 配置

def load_config():
    config = dict(DEFAULTS)
    if os.path.exists(CONFIG_PATH):
        try:
            # utf-8-sig：容忍带 BOM 的 config.json。记事本和 PowerShell 的
            # Set-Content -Encoding UTF8 都会写 BOM，而 json.load 遇到 BOM 会直接
            # 报 "Unexpected UTF-8 BOM"（本插件踩过：配置文件被悄悄读成默认值）。
            with open(CONFIG_PATH, "r", encoding="utf-8-sig") as handle:
                user = json.load(handle)
            if isinstance(user, dict):
                for key, value in user.items():
                    if key.startswith("_"):
                        continue        # 允许用 "_comment" 之类写说明
                    config[key] = value
        except (OSError, json.JSONDecodeError) as err:
            print(f"[pet] config.json 读取失败，用默认值：{err}", file=sys.stderr)
    return config


def find_image(configured):
    """configured 不存在时，在常见位置找一个像桌宠的文件。"""
    candidates = [configured,
                  os.path.join(HERE, "pet.gif"),
                  os.path.join(HERE, "pet.png"),
                  os.path.join(HERE, "image.gif"),
                  os.path.join(HERE, "image.png")]
    for candidate in candidates:
        if candidate and os.path.exists(candidate):
            return candidate
    return None


def load_position():
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as handle:
            state = json.load(handle)
        return state.get("x"), state.get("y")
    except (OSError, json.JSONDecodeError):
        return None, None


ALERT_PATH = os.path.join(HERE, ".alert-state.json")

# 形象库。放一张图进来就能在右键菜单里直接切换，不用改 config.json、不用重启。
SKIN_DIR = os.path.join(HERE, "skins")
SKIN_EXTENSIONS = (".gif", ".png")


def ensure_skin_dir():
    try:
        os.makedirs(SKIN_DIR, exist_ok=True)
    except OSError:
        pass
    return SKIN_DIR


def list_skins():
    """
    形象库里可用的素材（含 config.json 里指定的那一张）。

    返回 [(显示名, 绝对路径), ...]，按显示名排序。
    找不到任何素材时返回空列表 —— 调用方据此决定要不要提示。
    """
    ensure_skin_dir()
    found = {}
    known_paths = set()
    try:
        for name in sorted(os.listdir(SKIN_DIR)):
            path = os.path.join(SKIN_DIR, name)
            if not os.path.isfile(path):
                continue
            if os.path.splitext(name)[1].lower() not in SKIN_EXTENSIONS:
                continue
            found[os.path.splitext(name)[0]] = path
            known_paths.add(os.path.normcase(os.path.abspath(path)))
    except OSError:
        pass

    configured = find_image(load_config().get("image", ""))
    if configured:
        configured_abs = os.path.normcase(os.path.abspath(configured))
        # 只有"不在形象库里"的才补一条（用路径判重，不是用名字）。
        # 否则同一张图会以"库里的名字"和"config 的名字"出现两次，
        # 菜单上就会有两个「当前」标记（本插件真出现过）。
        if configured_abs not in known_paths:
            stem = os.path.splitext(os.path.basename(configured))[0]
            found.setdefault(f"{stem}（config）", os.path.abspath(configured))

    return sorted(found.items(), key=lambda kv: kv[0].lower())


def save_image_choice(path):
    """
    把选中的素材写回 config.json（保留其它键与注释键）。

    只改 "image" 这一个字段；顺手把没用的注释键原样留着，用户回头还能看懂。
    """
    data = {}
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8-sig") as handle:
            loaded = json.load(handle)
        if isinstance(loaded, dict):
            data = loaded
    except (OSError, json.JSONDecodeError):
        pass

    data["image"] = path
    try:
        tmp = f"{CONFIG_PATH}.tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
        os.replace(tmp, CONFIG_PATH)
        log(f"已把形象写入 config.json：{path}")
        return True
    except OSError as err:
        log(f"写 config.json 失败：{err}")
        return False


def load_alert_state():
    """
    提醒去重状态：{kind: 上次提醒时间戳}。
    持久化到磁盘的原因：不加去重的话，余额低于阈值之后每次轮询（5 秒）都会弹一次，
    用户会被自己的桌宠刷屏（DSH 挂件同样有这个"只提醒一次"的语义）。
    """
    try:
        with open(ALERT_PATH, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def save_alert_state(state):
    try:
        with open(ALERT_PATH, "w", encoding="utf-8") as handle:
            json.dump(state, handle)
    except OSError:
        pass


def save_position(x, y):
    try:
        with open(STATE_PATH, "w", encoding="utf-8") as handle:
            json.dump({"x": x, "y": y}, handle)
    except OSError:
        pass


# ----------------------------------------------------------------- 素材加载

def _decode_source(path, max_frames=MAX_FRAMES):
    """按扩展名解码成 [(rgba, w, h, delay_ms)]。"""
    ext = os.path.splitext(path)[1].lower()
    if ext == ".gif":
        width, height, frames = gif.decode(path, max_frames=max_frames)
        return [(f["rgba"], width, height, f["delay_ms"]) for f in frames], True
    if ext in (".png", ".apng"):
        width, height, rgba = png.decode(path)
        return [(rgba, width, height, 0)], False
    raise png.PngError(f"不认识的扩展名 {ext}（支持 .gif / .png）")


def load_frames(path, target_width, cache_path=CACHE_PATH, cutout=None, max_frames=MAX_FRAMES):
    """
    解码 → （可选）抠背景 → 裁边 → 缩放到目标宽度 → 加投影 → 生成 tk 图像。

    返回 (frames, width, height, animated)：
      frames  是 [(PhotoImage, delay_ms), ...]
      width/height 是整个画布尺寸（所有帧一致）
      animated 表示源文件是不是动图

    结果缓存到磁盘：640×640 的 8 帧 GIF 纯 Python 解码 + 缩放要几秒，
    缓存后第二次启动是瞬时的（缓存键含源文件大小、mtime、目标宽度、抠图参数与帧上限）。
    """
    stat = os.stat(path)
    key = {
        "path": path, "size": stat.st_size, "mtime": int(stat.st_mtime),
        "width": target_width, "cutout": cutout, "max_frames": max_frames,
    }

    decoded = None
    try:
        with open(cache_path, "rb") as handle:
            if json.loads(handle.readline().decode("utf-8")) == key:
                header = json.loads(handle.readline().decode("utf-8"))
                canvas_w, canvas_h = header["canvas"]
                entries = []
                for meta in header["frames"]:
                    blob = handle.read(meta["bytes"])
                    if len(blob) != meta["bytes"]:
                        raise ValueError("缓存截断")
                    # 每帧都带着自己的宽高与延时，缓存与解码两条路径返回**同构**的数据
                    # （早先只存了 delay，导致 Pet 那边解包数量对不上）
                    entries.append((bytearray(blob), meta["w"], meta["h"], meta["delay_ms"]))
                if entries:
                    decoded = (entries, canvas_w, canvas_h, header["animated"])
    except (OSError, ValueError, KeyError, json.JSONDecodeError):
        decoded = None

    if decoded is None:
        raw_frames, animated = _decode_source(path, max_frames)

        # 抠背景（可选）
        if cutout is not None:
            cleaned = []
            for rgba, width, height, delay in raw_frames:
                rgba, removed = png.cutout_background(
                    rgba, width, height, int(cutout.get("tolerance", 24)))
                if removed == 0:
                    print("[pet] 抠图没删掉任何像素：背景可能是渐变的，试着调大 cutout.tolerance",
                          file=sys.stderr)
                cleaned.append((rgba, width, height, delay))
            raw_frames = cleaned

        # 所有帧共用一个裁剪框（逐帧各裁各的会让动图抖动）
        box = png.union_alpha_box(
            [f[0] for f in raw_frames], [f[1] for f in raw_frames], [f[2] for f in raw_frames])
        if box is None:
            raise png.PngError("素材整张都是透明的，没有可见内容")

        entries = []
        for rgba, width, height, delay in raw_frames:
            rgba, width, height = png.crop(rgba, width, height, box)

            ratio = target_width / width
            dst_w = max(1, int(round(width * ratio)))
            dst_h = max(1, int(round(height * ratio)))
            if (dst_w, dst_h) != (width, height):
                rgba = png.resize_rgba(rgba, width, height, dst_w, dst_h)
            entries.append((rgba, dst_w, dst_h, delay))

        canvas_w = entries[0][1]
        canvas_h = entries[0][2]
        decoded = (entries, canvas_w, canvas_h, animated)

        try:
            with open(cache_path, "wb") as handle:
                handle.write(json.dumps(key).encode("utf-8") + b"\n")
                handle.write(json.dumps({
                    "canvas": [canvas_w, canvas_h],
                    "frames": [{"bytes": len(rgba), "w": w, "h": h, "delay_ms": delay}
                               for rgba, w, h, delay in entries],
                    "animated": animated,
                }).encode("utf-8") + b"\n")
                for entry in entries:
                    handle.write(bytes(entry[0]))
        except OSError:
            pass  # 缓存写不进去不影响功能

    raw_entries, canvas_w, canvas_h, animated = decoded
    return raw_entries, canvas_w, canvas_h, animated


# ----------------------------------------------------------------- 图像处理

def add_shadow(rgba, width, height, offset, blur, strength, shadow_color):
    """
    在图片下方加一层柔和投影，返回更大的画布（RGBA）。

    为什么加：颜色键只保证"背景"透明，图片边缘的抗锯齿像素会残留底色；
    有一层投影过渡之后，视觉上就是"浮在桌面上"。
    """
    if not (isinstance(shadow_color, str) and shadow_color.startswith("#") and len(shadow_color) == 7):
        shadow_color = "#000000"
    sr = int(shadow_color[1:3], 16)
    sg = int(shadow_color[3:5], 16)
    sb = int(shadow_color[5:7], 16)

    pad = blur + offset
    canvas_w = width + pad * 2
    canvas_h = height + pad * 2
    canvas = bytearray(canvas_w * canvas_h * 4)

    # ---- 1) 投影：图片 alpha 平移 + 模糊，再压暗上色
    alpha = bytes(rgba[i * 4 + 3] for i in range(width * height))
    blurred = bytearray(width * height)
    if blur > 0:
        temp = bytearray(width * height)
        for y in range(height):
            row = y * width
            for x in range(width):
                total = 0
                count = 0
                for dx in range(-blur, blur + 1):
                    xx = x + dx
                    if 0 <= xx < width:
                        total += alpha[row + xx]
                        count += 1
                temp[row + x] = total // count
        for x in range(width):
            for y in range(height):
                total = 0
                count = 0
                for dy in range(-blur, blur + 1):
                    yy = y + dy
                    if 0 <= yy < height:
                        total += temp[yy * width + x]
                        count += 1
                blurred[y * width + x] = total // count
    else:
        blurred[:] = alpha

    for y in range(height):
        for x in range(width):
            a = int(blurred[y * width + x] * strength)
            if a <= 0:
                continue
            cx = x + pad
            cy = y + pad + offset
            if not (0 <= cx < canvas_w and 0 <= cy < canvas_h):
                continue
            i = (cy * canvas_w + cx) * 4
            canvas[i] = sr
            canvas[i + 1] = sg
            canvas[i + 2] = sb
            canvas[i + 3] = min(255, a)

    # ---- 2) 本体合成到投影之上（source-over）
    for y in range(height):
        for x in range(width):
            si = (y * width + x) * 4
            sa = rgba[si + 3]
            if sa == 0:
                continue
            di = ((y + pad) * canvas_w + (x + pad)) * 4
            da = canvas[di + 3]
            out_a = sa + da * (255 - sa) // 255
            if out_a == 0:
                continue
            for channel in range(3):
                src_c = rgba[si + channel]
                dst_c = canvas[di + channel]
                canvas[di + channel] = (src_c * sa + dst_c * da * (255 - sa) // 255) // out_a
            canvas[di + 3] = out_a

    return canvas, canvas_w, canvas_h


def scale_rgba(rgba, width, height, dst_w, dst_h):
    if (dst_w, dst_h) == (width, height):
        return rgba
    return png.resize_rgba(rgba, width, height, dst_w, dst_h)


def rgba_to_photo(image, rgba, width, height, threshold=128):
    """
    RGBA 缓冲 → tkinter PhotoImage。

    用 PPM 头（P6）让 tk 自己解，比逐个 put 快几个数量级。
    alpha 低于阈值的像素替换成透明色键 —— 颜色键方案只能二值化，这是固有限制。
    """
    key_rgb = (255, 0, 254)
    body = bytearray(width * height * 3)
    for i in range(width * height):
        if rgba[i * 4 + 3] < threshold:
            body[i * 3] = key_rgb[0]
            body[i * 3 + 1] = key_rgb[1]
            body[i * 3 + 2] = key_rgb[2]
        else:
            body[i * 3] = rgba[i * 4]
            body[i * 3 + 1] = rgba[i * 4 + 1]
            body[i * 3 + 2] = rgba[i * 4 + 2]

    header = f"P6 {width} {height} 255 ".encode("ascii")
    return tk.PhotoImage(master=image, data=header + bytes(body), format="ppm")


# ------------------------------------------------------------------- 桌宠本体

class Pet:
    def __init__(self, config, watch_app=False):
        self.config = config
        self.watch_app = watch_app
        self.root = tk.Tk()
        self.root.title("CC Desktop 桌宠")
        self.root.overrideredirect(True)
        self.root.attributes("-topmost", True)

        image_path = find_image(config["image"])
        if image_path is None:
            messagebox.showerror(
                "找不到图片",
                f"没有可用的图片。\n\n请在 {CONFIG_PATH} 里把 \"image\" 指向你的图片，\n"
                f"或者把图片存成 {os.path.join(HERE, 'pet.gif')}（或 pet.png）。",
            )
            raise SystemExit(1)
        self.image_path = image_path
        log(f"素材：{image_path}")

        # 初始形象的加载全部交给 prepare_skin —— 与"换装"走同一条路径，
        # 避免初始化和热切换两套逻辑各自出岔子。
        self.key = TRANSPARENT_KEY if bool(config.get("transparent", True)) else "#202024"
        images, delays, canvas_w, canvas_h, animated = self.prepare_skin(image_path)
        self.width = canvas_w
        self.height = canvas_h
        self.animated = animated

        if config.get("transparent", True):
            self.root.config(bg=TRANSPARENT_KEY)
            self.root.attributes("-transparentcolor", TRANSPARENT_KEY)
        else:
            self.root.config(bg=self.key)

        self.canvas = tk.Canvas(
            self.root, width=self.width, height=self.height,
            highlightthickness=0, bd=0, bg=self.key,
        )
        self.canvas.pack()

        # 帧在 prepare_skin 里就已经转成 PhotoImage 了，播放期间零解码开销
        self.frame_images = images
        self.frame_delays = delays
        self.frame_index = 0

        self.item = self.canvas.create_image(
            0, self.height, anchor="sw", image=self.frame_images[0])

        x, y = load_position()
        self._place(x, y)

        self.bubble = None
        self.bubble_label = None
        self.bubble_hide_job = None
        self.anim_job = None
        self.poll_job = None
        self.watch_job = None
        self.detail_window = None
        self.detail_text = None
        self.balance_job = None
        self.alert_state = None
        self.closing = False
        self.drag_origin = None
        self.dragged = False
        self.snapshot = ledger_data.read_snapshot()
        # 提醒去重记录（持久化，免得每次开机重复告警）
        self.alert_state = load_alert_state()
        # 余额数字滚动用
        self.display_balance = None

        self.bind_canvas_events()
        self.root.bind("<Escape>", lambda _e: self.quit())
        self.root.protocol("WM_DELETE_WINDOW", self.quit)

        self.build_menu()

        log(f"窗口就绪：{self.width}x{self.height} @ {self.pos}，"
            f"{len(self.frame_images)} 帧，动画={self.animated}，透明={self.config.get('transparent', True)}")

        if config.get("animate", True) and len(self.frame_images) > 1:
            self.start_animation()
        self.start_polling()
        if self.watch_app:
            self.start_app_watch()

    # ---------------------------------------------------------------- 位置

    def _place(self, x, y):
        screen_w = self.root.winfo_screenwidth()
        screen_h = self.root.winfo_screenheight()
        if x is None or y is None:
            x = screen_w - self.width - 60
            y = screen_h - self.height - 90
        x = max(0, min(int(x), screen_w - self.width))
        y = max(0, min(int(y), screen_h - 40))     # 允许略微出屏，像"蹲"在底部
        self.root.geometry(f"{self.width}x{self.height}+{x}+{y}")
        self.pos = (x, y)

    # ---------------------------------------------------------------- 交互

    def on_press(self, event):
        self.drag_origin = (event.x_root - self.pos[0], event.y_root - self.pos[1])
        self.dragged = False

    def on_drag(self, event):
        if self.drag_origin is None:
            return
        self.dragged = True
        self._place(event.x_root - self.drag_origin[0], event.y_root - self.drag_origin[1])
        if self.bubble is not None:
            self.position_bubble()

    def on_release(self, _event):
        self.drag_origin = None
        save_position(*self.pos)
        if not self.dragged and self.config.get("bubble_on_click", True):
            self.toggle_bubble()
    def on_menu(self, event):
        try:
            self.menu.tk_popup(event.x_root, event.y_root)
        finally:
            self.menu.grab_release()

    def build_menu(self):
        self.menu = tk.Menu(self.root, tearoff=0)
        self.menu.add_command(label="显示余额", command=self.show_bubble)
        self.menu.add_command(label="刷新余额（联网）", command=self.request_balance_refresh)
        self.menu.add_command(label="刷新数据", command=self.refresh)
        self.menu.add_command(label="用量明细…", command=self.show_details)
        self.menu.add_separator()

        # ---- 换形象。放一张图进 skins/ 就能在这里直接切换，不用改配置文件、不用重启。
        skins = list_skins()
        current = os.path.abspath(self.image_path) if getattr(self, "image_path", None) else ""
        label = f"换形象（{len(skins)} 个）" if skins else "换形象（形象库是空的）"
        self.skin_menu = tk.Menu(self.menu, tearoff=0)
        if skins:
            for name, path in skins:
                mark = "● " if os.path.abspath(path) == current else "   "
                self.skin_menu.add_command(
                    label=f"{mark}{name}",
                    command=lambda p=path: self.switch_skin(p))
        else:
            self.skin_menu.add_command(label="（把 gif/png 放进形象库）", state="disabled")
        self.skin_menu.add_separator()
        self.skin_menu.add_command(label="打开形象库文件夹", command=self.open_skin_folder)
        self.skin_menu.add_command(label="浏览…", command=self.browse_skin)
        self.menu.add_cascade(label=label, menu=self.skin_menu)
        # 每次展开前重扫一遍形象库：这样往 skins/ 里丢一张图之后，
        # 不用重启桌宠就能在菜单里看到它。
        self.menu.bind("<<MenuSelect>>", self.on_menu_select)

        self.animation_var = tk.BooleanVar(value=bool(self.config.get("animate", True)))
        self.menu.add_checkbutton(label="动画", variable=self.animation_var,
                                  command=self.toggle_animation)
        self.menu.add_separator()
        source = os.path.basename(self.image_path)
        kind = f"动图 {len(self.frame_images)} 帧" if self.animated else "静态图"
        self.menu.add_command(label=f"当前：{source}（{kind}）", state="disabled")
        alert = self.config.get("balance_alert")
        budget = self.config.get("daily_budget")
        summary = []
        if alert is not None:
            summary.append(f"预警 {alert}")
        if budget is not None:
            summary.append(f"预算 {budget}")
        self.menu.add_command(
            label=f"提醒：{' · '.join(summary) if summary else '未设置（改 config.json）'}",
            state="disabled")
        self.menu.add_command(label="居中到底部", command=self.reset_position)
        self.menu.add_separator()
        self.menu.add_command(label="退出", command=self.quit)

    # ---------------------------------------------------------------- 形象

    def prepare_skin(self, image_path):
        """
        加载一个形象，产出可以直接显示的帧。

        返回 (frame_images, frame_delays, canvas_w, canvas_h, animated)。
        纯计算、不碰窗口 —— 所以换装时可以先算好再切换，中间不会闪出半成品。
        """
        started = time.time()
        entries, canvas_w, canvas_h, animated = load_frames(
            image_path, int(self.config["width"]), cutout=self.config.get("cutout"))

        durations = []
        prepared = []
        for rgba, width, height, delay in entries:
            if self.config.get("shadow", True):
                rgba, width, height = add_shadow(
                    rgba, width, height,
                    int(self.config.get("shadow_offset", 4)),
                    int(self.config.get("shadow_blur", 3)),
                    float(self.config.get("shadow_strength", 0.45)),
                    self.config.get("shadow_color", "#000000"),
                )
            if (width, height) != (canvas_w, canvas_h):
                # 投影会让每帧尺寸略有差异，统一到画布尺寸（左上对齐）
                canvas = bytearray(canvas_w * canvas_h * 4)
                for y in range(min(height, canvas_h)):
                    src = y * width * 4
                    dst = y * canvas_w * 4
                    span = min(width, canvas_w) * 4
                    canvas[dst:dst + span] = rgba[src:src + span]
                rgba = canvas
            prepared.append((rgba, width, height, delay))
            durations.append(delay)

        images = []
        delays = []
        for rgba, _w, _h, delay in prepared:
            images.append(rgba_to_photo(self.root, rgba, canvas_w, canvas_h))
            delays.append(delay if delay and delay > 0 else 100)

        # 静态图：用"呼吸起伏"造几帧代替动画
        if not (animated and len(prepared) > 1) and self.config.get("breath", True):
            amount = float(self.config.get("breath_amount", 0.03))
            base = prepared[0][0]
            for _label, factor in (("short", 1 - amount), ("tiny", 1 - amount * 1.6)):
                dst_h = max(1, int(round(canvas_h * factor)))
                scaled = scale_rgba(base, canvas_w, canvas_h, canvas_w, dst_h)
                padded = bytearray(canvas_w * canvas_h * 4)
                for y in range(min(dst_h, canvas_h)):
                    src = y * canvas_w * 4
                    padded[src:src + canvas_w * 4] = scaled[src:src + canvas_w * 4]
                images.append(rgba_to_photo(self.root, padded, canvas_w, canvas_h))
                delays.append(max(200, int(self.config.get("breath_period_ms", 2600)) // 4))

        log(f"形象加载完成：{os.path.basename(image_path)} {canvas_w}x{canvas_h} "
            f"{len(images)} 帧，耗时 {time.time() - started:.1f}s")
        return images, delays, canvas_w, canvas_h, animated and len(prepared) > 1

    def switch_skin(self, path, remember=True):
        """
        热切换形象：不用重启、不用改配置文件。

        先把新形象整帧准备好（这一步可能几秒），再一次性替换并重建画布 ——
        这样切换过程中不会闪出半成品，也不会因为帧尺寸变了而错位。
        """
        path = os.path.abspath(path)
        if not os.path.exists(path):
            log(f"换装失败：找不到 {path}")
            return False
        if path == getattr(self, "image_path", None):
            return True

        # 尺寸可能不同，先记住当前的位置（可能超出新尺寸）
        self.overlay_text(f"正在加载 {os.path.basename(path)} …")
        self.root.update_idletasks()

        try:
            images, delays, canvas_w, canvas_h, animated = self.prepare_skin(path)
        except (png.PngError, gif.GifError) as err:
            log(f"换装失败：{err}")
            self.overlay_text(f"换装失败：{err}", seconds=4)
            return False

        was_moving = self.anim_job is not None
        self.stop_animation()

        self.image_path = path
        self.config["image"] = path
        self.frame_images = images
        self.frame_delays = delays
        self.width = canvas_w
        self.height = canvas_h
        self.animated = animated

        # 重建画布（尺寸可能变了）
        self.canvas.destroy()
        self.canvas = tk.Canvas(self.root, width=self.width, height=self.height,
                                highlightthickness=0, bd=0, bg=self.key)
        self.canvas.pack()
        self.item = self.canvas.create_image(
            0, self.height, anchor="sw", image=self.frame_images[0])
        self.frame_index = 0
        self.bind_canvas_events()

        # 位置：保持"贴右下角"的观感，重新夹一遍边界
        self._place(self.pos[0], self.pos[1])
        if self.bubble is not None:
            self.position_bubble()

        if was_moving and self.config.get("animate", True) and len(self.frame_images) > 1:
            self.start_animation()
        elif not self.animated and self.config.get("animate", True) and len(self.frame_images) > 1:
            self.start_animation()

        if remember:
            save_image_choice(path)
        if self.detail_window is not None:
            self.update_details()

        self.overlay_text(f"形象：{os.path.splitext(os.path.basename(path))[0]}", seconds=2)
        return True

    def bind_canvas_events(self):
        """画布每次重建都要重新绑一遍（换装时会重建）。"""
        self.canvas.bind("<ButtonPress-1>", self.on_press)
        self.canvas.bind("<B1-Motion>", self.on_drag)
        self.canvas.bind("<ButtonRelease-1>", self.on_release)
        self.canvas.bind("<Button-3>", self.on_menu)
        self.canvas.bind("<Double-Button-1>", lambda _e: self.toggle_bubble())

    def overlay_text(self, text, seconds=0):
        """
        在桌宠上方临时显示一行提示。

        为什么要有它：换装（尤其大动图）要几秒，期间窗口可能还是旧形象，
        没有反馈的话用户会以为没生效、然后反复点。用气泡承载提示，
        不额外造窗口。
        """
        try:
            self.show_bubble(persistent=True, refresh=False)
            if self.bubble_label is not None:
                self.bubble_label.config(text=text)
                self.position_bubble()
            if seconds > 0:
                if self.bubble_hide_job is not None:
                    self.root.after_cancel(self.bubble_hide_job)
                self.bubble_hide_job = self.root.after(int(seconds * 1000), self.hide_bubble)
        except tk.TclError:
            pass

    def on_menu_select(self, event):
        """右键菜单展开时重扫形象库（tkinter 的 <<MenuSelect>> 不带"展开"信息，
        所以在菜单第一次显示时刷新一次即可）。"""
        try:
            if not getattr(self, "_menu_refreshed", False):
                self.refresh_skin_menu()
                self._menu_refreshed = True
        except tk.TclError:
            pass

    def refresh_skin_menu(self):
        """重建"换形象"子菜单。往 skins/ 丢图之后调它就能看到新素材。"""
        skins = list_skins()
        current = os.path.abspath(self.image_path) if getattr(self, "image_path", None) else ""
        menu = getattr(self, "skin_menu", None)
        if menu is None:
            return
        try:
            menu.delete(0, "end")
            if skins:
                for name, path in skins:
                    mark = "● " if os.path.abspath(path) == current else "   "
                    menu.add_command(label=f"{mark}{name}",
                                     command=lambda p=path: self.switch_skin(p))
            else:
                menu.add_command(label="（把 gif/png 放进形象库）", state="disabled")
            menu.add_separator()
            menu.add_command(label="打开形象库文件夹", command=self.open_skin_folder)
            menu.add_command(label="浏览…", command=self.browse_skin)
            # 顺带更新 cascade 上的计数与"当前素材"那行
            self.menu.entryconfigure(4, label=f"换形象（{len(skins)} 个）"
                                     if skins else "换形象（形象库是空的）")
            source = os.path.basename(self.image_path) if getattr(self, "image_path", None) else ""
            kind = f"动图 {len(self.frame_images)} 帧" if self.animated else "静态图"
            self.menu.entryconfigure(8, label=f"当前：{source}（{kind}）")
        except tk.TclError:
            pass

    def open_skin_folder(self):
        """打开形象库目录（资源管理器）。"""
        target = ensure_skin_dir()
        try:
            os.startfile(target)                 # noqa: S606  Windows 专用
        except (OSError, AttributeError) as err:
            log(f"打不开形象目录：{err}")
            messagebox.showinfo("形象库", f"形象目录：\n{target}")

    def browse_skin(self):
        """
        用文件对话框挑一张图，立刻换上并记到 config.json。

        挑完会**复制进形象库**（可选）：直接引用外部路径的话，那张图被移走/改名，
        桌宠下次启动就找不到形象了。复制进来更稳。
        """
        from tkinter import filedialog
        ensure_skin_dir()
        path = filedialog.askopenfilename(
            parent=self.root,
            title="选择桌宠形象",
            initialdir=SKIN_DIR,
            filetypes=[("动图或图片", "*.gif *.png"), ("GIF 动图", "*.gif"),
                       ("PNG 图片", "*.png"), ("全部文件", "*.*")],
        )
        if not path:
            return

        target = path
        try:
            if os.path.abspath(os.path.dirname(path)) != os.path.abspath(SKIN_DIR):
                name = os.path.basename(path)
                candidate = os.path.join(SKIN_DIR, name)
                stem, ext = os.path.splitext(name)
                serial = 1
                while os.path.exists(candidate) and os.path.abspath(candidate) != os.path.abspath(path):
                    candidate = os.path.join(SKIN_DIR, f"{stem}-{serial}{ext}")
                    serial += 1
                shutil.copy2(path, candidate)
                target = candidate
                log(f"已把素材复制进形象库：{target}")
        except OSError as err:
            # 复制失败就直接引用原路径，别拦着用户用
            log(f"复制进形象库失败（仍使用原路径）：{err}")

        self.switch_skin(target)

    # ---------------------------------------------------------------- 明细窗口

    def show_details(self):
        """用量明细窗口（对齐 DSH 挂件里的「用量记录」面板）。"""
        if self.detail_window is not None:
            try:
                self.detail_window.lift()
                self.detail_window.focus_force()
                return
            except tk.TclError:
                self.detail_window = None

        bg = self.config.get("bubble_bg", "#1e1e22")
        fg = self.config.get("bubble_fg", "#f0f0f2")
        size = int(self.config.get("detail_window_font", 10))

        window = tk.Toplevel(self.root)
        self.detail_window = window
        window.title("DeepSeek 用量明细")
        window.attributes("-topmost", True)
        window.config(bg=bg)
        window.geometry("560x420")

        frame = tk.Frame(window, bg=bg)
        frame.pack(fill="both", expand=True, padx=10, pady=10)

        text = tk.Text(frame, wrap="none", bg=bg, fg=fg, bd=0,
                       font=("Consolas", size), insertbackground=fg)
        scroll = tk.Scrollbar(frame, command=text.yview)
        text.configure(yscrollcommand=scroll.set)
        scroll.pack(side="right", fill="y")
        text.pack(side="left", fill="both", expand=True)

        self.detail_text = text
        self.update_details()

        def on_close():
            self.detail_window = None
            self.detail_text = None
            window.destroy()

        window.protocol("WM_DELETE_WINDOW", on_close)

    def update_details(self):
        text = getattr(self, "detail_text", None)
        if text is None:
            return
        try:
            text.configure(state="normal")
            text.delete("1.0", "end")
            text.insert("1.0", ledger_data.detail_text(self.snapshot))
            text.configure(state="disabled")
        except tk.TclError:
            self.detail_window = None
            self.detail_text = None

    def reset_position(self):
        self._place(None, None)
        save_position(*self.pos)
        if self.bubble is not None:
            self.position_bubble()

    # ---------------------------------------------------------------- 泡泡

    def toggle_bubble(self):
        if self.bubble is not None:
            self.hide_bubble()
            return
        # 点一下 = 顺便去后台问一次余额（对齐 DSH 挂件的"点鲸鱼手动刷新"）
        if self.config.get("refresh_on_click", True):
            self.request_balance_refresh()
        self.show_bubble(refresh=False)

    def request_balance_refresh(self):
        """
        在后台线程里调插件的 MCP server 执行一次 get_balance。

        为什么走 MCP 而不是自己发 HTTP：账本的读改写、排他锁、凭据查找、
        峰谷计价都已经在插件里实现并测过了（47 项自检）。在这里再写一份
        就等于制造第二个真相源，而且绕开了那把锁。
        """
        if self.balance_job is not None:
            return                      # 上一次还没回来，别叠加
        server = os.path.join(HERE, "..", "plugins", "whale-balance", "server.mjs")
        server = os.path.abspath(server)
        if not os.path.exists(server):
            log(f"余额刷新跳过：找不到插件 {server}")
            return

        def work():
            import subprocess
            exe = os.path.join(os.path.dirname(HERE), "CC Desktop.exe")
            try:
                creation = getattr(subprocess, "CREATE_NO_WINDOW", 0)
                payload = ('{"jsonrpc":"2.0","id":1,"method":"tools/call",'
                           '"params":{"name":"get_balance","arguments":{}}}\n')
                # encoding="utf-8" 必须显式给：subprocess 的 text=True 默认用**系统
                # locale 编码**（中文 Windows = GBK），而插件输出的是 UTF-8 中文报错，
                # 于是解码线程直接抛 UnicodeDecodeError、拿不到任何输出
                # （本插件踩过：日志里只有一句空的"余额刷新失败"）。
                result = subprocess.run(
                    [exe, server], input=payload, capture_output=True,
                    encoding="utf-8", errors="replace",
                    timeout=40, creationflags=creation,
                    # 把 EXE 当 Node 跑，且不依赖系统 PATH 里有没有 node
                    env={**os.environ, "ELECTRON_RUN_AS_NODE": "1"},
                )
                text = ""
                for line in (result.stdout or "").splitlines():
                    if '"result"' in line or '"error"' in line:
                        text = line
                        break
                ok = '"isError":false' in text
                if ok:
                    note = "已更新余额"
                else:
                    # 把插件给的说明提取出来（通常是"没找到 API key"这类可操作提示）
                    note = ""
                    marker = '"text":"'
                    at = text.find(marker)
                    if at >= 0:
                        note = text[at + len(marker):].split('"')[0][:160]
                    if not note:
                        note = (result.stderr or "").strip().splitlines()[-1:] or [""]
                        note = note[0][:160]
                log(f"余额刷新{'成功：' + note if ok else '失败：' + note}")
            except Exception as err:                 # noqa: BLE001
                log(f"余额刷新异常：{err}")
            finally:
                self.balance_job = None
                try:
                    self.root.after(0, self.refresh)
                except (tk.TclError, RuntimeError):
                    pass

        import threading
        self.balance_job = threading.Thread(target=work, daemon=True)
        self.balance_job.start()

    def show_bubble(self, persistent=False, refresh=True):
        if refresh:
            self.refresh()
        if self.bubble is None:
            bg = self.config.get("bubble_bg", "#1e1e22")
            self.bubble = tk.Toplevel(self.root)
            self.bubble.overrideredirect(True)
            self.bubble.attributes("-topmost", True)
            self.bubble.config(bg=bg)
            self.bubble_label = tk.Label(
                self.bubble, justify="left", anchor="w", padx=12, pady=8,
                bg=bg, fg=self.config.get("bubble_fg", "#f0f0f2"),
                font=("Microsoft YaHei UI", 10),
            )
            self.bubble_label.pack()
        self.update_bubble_text()
        self.position_bubble()

        timeout = int(self.config.get("bubble_timeout_ms", 8000))
        if persistent:
            timeout = 0                   # 提醒类泡泡不自动消失，让用户看见
        if self.bubble_hide_job is not None:
            self.root.after_cancel(self.bubble_hide_job)
            self.bubble_hide_job = None
        if timeout > 0:
            self.bubble_hide_job = self.root.after(timeout, self.hide_bubble)

    def position_bubble(self):
        if self.bubble is None:
            return
        self.bubble.update_idletasks()
        w = self.bubble.winfo_reqwidth()
        h = self.bubble.winfo_reqheight()
        x = max(0, min(self.pos[0] + self.width // 2 - w // 2,
                       self.root.winfo_screenwidth() - w))
        y = self.pos[1] - h - 6
        if y < 0:
            y = self.pos[1] + 8
        self.bubble.geometry(f"{w}x{h}+{x}+{y}")

    def hide_bubble(self):
        if self.bubble_hide_job is not None:
            self.root.after_cancel(self.bubble_hide_job)
            self.bubble_hide_job = None
        if self.bubble is not None:
            self.bubble.destroy()
            self.bubble = None
            self.bubble_label = None

    # ---------------------------------------------------------------- 动画

    def start_animation(self):
        """按每帧自己的时长播放。用累计时间而不是固定 tick，避免延时被误差吃掉。"""
        self.frame_index = 0
        self.frame_started = 0
        self.frame_delays_ms = self.frame_delays

        def tick():
            if self.closing:
                return
            now = time.monotonic() * 1000
            if now - self.frame_started >= self.frame_delays_ms[self.frame_index]:
                self.frame_index = (self.frame_index + 1) % len(self.frame_images)
                self.frame_started = now
                try:
                    self.canvas.itemconfig(self.item, image=self.frame_images[self.frame_index])
                except tk.TclError:
                    return
            self.anim_job = self.root.after(16, tick)

        self.frame_started = time.monotonic() * 1000
        self.anim_job = self.root.after(16, tick)

    def stop_animation(self):
        if self.anim_job is not None:
            try:
                self.root.after_cancel(self.anim_job)
            except tk.TclError:
                pass
            self.anim_job = None

    def toggle_animation(self):
        if self.animation_var.get():
            self.start_animation()
        else:
            self.stop_animation()

    # ---------------------------------------------------------------- 数据

    def start_polling(self):
        def tick():
            if self.closing:
                return
            try:
                self.refresh()
            except Exception:                     # noqa: BLE001  刷新失败不能弄死桌宠
                pass
            self.poll_job = self.root.after(max(1000, int(self.config.get("poll_ms", 5000))), tick)

        self.poll_job = self.root.after(int(self.config.get("poll_ms", 5000)), tick)

    def start_app_watch(self):
        """可选：CC Desktop 退出时自己也退出（--watch-app）。"""
        def tick():
            if self.closing:
                return
            state = cc_desktop_running()
            # 只有"确定不在跑"才退出；查不到（None）时继续活着 ——
            # 否则在进程列表被限制的环境里，桌宠会在 5 秒后自己消失。
            if state is False:
                log("CC Desktop 已退出，桌宠跟着退出（--watch-app）")
                self.quit()
                return
            self.watch_job = self.root.after(5000, tick)

        self.watch_job = self.root.after(5000, tick)

    def refresh(self):
        self.snapshot = ledger_data.read_snapshot()
        self.check_alerts()
        if self.bubble is not None and self.bubble_label is not None:
            self.update_bubble_text()
            self.position_bubble()
        self.update_details()

    def update_bubble_text(self):
        if self.bubble_label is None:
            return
        lines = ledger_data.bubble_text(
            self.snapshot, show_peak=bool(self.config.get("bubble_show_peak", True)))
        try:
            self.bubble_label.config(text="\n".join(lines))
        except tk.TclError:
            self.bubble = None
            self.bubble_label = None

    # ---------------------------------------------------------------- 提醒

    def check_alerts(self):
        """
        余额预警 / 今日预算提醒。

        去重规则与 DSH 挂件一致：同一类提醒在冷却期内只弹一次，否则每次轮询
        （5 秒）都会刷屏。冷却时间可配（alert_cooldown_min）。
        """
        if not self.snapshot["ok"]:
            return
        cooldown = max(1, int(self.config.get("alert_cooldown_min", 30))) * 60
        now = time.time()

        alert_at = self.config.get("balance_alert")
        balance = self.snapshot["balance"]
        if alert_at is not None and balance is not None and balance < float(alert_at):
            self.fire_alert("balance",
                            f"余额偏低：{ledger_data.format_money(balance)} "
                            f"{(self.snapshot['currency'] or '').strip()}\n"
                            f"（阈值 {alert_at}）",
                            now, cooldown)

        budget = self.config.get("daily_budget")
        used = self.snapshot["today_used"]
        if budget is not None and used is not None and used >= float(budget):
            self.fire_alert("budget",
                            f"今日用量已达 {ledger_data.format_money(used, 4)}\n"
                            f"（预算 {budget}，{self.snapshot['today_turns']} 轮）",
                            now, cooldown)

    def fire_alert(self, kind, message, now, cooldown):
        last = self.alert_state.get(kind, 0)
        if now - float(last) < cooldown:
            return
        self.alert_state[kind] = now
        save_alert_state(self.alert_state)
        log(f"提醒[{kind}]：{message.splitlines()[0]}")
        self.show_bubble(persistent=True)
        if self.bubble_label is not None:
            try:
                self.bubble_label.config(
                    text=message + "\n\n（同类提醒 " +
                         f"{int(cooldown / 60)} 分钟内不重复）")
            except tk.TclError:
                pass

    # ---------------------------------------------------------------- 生命周期

    def quit(self):
        # 先立旗子再取消定时器：否则退出瞬间还在排队的 tick 会往已销毁的
        # canvas 上画东西，Tcl 抛 "invalid command name ...tick"（本机实测踩到过）。
        self.closing = True
        for name in ("anim_job", "poll_job", "bubble_hide_job", "watch_job"):
            handle = getattr(self, name, None)
            if handle is not None:
                try:
                    self.root.after_cancel(handle)
                except tk.TclError:
                    pass
                setattr(self, name, None)
        # 只有"真正在跑的那个实例"才写位置：否则重复启动的实例退出时
        # 会把你刚拖好的位置覆盖掉。
        if not getattr(self, "duplicate", False):
            save_position(*self.pos)
        if self.detail_window is not None:
            try:
                self.detail_window.destroy()
            except tk.TclError:
                pass
            self.detail_window = None
        try:
            self.root.destroy()
        except tk.TclError:
            pass

    def run(self):
        self.root.mainloop()


def _process_names():
    """
    列出当前进程名（小写）。返回 None 表示"查不到" —— 与"确实没有"必须区分开。

    两种手段：tasklist 更通用，Get-Process 在某些受限环境里才可用
    （本机实测：沙箱下 tasklist 直接 `ERROR: Access denied` 返回空 stdout，
    而 Get-Process 正常）。把两者串起来，容忍任意一种失效。
    """
    creation = getattr(subprocess, "CREATE_NO_WINDOW", 0)

    try:
        result = subprocess.run(["tasklist", "/NH", "/FO", "CSV"],
                                capture_output=True, text=True, timeout=20,
                                creationflags=creation)
        if result.returncode == 0 and result.stdout:
            names = set()
            for line in result.stdout.splitlines():
                parts = line.split('","')
                if len(parts) >= 2:
                    names.add(parts[0].strip('"').lower())
            if names:
                return names
        log(f"tasklist 不可用（rc={result.returncode}，"
            f"stderr={(result.stderr or '').strip()[:60]}），改用 Get-Process")
    except (OSError, subprocess.SubprocessError) as err:
        log(f"tasklist 异常（{err}），改用 Get-Process")

    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command", "Get-Process | Select-Object -Expand Name"],
            capture_output=True, text=True, timeout=30, creationflags=creation)
        if result.returncode == 0 and result.stdout:
            names = {line.strip().lower() for line in result.stdout.splitlines() if line.strip()}
            # Get-Process 给的是不带 .exe 的名字
            return names | {f"{n}.exe" for n in names}
    except (OSError, subprocess.SubprocessError) as err:
        log(f"Get-Process 也失败（{err}）")

    return None


def cc_desktop_running(install_root=None):
    """
    CC Desktop 是否在跑。

    返回 True / False / **None**（查不到）。调用方必须区分 None 和 False：
    把"查不到"当成 False 会让 --watch-app 误杀桌宠、
    让 --wait-for-app 白等 5 分钟 —— 本插件两个方向都踩过。
    """
    root = install_root or os.path.dirname(HERE)
    image = os.path.basename(os.path.join(root, "CC Desktop.exe")).lower()

    names = _process_names()
    if names is None:
        return None
    return image in names


def main():
    parser = argparse.ArgumentParser(description="CC Desktop 桌宠")
    parser.add_argument("--image", help="桌宠图片：GIF 动图或 PNG 静态图")
    parser.add_argument("--width", type=int, help="显示宽度（像素），高度按比例")
    parser.add_argument("--no-shadow", action="store_true", help="不加投影")
    parser.add_argument("--no-animate", action="store_true", help="不动（动图只显示第一帧）")
    parser.add_argument("--cutout", type=int, metavar="TOLERANCE",
                        help="抠掉四边连通的纯色背景，参数是容差（0-255）")
    parser.add_argument("--transparent-key", choices=["on", "none"], default=None,
                        help="none = 关掉透明（排查『整块黑』之类问题时用）")
    parser.add_argument("--config", help="指定 config.json 路径")
    parser.add_argument("--allow-multiple", action="store_true",
                        help="允许多开（默认单实例：已有桌宠就直接退出）")
    parser.add_argument("--watch-app", action="store_true",
                        help="CC Desktop 退出时自己也退出（随应用生命周期）")
    parser.add_argument("--wait-for-app", action="store_true",
                        help="先等 CC Desktop 起来再显示（开机自启用）")
    args = parser.parse_args()

    log(f"启动：pid={os.getpid()} argv={sys.argv[1:]}")

    # --wait-for-app：开机自启时先等 CC Desktop 起来再出现，免得孤零零先冒出来。
    # 这段逻辑放在 Python 里而不是 .bat 里 —— cmd 的括号块和 PowerShell 引号
    # 太容易互相咬到（本插件踩过：批处理直接 "was unexpected at this time"）。
    if args.wait_for_app:
        log("等待 CC Desktop 启动（最多 300 秒）…")
        deadline = time.time() + 300
        while time.time() < deadline:
            state = cc_desktop_running()
            if state is None:
                # 查不到就别等了：宁可桌宠早出现，也不要开机后干等 5 分钟
                log("检测不到进程列表（环境受限），不再等待，直接启动桌宠")
                break
            if state:
                log("CC Desktop 已在运行，继续启动桌宠")
                break
            time.sleep(1)
        else:
            log("等超时了，仍然启动桌宠")

    if not args.allow_multiple and not claim_single_instance():
        # 已经有一个在跑：这次启动不做事。启动器会把它请到前台。
        log("已有实例在运行，本次启动退出")
        print("[pet] 已经有一个桌宠在运行了（单实例）。要开多个请加 --allow-multiple。")
        return 3
    log(f"单实例锁已获取（pid={os.getpid()}）")

    global CONFIG_PATH
    if args.config:
        CONFIG_PATH = os.path.abspath(args.config)

    config = load_config()
    if args.image:
        # --image 指定的素材会**记住**：写回 config.json，下次启动还是它。
        # （临时试一下不想记住，就改 config.json 或直接编辑 skins 目录）
        config["image"] = os.path.abspath(args.image)
    if args.width:
        config["width"] = args.width
    if args.no_shadow:
        config["shadow"] = False
    if args.no_animate:
        config["animate"] = False
    if args.cutout is not None:
        config["cutout"] = {"tolerance": args.cutout}
    if args.transparent_key == "none":
        config["transparent"] = False

    image_path = find_image(config["image"])
    if image_path is None:
        print("[pet] 找不到图片。请设置 config.json 的 \"image\"，或用 --image 指定。", file=sys.stderr)
        print(f"[pet] 也可以把图片存成 {os.path.join(HERE, 'pet.gif')}（或 pet.png）。", file=sys.stderr)
        return 2
    config["image"] = image_path

    # --image 传进来的素材持久化，这样"换形象"不需要每次重新指定
    if args.image and os.path.abspath(args.image) == os.path.abspath(image_path):
        save_image_choice(image_path)

    try:
        app = Pet(config, watch_app=args.watch_app)
        app.run()
        log("主循环结束，正常退出")
    except (png.PngError, gif.GifError) as err:
        log(f"素材解码失败：{err}")
        print(f"[pet] 素材解码失败：{err}", file=sys.stderr)
        try:
            messagebox.showerror("桌宠启动失败", f"素材解码失败：\n\n{err}")
        except Exception:                          # noqa: BLE001
            pass
        return 1
    except Exception as err:                       # noqa: BLE001
        # pythonw 下没有 stderr，异常会静默消失 —— 记日志 + 弹窗，别让用户对着空气猜
        import traceback
        log(f"未预期异常：{err}\n{traceback.format_exc()}")
        try:
            messagebox.showerror("桌宠启动失败",
                                 f"{err}\n\n详细日志：{LOG_PATH}")
        except Exception:                          # noqa: BLE001
            pass
        return 1
    finally:
        release_single_instance()
    return 0


if __name__ == "__main__":
    # 包一层：pythonw 没有 stderr，任何未捕获异常都会让进程"无声消失"。
    # 这里至少把它写进 pet.log 并弹个框，否则排查只能靠猜。
    try:
        code = main()
    except SystemExit as exc:                      # noqa: PERF203
        code = exc.code if isinstance(exc.code, int) else 0
    except BaseException as exc:                   # noqa: BLE001
        import traceback
        log(f"启动阶段崩溃：{exc}\n{traceback.format_exc()}")
        code = 1
    log(f"进程退出，code={code}")
    raise SystemExit(code)
