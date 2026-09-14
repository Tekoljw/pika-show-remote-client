/**
 * 简单 GUI——用 @webviewjs/webview（Windows 下走系统自带 WebView2，标准 N-API
 * 原生模块，不需要换 Electron、不需要换掉现在这套 pkg 打包流水线，见
 * package.json 里这个依赖旁边的注释）。
 *
 * 页面内容整段内嵌在这个文件里（不拆单独的 .html 资源文件）——pkg 打包单文件
 * exe 时少一层"资源文件路径在哪"的麻烦，跟"内联 HTML"是 webviewjs 官方示例
 * 本来就支持的用法，不是退而求其次。
 *
 * Node → 页面推状态：webview.evaluateScript() 直接调页面里的 window.onEngineState()。
 * 页面 → Node 调用：webview.expose('native', {...}) 挂一组函数，页面用
 * window.native.xxx() 调（webviewjs 官方 expose 示例就是这个写法）。
 *
 * 2026-09-14 起窗口固定大小、不可拖动缩放（用户反馈原来那个可缩放窗口连带
 * 出现的滚动条很碍眼，见 startUI 里 resizable:false 和 body 的
 * overflow:hidden）——布局也跟着收紧了一版，卡片合并、间距变小，目的是让
 * 全部内容一屏放得下，不需要滚动。
 */

const { Application } = require("@webviewjs/webview");
const { checkForUpdate, applyUpdate, CURRENT_VERSION } = require("./updater");
const { scanDevices } = require("./scan");

