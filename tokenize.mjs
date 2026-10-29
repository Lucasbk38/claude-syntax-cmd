// Deterministic syntax highlighter: VS Code's own TextMate grammars + the colour theme VS Code is set to.
// stdin: {"command": "...", "theme"?: "Theme name"}   stdout: {"lines": [[{t, fg, b, i, u}, ...], ...]}
// A shell command is tokenized with the shell grammar; code embedded in it (node -e, python -c, heredocs ...)
// is found by a plain shell lexer (no AI) and re-tokenized with its own grammar.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { detectEditor, findGrammars, norm, readJsonc, readText, resolveTheme } from './editors.mjs'

const require = createRequire(import.meta.url)
const { Registry, parseRawGrammar } = require('./vendor/vscode-textmate')
const oniguruma = require('./vendor/vscode-oniguruma')

const HERE = path.dirname(fileURLToPath(import.meta.url))

// ---------- editor, theme, grammars ----------

const input = JSON.parse(fs.readFileSync(0, 'utf8'))
const config = readJsonc(path.join(HERE, 'config.json')) ?? {}

const editor = detectEditor(input.editor ?? config.editor)
const resolved = resolveTheme(editor.id, input.theme ?? config.theme)
const theme = resolved.theme
const wanted = resolved.name
const defaultFg = (theme.colors['editor.foreground'] ?? '#D4D4D4').toLowerCase()
const grammarIndex = findGrammars(editor.id)
const grammarFiles = grammarIndex.files

// ---------- TextMate registry ----------

const wasm = fs.readFileSync(path.join(HERE, 'vendor/vscode-oniguruma/release/onig.wasm'))
await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength))

const registry = new Registry({
  onigLib: Promise.resolve({
    createOnigScanner: sources => new oniguruma.OnigScanner(sources),
    createOnigString: s => new oniguruma.OnigString(s),
  }),
  theme: { name: wanted, settings: [{ settings: { foreground: defaultFg } }, ...theme.tokenColors] },
  loadGrammar: async scope => {
    const file = grammarFiles[scope]
    const text = file && readText(file)
    return text ? parseRawGrammar(text, file) : null
  },
})
const colorMap = registry.getColorMap()

const grammars = new Map()
const grammarFor = async scope => {
  if (!grammars.has(scope)) grammars.set(scope, await registry.loadGrammar(scope).catch(() => null))
  return grammars.get(scope)
}

// one style per source character: null (default) or {fg, b, i, u}
const styleCache = new Map()
const styleOf = (fg, font) => {
  const key = `${fg}|${font}`
  if (!styleCache.has(key)) styleCache.set(key, { fg, b: !!(font & 2), i: !!(font & 1), u: !!(font & 4) })
  return styleCache.get(key)
}

const tokenizeText = async (scope, text) => {
  const styles = new Array(text.length).fill(null)
  const grammar = scope ? await grammarFor(scope) : null
  if (!grammar) return styles
  let stack = null
  let offset = 0
  for (const line of text.split('\n')) {
    const r = grammar.tokenizeLine2(line, stack)
    stack = r.ruleStack
    for (let k = 0; k < r.tokens.length; k += 2) {
      const start = r.tokens[k]
      const end = k + 2 < r.tokens.length ? r.tokens[k + 2] : line.length
      const meta = r.tokens[k + 1]
      const fg = (colorMap[(meta & 0x00ff8000) >>> 15] ?? defaultFg).toLowerCase()
      const font = (meta & 0x00007800) >>> 11
      if (fg === defaultFg && font === 0) continue
      const s = styleOf(fg === defaultFg ? null : fg, font)
      for (let c = start; c < end; c++) styles[offset + c] = s
    }
    offset += line.length + 1
  }
  return styles
}

// ---------- shell lexer (finds embedded code) ----------

const OP = /^(?:&>>?|\d*(?:<<<|<<-?|<>|>>|>&|<&|>\||>|<)(?:&?\d+-?)?|\|\||&&|\|&|[|&;()\n])/

