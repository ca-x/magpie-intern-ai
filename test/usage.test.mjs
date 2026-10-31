// auth.usage（用量概览看板）自测：模拟宿主调用 usage 钩子。台账写在
// 每个用例自己的沙箱 HOME 里（os.homedir 在 POSIX 上按次读 $HOME），
// /v1/models 用假 fetch 应答，全程不碰网络、不碰真实配置。
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const mod = await import("../index.mjs")
const hooks = await Object.values(mod).find((v) => typeof v === "function")({ client: null }, undefined)
const usage = hooks.auth.usage

const realFetch = globalThis.fetch
const okModels = async () => new Response(JSON.stringify({ data: [{ id: "glm-5.3" }] }), { status: 200 })

// 每个用例一个沙箱：台账只可能是自己写的这份
function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "duanyan-usage-"))
  process.env.HOME = home
  delete process.env.XDG_CONFIG_HOME
  return home
}
function ledger(home, lines) {
  const dir = join(home, ".config", "magpie")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "usage.jsonl"), lines.join("\n") + (lines.length ? "\n" : ""))
}
const row = (over = {}) => ({
  t: new Date().toISOString(),
  provider: "duanyan",
  providerAccount: "公司号",
  model: "glm-5.3",
  status: 200,
  in: 0,
  out: 0,
  cache_read: 0,
  ...over,
})
const counted = (r) => (r.in ?? 0) + (r.cache_read ?? 0) + (r.out ?? 0)

test("按账号统计今日/本月，窗口形状正确，别人的不算", async () => {
  const home = sandbox()
  const now = new Date()
  const ms = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
  const ds = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  // 台账按时间追加：行序必须从旧到新（补报行例外，它写在文件末尾、
  // 时间是客户端调用发生的时刻，可以很旧）
  const lastMonth = row({ t: new Date(ms - 86_400_000).toISOString(), in: 999, out: 999 })
  const early = row({ t: new Date(ms + 60_000).toISOString(), model: "claude-sonnet-4-5", in: 800, out: 400 })
  const otherAccount = row({ providerAccount: "个人号", in: 500, out: 500 })
  const otherProvider = row({ provider: "zcode", in: 500, out: 500 })
  const failed = row({ status: 500, in: 700, out: 700 })
  const renamed = row({ provider: "duanyan-plugin", in: 300, out: 200 })
  const justNow = row({ in: 1000, cache_read: 200, out: 500 })
  const reported = row({ t: new Date(ms - 10 * 86_400_000).toISOString(), source: "reported", providerAccount: undefined, in: 100, out: 100 })
  const rows = [lastMonth, early, otherAccount, otherProvider, failed, renamed, justNow, reported]
  ledger(home, rows.map((r) => JSON.stringify(r)))

  globalThis.fetch = okModels
  try {
    const out = await usage(async () => ({ type: "api", key: "sk-live-testkey0001", metadata: { email: "公司号" } }))
    assert.equal(out.signIn, "kept")
    assert.equal(out.plan, "API key")
    assert.equal(out.user, "公司号")

    const inMonth = [early, renamed, justNow]
    const inToday = inMonth.filter((r) => Date.parse(r.t) >= ds)
    const [today, month, ...tops] = out.windows
    assert.equal(today.name, "今日 tokens")
    assert.equal(today.amount, inToday.reduce((s, r) => s + counted(r), 0))
    assert.equal(today.unit, "tokens")
    assert.equal(today.span, 86400)
    assert.equal(today.aside, true)
    assert.equal(today.resetsAt, new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString())
    assert.equal(month.name, "本月 tokens")
    assert.equal(month.amount, inMonth.reduce((s, r) => s + counted(r), 0))
    assert.equal(
      month.resetsAt,
      new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString(),
    )
    assert.equal(month.span, Math.round((new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime() - ms) / 1000))
    // 缓存读单列（justNow 有 cache_read: 200），不和输入混在一起
    assert.match(month.display, /缓存 200/)

    // 本月用量最大的模型排前面，只列有量的
    const byModel = new Map()
    for (const r of inMonth) byModel.set(r.model, (byModel.get(r.model) ?? 0) + counted(r))
    const want = [...byModel.entries()].sort((a, b) => b[1] - a[1])
    assert.equal(tops.length, want.length)
    for (let i = 0; i < want.length; i++) {
      assert.equal(tops[i].name, want[i][0])
      assert.equal(tops[i].display, tokensShort(want[i][1]))
      assert.equal(tops[i].aside, true)
    }
  } finally {
    globalThis.fetch = realFetch
  }
})

