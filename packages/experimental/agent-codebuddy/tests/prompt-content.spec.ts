/**
 * Prompt shaping for the CodeBuddy CLI.
 *
 * Text stays a plain string, and an attached image is named in that text as a
 * link inside the session directory. The CLI ships `ViewImage`, a local tool
 * the model calls when the prompt names a path — a probe against build 2.181.0
 * confirmed it follows a symlink out of the session directory and answers from
 * the target's pixels. The link carries the media type's extension because the
 * attachment store names objects by sha256 with none, and `ViewImage` refuses a
 * path without one; the store therefore stays the only place bytes are written.
 */
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { existsSync, lstatSync, readlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { IMAGE_STAGE_DIR, promptContent, promptText } from '../src/driver.ts'

/** Smallest valid PNG, used only for its bytes. */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** Content-addressed object name, as the attachment store writes it. */
const OBJECT_ID = 'c0c1314affbf8f93a9993814db2571604a195e3a9dc36bb47321424800135928'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(run => run()))
})

function imageRef(mediaType = 'image/png') {
  return { attachmentId: AttachmentId(OBJECT_ID), mediaType, bytes: 68, width: 1, height: 1 } as const
}

function messageWith(content: readonly unknown[]) {
  return createUserMessage({ content, source: { kind: 'user' } } as never)
}

/** A session cwd plus a store object that lives outside it, as in production. */
async function workspace(): Promise<{ cwd: string; object: string }> {
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-image-'))
  cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
  const object = join(root, 'store', 'c0', OBJECT_ID)
  const { mkdir } = await import('node:fs/promises')
  await mkdir(join(root, 'store', 'c0'), { recursive: true })
  await writeFile(object, Buffer.from(PNG_BASE64, 'base64'))
  return { cwd: join(root, 'work'), object }
}

describe('promptContent', () => {
  it('returns the plain text when the message has no image', async () => {
    const { cwd } = await workspace()
    const message = messageWith([{ type: 'text', text: 'hello' }])
    expect(promptContent(message, { cwd, hostPath: () => undefined })).toBe('hello')
  })

  it('joins multiple text blocks with a newline', async () => {
    const { cwd } = await workspace()
    const message = messageWith([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])
    expect(promptContent(message, { cwd, hostPath: () => undefined })).toBe('a\nb')
  })

  it('links the store object with the media type extension instead of copying it', async () => {
    const { cwd, object } = await workspace()
    const message = messageWith([
      { type: 'text', text: 'what colour?' },
      { type: 'image', attachment: imageRef() },
    ])
    const prompt = promptContent(message, { cwd, hostPath: () => object })
    const link = join(cwd, IMAGE_STAGE_DIR, `${OBJECT_ID}.png`)
    expect(prompt).toBe(`what colour?\n[image: ${IMAGE_STAGE_DIR}/${OBJECT_ID}.png]`)
    // A symlink, not a copy: no bytes are written beside the session.
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readlinkSync(link)).toBe(object)
    expect((await stat(link)).size).toBe(Buffer.from(PNG_BASE64, 'base64').length)
    // The store object is still the only file holding the image.
    expect((await readFile(object)).equals(Buffer.from(PNG_BASE64, 'base64'))).toBe(true)
  })

  it('picks the extension from the declared media type', async () => {
    for (const mediaType of ['image/jpeg', 'image/webp'] as const) {
      const { cwd, object } = await workspace()
      const message = messageWith([{ type: 'image', attachment: imageRef(mediaType) }])
      const prompt = promptContent(message, { cwd, hostPath: () => object })
      expect(prompt).toBe(`[image: ${IMAGE_STAGE_DIR}/${OBJECT_ID}.${mediaType.split('/')[1]}]`)
    }
  })

  it('names an image even when the message carries no text', async () => {
    const { cwd, object } = await workspace()
    const message = messageWith([{ type: 'image', attachment: imageRef() }])
    expect(promptContent(message, { cwd, hostPath: () => object }))
      .toBe(`[image: ${IMAGE_STAGE_DIR}/${OBJECT_ID}.png]`)
  })

  it('reuses one link when the same image appears twice', async () => {
    const { cwd, object } = await workspace()
    const message = messageWith([
      { type: 'text', text: 'compare' },
      { type: 'image', attachment: imageRef() },
      { type: 'image', attachment: imageRef() },
    ])
    const prompt = promptContent(message, { cwd, hostPath: () => object })
    // The same content-addressed object maps to one link, so a repeat costs no
    // extra directory entry.
    expect(prompt.match(/\[image: [^\]]+\]/g)).toEqual([
      `[image: ${IMAGE_STAGE_DIR}/${OBJECT_ID}.png]`,
      `[image: ${IMAGE_STAGE_DIR}/${OBJECT_ID}.png]`,
    ])
  })

  it('refuses an image whose object was pruned instead of linking a dead path', async () => {
    const { cwd, object } = await workspace()
    const message = messageWith([
      { type: 'text', text: 'look' },
      { type: 'image', attachment: imageRef() },
    ])
    // The store can be pruned after the message was recorded; a link to the
    // missing object would still lint as a symlink and send the model hunting.
    await rm(object, { force: true })
    expect(() => promptContent(message, { cwd, hostPath: () => object }))
      .toThrow(/UNSUPPORTED_INPUT.*attachment object is gone/)
    expect(existsSync(join(cwd, IMAGE_STAGE_DIR, `${OBJECT_ID}.png`))).toBe(false)
  })

  it('names no tool when the CLI build lacks ViewImage', async () => {
    const { cwd, object } = await workspace()
    const message = messageWith([
      { type: 'text', text: 'look' },
      { type: 'image', attachment: imageRef() },
    ])
    const prompt = promptContent(message, { cwd, hostPath: () => object, viewImage: false })
    // Naming a tool the build does not have would strand the model; the path
    // alone is enough for it to reach for `Read`.
    expect(prompt).toBe(`look\n[image file: ${IMAGE_STAGE_DIR}/${OBJECT_ID}.png — open it with Read]`)
    expect(prompt).not.toContain('ViewImage')
  })

  it('replaces a stale link from an earlier turn', async () => {
    const { cwd, object } = await workspace()
    const link = join(cwd, IMAGE_STAGE_DIR, `${OBJECT_ID}.png`)
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(cwd, IMAGE_STAGE_DIR), { recursive: true })
    // A dangling link is what an interrupted earlier turn would leave.
    await symlink(join(cwd, 'gone.png'), link)
    const message = messageWith([{ type: 'image', attachment: imageRef() }])
    expect(() => promptContent(message, { cwd, hostPath: () => object })).not.toThrow()
    expect(readlinkSync(link)).toBe(object)
    expect(existsSync(link)).toBe(true)
  })

  it('refuses an image whose object is not on this host', async () => {
    const { cwd } = await workspace()
    const message = messageWith([
      { type: 'text', text: 'look' },
      { type: 'image', attachment: imageRef() },
    ])
    expect(() => promptContent(message, { cwd, hostPath: () => undefined }))
      .toThrow(/UNSUPPORTED_INPUT.*cannot read image/)
  })
})

describe('promptText', () => {
  it('accepts images without turning them into text', () => {
    const message = messageWith([
      { type: 'text', text: 'look' },
      { type: 'image', attachment: imageRef() },
    ])
    expect(promptText(message)).toBe('look')
  })

  it('still refuses block types the CLI cannot carry', () => {
    const message = messageWith([{ type: 'file', attachment: { fileId: 'f1' } }])
    expect(() => promptText(message)).toThrow(/refused block types file/)
  })
})
