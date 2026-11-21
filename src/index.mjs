// 包根入口 —— 只当「客户端锚点」，不含任何工具。
//
// 0.2.2 的 client-modules 只认「loader row 的 name 恰好等于包根名」的包来发现 dsh.client
// （dsh-client-modules/src/client/manifest.ts 的 exactPackageSpecifier 遇到子路径直接返回
// undefined，locatePkgJson 随后放弃这一行）。所以 cordis.patch.yml 里除了两个真组件：
//   dsh-deputy/os      → src/os.mjs      隔离桌面 + 面板端点 + deputy_* 五个工具
//   dsh-deputy/browser → src/browser.mjs 浏览器操作骨架 + browser_* 五个工具
// 还必须有一条 name 为包根 'dsh-deputy' 的 row；它没有 id，所以插件管理器的「包含的组件」
// 里不占一行，只负责让 client.js 被服务端发现并塞进 __DSH_BOOT__ 的模块图。
//
// 本文件同时保留老路径兼容：测试、MCP 形态、外部 import 'dsh-deputy' 都还从这里拿东西。
export * as os from './os.mjs'

export const name = 'dsh-deputy'
export const inject = []
export function apply() {}

export { toParameters, registerTools, text } from './registry.mjs'
export { toolSpecs } from './os.mjs'
