import { readFileSync } from 'node:fs'
import { mkdir, realpath } from 'node:fs/promises'
import { isSessionRoot, sessionDirectoryVariable, sessionPlanFile } from './session-plan.mjs'

async function main() {
  const root = process.env[sessionDirectoryVariable]
  if (!root || !(await isSessionRoot(root))) return
  const { hook_event_name: event, session_id: sessionId } = JSON.parse(readFileSync(0, 'utf8'))
  if (event !== 'SessionStart' || typeof sessionId !== 'string' || !sessionId.trim()) return

  const { directory, path } = sessionPlanFile(root, sessionId)
  await mkdir(directory, { mode: 0o700 }).catch((error) => {
    if (error.code !== 'EEXIST') throw error
  })
  if ((await realpath(directory)) !== directory) return

  const additionalContext = [
    'If the current task has a plan, keep it in sync with Flow Lens. Publish the full plan when you start following it, then update it when a step changes state or the plan changes.',
    `Use the absolute file path ${JSON.stringify(path)}. Write JSON to ${JSON.stringify(path + '.tmp')} and rename it over the plan file.`,
    'Use this format: {"version":1,"steps":[{"title":"Short step name","status":"in_progress"}]}. Valid statuses: pending, in_progress, completed. Use short step names in the user’s language.',
    'For a simple task, skip planning. When starting a different task without a plan, clear any previous plan by replacing it with {"version":1,"steps":[]}.',
    'Use normal file operations. If the temporary path is unavailable, continue the task without publishing the plan.'
  ].join('\n')
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } }))
}

// The session can start normally if the plugin or its temporary directory is unavailable.
await main().catch(() => {})
