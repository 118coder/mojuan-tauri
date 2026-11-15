/**
 * 墨卷全局右键菜单（W4a）
 * ---------------------------------------------------------------------------
 * 替代浏览器原生 contextmenu 的全应用自定义菜单。支持两种挂载方式（二选一，
 * 同一页面只能有一种来源，否则会出现两份菜单）：
 *
 *  1) 自主模式（推荐，缺省）：组件自己全局监听 contextmenu 并按上下文构建菜单。
 *     <ContextMenu onFind={(q) => openFind(q)} getFilePath={() => currentPath} />
 *
 *  2) 受控模式：App 自己监听 contextmenu 并构建 items 传入。
 *     <ContextMenu menu={ctxMenu} onClose={() => setCtxMenu(null)} />
 *     传了 menu prop（即使为 null）即进入受控模式，组件不再自主监听。
 *     CtxMenuItem / CtxMenuState 类型与本文件同名导出，Stub 的 import 可直接换路径。
 *
 * 调研铁律落实（调研报告 §2.1 / §2.2 / §2.5，逐条照做）：
 *  - 铁律 1（选区内右键=选区保留+有选区菜单）：按下右键时对选区做快照；
 *    Chromium 在 contextmenu 事件之前就可能把选区清掉，此时用快照恢复，
 *    再按「有选区」状态出菜单。菜单顺序：复制 / 复制为 Markdown / 在页内搜索所选文字 / 全选。
 *  - 铁律 2（选区外右键=清选区+无选区菜单）：显式 removeAllRanges，再出
 *    查找 Ctrl+F / 打开所在文件夹 / 重新加载。（阅读态无光标，「光标落到点击处」不适用）
 *  - 铁律 3（列表/树右键保留选中项）：属侧栏/标签条职责，不在此组件内。
 *  - 铁律 4（复制后选区保留）：菜单容器 user-select:none + 菜单内 pointerdown
 *    preventDefault，点菜单不动文档选区，复制动作也不碰选区。
 *  - 铁律 5（剪切=复制+删除）：剪切/粘贴仅编辑态存在，阅读态不提供。
 *  - §2.2 特定目标：图片上右键（复制图片 / 复制图片地址 / 在新浮层放大）、
 *    链接上右键（打开=默认外部浏览器 / 复制链接地址）、代码块右键（复制代码内容）。
 *  - §2.2 菜单项右侧统一标注快捷键文本。
 *  - 关闭方式：Esc / 点菜单外 / 滚轮 / 页面滚动（两种模式都有）。
 *
 * 「复制为 Markdown」（§2.5）：
 *  renderer.renderBlocks 给每个 Block 附了 srcMd（token.map 行号切片的原文）。
 *  选中跨块时按被选中块的序列整块拼接（块内选中粒度简化为整块，W4a 约定）。
 *  剪贴板写入顺序：Tauri plugin-clipboard-manager（writeText）→
 *  navigator.clipboard.writeText 兜底（浏览器演示 / 插件未注册时自动降级）。
 *
 * W4b 接线说明（自主模式）：
 *  - 「查找 Ctrl+F」「在页内搜索所选文字」→ onFind(query?)：打开 FindBar 并预填；
 *    铁律 2.4-3「选中文字带入搜索词」即通过 onFind(选中文本) 传给 FindBar 的 initialQuery。
 *  - getFilePath 供「打开所在文件夹」（invoke reveal_in_explorer，见 FRONTEND_API.md）；
 *    拿不到路径时该项置灰。
 *  - blocks 可传 App 持有的 Block[]；不传则用 renderer 最近一次渲染结果（getRenderedBlocks）。
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Block } from "../lib/renderer";
import { getRenderedBlocks } from "../lib/renderer";
import { claimScroll, onUserScroll, onUserWheel } from "../lib/interaction";

/* -------------------------------------------------------------------------- */
/* 对外类型                                                                    */
/* -------------------------------------------------------------------------- */

/** 受控模式菜单项（W4b 起由 App 构建传入） */
export interface CtxMenuItem {
  label?: string;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  action?: () => void;
  separator?: true;
}

