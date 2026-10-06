#!/usr/bin/env python3
"""
桌宠自检 —— 不需要联网、不需要 CC Desktop 在跑、不需要你的素材。

覆盖：
  1. PNG 编码器（本文件里手写，用来造测试图）与解码器互为逆运算
  2. 各种色彩类型/位深：RGBA、RGB、灰度、灰度+Alpha、调色板
  3. 5 种行过滤器全部走一遍
  4. alpha 缩放的"不发黑"性质（透明区 RGB 是黑也不能把边缘拉黑）
  5. 裁透明边、加投影的尺寸与不越界
  6. 账本读取：缺文件、坏 JSON、定点转换、"今日"按北京日

用法：python test_pet.py
退出码：0 全过 / 1 有断言失败
"""

import json
import os
import struct
import sys
import tempfile
import time
import zlib

# Windows 控制台默认是 GBK 代码页，直接打印 ✓/✗ 会 UnicodeEncodeError。
# 自检脚本必须在任何环境下都能跑完，所以这里强制切到 UTF-8 输出。
for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import png                      # noqa: E402
import ledger_data              # noqa: E402

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


def eq(actual, expected, label=""):
    if actual != expected:
        raise AssertionError(f"{label}期望 {expected!r}，实际 {actual!r}")
    return str(actual)


def assert_true(cond, message):
    if not cond:
        raise AssertionError(message)


# --------------------------------------------------------------- PNG 编码器

def _chunk(kind, payload):
    return (struct.pack(">I", len(payload)) + kind + payload
            + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF))


