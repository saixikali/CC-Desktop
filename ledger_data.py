"""
读取 whale-balance 账本 + 峰谷计价，供桌宠显示。

账本是 CC Desktop 那边那个 MCP 插件写的
（D:\\CC Desktop\\plugins-state.whale-balance.json），结构：
  { balances: [...], turns: [...], daily: {...} }
金额是定点整数（1e-8）的十进制字符串。

价格表直接读插件目录里的 pricing.json —— **只有一份**，插件调价时桌宠自动跟上，
不在这里再抄一份（抄两份迟早会不一致）。

这里只读、不写：桌宠和插件互不干扰，插件没装也只是显示"暂无数据"。
"""

import json
import os
import time

HERE = os.path.dirname(os.path.abspath(__file__))
INSTALL_ROOT = os.path.dirname(HERE)

LEDGER_PATH = os.path.join(INSTALL_ROOT, "plugins-state.whale-balance.json")
PRICING_PATH = os.path.join(INSTALL_ROOT, "plugins", "whale-balance", "pricing.json")

FIXED_SCALE = 100000000  # 与插件 accounting.mjs 的定点一致

# 峰谷时段（北京时间）。取自官方定价页：周一至周五 09:00–12:00 与 14:00–18:00 为高峰，
# 其余（含周末）为谷价。注意官方还排除中国法定节假日，这里**没有**节假日表，
# 所以节假日期间会按工作日高峰算，略偏高 —— 与插件的 isPeak() 保持同一取舍。
PEAK_WINDOWS = ((9 * 60, 12 * 60), (14 * 60, 18 * 60))


def _to_float(fixed_str):
    """定点字符串 → float。只用于显示，精确运算归插件那边。"""
    try:
        return int(fixed_str) / FIXED_SCALE
    except (TypeError, ValueError):
        return None


def beijing_now(ts=None):
    """返回北京时间的 time.struct_time（用 gmtime 加 8 小时，不依赖系统时区）。"""
    ts = time.time() if ts is None else ts
    return time.gmtime(ts + 8 * 3600)


def beijing_day(ts=None):
    """账本按北京日切分，这里必须同口径，否则"今日"会错一天。"""
    return time.strftime("%Y-%m-%d", beijing_now(ts))


def peak_state(ts=None):
    """
    当前是否高峰，以及距离下一次切换还有多久。

    返回 {is_peak, label, next_change_seconds, next_label}
    """
    now = beijing_now(ts)
    weekday = now.tm_wday          # 0=周一 … 6=周日
    minutes = now.tm_hour * 60 + now.tm_min + now.tm_sec / 60

    if weekday >= 5:
        # 周末全天谷价：下一次状态变化是周一 09:00
        days_to_monday = 7 - weekday
        secs = (days_to_monday * 24 * 60 - minutes) * 60
        return {
            "is_peak": False, "label": "谷价（周末全天）",
            "next_change_seconds": int(secs), "next_label": "高峰",
        }

    for start, end in PEAK_WINDOWS:
        if start <= minutes < end:
            return {
                "is_peak": True, "label": "高峰",
                "next_change_seconds": int((end - minutes) * 60), "next_label": "谷价",
            }

    # 谷价：找下一个高峰起点（今天剩下的，或明天 09:00）
    for start, end in PEAK_WINDOWS:
        if minutes < start:
            return {
                "is_peak": False, "label": "谷价",
                "next_change_seconds": int((start - minutes) * 60), "next_label": "高峰",
            }
    tomorrow = (24 * 60 - minutes) + PEAK_WINDOWS[0][0]
    return {
        "is_peak": False, "label": "谷价",
        "next_change_seconds": int(tomorrow * 60), "next_label": "高峰",
    }


def format_seconds(seconds):
    """把秒数写成紧凑的倒计时，例如 1h23m / 45m / 2m10s。"""
    if seconds is None or seconds < 0:
        return "—"
    seconds = int(seconds)
    hours, rest = divmod(seconds, 3600)
    minutes, secs = divmod(rest, 60)
    if hours:
        return f"{hours}h{minutes:02d}m"
    if minutes:
        return f"{minutes}m{secs:02d}s"
    return f"{secs}s"


def load_pricing():
    """
    读插件那份价格表。返回 (配置字典, models)。读不到时返回 (None, {})，
    调用方应当降级显示而不是报错 —— 桌宠不该因为价格表缺失就起不来。
    """
    try:
        with open(PRICING_PATH, "r", encoding="utf-8-sig") as handle:
            data = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return None, {}
    if not isinstance(data, dict):
        return None, {}
    return data, data.get("models") or {}


