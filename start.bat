@echo off
REM PIKA-Show 远程客户端启动脚本——只支持 Windows。
REM 双击这个文件，或者把它的快捷方式放进"启动"文件夹（Win+R 输入 shell:startup）
REM 实现开机/登录自动启动。

cd /d "%~dp0"

if not exist node_modules (
  echo 首次运行，正在安装依赖...
  call npm install
)

REM 设置 QLCPLUS_BIN=QLC+ 安装目录下 qlcplus.exe 的完整路径，如果不在系统 PATH 里
REM set QLCPLUS_BIN=C:\QLC+5\qlcplus.exe

node index.js
pause
