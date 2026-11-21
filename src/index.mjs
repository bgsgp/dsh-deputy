// 兼容入口：默认导出仍是「桌面（os）」组件。
//
// 0.2.2 起这个包在插件管理器里是两个组件，各自有自己的 Cordis 入口：
//   dsh-deputy/os      → src/os.mjs      （isolated desktop，主入口，package.json 的 dsh.bundle.patch 用它）
//   dsh-deputy/browser → src/browser.mjs （浏览器操作骨架）
// 本文件保持老路径可解析（测试、MCP 形态、外部 import 'dsh-deputy' 都还走这里）。
export * from './os.mjs'
