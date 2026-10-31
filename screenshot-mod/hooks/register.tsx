import type { Hook, Register } from 'claude-code'

type Dollar = Parameters<Hook<'command.run'>>[0]
type Mode = 'full' | 'region'

const REGION_WAIT_MS = 120_000

// Takes the picture with scripts/shot.ps1 (Windows PowerShell, no install) and leaves it on the clipboard:
// the person pastes it into the prompt box, where it shows as a picture. Nothing is saved to disk.
async function shoot($: Dollar, mode: Mode): Promise<string> {
  $.ui.status(mode === 'region' ? '📸 請用滑鼠框選區域（Esc 取消）' : '📸 截圖中…')
  let run
  try {
    run = await $.process.run(
      [
        'powershell.exe',
        '-NoProfile',
        '-STA',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        `${$.plugin.root}\\scripts\\shot.ps1`,
        '-Mode',
        mode,
      ],
      { timeoutMs: mode === 'region' ? REGION_WAIT_MS : 30_000 },
    )
  } catch {
    $.ui.status(undefined)
    return '截圖沒有完成：找不到 Windows PowerShell，或框選等太久被中止了。這個 mod 目前只支援 Windows。'
  }
  $.ui.status(undefined)

  if (run.exitCode === 2) return '已取消截圖。'
  if (run.exitCode !== 0) return `截圖失敗：${(run.stderr || run.stdout).trim().slice(0, 300) || `代碼 ${run.exitCode}`}`
  return '📸 截圖已複製到剪貼簿，在輸入框按 Ctrl+V 貼上（貼不上的話試 Alt+V）。'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'screenshot',
      description: '截圖到剪貼簿：整個螢幕，或框選區域',
      argumentHint: '[full | region]',
    })

    return next(e)
  })

  on('command.run', { command: 'screenshot' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg && arg !== 'full' && arg !== 'region') {
      return { text: '用法：/screenshot（整個螢幕）或 /screenshot region（框選區域）' }
    }

    return { text: await shoot($, arg === 'region' ? 'region' : 'full') }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box>
        <Text dimColor>📸 截圖 </Text>
        <Button
          key="full"
          label="整個螢幕"
          onPress={() => {
            void shoot($, 'full').then(text => $.ui.toast(text))
          }}
        />
        <Text dimColor> </Text>
        <Button
          key="region"
          label="框選區域"
          onPress={() => {
            void shoot($, 'region').then(text => $.ui.toast(text))
          }}
        />
      </Box>
    )
  })
}
