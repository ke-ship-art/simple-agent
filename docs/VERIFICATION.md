# 0.2.1 验证记录

平台：Windows x64。日期：2026-10-16。pi-ai 0.99.2，Electron 44.5.1 / 内置 Node 24.21.0。

## 已执行

- `npm run typecheck`：通过。
- `npm test`：13 个测试文件，100 项通过，0 项失败。保留原有能力测试；Word 断言改为实际段落内容及两种 run 样式均保留。
- 最终 Windows 便携 EXE：19 项应用验收全部通过，0 项失败；1 项开发模式专用测试按设计跳过（该项在源码构建验收中已通过）。
- 最终源码构建的 Electron 验收：20 项全部通过（19 项应用、1 项开发模式），0 项失败。新增 6 项：草稿隔离与重启、无认证模型选择、PDF 文件切换/提取、保存中冻结输入及 Ctrl+S、取消连接测试、多行引号 TSV 粘贴。
- 0.2.0 已完成的 Microsoft Excel COM 16.0 实机基线（本轮未改公式处理代码）：独立测试副本 CalculateFullRebuild，直接 B1=8、链式 C1=9、跨表 A1=18、独立 D1=101；保存后 openpyxl(data_only=True) 读出 8 和 18。
- openpyxl(data_only=True)：Excel 重算前，受影响缓存为 None，独立缓存 101/100 保留；原公式文本和重算属性可读。

## 场景映射

| 要求 | 自动化证据 |
|---|---|
| 同轮同文件双编辑 | reliability-core：真正 Agent 多 toolCall；原快照非重叠合并，一次提交 |
| 旧版本覆盖、外部修改 | files/workspace-reliability/reliability-core：拒绝 stale write；恢复遇外部内容不覆盖 |
| 多页图片 PDF 与恢复 | reliability-core：三页读取、图片去重、重启引用及按需加载；Electron：真实 PDF.js 图片进入 SDK 请求但不进入 state.json |
| Word 跨 run、样式与特殊文本 | documents/documents-reliability：粗斜体、tab/br、空白、emoji、等长保留、长度变化拒绝及显式策略 |
| Excel 依赖与分页 | 直接、链式、跨表、动态引用、独立缓存、公式修改、Sheet 名/ID 及不同大小工作表分页；实际 Excel/openpyxl |
| PDF 字体 | 中文添字/原生批注；缺字报 U+ 编号且文件字节不变；Unicode 原生批注可保存 |
| PDF 进程异常 | pdf-service：崩溃/超时/取消/频率限制/关闭；Electron：forcefullyCrashRenderer 后新窗口正常识别扫描页 |
| 大文件搜索 | 流式大单行 JSON/CSV、严格 UTF-8/二进制排除、限制/排除规则、进度/取消、主事件循环可推进；凭据内容排除 |
| 本机、LAN、外部端点 | endpoint：真实 loopback HTTP、显式 LAN 信任/DNS 重绑定/特殊地址/混合地址拒绝、HTTPS/重定向规则；各协议 SDK 到本机模拟服务 |
| 断网/超时/异常返回 | 挂起且忽略 signal、断开、取消、空回复/截断、无效工具、重复调用与上限 |
| 会话管理及资源 | 重命名、归档、删除、恢复、永久清理及共享图片引用；Electron 相同 UI 流程 |
| Diff 与撤销 | patch/统计、接受、精确字节撤销与冲突拒绝；Electron 并排视图、接受后整轮撤销 |
| 大工作表交互 | Electron：2500 行工作表仅渲染约 45 行，滚动至第 2001 行；粘贴 2×2 TSV 并保存后核对末行数据未丢失，范围复制结果一致 |
| 应用异常退出 | state 截断恢复上一代且保留坏文件；未完成事务恢复；Electron app.exit(77) 绕过正常退出后重启，已提交文件仍可撤销 |
| 凭据及权限 | safeStorage 加密、公开状态无密钥、错误脱敏、独立接入、加密修订失败不混配、登出清理；界面无 require、受限 preload |

## 复现

```powershell
npm ci
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run package
$env:SIMPLE_AGENT_PACKAGED_EXE = (Resolve-Path 'release/win-unpacked/Simple Agent.exe').Path
npm run test:e2e
Remove-Item Env:SIMPLE_AGENT_PACKAGED_EXE
```

开发测试需要 Node 24.19+；Office 互操作测试需要 Python 3 和 openpyxl，可设置 SIMPLE_AGENT_PYTHON，默认尝试 Codex 捆绑 Python（Windows）或 python3。便携程序不依赖外部 Node、Python 或 Office。

导出 Excel 实机测试副本：创建 test-results，设置 SIMPLE_AGENT_INTEROP_OUTPUT 为其中的 reliability-cache.xlsx，执行 `npx vitest run tests/documents-reliability.test.ts`，再运行 scripts/verify-excel.ps1。脚本只操作规定名称的测试副本，创建自己的隐藏 Excel 实例并在 finally 关闭，不复用用户实例。

文件写入/损坏/崩溃模拟均使用临时目录或 test-results；测试密钥为虚构值，没有使用用户原文件、真实登录账户或付费额度。

## 交付核对

- 运行包：`release/Simple-Agent-0.2.1-win-x64.zip`。测试对象为其中的 `Simple Agent.exe`，运行时确认为 Electron 44.5.1 / Node 24.21.0。
- 已解压至 `D:\Simple-Agent-0.2.1-win-x64`，启动文件为 `D:\Simple-Agent-0.2.1-win-x64\Simple Agent.exe`。全部 78 个文件的 SHA-256 与通过验收的 win-unpacked 目录一致；旧版本目录未改动。
- 源码完整保留在项目目录，包含锁文件、测试、构建脚本、资源及文档。按用户的精简要求，已删除重复源码 ZIP、旧版本包、win-unpacked、开发依赖和测试临时数据；上述测试结果是清理前的验收记录。恢复开发先运行 `npm ci`，需要源码包时再运行 `node scripts/package-source.mjs`。
- 交付校验清单：`release/Simple-Agent-0.2.1-checksums.sha256`。

## 未验证与边界

- 未验证真实供应商 OAuth 页面、真实账号权限和模型效果。OAuth/刷新使用模拟服务；实际协议参数已检查。
- LAN 信任/DNS 防护已测，未连接用户真实 NAS/WSL2/vLLM；不保证所有代理的特殊 DNS 模式兼容。
- Excel 实机覆盖标准测试工作簿，不代表全部 Office 高级格式；复杂结构仍保护。
- 未模拟断电/硬盘故障或恶意进程持续替换目录；多文件可恢复，不是系统级全局原子提交。
- 未在另一台无开发环境的实体 Windows 机器测试；便携应用自带 Electron/Node，测试应用流程不调用外部解释器或 Office。
- Windows ZIP 未代码签名。

本轮问题与修复见 [体验审查报告](EXPERIENCE-AUDIT.md)；0.2.0 的核心可靠性整改见 [整改报告](RELIABILITY-AUDIT.md)。


本轮恢复的开发依赖、构建产物和测试副本已在验收后清理；release 仅保留最新 0.2.1 ZIP 和校验清单。项目源码、测试与必要资源逐文件核对未被清理改变。
