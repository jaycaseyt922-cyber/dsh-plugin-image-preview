// 测试用临时素材：不依赖本机任何绝对路径，谁 clone 下来都能跑。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A 1×1 transparent PNG. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

/**
 * Build a throwaway directory with the files the tests need.
 * @returns {{ dir: string, png: string, subPng: string, mangled: string, notImage: string, dispose: () => void }}
 */
export function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-imgprev-'))
  const png = join(dir, 'tiny.png')
  writeFileSync(png, Buffer.from(PNG_BASE64, 'base64'))
  const subDir = join(dir, '_sub')
  mkdirSync(subDir)
  const subPng = join(subDir, 'pic.png')
  writeFileSync(subPng, Buffer.from(PNG_BASE64, 'base64'))
  // What a Markdown-escaped separator does to "<dir>\_sub\pic.png": the
  // backslash before the underscore is eaten, so the directory name loses
  // its separator.
  const mangled = join(dir + '_sub', 'pic.png')
  const notImage = join(dir, 'notes.txt')
  writeFileSync(notImage, 'not an image')
  return {
    dir,
    png,
    subPng,
    mangled,
    notImage,
    dispose: () => {
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
