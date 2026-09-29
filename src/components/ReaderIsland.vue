<!-- 阅读页 island（designs/v2/read.html 定稿移植）：
     T4 范围 = 线装竖排核心：对开/版心/字级装箱入界格/槽位补格/四种翻页/汉字页码/#pN/繁简切换。
     装箱全部走 src/lib/pagination.ts 纯函数引擎，island 只负责度量与渲染。 -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  columnWidth,
  findLeafOfSeg,
  leafFirstSeg,
  packColumns,
  packLeaves,
  packRows,
  pairOpenings,
  type Column,
  type Leaf,
  type Metrics,
  type Opening,
} from '../lib/pagination';
import type { PairUnit } from '../lib/validate';
import { toCN } from '../lib/cn-num';

export interface ReaderEntry {
  id: string;
  title: string;
  sections: Array<{ id: number; label: string }>;
  units: PairUnit[];
}

const props = defineProps<{ entry: ReaderEntry }>();

/* v2 定稿字号常量（線裝／卷軸共用，勿分叉） */
const SIZE = {
  origDefault: 42,
  origMin: 36,
  origMax: 52,
  glossMin: 15,
  glossRatio: 0.42,
  colRatio: 68 / 42,
};

const units = props.entry.units;

const trad = ref(true);
const vertical = ref(true);
const origSize = ref(SIZE.origDefault);
const leaves = ref<Leaf[]>([[]]);
const openings = ref<Opening[]>([{ right: 0, left: null }]);
const opening = ref(0);

const bookEl = ref<HTMLElement | null>(null);
const rightFrame = ref<HTMLElement | null>(null);

const colW = () => Math.round(origSize.value * SIZE.colRatio);
const glossSize = () => Math.max(SIZE.glossMin, Math.round(origSize.value * SIZE.glossRatio));
const glossStep = () => glossSize() * 1.55;

const cur = computed(() => openings.value[opening.value] ?? { right: 0, left: null });
const rightCols = computed<Leaf>(() => leaves.value[cur.value.right] ?? []);
const leftCols = computed<Leaf>(() => (cur.value.left != null ? leaves.value[cur.value.left] : undefined) ?? []);
const hasPrev = computed(() => opening.value > 0);
const hasNext = computed(() => opening.value < openings.value.length - 1);

const pageLabel = computed(() => {
  const total = openings.value.length;
  const r = cur.value.right + 1;
  const l = cur.value.left != null ? cur.value.left + 1 : null;
  const range = l != null ? `${toCN(r)}～${toCN(l)}` : toCN(r);
  return `${toCN(opening.value + 1)}／${toCN(total)}開 · ${range}／${toCN(leaves.value.length)}葉`;
});

const banxinYe = computed(() => {
  const r = cur.value.right + 1;
  const l = cur.value.left != null ? cur.value.left + 1 : null;
  return l != null ? { r: toCN(r), l: toCN(l) } : { r: toCN(r), l: null };
});

const banxinSeg = computed(() => {
  const seg = leafFirstSeg(leaves.value[cur.value.right]);
  return seg != null ? `段${toCN(seg)}` : '　';
});

const titleShort = computed(() => props.entry.title.slice(-3));

function applySizes() {
  const root = document.documentElement;
  root.style.setProperty('--orig-size', origSize.value + 'px');
  root.style.setProperty('--col-w', colW() + 'px');
  root.style.setProperty('--gloss-size', glossSize() + 'px');
  root.style.setProperty('--gloss-col-w', Math.round(glossSize() * 1.55) + 'px');
}

function measureLeafBox(): { w: number; h: number } {
  const r = (rightFrame.value ?? bookEl.value)?.getBoundingClientRect();
  const width = r?.width ?? 0;
  const height = r?.height ?? 0;
  return { w: Math.max(width - 14, 240), h: Math.max(height - 8, 360) };
}

function currentMetrics(): Metrics {
  const box = measureLeafBox();
  return {
    colH: Math.max(120, box.h - 56),
    leafW: box.w,
    origSize: origSize.value,
    colW: colW(),
    glossSize: glossSize(),
    glossColW: Math.round(glossSize() * 1.55),
    glossStep: glossStep(),
    glossPad: 24,
  };
}

