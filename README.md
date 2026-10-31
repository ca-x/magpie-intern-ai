# magpie-intern-ai

书生端砚（[InternAI Discovery](https://discovery.intern-ai.org.cn)）的 [Magpie](https://usemagpie.ai) / [OpenCode](https://opencode.ai) 供应商插件。用你自己的书生端砚 API key，把它的模型接入 Magpie / OpenCode。

- **单一供应商、一次登录**：只显示一个"书生端砚"，模型列表里自动处理协议分流
- **协议自动分流**：普通模型走 OpenAI 兼容协议；id 含 `claude` 的模型自动分流到 Anthropic / SystemOne 原生协议（同域），保留 server-side cache 等 Anthropic 特性
- **浏览器弹窗登录（推荐）**：填好 API key 后默认走手机号验证码登录（也可一键改微信扫码），网页 token（uaa-token）自动取回，墨点余额看板免手动粘贴
- **多账号**：每个账号独立登录、独立配置，互不干扰
- **模型列表动态获取**：登录后从 `/v1/models` 拉取账号实际可用的模型，不写死任何静态列表
- **用量概览看板（Magpie）**：设置 → 用量 → 概览里每个账号一张卡，显示今日 / 本月 token 用量与本月用量最大的模型
- **零运行时依赖**

## 供应商

| id | 默认协议 | 默认 Base URL | AI SDK |
| --- | --- | --- | --- |
| `duanyan` | OpenAI 兼容（chat completions） | `https://discovery-api.intern-ai.org.cn/v1` | `@ai-sdk/openai-compatible` |

claude 系模型在动态列表里自动挂 `@ai-sdk/anthropic` + `https://discovery-api.intern-ai.org.cn`（模型级 `api` 覆盖，社区 Zed 插件同款机制），对宿主仍只显示一个供应商。

> 注：如果供应商 id 在你的 Magpie 版本里与内置订阅冲突，宿主会自动改名为 `duanyan-plugin`，属于正常行为。

## 获取 API key

1. 打开 [discovery.intern-ai.org.cn](https://discovery.intern-ai.org.cn)，注册 / 登录你的账号。
2. 在控制台（API 管理）里生成 API key。
3. 复制 key，登录时粘贴。

## 登录方式

供应商提供两种登录方式，可并存多个账号、各自选择：

### 方式一：书生端砚账号（浏览器）—— 推荐

登录时填 API key（必填）和备注名（可选），之后基本全自动，**默认手机号验证码登录**：

1. Magpie 打开插件在本机 `127.0.0.1:8081` 起的一次性桥接页，页面自动弹出书生端砚 SSO 的手机号登录表单（验证码 / 密码均可；被浏览器拦截就点「重新打开登录窗口」）；
2. 登录成功后回到桥接页点 **「第二步：我已登录，完成授权」**——弹窗切换到确认页，再点一次确认即自动回传；
3. 插件在本地把一次性 code 换成网页 token（`uaa-token`）存进账号——**墨点余额看板自动可用，不用再从 Cookie 里手动复制**。

偏好微信？桥接页上有 **「改用微信扫码登录」** 按钮：一步直达，扫码确认后自动回传（手机号流之所以多一步确认，是 SSO 的回传逻辑只在微信授权页上，手机号登录页没有）。

限制与说明：

- 端口 **8081 必须空闲**：SSO 弹窗的 opener 白名单硬编码了 `http://localhost:8081`，换端口收不到回传；被占用时登录会明确报错，请改用方式二；
- 全程 5 分钟超时；取消登录后端口最多 5 分钟才释放，期间重试会提示端口被占用；
- 对话请求仍使用 API key——浏览器登录只是自动完成「网页 token」这一步（API key 打不开控制台接口，网页 token 才打得到墨点余额）。

### 方式二：书生端砚 API key（手动）

粘贴 API key，需要墨点余额看板时再手动粘贴网页 token（见下文「获取网页 token」）。8081 被占用、弹窗流失败或不方便开浏览器时用这个。

## 安装

### Magpie

```bash
# 从 GitHub 直接安装
magpie plugin add github:ca-x/magpie-intern-ai

# 或从 npm
magpie plugin add magpie-intern-ai
```

安装后登录（一次即可）：

```bash
magpie plugin login duanyan
```

验证：

```bash
magpie plugin --json        # 无加载错误
magpie provider test duanyan
```

### OpenCode

```bash
opencode plugin add ca-x/magpie-intern-ai
```

OpenCode 会忽略 Magpie 专属行为，登录方式与供应商配置照常可用。

### 应用内安装

Magpie → 设置 → 插件 → 发现/安装，粘贴本仓库地址或 npm 包名 `magpie-intern-ai`，然后在供应商页面添加账号。

## 多账号

在供应商设置里多次添加账号即可（或多次执行 `magpie plugin login duanyan`）。策略说明：

- **隔离**：每个账号存自己的 API key，模型列表按账号各自拉取（谁的 key 拉谁的可用模型），账号间状态完全隔离；宿主负责账号调度（`id#xxxxxx` 存储、按账号排队/切换）。
- **命名**：登录时可填"账号备注名"（存 `metadata.email`，宿主用它显示账号名）；不填则用 key 尾几位区分。同备注名再次登录会替换原账号。
- **并发**：默认每账号同时 4 个请求（`maxConcurrency`），防止触发平台限流；可在供应商设置里调整。

## 用量概览看板（Magpie）

Magpie 的 设置 → 用量 → 概览 会为每个已登录账号显示一张卡（`auth.usage` 钩子，OpenCode 不使用）。看板有两种模式，取决于账号是否带有"网页 token"：

**模式一：网页 token（推荐，平台真数据）**

控制台的墨点余额/用量接口只认网页会话（API key 打不开它们），所以账号需要带一个"网页 token"（即控制台 Cookie 里的 `uaa-token` 值）。两种来源任选其一：

- **用「书生端砚账号（浏览器）」方式登录**——token 由 SSO 弹窗流自动取回（推荐，见「登录方式」）；
- **手动粘贴**（用「书生端砚 API key」方式登录时）：

1. 用浏览器登录 [discovery.intern-ai.org.cn](https://discovery.intern-ai.org.cn)
2. F12 → Application → Cookies → `discovery.intern-ai.org.cn` → 复制 `uaa-token` 的值（或在控制台 Console 执行 `document.cookie.match(/uaa-token=([^;]+)/)[1]`）
3. 登录插件账号（或同备注名重新登录替换）时粘贴进"网页 token"输入框

有 token 时看板显示：**墨点余额**（路由按余量优先使用，并带最近一次清零时点与该次损失的墨点数——智能路由在多账号重置时间打平时会优先花快到期的墨点，不浪费）、**5 小时 / 7 天用量窗口**（平台侧限流，含恢复时间）、**本月用量**（token / 请求数 / 消耗墨点，平台侧全设备口径）。token 会过期（网页登录态），过期时卡片提示**用浏览器方式重新登录该账号**（或重新手动粘贴），聊天不受影响（API key 独立有效）。

**模式二：无 token（默认，本机台账统计）**

- **数据来源**：从 **Magpie 自己的 `usage.jsonl` 台账**（本机 `~/.config/magpie/usage.jsonl`）按账号统计——和 WorkBuddy 插件免费模型窗口的做法相同。只覆盖走本机 Magpie 的请求。
- **窗口**：今日 tokens、本月 tokens（自然日/自然月，本地时区，token 口径 = 输入 + 缓存读 + 输出，只计成功请求；缓存读在卡片上单列，不混进输入），以及本月用量最大的三个模型。
- **账号归属**：台账里每行带 `providerAccount` 标签——填了备注名的账号精确匹配备注名；没填的按 key 尾几位匹配。因此：**登录后改名会让旧记录不再计入**；两个都没填备注名、key 尾几位又恰好相同的账号会分不清（极少见）。

两种模式下，key 有效性都顺带用 `/v1/models` 探测一次，401/403 时卡片提示重新登录。墨点余额请以网页控制台为准。

## 模型列表说明

- 登录后插件调用 `GET https://discovery-api.intern-ai.org.cn/v1/models`（带该账号的 key）获取实际可用模型，**没有静态兜底列表**，模型完全以动态获取为准。
- 全部模型列在同一个供应商下：id 含 `claude` 的自动分流到 Anthropic 原生协议端点，其余走 OpenAI 兼容端点。
- 能力/价格平台清单不提供，插件给中性默认（支持 tool call、价格 0），宿主里可自行覆盖。
- 拉取失败（网络/平台问题）时保留宿主已有的模型配置；key 失效（401/403）时提示重新登录。

## 开发与测试

本地单元测试（不需要网络，模拟宿主调用各钩子）：

```bash
npm test   # node --test test/*.test.mjs，push 时 CI 也会跑
```

沙箱集成测试（绝不在日常使用的 magpie 上测）：

```bash
sb=$(mktemp -d)
m() { env HOME="$sb" XDG_CONFIG_HOME="$sb/.config" XDG_CACHE_HOME="$sb/.cache" magpie "$@"; }

m plugin add ./magpie-intern-ai    # 文件夹就地加载
m plugin --json                    # 检查加载错误
m plugin login duanyan             # 粘贴 API key
m provider test duanyan            # 每种 API 发一个小请求
```

## 隐私

插件只把你的对话请求转发到书生端砚官方 API（`discovery-api.intern-ai.org.cn`），网页 token 只发往 `discovery.intern-ai.org.cn` 的控制台接口，不记录、不上报任何内容。

浏览器弹窗登录时，插件会在本机 `127.0.0.1:8081`（仅回环地址）起一个一次性的桥接页服务：它只和你的浏览器、以及你主动登录的 SSO 弹窗（`sso.openxlab.org.cn`）交互，登录完成后即关闭；一次性 code 的换取由插件进程直发书生端砚官方接口。token 不写入日志。

## License

MIT
