// Finds the editor whose colours and grammars to use, and where its theme and TextMate grammars live.
// Everything here is plain file reading: no network, no model.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HOME = os.homedir()
const PLATFORM = os.platform()
const HERE = path.dirname(fileURLToPath(import.meta.url))

export const readText = file => { try { return fs.readFileSync(file, 'utf8') } catch { return null } }
export const isDir = d => { try { return fs.statSync(d).isDirectory() } catch { return false } }

export const parseJsonc = text => {
  try { return JSON.parse(text) } catch {} // plain JSON (most themes and grammars) skips the slow comment stripper
  let out = ''
  for (let i = 0, str = false; i < text.length; i++) {
    const c = text[i]
    if (str) {
      out += c
      if (c === '\\') out += text[++i]
      else if (c === '"') str = false
    } else if (c === '"') { str = true; out += c }
    else if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n' }
    else if (c === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++ }
    else out += c
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}
export const readJsonc = file => { const t = readText(file); if (t === null) return null; try { return parseJsonc(t) } catch { return null } }

// the per-user config folder of an app, per OS
const appData = name =>
  PLATFORM === 'darwin' ? path.join(HOME, 'Library/Application Support', name)
  : PLATFORM === 'win32' ? path.join(process.env.APPDATA ?? path.join(HOME, 'AppData/Roaming'), name)
  : path.join(process.env.XDG_CONFIG_HOME ?? path.join(HOME, '.config'), name)

const macApp = app => `/Applications/${app}.app/Contents/Resources/app/extensions`
const winApp = dir => path.join(process.env.LOCALAPPDATA ?? path.join(HOME, 'AppData/Local'), 'Programs', dir, 'resources/app/extensions')

// editors that read VS Code's formats (settings.json, extensions with package.json, TextMate grammars)
export const VSCODE_FAMILY = {
  vscode: { label: 'Visual Studio Code', user: appData('Code/User'), ext: path.join(HOME, '.vscode/extensions'), app: [macApp('Visual Studio Code'), '/usr/share/code/resources/app/extensions', '/usr/lib/code/extensions', '/opt/visual-studio-code/resources/app/extensions', winApp('Microsoft VS Code')] },
  'vscode-insiders': { label: 'VS Code Insiders', user: appData('Code - Insiders/User'), ext: path.join(HOME, '.vscode-insiders/extensions'), app: [macApp('Visual Studio Code - Insiders'), '/usr/share/code-insiders/resources/app/extensions', winApp('Microsoft VS Code Insiders')] },
  cursor: { label: 'Cursor', user: appData('Cursor/User'), ext: path.join(HOME, '.cursor/extensions'), app: [macApp('Cursor'), '/opt/cursor/resources/app/extensions', winApp('cursor')] },
  windsurf: { label: 'Windsurf', user: appData('Windsurf/User'), ext: path.join(HOME, '.windsurf/extensions'), app: [macApp('Windsurf'), '/opt/windsurf/resources/app/extensions', winApp('Windsurf')] },
  vscodium: { label: 'VSCodium', user: appData('VSCodium/User'), ext: path.join(HOME, '.vscode-oss/extensions'), app: [macApp('VSCodium'), '/usr/share/codium/resources/app/extensions', winApp('VSCodium')] },
}

export const EDITORS = ['vscode', 'vscode-insiders', 'cursor', 'windsurf', 'vscodium', 'zed', 'sublime', 'jetbrains', 'neovim', 'helix', 'vim']

const sublimeDir = () => appData('Sublime Text')
const zedSettings = () => PLATFORM === 'darwin' || PLATFORM === 'linux' ? path.join(process.env.XDG_CONFIG_HOME ?? path.join(HOME, '.config'), 'zed/settings.json') : path.join(appData('Zed'), 'settings.json')
const jetbrainsRoots = () => (PLATFORM === 'darwin' ? [appData('JetBrains')] : PLATFORM === 'win32' ? [appData('JetBrains')] : [appData('JetBrains')]).filter(isDir)
const nvimDirs = () => [path.join(process.env.XDG_CONFIG_HOME ?? path.join(HOME, '.config'), 'nvim'), path.join(process.env.LOCALAPPDATA ?? '', 'nvim')].filter(d => d && isDir(d))
const vimFiles = () => [path.join(HOME, '.vimrc'), path.join(HOME, '.vim/vimrc'), path.join(HOME, '_vimrc')].filter(f => fs.existsSync(f))
const helixConfig = () => path.join(process.env.XDG_CONFIG_HOME ?? path.join(HOME, '.config'), 'helix/config.toml')

const isInstalled = id => {
  if (VSCODE_FAMILY[id]) { const f = VSCODE_FAMILY[id]; return isDir(f.user) || f.app.some(isDir) }
  if (id === 'zed') return fs.existsSync(zedSettings())
  if (id === 'sublime') return isDir(sublimeDir())
  if (id === 'jetbrains') return jetbrainsRoots().length > 0
  if (id === 'neovim') return nvimDirs().length > 0
  if (id === 'helix') return fs.existsSync(helixConfig())
  if (id === 'vim') return vimFiles().length > 0
  return false
}

// ---------- which editor ----------

const IDE_NAMES = [
  [/cursor/i, 'cursor'], [/windsurf/i, 'windsurf'], [/insiders/i, 'vscode-insiders'], [/vscodium|codium/i, 'vscodium'],
  [/visual studio code|vs ?code/i, 'vscode'], [/zed/i, 'zed'], [/sublime/i, 'sublime'],
  [/intellij|pycharm|webstorm|goland|rider|phpstorm|clion|rubymine|datagrip|android studio|jetbrains|fleet/i, 'jetbrains'],
]
const idFromIdeName = name => IDE_NAMES.find(([re]) => re.test(name))?.[1] ?? null

const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }

