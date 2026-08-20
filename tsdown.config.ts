// dsh-system-monitor client bundle 配置。
// 契约（来自 DSH 的 packages/client/tsdown.client.ts clientConfig）：
//   - format 必须为 'cjs'，产物为 window.__ModuleLoader__.load({ id, factory })
//     闭包工厂格式，factory 通过注入的 require 从 Loader 模块表解析 external
//   - external 只包括 shell 基线（PLATFORM_MODULES + PRELOADED_CLIENT_EXTERNALS）
//     + 本包 dsh.client.external 声明；其余依赖必须 inline
//   - clean 必须关闭（不碰 host 半套的 tsc 产物）
// 本仓库不安装 tsdown（由 DSH checkout 的 .bin 执行），故配置不 import 任何包。
export default {
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  clean: false,
  sourcemap: true,
  deps: {
    neverBundle: [
      'react',
      'react/jsx-runtime',
      'react-dom',
      'react-dom/client',
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-client-ui-slots',
      '@deepseek-ai/dsh-client-ui-primitives',
      '@deepseek-ai/dsh-client-runtime/client',
    ],
    alwaysBundle: (specifier) => ![
      'react',
      'react/jsx-runtime',
      'react-dom',
      'react-dom/client',
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-client-ui-slots',
      '@deepseek-ai/dsh-client-ui-primitives',
      '@deepseek-ai/dsh-client-runtime/client',
    ].includes(specifier),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "dsh-system-monitor", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}
