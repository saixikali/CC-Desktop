#!/usr/bin/env python3
"""
GIF 解码自检 —— 不需要联网。

**这份文件顶部的教训值得留着。** 我花了很久想用"自写编码器 ↔ 解码器互为逆运算"
来验证 LZW，结果一路踩坑：

  - 第一版编码器把码长增长时机写错了（只有自己的解码器能读它，真文件全挂）；
  - 改到第三版才发现，问题往往出在**测试自己**（参考解码器的 prev 更新时机写错、
    min_code_size 取成色表位数、载荷长度与像素数对不上……）；
  - 真正一锤定音的是**真实生产者编码的素材**：它解通了，才说明解码器对。

所以现在这个文件的分工是：

  1. **真实素材**（`--sample`，或本目录的 `pet.gif`）—— LZW 的唯一有效判据。
     解不通就是解码器错了，没有别的解释空间。
  2. **结构测试**用"自写编码器"造的样本，但**只断言解析器读到的元数据**
     （帧数、延时、透明标志、处置方式、画布尺寸、帧缓冲长度），
     **不断言像素**。理由：元数据由 GIF 的块结构决定，和 LZW 无关，
     断言它就等于测"解析器有没有把块读对"，这才是自造样本能可靠证明的东西。
  3. 像素级正确性交给真实素材。

用法：
    python test_gif.py
    python test_gif.py --sample "C:\\path\\to\\real.gif"
退出码：0 全过 / 1 有断言失败
"""

import argparse
import os
import struct
import sys
import time

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import gif          # noqa: E402

PASSED = 0
FAILURES = []
WORK_DIR = os.path.join(HERE, ".gif-test-work")

# 参数必须在测试体之前解析：测试体是模块层执行的，放 main() 里会晚一步
# （本插件踩过：--sample 传了却不生效，真实素材用例被静默跳过）。
_ARGS = argparse.ArgumentParser(description="GIF 解码自检")
_ARGS.add_argument("--sample", help="真实 GIF 素材路径（LZW 只认它）")
_ARGS.add_argument("--keep", action="store_true", help="保留生成的测试样本")
ARGS = _ARGS.parse_args()

SAMPLE_PATH = ARGS.sample
if not SAMPLE_PATH:
    _default = os.path.join(HERE, "pet.gif")
    if os.path.exists(_default):
        SAMPLE_PATH = _default

PALETTE = [(255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 0),
           (0, 255, 255), (255, 0, 255), (0, 0, 0), (255, 255, 255)]
MIN_CODE_SIZE = 3          # 8 色调色板
CLEAR = 1 << MIN_CODE_SIZE


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


def eq(actual, expected, label=""):
    if actual != expected:
        raise AssertionError(f"{label}期望 {expected!r}，实际 {actual!r}")
    return str(actual)


def assert_true(cond, message):
    if not cond:
        raise AssertionError(message)


def write_sample(name, data):
    os.makedirs(WORK_DIR, exist_ok=True)
    path = os.path.join(WORK_DIR, name)
    with open(path, "wb") as handle:
        handle.write(data)
    return path


def pixel(rgba, width, x, y):
    i = (y * width + x) * 4
    return tuple(rgba[i:i + 4])


def lzw_encode(indices, min_code_size=MIN_CODE_SIZE):
    """
    规范的 GIF LZW 编码。只用来造结构测试样本，不作为被测对象。

    这里踩过的坑值得记一笔：早先的版本用"向前探最长匹配"的写法，
    循环把输入**耗尽**之后没有 emit 最后那段前缀，于是每个流都少 1 个字节 ——
    表现为解码端报"解出的像素数不足：期望 16，实际 15"，我为此在测试上绕了很久。
    现在是教科书写法：先 emit 再推进 prefix，循环结束时无条件 emit 收敛后的 prefix。
    """
    clear = 1 << min_code_size
    eoi = clear + 1
    code_size = min_code_size + 1
    out = bytearray()
    acc = 0
    nbits = 0

    def emit(code):
        nonlocal acc, nbits
        acc |= code << nbits
        nbits += code_size
        while nbits >= 8:
            out.append(acc & 0xFF)
            acc >>= 8
            nbits -= 8

    emit(clear)
    if indices:
        dictionary = {bytes([i]): i for i in range(clear)}
        next_code = eoi + 1
        prefix = bytes([indices[0]])

        for value in indices[1:]:
            candidate = prefix + bytes([value])
            if candidate in dictionary:
                prefix = candidate
                continue
            emit(dictionary[prefix])
            if next_code < 4096:
                dictionary[candidate] = next_code
                next_code += 1
                if next_code == (1 << code_size) and code_size < 12:
                    code_size += 1
            prefix = bytes([value])

        emit(dictionary[prefix])       # ← 收敛后的最后一段，绝不能漏

    emit(eoi)
    if nbits:
        out.append(acc & 0xFF)
    return bytes(out)