/** 重分页；keepSeg 给定时定位到该段首句所在开（保持阅读位置） */
function repaginate(keepSeg?: number | null) {
  const m = currentMetrics();
  const next =
    vertical.value
      ? packLeaves(packColumns(units, m, { trad: trad.value }), m)
      : packRows(units, m, { trad: trad.value });
  openings.value = pairOpenings(next);
  if (keepSeg != null) {
    const li = findLeafOfSeg(next, keepSeg);
    if (li >= 0) {
      const oi = openings.value.findIndex((o) => o.right === li || o.left === li);
      if (oi >= 0) opening.value = oi;
    }
  } else {
    opening.value = Math.min(opening.value, openings.value.length - 1);
  }
  leaves.value = next;
}

/** 界格通栏、字不满格留白：空余栏位以隐藏槽位补齐 */
function slotCount(leaf: Leaf): number {
  if (!vertical.value) return 0;
  const m = currentMetrics();
  const usedW = leaf.reduce((s, c) => s + columnWidth(c, m), 0);
  const slotW = colW() + 1;
  let n = 0;
  while (usedW + slotW * (n + 1) <= m.leafW + 0.5) n++;
  return n;
}

function glossHeight(col: Column): number {
  return col.kind === 'gloss' ? Math.ceil([...col.text].length * glossStep()) : 0;
}

function syncColHeights() {
  if (!vertical.value) return;
  bookEl.value?.querySelectorAll<HTMLElement>('.page-flow').forEach((flow) => {
    const maxH = flow.clientHeight || 600;
    flow.querySelectorAll<HTMLElement>('.pair').forEach((pair) => {
      pair.style.height = maxH + 'px';
    });
  });
}

function repaint() {
  nextTick(() => requestAnimationFrame(() => syncColHeights()));
}

function go(delta: number) {
  const next = opening.value + delta;
  if (next < 0 || next >= openings.value.length) return;
  opening.value = next;
  repaint();
}

function keepSegOfCurrent(): number | null {
  return leafFirstSeg(leaves.value[cur.value.right]);
}

function rebuild(keepSeg = true) {
  applySizes();
  repaginate(keepSeg ? keepSegOfCurrent() : null);
  repaint();
}

/* —— #pN 深链 —— */
function parseHash(): number | null {
  const m = /^#p(\d+)$/.exec(location.hash);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

function syncHash() {
  const url = new URL(location.href);
  url.hash = `#p${opening.value + 1}`;
  history.replaceState(null, '', url);
}

/* —— 键盘 / 滚轮 —— */
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowRight') {
    e.preventDefault();
    go(1);
  }
  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    go(-1);
  }
}

let wheelLock = 0;
function onWheel(e: WheelEvent) {
  const now = Date.now();
  if (now - wheelLock < 500) return;
  if (Math.abs(e.deltaY) < 20 && Math.abs(e.deltaX) < 20) return;
  wheelLock = now;
  go(e.deltaY > 0 || e.deltaX > 0 ? 1 : -1);
}

let resizeTimer: ReturnType<typeof setTimeout> | undefined;
function onResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => rebuild(true), 180);
}

function setTrad(v: boolean) {
  if (trad.value === v) return;
  trad.value = v;
  rebuild(true);
}

onMounted(() => {
  applySizes();
  const p = parseHash();
  repaginate(null);
  if (p != null) opening.value = Math.min(Math.max(p - 1, 0), openings.value.length - 1);
  repaint();
  document.addEventListener('keydown', onKeydown);
  window.addEventListener('resize', onResize);
});

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown);
  window.removeEventListener('resize', onResize);
  clearTimeout(resizeTimer);
});

watch(opening, syncHash);
</script>

