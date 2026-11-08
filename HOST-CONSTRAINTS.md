# DSH 宿主约束清单

这份文档只记**踩过的坑**和**验证过的事实**，不写猜测。每条都注明"症状"，方便下次快速对照。

## 1. 清单与加载

**`package.json` 必须是无 BOM 的 UTF-8。**
症状：DSH 启动时打一行 `skipping profile bundle "<name>": SyntaxError: Unexpected token '﻿'`，整个插件被跳过；界面无异常、无报错。
规则：不要用 PowerShell `Set-Content -Encoding UTF8` 写 JSON（会加 BOM）；用无 BOM 写入并在改完后 `ConvertFrom-Json` 校验一次。

**`dsh.client.inject` 决定这个包的客户端模块排在哪些包之后激活。**
症状：删掉后插件先于 `@deepseek-ai/dsh-client-ui-conversation` 激活，后者的激活失败，接着 11 个依赖 `uiConversation` 的插件全部 pending，启动直接崩（`web boot: N entries did not activate`）。
规则：只要插件要往某个 UI 包的插槽里注册，就把该包写进 `dsh.client.inject`。

**web boot 审计只报状态，不报异常。**
症状：日志里只有 `xxx: failed` / `pending (waiting for service: yyy)`，看不到真正的异常。
规则：客户端插件自己 `console.warn`，宿主插件自己写诊断文件（见第 7 条）。

## 2. 插槽

`ctx.slots.register(spec, Component)`，`spec.name` 必须是一个**已声明**的槽；`ctx.slots.inject(name, cb)` 等槽出现后再注册。

**`kind: "single"` 只能有一个占用者**：第二个注册被静默丢弃，不报错。
症状：注册成功、无异常，界面上什么都没有。
已知：`conversation.header` 是 single，且已被标题组件本身占用 → 插件不要往里注册。
**`kind: "list"` 可多个占用者**，才是插件该用的。

已验证的槽：

| 槽 | 类型 | 位置 |
|---|---|---|
| `conversation.header` | single（被占用） | 会话标题栏整块 |
| `conversation.header.leading` | single | 标题栏左侧 |
| `conversation.session.header.actions` | list | 标题栏右侧动作区 |
| `conversation.session.header.utilities` | list | 标题栏右侧工具区 |
| `conversation.input.dock` | list | 输入框上方（可放多行） |
| `conversation.input.overlay` | list | 输入框浮层 |
| `conversation.chat.node` | list | 消息流内（会随滚动移动） |
| `sidebar.right.pane.tab` | list | 右侧栏页签 |

## 3. 层叠与定位（最重要的一条）

会话标题行的 CSS 是：

```
.titleRow { display: flex; container-type: inline-size; }
```

`container-type` 让它同时成为 **`position: fixed` 的包含块** 和 **一个层叠上下文**。后果：

- 在标题栏里写 `position: fixed; top: 60px`，坐标不是相对窗口，而是相对那条 30px 高的标题行 → 元素跑到可视区外
- 换成 `position: absolute` 也逃不出：整个标题栏是层叠上下文，它后面的对话内容永远画在它上面 → 卡片被盖住
- 再叠一层全屏透明遮罩，用户的感觉就是"点不动"

**结论：不要在会话标题栏里做浮层。** 需要展开的面板放在 `conversation.input.dock`（文档流，无层叠问题）。

## 4. 服务注入

cordis 的服务是按上下文隔离的：

- `ctx.get('llm')` 在插件没声明 inject 时返回 `undefined`，**不报错**
- 正确写法：`ctx.inject(['llm', 'webServer'], (inner) => { inner.llm … })`，回调在两个服务都就绪后才跑
- 插件自己的 `inject` 数组声明的是"没它就不激活"的硬依赖；可选依赖用 `ctx.inject`

症状（本次）：模型层和路由从未挂上，界面一切正常，只是永远只有规则层。

## 5. 路由

`ctx.webServer.register({ kind: 'exact', path, handler })`，返回 disposer；挂在 DSH 自己的 Web 服务上，**同源**，不需要另开端口、没有跨域。

- 同一 path 重复注册会 `throw`（`webserver: duplicate exact route`）——可以拿它当"这个进程里已有一个活实例"的锁
- 未知路径返回 404，不需要鉴权即可探测；这让我们能从外部 curl 验证路由是否挂上

## 6. 会话事件

```js
ctx.on('session/event', (session, event) => { … })
```

- `session.id` 是会话 id
- 本项目用到的类型：`turn/start`（`event.data.turn`）、`user/message`（`event.data.source.kind === 'user'`）、`assistant/message`（`event.data.message.content`）、`turn/end`
- 会话加载时不会补发历史事件 → 想处理历史必须自己读 `session.log`

## 7. 投影单元

```js
ctx.sessionProjections.register({ key, stateVersion, stateSchema, init, apply, wire })
```

- `stateSchema` / `wire.viewSchema` 只用到 `.parse(value)`，可以用鸭子类型 `{ parse: (v) => v }`
- `apply(state, event)` 必须同步；与单元无关的事件要返回**同一个引用**（注册表用 `Object.is` 闸门）
- `stateVersion` 变了，旧缓存行会被丢弃（不会崩，但需要能重新折）
- `wire.view(state)` 的返回值会发给客户端，必须是可 JSON 序列化的纯数据

## 8. 模型调用

```js
const call = await ctx.llm.prepareCall({ provider, model, maxTokens }, signal, (controls) => controls)
const options = { ...call.config, messages, system, sessionId, purpose, signal }
for await (const chunk of call.stream(options)) { /* text-delta / finish */ }
```

- 文本增量在 `chunk.type === 'text-delta'` 的 `chunk.text`
- 结束分片 `chunk.type === 'finish'`，`chunk.reason.kind` 为 `stop` / `tool-calls` / `max-tokens`
- 模型偶尔不按格式输出（本次出现 1 次非 JSON）→ 解析必须容错，失败当轮跳过

## 9. 诊断

宿主进程的日志外部读不到。插件必须自带：

- 写文件：`~/.dsh/state/<plugin>/diag.log`（`apply` 开始、关键分支、异常）
- 客户端探针：点击等关键交互 `fetch('/<plugin>/ping?...')`，宿主记日志

这套东西本次定位了两个"点了没反应"的问题，值得复制。
