import { atom, on, plugin, read, set, Progress, Select, Stack, Text } from 'orca'
import type { PanelContext } from 'orca'

const statusLabels = {
  pending: 'В очереди',
  in_progress: 'Текущий этап',
  completed: 'Готово'
}

type Step = { title: string; status: keyof typeof statusLabels }
type Agent = { terminalId: string; sessionId: string | null; label: string; steps: Step[] }
type Snapshot = { workspaceId: string | null; agents: Agent[] }

declare module 'orca' {
  interface PluginRequests {
    'flow.current': { input: Record<string, never>; output: Snapshot }
  }
  interface PluginPanelEvents {
    'flow.changed': { workspaceId: string }
  }
}

const snapshot = atom<Snapshot | null>(null)
const selected = atom('')
const failed = atom(false)

function agentKey(agent: Agent) {
  return JSON.stringify([agent.terminalId, agent.sessionId])
}

export function setup(ctx: PanelContext) {
  let revision = 0

  async function refresh() {
    const request = ++revision
    try {
      const result = await plugin.request('flow.current', {}, { timeoutMs: 5000 })
      if (ctx.signal.aborted || request !== revision) return
      set(snapshot, result)
      set(failed, false)
    } catch {
      if (ctx.signal.aborted || request !== revision) return
      set(failed, true)
    }
  }

  ctx.subscriptions.push(
    on('workspace.changed', ({ context }) => {
      if (read(snapshot)?.workspaceId !== context?.workspaceId) {
        set(snapshot, null)
        set(selected, '')
        set(failed, false)
      }
      void refresh()
    }),
    on('agent.status.changed', ({ workspaceId }) => {
      if (workspaceId === read(snapshot)?.workspaceId) void refresh()
    }),
    plugin.on('flow.changed', ({ workspaceId }) => {
      if (!read(snapshot) || workspaceId === read(snapshot)?.workspaceId) void refresh()
    })
  )
  void refresh()
}

export default function FlowLens() {
  const data = read(snapshot)
  if (read(failed)) return <Text tone="danger">Не удалось получить план агента.</Text>
  if (!data) return <Text muted>Загружаем план…</Text>
  if (!data.workspaceId) return <Text muted>Откройте рабочую область в Orca.</Text>
  if (!data.agents.length) return <Text muted>Откройте сессию агента в этой рабочей области.</Text>

  const agent = data.agents.length === 1
    ? data.agents[0]
    : data.agents.find((item) => agentKey(item) === read(selected))
  const steps = agent?.steps ?? []
  const complete = steps.filter((step) => step.status === 'completed').length

  return (
    <Stack gap="md">
      {data.agents.length > 1 ? (
        <Select
          label="Сессия агента"
          value={agent ? agentKey(agent) : ''}
          placeholder="Выберите сессию"
          options={data.agents.map((item, index) => ({
            value: agentKey(item),
            label: `${index + 1}. ${item.label}`
          }))}
          onChange={(value) => set(selected, value)}
        />
      ) : <Text weight="semibold">{agent?.label}</Text>}
      {agent && steps.length === 0 && <Text muted>Попросите агента создать или обновить план.</Text>}
      {steps.length > 0 && (
        <Stack gap="sm">
          <Text muted>Выполнено {complete} из {steps.length}</Text>
          <Progress label="Выполнено этапов" value={Math.round(100 * complete / steps.length)} />
          {steps.map((step, index) => (
            <Stack key={index} gap="xs">
              <Text weight={step.status === 'in_progress' ? 'semibold' : 'regular'}>
                {index + 1}. {step.title}
              </Text>
              <Text size="xs" tone={step.status === 'in_progress' ? 'accent' : 'neutral'}>
                {statusLabels[step.status]}
              </Text>
            </Stack>
          ))}
        </Stack>
      )}
    </Stack>
  )
}
