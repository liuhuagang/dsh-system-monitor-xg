# dsh-system-monitor-xg

**简体中文** · [English](README_EN.md)

DSH（DeepSeek Harness）宿主机负载监控插件：**CPU 占用 + 温度 / 内存 / GPU
算力与显存带宽利用率、显存、功耗、核心/显存温度**实时显示，并自动诊断推理
瓶颈——**「GPU 占用高 ≠ 算力打满」**：decode 阶段 SM 大量时间在等显存返回
数据，瓶颈常常是显存带宽而不是算力。

[![DSH](https://img.shields.io/badge/DSH-0.1.0--rc.7-blue)](https://github.com/deepseek-ai/deepseek-harness)
[![npm version](https://img.shields.io/npm/v/dsh-system-monitor-xg)](https://www.npmjs.com/package/dsh-system-monitor-xg)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

## 解决什么问题

nvidia-smi 有两个**正交**的利用率数字：

| 指标 | 含义 |
|---|---|
| `utilization.gpu` | **SM 算力利用率**（计算单元活跃占比） |
| `utilization.memory` | **显存带宽控制器利用率**（≈ 带宽占用，注意不是显存占用！） |

两者组合即可回答「GPU 很忙，忙在算力还是带宽」：

| 现象 | 诊断 |
|---|---|
| SM 高 + 带宽高 + 功耗低 | **带宽受限**（decode 典型：算力等显存） |
| SM 高 + 带宽低 | **算力受限**（prefill 典型：计算饱和） |
| 功耗 ≈ 上限 | 功耗墙 |
| 显存占用 > 95% | 显存容量瓶颈（上下文受限） |
| 核心高温 + SM 时钟降频，或显存温度 ≥ 95℃ | 热限制 |

## 特性

- **Web 底栏实时显示**：CPU% + CPU 温度（`52℃`，ACPI 热区，5s 采样；
  平台无传感器或权限不足时隐藏）、内存%、每张 GPU 的 SM 算力 / 显存带宽 /
  显存 / 功耗 / 核心+显存温度（`77/68℃`；驱动未上报显存温度时仅核心温度），
  叠加瓶颈徽标（算力=蓝、带宽=琥珀、功耗=橙、热/显存=红）
- **生成阶段对比**：点击底栏展开最近 10 次生成的 **prefill vs decode**
  两阶段负载统计——prefill 算力密集、decode 带宽密集，两阶段对比是
  「占用高但算力不满」的量化证据
- **agent 工具 `system_metrics`**：会话内随时查询负载快照、瓶颈诊断、
  生成阶段对比、显存占用进程（评测报告可直接引用）
- **负载 JSONL 落盘**：`~/.dsh/dsh-system-monitor/metrics-<日期>.jsonl`
  （每秒采样）+ `generations-<日期>.jsonl`（每次生成的阶段汇总）
- **零运行时依赖**：CPU/内存用 Node 内置 API，CPU 温度走 WMI（Windows）/
  sysfs（Linux），GPU 解析 `nvidia-smi` CSV——无需 pip、无需原生模块、
  无需管理员权限（CPU 温度在 Windows 上依赖 `root/wmi` 访问权限，见已知限制）
- 多 GPU 支持（取最活跃 GPU 做瓶颈诊断）

## 安装（给使用者）

```sh
# 1. 安装插件（从 npm，无需 clone 仓库）
dsh plugin --profile web add dsh-system-monitor-xg

# 2. 重启 DSH Web（生产模式无热装机制；重启方式与你平时启动 dsh 一致）
#    重启后打开任意会话页，输入框下方（内置统计行右侧）出现负载条：
#    CPU 12% 内存 34% │ GPU0 SM 45% 带宽 88% 显存 12/24G 160W 66/62℃ ●带宽受限

# 3. 验证
#    - 底栏每秒刷新；跑一次本地推理可见瓶颈徽标变化（带宽受限/算力受限…）
#    - 点击底栏展开最近生成的 prefill/decode 阶段对比
#    - 会话里让 agent 调用：system_metrics（查询负载/瓶颈/阶段统计）
#    - 负载数据落盘 ~/.dsh/dsh-system-monitor/（metrics-<日期>.jsonl）

# 4. 升级
dsh plugin --profile web update dsh-system-monitor-xg

# 5. 卸载
dsh plugin --profile web remove dsh-system-monitor-xg
```

> 环境要求：NVIDIA GPU + 驱动自带 nvidia-smi（Windows 在 System32，Linux 在
> /usr/bin）；无 NVIDIA GPU 时插件正常加载，GPU 段显示「不可用」，CPU/内存
> 监控不受影响。nvidia-smi 调用失败（驱动瞬态异常、GPU 复位、超时等）不会
> 永久停用 GPU 监控：失败后自动进入冷却期重试（瞬态 5s / 二进制缺失 5min），
> 采样成功即自动恢复；失败原因会打 host 日志并可通过 `system_metrics` 的
> `lastGpuError` 字段查询。开发模式（想改代码调试）用
> `dsh plugin --profile web add <本仓库路径>`。

## 使用

- 底栏每 1 秒刷新一次，直接可读：
  `CPU 12% 42℃ 内存 34% │ GPU0 SM 45% 带宽 88% 显存 12.4/24G 160W 66/62℃ ●带宽受限`
  （CPU 温度段紧随 CPU 占用段，平台无传感器或权限不足时隐藏；GPU 温度段为
  `核心/显存℃`，驱动未上报显存温度时退化为单值 `66℃`）
- 悬停查看细节（单核分布 / 时钟 / 功耗上限 / 核心与显存温度）；点击展开生成阶段对比表
- Agent 会话中直接调用工具（例）：
  ```
  使用 system_metrics 工具查询当前负载和瓶颈，history=5, generations=5
  ```

## REST API（host 侧，供脚本/底栏轮询）

| 端点 | 说明 |
|---|---|
| `GET /system-monitor/api/snapshot?light=1` | 最新采样（light 只回 now，底栏轮询用） |
| `GET /system-monitor/api/snapshot` | 最新采样 + 最近 60 条历史 + 最近 10 次生成 |
| `GET /system-monitor/api/generations?limit=20` | 生成阶段汇总 |
| `GET /system-monitor/api/history?window=120` | 采样历史窗口 |
| `GET /system-monitor/api/processes` | 显存占用进程（Windows 上可能无权限读显存值） |

## 配置（cordis.patch.yml insert 的 config）

```yaml
- insert:
    - id: dsh-system-monitor-xg
      name: 'dsh-system-monitor-xg'
      config:
        intervalMs: 1000    # 采样间隔（250–10000ms）
        historySize: 3600   # 内存环形缓冲条数
        persist: true       # JSONL 落盘开关
```

## 开发

```sh
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build.ps1
# 构建产物：lib/index.js（host）+ lib/client.js（浏览器 bundle）+ lib/types/
```

- 构建脚本自动 junction 类型依赖到 `D:\deepseek-harness`（`$env:DSH_CHECKOUT`
  可覆盖），用 checkout 的 tsc / tsdown，本仓库无需 `npm install`
- 安装为 `link:` 方式时，改代码后**重新构建即生效**（重启 DSH Web 后）
- 结构：`src/` host（采样 `cpu.ts` / `gpu.ts` / `thermal.ts`（CPU 温度，
  5s 慢通道）、诊断 `bottleneck.ts`、阶段跟踪 `sampler.ts`、落盘
  `ledger.ts`、入口 `index.ts`）、
  `src/client/` 浏览器端（`SystemBar.tsx` 底栏、`fetch.ts` 同步 XHR 轮询）

### 关键技术决策

- **数据通道**：底栏 1s 轮询 host REST API（同步 XHR——DSH web 环境会随机
  stall 异步 fetch，社区 dsh-status-bar 踩坑后的结论）
- **阶段边界**：`request/header`（prefill 开始）→ 首个 `assistant/chunk`
  （decode 开始）→ `assistant/message`（结束）
- **瓶颈阈值**：`bottleneck.ts` 中纯函数，判据顺序
  idle → 显存容量 → 热限制 → 功耗墙 → 带宽 → 算力 → 均衡

## 已知限制

- Windows 下 `nvidia-smi --query-compute-apps` 读进程显存需要管理员权限，
  无权限时 usedMb 为 0（进程名仍可见）
- 并非所有驱动都暴露显存温度传感器（`temperature.memory` 回 `N/A`，例如
  RTX PRO 6000 Blackwell 在部分驱动下）：此时温度段只显示核心温度，
  诊断证据 `memTempC` 为 null 且不参与热限制判定；驱动支持后自动生效
- Windows 的 CPU 温度来自 WMI `root/wmi:MSAcpi_ThermalZoneTemperature`
  （全部热区均值，0.1℃ 原始值 /10），经 `powershell -NoProfile` 每 5s 查询
  一次。`root/wmi` 命名空间常被机器策略限制为仅管理员可读：拒绝访问时
  底栏不显示 CPU 温度段、`system_metrics` 的 `lastCpuThermalError` 给出原因，
  5min 冷却后自动重试——以管理员身份启动 DSH（或放宽 WMI 策略）后自动生效，
  无需改配置。部分笔记本/虚拟机不暴露 ACPI 热区，此时同样为 null
- 阶段统计依赖采样点落在 prefill/decode 窗口内；极短生成（< 采样间隔）可能
  无采样点
- 底栏挂在会话页（composer.dock），无会话时不显示（与内置统计行一致）

## License

MIT
