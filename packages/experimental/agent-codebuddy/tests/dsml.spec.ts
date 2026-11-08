/**
 * Inline tool-markup stripping.
 *
 * The sample strings here are byte-for-byte copies of what a real CodeBuddy
 * session recorded, including the truncated closing tag (`</｜｜ parameter>`)
 * that a model actually produced. They are the regression fixture for a bug the
 * transcript showed as literal markup.
 */
import { describe, expect, it } from 'vitest'
import { hasInlineToolCall, stripInlineToolCalls } from '../src/dsml.ts'

/** One assistant text block captured from a live Session. */
const RECORDED = '\n\n<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="bash">\n<｜｜DSML｜｜ parameter name="command" string="true">ls -lt /Users/bangbang/.dsh/attachments/v1/objects/*/* 2>/dev/null | head -5</｜｜ parameter>\n<｜｜DSML｜｜ parameter name="description" string="true">列出最近的附件文件</｜｜ parameter>\n</｜｜ invoke>\n</｜｜ calls>'

describe('inline tool markup', () => {
  it('detects the markup a live session recorded', () => {
    expect(hasInlineToolCall(RECORDED)).toBe(true)
  })

  it('removes a markup-only block entirely', () => {
    // Nothing is left to show, which is correct: the model said nothing in prose.
    expect(stripInlineToolCalls(RECORDED)).toBe('')
  })

  it('keeps the prose around a block', () => {
    const mixed = '好的，我先看一下目录。\n\n<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="bash">\n<｜｜DSML｜｜ parameter name="command" string="true">ls</｜｜ parameter>\n</｜｜ invoke>\n</｜｜ calls>\n\n以上就是结果。'
    const stripped = stripInlineToolCalls(mixed)
    expect(stripped).toContain('好的，我先看一下目录。')
    expect(stripped).toContain('以上就是结果。')
    expect(stripped).not.toContain('｜DSML｜')
    expect(stripped).not.toContain('invoke')
  })

  it('removes a marker whose enclosing block was truncated away', () => {
    // A stream cut mid-call leaves the inner tags without their wrapper.
    const truncated = '前面的话\n<｜｜DSML｜｜ invoke name="bash">\n<｜｜DSML｜｜ parameter name="command" string="true">ls'
    expect(hasInlineToolCall(truncated)).toBe(true)
    const stripped = stripInlineToolCalls(truncated)
    expect(stripped).toContain('前面的话')
    expect(stripped).not.toContain('invoke')
    expect(stripped).not.toContain('｜DSML｜')
  })

  it('leaves ordinary prose untouched', () => {
    const prose = '这是一段完全正常的回复，包含 <标签> 和 | 竖线，还有 a < b 的比较。'
    expect(hasInlineToolCall(prose)).toBe(false)
    expect(stripInlineToolCalls(prose)).toBe(prose)
  })

  it('leaves fenced code untouched', () => {
    const code = '```js\nconst a = 1 < 2\nconst b = 3 > 2\n```'
    expect(hasInlineToolCall(code)).toBe(false)
    expect(stripInlineToolCalls(code)).toBe(code)
  })

  it('collapses the blank lines a removed block leaves behind', () => {
    const spaced = '第一段。\n\n\n\n<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="bash">\n</｜｜ invoke>\n</｜｜ calls>\n\n\n\n第二段。'
    expect(stripInlineToolCalls(spaced)).toBe('第一段。\n\n第二段。')
  })

  it('is idempotent', () => {
    const once = stripInlineToolCalls(RECORDED)
    expect(stripInlineToolCalls(once)).toBe(once)
  })
})