// the IDE Claude Code is connected to: a lock file per running IDE in ~/.claude/ide
const fromClaudeIde = () => {
  const dir = path.join(HOME, '.claude/ide')
  if (!isDir(dir)) return null
  const locks = fs.readdirSync(dir).filter(f => f.endsWith('.lock')).map(f => ({ f, j: readJsonc(path.join(dir, f)), m: fs.statSync(path.join(dir, f)).mtimeMs }))
  for (const l of locks.sort((a, b) => b.m - a.m)) {
    if (l.j?.ideName && (l.j.pid === undefined || alive(l.j.pid))) { const id = idFromIdeName(l.j.ideName); if (id) return id }
  }
  return null
}

const ENV_EDITORS = [
  [/^code-insiders/, 'vscode-insiders'], [/^code/, 'vscode'], [/^cursor/, 'cursor'], [/^windsurf/, 'windsurf'], [/^codium/, 'vscodium'],
  [/^(subl|sublime)/, 'sublime'], [/^nvim/, 'neovim'], [/^(vim|vi|gvim)$/, 'vim'], [/^hx|^helix/, 'helix'], [/^zed/, 'zed'],
  [/^(idea|pycharm|webstorm|goland|rider|clion|phpstorm|rubymine)/, 'jetbrains'],
]
const fromEnv = () => {
  for (const v of [process.env.VISUAL, process.env.EDITOR]) {
    if (!v) continue
    const bin = path.basename(v.trim().split(/\s+/)[0]).toLowerCase()
    const hit = ENV_EDITORS.find(([re]) => re.test(bin))
    if (hit) return hit[1]
  }
  return null
}

export const detectEditor = want => {
  if (want && want !== 'auto' && EDITORS.includes(want)) return { id: want, how: 'configured' }
  const ide = fromClaudeIde()
  if (ide) return { id: ide, how: 'the IDE Claude Code is connected to' }
  const env = fromEnv()
  if (env && isInstalled(env)) return { id: env, how: '$VISUAL / $EDITOR' }
  const found = EDITORS.find(isInstalled)
  return found ? { id: found, how: 'found installed' } : { id: 'bundled', how: 'no editor found' }
}