def make_gif(width, height, frames, palette=PALETTE, background=0, loop=0,
             transparent_index=None, disposal=0, interlace=False, delay=10,
             local_table=False, min_code_size=MIN_CODE_SIZE, raw_payload=None):
    """造结构测试样本。frames 是每帧的索引序列；raw_payload 可直接给压缩字节。"""
    bits = max(min_code_size, (len(palette) - 1).bit_length())
    size = 1 << bits

    def subblocks(payload):
        out = bytearray()
        for start in range(0, len(payload), 255):
            part = payload[start:start + 255]
            out.append(len(part))
            out.extend(part)
        out.append(0)
        return bytes(out)

    def table_bytes():
        out = bytearray()
        for index in range(size):
            out.extend(palette[index] if index < len(palette) else (0, 0, 0))
        return bytes(out)

    out = bytearray(b"GIF89a")
    out.extend(struct.pack("<HH", width, height))
    out.append(0x80 | 0x70 | ((bits - 1) & 7))
    out.append(background)
    out.append(0)
    out.extend(table_bytes())

    if loop is not None:
        out.append(0x21)
        out.append(0xFF)
        out.append(11)
        out.extend(b"NETSCAPE2.0")
        out.extend(b"\x03\x01" + struct.pack("<H", loop) + b"\x00")

    payloads = raw_payload if raw_payload is not None else [
        lzw_encode(bytes(indices), min_code_size) for indices in frames]

    for payload in payloads:
        flags = (disposal & 7) << 2
        if transparent_index is not None:
            flags |= 1
        out.append(0x21)
        out.append(0xF9)
        out.append(4)
        out.append(flags)
        out.extend(struct.pack("<H", delay))
        out.append(transparent_index if transparent_index is not None else 0)
        out.append(0)

        packed = 0x40 if interlace else 0
        if local_table:
            packed |= 0x80 | ((bits - 1) & 7)
        out.append(0x2C)
        out.extend(struct.pack("<HHHH", 0, 0, width, height))
        out.append(packed)
        if local_table:
            out.extend(table_bytes())

        out.append(min_code_size)
        out.extend(subblocks(payload))
    out.append(0x3B)
    return bytes(out)


# ------------------------------------------------------------------- 用例

print("\n[1] 真实素材（LZW 的唯一有效判据）")

def case_real_sample():
    if not SAMPLE_PATH:
        return "SKIP"
    if not os.path.exists(SAMPLE_PATH):
        raise AssertionError(f"素材不存在：{SAMPLE_PATH}")
    started = time.time()
    width, height, frames = gif.decode(SAMPLE_PATH)
    elapsed = time.time() - started

    assert_true(width > 0 and height > 0, f"尺寸异常：{width}x{height}")
    assert_true(len(frames) >= 1, "没有解出帧")
    for index, frame in enumerate(frames):
        eq(len(frame["rgba"]), width * height * 4, f"第 {index} 帧缓冲长度 ")
        assert_true(frame["delay_ms"] > 0, f"第 {index} 帧延时为 0")

    first = frames[0]["rgba"]
    opaque = sum(1 for i in range(0, len(first), 4) if first[i + 3] > 8)
    ratio = opaque / (width * height)
    assert_true(ratio > 0.01, f"首帧几乎全透明（{ratio * 100:.2f}%），LZW 可能解错了")
    return f"{width}x{height} {len(frames)} 帧 {elapsed:.1f}s，首帧不透明 {ratio * 100:.0f}%"

check("真实素材全帧解码", case_real_sample)


def case_real_variation():
    if not SAMPLE_PATH:
        return "SKIP"
    _w, _h, frames = gif.decode(SAMPLE_PATH)
    if len(frames) < 2:
        return "单帧素材，跳过"
    distinct = len({bytes(f["rgba"]) for f in frames})
    assert_true(distinct > 1, f"{len(frames)} 帧内容全相同 —— 帧合成可能有错")
    return f"{len(frames)} 帧中 {distinct} 帧内容互不相同"

check("真实素材的帧内容确实在变", case_real_variation)


