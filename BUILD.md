# DSH-Novel 桌面端构建指南

桌面端（``）是 Flutter 应用，通过 **ACP stdio** 驱动钉住的 DeepSeek Harness 内核（`kernel/`），打包时随应用携带 Node 运行时与全套智能体预设。

## 一次构建的产物结构

```
DSH-Novel-<win|mac|linux>-<arch>/
├── DSH-Novel.exe / dsh_novel.app / bundle/
└── resources/
    ├── node/        # Node 24 运行时（打包时从 nodejs.org / 镜像下载）
    ├── kernel/      # @deepseek-ai/dsh（版本钉住在 kernel/package.json）
    ├── scripts/     # provision-home.mjs（DSH_HOME 初始化）
    └── agents/      # manifest.json + novelist/（通用）+ agents/novelist-*（风格）
```

## 本地构建（以 Windows 为例）

前置：Node 20+、Flutter stable（3.5x）。

```bash
# 1. 工具依赖 + 生成风格智能体
cd app        # 以下命令均在  下执行
npm install
npm run agents

# 2. 安装内核（npm registry 公网可达即可）
npm run kernel:install

# 3. Flutter 平台脚手架（首次）
flutter create --platforms=windows,macos,linux --project-name dsh_novel .
flutter pub get

# 4. 构建 + 组装 + 下载 node + 打 zip
node scripts/build.mjs           # 缺省用当前平台与架构
```

产物在 `dist/DSH-Novel-*.zip`，附 sha256（`dist/checksums.txt`）。

常用参数：

```
node scripts/build.mjs --platform win --arch x64   # 指定平台
node scripts/build.mjs --skip-node                 # 复用已下载的 node 运行时
node scripts/build.mjs --skip-flutter              # 只重组装资源层
```

## 本地验证（不打包）

```bash
npm run verify:kernel   # 批处理式：initialize / 优雅关闭
node scripts/verify-acp-live.mjs   # 交互式：session/new / list / close（需要真实管道环境）
```

> 说明：`verify-acp-live` 需要真实的子进程管道（stdin/stdout）。
> 在某些受限沙箱里管道被禁用会导致 session/* 误报挂起；在普通终端与 CI 上正常。

## CI 自动构建

`.github/workflows/build.yml`：

- **verify-kernel**（ubuntu）：生成智能体 → 安装内核 → `verify-acp-live` 交互式冒烟；
- **build** 矩阵：windows-x64 / macos-arm64 / linux-x64，产出 `dist/*.zip` 工件；
- **release**：打 `v*` tag 时把各平台 zip + 校验和发布到 GitHub Release。

推送 tag 即发布：

```bash
git tag v1.0.0 && git push origin v1.0.0
```

## 内核版本策略

内核版本钉住在 `kernel/package.json`（当前 `@deepseek-ai/dsh@0.1.2-rc.1`，
与 EAC 桌面版 vendored 的 0.1.2 线一致）。升级 = 改版本号 + `npm run kernel:install` +
跑冒烟测试 + 回归一轮会话创建。
