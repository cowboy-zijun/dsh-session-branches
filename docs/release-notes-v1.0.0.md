## 让模型看得见对话分支

DSH 的「分支」（某一轮上的 branch 动作）本质是一次 fork：把当前会话到那一轮为止的事件整段复制进一个**全新的独立 Session**。子会话只记录 `isSeeded: true`，**不写 `parentSession`**——所以谱系树看不到它，侧边栏不缩进，模型也没有任何工具能枚举或读取它。

这个版本把「分支」第一次交到模型手里。

### 新增

- **`branch_list`** —— 找出与本对话共享历史的 Session，返回 id、标题、关系（`source` / `fork` / `descendant`）、分叉点 `seq`、自身事件数，以及该分支里用户说过的话
- **`branch_read`** —— 从分叉点起读取分支消息，`from_seq` 翻页，`include_tools` 附带工具调用名
- **系统提示段 `conversation-branches`** —— 告诉模型分支存在、什么时候该去查，不用等用户提醒
- 发现算法：按「首个事件完全相同（fork 会连时间戳一起逐字复制）」聚簇，再逐事件比对算出**精确分叉点**
- 注入消息过滤：按 `source.kind` 去掉 `runtime-context` / `time-context` / `skill-catalog` 等，预览里只剩真人输入
- 中英 locale、独立图标、`node test/smoke.test.mjs` 冒烟测试（发现 / 关系 / 分叉点 / 过滤 / 翻页 / 错误路径）

### 安装

```js
// 让助手调用，或插件管理器 → 安装 bundle
plugin_manager({ action: 'install_bundle', target: 'github:cowboy-zijun/dsh-session-branches' })
```

也可以克隆后把目录绝对路径传给 `install_bundle`。纯 JS、无构建、无运行时依赖。

### 已知限制

- 只读文本：图片、文件、推理、工具输出不还原
- 排除子代理会话（那些走 subagent 工具）
- 每次最多探测 80 个近期 Session，默认列 8 条分支
- 只返回与本对话共享历史的 Session，不是「读取任意 Session」

### 验证

- 真实数据：`看看`(1279 事件) ↔ `看看 (1)`(927 事件, `isSeeded`) 共享前缀 856，分叉后用户消息提取正确
- 本机安装后 `Tool.listTools` 可见两个工具，系统提示段生效
- `node test/smoke.test.mjs` 全部断言通过

---

English: Adds `branch_list` / `branch_read` host tools plus a `conversation-branches` prompt section, so the model can discover and read forked Sessions. A DSH fork copies the source prefix but records no `parentSession`, so discovery matches the identical first event and compares logs to find the fork point. Install with `install_bundle` targeting `github:cowboy-zijun/dsh-session-branches`.