// ---------- the theme name each editor has selected ----------

const grepFiles = (dir, exts, depth = 3, limit = 60) => {
  const out = []
  const walk = (d, n) => {
    if (out.length >= limit || n > depth) return
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.git') || e.name === 'node_modules') continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p, n + 1)
      else if (exts.some(x => e.name.endsWith(x))) out.push(p)
    }
  }
  try { walk(dir, 0) } catch { /* unreadable folder */ }
  return out
}

const COLORSCHEME = [
  /^\s*colou?rscheme\s+["']?([\w.-]+)/m,
  /colou?rscheme\s*\(?\s*["']([\w.-]+)["']/,
  /vim\.cmd\.colou?rscheme\s*\(?\s*["']([\w.-]+)["']/,
  /vim\.cmd\s*\(?\s*\[?\[?["']?\s*colou?rscheme\s+([\w.-]+)/,
  /^\s*colou?rscheme\s*=\s*["']([\w.-]+)["']/m,
]
const findColorscheme = files => {
  for (const f of files) {
    const t = readText(f)
    if (!t) continue
    for (const re of COLORSCHEME) { const m = re.exec(t); if (m) return m[1] }
  }
  return null
}

const themeNameOf = id => {
  if (VSCODE_FAMILY[id]) {
    const s = readJsonc(path.join(VSCODE_FAMILY[id].user, 'settings.json')) ?? {}
    return s['workbench.colorTheme'] ?? (s['window.autoDetectColorScheme'] ? s['workbench.preferredDarkColorTheme'] : null) ?? null
  }
  if (id === 'zed') {
    const t = readJsonc(zedSettings())?.theme
    return typeof t === 'string' ? t : t?.dark ?? t?.light ?? null
  }
  if (id === 'sublime') {
    const cs = readJsonc(path.join(sublimeDir(), 'Packages/User/Preferences.sublime-settings'))?.color_scheme
    return cs ? path.basename(cs).replace(/\.(sublime-color-scheme|tmTheme)$/, '') : null
  }
  if (id === 'jetbrains') {
    const dirs = jetbrainsRoots().flatMap(r => fs.readdirSync(r).map(n => path.join(r, n, 'options'))).filter(isDir)
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    for (const d of dirs) {
      const m = /<global_color_scheme[^>]*name="([^"]+)"/.exec(readText(path.join(d, 'colors.scheme.xml')) ?? '')
      if (m) return m[1]
      const l = /<laf[^>]*class-name="([^"]+)"/.exec(readText(path.join(d, 'laf.xml')) ?? '')
      if (l) return /light/i.test(l[1]) ? 'IntelliJ Light' : 'Darcula'
    }
    return 'Darcula'
  }
  if (id === 'neovim') return findColorscheme(nvimDirs().flatMap(d => grepFiles(d, ['.lua', '.vim'])))
  if (id === 'vim') return findColorscheme(vimFiles())
  if (id === 'helix') return /^\s*theme\s*=\s*["']([^"']+)["']/m.exec(readText(helixConfig()) ?? '')?.[1] ?? null
  return null
}

// ---------- theme files ----------

export const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '')

// editor / community names -> a theme bundled with the mod
const ALIASES = {
  darkmodern: 'dark-plus', defaultdarkmodern: 'dark-plus', darkplus: 'dark-plus', defaultdarkplus: 'dark-plus', darkvs: 'dark-plus', dark: 'dark-plus',
  lightmodern: 'light-plus', defaultlightmodern: 'light-plus', lightplus: 'light-plus', defaultlightplus: 'light-plus', light: 'light-plus', default: 'light-plus', intellijlight: 'light-plus',
  darcula: 'dark-plus', intellijdark: 'dark-plus', newuidark: 'dark-plus',
  onedark: 'one-dark-pro', onedarkmodern: 'one-dark-pro', onedarkpro: 'one-dark-pro', onehalfdark: 'one-dark-pro', onelight: 'one-light',
  tokyonight: 'tokyo-night', tokyonightstorm: 'tokyo-night', tokyonightmoon: 'tokyo-night', tokyonightday: 'light-plus',
  gruvbox: 'gruvbox-dark-medium', gruvboxmaterial: 'gruvbox-dark-medium', catppuccin: 'catppuccin-mocha', rosepinedawn: 'rose-pine-dawn',
  rosepine: 'rose-pine', nightfox: 'nord', nordfox: 'nord', ayu: 'ayu-dark', mariana: 'material-theme-ocean', sixteen: 'material-theme-darker',
  breakers: 'light-plus', celeste: 'material-theme-lighter', adaptive: 'dark-plus', monokaipro: 'monokai', material: 'material-theme', github: 'github-dark',
  githubdarkdefault: 'github-dark-default', githubdimmed: 'github-dark-dimmed', solarized: 'solarized-dark', everforest: 'everforest-dark',
  kanagawa: 'kanagawa-wave', zenburn: 'dark-plus', desert: 'dark-plus', slate: 'dark-plus', industry: 'dark-plus', habamax: 'dark-plus', retrobox: 'gruvbox-dark-medium',
  sorbet: 'dark-plus', default_: 'dark-plus', delek: 'light-plus', shine: 'light-plus', morning: 'light-plus', peachpuff: 'light-plus', quiet: 'light-plus',
}
const LIGHT_HINT = /light|day|dawn|latte|white|lotus|snow|paper|morning|shine|day/i

const bundledThemes = () => fs.readdirSync(path.join(HERE, 'bundled/themes')).filter(f => f.endsWith('.json')).map(f => ({ id: f.replace(/\.json$/, ''), file: path.join(HERE, 'bundled/themes', f) }))

const loadVsCodeTheme = file => {
  const j = readJsonc(file)
  if (!j) return { colors: {}, tokenColors: [] }
  const base = j.include ? loadVsCodeTheme(path.resolve(path.dirname(file), j.include)) : { colors: {}, tokenColors: [] }
  let own = j.tokenColors ?? []
  if (typeof own === 'string') own = loadVsCodeTheme(path.resolve(path.dirname(file), own)).tokenColors
  return { colors: { ...base.colors, ...j.colors }, tokenColors: [...base.tokenColors, ...own] }
}

// Sublime .sublime-color-scheme -> the same shape as a VS Code theme
const loadSublimeScheme = file => {
  const j = readJsonc(file)
  if (!j) return null
  const vars = j.variables ?? {}
  const resolve = v => {
    if (typeof v !== 'string') return undefined
    const m = /^var\((\w+)\)$/.exec(v)
    if (m) return resolve(vars[m[1]])
    const hex = /#[0-9a-fA-F]{6}/.exec(v)
    return hex ? hex[0] : undefined
  }
  return {
    colors: { 'editor.foreground': resolve(j.globals?.foreground) ?? '#d4d4d4', 'editor.background': resolve(j.globals?.background) ?? '#1e1e1e' },
    tokenColors: (j.rules ?? []).filter(r => r.scope).map(r => ({ scope: r.scope.split(/[,\s]+(?=\S)/).join(','), settings: { foreground: resolve(r.foreground), fontStyle: r.font_style } })),
  }
}

// every theme found in any installed VS Code-family editor
const installedThemes = () => {
  const out = []
  for (const roots of extensionRoots(Object.keys(VSCODE_FAMILY))) {
    for (const d of fs.readdirSync(roots).sort().reverse()) {
      const dir = path.join(roots, d)
      const pkg = readJsonc(path.join(dir, 'package.json'))
      if (!pkg?.contributes?.themes) continue
      const nls = readJsonc(path.join(dir, 'package.nls.json')) ?? {}
      const tr = s => (typeof s === 'string' && /^%.+%$/.test(s) ? (nls[s.slice(1, -1)]?.message ?? nls[s.slice(1, -1)] ?? s) : s)
      for (const t of pkg.contributes.themes) out.push({ names: [tr(t.label), t.id].filter(Boolean), file: path.join(dir, t.path) })
    }
  }
  return out
}

export const extensionRoots = ids => ids.flatMap(id => [VSCODE_FAMILY[id].ext, ...VSCODE_FAMILY[id].app]).filter(isDir)

// -> { name, source, theme: {colors, tokenColors} }
export const resolveTheme = (editorId, override) => {
  const wanted = override || themeNameOf(editorId) || null
  const bundled = bundledThemes()
  const asBundled = (id, source) => ({ name: wanted ?? id, source, theme: loadVsCodeTheme(bundled.find(b => b.id === id).file) })

  if (wanted) {
    // another editor's scheme names ("Dark", "Darcula") are generic: our own aliases beat a same-named VS Code theme
    if (!VSCODE_FAMILY[editorId]) {
      const n0 = norm(wanted)
      const known = bundled.find(b => norm(b.id) === n0)?.id ?? ALIASES[n0]
      if (known) return asBundled(known, 'bundled theme (closest to the editor\'s)')
    }
    const hit = installedThemes().find(t => t.names.some(n => norm(n) === norm(wanted)))
    if (hit) return { name: wanted, source: 'installed VS Code theme', theme: loadVsCodeTheme(hit.file) }

    if (editorId === 'sublime') {
      const files = grepFiles(path.join(sublimeDir(), 'Packages'), ['.sublime-color-scheme'], 4, 200)
      const f = files.find(x => norm(path.basename(x).replace(/\.sublime-color-scheme$/, '')) === norm(wanted))
      const t = f && loadSublimeScheme(f)
      if (t) return { name: wanted, source: 'Sublime Text colour scheme', theme: t }
    }

    const n = norm(wanted)
    const exact = bundled.find(b => norm(b.id) === n)
    if (exact) return asBundled(exact.id, 'bundled theme')
    if (ALIASES[n]) return asBundled(ALIASES[n], 'bundled theme (closest to the editor\'s)')
    const near = bundled.filter(b => n.includes(norm(b.id)) || norm(b.id).includes(n)).sort((a, b) => a.id.length - b.id.length)[0]
    if (near && n.length >= 4) return asBundled(near.id, 'bundled theme (closest to the editor\'s)')
    return asBundled(LIGHT_HINT.test(wanted) ? 'light-plus' : 'dark-plus', 'bundled theme (default)')
  }
  return asBundled('dark-plus', 'bundled theme (default)')
}

// scope -> grammar file, the editor's own VS Code-format grammars first, then any other installed one, then the bundled set
export const findGrammars = editorId => {
  const order = [...(VSCODE_FAMILY[editorId] ? [editorId] : []), ...Object.keys(VSCODE_FAMILY).filter(k => k !== editorId)]
  const files = {}
  const languages = {} // language id / alias / extension -> scope
  for (const root of extensionRoots(order)) {
    for (const d of fs.readdirSync(root).sort().reverse()) {
      const dir = path.join(root, d)
      const pkg = readJsonc(path.join(dir, 'package.json'))
      if (!pkg?.contributes) continue
      for (const g of pkg.contributes.grammars ?? []) {
        files[g.scopeName] ??= path.join(dir, g.path)
        if (g.language) for (const l of pkg.contributes.languages ?? []) if (l.id === g.language) for (const k of [l.id, ...(l.aliases ?? []), ...(l.extensions ?? []).map(e => e.replace(/^\./, ''))]) languages[norm(k)] ??= g.scopeName
      }
    }
  }
  const index = readJsonc(path.join(HERE, 'bundled/grammars.json')) ?? []
  for (const g of index) {
    files[g.scopeName] ??= path.join(HERE, 'bundled/grammars', `${g.name}.json`)
    for (const k of [g.name, g.displayName, ...(g.aliases ?? [])]) if (k) languages[norm(k)] ??= g.scopeName
  }
  return { files, languages }
}
