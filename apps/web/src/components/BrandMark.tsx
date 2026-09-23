/**
 * 顶栏品牌标：脉络的图标母版（brand/icon.svg，由 scripts/build-icons.mjs 复制到 public/）。
 *
 * 为什么用 <img> 引母版，而不是在组件里内联一份 SVG 路径：那会让「四个折面」的几何
 * 在仓库里存在两份（母版一份、组件一份），改了一处忘了另一处时没有任何信号。
 * 代价是顶栏多一次静态资源请求，而它会被浏览器缓存，16px 的图标也没有闪烁问题。
 *
 * 尺寸默认 20 而不是 16：母版是按 512 画布做的应用图标，图形四周留了内边距
 * （M 只占画布 71% 宽、56% 高），直接按 16px 渲染会比旁边的 13px 文字还显小。
 *
 * 它是纯装饰——产品名「脉络」就在旁边，所以走 alt="" 让读屏跳过。
 */
export function BrandMark({ size = 20 }: { size?: number }) {
  return <img src="/icon.svg" width={size} height={size} alt="" className="flex-none" />;
}
