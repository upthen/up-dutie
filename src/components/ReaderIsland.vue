<!-- 阅读页 island（designs/v2/read.html 定稿移植）：
     线装对开（版心书口 + 3D 翻页）｜卷轴（裱绢手卷）顶栏切换（?mode= 优先，localStorage 记忆）；
     字级装箱入界格 + 槽位补格 + 四种翻页 + 汉字页码「开/叶」双计 + #pN 深链
     + 繁简/竖横/字号切换 + 段跳转。
     装箱全部走 src/lib/pagination.ts 纯函数引擎，island 只负责度量与渲染。
     列内容以 v-html 生成：数据来自入库校验后的自家内容（受信），并供翻页动画面页复用同一渲染。 -->
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
const FLIP_MS = 850;
const LS = {
  mode: 'dutie-reader-mode',
  trad: 'dutie-reader-trad',
  size: 'dutie-reader-origSize',
};

const units = props.entry.units;

const mode = ref<'book' | 'scroll'>('book');
const trad = ref(true);
const vertical = ref(true);
const origSize = ref(SIZE.origDefault);
const leaves = ref<Leaf[]>([[]]);
const openings = ref<Opening[]>([{ right: 0, left: null }]);
const opening = ref(0);
const animating = ref(false);
const trackHTML = ref('');

/** 3D 翻页瞬时态：front=翻动叶正面（当前），back=背面（下一开的对应叶） */
const flip = ref<null | { delta: number; front: number | null; back: number | null }>(null);

const bookEl = ref<HTMLElement | null>(null);
const rightFrame = ref<HTMLElement | null>(null);
const flipSheetEl = ref<HTMLElement | null>(null);
const shadeFwdEl = ref<HTMLElement | null>(null);
const shadeBakEl = ref<HTMLElement | null>(null);
const leafLeftEl = ref<HTMLElement | null>(null);
const leafRightEl = ref<HTMLElement | null>(null);
const viewportEl = ref<HTMLElement | null>(null);
const paperPadEl = ref<HTMLElement | null>(null);

const colW = () => Math.round(origSize.value * SIZE.colRatio);
const glossSize = () => Math.max(SIZE.glossMin, Math.round(origSize.value * SIZE.glossRatio));
const glossStep = () => glossSize() * 1.55;

const cur = computed(() => openings.value[opening.value] ?? { right: 0, left: null });
const hasPrev = computed(() => opening.value > 0);
const hasNext = computed(() => opening.value < openings.value.length - 1);
const activeSeg = computed(() => leafFirstSeg(leaves.value[cur.value.right]));
/** 版心短名：四字内用全名；「×三帖」去后缀（孔侍中三帖→孔侍中）；
    「×帖」去帖字后四字内用之（快雪時晴帖→快雪時晴）；其余取末三字（集王聖教序→聖教序） */
const titleShort = computed(() => {
  const t = props.entry.title;
  const n = [...t].length;
  if (n <= 4) return t;
  if (t.endsWith('三帖')) return t.slice(0, -2);
  if (t.endsWith('帖') && [...t.slice(0, -1)].length <= 4) return t.slice(0, -1);
  return t.slice(-3);
});
const topMeta = computed(() =>
  mode.value === 'book' ? `${props.entry.title} · 刻本夾注 · 往右翻` : `${props.entry.title} · 中古卷軸`,
);

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
  return { r: toCN(r), l: l != null ? toCN(l) : null };
});

const banxinSeg = computed(() => {
  const seg = activeSeg.value;
  return seg != null ? `段${toCN(seg)}` : '　';
});

