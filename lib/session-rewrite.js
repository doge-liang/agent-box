'use strict';
// 会话 JSONL 落地改写:把源机项目根前缀替换为本机项目根(仅顶层 cwd 字段)。
// 只重写"含 cwd 且前缀命中"的行;其余行字节原样透传,最小化 JSON 重序列化漂移面。
// 不改写历史 tool 输出中嵌的路径(已知限制:resume 后上下文中会出现他机路径)。
function mapPath(value, oldRoot, newRoot, fromSep, toSep) {
  if (typeof value !== 'string') return null;
  if (value !== oldRoot && !value.startsWith(oldRoot + fromSep)) return null;
  const rest = value.slice(oldRoot.length);
  return newRoot + (fromSep === toSep ? rest : rest.split(fromSep).join(toSep));
}

function rewriteCwd(text, oldRoot, newRoot, opts = {}) {
  const fromSep = opts.fromSep || '/';
  const toSep = opts.toSep || '/';
  return text.split('\n').map((line) => {
    if (!line.includes('"cwd"')) return line;
    let rec;
    try { rec = JSON.parse(line); } catch { return line; }
    if (!rec || typeof rec !== 'object') return line;
    const mapped = mapPath(rec.cwd, oldRoot, newRoot, fromSep, toSep);
    if (mapped === null) return line;
    rec.cwd = mapped;
    return JSON.stringify(rec);
  }).join('\n');
}

module.exports = { rewriteCwd, mapPath };
