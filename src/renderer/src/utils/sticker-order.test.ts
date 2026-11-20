import { describe, expect, it } from 'vitest'
import { moveSticker } from './sticker-order'

/** 拖动、按钮与键盘共享同一排列语义，不能丢失或复制收藏。 */
describe('表情管理排序', () => {
  it('向前和向后均移到目标位置，保留原输入', () => {
    const ids=['a','b','c','d']
    expect(moveSticker(ids,'a','c')).toEqual(['b','c','a','d'])
    expect(moveSticker(ids,'d','b')).toEqual(['a','d','b','c'])
    expect(ids).toEqual(['a','b','c','d'])
  })
  it.each([['a','a'],['absent','b'],['a','absent']])('无效拖放不改变排列 %s → %s', (from,to) => {
    expect(moveSticker(['a','b'],from,to)).toEqual(['a','b'])
  })
})
