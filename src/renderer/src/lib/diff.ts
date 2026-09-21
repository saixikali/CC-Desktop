/**
 * 行级 diff（审批卡用）：零依赖的简化 LCS 行对比。
 * 策略：剥掉公共前/后缀后对中段做 LCS；中段过大（>250万格）时退化为整块替换，
 * 保证超大文件不会拖垮 UI。
 */

export interface DiffLine {
  type: "add" | "del" | "ctx";
  text: string;
}

/** 中段 LCS 的规模上限（旧行数 × 新行数），超过即整块替换。 */
const MAX_LCS_CELLS = 2_500_000;

function splitLines(text: string): string[] {
  if (text === "") return [];
  return text.split(/\r?\n/);
}

export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);

  // 公共前缀
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  // 公共后缀
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const out: DiffLine[] = [];
  for (let i = 0; i < start; i++) out.push({ type: "ctx", text: a[i] });

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  if (midA.length * midB.length > MAX_LCS_CELLS) {
    // 规模超限：整块替换（前 200 行 + 截断提示）
    const cap = (lines: string[], type: DiffLine["type"]) => {
      for (const l of lines.slice(0, 200)) out.push({ type, text: l });
      if (lines.length > 200) out.push({ type: "ctx", text: `…（其余 ${lines.length - 200} 行省略）` });
    };
    cap(midA, "del");
    cap(midB, "add");
  } else {
    // LCS DP
    const n = midA.length;
    const m = midB.length;
    const dp: Uint32Array = new Uint32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * (m + 1) + j] =
          midA[i] === midB[j]
            ? dp[(i + 1) * (m + 1) + j + 1] + 1
            : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        out.push({ type: "ctx", text: midA[i] });
        i++;
        j++;
      } else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) {
        out.push({ type: "del", text: midA[i] });
        i++;
      } else {
        out.push({ type: "add", text: midB[j] });
        j++;
      }
    }
    while (i < n) out.push({ type: "del", text: midA[i++] });
    while (j < m) out.push({ type: "add", text: midB[j++] });
  }

  for (let k = endA; k < a.length; k++) out.push({ type: "ctx", text: a[k] });
  return out;
}

/** diff 摘要：新增/删除行数。 */
export function summarizeDiff(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.type === "add") added++;
    else if (l.type === "del") removed++;
  }
  return { added, removed };
}