/** 受控模式菜单状态（W4b 起由 App 构建传入） */
export interface CtxMenuState {
  x: number;
  y: number;
  items: CtxMenuItem[];
}

export interface ContextMenuProps {
  /* ── 受控模式（W4b Stub 契约）：传了 menu 即由外部驱动 ── */
  /** 外部构建的菜单（null=不显示）；定义了该 prop 就不再自主监听 contextmenu */
  menu?: CtxMenuState | null;
  /** 受控模式关闭回调 */
  onClose?: () => void;

  /* ── 自主模式（W4a 契约）── */
  /** 「查找 Ctrl+F」与「在页内搜索所选文字」：W4b 打开 FindBar（query 为预填词） */
  onFind?: (query?: string) => void;
  /** 「重新加载」覆盖；缺省 location.reload() */
  onReload?: () => void;
  /** 当前文档绝对路径（「打开所在文件夹」用；null 时该项置灰） */
  getFilePath?: () => string | null;
  /** 覆盖「打开所在文件夹」；缺省 invoke("reveal_in_explorer") */
  onRevealFile?: (path: string) => void;
  /** 覆盖「打开链接」；缺省 invoke("open_url")（Tauri）→ window.open（浏览器） */
  onOpenLink?: (url: string) => void;
  /** 页内锚点（href="#xxx"）跳转：按标题文本定位块（虚拟列表下只能用块号跳） */
  onJumpAnchor?: (slug: string) => void;
  /** 「复制为 Markdown」的块源；缺省用 renderer 最近一次渲染结果 */
  blocks?: Block[];
}

/** 内部菜单项 */
interface CtxItem {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  onSelect?: () => void;
}
type CtxEntry = CtxItem | "sep";

interface MenuState {
  /** 指针位置（菜单出现处，未钳位） */
  x: number;
  y: number;
  items: CtxEntry[];
}

/* -------------------------------------------------------------------------- */
/* 剪贴板（Tauri 优先，navigator 兜底）                                          */
/* -------------------------------------------------------------------------- */

/** 是否运行在 Tauri 窗口里（浏览器演示模式为 false） */
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** 写纯文本：Tauri plugin-clipboard-manager 优先，失败降级 navigator.clipboard */
async function copyText(text: string): Promise<void> {
  if (!text) return;
  if (isTauri) {
    try {
      const clip = await import("@tauri-apps/plugin-clipboard-manager");
      await clip.writeText(text);
      return;
    } catch {
      /* Rust 侧未注册插件或调用失败：走浏览器兜底 */
    }
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    console.warn("[contextmenu] 写剪贴板失败：", err);
  }
}

/** 把 <img> 画到画布取 RGBA（Tauri writeImage 需要 row-major RGBA） */
function rgbaFromImg(img: HTMLImageElement): { data: Uint8Array; width: number; height: number } | null {
  try {
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) return null;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, w, h).data;
    return { data: new Uint8Array(d.buffer.slice(0)), width: w, height: h };
  } catch {
    return null;
  }
}

/** 复制图片：navigator ClipboardItem(png) 优先，Tauri writeImage(Image.new(rgba)) 兜底 */
async function copyImage(img: HTMLImageElement): Promise<void> {
  const src = img.currentSrc || img.src;
  // 1) 浏览器剪贴板：fetch → blob → ClipboardItem（png 兼容性最好）
  try {
    const blob = await (await fetch(src)).blob();
    let payload = blob;
    if (blob.type !== "image/png") {
      // svg/webp 等先经画布转 png
      const rgba = rgbaFromImg(img);
      if (rgba) {
        const c = document.createElement("canvas");
        c.width = rgba.width;
        c.height = rgba.height;
        c.getContext("2d")!.putImageData(
          new ImageData(new Uint8ClampedArray(rgba.data), rgba.width, rgba.height),
          0,
          0,
        );
        payload = await new Promise<Blob>((resolve, reject) =>
          c.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png"),
        );
      }
    }
    await navigator.clipboard.write([new ClipboardItem({ "image/png": payload })]);
    return;
  } catch {
    /* 继续尝试 Tauri 通道 */
  }
  // 2) Tauri 插件：RGBA 原始数据（需要 Rust 侧注册 clipboard-manager 插件）
  if (isTauri) {
    try {
      const [{ writeImage }, { Image }] = await Promise.all([
        import("@tauri-apps/plugin-clipboard-manager"),
        import("@tauri-apps/api/image"),
      ]);
      const rgba = rgbaFromImg(img);
      if (rgba) {
        await writeImage(await Image.new(rgba.data, rgba.width, rgba.height));
        return;
      }
    } catch {
      /* 插件未注册：放弃 */
    }
  }
  console.warn("[contextmenu] 复制图片失败：剪贴板不可用");
}