test("没填备注名时按 key 尾缀（或空账号名）对账号", async () => {
  const home = sandbox()
  ledger(home, [
    JSON.stringify(row({ providerAccount: "", in: 500, out: 0 })), // 唯一 key 账号的行
    JSON.stringify(row({ providerAccount: "…kFs2", in: 300, out: 0 })), // 宿主用尾缀命名的标签
    JSON.stringify(row({ providerAccount: "…kFs3", in: 100, out: 0 })), // 另一个账号
    JSON.stringify(row({ providerAccount: "公司号", in: 700, out: 0 })), // 别人的备注名
  ])
  globalThis.fetch = okModels
  try {
    const out = await usage(async () => ({ type: "api", key: "sk-duanyan-1234567890kFs2" }))
    assert.equal(out.windows[1].amount, 800) // 500 + 300
  } finally {
    globalThis.fetch = realFetch
  }
})

test("key 失效（401）→ 标记账号重新登录", async () => {
  sandbox()
  globalThis.fetch = async () => new Response("{}", { status: 401 })
  try {
    const out = await usage(async () => ({ type: "api", key: "bad" }))
    assert.equal(out.signIn, "expired")
    assert.match(out.error, /已失效/)
    assert.equal(out.windows, undefined)
  } finally {
    globalThis.fetch = realFetch
  }
})

test("网络失败不影响台账用量展示", async () => {
  const home = sandbox()
  ledger(home, [JSON.stringify(row({ in: 100, out: 50 }))])
  globalThis.fetch = async () => {
    throw new Error("offline")
  }
  try {
    const out = await usage(async () => ({ type: "api", key: "sk-live-testkey0001", metadata: { email: "公司号" } }))
    assert.equal(out.signIn, "kept")
    assert.equal(out.windows[1].amount, 150)
  } finally {
    globalThis.fetch = realFetch
  }
})