<template>
  <div class="reader-root">
    <header class="topbar">
      <a class="seal double" href="/">讀帖</a>
      <span class="meta">{{ entry.title }} · 刻本夾注 · 往右翻</span>
      <div class="tools">
        <button type="button" :class="{ active: trad }" title="繁體原文" @click="setTrad(true)">繁</button>
        <button type="button" :class="{ active: !trad }" title="簡體原文" @click="setTrad(false)">簡</button>
        <a class="tool-btn" :href="`/${entry.id}/`">扉</a>
        <a class="tool-btn" :href="`/${entry.id}/colophon`">跋</a>
      </div>
    </header>

    <div class="stage stage-book">
      <div ref="bookEl" class="book" @wheel.passive="onWheel">
        <div class="opening">
          <div class="leaf leaf-left">
            <div class="leaf-pad">
              <div class="text-frame frame">
                <div class="page-flow">
                  <article
                    v-for="(col, i) in leftCols"
                    :key="i"
                    :class="['pair', col.kind === 'gloss' ? 'is-gloss' : '']"
                    :data-seg="col.seg"
                  >
                    <div class="col">
                      <span v-if="col.kind === 'gloss'" class="jz-col" :style="{ height: glossHeight(col) + 'px' }">{{ col.text }}</span>
                      <template v-else>
                        <span v-for="(u, j) in col.units" :key="j" :class="['ch', u.punct ? 'punct' : '']">
                          <i v-if="u.segMark" class="seg-dot" aria-hidden="true"></i>{{ u.ch }}
                        </span>
                      </template>
                    </div>
                  </article>
                  <article v-for="s in slotCount(leftCols)" :key="'s' + s" class="pair slot" aria-hidden="true">
                    <div class="col"></div>
                  </article>
                </div>
              </div>
            </div>
          </div>

          <aside class="banxin" aria-label="版心書口">
            <div class="banxin-inner">
              <span class="yuwai" title="上魚尾"><span class="yuwai-mark">︻</span></span>
              <span class="title-short">{{ titleShort }}</span>
              <span class="juan">{{ banxinSeg }}</span>
              <span class="ye-code">
                {{ banxinYe.r }}<span v-if="banxinYe.l" class="sep">｜</span>{{ banxinYe.l ?? '' }}
              </span>
              <span class="yuwai yuwai-bot" title="下魚尾"><span class="yuwai-mark">︻</span></span>
            </div>
          </aside>

          <div class="leaf leaf-right">
            <div class="leaf-pad">
              <div ref="rightFrame" class="text-frame frame">
                <div class="page-flow">
                  <article
                    v-for="(col, i) in rightCols"
                    :key="i"
                    :class="['pair', col.kind === 'gloss' ? 'is-gloss' : '']"
                    :data-seg="col.seg"
                  >
                    <div class="col">
                      <span v-if="col.kind === 'gloss'" class="jz-col" :style="{ height: glossHeight(col) + 'px' }">{{ col.text }}</span>
                      <template v-else>
                        <span v-for="(u, j) in col.units" :key="j" :class="['ch', u.punct ? 'punct' : '']">
                          <i v-if="u.segMark" class="seg-dot" aria-hidden="true"></i>{{ u.ch }}
                        </span>
                      </template>
                    </div>
                  </article>
                  <article v-for="s in slotCount(rightCols)" :key="'s' + s" class="pair slot" aria-hidden="true">
                    <div class="col"></div>
                  </article>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div v-show="hasPrev" class="corner left" title="前一開" @click="go(-1)"><span class="hint">← 前一開</span></div>
        <div v-show="hasNext" class="corner right" title="後一開" @click="go(1)"><span class="hint">後一開 →</span></div>
      </div>
    </div>

    <footer class="pager">
      <button type="button" :disabled="!hasPrev" @click="go(-1)">前開</button>
      <span class="num">{{ pageLabel }}</span>
      <button type="button" :disabled="!hasNext" @click="go(1)">後開</button>
    </footer>
  </div>
</template>

<style>
/* 读帖 · 阅读页（designs/v2/read.html 线装部分移植；本组件仅在阅读页加载，非 scoped 以覆盖 body 态） */
.reader-root {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--env-floor);
  color: var(--ink);
}
.reader-root .topbar { flex-shrink: 0; }