/* —— 偏好记忆：URL ?mode= 优先，其次 localStorage —— */
function loadPrefs(): { mode: 'book' | 'scroll'; trad: boolean; origSize: number } {
  const q = new URLSearchParams(location.search);
  let m = q.get('mode');
  if (m !== 'book' && m !== 'scroll') {
    try {
      m = localStorage.getItem(LS.mode) ?? undefined;
    } catch {
      m = undefined;
    }
  }
  if (m !== 'book' && m !== 'scroll') m = 'book';
  let t = true;
  try {
    if (localStorage.getItem(LS.trad) === '0') t = false;
  } catch {
    /* 隐私模式等场景静默降级 */
  }
  let s = SIZE.origDefault;
  try {
    const v = parseInt(localStorage.getItem(LS.size) ?? '', 10);
    if (v >= SIZE.origMin && v <= SIZE.origMax) s = v;
  } catch {
    /* 同上 */
  }
  return { mode: m, trad: t, origSize: s };
}

function savePrefs() {
  try {
    localStorage.setItem(LS.mode, mode.value);
    localStorage.setItem(LS.trad, trad.value ? '1' : '0');
    localStorage.setItem(LS.size, String(origSize.value));
  } catch {
    /* 静默降级 */
  }
}

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

/** 卷轴纸心可用列高（纸心上下天地头） */
function scrollMetrics(): Metrics {
  const pad = paperPadEl.value;
  let colH = 560;
  if (pad) {
    const cs = getComputedStyle(pad);
    const inner = pad.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
    colH = Math.max(160, Math.floor(inner - 56));
  }
  return {
    colH,
    leafW: Number.POSITIVE_INFINITY,
    origSize: origSize.value,
    colW: colW(),
    glossSize: glossSize(),
    glossColW: Math.round(glossSize() * 1.55),
    glossStep: glossStep(),
    glossPad: 24,
  };
}

/* —— 度量自愈：初次分页若发生在面板尺寸/样式未稳时（刷新即乱、开 F12 才恢复的根源），
      就绪信号到达后若度量与分页时不一致则重分页；一致则零开销 —— */
let paginatedKey = '';

function measuredKey(): string {
  if (mode.value === 'book') {
    const b = measureLeafBox();
    return `b${Math.round(b.w)}x${Math.round(b.h)}`;
  }
  return `s${Math.round(scrollMetrics().colH)}`;
}

function rebuildIfChanged() {
  if (measuredKey() === paginatedKey) return;
  rebuild(true);
}

/** 重分页；keepSeg 给定时定位到该段首句所在开（保持阅读位置） */
function repaginate(keepSeg?: number | null) {
  const m = currentMetrics();
  const next = vertical.value
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
  paginatedKey = measuredKey();
}

/* —— 界行渲染（书叶、卷轴、翻页面页共用） —— */
function colHTML(col: Column): string {
  const segAttr = col.seg != null ? ` data-seg="${col.seg}"` : '';
  if (col.kind === 'gloss') {
    const h = Math.ceil([...col.text].length * glossStep());
    return `<article class="pair is-gloss"${segAttr}><div class="col"><span class="jz-col" style="height:${h}px">${col.text}</span></div></article>`;
  }
  const chars = col.units
    .map((u) => {
      const mark = u.segMark ? '<i class="seg-dot" aria-hidden="true"></i>' : '';
      return `<span class="ch${u.punct ? ' punct' : ''}">${mark}${u.ch}</span>`;
    })
    .join('');
  const gloss = col.kind === 'row' ? `<span class="jz-inline">${col.gloss}</span>` : '';
  return `<article class="pair"${segAttr}><div class="col">${chars}${gloss}</div></article>`;
}

