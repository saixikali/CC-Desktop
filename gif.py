"""
纯 Python GIF 解码器 —— 不依赖 Pillow。

需要它的原因：桌宠素材是动图（GIF89a、8 帧、带透明色），而 tkinter 的 PhotoImage
只能读 PNG/GIF 的一个子集，且给不了"逐帧 + 每帧延时 + 透明索引"这些信息。

支持：GIF87a / GIF89a、全局与局部色表、透明索引、交错、NETSCAPE 循环扩展、
四种处置方式（未指定/保留/清背景/恢复前一帧）。

输出每帧都是 **画布尺寸** 的 RGBA8888（已按处置规则合成好），
并附带该帧的显示时长（毫秒）。这样调用方不需要理解 GIF 的合成规则。
"""

import struct

MAX_CODES = 4096


class GifError(Exception):
    """解码失败。带明确原因，不静默出错图。"""


def _read_subblocks(data, pos):
    """读一串子块，拼成一个 bytes。返回 (数据, 新位置)。"""
    out = bytearray()
    while pos < len(data):
        size = data[pos]
        pos += 1
        if size == 0:
            break
        out.extend(data[pos:pos + size])
        pos += size
    return bytes(out), pos


def _lzw_decode(min_code_size, data, expected):
    """
    GIF 的 LZW 解压。

    几个容易写错的地方（都踩过）：
      - 码字是**小端位序**（低位先出），不是 MSB-first；
      - 字典从 2^min_code_size + 2 开始（+1 是 clear code，+2 是 EOI）；
      - 码长在"字典即将溢出"时增长，且增长的判定点是 next_code == (1 << code_size)；
      - 收到 KwKwK 情形（code == next_code）要取 prev + prev[0]。
    """
    clear = 1 << min_code_size
    eoi = clear + 1
    code_size = min_code_size + 1
    next_code = eoi + 1

    table = [bytes([i]) for i in range(clear)] + [b"", b""]
    prev = None
    out = bytearray()

    bit_pos = 0
    total_bits = len(data) * 8

    while bit_pos + code_size <= total_bits:
        byte_index = bit_pos >> 3
        chunk = data[byte_index:byte_index + 3]
        if len(chunk) < 2:
            break
        window = chunk[0] | (chunk[1] << 8) | ((chunk[2] if len(chunk) > 2 else 0) << 16)
        code = (window >> (bit_pos & 7)) & ((1 << code_size) - 1)
        bit_pos += code_size

        if code == clear:
            table = [bytes([i]) for i in range(clear)] + [b"", b""]
            code_size = min_code_size + 1
            next_code = eoi + 1
            prev = None
            continue

        if code == eoi:
            break

        if prev is None:
            if code >= len(table):
                raise GifError(f"首个码字 {code} 越界")
            entry = table[code]
        elif code < len(table):
            entry = table[code]
            # 每读一个码就新增一条 —— 这**不是可选的**：
            # 编码端每产出一个码也恰好新增一条，两边必须同步，
            # 否则 next_code 会慢一步、码长增长的时机随之错开，后面全部解错。
            # （本插件踩过：只在"码已在表里"时才加条目，导致第 8 个码起就歪。）
            if next_code < MAX_CODES:
                table.append(prev + entry[:1])
                next_code += 1
                # 增长判据是标准约定：新增条目后若 next_code == (1<<code_size)，
                # 先增码长再读下一个码。
                #
                # 这里有个反直觉的坑（本插件踩了整整一轮）：解码端的 next_code 天然
                # 比编码端**滞后一个条目**，看起来"应该"用 next_code+1 判据才对齐。
                # 但真实 GIF 用的是标准判据 —— 我用本文件里那个自写编码器先得出
                # "要 +1"的结论，结果真文件反而解不了了。教训是：
                # 合成往返只能证明两边自洽，**真文件才是权威判据**。
                if next_code == (1 << code_size) and code_size < 12:
                    code_size += 1
        elif code == next_code:
            # KwKwK：编码端刚新增、还没来得及输出的那一条
            entry = prev + prev[:1]
            if next_code < MAX_CODES:
                table.append(entry)
                next_code += 1
                if next_code == (1 << code_size) and code_size < 12:
                    code_size += 1
        else:
            raise GifError(f"码字 {code} 既不在字典里也不是 next_code({next_code})")

        out.extend(entry)
        prev = entry

    # 不在这里按 expected 提前 break：那会跳过 EOI，并在 expected 偏大时
    # 把"数据不足"误判成"解够了"。正确性判据只有最后那一次长度检查。

    if len(out) < expected:
        raise GifError(f"解出的像素数不足：期望 {expected}，实际 {len(out)}")
    return bytes(out[:expected])


def _deinterlace(indices, width, height):
    """GIF 交错是按 8 行一组分四趟存的，要重排回顺序行。"""
    out = bytearray(len(indices))
    # 四趟各自的行号序列
    rows = []
    for start, step in ((0, 8), (4, 8), (2, 4), (1, 2)):
        rows.extend(range(start, height, step))
    pos = 0
    for y in rows:
        out[y * width:(y + 1) * width] = indices[pos:pos + width]
        pos += width
    return out


