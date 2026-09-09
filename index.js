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
 */

const RemoteEngine = require("./lib/engine");
const { startUI } = require("./lib/ui");

const engine = new RemoteEngine();
engine.start();
startUI(engine);

process.on("SIGINT", () => { engine.shutdown(); process.exit(0); });
process.on("SIGTERM", () => { engine.shutdown(); process.exit(0); });
