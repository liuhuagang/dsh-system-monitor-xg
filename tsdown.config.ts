// tsdown config（无 import：本仓库不安装 tsdown，由 DSH checkout 的 .bin 执行，
// 配置里 import 'tsdown' 会解析失败）。
// React、Cordis 与 DSH 包都由 Web shell 的 module table 提供，不打进 bundle。
export default {
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'browser',
  deps: {
    neverBundle: ['react', 'react-dom', /^@deepseek-ai\//],
  },
}
