import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { PairUnit } from './validate';
import {
  MAX_ROWS_PER_LEAF,
  MIN_ROWS_PER_LEAF,
  charsPerGlossCol,
  charsPerOrigCol,
  columnWidth,
  findLeafOfSeg,
  flattenChars,
  isPunct,
  leafFirstSeg,
  packColumns,
  packLeaves,
  packRows,
  pairOpenings,
  type Metrics,
} from './pagination';

/* 度量贴近真实阅读器：42px 字号、68px 界行、约 700×520 的文字区 */
const M: Metrics = {
  colH: 640,
  leafW: 520,
  origSize: 42,
  colW: 68,
  glossSize: 18,
  glossColW: 28,
  glossStep: 18 * 1.55,
  glossPad: 24,
};

/** 连续分块造句对：n 句分 segs 段，段首句带 f */
function mkUnits(n: number, segs = 1): PairUnit[] {
  const block = Math.ceil(n / segs);
  return Array.from({ length: n }, (_, i) => ({
    d: Math.floor(i / block) + 1,
    f: i % block === 0,
    t: `原句甲乙丙丁${i}。`,
    s: `原句甲乙丙丁${i}。`,
    z: `释义文字第${i}句。`,
  }));
}

/** 全等契约的期望序列：逐句对「原文句 + 释义句（去空白）」 */
function expectedSeq(units: PairUnit[], pick: (u: PairUnit) => string): string[] {
  return units.flatMap((u) => [...pick(u), ...[...u.z].filter((c) => c.trim() !== '')]);
}

describe('packColumns · 竖排界行', () => {
  it('每原文列字数不超容量（floor(colH/origSize)），除非单字成列', () => {
    const cap = charsPerOrigCol(M);
    const cols = packColumns(mkUnits(5), M, { trad: true });
    for (const col of cols) {
      if (col.kind !== 'orig') continue;
      expect(col.units.length).toBeLessThanOrEqual(cap);
    }
  });

  it('列高不足一字时单字成列（单超限边界）', () => {
    const tiny: Metrics = { ...M, colH: 30, origSize: 42 };
    const cols = packColumns(mkUnits(1), tiny, { trad: true });
    const origCols = cols.filter((c) => c.kind === 'orig');
    expect(origCols.length).toBeGreaterThan(0);
    for (const col of origCols) {
      expect(col.units).toHaveLength(1);
    }
  });

  it('释义列字数不超容量', () => {
    const cap = charsPerGlossCol(M);
    const cols = packColumns(mkUnits(5), M, { trad: true });
    for (const col of cols) {
      if (col.kind === 'gloss') expect([...col.text].length).toBeLessThanOrEqual(cap);
    }
  });

  it('段首标记只落在段首句第一字（来自 f）', () => {
    const cols = packColumns(mkUnits(4, 2), M, { trad: true });
    const marks = cols.flatMap((c) => (c.kind === 'gloss' ? [] : c.units.filter((u) => u.segMark)));
    expect(marks.map((u) => u.pair)).toEqual([0, 2]);
  });

  it('繁简切换只换文字不换结构', () => {
    const units: PairUnit[] = [
      { d: 1, f: true, t: '甲乙。', s: '乂乂。', z: '释。' },
    ];
    const trad = packColumns(units, M, { trad: true });
    const simp = packColumns(units, M, { trad: false });
    expect(trad.filter((c) => c.kind === 'orig').map((c) => (c as { units: { ch: string }[] }).units.map((u) => u.ch).join(''))).toEqual(['甲乙。']);
    expect(simp.filter((c) => c.kind === 'orig').map((c) => (c as { units: { ch: string }[] }).units.map((u) => u.ch).join(''))).toEqual(['乂乂。']);
  });

  it('isPunct 识别中英标点', () => {
    expect(isPunct('。')).toBe(true);
    expect(isPunct('，')).toBe(true);
    expect(isPunct('?')).toBe(true);
    expect(isPunct(' ')).toBe(true);
    expect(isPunct('甲')).toBe(false);
  });
});

describe('packLeaves · 书叶装箱', () => {
  it('每叶界行宽总和不超过叶宽（首列例外：孤列允许超限）', () => {
    const cols = packColumns(mkUnits(12), M, { trad: true });
    const leaves = packLeaves(cols, M);
    expect(leaves.length).toBeGreaterThan(1);
    for (const leaf of leaves) {
      if (leaf.length === 1) continue; // 单列孤叶
      const w = leaf.reduce((s, c) => s + columnWidth(c, M), 0);
      expect(w).toBeLessThanOrEqual(M.leafW);
    }
  });

  it('界行跨叶保持语序且无丢无重（全等契约）', () => {
    const units = mkUnits(9);
    const cols = packColumns(units, M, { trad: true });
    const leaves = packLeaves(cols, M);
    const flat = leaves.flat().flatMap((c) => (c.kind === 'gloss' ? [c] : []));
    // 列级全等：装箱不丢列
    expect(leaves.flat().length).toBe(cols.length);
    expect(flat.length).toBe(cols.filter((c) => c.kind === 'gloss').length);
  });

  it('空输入产生一叶空书', () => {
    expect(packLeaves([], M)).toEqual([[]]);
    expect(packColumns([], M, { trad: true })).toEqual([]);
  });

  it('恰好装满一叶时不切第二叶', () => {
    const single: Metrics = { ...M, colW: 99, glossColW: 99 };
    // 手工构造：两列，宽度 = 100 + 100 = 200 = leafW
    const cols = packColumns([{ d: 1, f: true, t: '甲。', s: '甲。', z: '乙。' }], single, { trad: true });
    const leaves = packLeaves(cols, { ...single, leafW: 200 });
    expect(leaves).toHaveLength(1);
  });

  it('超宽单列（列宽>叶宽）成孤叶且不死循环', () => {
    const cols = packColumns([{ d: 1, f: true, t: '甲乙丙丁。', s: '甲乙丙丁。', z: '释。' }], M, { trad: true });
    const leaves = packLeaves(cols, { ...M, leafW: 10 });
    expect(leaves.length).toBe(cols.length);
    for (const leaf of leaves) expect(leaf).toHaveLength(1);
  });
});

