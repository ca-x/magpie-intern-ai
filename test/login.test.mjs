// 浏览器弹窗登录自测：不真绑 8081（端口注入到临时端口）、不真开浏览器、
// 不真联网——SSO/平台侧用假 fetch 应答，本地桥接服务用注入端口真实起
// 监听（同社区 autoclaw 的本地 OAuth 测法：自己的服务是真的，上游是假的）。
import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"

const mod = await import("../index.mjs")
const hooks = await Object.values(mod).find((v) => typeof v === "function")({ client: null }, undefined)
const { ssoPopupUrl, startBrowserLogin, beginBrowserSignIn } = mod._internal

// 每个用例拿一个空闲端口（生产固定 8081：SSO 弹窗 opener 白名单硬编码，
// 测试不能依赖它空闲）
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port
      probe.close(() => resolve(port))
    })
  })
}

// fetch 按 URL 路由：users/auth 走假应答并记录请求，其余（本地桥接服务）
// 透传给真 fetch——和 usage.test.mjs 的 routeFetch 同思路
function routeFetch(routes, calls = []) {
  const realFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    for (const [frag, handler] of Object.entries(routes)) {
      if (url.includes(frag)) {
        calls.push({ url, body: init?.body == null ? null : JSON.parse(String(init.body)) })
        return handler()
      }
    }
    return realFetch(input, init)
  }
  return { calls, restore: () => (globalThis.fetch = realFetch), real: realFetch }
}

const tokenOk = () =>
  new Response(JSON.stringify({ code: 0, msg: "success", data: { token: "ey-test-uaatoken" } }), { status: 200 })

// 模拟桥接页回传 code：POST 本地 /code（Origin 头模拟浏览器同源）
const postCode = (port, code, origin) =>
  fetch(`http://127.0.0.1:${port}/code`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
    body: JSON.stringify({ code }),
  })

test("登录方式：api 与浏览器 oauth 并存，prompts 是 API key + 备注名", () => {
  const [api, browser] = hooks.auth.methods
  assert.equal(api.type, "api", "手动粘贴方式保留在首位")
  assert.equal(browser.type, "oauth")
  assert.match(browser.label, /浏览器/)
  assert.deepEqual(
    browser.prompts.map((p) => p.key),
    ["key", "email"],
    "prompts 收 API key（必填）+ 备注名（可选）",
  )
})

test("缺 API key：authorize 直接报错，不起服务", async () => {
  await assert.rejects(() => beginBrowserSignIn({ email: "公司号" }), /API key/)
  await assert.rejects(() => beginBrowserSignIn({ key: "   " }), /API key/)
})

test("成功路径：桥页弹窗参数正确，code → token，prompts 值进结果，服务收尾", async () => {
  const port = await freePort()
  const { calls, restore, real } = routeFetch({ "users/auth": tokenOk })
  try {
    const session = await beginBrowserSignIn({ key: "sk-live-key", email: "公司号" }, { port, deadlineMs: 10_000 })
    assert.equal(session.url, `http://localhost:${port}/login-bridge`)
    assert.equal(session.method, "auto")
    assert.match(session.instructions, /浏览器/)

    // 桥接页真实可访问，且内嵌的弹窗参数符合 SSO 端约定：
    // 默认弹 /login 手机号表单（SSO 回传逻辑只在 /wechat 路由，手机号流
    // 两段式）；/wechat 确认页带 openerOrigin 原文（SSO 端裸 split 解析，
    // 不能 URL 编码）、不带 redirect（带它会走无 postMessage 的重定向分支）
    const page = await (await real(session.url)).text()
    assert.match(page, /window\.open\(url, "login-plugin-wechat"/, "所有弹窗共用固定窗口名")
    assert.match(page, /openPopup\(PHONE_URL\)/)
    assert.match(page, /openPopup\(WECHAT_URL\)/)
    assert.match(page, /sso\.openxlab\.org\.cn\/login\?clientId=/, "默认弹手机号登录表单")
    assert.match(page, new RegExp(`openerOrigin=http://localhost:${port}\\b`))
    assert.match(page, /sso\.openxlab\.org\.cn\/wechat\?clientId=/)
    assert.match(page, /wechat-login-auth-success/)
    assert.match(page, /完成授权/, "手机号流第二步：完成授权按钮")
    assert.ok(!page.includes("redirect="), "弹窗地址不能带 redirect 参数")
    assert.match(page, /ev\.origin !== SSO_ORIGIN/, "桥页必须校验消息来源")
    assert.match(ssoPopupUrl(), /openerOrigin=http:\/\/localhost:8081$/, "生产弹窗地址固定 openerOrigin 8081")

    // 模拟弹窗流：SSO 登录成功后桥页把一次性 code 回传本地服务
    assert.deepEqual(await (await postCode(port, "good-code", `http://localhost:${port}`)).json(), { ok: true })
    // 重复回传幂等，且只有第一个 code 生效（用户在弹窗里重登也不换）
    assert.deepEqual(await (await postCode(port, "second-code", `http://localhost:${port}`)).json(), { ok: true })

    const out = await session.callback()
    assert.equal(out.type, "success")
    assert.equal(out.key, "sk-live-key", "API key 落结果顶层（宿主存成账号 key）")
    assert.deepEqual(out.metadata, { email: "公司号", webToken: "ey-test-uaatoken" }, "备注名与网页 token 进 metadata")

    // code 换 token 必须由本进程发往平台 users/auth
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, "https://discovery.intern-ai.org.cn/api/user-center/v1/users/auth")
    assert.deepEqual(calls[0].body, { code: "good-code" })

    // callback 返回后本地服务必须已关闭，端口释放
    await assert.rejects(() => real(session.url), "callback 结束后桥接服务应已关闭")
  } finally {
    restore()
  }
})

