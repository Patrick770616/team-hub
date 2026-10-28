' Double-click: starts the team hub in the background (no black window) and opens the browser.
' Already running: only the browser opens. Stop it with the close button on the page. Log: data\server.log
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
sh.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "node launcher.js", 0, False
