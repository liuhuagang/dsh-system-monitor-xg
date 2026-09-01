# dsh-system-monitor-xg

[简体中文](README.md) · **English**

DSH (DeepSeek Harness) host-machine load monitoring plugin: real-time display of
**CPU / memory / GPU compute and VRAM bandwidth utilization, VRAM, power,
temperature**, plus automatic inference bottleneck diagnosis — **"high GPU
utilization ≠ compute saturated"**: during the decode stage, SMs spend a large
part of their time waiting for data to come back from VRAM, so the bottleneck is
often VRAM bandwidth rather than compute.

[![DSH](https://img.shields.io/badge/DSH-0.1.0--rc.7-blue)](https://github.com/deepseek-ai/deepseek-harness)
[![npm version](https://img.shields.io/npm/v/dsh-system-monitor-xg)](https://www.npmjs.com/package/dsh-system-monitor-xg)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

## What problem does it solve

nvidia-smi reports two **orthogonal** utilization numbers:

| Metric | Meaning |
|---|---|
| `utilization.gpu` | **SM compute utilization** (fraction of compute units active) |
| `utilization.memory` | **VRAM bandwidth-controller utilization** (≈ bandwidth usage; note this is NOT VRAM usage!) |

Combined, they answer "the GPU is busy — busy on compute or on bandwidth?":

| Symptom | Diagnosis |
|---|---|
| High SM + high bandwidth + low power | **Bandwidth-bound** (typical of decode: compute waits on VRAM) |
| High SM + low bandwidth | **Compute-bound** (typical of prefill: compute is saturated) |
| Power ≈ cap | Power wall |
| VRAM usage > 95% | VRAM capacity bottleneck (context-limited) |
| High temperature + SM clock throttling | Thermal limit |

## Features

- **Real-time Web bottom-bar display**: CPU %, memory %, and per-GPU SM compute /
  VRAM bandwidth / VRAM / power / temperature, with overlay bottleneck badges
  (compute=blue, bandwidth=amber, power=orange, thermal/VRAM=red)
- **Generation-stage comparison**: click the bottom bar to expand the **prefill
  vs decode** two-stage load statistics for the last 10 generations — prefill is
  compute-intensive, decode is bandwidth-intensive; comparing the two stages is
  the quantitative evidence for "high utilization but compute not saturated"
- **Agent tool `system_metrics`**: query load snapshots, bottleneck diagnosis,
  generation-stage comparison, and VRAM-using processes at any time within a
  session (directly citable in evaluation reports)
- **Load JSONL written to disk**: `~/.dsh/dsh-system-monitor/metrics-<date>.jsonl`
  (sampled every second) + `generations-<date>.jsonl` (per-generation stage summary)
- **Zero runtime dependencies**: CPU/memory use Node built-in APIs, GPU parses
  `nvidia-smi` CSV — no pip, no native modules, no admin privileges
- Multi-GPU support (uses the most active GPU for bottleneck diagnosis)

## Installation (for users)

```sh
# 1. Install the plugin (from npm, no need to clone the repo)
dsh plugin --profile web add dsh-system-monitor-xg

# 2. Restart DSH Web (production mode has no hot-reload mechanism; restart the same
#    way you normally start dsh). After restart, open any session page; a load bar
#    appears below the input box (to the right of the built-in stats row):
#    CPU 12% 内存 34% │ GPU0 SM 45% 带宽 88% 显存 12/24G 160W 66℃ ●带宽受限

# 3. Verify
#    - The bottom bar refreshes every second; run a local inference to see the
#      bottleneck badge change (bandwidth-bound / compute-bound …)
#    - Click the bottom bar to expand the prefill/decode stage comparison for the
#      most recent generations
#    - In a session, have the agent call: system_metrics (query load / bottleneck /
#      stage statistics)
#    - Load data is written to disk under ~/.dsh/dsh-system-monitor/
#      (metrics-<date>.jsonl)

# 4. Upgrade
dsh plugin --profile web update dsh-system-monitor-xg

# 5. Uninstall
dsh plugin --profile web remove dsh-system-monitor-xg
```

> Environment requirements: NVIDIA GPU + the nvidia-smi bundled with the driver
> (Windows: System32, Linux: /usr/bin); without an NVIDIA GPU the plugin still
> loads normally, the GPU segment shows "unavailable", and CPU/memory monitoring
> is unaffected. For development mode (to tweak and debug the code) use
> `dsh plugin --profile web add <this repo path>`.

## Usage

- The bottom bar refreshes once every second and is directly readable:
  `CPU 12% 内存 34% │ GPU0 SM 45% 带宽 88% 显存 12.4/24G 160W 66℃ ●带宽受限`
- Hover to see details (per-core distribution / clocks / power cap); click to
  expand the generation-stage comparison table
- In an agent session, call the tool directly (example):
  ```
  使用 system_metrics 工具查询当前负载和瓶颈，history=5, generations=5
  ```

## REST API (host side, for scripts / bottom-bar polling)

| Endpoint | Description |
|---|---|
| `GET /system-monitor/api/snapshot?light=1` | Latest sample (light returns only `now`; used for bottom-bar polling) |
| `GET /system-monitor/api/snapshot` | Latest sample + last 60 history entries + last 10 generations |
| `GET /system-monitor/api/generations?limit=20` | Generation-stage summary |
| `GET /system-monitor/api/history?window=120` | Sampling history window |
| `GET /system-monitor/api/processes` | VRAM-using processes (may lack permission to read VRAM values on Windows) |

## Configuration (the `config` in the cordis.patch.yml `insert`)

```yaml
- insert:
    - id: dsh-system-monitor-xg
      name: 'dsh-system-monitor-xg'
      config:
        intervalMs: 1000    # sample interval (250–10000ms)
        historySize: 3600   # number of entries in the in-memory ring buffer
        persist: true       # whether to write JSONL to disk
```

## Development

> **Project rules**: repo positioning (internal engineering repo vs external
> publishing repo), development/commit/release conventions, and an architecture
> overview — see [AGENTS.md](AGENTS.md).

```sh
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build.ps1
# Build output: lib/index.js (host) + lib/client.js (browser bundle) + lib/types/
```

- The build script automatically junctions type dependencies to
  `D:\deepseek-harness` (overridable via `$env:DSH_CHECKOUT`), using the
  checkout's tsc / tsdown — no `npm install` needed for this repo
- When installed as a `link:`, rebuilding after changing code takes effect
  (after restarting DSH Web)
- Structure: `src/` host (sampling `cpu.ts` / `gpu.ts`, diagnosis
  `bottleneck.ts`, stage tracking `sampler.ts`, persistence `ledger.ts`, entry
  `index.ts`), `src/client/` browser side (`SystemBar.tsx` bottom bar,
  `fetch.ts` synchronous XHR polling)

### Key technical decisions

- **Data channel**: the bottom bar polls the host REST API every 1s (synchronous
  XHR — the DSH web environment randomly stalls async fetch; this is the lesson
  learned by the community dsh-status-bar)
- **Stage boundaries**: `request/header` (prefill starts) → first
  `assistant/chunk` (decode starts) → `assistant/message` (ends)
- **Bottleneck thresholds**: pure functions in `bottleneck.ts`, with the
  judgment order idle → VRAM capacity → thermal limit → power wall → bandwidth →
  compute → balanced

## Known limitations

- On Windows, reading per-process VRAM via `nvidia-smi --query-compute-apps`
  requires admin privileges; without them usedMb is 0 (process names are still
  visible)
- Stage statistics depend on samples landing within the prefill/decode window;
  very short generations (< sample interval) may have no samples
- The bottom bar is attached to the session page (composer.dock); it is not
  shown when there is no session (consistent with the built-in stats row)

## License

MIT
