/** 汉字数字（页码/叶码用）：1–99 */
const CN_NUM = [
  '〇', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
];

export function toCN(n: number): string {
  if (n <= 20) return CN_NUM[n] ?? String(n);
  if (n < 100) {
    const t = Math.floor(n / 10);
    const o = n % 10;
    return (t === 1 ? '十' : CN_NUM[t] + '十') + (o ? CN_NUM[o] : '');
  }
  return String(n);
}
