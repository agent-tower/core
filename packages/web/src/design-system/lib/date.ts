/** 按日历加减天数（保留本地时区的年月日），跨夏令时也不会错一天——不要用毫秒相加 */
export function addDays(date: Date, days: number) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days)
}
