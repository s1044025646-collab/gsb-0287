/**
 * FNV-1a 32 位哈希，对字符串的 UTF-8 字节序列计算。
 *
 * 规则（公开固定，可复现）：
 *   hash = 0x811c9dc5 (2166136261)
 *   对每个字节 b: hash = (hash XOR b) * 0x01000193，乘法按 32 位无符号整数截断
 *   （JS 中用 Math.imul 得到低 32 位，再用 >>> 0 视为无符号数）。
 * 桶号规则：bucket = hash & (capacity - 1)，capacity 必须为 2 的幂。
 */
export function fnv1a32(input: string): number {
  const bytes = Buffer.from(input, "utf8");
  let hash = 0x811c9dc5;
  for (const b of bytes) {
    hash ^= b;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function bucketOf(hash: number, capacity: number): number {
  return hash & (capacity - 1);
}
