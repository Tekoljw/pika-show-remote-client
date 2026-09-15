# PIKA-Show 远程客户端

装在直播间那台 **Windows** 电脑上跑的程序。只支持 Windows,不做跨平台——现场那台灯控电脑就是 Windows,没必要为了理论上的跨平台能力多花工夫。

2026-09 起带一个简单图形界面(`@webviewjs/webview`,Windows 下走系统自带的 WebView2,不是 Electron):连接开关、填连接密钥、改设备名字、检查更新。

## 依赖

- [Node.js](https://nodejs.org/) **>= 24**(源码直跑才需要;`@webviewjs/webview` 要求这个版本,打包成 exe 之后不用装 Node)
- [QLC+](https://www.qlcplus.org/)——2026-09-14 起**打包进了分发产物里,不用用户自己单独装**（Apache 2.0 协议允许这样重新分发,见项目记忆 `reference_qlcplus_bundling.md`）。CI 打包时会去官网下载官方安装包解出 `qlcplus.exe` 一起分发,跟我们自己的 exe 放在同一个 `qlcplus/` 子目录里。如果这台电脑本来就单独装过 QLC+、又没有这个捆绑目录,会退回系统 PATH 里找,也可以用 `QLCPLUS_BIN` 环境变量显式指定
- Windows 10 1809 及以上 / Windows 11 通常已经自带 WebView2 运行时;老系统缺失时 Microsoft Edge 会自动补装,一般不用额外操心

## 界面说明

打开后一个窗口,几个卡片:

- **连接状态**:显示有没有连上 PIKA-Show 服务端,旁边一个"连接/断开"按钮——断开只是停掉这条远程连接,本地 QLC+ 不受影响
- **连接密钥**:第一次跑、本地还没存密钥时才会出现这张卡片,把 Telegram 里"🔑 获取我的连接密钥"发来的密钥粘贴进去提交,粘一次以后自动记住(DPAPI 加密存本地),断线自动重连不用再填
- **管理员 TG ID**:认证成功后自动显示——是密钥归属的那个 Telegram 用户,不是手填的
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

产物是 `dist/` 整个目录——`pika-show-remote.exe` 加一个 `qlcplus/` 子目录（打包时自动下载官方 QLC+ 装好，见上面"依赖"一节），不再是单文件。CI（`pika-show-remote-client` 镜像仓库的 `build.yml`）在此基础上还会用 Inno Setup（`installer.nsi` 已废弃，改用 `installer.iss`；`windows-latest` runner 实测自带，路径 `C:\Program Files (x86)\Inno Setup 6\ISCC.exe`）打包出一个单文件安装向导 `PIKA-Show-Setup-v<版本>.exe`，装的时候会顺手把"开机自动启动"也配好——GitHub Release 里三份资产都会挂：**新用户首次安装推荐用 `PIKA-Show-Setup-v<版本>.exe`**（双击、下一步、完成，自动配自启动）；`pika-show-remote-v<版本>.zip` 是免安装完整包，解压即用；`pika-show-remote.exe` 是裸 exe，给已经装过 QLC+ 的老用户或热更新用。界面里的"检查更新"只在打包后的 exe 里有效——源码直跑(`node index.js`)模式下点"检查更新"能查,但"立即更新"会报错拒绝执行,因为没有一个"自己"可以被替换。

**如实说明这一层保护的边界**:这只是把代码+Node 运行时打包成一个二进制文件,不是加密。打包格式(`pkg`/`@yao-pkg/pkg`)本身是公开、有文档的,懂行的人用现成工具能把代码整个提取出来——这一步的作用是"用户拿到的是一个 exe,不是能直接打开看的源码文件夹",劝退非技术用户,挡不住真正想反编译的人。

技术细节留个坑:打包目标是 Windows,但如果在非 Windows 机器上构建(比如这个仓库现在托管的 EC2 是 Linux),必须带 `--public-packages "*" --public` 这两个参数,否则会在目标机器上报 `V8 rejected the bytecode cache` 错误——这是 V8 字节码不能跨平台/跨构建环境复用导致的,`npm run build:win` 已经带上了这两个参数,不要手动去掉。

## 配对

2026-09-15 起改成密钥直连（取代验证码人工配对流程，见项目记忆
`reference_pc_key_auth.md`）——**本地会存一份密钥**（DPAPI 加密，只有这台机器
+ 这个 Windows 账号能解开），第一次跑或者本地没有密钥时才弹密钥输入卡片。
在 Telegram 里点底部键盘"🔑 获取我的连接密钥"，bot 会私聊发一条密钥消息
（5 分钟后自动撤回），粘贴进客户端提交即可——只有一次性操作，以后每次启动
或断线都会自动用这把密钥重连，不需要再人工干预。密钥被管理后台吊销后，
本地这份会被清掉，重新弹出输入卡片，需要回 Telegram 重新申请一把。

## 检查更新 / 热更新

点界面里的"检查更新",会去查 [pika-show-remote-client 这个公开仓库](https://github.com/Tekoljw/pika-show-remote-client/releases) 的最新 Release,跟当前 `package.json` 里的版本号比对。有新版会出现"立即更新"按钮,点了之后:下载新 exe → 等当前进程退出 → 把新文件换到位 → 自动重新拉起。整个过程会重启程序,直播中不要手贱点。

⚠️ **热更新目前只替换 `pika-show-remote.exe` 这一个文件,不会动 `qlcplus/` 这个捆绑目录**——QLC+ 版本的升级还没纳入热更新范围(见项目记忆 `reference_qlcplus_bundling.md` 的"打包形态改变的连锁影响"一节,这是打包进 QLC+ 之后还没做完的后续工作),真要换 QLC+ 版本目前得整个重新下载安装包。

新版本的发布是 CI 自动做的(`.github/workflows/build.yml` 构建通过后,按 `package.json` 里的版本号自动建一个新 Release、把打包好的 zip 挂上去)——要发新版本,改代码的同时把 `package.json` 的 `version` 也提一下,push 之后 CI 会自动出新 Release。

## 环境变量(都是可选的,不设就用默认值)

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PIKA_SHOW_HOST` | `show.pika.club` | 服务端域名 |
| `QLCPLUS_BIN` | 优先用打包时捆绑的那份,没有才退回 PATH | QLC+ 可执行文件完整路径,显式指定的优先级最高 |
| `QLCPLUS_PORT` | `9999` | QLC+ 内建 Web API 端口 |
| `QLCPLUS_WORKSPACE` | 无 | 启动时自动加载的配接方案(`.qxw`)文件路径 |
