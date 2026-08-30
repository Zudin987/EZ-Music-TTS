Option Explicit

Dim shell, fso, root, logDir, logPath, oldLog, batPath, inner, command, rc
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)
logDir = fso.BuildPath(root, "logs")
If Not fso.FolderExists(logDir) Then fso.CreateFolder(logDir)

logPath = fso.BuildPath(logDir, "launcher.log")
oldLog = fso.BuildPath(logDir, "launcher-old.log")

' Keep unattended logging bounded. Rotate at 5 MiB.
If fso.FileExists(logPath) Then
  If fso.GetFile(logPath).Size > 5242880 Then
    If fso.FileExists(oldLog) Then fso.DeleteFile oldLog, True
    fso.MoveFile logPath, oldLog
  End If
End If

batPath = fso.BuildPath(root, "start-bot.bat")
inner = Quote(batPath) & " /hidden >> " & Quote(logPath) & " 2>&1"
command = "cmd.exe /d /c " & Quote(inner)

' Window style 0 = hidden. Wait=True keeps Task Scheduler attached to the
' actual bot lifetime so restart-on-failure settings can work.
rc = shell.Run(command, 0, True)
WScript.Quit rc

Function Quote(value)
  Quote = Chr(34) & value & Chr(34)
End Function
