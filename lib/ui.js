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
  h1 { font-size: 15px; margin: 0 0 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
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
  <h1 id="titleName">PIKA-Show</h1>
  <div class="version">版本 v<span id="version">${CURRENT_VERSION}</span></div>

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

  <div class="card" id="keyCard" style="display:none">
    <div class="row">
      <div class="label">连接密钥</div>
      <input type="text" id="keyInput" placeholder="在 Telegram 里点「🔑 获取我的连接密钥」，粘贴到这里" />
      <button id="keySubmit">提交</button>
    </div>
    <div class="hint">粘贴一次密钥即可，之后会自动连接、断线自动重连，不用再输第二次。</div>
    <div class="hint" id="keyHint"></div>
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
  let state = { connected: false, needsKey: false, deviceName: "", ownerTelegramId: null, qlcReady: false };

  function render() {
    $("titleName").textContent = state.deviceName || "PIKA-Show";
    // 2026-09-15 用户实机确认：v1.3.2 那版"靠 getVersion()/state 推送兜底"的
    // 修复在真实 WebView2 上没生效，版本号一直空白，等多久都没用——原生 IPC
    // 这条链路本身在真机上不可靠，具体哪一步失效未查清。版本号已经在初始 HTML
    // 里直接烧死（见上面 <span id="version">${CURRENT_VERSION}</span>），
    // 不再依赖任何异步调用。这行只是万一 IPC 某次真的推送成功，顺手保持一致，
    // 删掉也不影响版本号显示。
    if (state.version) $("version").textContent = state.version;

    $("connBadge").textContent = state.connected ? "已连接" : "未连接";
    $("connBadge").className = "badge " + (state.connected ? "on" : "off");
    $("connToggle").textContent = state.connected ? "断开" : "连接";
    $("connToggle").className = state.connected ? "danger" : "";

    $("qlcBadge").textContent = state.qlcReady ? "已就绪" : "未就绪";
    $("qlcBadge").className = "badge " + (state.qlcReady ? "on" : "off");

    $("keyCard").style.display = state.needsKey ? "" : "none";

    $("ownerRow").style.display = state.ownerTelegramId ? "" : "none";
    $("ownerId").textContent = state.ownerTelegramId || "—";

    if (document.activeElement !== $("nameInput")) {
      $("nameInput").value = state.deviceName || "";
    }

    reportSize();
  }

  // 量出真实内容高度，报给 Node 端去校正窗口大小（见 startUI 的
  // resizeToContent）——固定像素猜的窗口高度在真实 WebView2 上跟本地验证
  // 布局用的环境字体度量/系统缩放比例都可能不一样，会裁掉内容看不见，
  // 2026-09-14 用户实测到"底下内容显示不出来"就是这个原因。不做"高度没变
  // 就跳过"这种优化——每次 render 都调一次，setSize 传同样的值是无害的
  // 空操作，这样即使最早几次调用因为 native 绑定还没就绪而静默失败，后面
  // 每次 render（含每 3 秒一次的状态轮询）都会重试，不会因为"记录过上次
  // 报告的高度"而错过真正生效的那一次。
  function reportSize() {
    window.native?.resizeToContent(document.body.scrollHeight)?.catch(() => {});
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

  // DOMContentLoaded 这一刻，webview 的原生 IPC 绑定(window.native.*)不一定
  // 已经就绪——跟 Node→页面推送方向那个"webview 没就绪时 evaluateScript 崩溃"
  // 是同一类时序竞态，只是这次反过来，是页面主动调 native 可能直接卡住/静默
  // 失败（2026-09-14 用户实测：版本号和真实连接状态都没显示出来，一直停在
  // 默认值）。这里只当是"尽早显示"的乐观路径，失败也无所谓——Node 那边
  // engine.on("state",...) 的监听在 app.run() 之前就注册好了，不依赖页面
  // 加载进度，每次 engine 状态变化、以及每 3 秒一次的轮询都会主动把真实
  // state（含 version）推过来，即使这次主动拉取失败，最多几秒后也会被
  // 推送纠正，不会永远卡在初始占位值。
  window.addEventListener("DOMContentLoaded", async () => {
    try {
      const [version, s] = await Promise.all([window.native.getVersion(), window.native.getState()]);
      state = { ...state, ...s, version };
      render();
    } catch (e) {
      console.error("初始状态拉取失败，等待 Node 主动推送兜底:", e);
    }
  });

  $("connToggle").onclick = () => {
    if (state.connected) window.native.disconnect();
    else window.native.reconnect();
  };

  $("keySubmit").onclick = () => {
    const key = $("keyInput").value.trim();
    if (!key) return;
    window.native.submitKey(key);
    $("keyHint").textContent = "已提交，正在连接...";
    setTimeout(() => { $("keyHint").textContent = ""; }, 5000);
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
  // 初始高度只是个"先别太难看"的起步值——用户反馈按固定像素猜的高度在真实
  // WebView2（跟这里本地验证布局用的 Chromium/Linux 环境字体度量、可能还有
  // Windows 缩放比例都不一样）上会裁掉底部内容。真正准确的尺寸交给页面自己
  // 量出真实内容高度后通过 resizeToContent 这个 native 调用修正，见下面
  // webview.expose 和页面脚本里的 reportSize()。resizable:false 只挡用户
  // 手动拖动缩放，不影响程序自己调用 setSize()。
  const window = app.createBrowserWindow({
    title: "PIKA-Show 远程客户端",
    width: 420,
    height: 600,
    resizable: false,
  });
  const webview = window.createWebview({ html: HTML, ipcName: "bindings" });

  webview.expose("native", {
    getVersion: async () => CURRENT_VERSION,
    getState: async () => engine.getState(),
    // 页面量出真实内容高度后调这个校正窗口大小——setSize 是同步的原生调用，
    // 不是 evaluateScript 那种"webview 没就绪就返回 undefined"的坑，包一层
    // try/catch 纯粹是兜底极端情况（比如窗口已经在关闭过程中）。
    resizeToContent: async (height) => {
      try {
        const h = Math.min(900, Math.max(420, Math.round(height) + 40));
        window.setSize(420, h, true);
      } catch {}
    },
    reconnect: async () => { engine.reconnect(); },
    disconnect: async () => { engine.disconnect(); },
    submitKey: async (key) => { engine.submitKey(key); },
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
  // version 顺带塞进每次 state 推送——页面自己主动拉取版本号
  // （DOMContentLoaded 里调 window.native.getVersion()）在 webview 绑定还没
  // 就绪时可能失败/卡住，靠这里的主动推送兜底：只要收到过一次 state 推送
  // （最迟 3 秒后的轮询，见下面 qlcPoll），版本号就会被补上，不会一直空白。
  const pushState = (state) => {
    try { webview.evaluateScript(`window.onEngineState(${JSON.stringify({ ...state, version: CURRENT_VERSION })})`)?.catch(() => {}); } catch {}
  };
  const pushLog = (line) => {
    try { webview.evaluateScript(`window.onEngineLog(${JSON.stringify(line)})`)?.catch(() => {}); } catch {}
  };
  engine.on("state", pushState);
  engine.on("log", pushLog);

  // QLC+ 就不就绪不会主动 emit('state')（qlcEngine 自己不知道 engine 的存在），
  // 用轮询兜底刷一下这个字段，别的字段（connected/needsKey/...)本来就是
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