const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>PIKA-Show 远程客户端</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { overflow: hidden; }
  body {
    margin: 0; padding: 12px; background: #0f0f18; color: #e8e8ef;
    font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; font-size: 13px;
  }
  h1 { font-size: 15px; margin: 0 0 2px; }
  .version { color: #888; font-size: 11px; margin-bottom: 10px; }
  .card { background: #1a1a26; border: 1px solid #2a2a3a; border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; }
  .row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .row:last-child { margin-bottom: 0; }
  .label { color: #999; min-width: 76px; flex-shrink: 0; font-size: 12.5px; }
  .value { flex: 1; word-break: break-all; font-size: 12.5px; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; }
  .badge.on { background: #16321f; color: #4ade80; }
  .badge.off { background: #33161a; color: #f87171; }
  .badge.pending { background: #332a16; color: #fbbf24; }
  input[type=text] {
    flex: 1; background: #0f0f18; border: 1px solid #333; color: #e8e8ef;
    border-radius: 6px; padding: 6px 8px; font-size: 13px;
  }
  button {
    background: #6d5bd0; border: none; color: white; border-radius: 6px;
    padding: 6px 12px; font-size: 12px; cursor: pointer; flex-shrink: 0;
  }
  button:hover { background: #7d6be0; }
  button:disabled { background: #333; color: #777; cursor: not-allowed; }
  button.secondary { background: #2a2a3a; }
  button.secondary:hover { background: #3a3a4a; }
  button.danger { background: #7a2a2a; }
  button.danger:hover { background: #932f2f; }
  .hint { color: #777; font-size: 11px; margin-top: 4px; }
  .log { background: #000; border-radius: 8px; padding: 8px; height: 76px; overflow-y: auto;
    font-family: Consolas, monospace; font-size: 10.5px; color: #6a6; white-space: pre-wrap; }
</style>
</head>
<body>
  <h1>PIKA-Show 远程客户端</h1>
  <div class="version">版本 v<span id="version"></span></div>

  <div class="card">
    <div class="row">
      <div class="label">连接状态</div>
      <div class="value"><span id="connBadge" class="badge off">未连接</span></div>
      <button id="connToggle">连接</button>
    </div>
    <div class="row">
      <div class="label">设备接口引擎</div>
      <div class="value"><span id="qlcBadge" class="badge off">未就绪</span></div>
    </div>
    <div class="row">
      <div class="label">灯控台连接</div>
      <div class="value"><span id="consoleBadge" class="badge off">未扫描</span></div>
      <button id="consoleScanBtn" class="secondary">扫描</button>
    </div>
    <div class="row" id="ownerRow" style="display:none">
      <div class="label">管理员 TG ID</div>
      <div class="value" id="ownerId">—</div>
    </div>
  </div>

  <div class="card" id="pairingCard" style="display:none">
    <div class="row">
      <div class="label">配对验证码</div>
      <input type="text" id="pairingInput" placeholder="Telegram 里收到的 6 位验证码" maxlength="6" />
      <button id="pairingSubmit">提交</button>
    </div>
    <div class="hint">管理员的 Telegram 会收到一条验证码消息，填进来完成配对。</div>
  </div>

  <div class="card">
    <div class="row">
      <div class="label">设备名字</div>
      <input type="text" id="nameInput" placeholder="给这台 PC 起个名字" maxlength="60" />
      <button id="nameSubmit">保存</button>
    </div>
    <div class="hint" id="nameHint"></div>
    <div class="row">
      <div class="label">检查更新</div>
      <button id="checkUpdateBtn" class="secondary">检查更新</button>
      <button id="applyUpdateBtn" style="display:none">立即更新</button>
    </div>
    <div class="hint" id="updateHint">当前已是最新版本时不会有提示</div>
  </div>

  <div class="card">
    <div class="row"><div class="label">运行日志</div></div>
    <div class="log" id="logBox"></div>
  </div>

<script>
  const $ = (id) => document.getElementById(id);
  let state = { connected: false, pairingPending: false, deviceName: "", ownerTelegramId: null, qlcReady: false };

  function render() {
    $("connBadge").textContent = state.connected ? "已连接" : "未连接";
    $("connBadge").className = "badge " + (state.connected ? "on" : "off");
    $("connToggle").textContent = state.connected ? "断开" : "连接";
    $("connToggle").className = state.connected ? "danger" : "";

    $("qlcBadge").textContent = state.qlcReady ? "已就绪" : "未就绪";
    $("qlcBadge").className = "badge " + (state.qlcReady ? "on" : "off");

    $("pairingCard").style.display = state.pairingPending ? "" : "none";

    $("ownerRow").style.display = state.ownerTelegramId ? "" : "none";
    $("ownerId").textContent = state.ownerTelegramId || "—";

    if (document.activeElement !== $("nameInput")) {
      $("nameInput").value = state.deviceName || "";
    }
  }

  window.onEngineState = function (s) {
    state = s;
    render();
  };

  window.onEngineLog = function (line) {
    const box = $("logBox");
    box.textContent += line + "\\n";
    box.scrollTop = box.scrollHeight;
  };

  window.addEventListener("DOMContentLoaded", async () => {
    $("version").textContent = await window.native.getVersion();
    state = await window.native.getState();
    render();
  });

  $("connToggle").onclick = () => {
    if (state.connected) window.native.disconnect();
    else window.native.reconnect();
  };

  $("pairingSubmit").onclick = () => {
    const code = $("pairingInput").value.trim();
    if (code) window.native.submitPairingCode(code);
  };

  $("nameSubmit").onclick = async () => {
    const name = $("nameInput").value.trim();
    if (!name) return;
    $("nameHint").textContent = "保存中...";
    const result = await window.native.setName(name);
    $("nameHint").textContent = result.ok ? "已保存并同步到云端" : ("失败: " + (result.error || "未知错误"));
  };

  // 灯控台连接——本地直接枚举 MIDI/串口设备（跟 light-sync-ui 网页"扫描设备"
  // 底层用的是同一个 scanDevices()），不走服务端，纯粹给这台电脑上的用户
  // 一个"接没接上灯控硬件"的直观状态，识别不到就明确显示未检测到，不是一直
  // 转圈也不是假装成功。
  $("consoleScanBtn").onclick = async () => {
    $("consoleScanBtn").disabled = true;
    $("consoleBadge").textContent = "扫描中...";
    $("consoleBadge").className = "badge pending";
    const r = await window.native.scanConsole();
    $("consoleScanBtn").disabled = false;
    if (!r.ok) {
      $("consoleBadge").textContent = "扫描失败";
      $("consoleBadge").className = "badge off";
      return;
    }
    const names = [...(r.midi || []), ...(r.serial || []).map((s) => s.device)];
    if (names.length === 0) {
      $("consoleBadge").textContent = "未检测到";
      $("consoleBadge").className = "badge off";
    } else {
      $("consoleBadge").textContent = names.length > 1 ? \`\${names[0]} 等 \${names.length} 个\` : names[0];
      $("consoleBadge").className = "badge on";
    }
  };

  $("checkUpdateBtn").onclick = async () => {
    $("updateHint").textContent = "检查中...";
    $("applyUpdateBtn").style.display = "none";
    const r = await window.native.checkForUpdate();
    if (r.error) {
      $("updateHint").textContent = "检查失败: " + r.error;
    } else if (r.hasUpdate) {
      $("updateHint").textContent = \`发现新版本 \${r.latestVersion}（当前 \${r.currentVersion}）\`;
      $("applyUpdateBtn").style.display = "";
      $("applyUpdateBtn").onclick = async () => {
        $("applyUpdateBtn").disabled = true;
        $("updateHint").textContent = "更新中，程序即将自动重启...";
        await window.native.applyUpdate(r.downloadUrl);
      };
    } else {
      $("updateHint").textContent = \`已是最新版本（\${r.currentVersion}）\`;
    }
  };

  render();
</script>
</body>
</html>`;

/**
 * @param {import('./engine')} engine
 */
function startUI(engine) {
  const app = new Application();
  const window = app.createBrowserWindow({
    title: "PIKA-Show 远程客户端",
    width: 420,
    height: 560,
    resizable: false,
  });
  const webview = window.createWebview({ html: HTML, ipcName: "bindings" });

  webview.expose("native", {
    getVersion: async () => CURRENT_VERSION,
    getState: async () => engine.getState(),
    reconnect: async () => { engine.reconnect(); },
    disconnect: async () => { engine.disconnect(); },
    submitPairingCode: async (code) => { engine.submitPairingCode(code); },
    setName: async (name) => {
      return new Promise((resolve) => {
        const onResult = (msg) => { engine.off("set_name_result", onResult); resolve(msg); };
        engine.on("set_name_result", onResult);
        engine.setName(name);
        setTimeout(() => { engine.off("set_name_result", onResult); resolve({ ok: false, error: "超时" }); }, 8000);
      });
    },
    // 灯控台连接检测——直接本地枚举，不经过 engine/WS，跟连不连得上服务端无关。
    scanConsole: async () => {
      try {
        const devices = await scanDevices();
        return { ok: true, ...devices };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
    checkForUpdate: async () => checkForUpdate(),
    applyUpdate: async (downloadUrl) => {
      try {
        await applyUpdate(downloadUrl, (msg) => engine.log(msg));
        return { ok: true };
      } catch (e) {
        engine.log(`更新失败: ${e.message}`);
        return { ok: false, error: e.message };
      }
    },
  });

  // engine.start()（在 index.js 里，早于这个函数）一连上服务端就会同步触发
  // "log"/"state" 事件——WS 连接是异步的，完全可能在 app.run() 真正把原生
  // 事件循环转起来、webview 页面加载完成之前就先连上了。这种情况下
  // evaluateScript() 返回的不是 rejected Promise，而是 undefined（原生绑定
  // 还没就绪，压根没能力创建 Promise）——直接 .catch() 会抛
  // "Cannot read properties of undefined (reading 'catch')"，直接崩溃退出，
  // 表现为"启动就闪崩"（2026-09-14 用户实测到的真实崩溃，见完整堆栈）。
  // 用 ?. 兜底：webview 没就绪时这次推送静默丢弃（日志/状态晚一点点才能看到，
  // 但程序不再因为这个崩溃），try/catch 再兜一层同步抛出的情况。
  const pushState = (state) => {
    try { webview.evaluateScript(`window.onEngineState(${JSON.stringify(state)})`)?.catch(() => {}); } catch {}
  };
  const pushLog = (line) => {
    try { webview.evaluateScript(`window.onEngineLog(${JSON.stringify(line)})`)?.catch(() => {}); } catch {}
  };
  engine.on("state", pushState);
  engine.on("log", pushLog);

  // QLC+ 就不就绪不会主动 emit('state')（qlcEngine 自己不知道 engine 的存在），
  // 用轮询兜底刷一下这个字段，别的字段（connected/pairingPending/...)本来就是
  // 事件驱动的，不受这个轮询影响。
  const qlcPoll = setInterval(() => pushState(engine.getState()), 3000);

  app.on("application-close-requested", () => {
    clearInterval(qlcPoll);
    engine.shutdown();
    app.exit();
  });

  app.run();
}

module.exports = { startUI };