/* -------------------------------------------------------------------------- */
/* 选区辅助                                                                    */
/* -------------------------------------------------------------------------- */

/** 点 (x,y) 是否落在选区客户端矩形集合内（±2px 容差）——「选区内右键」判定 */
function pointInSelection(x: number, y: number, rects?: DOMRect[]): boolean {
  if (!rects) {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
    rects = [];
    for (let i = 0; i < sel.rangeCount; i++) rects.push(...Array.from(sel.getRangeAt(i).getClientRects()));
  }
  return rects.some(
    (r) => x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2,
  );
}

/** 选区覆盖的渲染块序号区间（升序；与块无关的选区返回 null） */
function selectionBlockRange(): { min: number; max: number } | null {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const idxOf = (n: Node | null): number | null => {
    const el = n ? (n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement) : null;
    const block = el?.closest(".mj-block");
    const raw = block?.getAttribute("data-block-index");
    return raw == null ? null : Number(raw);
  };
  const a = idxOf(sel.anchorNode);
  const b = idxOf(sel.focusNode);
  if (a == null && b == null) return null;
  const lo = Math.min(a ?? b!, b ?? a!);
  const hi = Math.max(a ?? b!, b ?? a!);
  return { min: lo, max: hi };
}

/** 受控 CtxMenuItem[] → 内部条目 */
function normalizeItems(items: CtxMenuItem[]): CtxEntry[] {
  return items.map((it) =>
    it.separator
      ? ("sep" as const)
      : { label: it.label ?? "", shortcut: it.shortcut, disabled: it.disabled, danger: it.danger, onSelect: it.action },
  );
}

/* -------------------------------------------------------------------------- */
/* 组件                                                                        */
/* -------------------------------------------------------------------------- */