test("没有台账：显示暂无记录而不是报错", async () => {
  sandbox()
  globalThis.fetch = okModels
  try {
    const out = await usage(async () => ({ type: "api", key: "sk-live-testkey0001", metadata: { email: "公司号" } }))
    assert.equal(out.signIn, "kept")
    assert.equal(out.windows.length, 2) // 今日/本月都在，只是没有量
    assert.equal(out.windows[0].amount, 0)
    assert.equal(out.windows[0].display, "暂无记录")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("成功但 0 token 的请求（如 provider test）显示 0，不是暂无记录", async () => {
  const home = sandbox()
  ledger(home, [JSON.stringify(row({ in: 0, out: 0, cache_read: 0 }))])
  globalThis.fetch = okModels
  try {
    const out = await usage(async () => ({ type: "api", key: "sk-live-testkey0001", metadata: { email: "公司号" } }))
    assert.equal(out.windows[0].amount, 0)
    assert.equal(out.windows[0].display, "0（输入 0 / 输出 0）")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("文件尾的残缺行（正在写入）被跳过，不丢前面的量", async () => {
  const home = sandbox()
  const dir = join(home, ".config", "magpie")
  mkdirSync(dir, { recursive: true })
  const whole = JSON.stringify(row({ in: 900, out: 100 }))
  // 结尾不换行、JSON 截半：是宿主正在写的一行
  writeFileSync(join(dir, "usage.jsonl"), `${whole}\n${whole.slice(0, 30)}`)
  globalThis.fetch = okModels
  try {
    const out = await usage(async () => ({ type: "api", key: "sk-live-testkey0001", metadata: { email: "公司号" } }))
    assert.equal(out.windows[1].amount, 1000)
  } finally {
    globalThis.fetch = realFetch
  }
})

test("未登录：报错但不动账号状态", async () => {
  sandbox()
  assert.deepEqual(await usage(async () => null), { error: "未登录", signIn: "kept" })
})

// 网页 token（uaa-token）模式：控制台 /api/tokenplan/v1/* 返回真数据。
// fetch 按 URL 路由，并记录每次请求的 URL 和 authorization 头
function routeFetch(routes, calls = []) {
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    calls.push({ url, auth: new Headers(init?.headers).get("authorization") })
    for (const [frag, handler] of Object.entries(routes)) {
      if (url.includes(frag)) return handler()
    }
    return new Response("{}", { status: 404 })
  }
  return calls
}
const consoleOk = (data) => () =>
  new Response(JSON.stringify({ code: 0, msg: "success", data }), { status: 200 })
const BALANCE = {
  access_status: 1,
  rpm_limit: 50,
  tpm_limit: 2000000,
  available_credits: "202.898",
  active_package_count: 1,
  usage_windows: {
    "5h": { enabled: true, limit_credits: "10000.000", used_credits: "0.024", remaining_credits: "9999.976", next_recover_at: "2026-10-31 13:41:29" },
    "7d": { enabled: true, limit_credits: "50000.000", used_credits: "9797.102", remaining_credits: "40202.898", next_recover_at: "2026-11-06 17:41:29" },
  },
  calculated_at: "2026-10-31 12:49:18",
}
// packages 应答结构 2026-10-31 实测（/tmp/duanyan-packages.json）：月度包
// 清零在 current_cycle.end_at，expire_at 是 2099 哨兵
const PACKAGES = {
  page: 1,
  page_size: 20,
  total: 1,
  packages: [
    {
      pkg_id: "pkg_free_monthly_base",
      cycle_type: "monthly",
      current_cycle: { start_at: "2026-10-30 17:41:29", end_at: "2026-12-01 00:00:00" },
      total_credits: "10000.000",
      remaining_credits: "202.898",
      status: "available",
      expire_at: "2099-12-31 23:59:59",
      income_expense_type: "platform_grant",
      remark: "每月免费基础包",
    },
  ],
}

test("有网页 token：平台真数据（墨点余额 + 5h/7d 窗口 + 本月用量）", async () => {
  const home = sandbox()
  const calls = routeFetch({
    "/v1/models": okModels,
    "/credits/balance": consoleOk(BALANCE),
    "/usage/summary": consoleOk({
      summary: { total_tokens: 24007001, request_count: 38, consumed_credits: "9797.102" },
      daily_usage: [],
    }),
    "/credits/packages": consoleOk(PACKAGES),
  })
  try {
    const out = await usage(async () => ({
      type: "api",
      key: "sk-live-testkey0001",
      metadata: { email: "公司号", webToken: "eyJ0eXBld2VidG9rZW5zYW1wbGU" },
    }))
    assert.equal(out.signIn, "kept")
    assert.equal(out.windows.length, 4)

    // 控制台请求必须带网页 token 而非 API key，且只发往控制台域
    const consoleCalls = calls.filter((c) => c.url.includes("/api/tokenplan/"))
    assert.equal(consoleCalls.length, 3)
    for (const c of consoleCalls) {
      assert.ok(c.url.startsWith("https://discovery.intern-ai.org.cn/"), c.url)
      assert.equal(c.auth, "Bearer eyJ0eXBld2VidG9rZW5zYW1wbGU")
    }

    const [balance, fiveHour, sevenDay, monthUse] = out.windows
    assert.deepEqual(
      { name: balance.name, balance: balance.balance, unit: balance.unit, display: balance.display },
      { name: "墨点余额", balance: 202.898, unit: "墨点", display: "202.898 墨点" },
    )
    // 墨点包清零时点：月度包取 current_cycle.end_at（北京时间→UTC ISO），
    // runsOut 是该次损失的墨点数——智能路由在重置打平时优先花快过期的
    assert.equal(balance.runsOutAt, new Date("2026-12-01T00:00:00+08:00").toISOString())
    assert.equal(balance.runsOut, 202.898)
    assert.equal(balance.used, undefined, "余额窗是 balance 形，没有 used 百分比")
    assert.equal(fiveHour.name, "5 小时窗口")
    assert.equal(fiveHour.span, 18000)
    assert.ok(Math.abs(fiveHour.used - (100 * 0.024) / 10000) < 1e-9)
    // 平台给的是北京时间，resetsAt 应转成 UTC ISO
    assert.equal(fiveHour.resetsAt, new Date("2026-10-31T13:41:29+08:00").toISOString())
    assert.equal(sevenDay.name, "7 天窗口")
    assert.equal(sevenDay.span, 604800)
    assert.ok(Math.abs(sevenDay.used - (100 * 9797.102) / 50000) < 1e-9)
    assert.equal(monthUse.name, "本月用量")
    assert.equal(monthUse.aside, true)
    assert.equal(monthUse.display, "24.0M tokens · 38 次 · 9,797.102 墨点")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("网页 token 过期（A0211）：落回台账统计并在卡片提示，不标记账号", async () => {
  const home = sandbox()
  ledger(home, [JSON.stringify(row({ in: 100, out: 50, providerAccount: undefined }))])
  const expired = () =>
    new Response(JSON.stringify({ success: false, msgCode: "A0211", msg: "user token expired" }), { status: 200 })
  routeFetch({
    "/v1/models": okModels,
    "/credits/balance": expired,
    "/usage/summary": expired,
    "/credits/packages": expired,
  })
  try {
    const out = await usage(async () => ({
      type: "api",
      key: "sk-live-testkey0001",
      metadata: { webToken: "expired-token" },
    }))
    assert.equal(out.signIn, "kept", "token 过期不影响聊天，不标记账号")
    assert.match(out.error, /过期/)
    assert.equal(out.windows[1].amount, 150, "应落回本机台账统计")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("没填网页 token：维持本机台账行为", async () => {
  const home = sandbox()
  ledger(home, [JSON.stringify(row({ in: 10, out: 5, providerAccount: undefined }))])
  const calls = routeFetch({ "/v1/models": okModels })
  try {
    const out = await usage(async () => ({ type: "api", key: "sk-live-testkey0001" }))
    assert.equal(out.signIn, "kept")
    assert.equal(out.error, undefined)
    assert.equal(out.windows[1].amount, 15)
    assert.equal(calls.filter((c) => c.url.includes("/api/tokenplan/")).length, 0, "无 token 时不该碰控制台接口")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("一次性包更早到期：runsOutAt 取较早者，2099 哨兵被周期压过", async () => {
  sandbox()
  routeFetch({
    "/v1/models": okModels,
    "/credits/balance": consoleOk({ available_credits: "299.898", usage_windows: {} }),
    "/usage/summary": consoleOk({ summary: { total_tokens: 0, request_count: 0, consumed_credits: "0" } }),
    "/credits/packages": consoleOk({
      total: 2,
      packages: [
        {
          cycle_type: "monthly",
          current_cycle: { end_at: "2026-12-01 00:00:00" },
          remaining_credits: "202.898",
          expire_at: "2099-12-31 23:59:59",
        },
        { cycle_type: "once", remaining_credits: "97.000", expire_at: "2026-11-05 23:59:59" },
      ],
    }),
  })
  try {
    const out = await usage(async () => ({
      type: "api",
      key: "sk-live-testkey0001",
      metadata: { webToken: "eyJ0eXBld2VidG9rZW5zYW1wbGU" },
    }))
    const balance = out.windows[0]
    assert.equal(balance.runsOutAt, new Date("2026-11-05T23:59:59+08:00").toISOString())
    assert.equal(balance.runsOut, 97, "runsOut 是该时点损失的墨点数（只算那时到期的包）")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("套餐接口失败：余额窗口没有 runsOutAt，卡片其余照常", async () => {
  sandbox()
  routeFetch({
    "/v1/models": okModels,
    "/credits/balance": consoleOk({ available_credits: "50.000", usage_windows: {} }),
    "/usage/summary": consoleOk({ summary: { total_tokens: 0, request_count: 0, consumed_credits: "0" } }),
    "/credits/packages": () => new Response("{}", { status: 500 }),
  })
  try {
    const out = await usage(async () => ({
      type: "api",
      key: "sk-live-testkey0001",
      metadata: { webToken: "eyJ0eXBld2VidG9rZW5zYW1wbGU" },
    }))
    assert.equal(out.signIn, "kept")
    assert.equal(out.windows[0].balance, 50)
    assert.equal(out.windows[0].runsOutAt, undefined)
    assert.equal(out.error, undefined)
  } finally {
    globalThis.fetch = realFetch
  }
})

// 与实现同口径的展示缩写，只用在断言里
function tokensShort(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`
  return String(Math.round(n))
}
