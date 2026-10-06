"""
纯 Python PNG 解码器 —— 不依赖 Pillow。

为什么需要：目标机器上 Python 3.14 自带 tkinter，但**没有 PIL**。而 tkinter 的
PhotoImage 只支持 PNG 的一个子集（实测读不了带预乘/交错/16 位深的 PNG），
所以桌宠的素材得自己解。

支持：位深 8 / 色彩类型 0(灰度)、2(RGB)、3(调色板)、4(灰度+Alpha)、6(RGBA)，
全部 5 种行过滤器，非交错。不支持 16 位深与 Adam7 交错（遇到会明确报错，不静默出错图）。

输出统一为 (width, height, bytearray) 的 RGBA8888 缓冲。
"""

import struct
import zlib

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


class PngError(Exception):
    """解码失败。带明确原因，避免"看起来解码成功但图是错的"。"""


def _paeth(a, b, c):
    p = a + b - c
    pa = p - a if p >= a else a - p
    pb = p - b if p >= b else b - p
    pc = p - c if p >= c else c - p
    if pa <= pb and pa <= pc:
        return a
    if pb <= pc:
        return b
    return c


def _unfilter(raw, width, height, channels, bytes_per_sample):
    """把扫线还原成连续像素。返回 bytearray，长度 = height * stride。"""
    stride = width * channels * bytes_per_sample
    out = bytearray(stride * height)
    pos = 0
    prev = bytearray(stride)

    for y in range(height):
        if pos >= len(raw):
            raise PngError(f"图像数据在扫线 {y}/{height} 处提前结束")
        filter_type = raw[pos]
        pos += 1
        line = bytearray(raw[pos:pos + stride])
        if len(line) != stride:
            raise PngError(f"扫线 {y} 数据不足：期望 {stride} 字节，实际 {len(line)}")
        pos += stride

        if filter_type == 0:
            pass
        elif filter_type == 1:  # Sub
            step = channels * bytes_per_sample
            for i in range(step, stride):
                line[i] = (line[i] + line[i - step]) & 0xFF
        elif filter_type == 2:  # Up
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif filter_type == 3:  # Average
            step = channels * bytes_per_sample
            for i in range(stride):
                left = line[i - step] if i >= step else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xFF
        elif filter_type == 4:  # Paeth
            step = channels * bytes_per_sample
            for i in range(stride):
                left = line[i - step] if i >= step else 0
                upleft = prev[i - step] if i >= step else 0
                line[i] = (line[i] + _paeth(left, prev[i], upleft)) & 0xFF
        else:
            raise PngError(f"扫线 {y} 用了未知过滤器类型 {filter_type}")

        out[y * stride:(y + 1) * stride] = line
        prev = line

    return out


