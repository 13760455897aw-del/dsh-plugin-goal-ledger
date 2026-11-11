# 目标日志 / Goal Ledger

只给你看、不进模型上下文的 DSH 插件。它挂在会话标题栏右侧（`conversation.session.header.actions`，标题栏里唯一的 list 插槽）：平时是一枚纸质小标签"目标日志"，偏离主线时旁边带红色数字；点一下在下面展开一张便签卡片。

> 为什么不在标题正下方另开一栏：`conversation.header` 在 `dsh-client-ui-conversation` 里声明为 `kind: "single"`，已经由会话标题组件本身占用，注册进去的组件不会渲染、也不会报错。标题栏里可多人占用的只有 `.actions` 和 `.utilities`。

卡片内容：

- **抬头**：`12 轮 · 5 个目标`、偏离计数（红色印章）、"展开全部 / 收起全部"
- **总览**：一句话讲清来龙去脉——"从「第一个目标」开始，拆成 N 个目标，现在在「主线」"
- **最近**：主线最后一次推进，用的是模型自己那句收尾总结
- **本轮**：当前这一轮在干什么（进行中）
- **任务树**：`任务 1` → `1.1` → `1.1.1` 逐级缩进，每个节点左侧有 `▸/▾` 就地展开（下拉，不换面板、不加宽卡片），行尾是轮次区间；标签颜色点对应关系（承继/细化/分支/旁支/新线）

卡片宽度固定 500px，靠右展开，不会压到左侧栏。

## 两层归纳

| 层 | 在哪 | 做什么 | 成本 |
|---|---|---|---|
| 规则层 | 投影单元 `goalLedger` | 纯折叠：关系判定、分句归纳、进度摘句。第一轮就可用，模型失败时兜底 | 0 |
| 模型层 | `lib/model-ledger.js` | 每轮结束一次小调用，让模型输出 `{rel, parentId, name, progress}`：任务名、挂到哪个任务、这轮进展 | 每轮 1 次（几百 token） |

模型层的结果通过 `GET /goal-ledger/state?session=<id>`（复用 DSH 自己的 `webServer`，同源、无跨域）送到卡片；卡片优先显示模型结果，**卡片底部会写明当前用的是哪一层**——"模型归纳"或"规则归纳（模型结果未到）"，失败时还会带上原因。

模型调用只发生在宿主进程、只用 `ctx.llm`，**不注入任何上下文、不写会话日志、不加工具**，对话里的模型完全看不到它。

## 两条硬规则

1. **不是每轮都记。** 同一个任务的后续推进（包括光回一句"继续"）只更新轮数、最后推进时间和"最近"那一行；只有 model 判成 child / root 时才新增节点。
2. **不是原句。** 任务名由模型给（≤14 字，像任务标题），"最近"取助手收尾消息的第一句。

## 规则层的折叠细节

| 层 | 做什么 | 成本 |
|---|---|---|
| 关系层 | 显式切换词 / 延续词 / 细化词 / 裸催促（"继续""好的"）优先于锚点重叠 | 0 |
| 锚点层 | ASCII 标识符 + 中文二元组做锚点重叠，判断"是不是还在动同一批东西" | 0 |
| 归纳层 | 分句打分（动作动词加分、抱怨句减分、描述句合并）→ 短句 | 0 |
| 进度层 | 助手收尾消息的第一句，剥掉 Markdown 包裹 | 0 |

## 明确不做

- **不做跨会话**：目标是会话级的，不是工作区级的
- **不做进度百分比**：没有接文件/todo 硬信号
- **不提醒模型**：只提醒人
- **不写会话日志**：模型结果落在 `~/.dsh/state/goal-ledger/<session>.json`，不碰 session 文件

## 参数（怎么改）

参数在 [cordis.patch.yml](cordis.patch.yml) 的 `config` 里，**改完重启 DSH 生效**。

| 参数 | 默认 | 含义 | 影响 |
|---|---|---|---|
| `enabled` | `true` | 总开关 | 关掉只留规则层，不调模型、不挂路由 |
| `provider` | `deepseek-account` | 模型路由的账号来源 | 换账号/换供应商接口时改 |
| `model` | `deepseek-flash` | 具体模型 | 换更贵的模型会更好但更慢更贵 |
| `maxTokens` | `320` | 单次判定输出上限 | 实际只用 40–80，调大没收益 |
| `timeoutMs` | `25000` | 单次调用超时 | 超时按失败处理，本轮跳过 |
| `promptTasks` | `12` | 提示词里列几个任务 | 调小省 token；调大更容易挂到旧任务 |
| `excerptChars` | `240` | 每轮发给模型的助手摘录字数 | 便宜的直接旋钮 |
| `digestChars` | `4000` | 历史回填的对话摘要上限 | 只在首次打开旧会话时用一次 |
| `retries` | `1` | 非 JSON 输出的重试次数（0–3） | 偶发跑偏时兜底 |

两种改法：

1. **改插件自带的 [cordis.patch.yml](cordis.patch.yml)**（推荐）：直接改上面的值，重启。所有 profile 都生效。
2. **改 profile 覆盖**：在 `~/.dsh/profiles/desktop/cordis.patch.yml` 里加一条
   ```yaml
   - id: goal-ledger
     config:
       enabled: true
       model: deepseek-chat
       # ……所有键都要重写，patch 会整体替换 config，不做合并
   ```
   注意：profile 层是**整体替换**，漏写的键会回落到代码默认值。

## 安装

**在插件市场里装（图形界面）**

DSH 不自带索引源。打开「插件」页 → 实验插件里启用 **Custom plugin indexes** → 切到 **Discover** 标签 → **Add index source**，填入：

```
https://raw.githubusercontent.com/13760455897aw-del/dsh-plugin-goal-ledger/master/plugin-index.json
```

刷新后能看到「目标日志」卡片，点安装即可。

**从 npm 安装**

```powershell
dsh plugin --profile desktop add dsh-plugin-goal-ledger
```

新增 bundle 需要重启 DSH 才会组合。

**从源码 link 安装**

```json
"dependencies": { "dsh-plugin-goal-ledger": "link:E:/插件灵感一箩筐/packages/goal-ledger" }
```

并在 `dsh.profile.bundles` 里加上 `dsh-plugin-goal-ledger`。

## 卸载

从 profile 的 `dsh.profile.bundles` 里去掉、删除依赖后重启；或运行仓库里的 `disable.ps1`。

## 测试

```powershell
node test/ledger.spec.mjs   # 折叠、关系判定、归纳与进度，12 项
node test/model.spec.mjs    # 判定解析、回填、结论、长轮询，13 项
node test/config.spec.mjs   # 参数与重试，4 项
node test/host.spec.mjs     # 宿主入口、两条路由、两个监听
node test/client.spec.mjs   # 浏览器 bundle 的加载、fiber 属主与卸载回收
node test/chip.spec.mjs     # 点开/关闭卡片 + 尺寸探针
node dev/preview.mjs        # 用真实组件渲染一张预览页
```
