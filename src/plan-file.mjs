import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

const git = promisify(execFile)
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
const maxBytes = 128 * 1024
const fallback = '.flow-lens'
const statuses = new Set(['pending', 'in_progress', 'completed'])

export function normalizeSteps(list, textKey) {
  if (!Array.isArray(list) || list.length > 100) return null
  const steps = []
  for (const item of list) {
    const title = item?.[textKey]
    if (typeof title !== 'string' || !title.trim() || !statuses.has(item.status)) return null
    steps.push({ title: title.trim().slice(0, 500), status: item.status })
  }
  return steps
}

export async function createPlanFile(mode, workspacePath) {
  if (mode === 'temp') {
    const directory = await mkdtemp(join(await realpath(tmpdir()), 'flow-lens-'))
    return { mode, directory, path: join(directory, 'plan.json') }
  }

  if (!workspacePath || !isAbsolute(workspacePath)) throw new Error('workspace-unavailable')
  const root = await realpath(workspacePath)
  const name = `plan-${randomUUID()}.json`
  const relativePlan = `${fallback}/${name}`
  for (const path of [`${fallback}/`, relativePlan, `${relativePlan}.tmp`]) {
    // check-ignore skips tracked paths. Never pass --no-index here.
    await git('git', ['-C', root, 'check-ignore', '-q', '--', path],
      { env: gitEnv, timeout: 2500 }).catch(() => { throw new Error('not-ignored') })
  }
  const directory = join(root, fallback)
  await mkdir(directory, { mode: 0o700 }).catch((error) => {
    if (error.code !== 'EEXIST') throw error
  })
  if (!(await lstat(directory)).isDirectory()) throw new Error('unsafe-directory')
  return { mode, directory, path: join(directory, name) }
}

export async function readPlanFile({ directory, path }) {
  try {
    if ((await realpath(directory)) !== directory) return { state: 'invalid' }
    const entry = await lstat(path)
    if (!entry.isFile() || entry.size > maxBytes) return { state: 'invalid' }

    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
      if (!(await file.stat()).isFile()) return { state: 'invalid' }
      const buffer = Buffer.alloc(maxBytes + 1)
      let size = 0
      while (size < buffer.length) {
        const { bytesRead } = await file.read(buffer, size, buffer.length - size, size)
        if (bytesRead === 0) break
        size += bytesRead
      }
      if (size > maxBytes) return { state: 'invalid' }
      const data = JSON.parse(buffer.toString('utf8', 0, size))
      const steps = data?.version === 1 ? normalizeSteps(data.steps, 'title') : null
      return steps === null ? { state: 'invalid' } : { state: 'ready', steps }
    } finally {
      await file.close()
    }
  } catch (error) {
    return { state: error.code === 'ENOENT' ? 'waiting' : 'invalid' }
  }
}

export function removeTemporaryDirectory(directory) {
  return rm(directory, { recursive: true, force: true })
}
