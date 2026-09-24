# agents/ —— 风格智能体（生成物）

本目录下的 `novelist-*` 预设由生成器产出，**请勿手改**——单一事实源：

- `novelist/`（仓库根）：基准预设（人设、工具、skills 全在这里维护）；
- `agents/styles.yml`：风格差异（显示名、描述、人设首句、文风要求段落）。

## 再生成

```bash
npm run agents        # 重新生成全部风格预设 + manifest.json
npm run agents:clean  # 先删掉旧生成物再生成
```

生成逻辑：读取 `novelist/agent.cordis.yml`，替换 persona 首句、在末尾追加
`styles.yml` 里的「文风要求」段落，`skills/` 与 `plugins/` 原样复制。
生成的每个目录自包含（安装到 DSH_HOME/.agent-presets/ 后独立可用）。

## 新增一种风格

1. 在 `styles.yml` 追加一段（id 合法字符 `[a-z0-9][a-z0-9-]*`）；
2. `npm run agents`；
3. 桌面端「设置 → 重新同步内置智能体」或重装该预设。

## manifest.json

`provision-home.mjs`（运行时）只读 `manifest.json`，不解析 YAML——
新增/删除风格后务必重新生成。