def price_for(model, ts=None):
    """
    按模型 id 取当前生效单价（含峰谷折算）。找不到就返回 None。

    与插件 accounting.mjs 的匹配规则保持一致：精确 → 别名 → 前缀。
    """
    pricing, models = load_pricing()
    if not models:
        return None
    ratio = pricing.get("offPeakRatio", 0.5) if isinstance(pricing, dict) else 0.5

    spec = models.get(model)
    if spec is None:
        for key, value in models.items():
            aliases = value.get("aliases") or []
            if model in aliases or model.startswith(key):
                spec = value
                break
    if spec is None:
        return None

    state = peak_state(ts)
    factor = 1.0 if state["is_peak"] else float(spec.get("offPeakRatio", ratio))
    return {
        "model": model,
        "currency": spec.get("currency", "USD"),
        "cacheHit": round(spec.get("cacheHit", 0) * factor, 8),
        "cacheMiss": round(spec.get("cacheMiss", 0) * factor, 8),
        "output": round(spec.get("output", 0) * factor, 8),
        "is_peak": state["is_peak"],
    }


def read_snapshot(path=None):
    """
    返回一个 dict：
      ok              账本是否读到
      balance         最近一次观测到的余额（float 或 None）
      currency        币种
      balance_age     距上次观测的秒数（或 None）
      today_used      今日逐轮估算合计（float）
      today_turns     今日轮数
      today_observed  今日观测口径消费（float）
      balance_delta   最近一次观测相对上一次的变化（float 或 None）
      recent_turns    最近若干轮明细 [{ts, model, cost, peak, tokens}]
      by_model        今日按模型汇总 {model: cost}
      totals          {today, week, month, all} 逐轮估算合计
      note            异常说明（正常为 None）
    """
    path = path or LEDGER_PATH
    result = {
        "ok": False, "balance": None, "currency": None, "balance_age": None,
        "today_used": 0.0, "today_turns": 0, "today_observed": 0.0,
        "balance_delta": None, "recent_turns": [], "by_model": {},
        "totals": {"today": 0.0, "week": 0.0, "month": 0.0, "all": 0.0},
        "note": None,
    }

    if not os.path.exists(path):
        result["note"] = "账本还没生成（先在 CC Desktop 里问一次余额）"
        return result

    try:
        with open(path, "r", encoding="utf-8-sig") as handle:
            ledger = json.load(handle)
    except (OSError, json.JSONDecodeError) as err:
        result["note"] = f"账本读取失败：{err}"
        return result

    result["ok"] = True
    balances = ledger.get("balances") or []

    if balances:
        last = balances[-1]
        result["balance"] = _to_float(last.get("total"))
        result["currency"] = last.get("currency")
        ts = last.get("ts")
        if isinstance(ts, (int, float)):
            result["balance_age"] = max(0, int(time.time() - ts / 1000))
        delta = _to_float(last.get("delta"))
        kind = last.get("kind")
        if delta is not None and kind in ("spend", "topup"):
            result["balance_delta"] = delta

    today = beijing_day()
    day = (ledger.get("daily") or {}).get(today) or {}
    for key, field in (("today_used", "turnCost"), ("today_observed", "observedSpend")):
        value = _to_float(day.get(field))
        if value is not None:
            result[key] = value
    result["today_turns"] = int(day.get("turnCount") or 0)

    # ---- 逐轮明细与汇总
    turns = ledger.get("turns") or []
    week_from = time.strftime("%Y-%m-%d", time.gmtime(time.time() + 8 * 3600 - 6 * 86400))
    month_prefix = today[:7]
    totals = {"today": 0.0, "week": 0.0, "month": 0.0, "all": 0.0}
    by_model = {}

    for turn in turns:
        cost = _to_float(turn.get("cost")) or 0.0
        day_key = turn.get("day") or ""
        totals["all"] += cost
        if day_key == today:
            totals["today"] += cost
            model = turn.get("model") or "unknown"
            by_model[model] = by_model.get(model, 0.0) + cost
        if day_key >= week_from:
            totals["week"] += cost
        if day_key.startswith(month_prefix):
            totals["month"] += cost
    result["totals"] = totals
    result["by_model"] = by_model

    for turn in turns[-12:][::-1]:
        result["recent_turns"].append({
            "ts": turn.get("ts", 0),
            "model": turn.get("model") or "unknown",
            "cost": _to_float(turn.get("cost")) or 0.0,
            "peak": bool(turn.get("peak")),
            "source": turn.get("source") or "manual",
            "tokens": turn.get("tokens") or {},
        })

    return result


