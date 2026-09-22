/**
 * 顶部栏：品牌 + 面包屑。
 *
 * 本步只渲染根看板，所以面包屑只有一段。导航做出来后改为读 `GET /api/breadcrumb/:taskId`：
 * 那时「根看板」这一段的标题由后端给出（见 docs/decisions.md D11），这里的常量就该删掉。
 */
const ROOT_BOARD_TITLE = '根看板';

export function TopBar() {
  return (
    <header className="flex h-[46px] flex-none items-center gap-3 border-b border-line bg-surface px-3.5">
      {/* 品牌就是页面的 h1：看板里的列用 h2、卡片用 h3，标题层级不悬空。 */}
      <h1 className="flex items-center gap-1.5 font-semibold tracking-[0.2px]">
        <span className="grid size-4 place-items-center rounded-[4px] bg-accent text-white">
          {/* 三条长短线，取自定版原型 A 的品牌标；纯装饰，对读屏隐藏。 */}
          <svg
            width="9"
            height="9"
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M2.5 3.5h9M2.5 7h6M2.5 10.5h4" />
          </svg>
        </span>
        看板
      </h1>
      <span className="h-[18px] w-px flex-none bg-line" />
      <nav className="min-w-0 text-[12.5px]" aria-label="面包屑">
        <span className="px-[7px] py-[3px] font-semibold text-ink">{ROOT_BOARD_TITLE}</span>
      </nav>
    </header>
  );
}
