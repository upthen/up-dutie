import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
import { validateEntry } from './lib/validate';

/* 内容即代码：仓库根 content/ 是唯一内容来源（README 目录导览约定），
   新增碑帖 = 加一个 JSON，不改代码。base 须传 file URL（Windows 绝对路径字符串会被误判 scheme）。 */
const contentDir = new URL('../content', import.meta.url);

const unitSchema = z.object({
  d: z.number().int().min(1),
  f: z.boolean().optional(),
  t: z.string().min(1),
  s: z.string().min(1),
  z: z.string().min(1),
});

const entrySchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    category: z.enum(['stele', 'treatise']),
    status: z.enum(['published', 'planned']),
    title: z.string().min(1),
    alias: z.string().optional(),
    dynasty: z.string().min(1),
    /** 目录页分组名（如「秦 · 漢」跨朝代合组），缺省用 dynasty */
    group: z.string().optional(),
    year: z.string().min(1),
    author: z.string(),
    calligrapher: z.string(),
    script: z.string(),
    stone: z.string().optional(),
    sections: z.array(z.object({ id: z.number().int(), label: z.string() })).optional(),
    colophon: z.string().optional(),
    source: z.string().optional(),
    /** 底本全文校验串：繁体句拼接必须与之全等 */
    fullText: z.string().optional(),
    units: z.array(unitSchema).optional(),
    /** 目录页排序 */
    listOrder: z.number().int().min(1),
  })
  .superRefine((entry, ctx) => {
    if (entry.status === 'published') {
      for (const field of ['units', 'fullText', 'sections', 'colophon'] as const) {
        if (!entry[field]) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `published 条目必须提供 ${field}` });
        }
      }
    }
    if (entry.status === 'published' && entry.units) {
      for (const issue of validateEntry(entry)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: issue.path ?? [],
          message: `${issue.where}：${issue.message}`,
        });
      }
    }
  });

const steles = defineCollection({
  loader: glob({ pattern: '*.json', base: contentDir }),
  schema: entrySchema,
});

export const collections = { steles };
