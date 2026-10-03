// FNV-1a 32 位哈希，对键的 UTF-8 字节序列计算。
// 规则（公开固定，可复现）：
//   h = 2166136261 (0x811c9dc5)
//   对每个字节 b: h = (h XOR b) * 16777619 (0x01000193)，乘法按 32 位无符号整数截断
// 桶号 = h & (capacity - 1)，容量始终为 2 的幂。
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export function fnv1a32(key: string): number {
  const bytes = Buffer.from(key, 'utf8');
  let h = FNV_OFFSET >>> 0;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, FNV_PRIME) >>> 0; // 32 位截断
  }
  return h >>> 0;
}

export function bucketOf(hash: number, capacity: number): number {
  return (hash & (capacity - 1)) >>> 0;
}
