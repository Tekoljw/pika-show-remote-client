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
const http = require("http");
const { EventEmitter } = require("events");

const RESTART_DELAY_MS = 5000;
const WS_RECONNECT_DELAY_MS = 3000;
const WS_CONNECT_GRACE_MS = 2000;

// 从 QLC+ 网页配置界面（/config）的 HTML 里挖出每一路 Universe 当前选中的
// 真实输出——2026-09-13 实测确认：QLC+ 把这个选择存在它自己独立的全局设置
// 文件里（~/.config/qlcplus/...conf 的 [outputmap] 段），不是存在项目文件里，
// 人工在网页上选一次之后，这个函数才能把选中的结果读回来，交给上层存进我们
// 自己的配置——因为反过来发现的坑是：如果生成的 .qxw 没有显式写 <Output>
// 标签，QLC+ 加载这份新文件时会把 Universe 重置成"没有输出"，不会自动继续
// 沿用全局设置里记的那个旧选择。所以真正可靠的办法是我们自己记住、每次生成
// 都显式写进 <Output> 标签，不能指望 QLC+ 自己"记得"。
//
// 现在支持多路 Universe（每种连接方式一路，见 qxwGenerator.js 的
// CONNECTION_UNIVERSE_ID），网页配置界面对每路 Universe 各生成一个
// ioChanged('OUTPUT', <universeId>, ...) 的下拉框，这里解析全部而不是只认
// Universe 0，返回 { [universeId]: {plugin,line,lineName} | undefined }。
function parseAllSelectedOutputs(html) {
  const result = {};
  const re = /ioChanged\('OUTPUT',\s*(\d+)/g;
  let match;
  while ((match = re.exec(html))) {
    const universeId = Number(match[1]);
    const endIdx = html.indexOf("</select>", match.index);
    const segment = html.slice(match.index, endIdx === -1 ? undefined : endIdx);
    const optionMatch = segment.match(/<option value="([^"]+)"\s+selected[^>]*>([^<]*)</);
    if (!optionMatch) continue;
    const [, value, label] = optionMatch;
    const [plugin, rawLine] = value.split("|");
    const line = Number(String(rawLine || "").trim());
    if (!plugin || plugin === "None" || !Number.isFinite(line) || line < 0) continue;
    result[universeId] = { plugin, line, lineName: label.trim() };
  }
  return result;
}

class QlcEngine extends EventEmitter {
  constructor({ binaryPath = "qlcplus.exe", port = 9999, workspace = null } = {}) {
    super();
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
    this.ws.on("open", () => {
      console.log("[QLC+] WebSocket 已连接，可以发指令了");
      this.emit("ready");
    });
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
   * 读回每一路 Universe 当前真实选中的输出——用来在人工通过 QLC+ 网页配置界面
   * （http://这台电脑IP:9999/config）选好真实硬件输出之后，把这些选择"抄"
   * 回我们自己的配置里，见 parseAllSelectedOutputs 顶部注释解释为什么必须这么做。
   * 每次 QLC+ 连上之后（start()/reload() 之后）调用一次。返回
   * { [universeId]: {plugin,line,lineName} }，哪路没配过/配置就是"无输出"，
   * 对应的 key 不会出现，不当错误处理。
   */
  readOutputPatch() {
    return new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${this.port}/config`, (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => resolve(parseAllSelectedOutputs(body)));
      });
      req.on("error", () => resolve({}));
      req.setTimeout(5000, () => { req.destroy(); resolve({}); });
    });
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

  /**
   * 直接设置一个通道的值——`address` 是**跨 Universe 的绝对地址**，不是某一路
   * Universe 内的相对通道号。2026-09-13 用本机 headless QLC+ + Loopback 插件
   * 实测确认（扒了 QLC+ 自带网页版 simpledesk.js 的源码印证）：
   *   绝对地址 = Universe序号(0-based) × 512 + 相对通道号(1-based)
   * 例：DMX(Universe 0) 相对通道 5 → 传 5；MIDI(Universe 1) 相对通道 5 → 传 517。
   * 调用方（engine.js 的逐通道实测功能）负责按 CONNECTION_UNIVERSE_ID 算出这个
   * 绝对地址，这里只管原样透传给 QLC+，不做换算。
   */
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
