import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateEntry, type SteleEntry } from './validate';

function makeEntry(overrides: Record<string, unknown> = {}): SteleEntry {
  return {
    id: 'test',
    status: 'published',
    sections: [
      { id: 1, label: '段一' },
      { id: 2, label: '段二' },
    ],
    units: [
      { d: 1, f: true, t: '天 地。', s: '天 地。', z: '天地如此。' },
      { d: 1, t: '日 月。', s: '日 月。', z: '日月如此。' },
      { d: 2, f: true, t: '山 川；风 雨。', s: '山 川；风 雨。', z: '山川风雨如此。' },
    ],
    fullText: '天 地。日 月。山 川；风 雨。',
    ...overrides,
  } as SteleEntry;
}

const msgs = (issues: ReturnType<typeof validateEntry>) => issues.map((i) => `${i.where}：${i.message}`).join('\n');

describe('validateEntry · 合法数据', () => {
  it('结构完整的条目无任何 issue', () => {
    expect(validateEntry(makeEntry())).toEqual([]);
  });

  it('planned 条目（无正文）直接通过', () => {
    expect(validateEntry({ id: 'p', status: 'planned' })).toEqual([]);
  });

  it('真实内容《集王圣教序》47 句对通过校验', () => {
    const raw = JSON.parse(
      readFileSync(new URL('../../content/sheng-jiao-xu.json', import.meta.url), 'utf-8'),
    ) as SteleEntry;
    const issues = validateEntry(raw);
    expect(issues).toEqual([]);
  });
});

describe('validateEntry · 逐句规则', () => {
  it('释义为空被报出并定位到句', () => {
    const entry = makeEntry({ units: makeEntry().units!.map((u, i) => (i === 1 ? { ...u, z: '  ' } : u)) });
    const issues = validateEntry(entry);
    expect(issues).toHaveLength(1);
    expect(issues[0].where).toBe('句2（段1）');
    expect(issues[0].message).toContain('释义为空');
    expect(issues[0].path).toEqual(['units', 1, 'z']);
  });

  it('繁体句未以句终符收尾被报出', () => {
    const entry = makeEntry({ units: makeEntry().units!.map((u, i) => (i === 0 ? { ...u, t: '天 地，' } : u)) });
    const issues = validateEntry(entry);
    expect(issues.some((i) => i.message.includes('繁体句未以句终符'))).toBe(true);
  });

  it('繁/简句读不一致被报出（简体漏了一句）', () => {
    const entry = makeEntry({ units: makeEntry().units!.map((u, i) => (i === 2 ? { ...u, s: '山 川。' } : u)) });
    const issues = validateEntry(entry);
    const hit = issues.find((i) => i.message.includes('繁/简句读不一致'));
    expect(hit).toBeDefined();
    expect(hit!.where).toBe('句3（段2）');
  });

  it('简体原文为空被报出', () => {
    const entry = makeEntry({ units: makeEntry().units!.map((u, i) => (i === 0 ? { ...u, s: '' } : u)) });
    expect(validateEntry(entry).some((i) => i.message.includes('简体原文为空'))).toBe(true);
  });
});

describe('validateEntry · 段落规则', () => {
  it('段号断号（1 → 3）被报出', () => {
    const units = makeEntry().units!;
    units[2].d = 3;
    const issues = validateEntry(makeEntry({ units }));
    const hit = issues.find((i) => i.message.includes('段号不连续'));
    expect(hit).toBeDefined();
    expect(hit!.where).toBe('句3（段3）');
  });

  it('段首缺少 f 标记被报出', () => {
    const units = makeEntry().units!;
    delete (units[2] as { f?: boolean }).f;
    const issues = validateEntry(makeEntry({ units }));
    expect(issues.some((i) => i.message.includes('段2 缺少段首标记'))).toBe(true);
  });

  it('非首句带 f（越位）被报出', () => {
    const units = makeEntry().units!;
    units[1].f = true;
    const issues = validateEntry(makeEntry({ units }));
    expect(issues.some((i) => i.message.includes('越位'))).toBe(true);
  });

  it('首句段号不为 1 被「段号不连续」覆盖', () => {
    const units = makeEntry().units!;
    units[0].d = 2;
    units[1].d = 2;
    units[2].d = 3;
    const issues = validateEntry(makeEntry({ units, sections: [{ id: 1, label: 'a' }, { id: 2, label: 'b' }] }));
    const hit = issues.find((i) => i.message.includes('段号不连续'));
    expect(hit).toBeDefined();
    expect(hit!.where).toBe('句1（段2）');
  });

  it('段落表 id 与序位不符、段数与正文不符被报出', () => {
    const issues = validateEntry(makeEntry({ sections: [{ id: 2, label: 'x' }] }));
    expect(issues.some((i) => i.message.includes('段落 id 应为 1，实际 2'))).toBe(true);
    expect(issues.some((i) => i.message.includes('段落表共 1 段，正文最大段号为 2'))).toBe(true);
  });
});

describe('validateEntry · 全文校验串', () => {
  it('拼接与 fullText 不一致时定位到差异所在句', () => {
    const issues = validateEntry(makeEntry({ fullText: '天 地。日 月。山 川；风 雨。多了' }));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('繁体句拼接与 fullText 不一致');
    expect(issues[0].path).toEqual(['fullText']);
  });

  it('句中改字时报出差异字位与所在句', () => {
    const entry = makeEntry({
      fullText: '天 地。日 月。山 川；風 雨。',
    });
    const issues = validateEntry(entry);
    const hit = issues.find((i) => i.message.includes('繁体句拼接与 fullText 不一致'));
    expect(hit).toBeDefined();
    expect(hit!.where).toBe('句3（段2）');
    expect(hit!.message).toContain('第 13 字');
  });

  it('缺少 fullText 被报出', () => {
    const issues = validateEntry(makeEntry({ fullText: undefined }));
    expect(issues.some((i) => i.message.includes('缺少 fullText'))).toBe(true);
  });

  it('units 为空时条目级报错且不再逐句检查', () => {
    const issues = validateEntry(makeEntry({ units: [] }));
    expect(issues).toHaveLength(1);
    expect(issues[0].where).toBe('条目');
    expect(issues[0].message).toContain('缺少 units');
  });
});

describe('validateEntry · 报错可读性', () => {
  it('报错信息拼装为「定位：描述」', () => {
    const entry = makeEntry({ fullText: '不匹配' });
    const issues = validateEntry(entry);
    expect(msgs(issues)).toMatch(/条目|句\d+/);
  });
});