const lex = src => {
  const segments = []
  let seg = { words: [], heredocs: [], redirs: [] }
  const pending = []
  let next = null // flag for the next word: 'redir' | 'herestring' | 'heretag'
  const endSegment = () => { if (seg.words.length || seg.heredocs.length) segments.push(seg); seg = { words: [], heredocs: [], redirs: [] } }

  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === ' ' || c === '\t') { i++; continue }
    if (c === '\\' && src[i + 1] === '\n') { i += 2; continue }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue }
    const op = (/^\d*[<>]|^&>|^[|&;()\n]/.test(src.slice(i, i + 4)) ? OP.exec(src.slice(i, i + 12)) : null)
    if (op) {
      const o = op[0]
      i += o.length
      if (o === '\n') {
        for (const h of pending.splice(0)) {
          const bodyStart = i
          let j = i
          while (j <= src.length) {
            let e = src.indexOf('\n', j)
            if (e < 0) e = src.length
            const line = h.strip ? src.slice(j, e).replace(/^\t+/, '') : src.slice(j, e)
            if (line === h.tag) { h.body = [bodyStart, j]; i = Math.min(e + 1, src.length); break }
            if (e >= src.length) { h.body = [bodyStart, src.length]; i = src.length; break }
            j = e + 1
          }
        }
        endSegment()
      } else if (/<<<$|<<-?$/.test(o.replace(/\d+/g, '').replace(/&.*/, ''))) {
        next = o.includes('<<<') ? 'herestring' : (o.includes('-') ? 'heretagStrip' : 'heretag')
      } else if (/[<>]/.test(o)) {
        next = /&\d*-?$/.test(o) ? null : 'redir'
      } else if (o !== '&>' && o !== '&>>') {
        endSegment()
      } else next = 'redir'
      continue
    }
    // a word
    const start = i
    let value = ''
    const map = []
    const push = (ch, at) => { value += ch; map.push(at) }
    while (i < src.length) {
      const ch = src[i]
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === ';' || ch === '|' || ch === '&' || ch === '<' || ch === '>' || ch === '(' || ch === ')') break
      if (ch === "'") {
        const e = src.indexOf("'", i + 1)
        const end = e < 0 ? src.length : e
        for (let k = i + 1; k < end; k++) push(src[k], k)
        i = e < 0 ? src.length : e + 1
      } else if (ch === '$' && src[i + 1] === "'") {
        let k = i + 2
        while (k < src.length && src[k] !== "'") { if (src[k] === '\\') { push(src[k], k); k++ } if (k < src.length) push(src[k], k); k++ }
        i = k + 1
      } else if (ch === '"') {
        let k = i + 1
        while (k < src.length && src[k] !== '"') {
          if (src[k] === '\\' && '$`"\\\n'.includes(src[k + 1] ?? '')) { if (src[k + 1] !== '\n') push(src[k + 1], k + 1); k += 2 }
          else { push(src[k], k); k++ }
        }
        i = k + 1
      } else if (ch === '\\') {
        if (src[i + 1] !== '\n' && i + 1 < src.length) push(src[i + 1], i + 1)
        i += 2
      } else if ((ch === '$' && src[i + 1] === '(') || ch === '`') {
        // command substitution kept inside the word, raw
        let depth = ch === '`' ? 0 : 1
        let k = i + (ch === '`' ? 1 : 2)
        push(ch, i); if (ch === '$') push('(', i + 1)
        while (k < src.length && (ch === '`' ? src[k] !== '`' : depth > 0)) {
          if (ch !== '`') { if (src[k] === '(') depth++; else if (src[k] === ')') depth-- }
          push(src[k], k); k++
        }
        i = k + 1
      } else { push(ch, i); i++ }
    }
    const word = { start, end: Math.min(i, src.length), value, map }
    if (next === 'heretag' || next === 'heretagStrip') {
      const h = { tag: value, strip: next === 'heretagStrip', body: null }
      pending.push(h); seg.heredocs.push(h)
    } else if (next === 'herestring') seg.herestring = word
    else if (next === 'redir') seg.redirs.push(word)
    else seg.words.push(word)
    next = null
  }
  endSegment()
  return segments
}

// ---------- which segments carry code, and in what language ----------

const WRAPPERS = new Set(['env', 'sudo', 'time', 'exec', 'command', 'nohup', 'uv', 'run', 'poetry', 'pipx', 'npx', 'bunx', 'pnpm', 'dlx', 'exec', 'xcrun', 'caffeinate'])
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/

// runner: matches the program name; evalFlags: flags whose NEXT word is code; skip: flags that swallow one argument
const RUNNERS = [
  { re: /^(python|python\d+(\.\d+)*|py|pypy3?)$/, scope: 'source.python', eval: w => w === '-c' || /^-[A-Za-z]*c$/.test(w), skip: new Set(['-W', '-X', '-Q', '-m']) , stop: new Set(['-m']) },
  { re: /^(node|nodejs)$/, scope: 'source.js', eval: w => ['-e', '-p', '-pe', '-ep', '--eval', '--print'].includes(w), skip: new Set(['-r', '--require', '--import', '--loader', '--input-type', '--env-file', '--experimental-loader']) },
  { re: /^bun$/, scope: 'source.js', eval: w => ['-e', '--eval', '-p', '--print'].includes(w), skip: new Set(['--preload', '-r', '--cwd', '--env-file']), words: new Set(['run']) },
  { re: /^deno$/, scope: 'source.ts', after: 'eval', eval: () => false, skip: new Set() },
  { re: /^(tsx|ts-node)$/, scope: 'source.ts', eval: w => ['-e', '-p', '--eval', '--print'].includes(w), skip: new Set() },
  { re: /^ruby$/, scope: 'source.ruby', eval: w => w === '-e', skip: new Set(['-r', '-I']) },
  { re: /^(bash|sh|zsh)$/, scope: 'source.shell', eval: w => w === '-c' || /^-[A-Za-z]*c$/.test(w), skip: new Set(['-o', '-O']) },
]

