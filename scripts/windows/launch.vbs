Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
node = fso.BuildPath(root, "runtime\node.exe")
cli = fso.BuildPath(root, "app\dist\cli.mjs")
command = Chr(34) & node & Chr(34) & " " & Chr(34) & cli & Chr(34) & " ui"
shell.Run command, 0, False