export function ContextMenu(props: ContextMenuProps) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  /** 钳位后的实际位置（layout 阶段测量完再画，避免出屏闪烁） */
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const propsRef = useRef(props);
  propsRef.current = props;
  /** 是否受控模式（menu prop 传了就是，哪怕为 null） */
  const controlled = props.menu !== undefined;
  const controlledRef = useRef(controlled);
  controlledRef.current = controlled;

  /** 生效菜单：受控 = props.menu；自主 = 内部 state */
  const ctrl = props.menu ?? null;
  // PATCH(主线): memo 化保证引用稳定——受控模式下若每次渲染重建 effMenu，
  // 下面的钳位 useLayoutEffect 依赖 [effMenu] 会每帧触发 setPos → 无限重渲死循环
  // （W4b 实测：右键弹出瞬间页面永久冻结）
  const effMenu: MenuState | null = useMemo(
    () =>
      controlled
        ? ctrl
          ? { x: ctrl.x, y: ctrl.y, items: normalizeItems(ctrl.items) }
          : null
        : menu,
    [controlled, ctrl, menu],
  );

  const menuOpenRef = useRef(false);
  menuOpenRef.current = !!effMenu;
  const lightboxOpenRef = useRef(false);
  lightboxOpenRef.current = !!lightbox;

  /** 右键按下瞬间的选区快照（原生行为可能抢先清掉选区） */
  const selSnapshotRef = useRef<{ ranges: Range[]; rects: DOMRect[] } | null>(null);

  /** 关闭：受控走 onClose，自主清内部状态 */
  const closeMenu = (): void => {
    if (controlledRef.current) propsRef.current.onClose?.();
    else setMenu(null);
  };

  /* ------------------------------ 动作实现（自主模式菜单） ------------------------------ */

  /** 复制为 Markdown：被选中的块序列整块拼接 srcMd（W4a 简化粒度） */
  const copySelectionAsMarkdown = async (): Promise<void> => {
    const sel = document.getSelection();
    const text = sel?.toString() ?? "";
    const range = selectionBlockRange();
    const blocks = propsRef.current.blocks ?? getRenderedBlocks();
    let md = "";
    if (range && blocks.length > 0) {
      const parts: string[] = [];
      const to = Math.min(range.max, blocks.length - 1);
      for (let i = Math.max(0, range.min); i <= to; i++) {
        const src = blocks[i]?.srcMd;
        if (src) parts.push(src);
      }
      md = parts.join("\n\n");
    }
    await copyText(md || text);
  };

  /** 全选：优先全选阅读区，找不到阅读区时全选 body */
  const selectAll = (): void => {
    const sel = document.getSelection();
    if (!sel) return;
    sel.removeAllRanges();
    const scope = document.querySelector(".mj-reader") ?? document.body;
    sel.selectAllChildren(scope);
  };

  /**
   * 打开链接：页内锚点 → 按标题文本定位块（虚拟列表下 getElementById 靠不住）；
   * 外链 → Tauri open_url（默认外部浏览器）→ window.open 兜底。
   *
   * 页内锚点为什么不能直接 scrollIntoView：
   *   1) 渲染器从不给标题生成 id，getElementById 永远拿不到，点击等于没反应；
   *   2) 阅读器是虚拟列表，未渲染的块根本不在 DOM 里。
   * 所以交给 App 的 onJumpAnchor 按 heading 文本找块号再 scrollToBlock。
   */
  const openLink = async (a: HTMLAnchorElement): Promise<void> => {
    const href = a.getAttribute("href") ?? "";
    if (!href) return;
    if (href.startsWith("#")) {
      const raw = decodeURIComponent(href.slice(1));
      const jumpAnchor = propsRef.current.onJumpAnchor;
      if (jumpAnchor) {
        jumpAnchor(raw);
        return;
      }
      // 没配回调时的兜底：至少把已经渲染出来的元素滚进视野，并补申报
      // （否则这次滚动会被判成「用户滚动」，误触发分屏联动）。
      const target = document.getElementById(raw);
      if (!target) return;
      const scroller = target.closest<HTMLElement>('[data-scroll-kind="reader"]');
      const before = scroller?.scrollTop ?? 0;
      target.scrollIntoView({ block: "start" });
      if (scroller) claimScroll(scroller, before, "jump");
      return;
    }
    const abs = a.href || href;
    const override = propsRef.current.onOpenLink;
    if (override) {
      override(abs);
      return;
    }
    if (isTauri) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("open_url", { url: abs });
        return;
      } catch {
        /* 回退 window.open */
      }
    }
    window.open(abs, "_blank", "noopener");
  };

  /** 打开所在文件夹：invoke reveal_in_explorer（FRONTEND_API.md），浏览器模式无操作 */
  const revealFile = async (path: string): Promise<void> => {
    const override = propsRef.current.onRevealFile;
    if (override) {
      override(path);
      return;
    }
    if (isTauri) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("reveal_in_explorer", { path });
        return;
      } catch (err) {
        console.warn("[contextmenu] 打开所在文件夹失败：", err);
      }
    }
  };

  /** 复制代码块内容：优先 pre>code 的文本（高亮升级后 textContent 仍是完整代码） */
  const copyCode = async (block: Element): Promise<void> => {
    const code = block.querySelector("pre code") ?? block.querySelector("pre");
    const text = (code?.textContent ?? block.textContent ?? "").replace(/\n+$/, "");
    await copyText(text);
  };

  /* ------------------------------ 自主模式菜单构建 ------------------------------ */

  const buildItems = (target: Element, hasSel: boolean, selText: string): CtxEntry[] => {
    // 铁律 1：选区内右键 → 有选区菜单（顺序固定）
    if (hasSel) {
      return [
        { label: "复制", shortcut: "Ctrl+C", onSelect: () => void copyText(selText) },
        { label: "复制为 Markdown", shortcut: "Ctrl+Shift+C", onSelect: () => void copySelectionAsMarkdown() },
        { label: "在页内搜索所选文字", onSelect: () => propsRef.current.onFind?.(selText) },
        "sep",
        { label: "全选", shortcut: "Ctrl+A", onSelect: selectAll },
      ];
    }
    // §2.2 特定目标（点击处优先级：图片 > 链接 > 代码块）
    const img = target.closest("img");
    if (img) {
      return [
        { label: "复制图片", onSelect: () => void copyImage(img) },
        { label: "复制图片地址", onSelect: () => void copyText(img.currentSrc || img.src) },
        { label: "在新浮层放大", onSelect: () => setLightbox(img.currentSrc || img.src) },
      ];
    }
    const a = target.closest("a");
    if (a) {
      return [
        { label: "打开", onSelect: () => void openLink(a) },
        { label: "复制链接地址", onSelect: () => void copyText(a.href) },
      ];
    }
    const code = target.closest(".mj-code-block");
    if (code) {
      return [{ label: "复制代码内容", onSelect: () => void copyCode(code) }];
    }
    // 铁律 2：无选区菜单
    const path = propsRef.current.getFilePath?.() ?? null;
    return [
      { label: "查找", shortcut: "Ctrl+F", onSelect: () => propsRef.current.onFind?.() },
      {
        label: "打开所在文件夹",
        disabled: !path,
        onSelect: () => {
          const p = propsRef.current.getFilePath?.();
          if (p) void revealFile(p);
        },
      },
      {
        label: "重新加载",
        onSelect: () => {
          if (propsRef.current.onReload) propsRef.current.onReload();
          else location.reload();
        },
      },
    ];
  };

  /* ------------------------------ 全局监听 ------------------------------ */

  useEffect(() => {
    const snapshotSelection = (): void => {
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        selSnapshotRef.current = null;
        return;
      }
      const ranges: Range[] = [];
      const rects: DOMRect[] = [];
      for (let i = 0; i < sel.rangeCount; i++) {
        const r = sel.getRangeAt(i);
        ranges.push(r.cloneRange());
        rects.push(...Array.from(r.getClientRects()));
      }
      selSnapshotRef.current = { ranges, rects };
    };

    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target as Element | null;
      const insideMenu = !!(target && menuRef.current && menuRef.current.contains(target));
      if (insideMenu) {
        // 铁律 4：点菜单绝不 disturb 文档选区（preventDefault 阻止选区收拢与焦点转移）
        e.preventDefault();
        return;
      }
      // 点菜单外（任何键）：关闭（受控/自主都走 closeMenu）
      if (menuOpenRef.current) closeMenu();
      if (lightboxOpenRef.current) setLightbox(null);
      // 右键按下瞬间记选区快照（自主模式用）
      if (e.button === 2) snapshotSelection();
    };

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      // Esc 先关浮层/菜单（选区清除等留给 W4b 的全局快捷键）
      if (lightboxOpenRef.current) {
        e.preventDefault();
        setLightbox(null);
        return;
      }
      if (menuOpenRef.current) {
        e.preventDefault();
        closeMenu();
      }
    };

    /** 自主模式：全局接管 contextmenu */
    const onContextMenu = (e: MouseEvent): void => {
      if (controlledRef.current) return; // 受控模式：菜单由外部驱动，不自主接管
      e.preventDefault();
      const target = e.target as Element | null;
      if (!target) return;
      // 菜单上再右键：不出新菜单
      if (menuRef.current && menuRef.current.contains(target)) return;
      // 轻箱打开时右键只关轻箱
      if (lightboxOpenRef.current) {
        setLightbox(null);
        return;
      }

      // 铁律 1/2：判定点击是否在选区内；原生行为清掉选区时用按下瞬间快照恢复
      const sel = document.getSelection();
      const hasSel = !!sel && !sel.isCollapsed && sel.rangeCount > 0;
      const inside = hasSel && pointInSelection(e.clientX, e.clientY);
      const snap = selSnapshotRef.current;
      let restored = false;
      if (!hasSel && snap && snap.rects.length > 0 && pointInSelection(e.clientX, e.clientY, snap.rects)) {
        const s = document.getSelection();
        s?.removeAllRanges();
        for (const r of snap.ranges) s?.addRange(r);
        restored = true;
      }
      selSnapshotRef.current = null;

      if (hasSel && !inside && !restored) {
        // 铁律 2：选区外右键 = 清除选区
        sel?.removeAllRanges();
      }

      const finalHasSel = (inside || restored) && !!(document.getSelection()?.toString());
      const selText = finalHasSel ? document.getSelection()!.toString() : "";
      const items = buildItems(target, finalHasSel, selText);
      setMenu({ x: e.clientX, y: e.clientY, items });
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("contextmenu", onContextMenu);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener("keydown", onKeyDown, true);
    };
    // 监听只挂一次；回调经由 ref 读取最新 props/状态（受控/自主模式切换也由 ref 感知）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------------------------------------------------------------------- */
  /* 菜单打开期间的「滚动即关闭」（W8：只认真实用户滚动）                       */
  /* ---------------------------------------------------------------------- */
  /*
   * W7 把 window wheel + document scroll 捕获监听挂在这里。问题是 document
   * 捕获监听收得到**所有** scroll，包括程序化滚动：预览一滚，大纲的跟随
   * 滚动、阅读器的高度补偿滚动都会把菜单关掉 —— 用户看到的就是「滚轮和
   * 别的控件打架」。现在改为订阅仲裁器，只有 classifyScroll 判定为 user
   * （没有程序化登记、或登记值对不上）的滚动才会关菜单。
   */
  const menuVisible = !!effMenu;
  useEffect(() => {
    if (!menuVisible) return;
    const offScroll = onUserScroll((o) => {
      if (!menuOpenRef.current) return;
      if (menuRef.current?.contains(o.el)) return; // 菜单内部滚动不动它
      closeMenu();
    });
    const offWheel = onUserWheel((_e, host) => {
      if (!menuOpenRef.current) return;
      if (host && menuRef.current?.contains(host)) return;
      closeMenu();
    });
    return () => {
      offScroll();
      offWheel();
    };
    // 监听只随菜单开合挂卸；closeMenu 内部走 ref 读最新状态
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuVisible]);

  /* ------------------------------ 出屏钳位（边缘翻转） ------------------------------ */

  useLayoutEffect(() => {
    if (!effMenu) {
      setPos(null);
      return;
    }
    const el = menuRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = effMenu.x;
    let y = effMenu.y;
    // 指针处优先；放不下则向内翻（底边向上翻、右边向左翻），至少留 8px 边距
    if (y + r.height > vh - 8) y = Math.max(8, vh - r.height - 8);
    if (x + r.width > vw - 8) x = Math.max(8, vw - r.width - 8);
    // PATCH(主线): 函数式更新——位置不变时复用旧对象引用，避免无谓重渲
    setPos((p) => (p && p.x === x && p.y === y ? p : { x, y }));
    // effMenu 引用变化（开/关/换内容）时重新钳位
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effMenu]);

  /* ------------------------------ 渲染 ------------------------------ */

  return (
    <>
      {effMenu && (
        <div
          class="ctx-menu"
          data-testid="ctx-menu"
          data-scroll-kind="menu"
          ref={menuRef}
          style={{ left: `${pos?.x ?? effMenu.x}px`, top: `${pos?.y ?? effMenu.y}px` }}
          onContextMenu={(e) => e.preventDefault()}
        >
          {effMenu.items.map((item, i) =>
            item === "sep" ? (
              <div class="menu-sep" key={i} />
            ) : (
              <div
                key={i}
                class={"menu-item" + (item.disabled ? " disabled" : "") + (item.danger ? " danger" : "")}
                onClick={() => {
                  item.onSelect?.();
                  closeMenu();
                }}
              >
                <span>{item.label}</span>
                {item.shortcut && <span class="shortcut">{item.shortcut}</span>}
              </div>
            ),
          )}
        </div>
      )}
      {lightbox && (
        <div class="mj-lightbox" data-scroll-kind="modal" data-wheel="swallow" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="图片预览" />
        </div>
      )}
    </>
  );
}