const EXT = {
  py: 'source.python', js: 'source.js', mjs: 'source.js', cjs: 'source.js', jsx: 'source.js.jsx', ts: 'source.ts', mts: 'source.ts',
  cts: 'source.ts', tsx: 'source.tsx', json: 'source.json', rb: 'source.ruby', sh: 'source.shell', bash: 'source.shell', zsh: 'source.shell',
  yaml: 'source.yaml', yml: 'source.yaml', css: 'source.css', html: 'text.html.basic', md: 'text.html.markdown', sql: 'source.sql',
}

const base = w => w.value.slice(w.value.lastIndexOf('/') + 1)

// -> [{scope, value, map}]
const findEmbedded = (src, segments) => {
  const out = []
  for (const seg of segments) {
    const ws = seg.words
    let r = -1, runner = null
    for (let k = 0; k < ws.length && k < 12; k++) {
      const v = ws[k].value
      const hit = RUNNERS.find(x => x.re.test(base(ws[k])))
      if (hit && !(k > 0 && v.startsWith('-'))) { r = k; runner = hit; break }
      if (ASSIGN.test(v) || WRAPPERS.has(v) || v.startsWith('-') || (k > 0 && ws[k - 1].value.startsWith('-'))) continue
      break
    }
    let code = null
    if (runner) {
      let usesStdin = true
      for (let k = r + 1; k < ws.length; k++) {
        const v = ws[k].value
        if (runner.after) { if (v === runner.after) { const c = ws.slice(k + 1).find(x => !x.value.startsWith('-')); if (c) { code = c; usesStdin = false } break } continue }
        if (runner.eval(v)) { code = ws[k + 1] ?? null; usesStdin = false; break }
        if (runner.stop?.has(v)) { usesStdin = false; break }
        if (runner.skip.has(v)) { k++; continue }
        if (runner.words?.has(v)) continue
        if (v === '-') continue
        if (v.startsWith('-')) continue
        usesStdin = false // a script file
        break
      }
      if (code) out.push({ scope: runner.scope, value: code.value, map: code.map })
      else if (usesStdin) {
        const h = seg.heredocs.find(x => x.body)
        if (h) { const [a, b] = h.body; out.push({ scope: runner.scope, value: src.slice(a, b), map: Array.from({ length: b - a }, (_, n) => a + n) }) }
        else if (seg.herestring) out.push({ scope: runner.scope, value: seg.herestring.value, map: seg.herestring.map })
      }
    } else {
      // cat > file.py <<'EOF' ... : language from the target's extension
      const h = seg.heredocs.find(x => x.body)
      const target = [...seg.redirs, ...(ws[0] && /^(tee)$/.test(base(ws[0])) ? ws.slice(1) : [])].map(w => w.value).find(v => EXT[v.slice(v.lastIndexOf('.') + 1).toLowerCase()])
      if (h && target) {
        const [a, b] = h.body
        out.push({ scope: EXT[target.slice(target.lastIndexOf('.') + 1).toLowerCase()], value: src.slice(a, b), map: Array.from({ length: b - a }, (_, n) => a + n) })
      }
    }
  }
  return out
}

// ---------- main ----------

const src = String(input.code ?? input.command ?? '')
const language = input.language ? grammarIndex.languages[norm(input.language)] ?? null : null
const SHELL = 'source.shell'
let styles
if (input.code !== undefined) {
  // plain code in a named language (or the shell when none is named / known)
  styles = await tokenizeText(language ?? (input.language ? null : SHELL), src)
} else {
  styles = await tokenizeText(SHELL, src)
  for (const e of findEmbedded(src, lex(src))) {
    const inner = await tokenizeText(e.scope, e.value)
    for (let k = 0; k < inner.length; k++) styles[e.map[k]] = inner[k]
  }
}

const lines = []
let offset = 0
for (const line of src.split('\n')) {
  const runs = []
  for (let c = 0; c < line.length; c++) {
    const s = styles[offset + c]
    const last = runs[runs.length - 1]
    if (last && last.s === s) last.t += line[c]
    else runs.push({ s, t: line[c] })
  }
  lines.push(runs.map(({ s, t }) => ({ t, fg: s?.fg ?? null, b: !!s?.b, i: !!s?.i, u: !!s?.u })))
  offset += line.length + 1
}
process.stdout.write(JSON.stringify({ editor: editor.id, theme: wanted, themeSource: resolved.source, language: input.language ? (language ? input.language : null) : undefined, lines }))
