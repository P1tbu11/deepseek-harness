import { describe, expect, it } from 'vitest'
import { approvalDisplayReason, permissionDetail } from '../src/approval-copy.ts'

describe('CodeBuddy approval copy', () => {
  it('names the Bash command a human must judge before allowing', () => {
    const detail = permissionDetail({ command: 'grep -rn "stop hook" ~/.codebuddy/settings.json' })
    expect(detail).toBe('grep -rn "stop hook" ~/.codebuddy/settings.json')
    const copy = approvalDisplayReason('Bash', detail)
    expect(copy.en).toBe('CodeBuddy CLI asks to use Bash: grep -rn "stop hook" ~/.codebuddy/settings.json')
    expect(copy.zh).toContain('grep -rn "stop hook" ~/.codebuddy/settings.json')
    expect(new Set(Object.values(copy)).size).toBe(8)
  })

  it('falls back to the tool name when the input names no operation', () => {
    for (const input of [undefined, null, 'Bash', {}, { command: '   ' }, { other: 'x' }]) {
      expect(permissionDetail(input)).toBeUndefined()
      expect(approvalDisplayReason('Read', permissionDetail(input)).en).toBe('CodeBuddy CLI asks to use Read')
    }
  })

  it('reads a path or pattern when the tool is not a shell command', () => {
    expect(permissionDetail({ file_path: '/Users/bangbang/.codebuddy/settings.json' }))
      .toBe('/Users/bangbang/.codebuddy/settings.json')
    expect(permissionDetail({ pattern: 'stop hook' })).toBe('stop hook')
  })

  it('prefers the command when a request carries several candidate fields', () => {
    expect(permissionDetail({ path: '/tmp/x', command: 'ls -la' })).toBe('ls -la')
  })
})
