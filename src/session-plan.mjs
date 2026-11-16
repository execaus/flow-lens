import { createHash } from 'node:crypto'
import { lstat, mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'

const prefix = 'flow-lens-session-'
export const sessionDirectoryVariable = 'FLOW_LENS_SESSION_DIR'

export async function createSessionRoot() {
  return mkdtemp(join(await realpath(tmpdir()), prefix))
}

export function sessionPlanFile(root, sessionId) {
  const digest = createHash('sha256').update(sessionId).digest('hex')
  const directory = join(root, digest)
  return { mode: 'temp', directory, path: join(directory, 'plan.json') }
}

export async function isSessionRoot(root) {
  return isAbsolute(root) && basename(root).startsWith(prefix) &&
    (await realpath(root)) === root && (await lstat(root)).isDirectory()
}