/** 界格通栏、字不满格留白：空余栏位以隐藏槽位补齐 */
function leafHTML(leafIdx: number | null): string {
  const leaf = leafIdx == null ? [] : leaves.value[leafIdx] ?? [];
  const m = currentMetrics();
  let html = '';
  let usedW = 0;
  for (const col of leaf) {
    html += colHTML(col);
    usedW += columnWidth(col, m);
  }
  if (vertical.value) {
    const slotW = colW() + 1;
    while (usedW + slotW <= m.leafW + 0.5) {
      html += '<article class="pair slot" aria-hidden="true"><div class="col"></div></article>';
      usedW += slotW;
    }
  }
  return html;
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

/* —— 卷轴 —— */
async function paintScroll(keepRatio: boolean) {
  const vp = viewportEl.value;
  if (!vp) return;
  let ratio = 0;
  if (keepRatio && vp.scrollWidth > vp.clientWidth) {
    ratio = vp.scrollLeft / (vp.scrollWidth - vp.clientWidth || 1);
  }
  trackHTML.value = packColumns(units, scrollMetrics(), { trad: trad.value }).map(colHTML).join('');
  paginatedKey = measuredKey();
  await nextTick();
  requestAnimationFrame(() => {
    if (!keepRatio) {
      vp.scrollLeft = 0;
    } else {
      const max = vp.scrollWidth - vp.clientWidth;
      if (max > 0) vp.scrollLeft = ratio * max;
    }
  });
}

function rollBy(dx: number) {
  viewportEl.value?.scrollBy({ left: dx, behavior: 'smooth' });
}

function onViewportWheel(e: WheelEvent) {
  if (mode.value !== 'scroll') return;
  if (Math.abs(e.deltaY) >= Math.abs(e.deltaX) && Math.abs(e.deltaY) > 2) {
    e.preventDefault();
    /* rtl 视口 scrollLeft 为负向（0=右端起首），滚轮向下=向后读 */
    if (viewportEl.value) viewportEl.value.scrollLeft -= e.deltaY;
  }
}

let dragging = false;
let dragStartX = 0;
let dragStartScroll = 0;
function onDragDown(e: PointerEvent) {
  if (mode.value !== 'scroll' || e.button !== 0) return;
  dragging = true;
  dragStartX = e.clientX;
  dragStartScroll = viewportEl.value?.scrollLeft ?? 0;
  viewportEl.value?.classList.add('is-dragging');
  viewportEl.value?.setPointerCapture(e.pointerId);
}
function onDragMove(e: PointerEvent) {
  if (!dragging || !viewportEl.value) return;
  /* rtl 视口：向左拖曳露出后方内容 = scrollLeft 变负 */
  viewportEl.value.scrollLeft = dragStartScroll - (dragStartX - e.clientX);
}
function onDragEnd() {
  dragging = false;
  viewportEl.value?.classList.remove('is-dragging');
}

/* —— 3D 翻页（窄屏/横排降级为直接切换） —— */
async function runFlip(delta: number, next: number) {
  const curOp = openings.value[opening.value];
  const nextOp = openings.value[next];
  flip.value = {
    delta,
    front: delta > 0 ? curOp.left : curOp.right,
    back: delta > 0 ? nextOp.right : nextOp.left,
  };
  await nextTick();
  await new Promise<void>((resolve) => {
    const sheet = flipSheetEl.value;
    const shade = delta > 0 ? shadeFwdEl.value : shadeBakEl.value;
    if (!sheet) {
      flip.value = null;
      resolve();
      return;
    }
    shade?.classList.add('on');
    if (delta > 0) leafLeftEl.value && (leafLeftEl.value.style.visibility = 'hidden');
    else leafRightEl.value && (leafRightEl.value.style.visibility = 'hidden');
    syncColHeights();
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      opening.value = next;
      flip.value = null;
      if (leafLeftEl.value) leafLeftEl.value.style.visibility = '';
      if (leafRightEl.value) leafRightEl.value.style.visibility = '';
      shade?.classList.remove('on');
      repaint();
      resolve();
    };
    const to = delta > 0 ? 'rotateY(165deg)' : 'rotateY(-165deg)';
    const anim = sheet.animate(
      [{ transform: 'rotateY(0deg)' }, { transform: to }],
      { duration: FLIP_MS, easing: 'cubic-bezier(0.4, 0.05, 0.2, 1)', fill: 'forwards' },
    );
    anim.onfinish = done;
    setTimeout(done, FLIP_MS + 120);
  });
}

async function go(delta: number) {
  if (animating.value || mode.value !== 'book') return;
  const next = opening.value + delta;
  if (next < 0 || next >= openings.value.length) return;
  const narrow = window.matchMedia('(max-width: 960px)').matches;
  if (narrow || !vertical.value) {
    opening.value = next;
    repaint();
    return;
  }
  animating.value = true;
  try {
    await runFlip(delta, next);
  } finally {
    animating.value = false;
  }
}