.stage {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 8px 12px 0;
  background:
    radial-gradient(ellipse at 50% 40%, #3A3A3A 0%, transparent 55%),
    linear-gradient(180deg, var(--env-mid) 0%, var(--env-floor) 100%);
}
.reader-root .pager { flex-shrink: 0; }

/* ========== 线装 ========== */
.book {
  width: min(1720px, 96vw);
  height: min(920px, 88vh);
  min-width: min(720px, 96vw);
  position: relative;
  display: flex;
  flex-direction: row;
  align-items: stretch;
  background: transparent;
  overflow: visible;
  perspective: 2400px;
  perspective-origin: 50% 50%;
}
.book::before {
  content: "";
  position: absolute;
  inset: 4px -2px -6px;
  background: rgba(0, 0, 0, 0.35);
  z-index: -1;
  pointer-events: none;
  filter: blur(2px);
}
.opening {
  flex: 1;
  display: flex;
  min-height: 0;
  min-width: 0;
  position: relative;
  transform-style: preserve-3d;
}
.leaf {
  flex: 1 1 50%;
  min-width: 0;
  position: relative;
  background-color: var(--paper);
  background-image:
    radial-gradient(ellipse at 18% 22%, rgba(70, 50, 30, 0.035) 0%, transparent 42%),
    radial-gradient(ellipse at 78% 68%, rgba(50, 40, 25, 0.03) 0%, transparent 48%);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.leaf-pad {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 52px 42px 30px;
}
.leaf-left .leaf-pad { padding-left: 44px; padding-right: 28px; }
.leaf-right .leaf-pad { padding-right: 44px; padding-left: 28px; }
.text-frame {
  flex: 1;
  min-height: 0;
  position: relative;
  background: var(--paper);
  overflow: hidden;
  padding: 4px 8px 12px;
  box-sizing: border-box;
}
.leaf-right { box-shadow: inset -1px 0 0 rgba(34, 26, 18, 0.12); }
.leaf-left { box-shadow: inset 1px 0 0 rgba(34, 26, 18, 0.08); }

/* 版心书口 */
.banxin {
  flex: 0 0 46px;
  position: relative;
  background-color: var(--paper);
  background-image:
    radial-gradient(ellipse at 50% 40%, rgba(70, 50, 30, 0.03) 0%, transparent 60%);
  border-left: 1px solid rgba(34, 26, 18, 0.45);
  border-right: 1px solid rgba(34, 26, 18, 0.45);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  padding: 52px 0 30px;
  z-index: 5;
}
.banxin-inner {
  writing-mode: vertical-rl;
  text-orientation: mixed;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  height: 100%;
  font-family: var(--songti);
  color: var(--ink);
}
.banxin .title-short {
  font-family: var(--kaiti);
  font-size: 13px;
  letter-spacing: 0.32em;
}
.banxin .juan {
  font-size: 11px;
  letter-spacing: 0.22em;
  color: var(--muted);
}
.yuwai {
  writing-mode: horizontal-tb;
  width: 22px;
  height: 20px;
  position: relative;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ink);
  opacity: 0.78;
}
.yuwai .yuwai-mark {
  font-family: "Songti SC", "SimSun", "Noto Serif CJK TC", serif;
  font-size: 17px;
  line-height: 1;
  font-weight: 700;
  letter-spacing: 0;
}
.yuwai.yuwai-bot .yuwai-mark { transform: rotate(180deg); }
.banxin .ye-code {
  font-size: 12px;
  letter-spacing: 0.15em;
  color: var(--zhu);
  margin-top: auto;
}
.banxin .ye-code .sep { opacity: 0.45; margin: 0 0.12em; }

/* 界行 / 字格 */
.page-flow {
  position: relative;
  z-index: 1;
  height: 100%;
  width: 100%;
  display: flex;
  flex-direction: row-reverse;
  align-items: stretch;
  justify-content: flex-start;
  gap: 0;
  overflow: hidden;
  padding: 0;
  box-sizing: border-box;
  border-right: 1px solid var(--grid);
}
.pair {
  position: relative;
  box-sizing: content-box;
  flex: 0 0 var(--col-w);
  width: var(--col-w);
  min-width: var(--col-w);
  max-width: var(--col-w);
  height: 100%;
  border-left: 1px solid var(--grid);
  border-right: none;
  margin: 0;
  padding: 0;
}
.pair.slot .col { visibility: hidden; }
.col {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  overflow: hidden;
  padding: 8px 0 20px;
  margin: 0;
}
.ch {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  width: var(--col-w);
  height: var(--orig-size);
  margin: 0;
  padding: 0;
  flex-shrink: 0;
  font-family: var(--kaiti);
  font-size: var(--orig-size);
  line-height: 1;
  color: var(--ink);
  border: none;
}
.ch.punct { font-size: calc(var(--orig-size) * 0.82); }
.ch .seg-dot {
  position: absolute;
  top: 4px;
  right: 5px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--zhu);
  pointer-events: none;
  z-index: 2;
}
.pair.is-gloss {
  flex-basis: var(--gloss-col-w);
  width: var(--gloss-col-w);
  min-width: var(--gloss-col-w);
  max-width: var(--gloss-col-w);
}
.pair.is-gloss .col {
  padding: 8px 0 22px;
  justify-content: flex-start;
  overflow: visible;
}
.jz-col {
  display: block;
  box-sizing: border-box;
  width: 100%;
  height: auto;
  max-height: none;
  margin: 0;
  padding: 0;
  overflow: visible;
  writing-mode: vertical-rl;
  text-orientation: upright;
  font-family: var(--songti);
  font-size: var(--gloss-size);
  line-height: 1.35;
  letter-spacing: 0.04em;
  color: var(--gloss);
  white-space: nowrap;
}
.jz-inline {
  display: inline;
  font-family: var(--songti);
  font-size: calc(var(--orig-size) * 0.42);
  color: var(--gloss);
  margin-left: 0.35em;
  letter-spacing: 0.04em;
}

