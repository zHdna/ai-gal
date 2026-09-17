# AI-GAL

**AI-GAL** 是一个完全本地运行的 AI 角色扮演 / 视觉小说（Galgame）引擎。
用 SillyTavern 生态的角色卡驱动多角色剧情：主 AI 负责写故事，管家 AI 负责格式切分与氛围分析，
配合 ComfyUI 自动生成立绘与 CG，支持 TTS 语音朗读、MVU 变量系统、世界书、多存档管理与移动端自适应界面。

后端 Node.js + Express + SQLite（better-sqlite3），前端为原生 JS 游戏化 UI，无需构建、解压即用。

---

## 一、功能特性

### 角色扮演与剧情
- **SillyTavern 兼容角色卡**：支持 `.json` 与 PNG 内嵌卡导入；内置角色卡优化助手（格式规范 / 去重合并）
- **双 AI 流水线**：主 AI 生成剧情（### story / dialog / status / actions 分段），管家 AI 自动完成
  氛围（mood）分析、行动选项生成、记忆摘要、生图触发判断
- **世界书**：关键词 / 常驻 / 关闭三种激活模式，见 `WORLDBOOK_ACTIVATION_GUIDE.md`
- **MVU 变量卡兼容**：支持 `<UpdateVariables>`、JSONPatch、SAM 等变量系统，内置世界状态检视器
- **STscript 兼容**：脚本命令与脚本变量（全局 / 会话级）
- **记忆代理**：每轮生成一句记忆摘要，累计后自动整理成表格注入上下文，长对话不丢剧情

### 视觉与音频
- **ComfyUI 自动生图**：（注：请一定要安装ComfyUI以确保游戏体验）主要功能：角色立绘（portrait）、剧情 CG、角色登场 CG、头像；
  提示词标签按双层结构（Hard Tags + 自然语言）自动组合
- **TTS 语音朗读**：支持火山引擎、阿里百炼、SiliconFlow、Volink 等云端 API 格式，
  以及 ComfyUI Qwen3-TTS（`qwen3-tts-01.json`）本地推理
- **BGM 氛围联动**：按管家 AI 判定的 mood（battle / blue / ceremony / nomal / relaxed / suspense）自动切歌
- **主题系统**：内置多套主题 + 自定义 CSS 变量

### 存档与界面
- **master/sub 存档架构**：按角色分文件夹，存档内含事件日志、角色名册、CG 画廊、生成图片
- **多端界面**：桌面全屏 VN 演出界面 + 手机 / 平板移动端（自动识别跳转，可用 `?desktop=1` 切回）
- **局域网游玩**：`Start-LAN.bat` 启动后，同一网络下的手机可直接访问

---

## 二、快速开始

### 环境

- Windows（`start.bat` 为 Windows 脚本；其他系统可直接 `node server/index.js`）
- 无需安装 Node.js —— 仓库自带 `runtime/node.exe`

### 启动

| 方式 | 操作 | 地址 |
| --- | --- | --- |
| 本机（推荐） | 双击 `start.bat` | http://127.0.0.1:3210 |
| 局域网 | 双击 `Start-LAN.bat` | http://<你的IP>:3210 |
| 手动 | `node server\index.js` | http://127.0.0.1:3210 |

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `3210` | 监听端口 |
| `HOST` | `127.0.0.1` | `Start-LAN.bat` 会设为 `0.0.0.0` |
| `DISABLE_MOBILE_FRONTEND` | 未设置 | 设为 `1` 关闭移动端自动跳转 |
| `CRYPTO_PASSWORD` | 未设置 | API Key 加密口令，**建议设置** |
| `CRYPTO_SALT` | 未设置 | 加密盐，**建议设置** |

### 安装依赖（克隆后必做）

`node_modules/` 不随仓库分发，克隆后先安装：

```bat
npm install
```

> `better-sqlite3` 是原生模块，需与本机 Node 版本匹配，Windows 建议直接用自带的
> `runtime\node.exe`（v22）；其他平台安装 Node 22 后亦可正常 `npm install`（官方预编译二进制）。

---

## 三、首次配置

### 1. API 供应商（必填）

进入 **设置 → API 供应商**，添加你自己的模型服务：填写名称、`Base URL`、`API Key`、模型名，
类型一般选 `openai` 兼容；保存后在对应功能里选中它作为「主 AI / 管家 AI / TTS」。

> 本版本**预置供应商为空**，需要自行添加。
> 你的 Key 会以 AES-256-GCM 加密存入本地数据库，不会上传任何远端。

**加密说明**：加密口令来自 `CRYPTO_PASSWORD` / `CRYPTO_SALT` 环境变量；未设置时会在
`server/db/.crypto_secret` 生成一个本机随机密钥（该数据库连同 `.crypto_secret` 一起拷走仍可解密，
只拷 `data.db` 则不能）。长期使用建议显式设置环境变量。