function keepSegOfCurrent(): number | null {
  return leafFirstSeg(leaves.value[cur.value.right]);
}

function rebuild(keepSeg = true) {
  applySizes();
  savePrefs();
  if (mode.value === 'book') {
    repaginate(keepSeg ? keepSegOfCurrent() : null);
    repaint();
  } else {
    paintScroll(true);
  }
}

/* —— 控件 —— */
async function setMode(m: 'book' | 'scroll', pushUrl = true) {
  if (mode.value === m) return;
  mode.value = m;
  savePrefs();
  if (pushUrl) {
    const url = new URL(location.href);
    url.searchParams.set('mode', m);
    history.replaceState(null, '', url);
  }
  applySizes();
  /* nextTick（微任务）等 Vue 应用 mode 类后再度量：
     不用 requestAnimationFrame——后台标签页会被节流，切换回来量不到 */
  await nextTick();
  if (m === 'book') {
    repaginate(keepSegOfCurrent());
    repaint();
  } else {
    paintScroll(false);
  }
}

function setTrad(v: boolean) {
  if (trad.value === v) return;
  trad.value = v;
  rebuild(true);
}

function setVertical(v: boolean) {
  if (vertical.value === v) return;
  vertical.value = v;
  rebuild(true);
}

function stepSize(d: number) {
  const v = Math.min(SIZE.origMax, Math.max(SIZE.origMin, origSize.value + d));
  if (v === origSize.value) return;
  origSize.value = v;
  rebuild(true);
}

function jumpToSeg(seg: number) {
  const li = findLeafOfSeg(leaves.value, seg);
  if (li < 0) return;
  const oi = openings.value.findIndex((o) => o.right === li || o.left === li);
  if (oi >= 0) {
    opening.value = oi;
    repaint();
  }
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
  if (mode.value === 'book') {
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      go(1);
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      go(-1);
    }
  } else {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      rollBy(-220);
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      rollBy(220);
    }
  }
}

let wheelLock = 0;
function onBookWheel(e: WheelEvent) {
  if (mode.value !== 'book') return;
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

/* 就绪自愈回调（load/字体/延时/可见性/ResizeObserver 多信号复用，幂等） */
function onSettle() {
  repaint();
  rebuildIfChanged();
}

onMounted(() => {
  const prefs = loadPrefs();
  mode.value = prefs.mode;
  trad.value = prefs.trad;
  origSize.value = prefs.origSize;
  applySizes();
  savePrefs();
  const url = new URL(location.href);
  url.searchParams.set('mode', mode.value);
  history.replaceState(null, '', url);

  const p = parseHash();
  if (mode.value === 'book') {
    repaginate(null);
    if (p != null) opening.value = Math.min(Math.max(p - 1, 0), openings.value.length - 1);
    repaint();
  } else {
    paintScroll(false);
  }

  document.addEventListener('keydown', onKeydown);
  window.addEventListener('resize', onResize);
  viewportEl.value?.addEventListener('wheel', onViewportWheel, { passive: false });

  /* 样式/字体/面板尺寸稳定后校正初次分页（多个信号兜底） */
  if (document.readyState === 'complete') setTimeout(onSettle, 60);
  else window.addEventListener('load', onSettle, { once: true });
  document.fonts?.ready?.then(onSettle).catch(() => {});
  setTimeout(onSettle, 400);
  setTimeout(onSettle, 1200);
  document.addEventListener('visibilitychange', onSettle);

  /* 书叶尺寸一变即校正（不依赖 window resize 事件，覆盖加载间隙丢事件） */
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => onSettle());
    if (bookEl.value) ro.observe(bookEl.value);
    if (paperPadEl.value) ro.observe(paperPadEl.value);
  }
});

