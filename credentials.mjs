/**
 * whale-balance —— 凭据解析（server 与自检共用，零依赖）
 *
 * 为什么单独一个文件：判定逻辑必须是纯函数才测得到。
 * server.mjs 一旦被 import 就会打开 stdin 的 JSON-RPC 循环，测试没法把它拉进来，
 * 所以"从哪个变量找 key"这件事必须留在这里。
 *
 * 为什么需要 anthropicKeyForDeepSeek：
 * 本机（以及很多国内用法）是把 Claude Code 指向 DeepSeek 的 Anthropic 兼容端点：
 *   ANTHROPIC_BASE_URL = https://api.deepseek.com/anthropic
 *   ANTHROPIC_AUTH_TOKEN = sk-...        ← 这就是 DeepSeek 的 key
 * 这种情况下用户手里明明有 key，插件却只认 DEEPSEEK_API_KEY，于是报"没有找到 key"。
 * 复用宿主已经注入的凭据，比让用户再抄一份明文到磁盘更干净。
 *
 * 守卫为什么必须存在：
 * 如果哪天宿主换回真正的 Anthropic，ANTHROPIC_AUTH_TOKEN 就是 Anthropic 的 key。
 * 拿它去请求 api.deepseek.com/user/balance 等于把凭据发给了无关的第三方。
 * 所以**只在 base URL 确实指向 deepseek 时才复用**，这是本文件存在的全部意义。
 */

const DEEPSEEK_BASE_RE = /deepseek/i;

/**
 * 从宿主注入的环境变量里取 DeepSeek 可用的 key。
 * 纯函数：不读盘、不联网、不改入参。
 *
 * @param {Record<string, string|undefined>} env  通常是 process.env
 * @returns {{key: string, source: string}|null}  取不到时为 null
 */
export function anthropicKeyForDeepSeek(env) {
  if (!env || typeof env !== 'object') return null;

  const base = env.ANTHROPIC_BASE_URL;
  if (typeof base !== 'string' || !DEEPSEEK_BASE_RE.test(base)) return null; // 守卫：不是 deepseek 就不碰

  for (const name of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']) {
    const value = env[name];
    if (typeof value === 'string' && value.trim()) {
      return { key: value.trim(), source: `环境变量 ${name}（ANTHROPIC_BASE_URL 指向 deepseek）` };
    }
  }
  return null;
}
