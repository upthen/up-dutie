/* 分页引擎（spec 测试决策接缝二）：纯函数，度量以注入的 metrics 传入，不依赖 DOM。
   行为契约：输出序列与输入全等（无丢、无重、不乱序）；给定度量下单叶不超容量
   （单字超限允许成孤列，对应 spec「单超限句对允许成孤页」）；空输入有定义行为。

   装箱模型（v2 定稿·字级装箱）：
   - 竖排：句对 → 界行（原文每字一格、按列高切列；释义按每列容量切片）→ 书叶（按叶宽贪心）→ 对开（两叶一开）
   - 横排：句对 = 一行（原文行 + 行内释义），按行数装箱成叶 */

import type { PairUnit } from './validate';

export const PUNCT_RE = /[，。；：、？！「」『』（）—…·《》〈〉,.\!?;:'"()\-\s]/;
export const isPunct = (ch: string) => PUNCT_RE.test(ch);

/** 字格单元 */
export interface ChUnit {
  type: 'ch';
  ch: string;
  punct: boolean;
  pair: number;
  seg: number;
  /** 段首句的第一字（来自数据字段 f，入库时校验唯一） */
  segMark: boolean;
}

export interface OrigColumn {
  kind: 'orig';
  seg: number;
  pair: number;
  units: ChUnit[];
}
export interface GlossColumn {
  kind: 'gloss';
  seg: number;
  pair: number;
  text: string;
}
/** 横排行：原文 + 行内释义 */
export interface RowColumn {
  kind: 'row';
  seg: number;
  pair: number;
  units: ChUnit[];
  gloss: string;
}
export type Column = OrigColumn | GlossColumn | RowColumn;
export type Leaf = Column[];

export interface Opening {
  /** 右叶（起手叶）索引 */
  right: number;
  /** 左叶索引；末开不足时为 null */
  left: number | null;
}

export interface Metrics {
  /** 书叶文字区可用高（px） */
  colH: number;
  /** 书叶文字区可用宽（px） */
  leafW: number;
  /** 原文字号（px），亦即每字格高 */
  origSize: number;
  /** 界行宽（px），原文列宽 */
  colW: number;
  /** 释义字号（px） */
  glossSize: number;
  /** 释义列宽（px） */
  glossColW: number;
  /** 释义每字步进（px） */
  glossStep: number;
  /** 释义列容量计算时扣除的上下留白（px） */
  glossPad: number;
}

/** 横排每叶行数上下限（v2 定稿：3–6 行） */
export const MIN_ROWS_PER_LEAF = 3;
export const MAX_ROWS_PER_LEAF = 6;

export interface PackOptions {
  /** true 用繁体 t，false 用简体 s */
  trad: boolean;
}

function chunk<T>(arr: T[], size: number): T[][] {
  if (size < 1) size = 1;
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** 原文每列可容字数；列高不足一字时保底 1（单字成列，允许超容量） */
export function charsPerOrigCol(m: Metrics): number {
  return Math.max(1, Math.floor(m.colH / m.origSize));
}

/** 释义每列可容字数 */
export function charsPerGlossCol(m: Metrics): number {
  return Math.max(1, Math.floor((m.colH - m.glossPad) / m.glossStep));
}

/** 界行的渲染宽度（含 1px 界线） */
export function columnWidth(col: Column, m: Metrics): number {
  return (col.kind === 'gloss' ? m.glossColW : m.colW) + 1;
}

/** 竖排第一步：句对 → 界行序列（原文列与释义列交替，语序保持） */
export function packColumns(units: PairUnit[], m: Metrics, opts: PackOptions): Column[] {
  const perOrig = charsPerOrigCol(m);
  const perGloss = charsPerGlossCol(m);
  const columns: Column[] = [];

  units.forEach((p, pi) => {
    const text = opts.trad ? p.t : p.s;
    for (const chars of chunk([...text], perOrig)) {
      columns.push({
        kind: 'orig',
        seg: p.d,
        pair: pi,
        units: chars.map((ch, ci) => ({
          type: 'ch' as const,
          ch,
          punct: isPunct(ch),
          pair: pi,
          seg: p.d,
          segMark: ci === 0 && p.f === true,
        })),
      });
    }
    const glossChars = [...p.z].filter((c) => c.trim() !== '');
    for (const text of chunk(glossChars, perGloss)) {
      columns.push({ kind: 'gloss', seg: p.d, pair: pi, text: text.join('') });
    }
  });

  return columns;
}

/** 竖排第二步：界行 → 书叶（按叶宽贪心装箱；首列必入，杜绝空叶死循环） */
export function packLeaves(columns: Column[], m: Metrics): Leaf[] {
  const leaves: Leaf[] = [];
  let leaf: Leaf = [];
  let usedW = 0;
  for (const col of columns) {
    const cw = columnWidth(col, m);
    if (usedW + cw > m.leafW && leaf.length) {
      leaves.push(leaf);
      leaf = [];
      usedW = 0;
    }
    leaf.push(col);
    usedW += cw;
  }
  if (leaf.length) leaves.push(leaf);
  return leaves.length ? leaves : [[]];
}

/** 书叶 → 对开（两叶一开，右叶在先） */
export function pairOpenings(leaves: Leaf[]): Opening[] {
  const openings: Opening[] = [];
  for (let i = 0; i < leaves.length; i += 2) {
    openings.push({ right: i, left: i + 1 < leaves.length ? i + 1 : null });
  }
  return openings.length ? openings : [{ right: 0, left: null }];
}

/** 横排：句对 → 每叶行集（原文行+行内释义，按行高装箱，行数 3–6 夹取） */
export function packRows(units: PairUnit[], m: Metrics, opts: PackOptions): Leaf[] {
  const rowH = m.origSize * 1.35 + 28;
  const per = Math.max(MIN_ROWS_PER_LEAF, Math.min(MAX_ROWS_PER_LEAF, Math.floor(m.colH / rowH)));
  const leaves: Leaf[] = [];
  for (let i = 0; i < units.length; i += per) {
    leaves.push(
      units.slice(i, i + per).map((p, j) => {
        const chars = [...(opts.trad ? p.t : p.s)];
        return {
          kind: 'row' as const,
          seg: p.d,
          pair: i + j,
          gloss: p.z,
          units: chars.map((ch, ci) => ({
            type: 'ch' as const,
            ch,
            punct: isPunct(ch),
            pair: i + j,
            seg: p.d,
            segMark: ci === 0 && p.f === true,
          })),
        };
      }),
    );
  }
  return leaves.length ? leaves : [[]];
}

/** 段首句（f 标记）所在书叶索引；找不到返回 -1 */
export function findLeafOfSeg(leaves: Leaf[], seg: number): number {
  for (let li = 0; li < leaves.length; li++) {
    for (const col of leaves[li]) {
      if (col.kind === 'gloss') continue;
      if (col.units.some((u) => u.seg === seg && u.segMark)) return li;
    }
  }
  return -1;
}

/** 书叶的第一个段号（版心「段次」用）；空叶返回 null */
export function leafFirstSeg(leaf: Leaf | null | undefined): number | null {
  if (!leaf) return null;
  for (const col of leaf) {
    if (col.seg != null) return col.seg;
    for (const u of col.units ?? []) {
      if (u.seg != null) return u.seg;
    }
  }
  return null;
}

/** 扁平化书叶为字符序列（验收用：与输入全等） */
export function flattenChars(leaves: Leaf[]): string[] {
  const out: string[] = [];
  for (const leaf of leaves) {
    for (const col of leaf) {
      if (col.kind === 'gloss') {
        out.push(...[...col.text]);
      } else {
        for (const u of col.units) out.push(u.ch);
        if (col.kind === 'row') out.push(...[...col.gloss]);
      }
    }
  }
  return out;
}