def format_money(value, digits=2):
    if value is None:
        return "—"
    return f"{value:,.{digits}f}"


def format_age(seconds):
    if seconds is None:
        return ""
    if seconds < 60:
        return "刚刚"
    if seconds < 3600:
        return f"{seconds // 60} 分钟前"
    if seconds < 86400:
        return f"{seconds // 3600} 小时前"
    return f"{seconds // 86400} 天前"


def bubble_text(snapshot, show_peak=True):
    """
    泡泡里的几行文本。结构对齐 DSH 挂件的默认泡泡：
    余额 / 今日已用 / 峰谷状态。
    """
    if not snapshot["ok"]:
        return [snapshot["note"] or "暂无数据"]

    lines = []
    currency = snapshot["currency"] or ""

    if snapshot["balance"] is not None:
        lines.append(f"余额 {format_money(snapshot['balance'])} {currency}".rstrip())
        tail = []
        age = format_age(snapshot["balance_age"])
        if age:
            tail.append(f"{age}观测")
        digits = snapshot["balance_delta"]
        if digits is not None:
            sign = "+" if digits > 0 else "−"
            tail.append(f"{sign}{format_money(abs(digits), 4)}")
        if tail:
            lines.append("（" + " · ".join(tail) + "）")
    else:
        lines.append("还没有余额记录")
        lines.append("（问一次「余额还有多少」）")

    if snapshot["today_turns"]:
        lines.append(f"今日 {format_money(snapshot['today_used'], 4)} · {snapshot['today_turns']} 轮")
    else:
        lines.append(f"今日 {format_money(snapshot['today_used'], 4)}")

    if show_peak:
        state = peak_state()
        lines.append(f"{state['label']} · {format_seconds(state['next_change_seconds'])}后转"
                     f"{state['next_label']}")

    return lines


def detail_text(snapshot):
    """菜单里"用量明细"窗口用的多行文本。"""
    if not snapshot["ok"]:
        return snapshot["note"] or "暂无数据"

    lines = ["=== DeepSeek 用量 ==="]
    currency = snapshot["currency"] or ""

    if snapshot["balance"] is not None:
        lines.append(f"余额        {format_money(snapshot['balance'])} {currency}")
        lines.append(f"上次观测    {format_age(snapshot['balance_age'])}")
    else:
        lines.append("余额        还没有观测记录")

    state = peak_state()
    lines.append(f"当前时段    {state['label']}（{format_seconds(state['next_change_seconds'])}"
                 f"后转{state['next_label']}）")

    totals = snapshot["totals"]
    lines.append("")
    lines.append("=== 逐轮估算（本机会话口径）===")
    lines.append(f"今日        {format_money(totals['today'], 4)}（{snapshot['today_turns']} 轮）")
    lines.append(f"近 7 天     {format_money(totals['week'], 4)}")
    lines.append(f"本月        {format_money(totals['month'], 4)}")
    lines.append(f"全部        {format_money(totals['all'], 4)}")
    lines.append(f"今日观测消费 {format_money(snapshot['today_observed'], 4)}（余额口径）")

    if snapshot["by_model"]:
        lines.append("")
        lines.append("=== 今日按模型 ===")
        for model, cost in sorted(snapshot["by_model"].items(), key=lambda kv: -kv[1]):
            share = cost / totals["today"] * 100 if totals["today"] else 0
            bar = "█" * max(1, int(share / 5)) if cost > 0 else ""
            lines.append(f"{model:<24} {format_money(cost, 4)}  {share:4.1f}% {bar}")

    if snapshot["recent_turns"]:
        lines.append("")
        lines.append("=== 最近 12 轮 ===")
        for turn in snapshot["recent_turns"]:
            when = time.strftime("%m-%d %H:%M", beijing_now(turn["ts"] / 1000))
            tag = "峰" if turn["peak"] else "谷"
            src = "hook" if turn["source"] == "hook" else "手动"
            lines.append(f"{when}  {turn['model']:<18} {format_money(turn['cost'], 4)}  {tag} {src}")

    lines.append("")
    lines.append("两个口径不要相加：观测口径来自账户余额变化（可信但粗糙），")
    lines.append("逐轮口径是本机按 token × 单价的估算（细但有偏差，只覆盖上报过的轮次）。")
    return "\n".join(lines)