let ro: ResizeObserver | null = null;

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown);
  window.removeEventListener('resize', onResize);
  viewportEl.value?.removeEventListener('wheel', onViewportWheel);
  document.removeEventListener('visibilitychange', onSettle);
  window.removeEventListener('load', onSettle);
  ro?.disconnect();
  clearTimeout(resizeTimer);
});

watch(opening, syncHash);
</script>

<template>
  <div :class="['reader-root', mode === 'book' ? 'layout-book' : 'layout-scroll', { 'mode-h': !vertical }]">
    <header class="topbar">
      <a class="seal double" href="/">讀帖</a>
      <span class="meta">{{ topMeta }}</span>
      <div class="mode-switch" role="group" aria-label="版式">
        <button type="button" :class="{ active: mode === 'book' }" title="線裝對開" @click="setMode('book')">線裝</button>
        <button type="button" :class="{ active: mode === 'scroll' }" title="中古卷軸" @click="setMode('scroll')">卷軸</button>
      </div>
      <nav class="seg" aria-label="段落跳轉">
        <button
          v-for="s in entry.sections"
          :key="s.id"
          type="button"
          :class="{ active: activeSeg === s.id }"
          :title="s.label"
          @click="jumpToSeg(s.id)"
        >
          段{{ toCN(s.id) }}
        </button>
      </nav>
      <div class="tools">
        <button type="button" :class="{ active: trad }" title="繁體原文" @click="setTrad(true)">繁</button>
        <button type="button" :class="{ active: !trad }" title="簡體原文" @click="setTrad(false)">簡</button>
        <span class="vert-horz">
          <button type="button" :class="{ active: vertical }" title="豎排" @click="setVertical(true)">豎</button>
          <button type="button" :class="{ active: !vertical }" title="橫排" @click="setVertical(false)">橫</button>
        </span>
        <button type="button" title="縮小" @click="stepSize(-2)">A－</button>
        <button type="button" title="放大" @click="stepSize(2)">A＋</button>
        <a class="tool-btn" :href="`/${entry.id}/`">扉</a>
        <a class="tool-btn" :href="`/${entry.id}/colophon`">跋</a>
      </div>
    </header>

    <div class="stage stage-book">
      <div ref="bookEl" class="book" @wheel.passive="onBookWheel">
        <div class="opening">
          <div ref="leafLeftEl" class="leaf leaf-left">
            <div class="leaf-pad">
              <div class="text-frame frame">
                <div class="page-flow" v-html="leafHTML(cur.left)"></div>
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

          <div ref="leafRightEl" class="leaf leaf-right">
            <div class="leaf-pad">
              <div ref="rightFrame" class="text-frame frame">
                <div class="page-flow" v-html="leafHTML(cur.right)"></div>
              </div>
            </div>
          </div>
        </div>

        <div ref="shadeFwdEl" class="flip-shade fwd"></div>
        <div ref="shadeBakEl" class="flip-shade bak"></div>
        <div v-if="flip" class="flip-layer active" aria-hidden="true">
          <div
            ref="flipSheetEl"
            class="flip-sheet"
            :class="flip.delta > 0 ? 'fwd' : 'bak'"
            style="transform: rotateY(0deg)"
          >
            <div class="flip-face front frame">
              <div class="leaf-pad"><div class="text-frame frame"><div class="page-flow" v-html="leafHTML(flip.front)"></div></div></div>
            </div>
            <div class="flip-face back frame">
              <div class="leaf-pad"><div class="text-frame frame"><div class="page-flow" v-html="leafHTML(flip.back)"></div></div></div>
            </div>
          </div>
        </div>
        <div v-show="hasPrev" class="corner left" title="前一開" @click="go(-1)"><span class="hint">← 前一開</span></div>
        <div v-show="hasNext" class="corner right" title="後一開" @click="go(1)"><span class="hint">後一開 →</span></div>
      </div>
    </div>

    <div class="stage stage-scroll">
      <div class="scroll-stage">
        <div
          ref="viewportEl"
          class="viewport"
          tabindex="0"
          aria-label="卷軸紙心，橫向捲動閱讀"
          @pointerdown="onDragDown"
          @pointermove="onDragMove"
          @pointerup="onDragEnd"
          @pointercancel="onDragEnd"
        >
          <div class="mounting">
            <div class="scroll-paper">
              <div class="watermark" aria-hidden="true"></div>
              <div class="zhu-seal" aria-hidden="true">御覽</div>
              <div ref="paperPadEl" class="paper-pad">
                <div class="track" v-html="trackHTML"></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <footer class="pager pager-book">
      <button type="button" :disabled="!hasPrev" @click="go(-1)">前開</button>
      <span class="num">{{ pageLabel }}</span>
      <button type="button" :disabled="!hasNext" @click="go(1)">後開</button>
    </footer>

    <div class="scroll-bar">
      <button type="button" title="向左捲（讀後方）" @click="rollBy(-280)">← 捲左</button>
      <span class="hint">滾輪／拖曳／←→ · 右起豎讀</span>
      <button type="button" title="向右捲（回起首）" @click="rollBy(280)">捲右 →</button>
    </div>
  </div>