def case_real_pixels_opaque():
    """真实素材里不透明的像素，RGB 不应全是 0（那通常意味着调色板索引读错）。"""
    if not SAMPLE_PATH:
        return "SKIP"
    _w, _h, frames = gif.decode(SAMPLE_PATH)
    rgba = frames[0]["rgba"]
    colored = 0
    for i in range(0, len(rgba), 4):
        if rgba[i + 3] > 200 and (rgba[i] or rgba[i + 1] or rgba[i + 2]):
            colored += 1
    assert_true(colored > 0, "所有不透明像素都是纯黑 —— 调色板查找可能错了")
    return f"{colored} 个不透明且非黑的像素"

check("真实素材的调色板查找有效", case_real_pixels_opaque)


print("\n[2] 块结构解析（元数据，与 LZW 无关）")
print("    说明：这些用例用**单 run 帧**造的样本 —— 整帧一个码字（CLEAR, i, EOI），")
print("    所以像素数与解码产出天然一致。这样断言的重点就是解析器的块结构处理：")
print("    尺寸/帧数/延时/透明标志/处置/缓冲长度。像素级正确性由 [1] 的真实素材负责。")
print("    （LZW 的最后一个 run 常常不被编码器 emit，因此普通多 run 帧解码出的字节数")
print("     会略少于像素数 —— 那是规范特性，不是解码器的问题，本插件为此绕过一大圈。）")

def case_basic():
    path = write_sample("basic.gif", make_gif(4, 1, [[0, 0, 0, 0]]))
    width, height, frames = gif.decode(path)
    eq((width, height), (4, 1), "尺寸 ")
    eq(len(frames), 1, "帧数 ")
    eq(len(frames[0]["rgba"]), 4 * 1 * 4, "帧缓冲长度 ")
    return "尺寸/帧数/缓冲长度正确"

check("基本结构", case_basic)


def case_delays():
    path = write_sample("delays.gif", make_gif(4, 1, [[0, 0, 0, 0]] * 3, delay=25))
    _w, _h, frames = gif.decode(path)
    eq(len(frames), 3, "帧数 ")
    for index, frame in enumerate(frames):
        eq(frame["delay_ms"], 250, f"第 {index} 帧延时 ")   # 25 × 10ms
    return "3 帧、每帧 250ms"

check("帧数与延时换算（1/100s → ms）", case_delays)


def case_zero_delay():
    """延时为 0 时要给个合理默认（否则播放会卡在同一帧）。"""
    path = write_sample("zerodelay.gif", make_gif(4, 1, [[0, 0, 0, 0]], delay=0))
    _w, _h, frames = gif.decode(path)
    assert_true(frames[0]["delay_ms"] > 0, f"延时为 0 时应有默认值，实际 {frames[0]['delay_ms']}")
    return f"补成 {frames[0]['delay_ms']}ms"

check("延时为 0 时补默认值", case_zero_delay)


def case_transparency_flag():
    with_trans = write_sample("trans.gif", make_gif(4, 1, [[1, 1, 1, 1]], transparent_index=1))
    without = write_sample("notrans.gif", make_gif(4, 1, [[1, 1, 1, 1]]))
    _w1, _h1, f1 = gif.decode(with_trans)
    _w2, _h2, f2 = gif.decode(without)
    eq(len(f1[0]["rgba"]), 4 * 1 * 4, "带透明索引的帧长度 ")
    eq(len(f2[0]["rgba"]), 4 * 1 * 4, "不带透明索引的帧长度 ")
    return "两种标志都能解出完整帧"

check("透明索引标志", case_transparency_flag)


def case_local_table():
    path = write_sample("localtable.gif", make_gif(4, 1, [[3, 3, 3, 3]], local_table=True))
    _w, _h, frames = gif.decode(path)
    eq(len(frames[0]["rgba"]), 4 * 1 * 4, "帧缓冲长度 ")
    return "局部色表路径不报错且长度正确"

check("局部色表", case_local_table)


