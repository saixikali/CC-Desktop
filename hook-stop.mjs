/**
 * whale-balance 的 Stop hook —— 自动逐轮记账。
 *
 * 为什么需要它：MCP 工具只能"被调用才存在"，做不到自动记账。hooks 是 CC Desktop
 * 插件系统里另一条扩展路径，能在每轮结束时拿到会话上下文，于是我在这里读
 * Claude Code 的 transcript（里面带每轮的 usage），自动把金额记进同一个账本。
 *
 * 契约（重要）：
 *  - stdout 必须保持干净。Stop hook 往 stdout 写内容会被当成"给模型的追加指令"，
 *    污染对话。所以本脚本只在完全成功且未启用 debug 时静默退出；
 *  - 任何错误都不改变退出码为 0 —— 记账失败绝不能阻断对话。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LEDGER_PATH, saveLedger, recordTurn, formatMoney, acquireLock, LedgerBusy, loadLedger,
} from './ledger.mjs';

// 必须用 fileURLToPath：URL.pathname 会把非 ASCII 路径百分号编码，
// 于是 state 文件会写到 "%E4%B8%AD..." 这种假路径上去（本插件踩过）。
const HOOK_DIR = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(HOOK_DIR, '.hook-state.json');
const LOG_PATH = path.join(HOOK_DIR, 'hook.log');
const SCAN_MAX_DEPTH = 3;
const SCAN_MAX_FILES = 400;

const DEBUG = process.env.WHALE_BALANCE_HOOK_DEBUG === '1';
const startedAt = Date.now();
// stdin 看门狗：生产环境的 hook 运行器若不关 stdin，读它会挂死整个轮次。
// 超时后按「无 payload」继续 —— 退化成"只记账、不做 session 匹配"，而不是卡住对话。
const STDIN_TIMEOUT_MS = 3000;

function note(message) {
  if (!DEBUG) return;
  try {
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch { /* 日志写不进去也不能影响对话 */ }
}

function readState() {
  try {
    const text = fs.readFileSync(STATE_PATH, 'utf8');
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      note(`state 不是对象，按空状态处理：${text.slice(0, 200)}`);
      return {};
    }
    note(`state 读取成功：offset=${parsed.offset} transcript=${parsed.transcript ?? '(未认下)'}`);
    return parsed;
  } catch (err) {
    if (err?.code === 'ENOENT') note(`state 不存在（${STATE_PATH}），按空状态处理`);
    else note(`state 读取失败（${err?.code ?? ''} ${err?.message}），按空状态处理`);
    return {};
  }
}

