; PIKA-Show 远程客户端安装包——用 NSIS 打包，跟 QLC+ 官方安装包用的是同一个
; 工具（windows-latest CI runner 自带 NSIS 3.10，不用额外装）。
;
; RequestExecutionLevel user：不要管理员权限。直播间那台电脑不一定是管理员
; 账号登录，装在当前用户目录下（$LOCALAPPDATA）更省事，也是 QLC+ 自己安装包
; 的同款做法（见 reference_qlcplus_bundling.md 里核实过的 .nsi 源码）。
;
; 输入（CI 在跑这个脚本之前已经准备好，见 build.yml）：
;   dist\pika-show-remote.exe   我们自己的主程序（pkg 打包，已经 editbin 成
;                                WINDOWS 子系统，双击不弹命令行）
;   dist\qlcplus\               捆绑的 QLC+（见 reference_qlcplus_bundling.md）
;
; 装完顺手把"开机自动启动"也做了——原来 README 要求用户自己把快捷方式拖进
; "启动"文件夹，这一步现在在安装时自动完成。

Unicode true

!define APP_NAME "PIKA-Show 远程客户端"
!define EXE_NAME "pika-show-remote.exe"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\PIKA-Show"

!ifndef VERSION
  !define VERSION "0.0.0"
!endif

Name "${APP_NAME}"
OutFile "PIKA-Show-Setup-v${VERSION}.exe"
InstallDir "$LOCALAPPDATA\PIKA-Show"
RequestExecutionLevel user

Page directory
Page instfiles

UninstPage uninstConfirm
UninstPage instfiles

Section "Install"
  SetOutPath "$INSTDIR"
  File "dist\${EXE_NAME}"
  File /r "dist\qlcplus"

  CreateDirectory "$SMPROGRAMS\PIKA-Show"
  CreateShortcut "$SMPROGRAMS\PIKA-Show\${APP_NAME}.lnk" "$INSTDIR\${EXE_NAME}"
  CreateShortcut "$SMPROGRAMS\PIKA-Show\卸载 ${APP_NAME}.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortcut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${EXE_NAME}"

  ; 开机自动启动——放进当前用户的"启动"文件夹，等同于 shell:startup，
  ; README 里原来要求用户手动做的那一步，装的时候顺手做掉
  CreateShortcut "$SMSTARTUP\${APP_NAME}.lnk" "$INSTDIR\${EXE_NAME}"

  WriteUninstaller "$INSTDIR\Uninstall.exe"

  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1

  ExecShell "" "$INSTDIR\${EXE_NAME}"
SectionEnd

Section "Uninstall"
  Delete "$INSTDIR\${EXE_NAME}"
  RMDir /r "$INSTDIR\qlcplus"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"

  Delete "$SMPROGRAMS\PIKA-Show\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\PIKA-Show\卸载 ${APP_NAME}.lnk"
  RMDir "$SMPROGRAMS\PIKA-Show"
  Delete "$DESKTOP\${APP_NAME}.lnk"
  Delete "$SMSTARTUP\${APP_NAME}.lnk"

  DeleteRegKey HKCU "${UNINSTALL_KEY}"
SectionEnd
