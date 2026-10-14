# Terminal

面向 Windows 11 x64 的极简终端。

![Terminal](src/Mist.Terminal/Assets/terminal.png)

## 安装

从 [Releases](https://github.com/tianshizhici-2026/Terminal/releases/latest) 下载 Windows x64 发行包：

- `Terminal-<版本>-win-x64.zip`：便携版，包含 .NET 运行时。
- `Terminal-<版本>-lite-win-x64.zip`：轻量版，需要安装 [.NET 8 Desktop Runtime x64](https://dotnet.microsoft.com/en-us/download/dotnet/8.0)。

两种版本均需要 [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)。解压整个目录后运行 `Terminal.exe`，可为其创建桌面快捷方式。发行页提供 `SHA256SUMS.txt` 用于核对下载文件。

配置保存在 `%LOCALAPPDATA%\Terminal`。升级时解压到新目录并运行新版即可沿用配置。

## 构建

需要 Windows 11、.NET 8 SDK、Node.js 和 npm。在项目根目录执行：

```powershell
npm ci
npm start
```

生成便携版、轻量版 ZIP 和 SHA-256 校验文件：

```powershell
.\scripts\package.ps1
```

输出位于 `dist/`。打包前关闭目标目录中正在运行的 Terminal。

## 项目结构

```text
src/Mist.Terminal/  WPF / WebView2 宿主、终端会话及 SSH/SFTP
ui/                界面、样式和交互
scripts/           构建、打包及图标生成
tests/             后端与界面测试
licenses/          第三方许可证
```
