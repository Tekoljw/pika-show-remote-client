# PIKA-Show 远程客户端

装在直播间那台 **Windows** 电脑上跑的程序。只支持 Windows,不做跨平台——现场那台灯控电脑就是 Windows,没必要为了理论上的跨平台能力多花工夫。

2026-09 起带一个简单图形界面(`@webviewjs/webview`,Windows 下走系统自带的 WebView2,不是 Electron):连接开关、填配对验证码、改设备名字、检查更新。

## 依赖

- [Node.js](https://nodejs.org/) **>= 24**(源码直跑才需要;`@webviewjs/webview` 要求这个版本,打包成 exe 之后不用装 Node)
- [QLC+](https://www.qlcplus.org/)(装好之后确认 `qlcplus.exe` 在系统 PATH 里,或者在界面里 / 用 `QLCPLUS_BIN` 环境变量指定完整路径)
- Windows 10 1809 及以上 / Windows 11 通常已经自带 WebView2 运行时;老系统缺失时 Microsoft Edge 会自动补装,一般不用额外操心

## 界面说明

打开后一个窗口,几个卡片:

- **连接状态**:显示有没有连上 PIKA-Show 服务端,旁边一个"连接/断开"按钮——断开只是停掉这条远程连接,本地 QLC+ 不受影响
- **配对验证码**:第一次跑、还没配对时才会出现这张卡片,把 Telegram 里收到的 6 位码填进去提交
- **管理员 TG ID**:配对成功后自动显示——不是手填的,是"验证码发给了哪个管理员,谁填的验证码就认作是谁的设备"自动识别出来的(每个管理员收到的码不一样)
- **设备名字**:改了点保存,直接同步到云端,PIKA-Show 的 miniapp/管理后台里看到的就是这个名字
- **检查更新**:点一下查 GitHub 最新发布版本,有新版会出现"立即更新"按钮,点了会下载、自动重启替换成新版本

## 使用方式一:源码直跑(开发/调试用)

双击 `start.bat`,首次运行会自动 `npm install`。

要开机/登录自动启动:把 `start.bat` 的快捷方式放进"启动"文件夹(`Win+R` 输入 `shell:startup`)。

## 使用方式二:打包成单文件 exe(要分发给用户装的时候用这个)

```bash
npm install
npm run build:win
```

产物在 `dist/pika-show-remote.exe`,一个文件、不用装 Node.js,双击就能跑(QLC+ 还是要单独装)。界面里的"检查更新"只在这个打包后的 exe 里有效——源码直跑(`node index.js`)模式下点"检查更新"能查,但"立即更新"会报错拒绝执行,因为没有一个"自己"可以被替换。

**如实说明这一层保护的边界**:这只是把代码+Node 运行时打包成一个二进制文件,不是加密。打包格式(`pkg`/`@yao-pkg/pkg`)本身是公开、有文档的,懂行的人用现成工具能把代码整个提取出来——这一步的作用是"用户拿到的是一个 exe,不是能直接打开看的源码文件夹",劝退非技术用户,挡不住真正想反编译的人。

技术细节留个坑:打包目标是 Windows,但如果在非 Windows 机器上构建(比如这个仓库现在托管的 EC2 是 Linux),必须带 `--public-packages "*" --public` 这两个参数,否则会在目标机器上报 `V8 rejected the bytecode cache` 错误——这是 V8 字节码不能跨平台/跨构建环境复用导致的,`npm run build:win` 已经带上了这两个参数,不要手动去掉。

## 配对

首次启动、本地没有保存的 `device_token` 时,窗口里会弹出"配对验证码"那张卡片。管理员的 Telegram 会收到一条验证码消息(每个管理员收到的码不一样),把自己收到的那个填进去、点提交就完成配对了——这台 PC 会自动记为"这个管理员配对的"。之后每次启动都会用保存下来的 `device_token` 自动认证,不用再填一遍。

## 检查更新 / 热更新

点界面里的"检查更新",会去查 [pika-show-remote-client 这个公开仓库](https://github.com/Tekoljw/pika-show-remote-client/releases) 的最新 Release,跟当前 `package.json` 里的版本号比对。有新版会出现"立即更新"按钮,点了之后:下载新 exe → 等当前进程退出 → 把新文件换到位 → 自动重新拉起。整个过程会重启程序,直播中不要手贱点。

新版本的发布是 CI 自动做的(`.github/workflows/build.yml` 构建通过后,按 `package.json` 里的版本号自动建一个新 Release、把 exe 挂上去)——要发新版本,改代码的同时把 `package.json` 的 `version` 也提一下,push 之后 CI 会自动出新 Release。

## 环境变量(都是可选的,不设就用默认值)

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PIKA_SHOW_HOST` | `show.pika.club` | 服务端域名 |
| `QLCPLUS_BIN` | `qlcplus.exe`(从 PATH 找) | QLC+ 可执行文件完整路径 |
| `QLCPLUS_PORT` | `9999` | QLC+ 内建 Web API 端口 |
| `QLCPLUS_WORKSPACE` | 无 | 启动时自动加载的配接方案(`.qxw`)文件路径 |
