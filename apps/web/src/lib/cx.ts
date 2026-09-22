/** 拼 className：过滤掉 false / undefined，省得模板串里留下多余空格。 */
export function cx(...values: Array<string | false | undefined>): string {
  return values.filter(Boolean).join(' ');
}
