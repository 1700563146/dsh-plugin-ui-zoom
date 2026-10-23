/**
 * 界面缩放：把整个文档根节点等比放大/缩小，等于浏览器 Ctrl+ 的效果。
 *
 * 为什么落在 document.documentElement 的 zoom 上：
 * - 宿主的字号大多是硬编码像素（`font-size:12px`），没有 rem 阶梯，改 token 只能覆盖
 *   少数几处，做不到「整界面」。
 * - zoom 参与布局，布局视口、固定定位的菜单/遮罩、命中测试都会跟着变；而 transform:scale
 *   会造出一个假的包含块，把 fixed 元素困在里面。
 *
 * 两条硬规矩（都踩过）：
 * 1. 访问别的服务的属性前必须声明依赖：Cordis 对「已定义但没 inject 的服务」会直接抛
 *    `cannot get property "x" without inject`，不是返回 undefined。所以这里一律用
 *    ctx.inject([...], cb) 拿一个作用域，绝不直接摸 ctx.shortcuts。
 * 2. 滚轮不在快捷键中心的管辖范围（它只收键盘 code），只能自己监听；
 *    必须 passive: false，否则没法 preventDefault，会一边缩放一边滚页面。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-ui-zoom',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const STORAGE_KEY = 'dsh-ui-zoom';
    const MIN = 0.7;
    const MAX = 1.6;
    const STEP = 0.05;
    const DEFAULT = 1;
    // 触控板一次滑动会送几十个小 delta，累积到这么多像素才走一档
    const WHEEL_TRAVEL = 50;

    // 界面文字的本地化。不走宿主的 locale 服务：那需要协议约定，而这里只有五句话。
    // 语言取浏览器/系统的第一语言，中文就给中文，其余给英文。
    const copy = (() => {
      let language = '';
      try {
        language = typeof navigator === 'undefined' ? '' : navigator.language || '';
      } catch {
        language = '';
      }
      if (/^zh/i.test(language)) {
        return {
          zoomIn: '放大界面',
          zoomOut: '缩小界面',
          reset: '界面缩放回到 100%',
          resetShort: '回到 100%',
          zoomInHint: '放大界面（Ctrl+滚轮 / Mod+=）',
          zoomOutHint: '缩小界面（Ctrl+滚轮 / Mod+-）',
          resetHint: '回到 100%（Mod+0）',
        };
      }
      return {
        zoomIn: 'Zoom in',
        zoomOut: 'Zoom out',
        reset: 'Reset zoom to 100%',
        resetShort: 'Reset to 100%',
        zoomInHint: 'Zoom in (Ctrl+wheel / Mod+=)',
        zoomOutHint: 'Zoom out (Ctrl+wheel / Mod+-)',
        resetHint: 'Reset to 100% (Mod+0)',
      };
    })();

    const clamp = (value) => {
      const stepped = Math.round(value / STEP) * STEP;
      return Math.min(MAX, Math.max(MIN, Math.round(stepped * 100) / 100));
    };

    const load = () => {
      try {
        const saved = Number(localStorage.getItem(STORAGE_KEY));
        return Number.isFinite(saved) && saved >= MIN && saved <= MAX ? clamp(saved) : DEFAULT;
      } catch {
        return DEFAULT;
      }
    };

    const save = (value) => {
      try {
        localStorage.setItem(STORAGE_KEY, String(value));
      } catch {
        // 隐私模式下写不进去，缩放照常生效，只是不记忆
      }
    };

    const listeners = new Set();
    let current = DEFAULT;

    // 宿主正文栏的宽度是写死的：
    //   --dsh-chat-content-width: var(--dsh-chat-user-width, clamp(680px, 栏宽 * .64, 920px))
    // 也就是说 920px 是硬上限。整页 zoom 缩小时，这条 920px 的栏在物理上跟着缩小
    // （窗格没变），于是「字变小了、左右空白更大」，缩得越多越像一条窄带。
    // 这里把上限按 1/zoom 放大，让栏的物理宽度保持不变 —— 缩小时是「一行塞更多字」，
    // 而不是「把整条栏缩小」。用户自己拖过宽度时宿主会写内联样式，那时以用户的为准。
    const CONTENT_CAP_PX = 920;

    function syncContentWidth(scale) {
      const style = document.documentElement.style;
      if (scale === 1) {
        style.removeProperty('--dsh-chat-user-width');
        return;
      }
      const cap = Math.round(CONTENT_CAP_PX / scale);
      // 100% 在这里指正文栏的可用宽度，窄窗口下不会顶出去
      style.setProperty('--dsh-chat-user-width', `min(calc(100% - 32px), ${cap}px)`);
    }

    // 有些引擎里 zoom 只缩元素自身的盒子，布局视口不变，应用就不会铺满窗口，
    // 四周留白。这里量一次再决定补不补宽高 —— 只有真的没铺满才动，撤得干净。
    function syncFill(scale) {
      const app = document.getElementById('root');
      if (!app) return;
      app.style.removeProperty('width');
      app.style.removeProperty('height');
      if (scale === 1) return;

      const viewport = window.innerWidth;
      if (viewport <= 0) return;
      if (app.getBoundingClientRect().width >= viewport * 0.98) return; // 已经铺满，不用管

      app.style.setProperty('width', `calc(100% / ${scale})`);
      app.style.setProperty('height', `calc(100% / ${scale})`);
      const fixed = app.getBoundingClientRect().width;
      if (fixed < viewport * 0.98 || fixed > viewport * 1.05) {
        // 补了还是不对（可能有别的约束）：撤回，宁可维持原样也不要半吊子布局
        app.style.removeProperty('width');
        app.style.removeProperty('height');
      }
    }

    function paint(scale) {
      const root = document.documentElement;
      if (scale === 1) root.style.removeProperty('zoom');
      else root.style.setProperty('zoom', String(scale));
      syncContentWidth(scale);
      syncFill(scale);
    }

    function applyScale(next) {
      current = clamp(next);
      paint(current);
      save(current);
      for (const listener of listeners) listener();
    }

    function subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }

    // 键盘命令：默认键位按「运行时:平台」六档声明，缺的那档就是不绑。
    // 桌面端用 Mod+=/-/0（Mod = macOS 的 Command、Windows 的 Ctrl）；
    // Web 端按宿主的约定加 Alt，避开浏览器自己的页面缩放。
    const defaults = (code) => ({
      'desktop:windows': { code, modifiers: ['primary'] },
      'desktop:macos': { code, modifiers: ['primary'] },
      'desktop:linux': { code, modifiers: ['primary'] },
      'web:windows': { code, modifiers: ['primary', 'alt'] },
      'web:macos': { code, modifiers: ['primary', 'alt'] },
      'web:linux': { code, modifiers: ['primary', 'alt'] },
    });

    const COMMANDS = [
      {
        id: 'ui-zoom.in',
        label: () => copy.zoomIn,
        aliases: ['zoom in', 'bigger'],
        defaults: defaults('Equal'),
        act: () => applyScale(current + STEP),
      },
      {
        id: 'ui-zoom.out',
        label: () => copy.zoomOut,
        aliases: ['zoom out', 'smaller'],
        defaults: defaults('Minus'),
        act: () => applyScale(current - STEP),
      },
      {
        id: 'ui-zoom.reset',
        label: () => copy.reset,
        aliases: ['zoom reset', 'actual size'],
        defaults: defaults('Digit0'),
        act: () => applyScale(DEFAULT),
      },
    ];

    const style = `
      .ui-zoom-pill {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        height: 26px;
        padding: 0 3px;
        border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.25));
        border-radius: 999px;
        background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.08));
        color: var(--dsw-alias-label-secondary, #5f6368);
        font-size: 12px;
        line-height: 1;
        user-select: none;
      }
      .ui-zoom-btn {
        display: grid;
        place-items: center;
        width: 20px;
        height: 20px;
        margin: 0;
        padding: 0;
        border: 0;
        border-radius: 6px;
        background: transparent;
        color: inherit;
        font: inherit;
        font-size: 13px;
        cursor: pointer;
      }
      .ui-zoom-btn:hover:not(:disabled) {
        background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.16));
        color: var(--dsw-alias-label-primary, #0f1115);
      }
      .ui-zoom-btn:disabled { opacity: 0.35; cursor: default; }
      .ui-zoom-value {
        min-width: 38px;
        height: 20px;
        padding: 0 2px;
        border: 0;
        border-radius: 6px;
        background: transparent;
        color: inherit;
        font: inherit;
        font-variant-numeric: tabular-nums;
        cursor: pointer;
      }
      .ui-zoom-value:hover {
        background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.16));
        color: var(--dsw-alias-label-primary, #0f1115);
      }
    `;

    function ZoomPill() {
      const scale = React.useSyncExternalStore(subscribe, () => current, () => DEFAULT);
      const percent = Math.round(scale * 100);
      const atMin = scale <= MIN + 1e-9;
      const atMax = scale >= MAX - 1e-9;

      return h(
        React.Fragment,
        null,
        h('style', { key: 'style' }, style),
        h(
          'div',
          { className: 'ui-zoom-pill', key: 'pill' },
          h(
            'button',
            {
              type: 'button',
              className: 'ui-zoom-btn',
              title: copy.zoomOutHint,
              'aria-label': copy.zoomOut,
              disabled: atMin,
              onClick: () => applyScale(current - STEP),
            },
            '\u2212',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'ui-zoom-value',
              title: copy.resetHint,
              'aria-label': copy.resetShort,
              onClick: () => applyScale(DEFAULT),
            },
            `${percent}%`,
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'ui-zoom-btn',
              title: copy.zoomInHint,
              'aria-label': copy.zoomIn,
              disabled: atMax,
              onClick: () => applyScale(current + STEP),
            },
            '+',
          ),
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 分块 try/catch：DSH 的启动是「全有全无」，一个插件激活时抛出就能让整个应用起不来。
        // 任何一块出问题都只丢这一块，不该牵连宿主 —— 失败要在控制台里喊出来。
        const safe = (part, run) => {
          try {
            run();
          } catch (error) {
            console.warn(`[ui-zoom] ${part} 未生效：`, error);
          }
        };

        // 缩放本身：装上立即生效，卸载时把文档还原、把监听摘掉。
        safe('缩放与滚轮', () =>
          ctx.effect(() => {
            current = load();
            paint(current);

            let travel = 0;
            const onWheel = (event) => {
              if (!event.ctrlKey && !event.metaKey) return;
              event.preventDefault();
              if (event.deltaMode === 1) travel += event.deltaY * 16;
              else travel += event.deltaY;
              if (Math.abs(travel) < WHEEL_TRAVEL) return;
              applyScale(current + (travel < 0 ? STEP : -STEP));
              travel = 0;
            };
            // passive:false 才允许 preventDefault，否则滚轮会同时滚页面
            window.addEventListener('wheel', onWheel, { passive: false });

            return () => {
              window.removeEventListener('wheel', onWheel);
              // 把自己加过的样式全部收干净，回到宿主原样
              const style = document.documentElement.style;
              style.removeProperty('zoom');
              style.removeProperty('--dsh-chat-user-width');
              const app = document.getElementById('root');
              if (app) {
                app.style.removeProperty('width');
                app.style.removeProperty('height');
              }
            };
          }, 'ui-zoom: apply zoom'),
        );

        // 键盘命令交给宿主的快捷键中心（冲突裁决、用户改键、持久化都由它负责）。
        // 用注入作用域拿服务：拿不到时插件照常激活，只是没有键盘快捷键，
        // 滚轮和胶囊仍然可用 —— 绝不能为此去抢键盘，那会和别人重复触发。
        safe('键盘快捷键', () =>
          ctx.inject(['shortcuts'], (scope) => {
            scope.effect(() => {
              const disposers = [];
              for (const command of COMMANDS) {
                try {
                  disposers.push(
                    scope.shortcuts.register({
                      id: command.id,
                      label: command.label,
                      aliases: command.aliases,
                      defaults: command.defaults,
                      // 焦点在页面、输入框、终端里都响应：缩放不吃任何输入语义
                      regions: ['page', 'editable', 'terminal'],
                      resolve: () => ({ status: 'handled', run: command.act }),
                    }),
                  );
                } catch (error) {
                  console.warn(`[ui-zoom] 快捷键 ${command.id} 注册失败：`, error);
                }
              }
              return () => {
                for (const dispose of disposers) {
                  if (typeof dispose === 'function') dispose();
                }
              };
            }, 'ui-zoom: shortcuts');
          }),
        );

        // 输入框右侧有预留的排布空间，是宿主的公共位置，不会和别人的元素抢位置。
        safe('胶囊控件', () =>
          ctx.slots.inject('conversation.composer.dock', () =>
            ctx.slots.register(
              {
                name: 'conversation.composer.dock',
                id: 'ui-zoom',
                order: 20,
              },
              ZoomPill,
            ),
          ),
        );
      },
    };
  },
});