</template>

<style>
/* 读帖 · 阅读页（designs/v2/read.html 移植；本组件仅在阅读页加载，非 scoped 以覆盖全局态） */
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

/* 版式切换：線裝｜卷軸 */
.mode-switch {
  display: flex;
  gap: 2px;
  margin-right: 8px;
  padding-right: 10px;
  border-right: 1px solid rgba(255, 255, 255, 0.12);
  flex-shrink: 0;
}
.mode-switch button {
  min-width: 36px;
  height: 26px;
  padding: 0 10px;
  font-size: 12px;
  letter-spacing: 0.12em;
  color: #C8C8C8;
  border: 1px solid transparent;
}
.mode-switch button:hover {
  color: #F0F0F0;
  border-color: rgba(180, 80, 70, 0.5);
}
.mode-switch button.active {
  color: #D08078;
  border-color: #C45A4A;
}

/* 两模式互斥显隐 */
.reader-root.layout-scroll .stage-book,
.reader-root.layout-book .stage-scroll { display: none !important; }
.reader-root.layout-scroll .pager-book { display: none !important; }
.reader-root.layout-book .scroll-bar { display: none !important; }
.reader-root.layout-scroll .seg,
.reader-root.layout-scroll .vert-horz { display: none !important; }

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

/* 界行 / 字格（线装＋卷轴共用） */
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

/* —— 横排模式：句对 = 原文行 + 行内小字释义 —— */
.reader-root.layout-book.mode-h .page-flow {
  flex-direction: column;
  gap: 12px;
  overflow-y: auto;
  padding: 12px 16px;
  border-right: none;
}
.reader-root.layout-book.mode-h .pair {
  flex: none;
  flex-direction: column;
  align-items: stretch;
  gap: 4px;
  border: none;
  border-bottom: 1px solid rgba(122, 99, 58, 0.18);
  padding-bottom: 10px;
  max-width: 100%;
  width: 100%;
  min-width: 0;
  height: auto;
}
.reader-root.layout-book.mode-h .col {
  border: none;
  box-shadow: none;
  background: none;
  max-height: none;
  height: auto !important;
  width: 100%;
  min-width: 0;
  flex-direction: row;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-start;
  padding: 4px 0;
  gap: 0;
}
.reader-root.layout-book.mode-h .ch {
  display: inline-flex;
  border: none;
  width: 1em;
  height: 1em;
  font-size: var(--orig-size);
}
.reader-root.layout-book.mode-h .pair.is-gloss { display: none; }
.reader-root.layout-book.mode-h .jz-col { display: none; }
.reader-root.layout-book.mode-h .ch .seg-dot { top: 0; left: -0.15em; transform: none; }

