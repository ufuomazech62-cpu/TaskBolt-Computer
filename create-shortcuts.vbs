Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

exePath = WshShell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\TaskBolt\taskbolt-computer.exe"
iconPath = WshShell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\TaskBolt\taskbolt-computer.exe,0"
desktopPath = WshShell.SpecialFolders("Desktop")
startMenuPath = WshShell.SpecialFolders("Programs")

' Desktop shortcut
Set shortcut1 = WshShell.CreateShortcut(desktopPath & "\TaskBolt.lnk")
shortcut1.TargetPath = exePath
shortcut1.WorkingDirectory = WshShell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\TaskBolt"
shortcut1.IconLocation = iconPath
shortcut1.Description = "TaskBolt - AI that sets up your computer"
shortcut1.Save

' Start Menu shortcut
Set shortcut2 = WshShell.CreateShortcut(startMenuPath & "\TaskBolt.lnk")
shortcut2.TargetPath = exePath
shortcut2.WorkingDirectory = WshShell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\TaskBolt"
shortcut2.IconLocation = iconPath
shortcut2.Description = "TaskBolt - AI that sets up your computer"
shortcut2.Save

WScript.Echo "Shortcuts created!"