/* 页角翻页提示 */
.corner {
  position: absolute;
  bottom: 0;
  width: 76px;
  height: 76px;
  z-index: 40;
  cursor: pointer;
}
.corner.left { left: 0; }
.corner.right { right: 0; }
.corner .hint {
  position: absolute;
  bottom: 14px;
  padding: 6px 10px;
  background: var(--zhu);
  color: #F8F3E4;
  font-size: 11px;
  letter-spacing: 0.2em;
  font-family: var(--hei);
  opacity: 0;
  transform: translateY(6px);
  transition: opacity 0.18s ease, transform 0.18s ease;
  pointer-events: none;
  white-space: nowrap;
}
.corner.left .hint { left: 14px; }
.corner.right .hint { right: 14px; }
.corner:hover .hint,
.corner.show .hint { opacity: 1; transform: translateY(0); }
.corner::after {
  content: "";
  position: absolute;
  bottom: 0;
  width: 0;
  height: 0;
  border-style: solid;
  opacity: 0;
  transition: opacity 0.18s;
}
.corner.left::after {
  left: 0;
  border-width: 0 0 18px 18px;
  border-color: transparent transparent rgba(156, 42, 32, 0.35) transparent;
}
.corner.right::after {
  right: 0;
  border-width: 0 18px 18px 0;
  border-color: transparent rgba(156, 42, 32, 0.35) transparent transparent;
}
.corner:hover::after { opacity: 1; }

@media (max-width: 960px) {
  .book { width: 96vw; height: 82vh; flex-direction: column-reverse; perspective: none; }
  .banxin {
    flex: 0 0 34px;
    flex-direction: row;
    padding: 0 12px;
    border-left: none;
    border-right: none;
    border-top: 1px solid rgba(46, 36, 24, 0.35);
    border-bottom: 1px solid rgba(46, 36, 24, 0.35);
  }
  .banxin-inner { writing-mode: horizontal-tb; flex-direction: row; height: auto; gap: 10px; }
}
</style>
