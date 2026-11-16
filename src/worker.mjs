import { createPlanFile, normalizeSteps, readPlanFile, removeTemporaryDirectory } from './plan-file.mjs'

const planTools = new Map([
  ['update_plan', ['plan', 'step']],
  ['functions.update_plan', ['plan', 'step']],
  ['TodoWrite', ['todos', 'content']]
])
function readSteps(tool, input) {
  const fields = planTools.get(tool)
  if (!fields) return null

  const [listKey, textKey] = fields
  return normalizeSteps(input?.[listKey], textKey)
}

let stop

export async function deactivate() {
  await stop?.()
}

export default function activate(orca) {
  const plans = new Map()
  const channels = new Map()
  const temporaryDirectories = new Set()
  const preparing = new Set()
  let checking = false
  let stopped = false
  let timer
  let nextRevision = 0

  function postChanged(workspaceId) {
    if (!stopped) orca.panels.post('flow.changed', { workspaceId })
  }

  async function readFiles() {
    if (checking) return
    checking = true
    const changed = new Set()
    try {
      await Promise.all([...channels.values()].map(async (channel) => {
        const result = await readPlanFile(channel.file)
        const signature = JSON.stringify(result)
        if (channel.signature === signature) return
        channel.signature = signature
        channel.state = result.state
        if (result.state === 'ready') channel.steps = result.steps
        if (result.state === 'waiting') channel.steps = null
        changed.add(channel.workspaceId)
      }))
      for (const workspaceId of changed) postChanged(workspaceId)
    } finally {
      checking = false
    }
  }

  stop = async () => {
    stopped = true
    clearInterval(timer)
    await Promise.allSettled([...temporaryDirectories].map(removeTemporaryDirectory))
  }

  async function currentWorkspace() {
    const context = await orca.host.call('workspace.readContext')
    if (!context?.workspaceId) return { workspaceId: null, agents: [] }

    const { agents } = await orca.host.call('agents.list')
    const latest = await orca.host.call('workspace.readContext')
    if (latest?.workspaceId !== context.workspaceId) return { workspaceId: null, agents: [] }

    const terminalIds = new Set(latest.terminals.map(({ id }) => id))
    return {
      workspaceId: latest.workspaceId,
      agents: agents.filter(({ terminalId }) => terminalIds.has(terminalId))
    }
  }

  orca.hooks.on('agent.tool.after', async ({ workspaceId, terminalId, tool, input }) => {
    if (!workspaceId || !terminalId) return
    const steps = readSteps(tool, input)
    if (steps === null) return

    const revision = ++nextRevision
    const workspace = await currentWorkspace()
    if (workspace.workspaceId !== workspaceId) return

    const agent = workspace.agents.find((item) => item.terminalId === terminalId)
    if (!agent) return

    const key = JSON.stringify([workspaceId, terminalId])
    if ((plans.get(key)?.revision ?? 0) >= revision) return

    plans.delete(key)
    plans.set(key, { revision, sessionId: agent.sessionId ?? null, steps })
    if (plans.size > 32) plans.delete(plans.keys().next().value)
    postChanged(workspaceId)
  })

  orca.panels.handle('flow.prepare', async (input) => {
    const { workspaceId, terminalId, sessionId, mode } = input ?? {}
    if (mode !== 'temp' && mode !== 'worktree') return { error: 'invalid-mode' }
    const workspace = await currentWorkspace()
    if (!workspaceId || workspace.workspaceId !== workspaceId ||
      !workspace.agents.some((agent) => agent.terminalId === terminalId && (agent.sessionId ?? null) === sessionId)) {
      return { error: 'session-changed' }
    }
    const key = JSON.stringify([workspaceId, terminalId, sessionId])
    if (channels.get(key)?.file.mode === mode) return { error: null }
    if (preparing.has(key)) return { error: 'busy' }
    preparing.add(key)

    try {
      let path
      if (mode === 'worktree') {
        if (!orca.host.has('workspace.list')) return { error: 'workspace-unavailable' }
        const { workspaces } = await orca.host.call('workspace.list')
        const row = workspaces.find(({ id }) => id === workspaceId)
        if (!row || (row.hostId !== 'local' && row.hostId !== null)) return { error: 'workspace-unavailable' }
        path = row.path
      }
      const file = await createPlanFile(mode, path)
      if (stopped) {
        if (mode === 'temp') await removeTemporaryDirectory(file.directory)
        return { error: 'session-changed' }
      }
      if (mode === 'temp') temporaryDirectories.add(file.directory)
      channels.set(key, { workspaceId, file, state: 'waiting', steps: null, signature: '{"state":"waiting"}' })
      timer ??= setInterval(() => void readFiles(), 1500)
      postChanged(workspaceId)
      return { error: null }
    } catch (error) {
      if (['not-ignored', 'unsafe-directory', 'workspace-unavailable'].includes(error.message)) {
        return { error: error.message }
      }
      return { error: 'file-unavailable' }
    } finally {
      preparing.delete(key)
    }
  })

  orca.panels.handle('flow.current', async () => {
    const { workspaceId, agents } = await currentWorkspace()
    return {
      workspaceId,
      agents: agents.map((agent) => {
        const sessionId = agent.sessionId ?? null
        const plan = plans.get(JSON.stringify([workspaceId, agent.terminalId]))
        const channel = channels.get(JSON.stringify([workspaceId, agent.terminalId, sessionId]))
        return {
          terminalId: agent.terminalId,
          sessionId,
          label: agent.title || agent.agent || 'Агент',
          steps: channel?.steps ?? (plan?.sessionId === sessionId ? plan.steps : []),
          file: channel ? { path: channel.file.path, mode: channel.file.mode, state: channel.state } : null
        }
      })
    }
  })
}
