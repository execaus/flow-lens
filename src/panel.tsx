import { atom, on, plugin, read, set, Button, Progress, Select, Stack, Text, Textarea } from 'orca'
import type { PanelContext } from 'orca'

const statusLabels = {
  pending: 'В очереди',
  in_progress: 'Текущий этап',
  completed: 'Готово'
}

type Step = { title: string; status: keyof typeof statusLabels }
type FileMode = 'temp' | 'worktree'
type PlanFile = { path: string; mode: FileMode; state: 'waiting' | 'ready' | 'invalid' }
type Agent = { terminalId: string; sessionId: string | null; label: string; steps: Step[]; file: PlanFile | null }
type Snapshot = { workspaceId: string | null; agents: Agent[] }
type PrepareInput = { workspaceId: string; terminalId: string; sessionId: string | null; mode: FileMode }

declare module 'orca' {
  interface PluginRequests {
    'flow.current': { input: Record<string, never>; output: Snapshot }
    'flow.prepare': { input: PrepareInput; output: { error: string | null } }
  }
  interface PluginPanelEvents {
    'flow.changed': { workspaceId: string }
  }
}

const snapshot = atom<Snapshot | null>(null)
const selected = atom('')
const failed = atom(false)
const preparing = atom(false)
const prepareError = atom<{ key: string; message: string } | null>(null)
const showInstruction = atom('')

const prepareErrors: Record<string, string> = {
  'not-ignored': 'Git должен игнорировать /.flow-lens/. Добавьте это правило в локальный info/exclude worktree и повторите проверку.',
  'unsafe-directory': 'Выберите другой канал. Путь .flow-lens занят файлом или ссылкой.',
  'workspace-unavailable': 'Запасной путь доступен только в локальной папке Git.',
  'session-changed': 'Сессия изменилась. Выберите её заново.'
}

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

function instruction(path: string) {
  return [
    'Веди план текущей задачи в Flow Lens. Составь его из контекста этой сессии.',
    `Пиши полный план в файл с абсолютным путём ${JSON.stringify(path)}.`,
    'Используй JSON формата {"version":1,"steps":[{"title":"Название этапа","status":"in_progress"}]}.',
    'Допустимые статусы: pending (в очереди), in_progress (текущий), completed (готово).',
    `Создай план сейчас. При смене этапа записывай обновлённый JSON в ${JSON.stringify(path + '.tmp')} и переименовывай этот файл поверх основного.`,
    'Используй обычные операции записи файлов. Включай в план только краткие названия этапов. Не добавляй файлы плана в Git.'
  ].join('\n')
}

async function prepare(data: Snapshot, agent: Agent, mode: FileMode) {
  if (!data.workspaceId || read(preparing)) return
  const key = agentKey(agent)
  set(preparing, true)
  set(prepareError, null)
  try {
    const { error } = await plugin.request('flow.prepare', {
      workspaceId: data.workspaceId, terminalId: agent.terminalId, sessionId: agent.sessionId, mode
    })
    if (error) {
      set(prepareError, { key, message: prepareErrors[error] ?? 'Не удалось подготовить файл плана.' })
      return
    }
    set(showInstruction, key)
  } catch {
    set(prepareError, { key, message: 'Не удалось подготовить файл плана.' })
  } finally {
    set(preparing, false)
  }
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
  const key = agent ? agentKey(agent) : ''
  const error = read(prepareError)

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
      {agent && steps.length === 0 && agent.file?.state !== 'ready' && (
        <Text muted>{agent.file ? 'Ожидаю план от агента.' : 'Подключите файл плана или попросите агента опубликовать встроенный план.'}</Text>
      )}
      {agent?.file?.state === 'ready' && steps.length === 0 && <Text muted>В файле нет этапов.</Text>}
      {agent?.file?.state === 'invalid' && (
        <Text tone="warning">Не удалось прочитать файл плана. Попросите агента проверить JSON.</Text>
      )}
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
      {agent && (
        <Stack gap="xs">
          {!agent.file && <Button disabled={read(preparing)} onPress={() => prepare(data, agent, 'temp')}>Подключить файл плана</Button>}
          {agent.file && (
            <Button variant="ghost" onPress={() => set(showInstruction, read(showInstruction) === key ? '' : key)}>
              {read(showInstruction) === key ? 'Скрыть инструкцию' : 'Показать инструкцию для агента'}
            </Button>
          )}
          {agent.file && read(showInstruction) === key && (
            <Stack gap="xs">
              <Textarea label="Инструкция для агента" value={instruction(agent.file.path)} />
              <Text size="xs" muted>Скопируйте текст из поля в выбранную сессию агента.</Text>
            </Stack>
          )}
          {(agent.file?.mode === 'temp' || error?.key === key) && (
            <Button variant="ghost" disabled={read(preparing)} onPress={() => prepare(data, agent, 'worktree')}>
              Использовать папку проекта
            </Button>
          )}
          {agent.file?.mode === 'worktree' && (
            <Button variant="ghost" disabled={read(preparing)} onPress={() => prepare(data, agent, 'temp')}>
              Использовать временную папку
            </Button>
          )}
          {error?.key === key && <Text tone="warning">{error.message}</Text>}
        </Stack>
      )}
    </Stack>
  )
}