describe('pairOpenings · 对开', () => {
  it('两叶一开、右叶在先，末开可缺左叶', () => {
    const leaves = [[], [], [], [], []];
    const ops = pairOpenings(leaves);
    expect(ops).toEqual([
      { right: 0, left: 1 },
      { right: 2, left: 3 },
      { right: 4, left: null },
    ]);
  });

  it('单叶成单开；空书也有一开', () => {
    expect(pairOpenings([[]])).toEqual([{ right: 0, left: null }]);
    expect(pairOpenings([])).toEqual([{ right: 0, left: null }]);
  });
});

describe('flattenChars · 全等契约', () => {
  it('竖排全链路输出 = 逐句对「原文句＋释义句」（无丢、无重、不乱序）', () => {
    const units = mkUnits(7, 3);
    const leaves = packLeaves(packColumns(units, M, { trad: true }), M);
    expect(flattenChars(leaves)).toEqual(expectedSeq(units, (u) => u.t));
  });

  it('横排全链路输出 = 逐句对「原文句＋释义句」', () => {
    const units = mkUnits(7, 3);
    const leaves = packRows(units, M, { trad: false });
    expect(flattenChars(leaves)).toEqual(expectedSeq(units, (u) => u.s));
  });
});

describe('packRows · 横排', () => {
  it('每叶行数在 3–6 之间（不足 3 行的末叶除外）', () => {
    const leaves = packRows(mkUnits(14), M, { trad: true });
    for (const leaf of leaves) {
      expect(leaf.length).toBeLessThanOrEqual(MAX_ROWS_PER_LEAF);
      if (leaf !== leaves[leaves.length - 1]) {
        expect(leaf.length).toBeGreaterThanOrEqual(MIN_ROWS_PER_LEAF);
      }
    }
    expect(leaves.reduce((s, l) => s + l.length, 0)).toBe(14);
  });

  it('每行是「原文行 + 行内释义」结构', () => {
    const leaves = packRows(mkUnits(3), M, { trad: true });
    const row = leaves[0][0];
    expect(row.kind).toBe('row');
    if (row.kind === 'row') {
      expect(row.gloss).toContain('释义');
      expect(row.units.every((u) => u.type === 'ch')).toBe(true);
    }
  });

  it('空输入产生一叶空书', () => {
    expect(packRows([], M, { trad: true })).toEqual([[]]);
  });
});

describe('段定位', () => {
  it('findLeafOfSeg 定位每段首句所在叶，未知段返回 -1', () => {
    const units = mkUnits(20, 4); // 段1: 0-4, 段2: 5-9, 段3: 10-14, 段4: 15-19
    const leaves = packLeaves(packColumns(units, M, { trad: true }), M);
    const segLeaf = new Set<number>();
    for (let seg = 1; seg <= 4; seg++) {
      const li = findLeafOfSeg(leaves, seg);
      expect(li).toBeGreaterThanOrEqual(0);
      segLeaf.add(li);
    }
    // 段次递增，所在叶号不回退
    expect([...segLeaf].sort((a, b) => a - b)).toEqual([...segLeaf]);
    expect(findLeafOfSeg(leaves, 99)).toBe(-1);
  });

  it('leafFirstSeg 返回叶内首个段号，空叶返回 null', () => {
    expect(leafFirstSeg([])).toBeNull();
    expect(leafFirstSeg(null)).toBeNull();
    const leaves = packLeaves(packColumns(mkUnits(6, 2), M, { trad: true }), M);
    const first = leafFirstSeg(leaves[0]);
    expect(first).toBe(1);
  });
});

describe('真实内容冒烟', () => {
  it('《集王圣教序》47 句对全链路全等、可定位四段', () => {
    const raw = JSON.parse(readFileSync(new URL('../../content/sheng-jiao-xu.json', import.meta.url), 'utf-8')) as {
      units: PairUnit[];
    };
    const units = raw.units;
    const leaves = packLeaves(packColumns(units, M, { trad: true }), M);
    expect(flattenChars(leaves)).toEqual(expectedSeq(units, (u) => u.t));
    for (let seg = 1; seg <= 4; seg++) {
      expect(findLeafOfSeg(leaves, seg)).toBeGreaterThanOrEqual(0);
    }
    // 常识性规模：47 句对应多叶多开
    expect(leaves.length).toBeGreaterThan(4);
    expect(pairOpenings(leaves).length).toBeGreaterThanOrEqual(Math.ceil(leaves.length / 2));
  });
});
