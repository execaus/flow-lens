const planTools = new Map([
  ['update_plan', ['plan', 'step']],
  ['functions.update_plan', ['plan', 'step']],
  ['TodoWrite', ['todos', 'content']]
])
const statuses = new Set(['pending', 'in_progress', 'completed'])

function readSteps(tool, input) {
  const fields = planTools.get(tool)
  if (!fields) return null

  const [listKey, textKey] = fields
  const list = input?.[listKey]
  if (!Array.isArray(list) || list.length > 100) return null

  const steps = []
  for (const item of list) {
    const title = item?.[textKey]
    if (typeof title !== 'string' || !title.trim() || !statuses.has(item.status)) {
      return null
    }
    steps.push({ title: title.trim().slice(0, 500), status: item.status })
  }
  return steps
}

export default function activate(orca) {
  const plans = new Map()
  let nextRevision = 0

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
    orca.panels.post('flow.changed', { workspaceId })
  })

  orca.panels.handle('flow.current', async () => {
    const { workspaceId, agents } = await currentWorkspace()
    return {
      workspaceId,
      agents: agents.map((agent) => {
        const sessionId = agent.sessionId ?? null
        const plan = plans.get(JSON.stringify([workspaceId, agent.terminalId]))
        return {
          terminalId: agent.terminalId,
          sessionId,
          label: agent.title || agent.agent || 'Агент',
          steps: plan?.sessionId === sessionId ? plan.steps : []
        }
      })
    }
  })
}
