/**
 * PIKA-Show 远程客户端——装在直播间那台 Windows 电脑上跑的程序。
 *
 * 只支持 Windows，不做跨平台——这是产品定位决定的（现场那台灯控电脑就是
 * Windows），没必要为了"理论上能跨平台"多花工夫，see start.bat。
 *
 * 2026-09 从纯控制台程序改成带图形界面：lib/engine.js 是原来堆在这个文件里的
 * 连接/QLC+/配对逻辑（几乎原样搬过去，只有"配对验证码怎么问"从 readline 问
 * 控制台改成了 GUI 弹输入框），lib/ui.js 是新加的 @webviewjs/webview 窗口，
 * lib/updater.js 是新加的检查更新/热更新。这个文件现在只做"把两者接起来"。
 *
 * 环境变量（跟之前一致）：
 *   PIKA_SHOW_HOST   服务端域名，默认 show.pika.club
 *   QLCPLUS_BIN      qlcplus.exe 完整路径，默认从 PATH 里找 "qlcplus.exe"
 *   QLCPLUS_PORT     QLC+ 内建 Web API 监听端口，默认 9999
 *   QLCPLUS_WORKSPACE 要自动加载的配接方案文件（.qxw），可选
 *
 * 2026-09-14 起打包时把 exe 的 PE 子系统从 CONSOLE 改成 WINDOWS（见
 * pika-show-remote-client 仓库 build.yml 里的 editbin 步骤），双击运行不再
 * 弹出黑色命令行窗口，只剩这个 GUI 窗口——用户反馈原来那个命令行窗口很碍眼。
 * 副作用：普通双击启动时这个进程没有控制台，process.stdout/stderr 没有
 * 有效句柄，直接 console.log 在这种情况下可能同步抛错（Windows 平台的已知
 * 坑）——整个代码库到处散落着 console.log/console.error（QLC+ 状态、扫描
 * 报错等），一个个找出来改不现实也容易漏，所以在整个程序的最上游、任何其它
 * 代码跑之前，把 console.log/error/warn/info 整体包一层 try/catch：没有
 * 控制台就静默吞掉，不会拖垮整个进程。日志真正显示给用户看的地方是 GUI 窗口
 * 里那个日志框（engine.js 的 log() 会同时 emit 给它，见 ui.js 的 pushLog），
 * 不依赖这几个 console.* 调用能不能成功。 */
for (const method of ["log", "error", "warn", "info"]) {
  const original = console[method].bind(console);
  console[method] = (...args) => { try { original(...args); } catch {} };
}

const RemoteEngine = require("./lib/engine");
const { startUI } = require("./lib/ui");

const engine = new RemoteEngine();
engine.start();
startUI(engine);

process.on("SIGINT", () => { engine.shutdown(); process.exit(0); });
process.on("SIGTERM", () => { engine.shutdown(); process.exit(0); });
