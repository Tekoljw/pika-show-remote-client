# PIKA-Show 远程客户端

装在直播间那台 **Windows** 电脑上跑的程序。只支持 Windows,不做跨平台——现场那台灯控电脑就是 Windows,没必要为了理论上的跨平台能力多花工夫。

## 依赖

- [Node.js](https://nodejs.org/)(建议 LTS 版本)
- [QLC+](https://www.qlcplus.org/)(装好之后确认 `qlcplus.exe` 在系统 PATH 里,或者用 `QLCPLUS_BIN` 环境变量指定完整路径)

## 使用方式一:源码直跑(开发/调试用)

双击 `start.bat`,首次运行会自动 `npm install`。

要开机/登录自动启动:把 `start.bat` 的快捷方式放进"启动"文件夹(`Win+R` 输入 `shell:startup`)。

## 使用方式二:打包成单文件 exe(要分发给用户装的时候用这个)

```bash
npm install
npm run build:win
```

产物在 `dist/pika-show-remote.exe`,一个文件、不用装 Node.js,双击就能跑(QLC+ 还是要单独装)。

**如实说明这一层保护的边界**:这只是把代码+Node 运行时打包成一个二进制文件,不是加密。打包格式(`pkg`/`@yao-pkg/pkg`)本身是公开、有文档的,懂行的人用现成工具能把代码整个提取出来——这一步的作用是"用户拿到的是一个 exe,不是能直接打开看的源码文件夹",劝退非技术用户,挡不住真正想反编译的人。

技术细节留个坑:打包目标是 Windows,但如果在非 Windows 机器上构建(比如这个仓库现在托管的 EC2 是 Linux),必须带 `--public-packages "*" --public` 这两个参数,否则会在目标机器上报 `V8 rejected the bytecode cache` 错误——这是 V8 字节码不能跨平台/跨构建环境复用导致的,`npm run build:win` 已经带上了这两个参数,不要手动去掉。

## 配对

首次启动没有本地保存的 `device_token` 时,会在控制台提示:

```
请输入管理员在 Telegram 里收到的配对验证码:
```

管理员打开 Telegram 会收到验证码,输进去就完成配对了。之后每次启动都会用保存下来的 `device_token` 自动认证,不用再输一遍。

## 环境变量(都是可选的,不设就用默认值)

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PIKA_SHOW_HOST` | `show.pika.club` | 服务端域名 |
| `QLCPLUS_BIN` | `qlcplus.exe`(从 PATH 找) | QLC+ 可执行文件完整路径 |
| `QLCPLUS_PORT` | `9999` | QLC+ 内建 Web API 端口 |
| `QLCPLUS_WORKSPACE` | 无 | 启动时自动加载的配接方案(`.qxw`)文件路径 |
