import { Fragment } from 'react';
import type { KeyboardEvent } from 'react';
import type { BreadcrumbItem } from '../api/types';
import { BrandMark } from './BrandMark';
import { SearchBox } from './SearchBox';
import { ThemeToggle } from './ThemeToggle';

/** 搜索框是一个受控控件：关键词与按键处理都在 BoardPage，这里只负责把它摆进顶栏。 */
export interface TopBarSearch {
  keyword: string;
  onKeywordChange: (keyword: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
}

/**
 * 顶部栏：品牌 + 面包屑 + 搜索框 + 主题控件。
 *
 * 面包屑由 `GET /api/breadcrumb/:taskId` 给出（见 docs/spec.md）；根看板那一段没有任务可查，
 * 由 src/hooks/useBreadcrumb.ts 用同一个文案常量补上。crumbs 为 null 表示还没拿到（加载中或失败），
 * 此时只显示品牌，不留半截面包屑。
 */
export function TopBar({
  crumbs,
  onNavigate,
  search,
}: {
  crumbs: BreadcrumbItem[] | null;
  onNavigate: (boardId: string | null) => void;
  search: TopBarSearch;
}) {
  return (
    <header className="flex h-[46px] flex-none items-center gap-3 border-b border-line bg-surface px-3.5">
      {/* 品牌就是页面的 h1：看板里的列用 h2，标题层级不悬空。 */}
      <h1 className="flex flex-none items-center gap-1.5 font-semibold tracking-[0.2px]">
        <BrandMark />
        脉络
      </h1>
      <span className="h-[18px] w-px flex-none bg-line" />
      {/* 层级深的时候面包屑会长过顶栏，这里让它横向滚动，而不是把最后一段（当前位置）挤掉。 */}
      <nav
        className="flex min-w-0 items-center overflow-x-auto text-[12.5px]"
        aria-label="面包屑"
      >
        {crumbs?.map((crumb, index) => {
          const isCurrent = index === crumbs.length - 1;
          return (
            <Fragment key={crumb.id ?? '根看板'}>
              {index > 0 && <span className="select-none px-px text-ink-3">/</span>}
              {isCurrent ? (
                // 当前层不可点：它就是当前位置，点它没有去处。
                <span
                  aria-current="page"
                  className="whitespace-nowrap rounded-[5px] px-[7px] py-[3px] font-semibold text-ink"
                >
                  {crumb.title}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => onNavigate(crumb.id)}
                  className="whitespace-nowrap rounded-[5px] px-[7px] py-[3px] text-ink-2 hover:bg-track hover:text-ink"
                >
                  {crumb.title}
                </button>
              )}
            </Fragment>
          );
        })}
      </nav>
      {/* 搜索框自带 ml-auto，把「面包屑」与「搜索框 + 主题控件」分成左右两组。 */}
      <SearchBox
        value={search.keyword}
        onValueChange={search.onKeywordChange}
        onKeyDown={search.onKeyDown}
      />
      {/* flex-none：面包屑再长也不该压扁它。 */}
      <ThemeToggle />
    </header>
  );
}