def decode(path):
    """解码 PNG → (width, height, bytearray RGBA)。"""
    with open(path, "rb") as handle:
        data = handle.read()

    if data[:8] != PNG_SIGNATURE:
        raise PngError("不是 PNG 文件（签名不匹配）")

    pos = 8
    width = height = None
    bit_depth = color_type = interlace = None
    palette = None
    transparency = None
    idat_parts = []

    while pos + 8 <= len(data):
        (length,) = struct.unpack(">I", data[pos:pos + 4])
        chunk_type = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + length]
        pos += 12 + length  # 4 长度 + 4 类型 + 数据 + 4 CRC

        if chunk_type == b"IHDR":
            width, height, bit_depth, color_type, _comp, _filt, interlace = struct.unpack(">IIBBBBB", chunk)
        elif chunk_type == b"PLTE":
            palette = chunk
        elif chunk_type == b"tRNS":
            transparency = chunk
        elif chunk_type == b"IDAT":
            idat_parts.append(chunk)
        elif chunk_type == b"IEND":
            break

    if width is None:
        raise PngError("缺少 IHDR")
    if interlace != 0:
        raise PngError("不支持 Adam7 交错 PNG（请另存为非交错）")
    if bit_depth != 8:
        raise PngError(f"不支持 {bit_depth} 位深（只支持 8 位）")

    channels_by_type = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}
    if color_type not in channels_by_type:
        raise PngError(f"不支持的色彩类型 {color_type}")
    channels = channels_by_type[color_type]

    raw = zlib.decompress(b"".join(idat_parts))
    pixels = _unfilter(raw, width, height, channels, 1)
    rgba = bytearray(width * height * 4)

    if color_type == 6:  # RGBA
        rgba[:] = pixels
    elif color_type == 2:  # RGB
        for i in range(width * height):
            rgba[i * 4:i * 4 + 3] = pixels[i * 3:i * 3 + 3]
            rgba[i * 4 + 3] = 255
    elif color_type == 4:  # 灰度 + Alpha
        for i in range(width * height):
            g = pixels[i * 2]
            rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = g
            rgba[i * 4 + 3] = pixels[i * 2 + 1]
    elif color_type == 0:  # 灰度
        for i in range(width * height):
            g = pixels[i]
            rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = g
            rgba[i * 4 + 3] = 255
    elif color_type == 3:  # 调色板
        if palette is None:
            raise PngError("调色板 PNG 缺少 PLTE")
        for i in range(width * height):
            index = pixels[i]
            rgba[i * 4] = palette[index * 3]
            rgba[i * 4 + 1] = palette[index * 3 + 1]
            rgba[i * 4 + 2] = palette[index * 3 + 2]
            if transparency is not None and index < len(transparency):
                rgba[i * 4 + 3] = transparency[index]
            else:
                rgba[i * 4 + 3] = 255

    return width, height, rgba


