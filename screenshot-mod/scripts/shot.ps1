# Captures the screen into the clipboard for the screenshot mod. Nothing is saved to disk.
#   -Mode full    the primary screen, at once
#   -Mode region  freeze the whole desktop, drag a rectangle (Esc cancels)
# Exit 0 = the picture is on the clipboard, 2 = cancelled.
param(
  [ValidateSet('full', 'region')][string]$Mode = 'full'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class ShotDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[void][ShotDpi]::SetProcessDPIAware() # real pixels, not scaled ones

function Grab([System.Drawing.Rectangle]$area) {
  $bmp = New-Object System.Drawing.Bitmap $area.Width, $area.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($area.Location, [System.Drawing.Point]::Empty, $area.Size)
  $g.Dispose()
  return $bmp
}

# $true keeps the picture on the clipboard after this process ends.
function ToClipboard($bmp) { [System.Windows.Forms.Clipboard]::SetDataObject($bmp, $true) }

if ($Mode -eq 'full') {
  $bmp = Grab ([System.Windows.Forms.Screen]::PrimaryScreen.Bounds)
  ToClipboard $bmp
  exit 0
}

# region: the desktop as it is now, shown dimmed; the dragged rectangle shows it bright.
$desk = [System.Windows.Forms.SystemInformation]::VirtualScreen
$shot = Grab $desk
$script:rect = [System.Drawing.Rectangle]::Empty
$script:from = $null
$script:picked = $false

$form = New-Object System.Windows.Forms.Form
$form.AutoScaleMode = 'None'
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$form.Bounds = $desk
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.KeyPreview = $true
$form.Cursor = [System.Windows.Forms.Cursors]::Cross
$form.GetType().GetProperty('DoubleBuffered', [Reflection.BindingFlags]'Instance,NonPublic').SetValue($form, $true, $null)
$dim = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(120, 0, 0, 0))
$pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 0, 160, 255)), 2

$form.Add_Paint({
  param($s, $e)
  $e.Graphics.DrawImage($shot, 0, 0)
  $e.Graphics.FillRectangle($dim, 0, 0, $shot.Width, $shot.Height)
  if ($script:rect.Width -gt 0 -and $script:rect.Height -gt 0) {
    $e.Graphics.DrawImage($shot, $script:rect, $script:rect, [System.Drawing.GraphicsUnit]::Pixel)
    $e.Graphics.DrawRectangle($pen, $script:rect)
  }
})
$form.Add_MouseDown({ param($s, $e) if ($e.Button -eq 'Left') { $script:from = $e.Location } })
$form.Add_MouseMove({
  param($s, $e)
  if ($null -ne $script:from) {
    $x = [Math]::Min($script:from.X, $e.X); $y = [Math]::Min($script:from.Y, $e.Y)
    $script:rect = New-Object System.Drawing.Rectangle $x, $y, ([Math]::Abs($e.X - $script:from.X)), ([Math]::Abs($e.Y - $script:from.Y))
    $s.Invalidate()
  }
})
$form.Add_MouseUp({
  param($s, $e)
  if ($null -ne $script:from) {
    $script:from = $null
    if ($script:rect.Width -ge 4 -and $script:rect.Height -ge 4) { $script:picked = $true; $s.Close() }
    else { $script:rect = [System.Drawing.Rectangle]::Empty; $s.Invalidate() }
  }
})
$form.Add_KeyDown({ param($s, $e) if ($e.KeyCode -eq 'Escape') { $s.Close() } })
$form.Add_Shown({ param($s, $e) $s.Activate() })
[void]$form.ShowDialog()
$form.Dispose()

if (-not $script:picked) { $shot.Dispose(); exit 2 }
$crop = $shot.Clone($script:rect, $shot.PixelFormat)
ToClipboard $crop
$shot.Dispose()
exit 0
