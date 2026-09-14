; PIKA-Show 远程客户端安装包——用 Inno Setup 打包（windows-latest CI runner
; 实测确认自带，路径是 C:\Program Files (x86)\Inno Setup 6\ISCC.exe，不用
; 额外装）。原计划用 NSIS，但 CI 实测这个 runner 上 NSIS 不在任何 Program
; Files 目录、也不在 PATH 里（跟官方 readme 的软件清单对不上，具体原因不明），
; 换成同样能生成单文件安装向导、而且已经现查证实存在的 Inno Setup。
;
; PrivilegesRequired=lowest：不要管理员权限。直播间那台电脑不一定是管理员
; 账号登录，装在当前用户目录下（{localappdata}）更省事。
;
; 输入（CI 在跑这个脚本之前已经准备好，见 build.yml）：
;   dist\pika-show-remote.exe   我们自己的主程序（pkg 打包，已经 editbin 成
;                                WINDOWS 子系统，双击不弹命令行）
;   dist\qlcplus\               捆绑的 QLC+（见 reference_qlcplus_bundling.md）
;
; 装完顺手把"开机自动启动"也做了——原来 README 要求用户自己把快捷方式拖进
; "启动"文件夹，这一步现在在安装时自动完成。卸载程序/Add-Remove Programs
; 注册表项 Inno Setup 自动生成，不用像 NSIS 那样手写 Uninstall 段。

#ifndef MyAppVersion
  #define MyAppVersion "0.0.0"
#endif
#define MyAppName "PIKA-Show 远程客户端"
#define MyAppExeName "pika-show-remote.exe"

[Setup]
AppName={#MyAppName}
AppVersion={#MyAppVersion}
DefaultDirName={localappdata}\PIKA-Show
DefaultGroupName=PIKA-Show
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputBaseFilename=PIKA-Show-Setup-v{#MyAppVersion}
Compression=lzma
SolidCompression=yes
OutputDir=.

[Files]
Source: "dist\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\qlcplus\*"; DestDir: "{app}\qlcplus"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\卸载 {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{userdesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{userstartup}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "启动 {#MyAppName}"; Flags: nowait postinstall skipifsilent
