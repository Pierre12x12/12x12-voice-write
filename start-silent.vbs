Set fso = CreateObject("Scripting.FileSystemObject")
Set WshShell = CreateObject("WScript.Shell")
projectDir = fso.GetParentFolderName(WScript.ScriptFullName)
electronExe = projectDir & "\node_modules\electron\dist\electron.exe"
WshShell.CurrentDirectory = projectDir
WshShell.Run """" & electronExe & """ """ & projectDir & """", 0, False
