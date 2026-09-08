/**
 * 无头 QLC+ 子进程管理——PIKA-Show 远程客户端自己的"灯光引擎"用它，不启动、
 * 也不需要它的任何界面（桌面版/QML版/网页版虚拟控制台全部不碰）。
 *
 * 只支持 Windows（产品定位就是装在直播间那台 Windows 电脑上，不做跨平台）。
 *
 * 命令行参数含义（`--nogui --nowm` 组合是官方要求的写法，在 Linux 上
 * `--nowm` 对应 X11 有没有窗口管理器；这个判断在 Windows 上根本不编译，
 * 传了也是无害的空操作，两个参数保持官方推荐的写法一起传，不用纠结）：
 *   --nogui --nowm   完全不显示界面
 *   --operate        跳过"设计模式"，直接进入运行模式，不需要人手动切换
 *   --open <file>    自动加载配接方案（灯具型号 <-> DMX 地址的绑定关系）
 *   --web --web-port 打开内建的远程控制 WebSocket 接口
 *
 * 控制方式是纯文本 WebSocket 协议（"QLC+API|..."/"CH|..."），完全绕开它的
 * HTML/CSS/JS 虚拟控制台——那部分我们一行都不用。
 *
 * QT_QPA_PLATFORM 不强制设默认值——那是在没有显示器的 Linux 服务器上才需要
 * 的 workaround（开发时在 EC2 上验证用的），Windows 正常用户会话下 Qt 默认
 * 的 platform 插件就能正常初始化，不需要这个环境变量。
 */

const { spawn } = require("child_process");
const WebSocket = require("ws");

const RESTART_DELAY_MS = 5000;
const WS_RECONNECT_DELAY_MS = 3000;
const WS_CONNECT_GRACE_MS = 2000;

class QlcEngine {
  constructor({ binaryPath = "qlcplus.exe", port = 9999, workspace = null } = {}) {
    this.binaryPath = binaryPath;
    this.port = port;
    this.workspace = workspace;
    this.proc = null;
    this.ws = null;
    this._stopping = false;
    this._restartTimer = null;
    this._reconnectTimer = null;
  }

  start() {
    this._stopping = false;
    const args = ["--nogui", "--nowm", "--operate", "--web", "--web-port", String(this.port)];
    if (this.workspace) args.push("--open", this.workspace);

    console.log(`[QLC+] 启动: ${this.binaryPath} ${args.join(" ")}`);
    this.proc = spawn(this.binaryPath, args, { env: process.env });

    this.proc.stdout.on("data", (d) => console.log(`[QLC+ stdout] ${String(d).trim()}`));
    this.proc.stderr.on("data", (d) => console.error(`[QLC+ stderr] ${String(d).trim()}`));
    this.proc.on("error", (e) => console.error(`[QLC+] 启动失败: ${e.message}（确认 QLC+ 是否已安装、在 PATH 里）`));
    this.proc.on("exit", (code) => {
      this.proc = null;
      if (this._stopping) return;
      console.error(`[QLC+] 进程退出(code=${code})，${RESTART_DELAY_MS / 1000} 秒后自动重启`);
      this._restartTimer = setTimeout(() => this.start(), RESTART_DELAY_MS);
    });

    setTimeout(() => this._connectWs(), WS_CONNECT_GRACE_MS);
  }

  _connectWs() {
    if (this._stopping) return;
    this.ws = new WebSocket(`ws://127.0.0.1:${this.port}/qlcplusWS`);
    this.ws.on("open", () => console.log("[QLC+] WebSocket 已连接，可以发指令了"));
    this.ws.on("error", (e) => console.error(`[QLC+] WebSocket 错误: ${e.message}`));
    this.ws.on("close", () => {
      if (this._stopping) return;
      console.log(`[QLC+] WebSocket 断开，${WS_RECONNECT_DELAY_MS / 1000} 秒后重连`);
      this._reconnectTimer = setTimeout(() => this._connectWs(), WS_RECONNECT_DELAY_MS);
    });
  }

  get ready() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * 换一份新的配接方案重新加载——灯光库同步之后调用。QLC+ 没有暴露"热重新
   * 加载配接方案"的 API，只能整个重启进程，重启期间(几秒)灯光会短暂失控，
   * 只在灯光库真的变了的时候才调用，不要频繁触发。
   */
  reload(workspacePath) {
    this.workspace = workspacePath;
    console.log(`[QLC+] 配接方案已更新，重启加载: ${workspacePath}`);
    if (this.proc) {
      this._stopping = true; // 借用这个标记，让 exit 回调不要走自动重启那条路
      const finishRestart = () => {
        this._stopping = false;
        this.start();
      };
      this.proc.once("exit", finishRestart);
      this.proc.kill();
    } else {
      this.start();
    }
  }

  /** 直接设置一个 DMX 通道的值（地址从 1 开始，对应 QLC+ 的 CH 命令） */
  setChannel(address, value) {
    if (!this.ready) return false;
    this.ws.send(`CH|${address}|${value}`);
    return true;
  }

  /** 触发/停止一个已经在配接方案里编排好的 Function（场景/Chase） */
  setFunctionStatus(functionId, running) {
    if (!this.ready) return false;
    this.ws.send(`QLC+API|setFunctionStatus|${functionId}|${running ? 1 : 0}`);
    return true;
  }

  stop() {
    this._stopping = true;
    if (this._restartTimer) clearTimeout(this._restartTimer);
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this.ws) { this.ws.removeAllListeners(); this.ws.close(); this.ws = null; }
    if (this.proc) { this.proc.kill(); this.proc = null; }
  }
}

module.exports = QlcEngine;
