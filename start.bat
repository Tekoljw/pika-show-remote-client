@echo off
REM PIKA-Show 远程客户端启动脚本——只支持 Windows。
REM 双击这个文件，或者把它的快捷方式放进"启动"文件夹（Win+R 输入 shell:startup）
REM 实现开机/登录自动启动。
REM 2026-09 起会弹出一个图形界面窗口（不再是纯控制台程序），这个 cmd 窗口
REM 还留着是为了在窗口弹出前显示 npm install 进度，以及万一启动崩溃时
REM 能看到报错（不会一闪而过）。

cd /d "%~dp0"

if not exist node_modules (
  echo 首次运行，正在安装依赖...
  call npm install
)

REM 设置 QLCPLUS_BIN=QLC+ 安装目录下 qlcplus.exe 的完整路径，如果不在系统 PATH 里
REM set QLCPLUS_BIN=C:\QLC+5\qlcplus.exe

node index.js
pause