/* —— 3D 翻页 —— */
.flip-layer {
  position: absolute;
  inset: 0;
  z-index: 30;
  pointer-events: none;
  visibility: hidden;
  opacity: 0;
}
.flip-layer.active { visibility: visible; opacity: 1; }
.flip-sheet {
  position: absolute;
  top: 0;
  bottom: 0;
  width: calc((100% - 48px) / 2);
  transform-style: preserve-3d;
  transition: transform 0.85s cubic-bezier(0.4, 0.05, 0.2, 1);
  will-change: transform;
  z-index: 2;
}
.flip-sheet.fwd {
  left: 0;
  transform-origin: 100% 50%;
  transform: rotateY(0deg) translateZ(0);
}
.flip-sheet.fwd.turn { transform: rotateY(165deg) translateZ(0); }
.flip-sheet.bak {
  right: 0;
  transform-origin: 0% 50%;
  transform: rotateY(0deg) translateZ(0);
}
.flip-sheet.bak.turn { transform: rotateY(-165deg) translateZ(0); }
.flip-face {
  position: absolute;
  inset: 0;
  backface-visibility: hidden;
  -webkit-backface-visibility: hidden;
  background: var(--paper);
  overflow: hidden;
  box-shadow: 0 0 0 1.5px rgba(46, 36, 24, 0.45);
}
.flip-face.front {
  box-shadow:
    0 0 0 1.5px rgba(46, 36, 24, 0.45),
    8px 0 24px rgba(46, 36, 24, 0.18);
}
.flip-sheet.fwd .flip-face.front {
  box-shadow:
    0 0 0 1.5px rgba(46, 36, 24, 0.5),
    -12px 0 36px rgba(46, 36, 24, 0.28),
    0 12px 40px rgba(46, 36, 24, 0.15);
}
.flip-sheet.bak .flip-face.front {
  box-shadow:
    0 0 0 1.5px rgba(46, 36, 24, 0.5),
    12px 0 36px rgba(46, 36, 24, 0.28),
    0 12px 40px rgba(46, 36, 24, 0.15);
}
.flip-face.back {
  transform: rotateY(180deg);
  box-shadow:
    0 0 0 1.5px rgba(46, 36, 24, 0.45),
    inset 0 0 40px rgba(46, 36, 24, 0.06);
}
.flip-face .leaf-pad { height: 100%; }
.flip-face .text-frame { height: 100%; }
.flip-shade {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 40%;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.35s ease;
  z-index: 28;
}
.flip-shade.fwd {
  left: 0;
  background: linear-gradient(90deg, transparent, rgba(46, 36, 24, 0.2));
}
.flip-shade.bak {
  right: 0;
  background: linear-gradient(270deg, transparent, rgba(46, 36, 24, 0.2));
}
.flip-shade.on { opacity: 1; }

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
  .flip-layer { visibility: hidden !important; opacity: 0 !important; }
}

