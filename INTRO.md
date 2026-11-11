# 目标日志 · Goal Ledger

> 把一场长对话折叠成一张任务树：当前任务一个红点，做完的划掉，每件事留一句结论。

## 它解决什么

长对话里最先失效的不是模型，是人的注意力。模型每答一次就带出新信息，你顺着往下走，几轮之后已经在忙别的事，忘了最初要干什么，最后干脆放弃。

目标日志把这件事变成看得见的结构：

```
目标日志  2/3
✓ 分析头条号文章数据与标题
  ✓ 批量生成标题文案
  ● 核查标题时效与真实性
    逐条溯源 40 条标题日期，分四类并说明均非新闻
```

- **● 红点** = 当前在做的那件事，只有它带一行进展
- **✓** = 已经离开的任务，点开能看到它的一句话结论
- **○** = 还没开始
- 任务名由模型归纳，不是你的原句；历史不删除，随时回看

## 地址

| 用途 | 地址 |
|---|---|
| 源码 | https://github.com/13760455897aw-del/dsh-plugin-goal-ledger |
| npm | https://www.npmjs.com/package/dsh-plugin-goal-ledger |
| 插件市场索引 | https://raw.githubusercontent.com/13760455897aw-del/dsh-plugin-goal-ledger/master/plugin-index.json |
| 设计文档 | [DESIGN-PAPER.md](DESIGN-PAPER.md) |

## 安装

### 方式一：插件市场（图形界面，推荐）

1. 打开 DSH 的「插件」页
2. 在「实验插件」里启用 **Custom plugin indexes**
3. 切到 **Discover** 标签 → **Add index source**
4. 粘贴索引地址：

   ```
   https://raw.githubusercontent.com/13760455897aw-del/dsh-plugin-goal-ledger/master/plugin-index.json
   ```

5. 出现「目标日志」卡片 → 点安装 → 重启 DSH

### 方式二：命令行

```powershell
dsh plugin --profile desktop add dsh-plugin-goal-ledger
```

装完重启 DSH（新增 bundle 需要重启才会组合）。

### 方式三：源码 link

```json
"dependencies": { "dsh-plugin-goal-ledger": "link:E:/插件灵感一箩筐/packages/goal-ledger" }
```

并在 `dsh.profile.bundles` 里加上 `dsh-plugin-goal-ledger`。

## 怎么用

- 会话输入框上方会多出一枚「目标日志」小标签
- 点一下展开卡片，再点收起
- 点某个任务行，展开它的分支或一句话结论
- 没有任何操作也能用：插件只读会话事件，不改变对话本身

## 兼容与开销

- DSH：`>=0.2.0-rc.1 <0.3.0-0`；Node ≥ 22
- 每轮一次小模型调用（默认 deepseek-flash）：典型 300–800 tokens
- 首次打开带历史的会话会做一次回填，约 1–2k tokens，每个会话只一次
- 模型不可用时自动退回规则层，界面照常，只是任务名会粗一些

## 参数

全部在 `cordis.patch.yml` 的 `config` 里，改完重启：

| 参数 | 默认 | 含义 |
|---|---|---|
| `enabled` | true | 总开关 |
| `model` | deepseek-flash | 用哪个模型归纳 |
| `maxTokens` | 320 | 单次输出上限 |
| `timeoutMs` | 25000 | 单次调用超时 |
| `promptTasks` | 12 | 提示词里列几个历史任务 |
| `excerptChars` | 240 | 每轮附带的助手摘录字数 |
| `digestChars` | 4000 | 历史回填摘要上限 |
| `retries` | 1 | 输出不是 JSON 时的重试次数 |

## 卸载

从插件页停用，或从 profile 的 `dsh.profile.bundles` 里去掉后重启；仓库里有 `disable.ps1`。

## 许可

MIT。设计取舍、算法、成本和踩过的坑都写在 [DESIGN-PAPER.md](DESIGN-PAPER.md)。

---

### English TL;DR

**Goal Ledger** folds a long DSH session into a task tree — current task with a red dot, finished ones ticked, one-line conclusion per task. Rule layer is free and instant; one small model call per turn names and files the work. It never touches the conversation context.

```
npm i -g dsh-plugin-goal-ledger   # or add it from the Discover tab
```

Install via Plugins → enable **Custom plugin indexes** → Discover → Add index source:
`https://raw.githubusercontent.com/13760455897aw-del/dsh-plugin-goal-ledger/master/plugin-index.json`

MIT licensed.
