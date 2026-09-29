# 读帖 · Dutiē

碑帖深读静态站——把名碑帖做成"数字集注本"：**一句原文，紧跟一句释义，书本式翻页**，辅助临池读帖。

> 产品名「读帖」，取"读帖"为书法功课之意；本仓库为其全部文档、原型与（即将开始的）实现。

## 当前状态

- [x] 需求共识与规格（[docs/spec.md](docs/spec.md)）
- [x] 四版 UI 原型迭代，定型「句读」方向（v1 原型已被 v2 取代，未入库；迭代记录见 ADR-0002）
- [x] 设计稿 Brief（[docs/design-prompt.md](docs/design-prompt.md)）
- [x] **v2 高保真设计稿定稿入库（[designs/v2/](designs/v2/)，视觉与交互最终基准）**
- [x] 首篇内容《集王圣教序》47 句对核对入库（[content/sheng-jiao-xu.json](content/sheng-jiao-xu.json)）
- [x] **Astro 实现**（按 [tickets.md](tickets.md) 七张工单施工完毕：目录/扉页/阅读/跋四页 + 内容校验 + 分页引擎，38 项测试）
- [ ] Netlify 上线（[netlify.toml](netlify.toml) 已备，连仓库即建）

## 本地开发

```bash
npm install       # 安装依赖
npm run dev       # 本地开发服务器（默认 http://localhost:4321）
npm test          # Vitest：内容校验 + 分页引擎两个纯模块接缝
npm run build     # 构建到 dist/（内容校验随构建强制执行，坏数据构建即失败）
npm run preview   # 预览构建产物
```

## 目录导览

| 路径 | 内容 |
|---|---|
| `docs/spec.md` | 产品规格（问题、用户故事、实现/测试决策、范围） |
| `docs/design-prompt.md` | 设计稿 Prompt（含视觉红线，第三节为验收清单） |
| `docs/decisions/` | 决策记录（ADR）：技术选型、阅读器形态 |
| `designs/v2/` | **v2 高保真设计稿**（视觉与交互最终基准，注意其 README 的内容警告） |
| `content/` | 结构化内容数据（核对版句对 + planned 名目，唯一内容来源） |
| `src/` | Astro 站点：页面、阅读器 Vue island、内容校验与分页引擎 |
| `tickets.md` | 施工工单（拆分与验收记录） |

## 站点结构

- `/` 碑帖目录（按朝代分组，planned 灰置）
- `/{id}/` 扉页（竖排碑名 + 展签元信息）
- `/{id}/read` 阅读页（线装对开｜卷轴双模式；`#pN` 深链、`?mode=book|scroll`）
- `/{id}/colophon` 跋 · 校记

## 技术栈（已定，见 ADR-0001）

- **Astro** 纯静态 + **Vue 3 island**（仅阅读器交互）
- 内容即代码：结构化句对数据随仓库版本化，新增碑帖不改代码
- 部署 **Netlify**（git 推送自动构建）
- 无后端、无账号、无客户端持久化（仅阅读偏好 localStorage 记忆）

## 内容工作流

公有领域底本核对异文 → 自标点分段 → 简体转写 → 逐句释义（AI 起草、人工校订）→ 撰校记 → 结构化句对入库 → 校验通过。
**版权红线**：原文自标点、释义自产，不摘录任何在版权注本——内容随时可公开。