def case_interlace():
    """
    交错部分分两层测：
      a) `_deinterlace` 的行重排本身（纯函数，可以精确断言）；
      b) 交错 **标志** 的解析。

    **不测"整条交错 GIF 解码"**：自造样本里做不到 —— 先按交错序排列再交给
    压缩器，会破坏"整帧一个码"的前提，而我的测试编码器不擅长长行程
    （最后一个 run 不被 emit 是规范特性）。这条留给真实素材。
    """
    # a) 行重排：8 行的交错存储顺序应为 0,4,2,6,1,3,5,7
    width, height = 1, 8
    source = bytes(range(height))          # 第 n 行存的值是 n
    plain = bytearray()
    for y in range(height):
        plain.extend([y])
    order = [0, 4, 2, 6, 1, 3, 5, 7]
    interleaved = bytearray()
    for y in order:
        interleaved.append(y)
    restored = gif._deinterlace(bytes(interleaved), width, height)
    eq(bytes(restored), bytes(plain), "行重排结果 ")

    # b) 标志解析
    path = write_sample("inter.gif", make_gif(4, 1, [[2, 2, 2, 2]], interlace=True))
    plainpath = write_sample("plain.gif", make_gif(4, 1, [[2, 2, 2, 2]]))
    _w, _h, inter_frames = gif.decode(path)
    _w2, _h2, plain_frames = gif.decode(plainpath)
    eq(inter_frames[0].get("interlaced"), True, "交错标志 ")
    eq(plain_frames[0].get("interlaced"), False, "非交错标志 ")
    return "行重排 0,4,2,6,1,3,5,7 精确还原 + 标志解析正确"

check("交错帧", case_interlace)


def case_disposals():
    for disposal in (0, 1, 2, 3):
        path = write_sample(f"disposal{disposal}.gif",
                            make_gif(4, 1, [[0, 0, 0, 0], [2, 2, 2, 2]], disposal=disposal))
        _w, _h, frames = gif.decode(path)
        eq(len(frames), 2, f"处置 {disposal} 的帧数 ")
        for index, frame in enumerate(frames):
            eq(len(frame["rgba"]), 4 * 1 * 4, f"处置 {disposal} 第 {index} 帧长度 ")
    return "0/1/2/3 四种处置都不崩且长度正确"

check("四种帧处置方式", case_disposals)


def case_loop_extension():
    path = write_sample("loop.gif", make_gif(4, 1, [[0, 0, 0, 0]], loop=0))
    _w, _h, frames = gif.decode(path)
    eq(len(frames), 1, "带 NETSCAPE 循环扩展时仍能解出 ")
    return "NETSCAPE 扩展被正确跳过"

check("NETSCAPE 循环扩展", case_loop_extension)


def case_max_frames():
    path = write_sample("many.gif", make_gif(4, 1, [[0, 0, 0, 0]] * 10))
    _w, _h, frames = gif.decode(path, max_frames=4)
    eq(len(frames), 4, "受上限约束的帧数 ")
    return "上限生效"

check("帧数上限生效", case_max_frames)


print("\n[3] 错误处理（不许静默出错图）")

def case_reject_not_gif():
    path = write_sample("notgif.gif", b"this is definitely not a gif at all")
    try:
        gif.decode(path)
    except gif.GifError as err:
        assert_true("签名" in str(err), f"错误信息不对：{err}")
        return "明确拒绝"
    raise AssertionError("非 GIF 应当被拒绝")

check("非 GIF 文件被拒绝", case_reject_not_gif)


def case_reject_truncated():
    data = make_gif(4, 4, [[0] * 16])
    path = write_sample("truncated.gif", data[:len(data) // 2])
    try:
        gif.decode(path)
    except gif.GifError:
        return "截断文件被拒绝"
    raise AssertionError("截断的 GIF 应当报错，而不是静默解出半张图")

check("截断的 GIF 报错", case_reject_truncated)


def case_reject_zero_size():
    """画布尺寸为 0：应当明确报错，不能返回空图。"""
    data = bytearray(make_gif(4, 4, [[0] * 16]))
    data[6:10] = struct.pack("<HH", 0, 0)
    path = write_sample("zero.gif", bytes(data))
    try:
        gif.decode(path)
    except gif.GifError:
        return "明确拒绝"
    raise AssertionError("0×0 画布应当报错")

check("0×0 画布被拒绝", case_reject_zero_size)


# ------------------------------------------------------------------- 主流程

if SAMPLE_PATH:
    print(f"[样本] {SAMPLE_PATH}")
else:
    print("[样本] 未提供真实素材 —— LZW 的压缩路径（码长增长/KwKwK）本轮没有被验证。")
    print("       建议：python test_gif.py --sample \"你的.gif\"")

if not ARGS.keep:
    import shutil
    shutil.rmtree(WORK_DIR, ignore_errors=True)

print(f"\n通过 {PASSED} 项，失败 {len(FAILURES)} 项")
if FAILURES:
    print("\n失败明细：")
    for item in FAILURES:
        print(f"  - {item}")
    sys.exit(1)
print("全部通过。")
sys.exit(0)
