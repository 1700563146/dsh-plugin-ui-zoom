/**
 * ui-zoom 的行为测试：把浏览器换成桩，把 Cordis 的服务访问规则也照实模拟。
 *
 * 重点护栏：ctx 上的 `shortcuts` getter 是**会抛异常**的，和真实 Cordis 一致
 * （「已定义但没 inject 的服务」不是返回 undefined，而是 `cannot get property ... without inject`）。
 * 插件只要还直接摸 ctx.shortcuts，这个测试就会红——那次启动崩溃就是这么来的。
 *
 * 用法：node test.mjs        （不影响安装，`files` 里没有它）
 */
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const reactStub = {
  Fragment: 'Fragment',
  createElement: (type, props, ...children) => ({ type, props, children }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
};

/** 造一个「假浏览器 + 假 ctx」，按真实 Cordis 规则限制服务访问。 */
function makeEnv({ withShortcuts }) {
  const env = {
    zoom: {},
    store: new Map(),
    handlers: {},
    slots: [],
    commands: [],
    cleanups: [],
    prevented: 0,
    component: null,
  };

  globalThis.localStorage = {
    getItem: (key) => (env.store.has(key) ? env.store.get(key) : null),
    setItem: (key, value) => env.store.set(key, String(value)),
  };
  globalThis.document = {
    documentElement: {
      style: {
        setProperty: (name, value) => { env.zoom[name] = value; },
        removeProperty: (name) => { delete env.zoom[name]; },
      },
    },
    // 应用根节点由各用例按需造：有的引擎里 zoom 不放大布局视口，要量一次才知道
    getElementById: () => env.app,
  };
  globalThis.window = {
    innerWidth: 1600,
    addEventListener: (type, fn, options) => { env.handlers[type] = { fn, options }; },
    removeEventListener: (type) => { delete env.handlers[type]; },
    __ModuleLoader__: {
      load({ id, factory }) {
        assert.equal(id, 'dsh-plugin-ui-zoom');
        const plugin = factory(() => reactStub);

        const shortcutsService = {
          register(command) {
            env.commands.push(command);
            return () => { command.disposed = true; };
          },
        };

        const scopeCtx = (services) => ({
          effect: (fn) => { const d = fn(); env.cleanups.push(d); return d; },
          get shortcuts() { return services.includes('shortcuts') ? shortcutsService : undefined; },
        });

        const ctx = {
          effect: (fn) => { const d = fn(); env.cleanups.push(d); return d; },
          inject: (deps, callback) => {
            const available = deps.every((name) => name === 'slots' || (name === 'shortcuts' && withShortcuts));
            if (available) callback(scopeCtx(deps));
          },
          slots: {
            inject: (_name, register) => register(),
            register: (options, component) => { env.slots.push(options); env.component = component; },
          },
        };
        // 真实 Cordis：没有 inject 就访问服务属性 → 直接抛
        Object.defineProperty(ctx, 'shortcuts', {
          get() { throw new Error('cannot get property "shortcuts" without inject'); },
        });

        plugin.apply(ctx);
      },
    },
  };

  env.wheel = (init) => {
    assert.ok(env.handlers.wheel, '应该监听 wheel');
    env.handlers.wheel.fn({
      ctrlKey: false, metaKey: false, deltaMode: 0, deltaY: 0,
      preventDefault: () => { env.prevented += 1; },
      ...init,
    });
  };
  // 造一个假的 #root：widths 按调用顺序依次返回，模拟「量一次 / 补完再量一次」
  env.makeApp = (widths) => {
    const style = {
      setProperty: (name, value) => { style[name] = value; },
      removeProperty: (name) => { delete style[name]; },
    };
    let index = 0;
    env.app = {
      style,
      getBoundingClientRect: () => ({ width: widths[Math.min(index++, widths.length - 1)] }),
    };
    return style;
  };
  env.buttons = () => {
    const found = [];
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(walk);
      if (node.type === 'button') found.push(node);
      walk(node.children ?? []);
    };
    walk(env.component({}));
    return found;
  };
  return env;
}