test("不填备注名：metadata 只有 webToken（账号名走 key 尾缀）", async () => {
  const port = await freePort()
  const { restore } = routeFetch({ "users/auth": tokenOk })
  try {
    const session = await startBrowserLogin({ key: "sk-live-key", port, deadlineMs: 10_000 })
    await postCode(port, "good-code")
    const out = await session.callback()
    assert.equal(out.type, "success")
    assert.deepEqual(out.metadata, { webToken: "ey-test-uaatoken" })
  } finally {
    restore()
  }
})

test("换 token 失败（平台拒绝）：callback 返回 failed，错误带平台提示、不带 token", async () => {
  const port = await freePort()
  const { restore } = routeFetch({
    "users/auth": () =>
      new Response(JSON.stringify({ code: -40132, msg: "SSO authentication failed" }), { status: 200 }),
  })
  try {
    const session = await startBrowserLogin({ key: "sk-live-key", port, deadlineMs: 10_000 })
    await postCode(port, "bad-code")
    const out = await session.callback()
    assert.equal(out.type, "failed")
    assert.match(out.error, /SSO authentication failed/)
    assert.ok(!out.error.includes("bad-code"), "错误信息不能包含 code 内容")
    await assert.rejects(() => fetch(`http://127.0.0.1:${port}/healthz`), "失败后服务也应关闭")
  } finally {
    restore()
  }
})

test("超时：callback 返回 failed，本地服务与定时器都清理", async () => {
  const port = await freePort()
  const session = await startBrowserLogin({ key: "sk-live-key", port, deadlineMs: 120 })
  const out = await session.callback()
  assert.equal(out.type, "failed")
  assert.match(out.error, /超时/)
  await assert.rejects(() => fetch(`http://127.0.0.1:${port}/healthz`))
})

test("宿主不调 callback（用户取消）：到点自动关服务，不挂端口", async () => {
  const port = await freePort()
  await startBrowserLogin({ key: "sk-live-key", port, deadlineMs: 120 })
  await new Promise((r) => setTimeout(r, 500))
  await assert.rejects(() => fetch(`http://127.0.0.1:${port}/healthz`))
})

test("端口被占用：authorize 报错并提示手动粘贴方式", async () => {
  const port = await freePort()
  const blocker = createServer()
  await new Promise((r) => blocker.listen(port, "127.0.0.1", r))
  try {
    await assert.rejects(() => beginBrowserSignIn({ key: "sk-live-key" }, { port }), /被占用|手动粘贴/)
  } finally {
    await new Promise((r) => blocker.close(r))
  }
})

test("非本机来源往 /code 塞 code：被拒绝且不进会话", async () => {
  const port = await freePort()
  const session = await startBrowserLogin({ key: "sk-live-key", port, deadlineMs: 400 })
  const evil = await postCode(port, "evil-code", "https://evil.example")
  assert.equal(evil.status, 403)
  const out = await session.callback()
  assert.equal(out.type, "failed", "伪造 code 没被接受，会话只能超时")
  assert.match(out.error, /超时/)
  await assert.rejects(() => fetch(`http://127.0.0.1:${port}/healthz`), "会话结束后服务已关闭")
})