function writeState(state) {
  try {
    fs.mkdirSync(HOOK_DIR, { recursive: true });
    const tmp = `${STATE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, STATE_PATH);
    note(`state 已写入 offset=${state.offset} transcript=${state.transcript ?? '(未认下)'}`);
  } catch (err) {
    note(`state 写入失败：${err?.code ?? ''} ${err?.message} —— 下次会重新建立基线（可能漏记这轮，但不会重复计费）`);
  }
}

/**
 * 读 stdin 拿 hook payload。
 *
 * 陷阱（本插件踩过）：`fs.readFileSync(0)` 与 `fs.readSync(0)` 在 stdin 不关闭时都会
 * **永久阻塞**，而且阻塞在系统调用里 —— 定时器、Atomics.wait 都救不回来，只有信号能打断。
 * 所以这里用事件式读取 + 一个 unref 过的看门狗定时器：正常情况 stdin 一关就收工；
 * 万一上游不关 stdin，3 秒后带着已读到的字节继续，绝不把整个轮次拖住。
 */
function readStdinThen(onDone) {
  let finished = false;
  const chunks = [];
  const started = Date.now();

  const finish = (reason) => {
    if (finished) return;
    finished = true;
    clearTimeout(watchdog);
    if (reason) note(`stdin ${reason}（已读 ${chunks.reduce((n, c) => n + c.length, 0)} 字节，耗时 ${Date.now() - started}ms）`);
    onDone(Buffer.concat(chunks).toString('utf8'));
  };

  const watchdog = setTimeout(() => finish('看门狗超时，按已读到的内容继续'), STDIN_TIMEOUT_MS);
  watchdog.unref?.();

  try {
    process.stdin.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
      if (chunks.reduce((n, c) => n + c.length, 0) > 1024 * 1024) finish('超过 1MB 上限，截断');
    });
    process.stdin.on('end', () => finish(null));
    process.stdin.on('error', (err) => finish(`读取报错 ${err?.code ?? ''}`));
    process.stdin.resume();
  } catch (err) {
    finish(`不可读：${err?.message ?? String(err)}`);
  }
}

/** 找 transcript：优先用 payload 给的路子，否则在 ~/.claude/projects 里找最新/同 session 的。 */
function discoverTranscript(payload, state) {
  const explicit = payload?.transcript_path ?? payload?.transcriptPath;
  if (typeof explicit === 'string' && explicit && fs.existsSync(explicit)) {
    return { file: explicit, how: 'payload.transcript_path' };
  }

  const sessionId = typeof payload?.session_id === 'string' ? payload.session_id
    : typeof payload?.sessionId === 'string' ? payload.sessionId : null;

  const roots = [];
  if (typeof payload?.cwd === 'string' && payload.cwd) roots.push(path.join(claudeProjectsRoot(), encodeCwd(payload.cwd)));
  roots.push(claudeProjectsRoot());

  const candidates = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    collectJsonl(root, 0, candidates);
    if (candidates.length >= SCAN_MAX_FILES) break;
  }
  if (candidates.length === 0) return { file: null, how: 'none' };

  candidates.sort((a, b) => b.mtime - a.mtime);

  if (sessionId) {
    const byId = candidates.find((c) => path.basename(c.file, '.jsonl') === sessionId);
    if (byId) return { file: byId.file, how: `session_id 匹配（共 ${candidates.length} 个候选）` };
  }

  // 同一会话的后续轮次：沿用上次认下的文件，避免 cwd 不同就漂到别的会话
  const last = state?.transcript;
  if (typeof last === 'string' && fs.existsSync(last)) {
    const stillNewest = candidates[0]?.file === last;
    if (stillNewest || !sessionId) return { file: last, how: '沿用上次认下的 transcript' };
  }

  return { file: candidates[0].file, how: `取最新（共 ${candidates.length} 个候选）` };
}

function claudeProjectsRoot() {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
}

function encodeCwd(cwd) {
  // Claude Code 的目录名编码：非字母数字一律换成 '-'
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

function collectJsonl(dir, depth, out) {
  if (depth > SCAN_MAX_DEPTH || out.length >= SCAN_MAX_FILES) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= SCAN_MAX_FILES) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsonl(full, depth + 1, out);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      try {
        const stat = fs.statSync(full);
        out.push({ file: full, mtime: stat.mtimeMs, size: stat.size });
      } catch { /* 跳过读不到的文件 */ }
    }
  }
}

/**
 * 从 offset 起增量读 transcript，抽出「本轮新增的 API 调用」。
 *
 * 去重与去重的理由：同一次 API 调用在 transcript 里会出现两条（thinking 条 + text 条），
 * 共用一个 message.id，而且两条都带完整 usage —— 不去重就会把每一轮算成两轮的钱。
 * 取最后一条（`set` 覆盖）即可。
 */
function extractTurns(file, fromOffset) {
  const size = fs.statSync(file).size;

  // 偏移是按**文本字符**累计的，而磁盘上的换行可能是 \r\n：文本长度与字节数不能混用。
  // 本插件真踩过这个坑 —— 用"文本字节数 + 假定 1 字节换行"算偏移，在 \r\n 的文件上
  // 每次都多出几个字节，于是 size < offset 成立、被误判成"文件被截断"，结果每轮都从头
  // 重放整份 transcript，历史轮次被反复计费。
  // 正确做法：偏移一律用**真实字节位置**（见下 bytesConsumed），并且容忍"文件变小"。
  let start = fromOffset;
  if (size < start) {
    note(`文件比记录的偏移小（size=${size} < offset=${start}）—— 按换行差异容忍，从 size 处继续而非从头重放`);
    start = size;
  }
  if (size === start) return { entries: [], nextOffset: start };

  const fd = fs.openSync(file, 'r');
  let buffer;
  try {
    buffer = Buffer.allocUnsafe(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
  } finally {
    fs.closeSync(fd);
  }

  const text = buffer.toString('utf8');
  const lines = text.split('\n');

  // 只处理到最后一个换行为止：最后一段可能是写了一半的 JSON
  const completeCount = Math.max(0, lines.length - 1);
  const usable = lines.slice(0, completeCount);
  const consumed = bytesThroughNthNewline(buffer, completeCount);

  const seen = new Map();
  for (const line of usable) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const message = entry?.message;
    if (!message || message.role !== 'assistant' || !message.usage) continue;
    const ts = Date.parse(entry.timestamp ?? '') || null;
    const id = message.id ?? `${entry.uuid ?? Math.random()}`;
    seen.set(id, {
      id,
      ts: ts ?? Date.now(),
      model: message.model ?? 'unknown',
      usage: message.usage,
    });
  }

  return { entries: [...seen.values()], nextOffset: start + consumed };
}

/** 数出 buffer 里前 lineCount 个换行（含）所占的**真实字节数**，兼容 \n 与 \r\n。 */
function bytesThroughNthNewline(buffer, lineCount) {
  if (lineCount <= 0) return 0;
  let found = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0x0a) {
      found += 1;
      if (found === lineCount) return index + 1;
    }
  }
  return buffer.length;
}

function main(raw) {
  const state = readState();

  // 基线：第一次跑只记下当前 transcript 的长度，之前的字节一律不算。
  // 不用「安装时刻 > 事件时间戳」是因为 transcript 条目的时间戳可能早于它落盘的时刻
  // （本插件踩过：那样会把之后所有轮次都挡掉）。字节基线不依赖时钟，也更准。
  const installTs = state.installTs ?? startedAt;
  if (!state.installTs) state.installTs = installTs;

  let payload = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    note(`payload 不是 JSON，按无 payload 处理：${raw.slice(0, 200)}`);
  }
  if (DEBUG) note(`payload=${JSON.stringify(payload)?.slice(0, 800)}`);

  const { file, how } = discoverTranscript(payload, state);
  if (!file) {
    note(`没找到 transcript（${how}）`);
    writeState(state);
    return;
  }
  note(`transcript=${file}（${how}）`);

  const sameFile = state.transcript === file;
  let fromOffset;
  if (!sameFile) {
    // 第一次认下这个文件，或换了文件：只从当前末尾起算
    fromOffset = fs.statSync(file).size;
    note(`首次认下该 transcript（或已换文件），基线 offset=${fromOffset}`);
  } else if (Number.isFinite(state.offset)) {
    fromOffset = state.offset;
  } else {
    fromOffset = fs.statSync(file).size;
  }

  // 关键：offset 的读取、账本的读改写、offset 的推进必须在**同一把锁**里。
  // 否则两个进程会从同一个 offset 各读一遍、各写一遍账本 —— 同一轮被记两次。
  // 锁拿不到就直接退出（退出码 0）：这轮留到下次处理，绝不会重复计费。
  let release;
  try {
    release = acquireLock({ timeoutMs: 4000 });
  } catch (err) {
    if (err instanceof LedgerBusy) {
      note('账本被占用，本轮留给下次处理（不推进 offset，因此不会漏也不会重）');
      return;
    }
    throw err;
  }

  let counted = 0;
  let totalCost = 0n;
  const failed = [];
  try {
    // 锁内重读 state：别的进程可能刚推进过 offset
    const fresh = readState();
    if (fresh.transcript === file && Number.isFinite(fresh.offset)) {
      fromOffset = fresh.offset;
    } else if (fresh.transcript !== file) {
      fromOffset = fs.statSync(file).size;
    }

    const { entries, nextOffset } = extractTurns(file, fromOffset);
    if (entries.length === 0) {
      state.transcript = file;
      state.offset = nextOffset;
      writeState(state);
      note(`无新增轮次（offset ${fromOffset} → ${nextOffset}）`);
      return;
    }

    const ledger = loadLedger();
    note(`准备记账 ${entries.length} 条：${entries.map((e) => `${e.id}@${e.ts}`).join(' | ')}`);
    for (const entry of entries) {
      try {
        const result = recordTurn(ledger, {
          model: entry.model,
          usage: entry.usage,
          ts: entry.ts,
          source: 'hook',
          extra: { callId: entry.id },
        });
        totalCost += result.total;
        counted += 1;
      } catch (err) {
        failed.push(`${entry.model}: ${err?.message ?? String(err)}`);
      }
    }
    if (counted > 0) saveLedger(ledger);
    note(`账本现有 ${ledger.turns.length} 轮，末尾 callId=${ledger.turns.slice(-3).map((t) => t.callId).join(',')}`);

    state.transcript = file;
    state.offset = nextOffset;
    writeState(state);
    note(`记账 ${counted} 轮 / 合计 ${formatMoney(totalCost, 6)} USD；跳过 ${failed.length} 轮${
      failed.length ? `：${failed.slice(0, 3).join(' | ')}` : ''}；offset → ${nextOffset}`);
  } finally {
    release();
  }
}

try {
  readStdinThen((raw) => {
    try {
      main(raw);
    } catch (err) {
      // 记账失败绝不阻断对话：只记日志，退出码保持 0
      note(`hook 异常：${err?.stack ?? String(err)}`);
    }
    process.exit(0);
  });
} catch (err) {
  note(`hook 启动异常：${err?.stack ?? String(err)}`);
  process.exit(0);
}
