# dsh-session-branches

让 DeepSeek Harness（DSH）里的模型能**看见并读取对话分支**。

[English](README.en.md) | 中文

## 它解决什么问题

DSH 的"分支"（聊天里某一轮的 branch 按钮）实际上是一次 fork：它把当前会话到那一轮为止的事件**整段复制**进一个**全新的独立 Session**。

- 子会话头里 `isSeeded: true`，但**不写 `parentSession`**——分支是独立对话，不是子代理；
- 因此 `sessionQuery.traceSession()` 的谱系树看不到它，侧边栏也不会缩进；
- 唯一的联系只剩"被复制的那段前缀"。

结果就是：分支里的你（和模型）看得到分叉前的一切，但**看不到另一条分支后来发生了什么**。模型没有任何工具能枚举或读取它们。

这个插件补上这一环：按"首个事件完全相同（fork 会连时间戳一起逐字复制）"聚簇，再逐事件比对算出**精确分叉点**，然后把分支内容以工具形式交给模型。

## 提供的能力

| 工具 | 作用 |
|---|---|
| `branch_list` | 列出与本对话共享历史的 Session：id、标题、关系（`source` / `fork` / `descendant`）、分叉点 `seq`、自身事件数、以及该分支里用户说过的话 |
| `branch_read` | 从分叉点起读取某个分支的消息，支持 `from_seq` 翻页、`include_tools` 附带工具调用名 |

同时注册一条系统提示段（`conversation-branches`），让模型知道"分支存在、什么时候该去查"，而不是等用户提醒。

## 安装

这是一个 DSH bundle（`package.json` 里声明了 `dsh.bundle.patch`），纯 JS、无构建步骤、无依赖。

**方式一：插件管理器（推荐）**

1. 把本仓库克隆或下载到本地任意目录；
2. 在 DSH 里安装该目录：插件管理器 → 安装 bundle，指定该目录的**绝对路径**；
   也可以直接让助手调用 `plugin_manager` 的 `install_bundle`，`target` 传该路径。

**方式二：作为安装 spec**

`install_bundle` 的 `target` 也接受安装 spec，可传仓库地址（例如 `github:<用户名>/dsh-session-branches`），由 pnpm 解析安装。

> 无论哪种方式，都由插件管理器写入 profile 的依赖与 `dsh.profile.bundles`；不要手写 profile 的 `package.json` 或 `cordis.patch.yml`。

安装后：

- `branch_list` / `branch_read` 出现在模型工具列表；
- 系统提示里多出 `## Conversation branches` 一段；
- 插件列表里显示标题"对话分支"（中文 locale）或 "Conversation branches"（英文）。

## 使用

在任意一条分支里，直接说：

- "另一个分支里我后来让你改了什么？"
- "对比一下两条分支的结论。"
- "刚才那条被覆盖的版本说了什么？"

模型会先 `branch_list`，再按需 `branch_read`。

## 实现要点

1. `discover()` 用 `ctx.sessionQuery.listSessions()` 取候选 Session（排除子代理会话、排除早于本谱系首事件的会话）；
2. 对每个候选做一次 `readEvent({ seq: 0 })` 轻量探测，取 `inheritedEventCount` 与首事件；
3. 首事件 `time + type + data` 相同即视为同一分支树；
4. 命中的候选再读完整日志，逐事件比对得到共享前缀长度（= 分叉点）；
5. 分叉点之后只保留 `user/message`（`source.kind === 'user'`）与 `assistant/message` 的文本，注入类消息（`runtime-context`、`time-context`、`skill-catalog` 等）按 `source.kind` 过滤掉。

## 限制

- 只读文本：图片、文件、推理、工具输出不还原；`include_tools` 只给工具名。
- 排除子代理会话（那些走 subagent 工具）。
- 每次最多探测 80 个近期 Session，默认最多列 8 条分支。
- 不是"读取任意 Session"的工具：只返回与本对话共享历史的那些。

## 测试

```powershell
node test/smoke.test.mjs
```

用手工构造的 source/branch 对覆盖：发现、关系判定、分叉点、预览过滤、翻页、错误路径。

## 关于包名

当前包名是 `@local/dsh-session-branches`，与已安装副本保持一致，避免同一 profile 里出现两个包名不同、工具名相同的插件。

若要发布到 npm，请先把 `package.json` 的 `name` 改成你的作用域或无作用域名（同时去掉 `"private": true`），重新安装后旧的 `@local/...` 副本要先移除，否则两个插件会抢注 `branch_list`。

## License

MIT
