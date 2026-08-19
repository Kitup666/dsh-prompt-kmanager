# dsh-prompt-kmanager

DeepSeek Harness 的提示词管理器:在浏览器里以可视化方式管理三档提示词作用域——**全局**(`$DSH_HOME/AGENTS.md`)、**项目**(各项目根目录的 `AGENTS.md` 系列文件)、**模式**(`.agent-presets/<id>/agent.cordis.yml` 里的 persona 行)。它只写官方提示词插件的同名文件,不参与系统提示词装配,也不改动 harness 源码。

> **个人用插件,公开供大伙试用。** 功能与交互尽量贴近日常使用习惯,但未经大规模环境验证。使用前请阅读文末免责声明。

## 功能

- **全 / 项 / 模 三个页签**:
  - **全局**:编辑 `$DSH_HOME/AGENTS.md`(用户级提示词)。
  - **项目**:管理各项目根目录的 `AGENTS.md` 系列文件(项目级提示词)。
  - **模式**:编辑 `.agent-presets/<id>` 下 persona 的 `text` / `complete` / `includeRuntimeContext`,即每个 agent 预设的系统提示词。
- **模式列表**:复用 harness 自带的 `dsh-agent-presets` 服务读取预设,名称/描述用系统同款 js-yaml 解析;第三方预设(如 dsh-router-standard)的坏 `preset.yml` 会在读取时被规范化治愈。
- **Skills 管理**:解析 / 渲染 / 列出仓库级与全局级 skills,设置调用方式。
- **指令预算**:读出每个模式的 `maxBytes` 指令预算。
- **全文备份**:备份页签把所有作用域的内容导出为一个文件。
- **dry-run 预览**:每个写入都先预览逐行改动(行号、原文/新文),确认后才落盘。
- **文件级协作**:直接读写官方 prompt 插件(`dsh-persona` / `dsh-agent-instructions`)消费的文件,重启进程后新会话即生效。

## 安装方式

### 前置要求

- 一个可用的 DeepSeek Harness 环境(Web 或 CLI)。
- Node.js、git、pnpm(按构建需要)。

### 一、作为源码开发的插件

```bash
# 1. 克隆本仓库到 harness 源码同级的 mypackages 目录
#    例如 harness 在 D:/deepseek-harness,则放到 D:/mypackages/dsh-prompt-kmanager
git clone https://github.com/Kitup666/dsh-prompt-kmanager.git

# 2. 构建(Windows)
cd dsh-prompt-kmanager
powershell -File scripts/build.ps1

# 3. 在 harness home 的 cordis.patch.yml 中加入插件行
#    - id: dsh-prompt-kmanager
#      name: '@deepseek-ai/dsh-prompt-kmanager'
```

### 二、通过插件管理器安装

若已安装 [dsh-plugin-kmanager](https://github.com/Kitup666/dsh-plugin-kmanager),可在「自制」页签用本仓库地址添加,构建后访问 `/prompts` 即可。

## 构建

```bash
# Windows
powershell -File scripts/build.ps1

# macOS / Linux
bash scripts/build.sh
```

构建产物在 `lib/`(已 gitignore),由 `tsc`(types) + `tsdown`(bundle)生成。

## 测试

```bash
node tests/smoke.mjs
```

## 免责声明

本插件为个人开发,未经大规模环境验证。使用过程中如遇问题,欢迎提 issue,但请自行评估风险。