def encode_png(width, height, rows, bit_depth=8, color_type=6, palette=None, trns=None,
               filter_type=0, interlace=0, channels=None):
    """
    手写一个 PNG。rows 是每行的原始字节（未加过滤字节）。
    filter_type 指定对每行使用哪种过滤器：0=None 1=Sub 2=Up 3=Average 4=Paeth。
    为了让过滤器真的被解到，这里按 filter_type 对原始数据**正向**做变换。

    注意 step：Sub/Average/Paeth 都是按"左邻像素"diff 的，步长必须是
    **每像素字节数**（RGBA 是 4），不是 1。一开始写成 1 时，只有 1 通道的图能过，
    RGBA 全部解错 —— 这个用例就是为了抓住这种错误而存在的。
    """
    if channels is None:
        channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color_type]
    step = channels * (bit_depth // 8)

    raw = bytearray()
    previous = bytearray(len(rows[0]))
    for row in rows:
        line = bytearray(row)
        if filter_type == 1:
            for i in range(len(line) - 1, step - 1, -1):
                line[i] = (line[i] - line[i - step]) & 0xFF
        elif filter_type == 2:
            for i in range(len(line)):
                line[i] = (line[i] - previous[i]) & 0xFF
        elif filter_type == 3:
            for i in range(len(line)):
                left = row[i - step] if i >= step else 0
                line[i] = (line[i] - ((left + previous[i]) >> 1)) & 0xFF
        elif filter_type == 4:
            for i in range(len(line)):
                left = row[i - step] if i >= step else 0
                upleft = previous[i - step] if i >= step else 0
                line[i] = (line[i] - png._paeth(left, previous[i], upleft)) & 0xFF
        raw.append(filter_type)
        raw.extend(line)
        previous = bytearray(row)

    ihdr = struct.pack(">IIBBBBB", width, height, bit_depth, color_type, 0, 0, interlace)
    out = png.PNG_SIGNATURE + _chunk(b"IHDR", ihdr)
    if palette is not None:
        out += _chunk(b"PLTE", palette)
    if trns is not None:
        out += _chunk(b"tRNS", trns)
    out += _chunk(b"IDAT", zlib.compress(bytes(raw), 6))
    out += _chunk(b"IEND", b"")
    return out


def write_temp(data, suffix=".png"):
    handle = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    handle.write(data)
    handle.close()
    return handle.name


def rgba_rows(pixels, width):
    """pixels: [(r,g,b,a), ...] 按行优先 → 每行的字节。"""
    rows = []
    for y in range(len(pixels) // width):
        row = bytearray()
        for x in range(width):
            row.extend(pixels[y * width + x])
        rows.append(bytes(row))
    return rows


# ------------------------------------------------------------------- 用例

print("\n[1] 解码器与编码器互逆")

def case_rgba_roundtrip():
    pixels = [
        (255, 0, 0, 255), (0, 255, 0, 255), (0, 0, 255, 255),
        (255, 255, 255, 0), (128, 64, 32, 128), (1, 2, 3, 4),
    ]
    data = encode_png(3, 2, rgba_rows(pixels, 3))
    path = write_temp(data)
    try:
        width, height, got = png.decode(path)
    finally:
        os.unlink(path)
    eq(width, 3, "宽 ")
    eq(height, 2, "高 ")
    for i, want in enumerate(pixels):
        have = tuple(got[i * 4:i * 4 + 4])
        eq(have, want, f"像素 {i} ")
    return "6 像素逐字节一致"

check("RGBA 往返（含全透明与半透明）", case_rgba_roundtrip)


def case_filters():
    """同一张图用 5 种过滤器各编码一次，解码结果必须完全一样。"""
    pixels = []
    for y in range(8):
        for x in range(8):
            pixels.append(((x * 31) % 256, (y * 47) % 256, (x * y * 7) % 256, 255 - x * 3))
    reference = None
    for filter_type in (0, 1, 2, 3, 4):
        data = encode_png(8, 8, rgba_rows(pixels, 8), filter_type=filter_type)
        path = write_temp(data)
        try:
            _w, _h, got = png.decode(path)
        finally:
            os.unlink(path)
        if reference is None:
            reference = bytes(got)
        elif bytes(got) != reference:
            raise AssertionError(f"过滤器 {filter_type} 解出的结果与 filter 0 不一致")
    return "5 种过滤器结果一致"

check("5 种行过滤器（None/Sub/Up/Average/Paeth）", case_filters)


def case_rgb():
    pixels = [(10, 20, 30, 255), (40, 50, 60, 255)]
    rows = [bytes([10, 20, 30, 40, 50, 60])]
    path = write_temp(encode_png(2, 1, rows, color_type=2))
    try:
        _w, _h, got = png.decode(path)
    finally:
        os.unlink(path)
    eq(tuple(got[0:4]), (10, 20, 30, 255), "第 1 像素 ")
    eq(tuple(got[4:8]), (40, 50, 60, 255), "第 2 像素 ")
    return "RGB 自动补 alpha=255"

check("色彩类型 2（RGB）", case_rgb)


def case_gray():
    path = write_temp(encode_png(2, 1, [bytes([7, 200])], color_type=0))
    try:
        _w, _h, got = png.decode(path)
    finally:
        os.unlink(path)
    eq(tuple(got[0:4]), (7, 7, 7, 255), "灰度 7 ")
    eq(tuple(got[4:8]), (200, 200, 200, 255), "灰度 200 ")
    return "灰度 → RGB 三通道相同"

check("色彩类型 0（灰度）", case_gray)


def case_gray_alpha():
    path = write_temp(encode_png(2, 1, [bytes([90, 128, 200, 255])], color_type=4))
    try:
        _w, _h, got = png.decode(path)
    finally:
        os.unlink(path)
    eq(tuple(got[0:4]), (90, 90, 90, 128), "灰度+Alpha 1 ")
    eq(tuple(got[4:8]), (200, 200, 200, 255), "灰度+Alpha 2 ")
    return "灰度+Alpha 展开正确"

check("色彩类型 4（灰度 + Alpha）", case_gray_alpha)


def case_palette():
    # 三色调色板：红、绿、蓝；其中绿色带 tRNS 透明度 100
    palette = bytes([255, 0, 0, 0, 255, 0, 0, 0, 255])
    trns = bytes([255, 100, 255])
    rows = [bytes([0, 1, 2])]
    path = write_temp(encode_png(3, 1, rows, color_type=3, palette=palette, trns=trns))
    try:
        _w, _h, got = png.decode(path)
    finally:
        os.unlink(path)
    eq(tuple(got[0:4]), (255, 0, 0, 255), "红 ")
    eq(tuple(got[4:8]), (0, 255, 0, 100), "绿（带 tRNS） ")
    eq(tuple(got[8:12]), (0, 0, 255, 255), "蓝 ")
    return "调色板 + tRNS 正确"

check("色彩类型 3（调色板 + tRNS）", case_palette)


def case_reject_interlaced():
    path = write_temp(encode_png(2, 2, [bytes([1, 2, 3, 4]), bytes([5, 6, 7, 8])], interlace=1))
    try:
        png.decode(path)
    except png.PngError as err:
        assert_true("交错" in str(err), f"错误信息没提交错：{err}")
        return "明确拒绝而不是出错图"
    finally:
        os.unlink(path)
    raise AssertionError("交错 PNG 应当被拒绝")


check("拒绝 Adam7 交错（不静默出错图）", case_reject_interlaced)


def case_reject_16bit():
    path = write_temp(encode_png(1, 1, [bytes([0, 1, 0, 2, 0, 3, 0, 4])], bit_depth=16))
    try:
        png.decode(path)
    except png.PngError as err:
        assert_true("位深" in str(err), f"错误信息没提位深：{err}")
        return "明确拒绝"
    finally:
        os.unlink(path)
    raise AssertionError("16 位深应当被拒绝")

check("拒绝 16 位深", case_reject_16bit)


print("\n[2] 缩放：不能把边缘拉黑")

def case_resize_no_dark_halo():
    """
    构造"透明像素的 RGB 是纯黑"这个真实情况（这是最坑人的一种）：
    左边一半不透明的白，右边一半全透明但 RGB=0。
    缩小后，紧邻边界的像素应当仍然接近白色 —— 如果实现没在预乘空间做加权，
    就会明显发灰发黑。
    """
    width = height = 8
    pixels = []
    for _y in range(height):
        for x in range(width):
            if x < 4:
                pixels.append((255, 255, 255, 255))
            else:
                pixels.append((0, 0, 0, 0))
    src = bytearray()
    for pixel in pixels:
        src.extend(pixel)

    dst_w = dst_h = 2
    out = png.resize_rgba(src, width, height, dst_w, dst_h)
    left = tuple(out[0:4])
    right = tuple(out[4:8])
    assert_true(left[0] >= 250, f"左半（全不透明白）缩后应仍接近白，实际 {left}")
    eq(left[3], 255, "左半 alpha ")
    eq(right[3], 0, "右半应保持全透明，alpha ")
    return f"左 {left[:3]} alpha={left[3]}，右 alpha={right[3]}"

check("缩小后透明边缘不发黑（预乘 alpha）", case_resize_no_dark_halo)


def case_resize_alpha_average():
    """alpha 应取面积平均：一半 255 一半 0，缩到 1 像素就是 ~128。"""
    src = bytearray([0, 0, 0, 255, 0, 0, 0, 0])
    out = png.resize_rgba(src, 2, 1, 1, 1)
    eq(out[3], 127, "alpha 平均 ")
    return f"alpha={out[3]}"

check("alpha 走面积平均", case_resize_alpha_average)


def case_cutout():
    """
    实心背景 + 中间一个不同色的块。
    抠图后：背景全透明，中间那块**必须保住**；而且内部同色的部分不能被波及
    （这就是"泛洪"和"全局按颜色删"的区别）。
    """
    width = height = 9
    src = bytearray()
    for y in range(height):
        for x in range(width):
            if 3 <= x <= 5 and 3 <= y <= 5:
                src.extend((0, 0, 255, 255))       # 中间蓝块
            else:
                src.extend((200, 30, 30, 255))     # 背景红（实心、不透明）
    out, removed = png.cutout_background(bytearray(src), width, height, tolerance=10)

    eq(out[3], 0, "左上角（背景）应透明，alpha ")
    center = ((4 * width) + 4) * 4
    eq(out[center + 3], 255, "中心蓝块应保留，alpha ")
    eq(tuple(out[center:center + 3]), (0, 0, 255), "中心蓝块颜色 ")
    eq(removed, width * height - 9, "被抠掉的像素数 ")

    # 容差为 0 时，颜色差一点就抠不掉
    strict, removed_strict = png.cutout_background(bytearray(src), width, height, tolerance=0)
    eq(removed_strict, removed, "容差 0 对纯色背景应等效 ")

    # 整张同色：应当全部被抠掉（此时 trim 会返回空图，调用方会报错，不是静默出错图）
    flat = bytearray()
    for _ in range(width * height):
        flat.extend((7, 7, 7, 255))
    _out, removed_flat = png.cutout_background(flat, width, height, tolerance=5)
    eq(removed_flat, width * height, "整张纯色应全被抠掉 ")
    return f"抠掉 {removed} 像素、保留中心块"

check("抠背景：泛洪不误伤内部同色区", case_cutout)


def case_trim():
    width = height = 5
    src = bytearray(width * height * 4)
    # 只在 (2,3) 放一个不透明像素
    index = (3 * width + 2) * 4
    src[index:index + 4] = bytes([9, 8, 7, 255])
    out, w, h = png.trim_transparent(src, width, height)
    eq((w, h), (1, 1), "裁后尺寸 ")
    eq(tuple(out[0:4]), (9, 8, 7, 255), "裁后像素 ")
    return "5x5 → 1x1"

check("裁掉四周全透明边", case_trim)


def case_add_shadow_bounds():
    import pet as pet_module
    width = height = 4
    src = bytearray(width * height * 4)
    for i in range(width * height):
        src[i * 4:i * 4 + 4] = bytes([255, 255, 255, 255])
    canvas, w, h = pet_module.add_shadow(src, width, height, 2, 1, 0.5, "#000000")
    pad = 2 + 1
    eq(w, width + pad * 2, "画布宽 ")
    eq(h, height + pad * 2, "画布高 ")
    eq(len(canvas), w * h * 4, "缓冲长度 ")
    # 本体必须还在（中心区域 alpha 应为 255）
    center = ((pad + 1) * w + (pad + 1)) * 4
    eq(canvas[center + 3], 255, "本体 alpha ")
    # 画布边缘不应有东西
    eq(canvas[3], 0, "左上角 alpha ")
    return f"{width}x{height} → {w}x{h}"

check("加投影：画布尺寸与不越界", case_add_shadow_bounds)


print("\n[3] 账本读取")

def case_ledger_missing():
    path = os.path.join(tempfile.gettempdir(), "definitely-not-there-whale.json")
    if os.path.exists(path):
        os.unlink(path)
    snap = ledger_data.read_snapshot(path)
    eq(snap["ok"], False, "ok ")
    assert_true(snap["note"], "缺文件时应当有说明")
    return snap["note"][:40]

check("账本不存在时不炸", case_ledger_missing)


def case_ledger_broken():
    path = write_temp(b"{ this is not json", suffix=".json")
    try:
        snap = ledger_data.read_snapshot(path)
    finally:
        os.unlink(path)
    eq(snap["ok"], False, "ok ")
    assert_true("失败" in (snap["note"] or ""), f"应当给出失败说明：{snap['note']}")
    return "坏 JSON 被兜住"

check("账本 JSON 损坏时不炸", case_ledger_broken)


def case_ledger_values():
    today = time.strftime("%Y-%m-%d", time.gmtime(time.time() + 8 * 3600))
    ledger = {
        "version": 2,
        "balances": [
            {"ts": 1, "day": "2026-01-01", "currency": "CNY", "total": "1000000000",
             "granted": "0", "toppedUp": "0", "delta": "0", "kind": "first"},
            {"ts": int(time.time() * 1000), "day": today, "currency": "CNY", "total": "1234567890",
             "granted": "500000000", "toppedUp": "0", "delta": "0", "kind": "flat"},
        ],
        "turns": [{"ts": 1, "day": today, "model": "deepseek-flash", "cost": "69120000"}],
        "daily": {today: {"observedSpend": "1000000", "turnCost": "69120000", "turnCount": 3}},
    }
    path = write_temp(json.dumps(ledger).encode("utf-8"), suffix=".json")
    try:
        snap = ledger_data.read_snapshot(path)
    finally:
        os.unlink(path)
    eq(snap["ok"], True, "ok ")
    assert_true(abs(snap["balance"] - 12.34567890) < 1e-9, f"余额换算错误：{snap['balance']}")
    eq(snap["currency"], "CNY", "币种 ")
    assert_true(abs(snap["today_used"] - 0.6912) < 1e-9, f"今日消耗换算错误：{snap['today_used']}")
    eq(snap["today_turns"], 3, "今日轮数 ")
    assert_true(snap["balance_age"] is not None and snap["balance_age"] < 60,
                f"最近观测时间差异常：{snap['balance_age']}")
    lines = ledger_data.bubble_text(snap)
    assert_true(any("12.35" in line for line in lines), f"泡泡里没有余额：{lines}")
    assert_true(any("0.6912" in line for line in lines), f"泡泡里没有今日消耗：{lines}")
    return " | ".join(lines)

check("定点金额换算 + 泡泡文案", case_ledger_values)


def case_beijing_day():
    # 北京 2026-10-01 00:30 = UTC 2026-09-30 16:30。UTC 日与北京日不同，必须按北京算。
    ts = 1790785800  # 2026-09-30T16:30:00Z
    eq(ledger_data.beijing_day(ts), "2026-10-01", "北京日 ")
    return "跨 UTC 日界正确"

check("「今日」按北京日切分", case_beijing_day)


def case_format_helpers():
    eq(ledger_data.format_money(None), "—", "None ")
    eq(ledger_data.format_money(1234.5), "1,234.50", "千分位 ")
    eq(ledger_data.format_age(30), "刚刚", "30 秒 ")
    eq(ledger_data.format_age(600), "10 分钟前", "10 分钟 ")
    eq(ledger_data.format_age(7200), "2 小时前", "2 小时 ")
    eq(ledger_data.format_age(None), "", "None ")
    return "格式化正确"

check("显示格式化", case_format_helpers)


print("\n[4] 峰谷计价与倒计时")

def case_format_seconds():
    eq(ledger_data.format_seconds(45), "45s", "45 秒 ")
    eq(ledger_data.format_seconds(130), "2m10s", "2 分 10 秒 ")
    eq(ledger_data.format_seconds(3600), "1h00m", "1 小时 ")
    eq(ledger_data.format_seconds(5000), "1h23m", "1 小时 23 分 ")
    eq(ledger_data.format_seconds(None), "—", "None ")
    return "紧凑倒计时格式正确"

check("倒计时格式化", case_format_seconds)


def _utc(y, mo, d, h, mi):
    """构造某个 UTC 时刻的时间戳（用于断言北京时间下的小时）。"""
    import calendar
    return calendar.timegm((y, mo, d, h, mi, 0, 0, 0, 0))


def case_peak_state():
    """
    北京时间（UTC+8）：
      工作日 09:00–12:00 与 14:00–18:00 = 高峰；其余含周末全天 = 谷价。
    2026-10-01 是周四。
    """
    # UTC 02:00 = 北京 10:00 → 高峰，距 12:00 还有 2 小时
    state = ledger_data.peak_state(_utc(2026, 10, 1, 2, 0))
    eq(state["is_peak"], True, "北京 10:00 ")
    eq(state["next_change_seconds"], 7200, "距高峰结束 ")
    eq(state["next_label"], "谷价", "下一个状态 ")

    # UTC 05:00 = 北京 13:00 → 谷价，距下一段高峰（14:00）还有 1 小时
    state = ledger_data.peak_state(_utc(2026, 10, 1, 5, 0))
    eq(state["is_peak"], False, "北京 13:00 ")
    eq(state["next_change_seconds"], 3600, "距下一段高峰 ")
    eq(state["next_label"], "高峰", "下一个状态 ")

    # UTC 08:00 = 北京 16:00 → 高峰（14–18 那段），距 18:00 还有 2 小时
    state = ledger_data.peak_state(_utc(2026, 10, 1, 8, 0))
    eq(state["is_peak"], True, "北京 16:00 ")
    eq(state["next_change_seconds"], 7200, "距高峰结束 ")

    # UTC 15:00 = 北京 23:00 → 谷价，距明天 09:00 还有 10 小时
    state = ledger_data.peak_state(_utc(2026, 10, 1, 15, 0))
    eq(state["is_peak"], False, "北京 23:00 ")
    eq(state["next_change_seconds"], 36000, "距明天高峰 ")

    # 周六 UTC 02:00 = 北京周六 10:00 → 全天谷价，且下一次变化是周一 09:00
    state = ledger_data.peak_state(_utc(2026, 10, 3, 2, 0))
    eq(state["is_peak"], False, "周六北京 10:00 应为谷价 ")
    eq("周末" in state["label"], True, f"标签应点明周末：{state['label']}")

    return "高峰/谷价/周末/跨日 全部正确"

check("峰谷判定与下一次切换倒计时", case_peak_state)


def case_price_for():
    """
    价格取自插件那份 pricing.json（只有一份，不在这里重抄）。
    这里断言的是**匹配规则与峰谷折算**，不硬编码具体数字 ——
    官方调价时不该让测试挂掉。
    """
    pricing, models = ledger_data.load_pricing()
    if not models:
        return "跳过（读不到 pricing.json）"

    peak_ts = _utc(2026, 10, 1, 2, 0)      # 北京 10:00 高峰
    valley_ts = _utc(2026, 10, 1, 15, 0)   # 北京 23:00 谷价

    peak = ledger_data.price_for("deepseek-flash", peak_ts)
    valley = ledger_data.price_for("deepseek-flash", valley_ts)
    assert_true(peak is not None and valley is not None, "取不到 deepseek-flash 单价")
    eq(peak["is_peak"], True, "高峰标记 ")
    eq(valley["is_peak"], False, "谷价标记 ")
    # 谷价应当明显低于高峰（官方规则是半价，这里只断言"更低"以免调价时误报）
    assert_true(valley["cacheMiss"] < peak["cacheMiss"],
                f"谷价未低于高峰：{valley['cacheMiss']} vs {peak['cacheMiss']}")

    spec = models.get("deepseek-flash") or {}
    if spec.get("aliases"):
        alias = spec["aliases"][0]
        got = ledger_data.price_for(alias, peak_ts)
        assert_true(got is not None and got["cacheMiss"] == peak["cacheMiss"],
                    f"别名 {alias} 未匹配到同一价目")

    eq(ledger_data.price_for("totally-unknown-model", peak_ts), None,
       "未知模型应返回 None（由调用方决定降级方式） ")
    return f"高峰 {peak['cacheMiss']} / 谷价 {valley['cacheMiss']}（{peak['currency']}，来自插件价格表）"

check("单价匹配与峰谷折算", case_price_for)


print("\n[5] 用量明细文本")

def case_detail_text():
    today = ledger_data.beijing_day()
    ledger = {
        "version": 2,
        "balances": [{
            "ts": int(time.time() * 1000), "day": today, "currency": "CNY",
            "total": "5000000000", "granted": "0", "toppedUp": "0",
            "delta": "-25000000", "kind": "spend",
        }],
        "turns": [
            {"ts": int(time.time() * 1000), "day": today, "model": "deepseek-flash",
             "cost": "69120000", "peak": True, "source": "hook",
             "tokens": {"cacheHit": 1, "cacheMiss": 2, "output": 3}},
            {"ts": int(time.time() * 1000), "day": today, "model": "deepseek-v4-pro",
             "cost": "132000000", "peak": False, "source": "mcp-tool", "tokens": {}},
        ],
        "daily": {today: {"observedSpend": "25000000", "turnCost": "201120000", "turnCount": 2}},
    }
    path = write_temp(json.dumps(ledger).encode("utf-8"), suffix=".json")
    try:
        snap = ledger_data.read_snapshot(path)
    finally:
        os.unlink(path)

    assert_true(snap["ok"], f"读取失败：{snap['note']}")
    eq(snap["today_turns"], 2, "轮数 ")
    assert_true(abs(snap["today_used"] - 2.0112) < 1e-9, f"今日合计 {snap['today_used']}")
    assert_true(snap["balance_delta"] is not None and snap["balance_delta"] < 0,
                "余额变化（消费为负）未被解析")
    eq(len(snap["by_model"]), 2, "按模型分组数 ")
    eq(len(snap["recent_turns"]), 2, "最近轮次条数 ")

    text = ledger_data.detail_text(snap)
    for needle in ("DeepSeek 用量", "逐轮估算", "今日按模型", "deepseek-v4-pro", "最近 12 轮"):
        assert_true(needle in text, f"明细里缺少「{needle}」")
    assert_true("两个口径不要相加" in text, "明细里应保留口径提醒")

    lines = ledger_data.bubble_text(snap)
    assert_true(any("50.00" in line for line in lines), f"泡泡里没有余额：{lines}")
    assert_true(any("2.0112" in line for line in lines), f"泡泡里没有今日用量：{lines}")
    assert_true(any("价" in line for line in lines), f"泡泡里没有峰谷：{lines}")

    # bubble_show_peak=False 时不该出现峰谷行
    slim = ledger_data.bubble_text(snap, show_peak=False)
    assert_true(not any("价 ·" in line or "后转" in line for line in slim),
                f"关掉峰谷后仍在显示峰谷行：{slim}")
    return f"{len(lines)} 行泡泡 / 明细 {len(text.splitlines())} 行"

check("明细文本与泡泡内容", case_detail_text)


print(f"\n通过 {PASSED} 项，失败 {len(FAILURES)} 项")
if FAILURES:
    print("\n失败明细：")
    for item in FAILURES:
        print(f"  - {item}")
    sys.exit(1)
print("全部通过。")
sys.exit(0)
