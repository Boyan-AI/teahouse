/** 同一份排列同时用于拖动和键盘移动，未知/越界目标不改变原顺序。 */
export function moveSticker(ids: string[], from: string, to: string): string[] {
  const a=ids.indexOf(from), b=ids.indexOf(to), next=[...ids]
  if (a<0 || b<0 || a===b) return next
  next.splice(a,1); next.splice(b,0,from)
  return next
}
