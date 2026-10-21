$ErrorActionPreference = "Stop"

$sourceRoot = Split-Path -Parent $PSCommandPath
$installRoot = Join-Path $env:LOCALAPPDATA "Programs\MeRuntime"
$stage = Join-Path $env:TEMP ("MeRuntime-" + [guid]::NewGuid().ToString("N"))

try {
    Expand-Archive -LiteralPath (Join-Path $sourceRoot "payload.zip") -DestinationPath $stage
    New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
    Copy-Item -Path (Join-Path $stage "*") -Destination $installRoot -Recurse -Force

    $launcher = Join-Path $installRoot "launch.vbs"
    $shell = New-Object -ComObject WScript.Shell
    $desktop = [Environment]::GetFolderPath("DesktopDirectory")
    $programs = Join-Path ([Environment]::GetFolderPath("Programs")) "Me Runtime"
    New-Item -ItemType Directory -Path $programs -Force | Out-Null

    foreach ($shortcutPath in @(
        (Join-Path $desktop "Me Runtime.lnk"),
        (Join-Path $programs "Me Runtime.lnk")
    )) {
        $shortcut = $shell.CreateShortcut($shortcutPath)
        $shortcut.TargetPath = Join-Path $env:SystemRoot "System32\wscript.exe"
        $shortcut.Arguments = "`"$launcher`""
        $shortcut.WorkingDirectory = $installRoot
        $shortcut.Description = "Start Me Runtime"
        $shortcut.Save()
    }

    Start-Process -FilePath (Join-Path $env:SystemRoot "System32\wscript.exe") -ArgumentList "`"$launcher`""
} finally {
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
}