def resize_rgba(src, src_w, src_h, dst_w, dst_h):
    """
    面积平均缩放，且在**预乘 alpha** 空间里做加权。

    为什么必须在预乘空间：透明像素的 RGB 常常是无意义的黑（0,0,0），
    直接按 alpha 加权会把边缘拉黑（"黑边/白边"就是这么来的）。
    先把颜色乘上 alpha 再平均，最后除回去，边缘才干净。
    """
    if dst_w <= 0 or dst_h <= 0:
        raise PngError("目标尺寸必须是正数")

    out = bytearray(dst_w * dst_h * 4)
    x_ratio = src_w / dst_w
    y_ratio = src_h / dst_h

    for dy in range(dst_h):
        y0 = int(dy * y_ratio)
        y1 = max(y0 + 1, int((dy + 1) * y_ratio))
        y1 = min(y1, src_h)
        for dx in range(dst_w):
            x0 = int(dx * x_ratio)
            x1 = max(x0 + 1, int((dx + 1) * x_ratio))
            x1 = min(x1, src_w)

            acc_a = acc_r = acc_g = acc_b = 0
            count = 0
            for y in range(y0, y1):
                row = y * src_w * 4
                for x in range(x0, x1):
                    i = row + x * 4
                    a = src[i + 3]
                    acc_a += a
                    acc_r += src[i] * a
                    acc_g += src[i + 1] * a
                    acc_b += src[i + 2] * a
                    count += 1

            o = (dy * dst_w + dx) * 4
            if count == 0 or acc_a == 0:
                out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0
                continue
            out[o] = min(255, acc_r // acc_a)
            out[o + 1] = min(255, acc_g // acc_a)
            out[o + 2] = min(255, acc_b // acc_a)
            out[o + 3] = min(255, acc_a // count)

    return out


def cutout_background(rgba, width, height, tolerance=24):
    """
    从四条边泛洪填充，把与边缘颜色接近的**连通**区域变透明。

    为什么需要：很多"看着像立绘"的图其实是实心背景（本机那张 2560×1440 就是
    100% 不透明）。不抠的话，桌宠会变成贴在桌面上的一个实心矩形。

    用泛洪而不是"全局按颜色删"：后者会把角色内部同色的部分也打洞。
    只删与边缘连通的那一片，内部同色区域能保住。

    返回 (新缓冲, 被变透明的像素数)。
    """
    if tolerance < 0:
        tolerance = 0
    total = width * height
    visited = bytearray(total)
    stack = []

    # 以四边像素作为种子
    for x in range(width):
        stack.append(x)
        stack.append((height - 1) * width + x)
    for y in range(height):
        stack.append(y * width)
        stack.append(y * width + width - 1)

    # 以左上角像素作为背景参考色（常见的纯色背景都在角落）
    base = (rgba[0], rgba[1], rgba[2])

    removed = 0
    while stack:
        index = stack.pop()
        if index < 0 or index >= total or visited[index]:
            continue
        visited[index] = 1
        i = index * 4

        # 已经透明的像素：不改它，但邻居要照常展开 ——
        # 否则"透明像素隔开的背景"会断成两片，抠不干净。
        if rgba[i + 3] != 0:
            dr = abs(rgba[i] - base[0])
            dg = abs(rgba[i + 1] - base[1])
            db = abs(rgba[i + 2] - base[2])
            if dr > tolerance or dg > tolerance or db > tolerance:
                continue
            rgba[i + 3] = 0
            removed += 1

        x = index % width
        y = index // width
        if x > 0:
            stack.append(index - 1)
        if x < width - 1:
            stack.append(index + 1)
        if y > 0:
            stack.append(index - width)
        if y < height - 1:
            stack.append(index + width)

    return rgba, removed


def crop(rgba, width, height, box):
    """按 (min_x, min_y, max_x, max_y) 裁出一块（坐标为闭区间）。"""
    min_x, min_y, max_x, max_y = box
    new_w = max_x - min_x + 1
    new_h = max_y - min_y + 1
    out = bytearray(new_w * new_h * 4)
    for y in range(new_h):
        src = ((min_y + y) * width + min_x) * 4
        dst = y * new_w * 4
        out[dst:dst + new_w * 4] = rgba[src:src + new_w * 4]
    return out, new_w, new_h


def union_alpha_box(frames, widths, heights, threshold=8):
    """
    求多帧不透明区域的**并集**包围盒。

    为什么不能逐帧各裁各的：动图每帧轮廓不同，各自裁边会得到不同的宽高比，
    缩放后帧与帧之间会跳动 —— 素材本身没抖，是我们的处理让它抖了。
    统一用一个裁剪框，所有帧尺寸就一致。
    """
    min_x, min_y, max_x, max_y = None, None, None, None
    for rgba, width, height in zip(frames, widths, heights):
        for y in range(height):
            row = y * width * 4
            for x in range(width):
                if rgba[row + x * 4 + 3] > threshold:
                    if min_x is None or x < min_x:
                        min_x = x
                    if max_x is None or x > max_x:
                        max_x = x
                    if min_y is None or y < min_y:
                        min_y = y
                    if max_y is None or y > max_y:
                        max_y = y
    if min_x is None:
        return None
    return (min_x, min_y, max_x, max_y)


def trim_transparent(rgba, width, height, threshold=8):
    """裁掉四周全透明的边，让桌宠的"脚"贴住窗口底边。"""
    min_x, min_y, max_x, max_y = width, height, -1, -1
    for y in range(height):
        row = y * width * 4
        for x in range(width):
            if rgba[row + x * 4 + 3] > threshold:
                if x < min_x:
                    min_x = x
                if x > max_x:
                    max_x = x
                if y < min_y:
                    min_y = y
                if y > max_y:
                    max_y = y
    if max_x < 0:
        return rgba, width, height  # 整张全透明，原样返回

    new_w = max_x - min_x + 1
    new_h = max_y - min_y + 1
    out = bytearray(new_w * new_h * 4)
    for y in range(new_h):
        src_row = (min_y + y) * width * 4 + min_x * 4
        dst_row = y * new_w * 4
        out[dst_row:dst_row + new_w * 4] = rgba[src_row:src_row + new_w * 4]
    return out, new_w, new_h
