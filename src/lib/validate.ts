/* 内容校验（spec 测试决策接缝一）：纯函数，不依赖 Astro / zod / DOM。
   断言：繁/简句读一致；繁体句拼接还原条目声明的全文校验串；
   段号连续、段首标记唯一；每句释义非空；句以句终符收尾。
   报错精确到段/句。 */

export interface PairUnit {
  d: number;
  f?: boolean;
  t: string;
  s: string;
  z: string;
}

export interface SteleEntry {
  id: string;
  status: string;
  units?: PairUnit[];
  fullText?: string;
  sections?: Array<{ id: number; label: string }>;
}

export interface ValidationIssue {
  /** 定位，如「句25（段3）」；条目级问题为「条目」 */
  where: string;
  message: string;
  /** zod path，供内容集合 superRefine 透传 */
  path?: Array<string | number>;
}

/** 句终符（分句在内容生产时确定，逗号不切） */
const SENT_ENDS = '。；？！';

function isSentEnd(ch: string): boolean {
  return SENT_ENDS.includes(ch);
}

function endsWithSentenceMark(text: string): boolean {
  const chars = [...text.trim()];
  return chars.length > 0 && isSentEnd(chars[chars.length - 1]);
}

function sentMarks(text: string): string[] {
  return [...text].filter(isSentEnd);
}

/** 首个差异的码点位（以码点计，不含代理对拆半） */
function firstDiffIndex(a: string, b: string): number {
  const ca = [...a];
  const cb = [...b];
  const n = Math.min(ca.length, cb.length);
  for (let i = 0; i < n; i++) {
    if (ca[i] !== cb[i]) return i;
  }
  return n;
}

function locateUnitByCharIndex(units: PairUnit[], charIndex: number): { unitIndex: number; d: number } | null {
  let acc = 0;
  for (let i = 0; i < units.length; i++) {
    const len = [...units[i].t].length;
    if (charIndex < acc + len) return { unitIndex: i, d: units[i].d };
    acc += len;
  }
  return null;
}

export function validateEntry(entry: SteleEntry): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // planned 条目只显名目，无正文可校
  if (entry.status !== 'published') return issues;

  const units = entry.units ?? [];
  if (units.length === 0) {
    issues.push({ where: '条目', message: 'published 条目缺少 units（句对数组）', path: ['units'] });
    return issues;
  }

  units.forEach((u, i) => {
    const where = `句${i + 1}（段${u.d ?? '?'}）`;
    if (!(u.t ?? '').trim()) {
      issues.push({ where, message: '繁体原文为空', path: ['units', i, 't'] });
    } else if (!endsWithSentenceMark(u.t)) {
      issues.push({ where, message: `繁体句未以句终符（。；？！）收尾，末尾为「${u.t.slice(-6)}」`, path: ['units', i, 't'] });
    }
    if (!(u.s ?? '').trim()) {
      issues.push({ where, message: '简体原文为空', path: ['units', i, 's'] });
    } else if (!endsWithSentenceMark(u.s)) {
      issues.push({ where, message: `简体句未以句终符（。；？！）收尾，末尾为「${u.s.slice(-6)}」`, path: ['units', i, 's'] });
    }
    if (u.t && u.s && sentMarks(u.t).join('') !== sentMarks(u.s).join('')) {
      issues.push({
        where,
        message: `繁/简句读不一致：繁「${sentMarks(u.t).join(' ')}」vs 简「${sentMarks(u.s).join(' ')}」`,
        path: ['units', i, 's'],
      });
    }
    if (!(u.z ?? '').trim()) {
      issues.push({ where, message: '释义为空', path: ['units', i, 'z'] });
    }
  });

  // 段号连续（1 起步、逐级 +1）＋ 段首标记唯一（每段首句恰一个 f）
  let prevSeg = 0;
  units.forEach((u, i) => {
    const where = `句${i + 1}（段${u.d}）`;
    if (u.d === prevSeg) {
      if (u.f) {
        issues.push({ where, message: `段首标记 f 越位：段${u.d} 的非首句不应带 f`, path: ['units', i, 'f'] });
      }
    } else if (u.d === prevSeg + 1) {
      if (!u.f) {
        issues.push({ where, message: `段${u.d} 缺少段首标记 f`, path: ['units', i, 'f'] });
      }
      prevSeg = u.d;
    } else {
      issues.push({
        where,
        message: `段号不连续：期望段${prevSeg + 1}（或延续段${prevSeg}），实际段${u.d}`,
        path: ['units', i, 'd'],
      });
      prevSeg = u.d;
    }
  });

  // 段落表与正文段号对齐
  const sections = entry.sections ?? [];
  const maxSeg = units.reduce((m, u) => Math.max(m, u.d), 0);
  if (sections.length === 0) {
    issues.push({ where: '条目', message: 'published 条目缺少 sections（段落表）', path: ['sections'] });
  } else {
    sections.forEach((s, i) => {
      if (s.id !== i + 1) {
        issues.push({
          where: `段落表第${i + 1}项`,
          message: `段落 id 应为 ${i + 1}，实际 ${s.id}`,
          path: ['sections', i, 'id'],
        });
      }
    });
    if (sections.length !== maxSeg) {
      issues.push({
        where: '条目',
        message: `段落表共 ${sections.length} 段，正文最大段号为 ${maxSeg}`,
        path: ['sections'],
      });
    }
  }

  // 繁体句拼接还原底本全文（与条目声明的校验串比对）
  const joined = units.map((u) => u.t).join('');
  const declared = entry.fullText;
  if (typeof declared !== 'string' || !declared.trim()) {
    issues.push({ where: '条目', message: 'published 条目缺少 fullText（底本全文校验串）', path: ['fullText'] });
  } else if (declared !== joined) {
    const at = firstDiffIndex(joined, declared);
    const loc = locateUnitByCharIndex(units, at);
    issues.push({
      where: loc ? `句${loc.unitIndex + 1}（段${loc.d}）` : '条目',
      message:
        `繁体句拼接与 fullText 不一致：首个差异在第 ${at + 1} 字` +
        (loc ? `（句${loc.unitIndex + 1}附近）` : '') +
        `；拼接共 ${[...joined].length} 字，声明共 ${[...declared].length} 字`,
      path: ['fullText'],
    });
  }

  return issues;
}
