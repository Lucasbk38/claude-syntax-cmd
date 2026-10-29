import type { EngineInterface, Register } from 'claude-code'

type Run = { t: string; fg: string | null; b: boolean; i: boolean; u: boolean }
type Result = { lines: Run[][]; editor: string; theme: string }
type Options = { editor: string; theme: string; strength: number; codeStrength: number; collapsedLines: number }

const SHOW_CODE = 'mcp__syntax-cmd__show_code'
const DIM_TO = '#999999'
const MAX_CACHED = 200

const cache = new Map<string, Result | 'pending' | 'failed'>()
let options: Options = { editor: 'auto', theme: '', strength: 0.55, codeStrength: 1, collapsedLines: 3 }

const channels = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))

// pulls a theme colour toward grey: strength 1 keeps it, 0 makes it grey
const soften = (hex: string, strength: number) => {
  if (strength >= 1) return hex
  const grey = channels(DIM_TO)
  const mixed = channels(hex).map((c, n) => Math.round(grey[n] + (c - grey[n]) * strength))
  return `#${mixed.map(c => c.toString(16).padStart(2, '0')).join('')}`
}

const keyOf = (payload: { command?: string; code?: string; language?: string }) =>
  payload.code === undefined ? `cmd:${payload.command}` : `code:${payload.language}:${payload.code}`

const highlight = async ($: EngineInterface, payload: { command?: string; code?: string; language?: string }) => {
  const key = keyOf(payload)
  cache.set(key, 'pending')
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value as string)

  try {
    const done = await $.process.run(['node', `${$.plugin.root}/tokenize.mjs`], {
      stdin: JSON.stringify({ ...payload, editor: options.editor, theme: options.theme }),
      timeoutMs: 8000,
    })
    if (done.exitCode !== 0) throw new Error(done.stderr.slice(0, 300))
    cache.set(key, JSON.parse(done.stdout) as Result)
  } catch (error) {
    cache.set(key, 'failed')
    $.ui.log(`syntax-cmd: ${String(error)}`, { to: 'debug' })
  }
  $.ui.invalidate('ui.render')
}

const renderRuns = (Text: any, runs: Run[], strength: number) =>
  runs.length === 0
    ? [<Text> </Text>]
    : runs.map(r =>
        r.fg === null && !r.b && !r.i && !r.u ? (
          strength < 1 ? <Text dimColor>{r.t}</Text> : <Text>{r.t}</Text>
        ) : (
          <Text color={r.fg === null ? undefined : soften(r.fg, strength)} dimColor={r.fg === null && strength < 1} bold={r.b} italic={r.i} underline={r.u}>
            {r.t}
          </Text>
        ),
      )

export const register: Register = (on, userOptions) => {
  options = { ...options, ...(userOptions as Partial<Options>) }

  // the tool Claude calls to show you code in a language of its choice
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'show_code',
      description:
        'Show the user a code snippet, syntax-highlighted in the given language with their editor theme. Use it when the user asks to see code, or when a snippet is the answer. The code is drawn in the terminal; do not repeat it in your reply.',
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'The code to show, exactly as it should read.' },
          language: { type: 'string', description: 'Language id or alias, for example python, js, ts, bash, json, rust, sql.' },
          title: { type: 'string', description: 'Optional caption, for example a file name.' },
        },
        required: ['code', 'language'],
      },
      isDeferred: false,
    })

    return next(e)
  })

  on('tool.call', { tool: SHOW_CODE }, ($, e, next) => {
    const input = e as unknown as { code?: string; language?: string }
    const code = (input.code ?? '').trimEnd()
    void highlight($, { code, language: input.language ?? '' })

    return {
      result: {
        content: [{ type: 'text', text: `Showed ${code.split('\n').length} lines of ${input.language} to the user.` }],
        isError: false,
      },
    }
  }).catch(($, e, next) => ({ deny: 'syntax-cmd: could not show the code.' }))

  // start tokenizing as a Bash call is made, so its row is usually ready when first drawn
  on('tool.call', { tool: 'Bash' }, ($, e, next) => {
    const command = e.command.trimEnd()
    if (command !== '' && !cache.has(keyOf({ command }))) void highlight($, { command })

    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const input = e.props.input as { command?: unknown; code?: unknown; language?: unknown; title?: unknown } | null
    const isShow = e.props.tool === SHOW_CODE
    const isBash = e.props.tool === 'Bash'
    if (!isShow && !isBash) return next(e)

    const payload = isShow
      ? typeof input?.code === 'string' ? { code: input.code.trimEnd(), language: String(input.language ?? '') } : null
      : typeof input?.command === 'string' && input.command.trim() !== '' ? { command: input.command.trimEnd() } : null
    if (payload === null) return next(e)

    const done = cache.get(keyOf(payload))
    if (done === undefined) void highlight($, payload)
    if (done === undefined || done === 'pending' || done === 'failed') return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const dot = e.props.isErrored || e.props.isInterrupted ? 'error' : e.props.isRunning ? 'inactive' : 'success'

    if (isShow) {
      return (
        <Box flexDirection="column">
          <Text>
            <Text color={dot}>⏺ </Text>
            <Text weight="bold">{typeof input?.title === 'string' && input.title !== '' ? input.title : 'Code'}</Text>
            <Text dimColor>{` (${String(input?.language ?? '')}) · ${done.theme}`}</Text>
          </Text>
          <Box flexDirection="column" borderStyle="round" borderColor="inactive" paddingX={1} marginLeft={2}>
            {done.lines.map(runs => (
              <Text wrap="wrap">{renderRuns(Text, runs, options.codeStrength)}</Text>
            ))}
          </Box>
        </Box>
      )
    }

    const shown = e.props.isExpanded ? done.lines : done.lines.slice(0, options.collapsedLines)
    const hidden = done.lines.length - shown.length

    return (
      <Box flexDirection="column">
        {shown.map((runs, n) => (
          <Text wrap="wrap">
            {n === 0 ? <Text color={dot}>⏺ </Text> : <Text>{'  '}</Text>}
            {n === 0 ? <Text weight="bold">Bash</Text> : <Text>{'    '}</Text>}
            <Text dimColor>{n === 0 ? '(' : ' '}</Text>
            {renderRuns(Text, runs, options.strength)}
            {n === shown.length - 1 && hidden === 0 ? <Text dimColor>)</Text> : null}
          </Text>
        ))}
        {hidden > 0 ? <Text dimColor>{`      … +${hidden} line${hidden === 1 ? '' : 's'}) (ctrl+o to expand)`}</Text> : null}
      </Box>
    )
  })
}