### 2. 生图（可选）

需要本地或远程 **ComfyUI**：

1. 在「设置 → 生图」填写 ComfyUI 地址（如 `http://127.0.0.1:8188`）
2. **提供工作流 JSON**：根目录的 `GALCG.json`（CG）与 `portrait_x.json`（立绘）默认是**空占位文件**，
   需要把自己 ComfyUI 里导出的工作流（API 格式 JSON）写入这两个文件，
   或在设置里填写自己工作流文件的名字（放在项目根目录）
3. 工作流引用的模型需在你的 ComfyUI `models/` 目录中已存在；提示词节点会自动探测，无需手动填节点 ID

### 3. TTS 语音（可选）

在「设置 → TTS」添加供应商：支持火山引擎、阿里百炼、SiliconFlow、Volink 等云端 API 格式
（使用云端服务需自备对应平台的 Key），以及 ComfyUI Qwen3-TTS 本地推理（工作流文件 `qwen3-tts-01.json`，
需在 ComfyUI 中安装 FL_Qwen3TTS 相关节点）。

### 4. BGM 背景音乐（可选）

仓库**不随附任何 mp3**（版权原因），只保留情绪目录结构。把你自己的音乐放入对应子目录即可启用氛围联动：

| 目录 | 情绪 |
| --- | --- |
| `BGM/battle/` | 战斗 |
| `BGM/blue/` | 忧郁 |
| `BGM/ceremony/` | 仪式 |
| `BGM/nomal/` | 日常 |
| `BGM/relaxed/` | 放松 |
| `BGM/suspense/` | 悬念 |

---

## 四、目录结构

```
AI-GAL/
├─ start.bat / Start-LAN.bat      启动脚本
├─ package.json / package-lock.json
├─ README.md                      本文件
├─ WORLDBOOK_ACTIVATION_GUIDE.md 世界书激活机制说明（用户文档）
├─ GALCG.json                     默认 CG 工作流（空占位，需自行填入）
├─ portrait_x.json                默认立绘工作流（空占位，需自行填入）
├─ qwen3-tts-01.json              ComfyUI Qwen3-TTS 工作流（可选功能）
├─ runtime/node.exe               自带 Node 运行时
├─ server/                        后端
│  ├─ index.js                    入口 / 路由挂载
│  ├─ crypto.js                   API Key 加解密
│  ├─ savePaths.js                master/sub 存档目录架构
│  ├─ db/init.js                  数据库建表与迁移
│  ├─ routes/                     各功能路由（chat / images / tts / saves …）
│  ├─ utils/                      工具（jsonpatch / nameMatch / pathGuard …）
│  └─ data/anime-character-names.json   动漫角色英文名对照表
├─ public/                        前端
│  ├─ index.html                  桌面 VN 界面
│  ├─ mobile.html                 移动端界面
│  └─ new/                        桌面界面（重设计版）
├─ BGM/                           背景音乐（目录结构随仓库，mp3 需自行放入）
├─ tools/                         构建 / 调试脚本
└─ data/                          运行时数据（TTS 队列等）
```

运行后生成（已加入 `.gitignore`，**请勿分享**）：

| 路径 | 内容 |
| --- | --- |
| `server/db/data.db` | 数据库（供应商 Key、角色卡、会话记录） |
| `server/db/.crypto_secret` | 本机加密密钥，**泄露等于泄露 Key** |
| `saves/` | 存档与存档内图片 |
| `data/generated_images/` | 生成的图片 |
| `data/tts-cache/` | TTS 音频缓存 |
| `public/uploads/` | 上传的头像 / 角色图 |
| `profile/` | 角色 / NPC 立绘 |

---

## 五、隐私与分享须知

分享本目录前，请务必清理以下内容（或确认其为空）：

- `server/db/data.db` 与 `server/db/.crypto_secret` —— 含 API Key 与聊天记录
- `saves/`、`data/generated_images/`、`data/tts-cache/`、`public/uploads/`、`profile/`
- 任何 `*.log` / `*.out` 文件（可能含本机绝对路径）

一键检查（PowerShell）：

```powershell
Get-ChildItem -Recurse -File -Force |
  Where-Object { $_.FullName -notmatch '\\node_modules\\' } |
  Select-String -Pattern 'sk-[A-Za-z0-9_\-]{16,}|api_key|D:\\' -List |
  Select-Object Path
```

---

## 六、声明

- 本项目以 **MIT** 许可证开源，见 [LICENSE](LICENSE)。
- 本项目具备成人向内容能力（可配置 NSFW 生图标签等），**仅供成年人**在本地使用。
- 请遵守你所在地区的法律法规，以及你所调用的各模型服务商的条款；
  使用者需自行对其生成与存储的内容负责。