/* ========== 卷轴 ========== */
.stage-scroll {
  flex-direction: column;
  align-items: stretch;
  justify-content: center;
  padding: 18px 0 12px;
}
.scroll-stage {
  position: relative;
  display: flex;
  align-items: stretch;
  height: min(760px, calc(100vh - 44px - 72px));
  width: 90vw;
  max-width: 90vw;
  margin: 0 auto;
  filter: drop-shadow(0 18px 28px rgba(0, 0, 0, 0.45));
}
.viewport {
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  scroll-behavior: smooth;
  cursor: grab;
  direction: rtl;
  border-radius: 2px;
  scrollbar-width: thin;
  scrollbar-color: rgba(60, 60, 60, 0.55) transparent;
}
.viewport::-webkit-scrollbar { height: 8px; }
.viewport::-webkit-scrollbar-thumb {
  background: rgba(60, 60, 60, 0.5);
  border-radius: 4px;
}
.viewport.is-dragging { cursor: grabbing; scroll-behavior: auto; }
.mounting {
  /* 宽度随内容收放：短卷居中、长卷照常横向卷动（margin auto 在溢出时归零） */
  display: flex;
  width: fit-content;
  margin-inline: auto;
  direction: ltr;
  height: 100%;
  padding: 20px 28px;
  background-color: #A8B0B8;
  background-image:
    radial-gradient(ellipse at 20% 30%, rgba(255, 255, 255, 0.18) 0%, transparent 40%),
    radial-gradient(ellipse at 70% 60%, rgba(40, 50, 60, 0.12) 0%, transparent 45%),
    repeating-linear-gradient(45deg, transparent 0 10px, rgba(255, 255, 255, 0.04) 10px 11px, transparent 11px 22px),
    repeating-linear-gradient(-45deg, transparent 0 14px, rgba(30, 40, 50, 0.05) 14px 15px),
    linear-gradient(180deg, #B8C0C8 0%, #A8B0B8 40%, #8A949E 100%);
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.2),
    inset 0 0 40px rgba(40, 50, 60, 0.15);
}
.scroll-paper {
  position: relative;
  height: 100%;
  min-height: 100%;
  align-self: stretch;
  background:
    radial-gradient(ellipse at 18% 22%, rgba(70, 50, 30, 0.04) 0%, transparent 42%),
    radial-gradient(ellipse at 78% 68%, rgba(50, 40, 25, 0.035) 0%, transparent 48%),
    linear-gradient(180deg, #F7F1E2 0%, var(--paper) 35%, #E8DCC0 100%);
  box-shadow:
    inset 0 0 60px rgba(180, 150, 100, 0.12),
    0 0 0 1px rgba(80, 60, 40, 0.18);
  display: flex;
  flex-direction: column;
  min-width: max-content;
}
.scroll-paper::before,
.scroll-paper::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  height: 0;
  border-top: 1.5px solid rgba(50, 38, 26, 0.55);
  z-index: 3;
  pointer-events: none;
}
.scroll-paper::before { top: 18px; }
.scroll-paper::after { bottom: 18px; }
.watermark {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: min(280px, 40vw);
  height: min(280px, 40vw);
  border-radius: 50%;
  border: 1.5px solid rgba(120, 90, 50, 0.07);
  pointer-events: none;
  z-index: 0;
  background: radial-gradient(circle, transparent 42%, rgba(120, 90, 50, 0.05) 48%, transparent 55%);
}
.watermark::before {
  content: "壽";
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--kaiti);
  font-size: 7em;
  color: rgba(120, 90, 50, 0.055);
  line-height: 1;
}
.zhu-seal {
  position: absolute;
  top: 26px;
  right: 20px;
  width: 36px;
  height: 36px;
  border: 1.5px solid var(--zhu);
  color: var(--zhu);
  font-family: var(--kaiti);
  font-size: 11px;
  letter-spacing: 0.05em;
  display: flex;
  align-items: center;
  justify-content: center;
  writing-mode: vertical-rl;
  line-height: 1.15;
  opacity: 0.85;
  z-index: 4;
  background: rgba(244, 238, 220, 0.35);
  pointer-events: none;
}
.paper-pad {
  position: relative;
  z-index: 1;
  flex: 1;
  min-height: 0;
  padding: 12px 16px 22px;
  display: flex;
  align-items: stretch;
}
.track {
  display: flex;
  flex-direction: row-reverse;
  align-items: stretch;
  height: 100%;
  min-width: max-content;
  border-right: 1px solid var(--grid);
}
.scroll-bar {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 20px;
  height: 40px;
  margin-top: 8px;
  color: rgba(160, 160, 160, 0.85);
  font-family: var(--songti);
  font-size: 13px;
  letter-spacing: 0.2em;
  flex-shrink: 0;
}
.scroll-bar button {
  color: #C8C8C8;
  font-size: 12px;
  letter-spacing: 0.18em;
  padding: 4px 14px;
  border: 1px solid transparent;
}
.scroll-bar button:hover {
  color: #D08078;
  border-color: rgba(196, 90, 74, 0.4);
}
.scroll-bar .hint {
  font-size: 11px;
  letter-spacing: 0.12em;
  color: rgba(140, 140, 140, 0.75);
}

@media (max-width: 720px) {
  .stage-scroll { padding: 10px 8px 6px; }
  .scroll-stage { width: 96vw; max-width: 96vw; }
  .mounting { padding: 14px 14px; }
}
</style>