def decode(path, max_frames=120):
    """
    解码 GIF。

    返回 (宽, 高, [ {rgba: bytearray, delay_ms: int}, ... ])。
    每帧 rgab 都是整张画布大小、已合成完毕的 RGBA8888。
    """
    with open(path, "rb") as handle:
        data = handle.read()

    if data[:6] not in (b"GIF87a", b"GIF89a"):
        raise GifError("不是 GIF 文件（签名不匹配）")

    width, height = struct.unpack("<HH", data[6:10])
    packed = data[10]
    background_index = data[11]
    global_table = None
    pos = 13
    if packed & 0x80:
        count = 2 ** ((packed & 7) + 1)
        global_table = data[pos:pos + count * 3]
        pos += count * 3

    if width == 0 or height == 0:
        raise GifError(f"画布尺寸异常：{width}x{height}")

    frames = []
    canvas = bytearray(width * height * 4)          # 当前合成结果
    # 透明背景的关键：GIF 的"清背景"在浏览器里是**变透明**，不是填背景色。
    # 桌宠要的就是透明，所以画布初值全 0（全透明）。

    pending = {"delay": None, "transparent_index": None, "disposal": 0}

    while pos < len(data):
        marker = data[pos]

        if marker == 0x3B:                          # 文件结束
            break

        if marker == 0x21:                          # 扩展块
            label = data[pos + 1]
            pos += 2
            if label == 0xF9:                       # 图形控制扩展
                block_size = data[pos]
                if block_size < 4:
                    raise GifError("图形控制扩展长度异常")
                flags = data[pos + 1]
                delay = struct.unpack("<H", data[pos + 2:pos + 4])[0]
                pending = {
                    "delay": delay * 10,            # 单位 1/100 秒 → 毫秒
                    "disposal": (flags >> 2) & 7,
                    "transparent_index": data[pos + 4] if flags & 1 else None,
                }
                pos += block_size + 1
                _, pos = _read_subblocks(data, pos)
            else:
                _, pos = _read_subblocks(data, pos)
            continue

        if marker == 0x2C:                          # 图像描述符
            left, top, frame_w, frame_h = struct.unpack("<HHHH", data[pos + 1:pos + 9])
            frame_packed = data[pos + 9]
            pos += 10

            local_table = None
            if frame_packed & 0x80:
                count = 2 ** ((frame_packed & 7) + 1)
                local_table = data[pos:pos + count * 3]
                pos += count * 3

            table = local_table if local_table is not None else global_table
            if table is None:
                raise GifError("既没有全局色表也没有局部色表")

            min_code_size = data[pos]
            pos += 1
            compressed, pos = _read_subblocks(data, pos)

            if frame_w == 0 or frame_h == 0:
                continue

            indices = _lzw_decode(min_code_size, compressed, frame_w * frame_h)
            if frame_packed & 0x40:
                indices = _deinterlace(indices, frame_w, frame_h)

            # ---- 先记住"处置前"的画布，供 disposal=3（恢复前一帧）用
            previous = bytes(canvas)

            transparent_index = pending["transparent_index"]
            for y in range(frame_h):
                canvas_y = top + y
                if canvas_y >= height:
                    break
                src_row = y * frame_w
                dst_row = canvas_y * width * 4
                for x in range(frame_w):
                    canvas_x = left + x
                    if canvas_x >= width:
                        break
                    index = indices[src_row + x]
                    if transparent_index is not None and index == transparent_index:
                        continue                    # 透明像素：保留画布原值
                    di = dst_row + canvas_x * 4
                    canvas[di] = table[index * 3]
                    canvas[di + 1] = table[index * 3 + 1]
                    canvas[di + 2] = table[index * 3 + 2]
                    canvas[di + 3] = 255

            frames.append({
                "rgba": bytearray(canvas),
                "delay_ms": pending["delay"] if pending["delay"] else 100,
                "interlaced": bool(frame_packed & 0x40),
            })
            if len(frames) >= max_frames:
                # 超上限就停在这儿：桌宠不需要几百帧，内存和启动时间都受不了
                break

            # ---- 按处置方式准备下一帧的画布
            disposal = pending["disposal"]
            if disposal == 2:                       # 清背景 → 该区域变透明
                for y in range(frame_h):
                    canvas_y = top + y
                    if canvas_y >= height:
                        break
                    row = canvas_y * width * 4
                    for x in range(frame_w):
                        canvas_x = left + x
                        if canvas_x >= width:
                            break
                        di = row + canvas_x * 4
                        canvas[di:di + 4] = b"\x00\x00\x00\x00"
            elif disposal == 3:                     # 恢复前一帧
                canvas = bytearray(previous)
            # disposal 0/1：保留当前画布，什么都不做

            pending = {"delay": None, "transparent_index": None, "disposal": 0}
            continue

        raise GifError(f"遇到未知块标记 0x{marker:02X}（位置 {pos}）")

    if not frames:
        raise GifError("没有解出任何帧")

    return width, height, frames
