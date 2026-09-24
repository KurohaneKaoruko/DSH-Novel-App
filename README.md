# DSH-Novel App · 小说写作工作台

基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）重打包的桌面小说写作应用：Rust + Tauri 壳加载 **DSH 原版 WebUI**，右侧注入文件面板（目录树 / 预览 / 编辑 / 字数统计），内置七位小说智能体预设。

## 包含内容

**七位智能体预设**（基于 [DSH-Novelist](https://github.com/KurohaneKaoruko/DSH-Novelist) 基准预设生成）

| 预设 | 定位 |
| --- | --- |
| 小说助手 | 通用创作 |
| 小说助手·热血爽文 | 男频升级流、打脸四拍、爽点升级链 |
| 小说助手·甜宠言情 | 女频心动设计、糖点节奏、双视角拉扯 |
| 小说助手·悬疑诡秘 | 谜面设计、线索公平性、多层反转 |
| 小说助手·仙侠武侠 | 古典语感、修炼体系、意境打斗 |
| 小说助手·科幻末世 | 设定推演、末世生存、人性抉择 |
| 小说助手·轻小说 | 吐槽分寸、角色声线、日常主线配比 |

每位预设含 7 个方法论 skill 与 7 个纯代码工具（lint / 材料组装 / 归档等），详见 [DSH-Novelist](https://github.com/KurohaneKaoruko/DSH-Novelist)。

**软件壳（Rust + Tauri）**

- 加载 DSH 原版 WebUI（不重写界面，保持 DSH 全部能力）
- 右侧文件面板：目录树、Markdown 预览（中文阅读排版）、编辑（Ctrl+S 保存）
- 面板配色跟随原版主题变量，自动适配明暗
- 内置 Node 运行时与钉版内核（`--online` 构建除外，首启自动下载）
- 应用内 DSH 内核更新（面板「内核」按钮：检查 → 升级 → 自动重启）

## 构建

前置：Rust stable、Node 22、Tauri CLI。Linux 另需 webkit2gtk 等依赖（见 workflow）。

```bash
npm install
npm run agents          # 生成智能体库
npm run kernel:install  # 安装钉版内核
npx tauri build         # 编译 + 打安装器
```

或一键：`node scripts/build.mjs`。产物在 `dist/`。

## 相关仓库

- [DSH-Novelist](https://github.com/KurohaneKaoruko/DSH-Novelist)——智能体预设（纯插件，可独立安装到任意 DSH 环境）
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)——内核运行时

## 许可证

[MIT License](../LICENSE) © 2026 KurohaneKaoruko