// ============ 阶段一：快捷键中心在场 ============
{
  const env = makeEnv({ withShortcuts: true });
  await import(`${pathToFileURL('./client.js').href}?with-shortcuts`);

  assert.equal(env.slots[0].name, 'conversation.composer.dock');
  assert.equal(env.slots[0].id, 'ui-zoom');
  assert.equal(env.buttons()[1].children[0], '100%');
  assert.equal(env.zoom.zoom, undefined, '100% 时不该写 zoom 属性');

  // 三条命令注册进了宿主的快捷键中心
  assert.deepEqual(env.commands.map((c) => c.id), ['ui-zoom.in', 'ui-zoom.out', 'ui-zoom.reset']);
  for (const command of env.commands) {
    assert.equal(typeof command.label, 'function');
    assert.deepEqual(command.regions, ['page', 'editable', 'terminal']);
    assert.equal(command.resolve({ modal: null }).status, 'handled');
  }
  assert.deepEqual(env.commands[0].defaults['desktop:windows'], { code: 'Equal', modifiers: ['primary'] });
  assert.deepEqual(env.commands[0].defaults['web:windows'], { code: 'Equal', modifiers: ['primary', 'alt'] });

  env.commands[0].resolve({}).run();
  assert.equal(env.zoom.zoom, '1.05');
  env.commands[2].resolve({}).run();
  assert.equal(env.zoom.zoom, undefined);

  // Ctrl+滚轮：阈值、方向、deltaMode、preventDefault
  env.wheel({ ctrlKey: true, deltaY: -30 });
  assert.equal(env.zoom.zoom, undefined, '没过阈值不该动');
  assert.equal(env.prevented, 1, '按住 ctrl 时要阻止页面滚动');
  env.wheel({ ctrlKey: true, deltaY: -30 });
  assert.equal(env.zoom.zoom, '1.05', '累计过阈值向上放大');
  env.wheel({ ctrlKey: true, deltaY: 60 });
  assert.equal(env.zoom.zoom, undefined, '向下滚回 100%（100% 不写属性）');
  const quiet = env.prevented;
  env.wheel({ deltaY: -60 });
  assert.equal(env.prevented, quiet, '没按 ctrl 不该接管');
  env.wheel({ ctrlKey: true, deltaMode: 1, deltaY: 2 });   // 2 行 ≈ 32px
  env.wheel({ ctrlKey: true, deltaMode: 1, deltaY: 2 });   // 累计 64px → 缩小
  assert.equal(env.zoom.zoom, '0.95');
  assert.deepEqual(env.handlers.wheel.options, { passive: false });

  // 夹取
  for (let i = 0; i < 40; i += 1) env.buttons()[2].props.onClick();
  assert.equal(env.zoom.zoom, '1.6');
  assert.equal(env.buttons()[2].props.disabled, true);
  for (let i = 0; i < 40; i += 1) env.buttons()[0].props.onClick();
  assert.equal(env.zoom.zoom, '0.7');
  assert.equal(env.buttons()[0].props.disabled, true);
  assert.equal(env.store.get('dsh-ui-zoom'), '0.7');

  // 正文栏上限要按 1/zoom 放大：缩小后是「一行更多字」，不是「一条更窄的带子」
  // 当前 0.7 → 920 / 0.7 ≈ 1314
  assert.equal(env.zoom['--dsh-chat-user-width'], 'min(calc(100% - 32px), 1314px)');
  env.commands[2].resolve({}).run();               // 复位
  assert.equal(env.zoom.zoom, undefined);
  assert.equal(env.zoom['--dsh-chat-user-width'], undefined, '回到 100% 要把这个覆盖摘掉');

  // 应用根节点已经铺满窗口时：不要动宽高
  {
    const style = env.makeApp([1600, 1600]);
    env.commands[1].resolve({}).run();             // 1.00 → 0.95
    assert.equal(style.width, undefined, '铺满了就不该补宽高');
  }

  // 没铺满（zoom 只缩了盒子、布局视口没放大）：补上 1/zoom，补完真的铺满 → 保留
  {
    env.commands[2].resolve({}).run();             // 回到 1.00
    const style = env.makeApp([1520, 1600]);
    env.commands[1].resolve({}).run();             // 1.00 → 0.95
    assert.equal(style.width, 'calc(100% / 0.95)', '没铺满要补宽');
  }

  // 补了还是不对 → 撤回，宁可原样
  {
    env.commands[2].resolve({}).run();
    const style = env.makeApp([1520, 1520]);
    env.commands[1].resolve({}).run();             // 1.00 → 0.95
    assert.equal(style.width, undefined, '补了没用就要撤回去');
  }

  // 卸载
  env.commands[2].resolve({}).run();
  for (const cleanup of env.cleanups.splice(0)) if (typeof cleanup === 'function') cleanup();
  assert.equal(env.zoom.zoom, undefined, '卸载要还原文档缩放');
  assert.equal(env.handlers.wheel, undefined, '卸载要摘掉滚轮监听');
  assert.equal(env.commands.every((c) => c.disposed), true, '卸载要注销快捷键命令');

  console.log('ui-zoom: 快捷键中心在场 —— 通过');
}

// ============ 阶段二：没有快捷键中心（或缺 shortcuts 服务）============
{
  const env = makeEnv({ withShortcuts: false });
  await import(`${pathToFileURL('./client.js').href}?without-shortcuts`);

  // 关键：不能因此抛异常，插件必须照常激活
  assert.equal(env.zoom.zoom, undefined);
  assert.equal(env.slots.length, 1, '胶囊控件仍要注册');
  assert.equal(env.commands.length, 0, '没有服务就不该注册命令');
  assert.equal(env.handlers.keydown, undefined, '不能退回去抢键盘，会和别的插件重复触发');

  env.wheel({ ctrlKey: true, deltaY: -60 });
  assert.equal(env.zoom.zoom, '1.05', '滚轮通道不依赖快捷键中心');
  env.buttons()[2].props.onClick();
  assert.equal(env.zoom.zoom, '1.1', '胶囊通道也不依赖它');

  for (const cleanup of env.cleanups.splice(0)) if (typeof cleanup === 'function') cleanup();
  assert.equal(env.zoom.zoom, undefined);

  console.log('ui-zoom: 快捷键中心缺席 —— 通过（优雅降级）');
}
