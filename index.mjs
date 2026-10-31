/**
 * 书生端砚 (InternAI Discovery) —— Magpie / OpenCode provider 插件
 *
 * https://discovery.intern-ai.org.cn
 *
 * 单供应商 duanyan，一个 API key 登录：主走 OpenAI 兼容协议
 * （https://discovery-api.intern-ai.org.cn/v1）；动态清单里 id 含 claude 的
 * 模型自动分流到 Anthropic / SystemOne 原生协议端点
 * （https://discovery-api.intern-ai.org.cn，同域，模型级 provider 覆盖），
 * 对宿主只显示一个提供商。
 *
 * 模型列表：登录后从 /v1/models 动态拉取（账号相关），不做静态写死。
 *
 * 用量概览（auth.usage，Magpie 专属钩子，OpenCode 忽略）：登录时可选
 * 粘贴网页 token（控制台 Cookie 里的 uaa-token，API key 打不开控制台
 * 接口），有它就走平台接口显示墨点余额和 5h/7d 用量窗口；没有（或
 * token 过期）则从宿主自己的 usage.jsonl 台账按账号统计本机用量。
 * key 是否仍有效顺带用 /v1/models 探测一次。
 *
 * 浏览器弹窗登录（auth.methods 里的 oauth 方法）：免去手动粘贴网页
 * token——插件在本机 127.0.0.1:8081 起一个一次性桥接页，桥接页弹出
 * SSO 登录窗（window.name=login-plugin-wechat，SSO 生产包内置的插件
 * 流），用户登录后弹窗 postMessage 一次性 code 给桥接页，桥接页回传
 * 本地服务，由插件进程 POST users/auth {code} 换 uaa-token。8081 是
 * SSO 弹窗 opener 白名单硬编码端口（sso 前端 main chunk，2026-10-31
 * 逆向确认）；被占用或超时（5 分钟）则提示改用 API key 方式手动粘贴。
 *
 * 只有 DuanYanAuth 一个插件工厂被导出：宿主会把入口的
 * 每个导出函数都当作插件调用，辅助函数一律留在模块内部不导出。
 */

import { closeSync, openSync, readSync, statSync } from "node:fs"
import { createServer } from "node:http"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"

const OPENAI_BASE = "https://discovery-api.intern-ai.org.cn/v1"
const ANTHROPIC_BASE = "https://discovery-api.intern-ai.org.cn"
// 动态模型清单端点：标准 OpenAI 风格，返回 { data: [{ id, … }] }
const MODELS_URL = `${OPENAI_BASE}/models`

const ICON = "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzIiIGhlaWdodD0iMzIiIHZpZXdCb3g9IjAgMCAzMiAzMiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiByeD0iNS4xMTQzNSIgZmlsbD0id2hpdGUiLz4KPHBhdGggZD0iTTEyLjM1NTQgMTguMjg4OEMxMy4wNjYyIDE4LjI4ODggMTMuNjQyNCAxOC44NjUyIDEzLjY0MjQgMTkuNTc2VjIxLjI3QzEzLjY0MjQgMjEuOTgwOSAxMy4wNjYyIDIyLjU1NzIgMTIuMzU1NCAyMi41NTczQzExLjY0NDUgMjIuNTU3MyAxMS4wNjgxIDIxLjk4MDkgMTEuMDY4MSAyMS4yN1YxOS41NzZDMTEuMDY4MSAxOC44NjUxIDExLjY0NDUgMTguMjg4OCAxMi4zNTU0IDE4LjI4ODhaIiBmaWxsPSIjMTgzODg5Ii8+CjxwYXRoIGQ9Ik0yMC42MjkzIDE4LjI4ODhDMjEuMzQwMiAxOC4yODg4IDIxLjkxNjYgMTguODY1MiAyMS45MTY2IDE5LjU3NlYyMS4yN0MyMS45MTY2IDIxLjk4MDkgMjEuMzQwMiAyMi41NTcyIDIwLjYyOTMgMjIuNTU3M0MxOS45MTg0IDIyLjU1NzMgMTkuMzQyMSAyMS45ODA5IDE5LjM0MjEgMjEuMjdWMTkuNTc2QzE5LjM0MjEgMTguODY1MSAxOS45MTg0IDE4LjI4ODggMjAuNjI5MyAxOC4yODg4WiIgZmlsbD0iIzE4Mzg4OSIvPgo8cGF0aCBmaWxsLXJ1bGU9ImV2ZW5vZGQiIGNsaXAtcnVsZT0iZXZlbm9kZCIgZD0iTTExLjIwMSA3Ljc1MTgxQzExLjMxIDcuNzA4NzUgMTEuNDIwOSA3LjY2NzA2IDExLjUzMzggNy42MjY4MUMxMS42NTAzIDcuNTg1MjUgMTEuNzY5IDcuNTQ1MjIgMTEuODg5OCA3LjUwNjc2QzEyLjEzMTQgNy40Mjk4MiAxMi4zODE1IDcuMzU5MjUgMTIuNjQwMyA3LjI5NTNDMTIuNzY5NyA3LjI2MzMzIDEyLjkwMTMgNy4yMzMgMTMuMDM1MSA3LjIwNDQyQzEzLjEwMiA3LjE5MDEzIDEzLjE2OTQgNy4xNzY0MyAxMy4yMzc0IDcuMTYzMDFDMTMuNDQxNCA3LjEyMjc1IDEzLjY1MDQgNy4wODYzOSAxMy44NjQ1IDcuMDU0MTVDMTQuMDA3MyA3LjAzMjY2IDE0LjE1MjMgNy4wMTI4NSAxNC4yOTk3IDYuOTk1MDRDMTQuNzQxNyA2Ljk0MTYxIDE1LjIwNDUgNi45MDUxOCAxNS42ODkgNi44ODY3MUMxNS45MzEyIDYuODc3NDcgMTYuMTc4OCA2Ljg3MjY1IDE2LjQzMTkgNi44NzI2NEMxNi42MjQxIDYuODcyNjQgMTYuODEzIDYuODc1NjMgMTYuOTk4OSA2Ljg4MDk4QzE3LjEzOCA2Ljg4NDk4IDE3LjI3NTQgNi44OTAyIDE3LjQxMTEgNi44OTcxMkMxNy42MTggNi45MDc2OCAxNy44MjA4IDYuOTIxODcgMTguMDE5NyA2LjkzOTA1QzE4LjEyNjEgNi45NDgyNCAxOC4yMzE0IDYuOTU3OTYgMTguMzM1NiA2Ljk2OUMxOC40NTEzIDYuOTgxMjcgMTguNTY1NiA2Ljk5NTEyIDE4LjY3ODYgNy4wMDk2MkMxOC43MTIyIDcuMDEzOTQgMTguNzQ1NyA3LjAxNzg3IDE4Ljc3OTEgNy4wMjIzOEMxOC43OTYxIDcuMDI0NjggMTguODEyOSA3LjAyNzMzIDE4LjgyOTkgNy4wMjk2OEMxOC45NTg2IDcuMDQ3NTIgMTkuMDg1NSA3LjA2NjUgMTkuMjEwNiA3LjA4NzIzQzE5LjMxMzQgNy4xMDQyNiAxOS40MTQ5IDcuMTIyNzIgMTkuNTE1MyA3LjE0MTY1QzE5LjYxODYgNy4xNjExMyAxOS43MjA3IDcuMTgxMTQgMTkuODIxNSA3LjIwMjU5QzE5Ljg0MDIgNy4yMDY1OCAxOS44NTg5IDcuMjEwNzggMTkuODc3NSA3LjIxNDgzQzE5Ljk5MTcgNy4yMzk2NiAyMC4xMDQzIDcuMjY1NjUgMjAuMjE1MyA3LjI5Mjk2QzIwLjIzODMgNy4yOTg2MiAyMC4yNjEyIDcuMzA0NjQgMjAuMjg0IDcuMzEwNEMyMC4zMjU2IDcuMzIwOSAyMC4zNjcxIDcuMzMxMzQgMjAuNDA4MiA3LjM0MjE4QzIwLjQzOTYgNy4zNTA0MiAyMC40NzA3IDcuMzU4OTkgMjAuNTAxNyA3LjM2NzQ0QzIwLjUzMDYgNy4zNzUyOSAyMC41NTk1IDcuMzgyODQgMjAuNTg4MiA3LjM5MDg3QzIwLjYzMzYgNy40MDM2IDIwLjY3ODcgNy40MTY3OCAyMC43MjM2IDcuNDI5OTRDMjAuNzM5OSA3LjQzNDcgMjAuNzU2MSA3LjQzOTQ0IDIwLjc3MjMgNy40NDQyNkMyMC44MTg3IDcuNDU4MDggMjAuODY0OCA3LjQ3MjQzIDIwLjkxMDYgNy40ODY3MUMyMC45MjQ3IDcuNDkxMTIgMjAuOTM4OSA3LjQ5NTI4IDIwLjk1MyA3LjQ5OTczQzIxLjAwMTggNy41MTUxMSAyMS4wNTAxIDcuNTMwOTcgMjEuMDk4MSA3LjU0Njg2QzIxLjEwOTMgNy41NTA1NyAyMS4xMjA1IDcuNTU0MDcgMjEuMTMxNyA3LjU1NzhDMjEuMTY5NSA3LjU3MDQ1IDIxLjIwNzEgNy41ODMzOCAyMS4yNDQ0IDcuNTk2MzRDMjEuMjY3OSA3LjYwNDQ4IDIxLjI5MTQgNy42MTIzIDIxLjMxNDggNy42MjA1NkMyMS4zNTYxIDcuNjM1MjEgMjEuMzk3MSA3LjY1MDMyIDIxLjQzNzkgNy42NjUzNUMyMS40NTI0IDcuNjcwNjYgMjEuNDY2OCA3LjY3NTg4IDIxLjQ4MTIgNy42ODEyNEMyMS41MTQ5IDcuNjkzODIgMjEuNTQ4MyA3LjcwNjk0IDIxLjU4MTcgNy43MTk3OEMyMS42MDk0IDcuNzMwNDQgMjEuNjM3IDcuNzQwOTggMjEuNjY0NSA3Ljc1MTgxQzIxLjY4MzggNy43NTk0NSAyMS43MDMxIDcuNzY3MjcgMjEuNzIyMyA3Ljc3NDk5QzIxLjc1ODQgNy43ODk0OSAyMS43OTQ0IDcuODAzOTMgMjEuODMwMSA3LjgxODc0QzIxLjg1MjkgNy44MjgxOCAyMS44NzU1IDcuODM3ODIgMjEuODk4MSA3Ljg0NzM4QzIxLjkzMDIgNy44NjA5NyAyMS45NjIyIDcuODc0NDQgMjEuOTkzOSA3Ljg4ODI3QzIyLjAxODkgNy44OTkxNSAyMi4wNDM2IDcuOTEwMzEgMjIuMDY4NCA3LjkyMTM0QzIyLjA5NSA3LjkzMzE5IDIyLjEyMTUgNy45NDUgMjIuMTQ3OCA3Ljk1NzAyQzIyLjE3NzIgNy45NzA0NCAyMi4yMDY1IDcuOTg0MDEgMjIuMjM1NiA3Ljk5NzY0QzIyLjI2MTIgOC4wMDk2NSAyMi4yODY4IDguMDIxNjggMjIuMzEyMiA4LjAzMzg0QzIyLjMzNjggOC4wNDU2MyAyMi4zNjEyIDguMDU3NTggMjIuMzg1NiA4LjA2OTUyQzIyLjQxMTMgOC4wODIxMSAyMi40MzY5IDguMDk0NzggMjIuNDYyNCA4LjEwNzU0QzIyLjQ4NzYgOC4xMjAxNCAyMi41MTI1IDguMTMzMDYgMjIuNTM3NCA4LjE0NTgyQzIyLjU2NDcgOC4xNTk3OCAyMi41OTE5IDguMTczNTkgMjIuNjE4OSA4LjE4Nzc1QzIyLjY0NzMgOC4yMDI2NSAyMi42NzU1IDguMjE3OTQgMjIuNzAzNiA4LjIzMzA2QzIyLjcyMTggOC4yNDI4OCAyMi43NDAxIDguMjUyNTggMjIuNzU4MiA4LjI2MjQ5QzIyLjc4NjIgOC4yNzc3NSAyMi44MTQgOC4yOTMxMSAyMi44NDE2IDguMzA4NThDMjIuODY3OSA4LjMyMzM0IDIyLjg5NDIgOC4zMzgxNyAyMi45MjAyIDguMzUzMTFDMjIuOTMxNiA4LjM1OTY2IDIyLjk0MyA4LjM2NjMyIDIyLjk1NDMgOC4zNzI5QzIyLjk4ODIgOC4zOTI1MyAyMy4wMjIgOC40MTIwOCAyMy4wNTU0IDguNDMyMDJDMjMuMDc4MiA4LjQ0NTYyIDIzLjEwMDggOC40NTk0MiAyMy4xMjMzIDguNDczMTdDMjMuMTQ5OSA4LjQ4OTMyIDIzLjE3NjMgOC41MDU1MSAyMy4yMDI1IDguNTIxODZDMjMuMjE0OCA4LjUyOTUzIDIzLjIyNyA4LjUzNzMzIDIzLjIzOTIgOC41NDUwNEMyMy4yNzAyIDguNTY0NTQgMjMuMzAwOSA4LjU4NDEyIDIzLjMzMTQgOC42MDM4OUMyMy4zNTE5IDguNjE3MTggMjMuMzcyMyA4LjYzMDU5IDIzLjM5MjYgOC42NDRDMjMuNDIwOCA4LjY2MjYgMjMuNDQ4OSA4LjY4MTE1IDIzLjQ3NjcgOC42OTk5OUMyMy40OTE2IDguNzEwMDQgMjMuNTA2MyA4LjcyMDMzIDIzLjUyMSA4LjczMDQ2QzIzLjU0NzkgOC43NDg4OSAyMy41NzQ3IDguNzY3MjcgMjMuNjAxMiA4Ljc4NTkzQzIzLjYyMjUgOC44MDA5MiAyMy42NDM3IDguODE2MTEgMjMuNjY0OCA4LjgzMTI0QzIzLjY4NzYgOC44NDc2MSAyMy43MTA0IDguODYzOTMgMjMuNzMzIDguODgwNDZDMjMuNzQ5OSA4Ljg5Mjg2IDIzLjc2NjcgOC45MDU0NiAyMy43ODM1IDguOTE3OTZDMjMuODA5MSA4LjkzNjk4IDIzLjgzNDYgOC45NTYwMiAyMy44NTk4IDguOTc1MjVDMjMuODc4NCA4Ljk4OTQxIDIzLjg5NjkgOS4wMDM2OSAyMy45MTUzIDkuMDE3OTZDMjMuOTM3NSA5LjAzNTE4IDIzLjk1OTcgOS4wNTI0IDIzLjk4MTcgOS4wNjk3OEMyMy45OTk4IDkuMDg0MTMgMjQuMDE3OSA5LjA5ODU1IDI0LjAzNTggOS4xMTMwMUMyNC4wNTk1IDkuMTMyMDQgMjQuMDgzMSA5LjE1MTA5IDI0LjEwNjQgOS4xNzAzQzI0LjEyMTcgOS4xODI4OSAyNC4xMzY4IDkuMTk1NjYgMjQuMTUyIDkuMjA4MzJDMjQuMTc3MyA5LjIyOTQxIDI0LjIwMjQgOS4yNTA1NyAyNC4yMjczIDkuMjcxODZDMjQuMjQxNCA5LjI4Mzk2IDI0LjI1NTQgOS4yOTYxNiAyNC4yNjk0IDkuMzA4MzJDMjQuMjkyMiA5LjMyODA3IDI0LjMxNDkgOS4zNDc3OCAyNC4zMzc0IDkuMzY3N0MyNC4zNTYzIDkuMzg0NDggMjQuMzc1MiA5LjQwMTMxIDI0LjM5MzkgOS40MTgyMkMyNC40MTIzIDkuNDM0OCAyNC40MzA1IDkuNDUxNTIgMjQuNDQ4NiA5LjQ2ODIyQzI0LjQ2OTYgOS40ODc1IDI0LjQ5MDQgOS41MDY4NSAyNC41MTExIDkuNTI2MjlDMjQuNTI2NyA5LjU0MDk0IDI0LjU0MjMgOS41NTU1NyAyNC41NTc3IDkuNTcwM0MyNC41Nzc1IDkuNTg5MTUgMjQuNTk3MSA5LjYwODA5IDI0LjYxNjYgOS42MjcwN0MyNC42MzUzIDkuNjQ1MjUgMjQuNjUzOSA5LjY2MzQ1IDI0LjY3MjMgOS42ODE3NkMyNC42ODc0IDkuNjk2NzggMjQuNzAyNCA5LjcxMTk3IDI0LjcxNzQgOS43MjcwN0MyNC43MzY0IDkuNzQ2MjcgMjQuNzU1NiA5Ljc2NTI5IDI0Ljc3NDQgOS43ODQ2MkMyNC43OTI0IDkuODAzMDkgMjQuODEgOS44MjE3NyAyNC44Mjc4IDkuODQwMzVDMjQuODQ1NiA5Ljg1ODk5IDI0Ljg2MzMgOS44Nzc1OSAyNC44ODA5IDkuODk2MzRDMjQuODkzMSA5LjkwOTQgMjQuOTA1MiA5LjkyMjU1IDI0LjkxNzQgOS45MzU2N0MyNC45NDE3IDkuOTYyMDIgMjQuOTY1OCA5Ljk4ODUxIDI0Ljk4OTggMTAuMDE1MUMyNC45OTU4IDEwLjAyMTkgMjUuMDAxOSAxMC4wMjg2IDI1LjAwOCAxMC4wMzU0QzI1LjAzMzQgMTAuMDYzOCAyNS4wNTg2IDEwLjA5MjQgMjUuMDgzNSAxMC4xMjExQzI1LjA5MjcgMTAuMTMxNiAyNS4xMDE3IDEwLjE0MjMgMjUuMTEwOCAxMC4xNTI5QzI1LjEzMzcgMTAuMTc5NCAyNS4xNTY0IDEwLjIwNTggMjUuMTc4OCAxMC4yMzI1QzI1LjE5MDcgMTAuMjQ2NyAyNS4yMDI1IDEwLjI2MSAyNS4yMTQyIDEwLjI3NTJDMjUuMjMxNiAxMC4yOTYzIDI1LjI0ODkgMTAuMzE3NCAyNS4yNjYxIDEwLjMzODVDMjUuMzE0OSAxMC4zOTg4IDI1LjM2MjUgMTAuNDU5NiAyNS40MDkzIDEwLjUyMDhDMjUuNDIwOCAxMC41MzU4IDI1LjQzMjMgMTAuNTUwOCAyNS40NDM3IDEwLjU2NTlDMjUuNDU2NyAxMC41ODMyIDI1LjQ2OTYgMTAuNjAwNiAyNS40ODI1IDEwLjYxOEMyNS40OTc0IDEwLjYzODEgMjUuNTEyMyAxMC42NTgyIDI1LjUyNyAxMC42Nzg0QzI1LjU0MzcgMTAuNzAxNCAyNS41NjAzIDEwLjcyNDUgMjUuNTc2NyAxMC43NDc2QzI1LjU5MDcgMTAuNzY3MiAyNS42MDQ2IDEwLjc4NjggMjUuNjE4NCAxMC44MDY1QzI1LjYyOTMgMTAuODIyMiAyNS42NDAxIDEwLjgzNzkgMjUuNjUxIDEwLjg1MzZDMjUuNjY3OCAxMC44NzgxIDI1LjY4NDYgMTAuOTAyNyAyNS43MDEyIDEwLjkyNzNDMjUuNzEzMyAxMC45NDUzIDI1LjcyNTIgMTAuOTYzNCAyNS43MzcyIDEwLjk4MTVDMjUuNzQ5MyAxMC45OTk4IDI1Ljc2MTYgMTEuMDE4IDI1Ljc3MzYgMTEuMDM2NEMyNS43ODgzIDExLjA1ODkgMjUuODAyNyAxMS4wODE2IDI1LjgxNzEgMTEuMTA0MkMyNS44MyAxMS4xMjQzIDI1Ljg0MjcgMTEuMTQ0NiAyNS44NTU0IDExLjE2NDhDMjUuODY3NiAxMS4xODQ0IDI1Ljg3OTggMTEuMjA0IDI1Ljg5MTggMTEuMjIzN0MyNS45MDM3IDExLjI0MjkgMjUuOTE1NiAxMS4yNjIyIDI1LjkyNzMgMTEuMjgxNUMyNS45Mzc2IDExLjI5ODYgMjUuOTQ3OCAxMS4zMTU3IDI1Ljk1OCAxMS4zMzI4QzI1Ljk5NyAxMS4zOTg0IDI2LjAzNTIgMTEuNDY0NCAyNi4wNzIzIDExLjUzMDdDMjYuMDgzMSAxMS41NTAxIDI2LjA5MzkgMTEuNTY5NCAyNi4xMDQ2IDExLjU4ODhDMjYuMTE3OCAxMS42MTI5IDI2LjEzMDkgMTEuNjM3IDI2LjE0MzkgMTEuNjYxMkMyNi4xNTE4IDExLjY3NTggMjYuMTU5NiAxMS42OTA1IDI2LjE2NzQgMTEuNzA1MkMyNi4yMDI5IDExLjc3MjIgMjYuMjM3NSAxMS44Mzk2IDI2LjI3MTMgMTEuOTA3M0MyNi4yODM1IDExLjkzMTkgMjYuMjk1NyAxMS45NTY1IDI2LjMwNzcgMTEuOTgxMkMyNi4zMTQ3IDExLjk5NTYgMjYuMzIxNyAxMi4wMDk5IDI2LjMyODYgMTIuMDI0MkMyNi4zMzkxIDEyLjA0NjEgMjYuMzQ5NCAxMi4wNjgxIDI2LjM1OTggMTIuMDkwMUMyNi4zNzE4IDEyLjExNTYgMjYuMzg0IDEyLjE0MTEgMjYuMzk1NyAxMi4xNjY3QzI2LjQwMyAxMi4xODI0IDI2LjQxMDIgMTIuMTk4MiAyNi40MTc0IDEyLjIxNDFDMjYuNDI5MSAxMi4yNCAyNi40NDA3IDEyLjI2NjEgMjYuNDUyMyAxMi4yOTIyQzI2LjQ2MDcgMTIuMzExMyAyNi40NjkyIDEyLjMzMDUgMjYuNDc3NSAxMi4zNDk3QzI2LjQ4NzQgMTIuMzcyNCAyNi40OTczIDEyLjM5NSAyNi41MDY5IDEyLjQxNzdDMjYuNTE0MiAxMi40MzQ4IDI2LjUyMTQgMTIuNDUxOSAyNi41Mjg2IDEyLjQ2OUMyNi41MzY3IDEyLjQ4ODUgMjYuNTQ0NSAxMi41MDgxIDI2LjU1MjUgMTIuNTI3NkMyNi41ODA0IDEyLjU5NTUgMjYuNjA3MyAxMi42NjM3IDI2LjYzMzUgMTIuNzMyQzI2LjY1MyAxMi43ODI3IDI2LjY3MTcgMTIuODMzNSAyNi42OTAzIDEyLjg4NDRDMjYuNzAzOCAxMi45MjE0IDI2LjcxNzYgMTIuOTU4MiAyNi43MzA2IDEyLjk5NTNDMjYuNzQ2OCAxMy4wNDEzIDI2Ljc2MiAxMy4wODc1IDI2Ljc3NzUgMTMuMTMzNkMyNi43OTIgMTMuMTc2NyAyNi44MDY2IDEzLjIxOTggMjYuODIwNSAxMy4yNjNDMjYuODMxNyAxMy4yOTgxIDI2Ljg0MjQgMTMuMzMzMyAyNi44NTMzIDEzLjM2ODVDMjYuODY5NiAxMy40MjEyIDI2Ljg4NiAxMy40NzM5IDI2LjkwMTUgMTMuNTI2OEMyNi45MTUyIDEzLjU3NCAyNi45MjgyIDEzLjYyMTIgMjYuOTQxMyAxMy42Njg1QzI2Ljk1MjIgMTMuNzA4IDI2Ljk2MzEgMTMuNzQ3NCAyNi45NzM2IDEzLjc4N0MyNi45ODc1IDEzLjgzOTYgMjcuMDAwNiAxMy44OTIzIDI3LjAxMzcgMTMuOTQ1QzI3LjAyMjIgMTMuOTc5MyAyNy4wMzExIDE0LjAxMzQgMjcuMDM5MiAxNC4wNDc2QzI3LjA1MjkgMTQuMTA1MSAyNy4wNjU4IDE0LjE2MjcgMjcuMDc4NiAxNC4yMjAzQzI3LjA4NTUgMTQuMjUxNyAyNy4wOTI3IDE0LjI4MzEgMjcuMDk5NCAxNC4zMTQ2QzI3LjExMTggMTQuMzcyOCAyNy4xMjM0IDE0LjQzMTEgMjcuMTM0OCAxNC40ODkzQzI3LjE0MSAxNC41MjA5IDI3LjE0NzQgMTQuNTUyNSAyNy4xNTMzIDE0LjU4NDFDMjcuMTYyMyAxNC42MzE5IDI3LjE3MDUgMTQuNjc5OCAyNy4xNzg4IDE0LjcyNzZDMjcuMTg1OSAxNC43Njc4IDI3LjE5MzMgMTQuODA3OSAyNy4xOTk5IDE0Ljg0ODJDMjcuMjA4OCAxNC45MDI0IDI3LjIxNjggMTQuOTU2NyAyNy4yMjQ5IDE1LjAxMDlDMjcuMjMgMTUuMDQ0OCAyNy4yMzUyIDE1LjA3ODYgMjcuMjQgMTUuMTEyNUMyNy4yNDc3IDE1LjE2NjkgMjcuMjU0NyAxNS4yMjEyIDI3LjI2MTYgMTUuMjc1NUMyNy4yNjYzIDE1LjMxMjMgMjcuMjcxMSAxNS4zNDkgMjcuMjc1NCAxNS4zODU3QzI3LjI5MzEgMTUuNTM1MiAyNy4zMDggMTUuNjg0MiAyNy4zMjAyIDE1LjgzMjVDMjcuMzIyMiAxNS44NTY5IDI3LjMyNDQgMTUuODgxMiAyNy4zMjYyIDE1LjkwNTVDMjcuMzMgMTUuOTU1NSAyNy4zMzMxIDE2LjAwNTQgMjcuMzM2NCAxNi4wNTUyQzI3LjMzODggMTYuMDkyNCAyNy4zNDEzIDE2LjEyOTYgMjcuMzQzNCAxNi4xNjY3QzI3LjM0NjYgMTYuMjIyOSAyNy4zNDg4IDE2LjI3OTEgMjcuMzUxMiAxNi4zMzUxQzI3LjM1MjYgMTYuMzY3MyAyNy4zNTQ1IDE2LjM5OTQgMjcuMzU1NiAxNi40MzE1QzI3LjM1NzYgMTYuNDg1IDI3LjM1ODggMTYuNTM4NCAyNy4zNjAxIDE2LjU5MTdDMjcuMzYwOCAxNi42MjI4IDI3LjM2MTkgMTYuNjUzOSAyNy4zNjI0IDE2LjY4NDlDMjcuMzgwOSAxNy43OTY0IDI3LjI1ODkgMTguODM5IDI3LjA2NTMgMTkuNzA2QzI4LjE2NTMgMjAuMDA2IDI5Ljg5NDYgMjAuOTU5NiAyOS4wOTg2IDIzLjQzOTNMMjkuMDY0OCAyMy41Mzk2QzI4LjMzNjIgMjUuNjI4MyAyNi4xNzI2IDI2LjUzNTYgMjQuNTMxOSAyNi4zMDZDMjMuNzQzIDI3LjU5NDkgMjEuMDE4NSAzMC4xNzI2IDE2LjQzMTkgMzAuMTcyNkwxNi4yMTgxIDMwLjE3MDhDMTEuNzU3OSAzMC4wOTI0IDkuMDE4OTYgMjcuNTc0NyA4LjE5ODYxIDI2LjMwNkM3LjEyNjY3IDI2LjM5MzQgNC43ODYzMSAyNS45NTk4IDMuODc0MTMgMjMuNTU1MkwzLjgzMTk0IDIzLjQzOTNDMi45NTIwMiAyMC45MzI3IDQuNzk4NTkgMTkuOTA2IDUuODMxOTQgMTkuNzA2QzUuNzg2NjMgMTkuNTA1NSA1Ljc0NTA4IDE5LjI5NTYgNS43MDgyNCAxOS4wNzc2QzUuNjU5MTIgMTguNzg2OSA1LjYxODQ1IDE4LjQ4MTkgNS41ODc5MyAxOC4xNjU2QzUuNTY1MDUgMTcuOTI4NCA1LjU0NzgzIDE3LjY4NDkgNS41Mzc0MSAxNy40MzY0QzUuNTIzNTEgMTcuMTA1MSA1LjUyMTQ0IDE2Ljc2NDkgNS41MzMyNCAxNi40MTlDNS41NDUwNSAxNi4wNzMgNS41NzA4NSAxNS43MjEzIDUuNjEyNDEgMTUuMzY2OUM1LjY1Mzk2IDE1LjAxMjcgNS43MTEyOSAxNC42NTU4IDUuNzg2NjMgMTQuMjk5NUM1LjgwNTQ3IDE0LjIxMDQgNS44MjU0MSAxNC4xMjEzIDUuODQ2NTMgMTQuMDMyM0M1Ljg4ODc1IDEzLjg1NDMgNS45MzU3MiAxMy42NzY3IDUuOTg3NDEgMTMuNDk5N0M2LjAxMzI1IDEzLjQxMTMgNi4wNDAxIDEzLjMyMjkgNi4wNjg0IDEzLjIzNDlDNi4xMzkxNyAxMy4wMTQ3IDYuMjE3NzUgMTIuNzk2IDYuMzA0NiAxMi41Nzk0QzYuMzIxOTQgMTIuNTM2MiA2LjMzOTcxIDEyLjQ5MzEgNi4zNTc3MiAxMi40NUM2LjM5Mzc5IDEyLjM2MzcgNi40MzExOCAxMi4yNzc5IDYuNDY5OTYgMTIuMTkyNEM2LjQ4OTM3IDEyLjE0OTcgNi41MDkyNCAxMi4xMDcxIDYuNTI5MzQgMTIuMDY0NkM2LjU2OTQ5IDExLjk3OTYgNi42MTA4NiAxMS44OTUgNi42NTM4MiAxMS44MTA5QzYuNjc1MzIgMTEuNzY4OSA2LjY5NzIzIDExLjcyNyA2LjcxOTQ0IDExLjY4NTFDNi44MDgyMyAxMS41MTgxIDYuOTAyNzcgMTEuMzUzMSA3LjAwMzMgMTEuMTkwNkM3LjAyODQ2IDExLjE0OTkgNy4wNTM5NCAxMS4xMDk0IDcuMDc5ODYgMTEuMDY5QzcuMTMxNjMgMTAuOTg4NCA3LjE4NDkzIDEwLjkwODQgNy4yMzk3NSAxMC44MjkyQzcuMjc0NzQgMTAuNzc4NiA3LjMxMDUzIDEwLjcyODQgNy4zNDY3OSAxMC42Nzg0TDIuNjk4NjEgMTEuNTM5M0wzLjgzMTk0IDcuODA1OThMOC43MzUzMyA5LjE5Mzc0QzguNzcxNDkgOS4xNjM2NiA4LjgwNzgxIDkuMTMzNTQgOC44NDQ3IDkuMTAzODlMNi45OTg2MSA3LjgwNTk4TDkuMzY1MjggNS4wMzkzMUwxMS4yMDEgNy43NTE4MVpNMjIuOTY1MyAxMy4yMDZDMjAuMTMxOSAxMi4xMzkzIDE4LjQzMTkgMTQuMzA2IDE2LjQzMTkgMTQuMTA2QzE0LjQzMTkgMTMuOTA2IDEyLjk2NTMgMTIuMzA2IDEwLjAzMTkgMTMuMjA2QzcuMDk4NjEgMTQuMTA2IDcuMzMxOTQgMTcuODcyNiA3LjY2NTI4IDE5LjcwNkM3LjkzMTk0IDIxLjE3MjYgOC4yMzE5NCAyMy4zMDYgOC4yMzE5NCAyMy4zMDZDNy43NzgyNSAyMy4zMTU0IDYuODIzMjcgMjIuODA2OSA2LjE1NDA4IDIwLjg2NTZMNi4wNTk4MSAyMC44ODQxQzUuNzM0MzQgMjAuOTQ3MSA1LjMwMjA4IDIxLjE0NyA1LjA0NzU3IDIxLjQ2MkM0Ljg1ODU2IDIxLjY5NTkgNC42NDUwNCAyMi4xMzM0IDQuOTYzOTcgMjMuMDQxOUM1LjU4OTIyIDI0LjgyMjkgNy4yOTU2MiAyNS4xNzU2IDguMTAwOTUgMjUuMTA5OUw4LjgxNjMyIDI1LjA1MTZMOS4yMDYxNiAyNS42NTQ0QzkuODQ4NTYgMjYuNjQ4IDEyLjMwNTEgMjguOTcyNiAxNi40MzE5IDI4Ljk3MjZDMjAuNTUzOCAyOC45NzI2IDIyLjkxMTcgMjYuNjU0IDIzLjUwODIgMjUuNjc5NEwyMy45MTg5IDI1LjAwODZMMjQuNjk4MSAyNS4xMTc3QzI1Ljg5IDI1LjI4NDYgMjcuNDcxIDI0LjU4MjkgMjcuOTU1OSAyMy4wNzI2QzI4LjI0OSAyMi4xNTk2IDI4LjAzOTcgMjEuNzM0MiAyNy44NTY5IDIxLjUwNjVDMjcuNjExIDIxLjIwMDIgMjcuMTgxIDIwLjk4MTUgMjYuNzQ5NCAyMC44NjM4TDI2LjY5OTQgMjAuODVDMjYuMjczMSAyMS45NjQxIDI1LjU4MTkgMjMuMjA5NCAyNC43MzE5IDIzLjMwNkMyNC43MzE5IDIzLjMwNiAyNS4wMTg2IDIxLjY1MjYgMjUuMjMxOSAxOS43MDZDMjUuNDk4NiAxNy4yNzI2IDI1Ljc5ODYgMTQuMjcyNiAyMi45NjUzIDEzLjIwNloiIGZpbGw9IiMxODM4ODkiLz4KPHBhdGggZD0iTTE2LjUxNSAxLjgyNzMzQzE5LjIzMDIgMS44MjczNSAyMS40MzE0IDMuNzY3NDUgMjEuNDMxNCA2LjE2MDY3QzIxLjQzMTQgNi40MDE2NSAyMS40MDg1IDYuNjM3OTQgMjEuMzY1NSA2Ljg2ODIyQzIwLjQ4NTkgNi4zMzc5IDE4LjY0NDQgNS45NzI2NSAxNi41MTUgNS45NzI2NEMxNC4zODU1IDUuOTcyNjQgMTIuNTQzOSA2LjMzNzg2IDExLjY2NDIgNi44NjgyMkMxMS42MjEzIDYuNjM3OTUgMTEuNTk4NiA2LjQwMTY0IDExLjU5ODYgNi4xNjA2N0MxMS41OTg2IDMuNzY3NDMgMTMuNzk5OCAxLjgyNzMzIDE2LjUxNSAxLjgyNzMzWiIgZmlsbD0iIzE4Mzg4OSIvPgo8L3N2Zz4K"

const SIGN_IN_LABEL = "书生端砚 API key"

// ---------------------------------------------------------------------------
// 内部工具（不从入口导出；插件入口的每个导出函数都会被宿主当作插件调用）
// ---------------------------------------------------------------------------

async function listRemoteModelIds(key) {
  let res
  try {
    res = await fetch(MODELS_URL, { headers: { authorization: `Bearer ${key}` } })
  } catch {
    return { ok: false }
  }
  if (res.status === 401 || res.status === 403) return { ok: false, unauthorized: true }
  if (!res.ok) return { ok: false }
  let body = null
  try {
    body = await res.json()
  } catch {
    return { ok: false }
  }
  const ids = (Array.isArray(body?.data) ? body.data : [])
    .map((m) => (typeof m?.id === "string" ? m.id : null))
    .filter((id) => Boolean(id))
  if (ids.length === 0) return { ok: false }
  return { ok: true, ids }
}

function prettify(id) {
  return id
    .replace(/^claude-/i, "Claude ")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function signInExpiredError() {
  const err = new Error("书生端砚 API key 已失效，请重新登录")
  err.signIn = "expired"
  return err
}

/**
 * 合并动态模型清单。models 钩子返回的是 OpenCode Model 形状：
 * 协议分流用 api: { id, url, npm }（社区 Zed/ZCode 同款写法）；
 * 能力/价格平台清单里没有，给中性默认，避免宿主显示错误信息。
 */
function mergeModels(providerModels, ids) {
  const merged = {}
  for (const id of ids) {
    const base = providerModels?.[id] ?? {}
    // claude 系模型分流到 Anthropic 原生协议端点（同域），保留
    // server-side cache 等 Anthropic 特性；其余模型走 OpenAI 兼容端点。
    const claude = /claude/i.test(id)
    merged[id] = {
      ...base,
      id,
      name: base.name ?? prettify(id),
      api: {
        id,
        url: claude ? ANTHROPIC_BASE : OPENAI_BASE,
        npm: claude ? "@ai-sdk/anthropic" : "@ai-sdk/openai-compatible",
      },
      status: "active",
      cost: base.cost ?? { input: 0, output: 0, cache: { read: 0, write: 0 } },
      capabilities: base.capabilities ?? {
        temperature: true,
        reasoning: false,
        toolcall: true,
        attachment: false,
        input: { text: true },
        output: { text: true },
      },
    }
  }
  return merged
}

function makeModelsHook() {
  return async (provider, { auth }) => {
    const key = typeof auth?.key === "string" ? auth.key : ""
    if (!key) return provider.models
    const result = await listRemoteModelIds(key)
    if (result.unauthorized) throw signInExpiredError()
    if (!result.ok) return provider.models
    if (result.ids.length === 0) return provider.models
    return mergeModels(provider.models, result.ids)
  }
}

/**
 * 每个账号共用的 loader：把请求发往指定 base，并附上该账号的 API key。
 * 多账号由宿主管理（auth 作用域隔离），这里不持有任何模块级状态。
 */
function makeLoader(base) {
  return (getAuth) =>
    getAuth().then((auth) => {
      if (auth?.type !== "api" || typeof auth.key !== "string" || !auth.key) return {}
      const key = auth.key
      return {
        baseURL: base,
        // apiKey 只是占位：宿主会把这个 fetch 连同 loader options 交给
        // 其他插件（chat.headers 钩子），真 key 绝不出现在这里，
        // 只在下面的 fetch 里按请求注入请求头。
        apiKey: "magpie-intern-ai",
        async fetch(input, init) {
          // 宿主会把这个 fetch 交给其他插件用：只允许把 key 发往书生端砚自己的域名
          let origin = ""
          try {
            origin = new URL(String(input)).origin
          } catch {
            throw new Error("书生端砚插件：拒绝向无法识别的 URL 发送请求")
          }
          if (origin !== "https://discovery-api.intern-ai.org.cn") {
            throw new Error(`书生端砚插件：拒绝把 API key 发往 ${origin}`)
          }
          const headers = new Headers(init?.headers)
          headers.set("authorization", `Bearer ${key}`)
          // claude 系模型经模型级分流发往 Anthropic 协议端点，那里认 x-api-key；
          // OpenAI 兼容端点忽略这个多余的头，可以始终带上。
          headers.set("x-api-key", key)
          return fetch(input, { ...init, headers })
        },
      }
    })
}

// ---------------------------------------------------------------------------
// 用量概览（auth.usage）：从宿主的 usage.jsonl 台账按账号统计。
// 台账每行是一条请求记录（时间 t、provider、providerAccount、model、
// status、in / cache_read / out …），由宿主在调用发生时追加，按时间有序。
// ---------------------------------------------------------------------------

// 台账可能写在插件宿主进程的 cwd（便携数据目录），也可能在标准配置目录：
// 与宿主 appdir.Config() 的查找顺序一致，第一个可读的胜出
function usageLedgers(cwd, env, home) {
  const dirs = [cwd]
  if (env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME)) dirs.push(join(env.XDG_CONFIG_HOME, "magpie"))
  if (home) dirs.push(join(home, ".config", "magpie"))
  return dirs.map((d) => join(d, "usage.jsonl"))
}

// 行的时间与"客户端补报"标记在读 JSON 前先用正则看：绝大多数行属于别的
// provider，一条 match 就能跳过，不用付 JSON.parse 的钱
const ROW_TIME = /"t"\s*:\s*"([^"]{10,64})"/
const ROW_REPORTED = /"source"\s*:\s*"reported"/

const rowTime = (line) => {
  const m = ROW_TIME.exec(line)
  return m ? Date.parse(m[1]) : NaN
}
const rowReported = (line) => ROW_REPORTED.test(line)

// 账号怎么和台账行对上：providerAccount 是宿主给账号的标签——填了备注名
// 就是备注名（登录时存 metadata.email），没填则是 key 尾几位。有备注名时
// 只认精确相等（宁可少算也不把别人的算进来）；没有时 key 尾缀也能对上
// （宿主的标签可能带省略号前缀），providerAccount 为空的行只可能属于
// 唯一一个无备注账号，也计入
function accountMatcher(auth) {
  const label = typeof auth?.metadata?.email === "string" ? auth.metadata.email : ""
  const key = typeof auth?.key === "string" ? auth.key : ""
  const tail = key.length >= 12 ? key.slice(-4) : ""
  return {
    id: `${label}|${tail}|${key}`,
    match: (row) => {
      if (row?.provider !== "duanyan" && row?.provider !== "duanyan-plugin") return false
      if (typeof row?.model !== "string") return false
      const a = row.providerAccount
      if (label) return a === label
      return !a || (Boolean(tail) && (a === tail || a.endsWith(tail)))
    },
  }
}

// 台账读一遍的缓存：文件指纹（mtime+size）加账号加月初没变就不重读。
// 看板每次打开都会问一次，而台账可能有好几百 MB
let ledgerRead = null

// monthRows 取本账号落在本月（本地时区自然月）的台账行，旧→新。没有
// 可读台账时返回空数组（看板显示暂无记录，而不是报错）
function monthRows(id, match, monthStart, cwd = process.cwd(), env = process.env, home = homedir()) {
  let found = null
  for (const path of usageLedgers(cwd, env, home)) {
    try {
      const st = statSync(path)
      if (!st.size) continue
      found = { path, st }
      break
    } catch {}
  }
  if (!found) return []
  const { path, st } = found
  const key = `${path}|${st.mtimeMs}:${st.size}|${id}|${monthStart}`
  if (ledgerRead?.key === key) return ledgerRead.rows
  const rows = readMonthBack(path, st, monthStart, match)
  ledgerRead = { key, rows }
  return rows
}

// readMonthBack 从文件尾往前按块读，只解码属于本账号 duanyan 的行。
// 台账按时间从旧到新追加，所以倒着读时碰到第一条早于月初的行，它之前
// （更早）的行不可能再落在本月，读到即停——补报行（source: reported）
// 的时间是客户端调用发生的时刻，可以是过去任何时间，不代表文件进度，
// 不能作为边界
function readMonthBack(path, st, monthStart, match) {
  const CHUNK = 1 << 16
  const fd = openSync(path, "r")
  try {
    // 最后一个字节不是换行：最后一行可能正被写入，是残缺的
    let torn = false
    if (st.size > 0) {
      const one = Buffer.allocUnsafe(1)
      readSync(fd, one, 0, 1, st.size - 1)
      torn = one[0] !== 0x0a
    }
    const rows = []
    let bad = 0
    let pos = st.size
    let carry = ""
    let first = true
    let stop = false
    while (pos > 0 && !stop) {
      const len = Math.min(CHUNK, pos)
      pos -= len
      const buf = Buffer.allocUnsafe(len)
      readSync(fd, buf, 0, len, pos)
      const lines = (buf.toString("utf8") + carry).split("\n")
      carry = lines.shift() // 它的第一行开始于上一个块里
      for (let i = lines.length - 1; i >= 0 && !stop; i--) {
        const line = lines[i]
        if (!line.trim()) continue
        const t = rowTime(line)
        if (Number.isFinite(t) && !rowReported(line) && t < monthStart) {
          stop = true
          break
        }
        if (!line.includes("duanyan")) continue
        let row
        try {
          row = JSON.parse(line)
        } catch {
          // 最后一行残缺是正在写入，正常；文件中部的坏行说明记录丢了，
          // 记下来最后报一声，否则用量悄悄少一截没人知道
          if (!(first && torn && i === lines.length - 1)) bad++
          continue
        }
        if (match(row)) rows.push(row)
      }
      first = false
    }
    // 文件第一行前面没有换行：只有读到文件头才轮到它
    if (!stop && pos === 0 && carry.trim() && carry.includes("duanyan")) {
      const t = rowTime(carry)
      if (!(Number.isFinite(t) && !rowReported(carry) && t < monthStart)) {
        try {
          const row = JSON.parse(carry)
          if (match(row)) rows.push(row)
        } catch {
          if (!torn) bad++
        }
      }
    }
    if (bad > 0) console.error(`magpie-intern-ai: ${path} 有 ${bad} 行无法解析，用量统计可能偏少`)
    return rows.reverse()
  } finally {
    closeSync(fd)
  }
}

// tokensShort 把 token 数说短：11.9M、812k
function tokensShort(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`
  return String(Math.round(n))
}

// usageWindows 把台账行折成看板窗口：今日/本月 token（自然日、自然月，
// 本地时区），加本月用量最大的三个模型。token 口径与平台侧计费一致的
// 部分——输入（含缓存读）加输出；只有成功（status 200）的行有已产生的
// 用量。窗口都 aside：这是记录，不是平台配额，用完也不会停账号
function usageWindows(rows, now = new Date()) {
  const y = now.getFullYear()
  const mo = now.getMonth()
  const d = now.getDate()
  const dayStart = new Date(y, mo, d).getTime()
  const monthStart = new Date(y, mo, 1).getTime()
  const nextDay = new Date(y, mo, d + 1)
  const nextMonth = new Date(y, mo + 1, 1)
  const counted = (r) =>
    Number(r.status) === 200 ? (r.in ?? 0) + (r.cache_read ?? 0) + (r.out ?? 0) : 0

  let month = { tokens: 0, inTok: 0, cacheTok: 0, outTok: 0, n: 0 }
  let today = { tokens: 0, inTok: 0, cacheTok: 0, outTok: 0, n: 0 }
  const byModel = new Map()
  for (const r of rows) {
    const t = Date.parse(r.t)
    if (!Number.isFinite(t) || t < monthStart) continue
    const ok = Number(r.status) === 200
    const tokens = counted(r)
    const add = (b) => {
      b.tokens += tokens
      b.inTok += r.in ?? 0
      b.cacheTok += r.cache_read ?? 0
      b.outTok += r.out ?? 0
      if (ok) b.n++
    }
    add(month)
    if (t >= dayStart) add(today)
    if (tokens > 0) byModel.set(r.model, (byModel.get(r.model) ?? 0) + tokens)
  }

  // 有成功请求但 token 为 0 也如实显示 0，别和"没有请求"混为一谈；
  // 缓存读单列——它的计费与真实输入不同，混进"输入"会读错量级
  const sum = (b) => {
    if (b.n === 0) return "暂无记录"
    const parts = [`输入 ${tokensShort(b.inTok)}`]
    if (b.cacheTok > 0) parts.push(`缓存 ${tokensShort(b.cacheTok)}`)
    parts.push(`输出 ${tokensShort(b.outTok)}`)
    return `${tokensShort(b.tokens)}（${parts.join(" / ")}）`
  }
  const windows = [
    {
      name: "今日 tokens",
      amount: today.tokens,
      unit: "tokens",
      display: sum(today),
      resetsAt: nextDay.toISOString(),
      span: 86400,
      aside: true,
    },
    {
      name: "本月 tokens",
      amount: month.tokens,
      unit: "tokens",
      display: sum(month),
      resetsAt: nextMonth.toISOString(),
      span: Math.round((nextMonth.getTime() - monthStart) / 1000),
      aside: true,
    },
  ]
  const top = [...byModel.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
  for (const [model, tokens] of top) windows.push({ name: model, display: tokensShort(tokens), aside: true })
  return windows
}

// ---------------------------------------------------------------------------
// 控制台 API（/api/tokenplan/v1/*，走网页会话 token 而非 API key）：
// 墨点余额与平台侧用量。token 是控制台 Cookie 里的 uaa-token（非
// HttpOnly，用户可复制），以 Bearer 头发送；2026-10-31 登录抓包确认。
// ---------------------------------------------------------------------------

const CONSOLE_BASE = "https://discovery.intern-ai.org.cn"

const dateStr = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`

// 平台的时间戳是北京时间的 "YYYY-MM-DD HH:mm:ss"
const beijingMs = (s) =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s.trim())
    ? Date.parse(s.trim().replace(" ", "T") + "+08:00")
    : NaN

// consoleGet 调一个控制台端点。expired 表示网页 token 已失效（平台对
// 过期 token 回 A0211 "user token expired"，可能挂在 401 或 200 上）；
// 其余失败一律 ok: false，由调用方落回台账
async function consoleGet(path, token) {
  let res
  try {
    res = await fetch(CONSOLE_BASE + path, { headers: { authorization: `Bearer ${token}` } })
  } catch {
    return { ok: false }
  }
  if (res.status === 401 || res.status === 403) return { ok: false, expired: true }
  if (!res.ok) return { ok: false }
  let body
  try {
    body = await res.json()
  } catch {
    return { ok: false }
  }
  if (body?.success === false || (body?.code !== 0 && body?.code !== "0") || !body?.data) {
    return { ok: false, expired: body?.msgCode === "A0211" }
  }
  return { ok: true, data: body.data }
}

// 墨点计费到千分位（202.898），显示保留三位
const creditsShort = (n) =>
  Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: 3 }) : "0"

// creditPackages 拉全墨点套餐列表（credits/packages，分页应答 data.packages，
// 剩余量与周期都是字符串）。失败返回 null：套餐数据只用于 runsOut 决胜，
// 拿不到不影响卡片其余部分
async function creditPackages(token) {
  const out = []
  for (let page = 1; page <= 5; page++) {
    const r = await consoleGet(`/api/tokenplan/v1/credits/packages?page=${page}&page_size=200`, token)
    if (!r.ok) return page === 1 ? null : out
    const list = Array.isArray(r.data?.packages) ? r.data.packages : []
    out.push(...list)
    const total = Number(r.data?.total)
    if (list.length === 0 || !(Number.isFinite(total) && total > out.length)) break
  }
  return out
}

// inkRunsOut 是墨点包里最近的一次清零：时点与该次损失的墨点数。到期取
// current_cycle.end_at（月度包按周期清零）与 expire_at（一次性包到期；
// 月度包这里是 2099 哨兵）的较早者，2099 哨兵自然被周期时间压过。返回
// null = 没有可判断的清零时点
function inkRunsOut(pkgs, now = Date.now()) {
  let soonest = NaN
  let lost = 0
  for (const p of Array.isArray(pkgs) ? pkgs : []) {
    const remaining = Number.parseFloat(p?.remaining_credits)
    if (!(remaining > 0)) continue
    const exp = [p?.current_cycle?.end_at, p?.expire_at]
      .map(beijingMs)
      .filter((t) => Number.isFinite(t) && t > now)
      .sort((a, b) => a - b)[0]
    if (!Number.isFinite(exp)) continue
    if (!Number.isFinite(soonest) || exp < soonest) {
      soonest = exp
      lost = remaining
    } else if (exp === soonest) {
      lost += remaining
    }
  }
  return Number.isFinite(soonest) ? { at: soonest, lost } : null
}

// consoleWindows 把 balance（credits/balance）、summary（usage/summary，
// 可能为 null）和 packages（creditPackages，可能为 null）折成看板窗口：
// 墨点余额（balance 形，路由按余量挑账号；带最近清零时点 runsOutAt 供
// Smart 在重置打平时优先花快过期的账号）、5h/7d 用量窗口（平台侧限流）、
// 本月用量（纯文本，aside）
function consoleWindows(balance, summary, packages) {
  const windows = []
  const avail = Number.parseFloat(balance?.available_credits)
  if (Number.isFinite(avail)) {
    const run = inkRunsOut(packages)
    windows.push({
      name: "墨点余额",
      balance: avail,
      unit: "墨点",
      display: `${creditsShort(avail)} 墨点`,
      ...(run ? { runsOutAt: new Date(run.at).toISOString(), runsOut: run.lost } : {}),
    })
  }
  for (const [name, key, span] of [["5 小时窗口", "5h", 18000], ["7 天窗口", "7d", 604800]]) {
    const w = balance?.usage_windows?.[key]
    const used = Number.parseFloat(w?.used_credits)
    const limit = Number.parseFloat(w?.limit_credits)
    if (!w?.enabled || !(limit > 0) || !Number.isFinite(used)) continue
    const reset = beijingMs(w.next_recover_at)
    windows.push({
      name,
      used: Math.min(100, (100 * used) / limit),
      amount: used,
      limit,
      unit: "墨点",
      display: `${creditsShort(used)} / ${creditsShort(limit)} 墨点`,
      ...(Number.isFinite(reset) ? { resetsAt: new Date(reset).toISOString() } : {}),
      span,
    })
  }
  const s = summary?.summary
  if (s) {
    windows.push({
      name: "本月用量",
      aside: true,
      display: `${tokensShort(s.total_tokens ?? 0)} tokens · ${s.request_count ?? 0} 次 · ${creditsShort(Number.parseFloat(s.consumed_credits ?? 0))} 墨点`,
    })
  }
  return windows
}

// ---------------------------------------------------------------------------
// 浏览器弹窗登录（auth.methods 的 oauth 方法）：本地桥接页 + SSO 弹窗
// postMessage 流，登录后自动取回网页 token（uaa-token），墨点余额看板
// 不再手动粘贴。机制 2026-10-31 逆向自 SSO 生产包（sso main chunk 组件
// bc）：window.name === "login-plugin-wechat" 的弹窗在登录成功后 POST
// internal/auth {clientId} 拿一次性 code，postMessage 给 opener——
// 但目标 origin 取的是弹窗 URL 上的 openerOrigin 查询参数（K() 不做
// URL 解码），且必须命中白名单里的 http://localhost:8081。所以桥接页
// 必须：窗口名固定、URL 带 openerOrigin 原文、不带 redirect 参数
// （带 redirect 会走 science-discovery 重定向分支，没有 postMessage）。
//
// 登录方式默认手机号：SSO 的回传逻辑只在 /wechat 路由的组件里（vc/bc），
// /login 的手机号表单（Gn→Rn）没有任何回传，所以手机号流是两段式——
// 弹窗先开 /login 全量登录表单，登录成功后把同一个弹窗导航到 /wechat
// 插件页（window.name 在弹窗内跨导航保持），已建立的会话在那里一键
// 确认即触发回传。微信扫码保留为一步直达的选项。
// ---------------------------------------------------------------------------

const LOGIN_PORT = 8081 // SSO 弹窗 opener 白名单硬编码，不能换
const LOGIN_HOST = "127.0.0.1"
const LOGIN_DEADLINE_MS = 5 * 60_000
const LOGIN_EXCHANGE_TIMEOUT_MS = 30_000
const SSO_CLIENT_ID = "dagw07mkg1bazlxzoy31"
const SSO_POPUP_BASE = "https://sso.openxlab.org.cn/wechat"
const SSO_ORIGIN = "https://sso.openxlab.org.cn"
const SSO_MESSAGE_TYPE = "wechat-login-auth-success"
// {code} 换 uaa-token：必须由本进程发起（浏览器跨域没有 ACAO 头换不了）
const USERS_AUTH_URL = `${CONSOLE_BASE}/api/user-center/v1/users/auth`

// 手机号登录页（/login 全量登录表单：验证码 / 密码）。它没有回传逻辑，
// 只负责建立 SSO 会话；回传在第二段的 /wechat 确认页完成
function ssoLoginUrl() {
  return `${SSO_ORIGIN}/login?clientId=${SSO_CLIENT_ID}&lang=zh-CN`
}

// 弹窗地址：clientId + lang + openerOrigin 原文（不要 URL 编码——SSO 的
// 查询参数读取是裸 split("=")，编码值对不上白名单；也不要 redirect）
function ssoPopupUrl(port = LOGIN_PORT) {
  return `${SSO_POPUP_BASE}?clientId=${SSO_CLIENT_ID}&lang=zh-CN&openerOrigin=http://localhost:${port}`
}

// 桥接页：默认自动弹「手机号验证码登录」窗（/login 全量表单），登录成功
// 后回本页点「完成授权」——把同一个弹窗（window.name 相同即复用）导航到
// /wechat 插件页，已建立的会话在那里一键确认触发 postMessage 回传。微信
// 扫码是并排的一步直达选项。「完成授权」和「改用微信扫码」打开同一地址
// （都是 /wechat 插件页），区别只在引导语：前者面向刚用手机号登录完的
// 用户（看到的是确认页），后者面向想从头走微信的用户（看到的是二维码）。
// 监听弹窗 postMessage 拿一次性 code，回传本地 /code。code 的位置做两种
// 形状兼容：弹窗发的是 internal/auth 的原始响应体，一次性 code 在
// data.code（uaa-be 信封），兜底再看 code / data.data.code。
function bridgePageHtml(phoneUrl, wechatUrl) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>书生端砚 · 浏览器登录</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
 body{font:15px/1.6 system-ui,-apple-system,"PingFang SC",sans-serif;background:#f5f6fa;color:#1c2333;margin:0;display:grid;place-items:center;min-height:90vh}
 .card{background:#fff;border-radius:14px;box-shadow:0 6px 24px rgba(16,32,64,.08);max-width:460px;width:100%;padding:28px;margin:20px;box-sizing:border-box}
 h1{font-size:18px;margin:0 0 10px}
 ol{margin:0 0 14px;padding-left:20px;color:#4a5568}
 #status{border-radius:8px;padding:10px 12px;background:#f0f4ff;color:#183889;word-break:break-all}
 #status.err{background:#fdecec;color:#a12622}
 #status.ok{background:#e8f6ee;color:#1c7c3c}
 button{margin-top:14px;font-size:14px;padding:9px 16px;border-radius:8px;border:0;background:#183889;color:#fff;cursor:pointer;margin-right:8px}
 #reopen{display:none;background:#5b6474}
 #wechat{background:#fff;color:#183889;border:1px solid #b9c4dd}
</style></head><body><div class="card">
<h1>书生端砚 · 浏览器登录</h1>
<ol><li>已为你打开登录窗口，用 <b>手机号验证码</b>（或密码）登录。</li><li>登录成功后回到本页，点 <b>完成授权</b>：弹窗会变成确认页，再点一次确认即自动回传，弹窗自行关闭。</li><li>不想用手机号？点 <b>改用微信扫码</b>，扫码确认后自动回传。</li></ol>
<div id="status">正在打开登录窗口……</div>
<button id="finish">第二步：我已登录，完成授权</button><button id="wechat">改用微信扫码登录</button><button id="reopen">重新打开登录窗口</button>
<p style="color:#8a93a5;font-size:12px;margin:12px 0 0">弹窗被浏览器拦截时点「重新打开登录窗口」；完成后本页可以关闭。</p>
</div><script>
var PHONE_URL = ${JSON.stringify(phoneUrl)};
var WECHAT_URL = ${JSON.stringify(wechatUrl)};
var SSO_ORIGIN = ${JSON.stringify(SSO_ORIGIN)};
var MSG_TYPE = ${JSON.stringify(SSO_MESSAGE_TYPE)};
var statusEl = document.getElementById("status");
function say(text, cls) { statusEl.textContent = text; statusEl.className = cls || ""; }
function openPopup(url) { return window.open(url, "login-plugin-wechat", "width=520,height=720"); }
function blocked() { say("登录窗口被浏览器拦截，请点「重新打开登录窗口」。", "err"); var r = document.getElementById("reopen"); r.style.display = "inline-block"; }
document.getElementById("finish").addEventListener("click", function () {
  var w = openPopup(WECHAT_URL);
  if (!w) blocked();
  else say("已打开授权确认页：在弹窗里点一次「确认」，即自动回传并关闭弹窗。");
});
document.getElementById("wechat").addEventListener("click", function () {
  var w = openPopup(WECHAT_URL);
  if (!w) blocked();
  else say("已打开微信扫码登录：扫码并确认后自动回传。");
});
document.getElementById("reopen").addEventListener("click", function () {
  var w = openPopup(PHONE_URL);
  if (!w) blocked();
  else say("已打开登录窗口，请在弹窗中完成手机号或密码登录，然后回到本页点「完成授权」。");
});
try {
  var w = openPopup(PHONE_URL);
  if (!w) blocked();
  else say("等待登录……在弹窗中用手机号验证码或密码完成登录，然后回到本页点「完成授权」。");
} catch (e) { blocked(); }
function pick(x) {
  var cand = [x && x.data && x.data.code, x && x.code, x && x.data && x.data.data && x.data.data.code];
  for (var i = 0; i < cand.length; i++) if (typeof cand[i] === "string" && cand[i]) return cand[i];
  return "";
}
window.addEventListener("message", function (ev) {
  if (ev.origin !== SSO_ORIGIN) return;
  var d = ev.data;
  if (!d || d.type !== MSG_TYPE) return;
  var code = pick(d.data);
  if (!code) { say("登录消息里没有一次性 code，请在弹窗中重新登录。", "err"); return; }
  say("已收到登录信息，正在回传……");
  fetch("/code", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: code }) })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (j && j.ok) say("已回传，正在完成登录——请回到 Magpie 查看。本页可以关闭。", "ok");
      else say("回传失败：" + ((j && j.error) || "未知错误"), "err");
    })
    .catch(function () { say("回传失败：本地服务无响应，请回到 Magpie 重新发起登录。", "err"); });
});
</script></body></html>`
}

// 一次性 code 换网页 token。平台应答 {code:0, data:{token}}（假 code
// 回 -40132 "SSO authentication failed"）；失败信息只取平台的 msg 字段，
// token 绝不进错误文案、日志或返回值之外的地方
async function exchangeCodeForToken(code) {
  let res
  try {
    res = await fetch(USERS_AUTH_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
      signal: AbortSignal.timeout?.(LOGIN_EXCHANGE_TIMEOUT_MS),
    })
  } catch {
    throw new Error("连接书生端砚登录服务失败，请检查网络后重试")
  }
  let body = null
  try {
    body = await res.json()
  } catch {}
  const token = body?.data?.token
  if (res.ok && (body?.code === 0 || body?.code === "0") && typeof token === "string" && token) return token
  const why = typeof body?.msg === "string" && body.msg ? body.msg : `HTTP ${res.status}`
  throw new Error(`网页 token 获取失败（${why}）——请重试，或改用「${SIGN_IN_LABEL}」方式手动粘贴`)
}

/**
 * 起一次浏览器登录会话：本地桥接服务（127.0.0.1:port）+ 会话 Promise。
 * authorize await 监听就绪后才把 url 交给宿主打开；deadlineMs 到点自动
 * 关服务并唤醒 callback——宿主可能永远不调 callback（用户取消），不能
 * 让端口和服务挂着。端口注入只用于测试（生产固定 8081）。
 */
function startBrowserLogin({ key, email, port = LOGIN_PORT, deadlineMs = LOGIN_DEADLINE_MS } = {}) {
  const state = { code: null, error: null, done: false, closed: false }
  let resolveCode = null
  let rejectCode = null
  const codePromise = new Promise((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
  })
  // 宿主可能不调 callback（用户在 Magpie 里取消），先挂一个空 catch，
  // 否则超时 reject 会变成 unhandled rejection 把宿主进程炸掉
  codePromise.catch(() => {})
  const notify = () => {
    if (state.code) resolveCode(state.code)
    else if (state.error) rejectCode(new Error(state.error))
  }
  const minutes = Math.max(1, Math.round(deadlineMs / 60000))
  const server = createServer((req, res) => {
    const base = `http://localhost:${port}`
    let url
    try {
      url = new URL(req.url, base)
    } catch {
      res.writeHead(400)
      res.end()
      return
    }
    const send = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
      res.end(JSON.stringify(body))
    }
    // 写接口只收本机来源：浏览器同源 fetch 一定带 Origin（localhost:8081）；
    // 其他网页跨源 POST 在这里挡掉，防止别人往会话里塞 code
    const localOrigin = () => {
      const o = req.headers.origin
      return !o || /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(String(o))
    }
    if (url.pathname === "/code" && req.method === "POST") {
      if (!localOrigin()) {
        send(403, { ok: false, error: "forbidden origin" })
        return
      }
      let raw = ""
      req.on("data", (c) => {
        if (raw.length < 65536) raw += c
      })
      req.on("end", () => {
        if (state.closed) {
          send(200, { ok: false, error: "本地登录服务已关闭，请回到 Magpie 重新发起登录" })
          return
        }
        let parsed = null
        try {
          parsed = JSON.parse(raw || "{}")
        } catch {}
        const code = typeof parsed?.code === "string" ? parsed.code.trim() : ""
        if (!code) {
          send(200, { ok: false, error: "登录消息缺少一次性 code" })
          return
        }
        // 第一个 code 生效，重复回传幂等（用户在弹窗里重登也只认第一次）
        if (!state.code) {
          state.code = code
          notify()
        }
        send(200, { ok: true })
      })
      return
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/login-bridge")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
      res.end(bridgePageHtml(ssoLoginUrl(), ssoPopupUrl(port)))
      return
    }
    if (req.method === "GET" && url.pathname === "/healthz") {
      send(200, { ok: true })
      return
    }
    res.writeHead(404, { "Content-Type": "text/plain" })
    res.end("not found")
  })
  const serverReady = new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, LOGIN_HOST, () => resolve())
  })
  let timer = null
  const closeServer = () => {
    if (state.closed) return
    state.closed = true
    clearTimeout(timer)
    if (!state.done) {
      state.error ??= `浏览器登录超时（${minutes} 分钟）——请重新发起登录，或改用「${SIGN_IN_LABEL}」方式手动粘贴网页 token`
    }
    notify()
    try {
      server.close()
    } catch {}
    server.closeAllConnections?.()
  }
  return serverReady.then(() => {
    timer = setTimeout(closeServer, deadlineMs)
    timer.unref?.()
    server.on("error", closeServer)
    return {
      url: `http://localhost:${port}/login-bridge`,
      instructions: `浏览器登录已就绪：弹窗默认打开手机号验证码登录页，登录后回到桥接页点「完成授权」（弹窗被拦截时点「重新打开登录窗口」；也可改用微信扫码），成功后自动取回网页 token，${minutes} 分钟内有效。`,
      method: "auto",
      async callback() {
        try {
          const code = await codePromise
          const token = await exchangeCodeForToken(code)
          state.done = true
          // prompts 的值必须进 success 结果（宿主存账号时丢弃 oauth 的
          // inputs）：key 落顶层，备注名随 metadata 落库给账号命名
          const metadata = { webToken: token }
          if (email) metadata.email = email
          return { type: "success", key, metadata }
        } catch (e) {
          return { type: "failed", error: e?.message ?? String(e) }
        } finally {
          closeServer()
        }
      },
    }
  })
}

// 宿主 authorize 入口：校验 prompts（API key 必填），起本地会话。
// 端口被占用（EADDRINUSE）在这里翻译成清晰提示——弹窗流没有备选端口
// 可退（白名单写死 8081），只能请用户改用手动粘贴方式。
async function beginBrowserSignIn(inputs, opts = {}) {
  const key = typeof inputs?.key === "string" ? inputs.key.trim() : ""
  if (!key) throw new Error("请先填写 API key：浏览器登录只自动获取网页 token，对话请求仍需要 API key")
  const email = typeof inputs?.email === "string" ? inputs.email.trim() : ""
  const port = opts.port ?? LOGIN_PORT
  try {
    return await startBrowserLogin({ key, email, port, deadlineMs: opts.deadlineMs })
  } catch (e) {
    if (e?.code === "EADDRINUSE" || e?.code === "EACCES") {
      throw new Error(
        `本地端口 ${port} 被占用，浏览器登录需要它（SSO 弹窗白名单硬编码 8081）。` +
          `若刚取消过登录请稍等会话超时后重试，或重启 Magpie；也可以改用「${SIGN_IN_LABEL}」方式手动粘贴网页 token`,
      )
    }
    throw e
  }
}

// ---------------------------------------------------------------------------
// 书生端砚：单供应商。主走 OpenAI 兼容协议，claude 系模型在 models 钩子里
// 用模型级 provider 覆盖分流到 Anthropic 原生协议端点（同域）。
// ---------------------------------------------------------------------------

export const DuanYanAuth = async () => ({
  config: async (cfg) => {
    cfg.provider ??= {}
    // 默认值在前、用户在 plugins.json 里的配置在后：补齐字段但不覆盖用户改动
    const was = cfg.provider["duanyan"] ?? {}
    cfg.provider["duanyan"] = {
      name: "书生端砚",
      npm: "@ai-sdk/openai-compatible",
      api: OPENAI_BASE,
      models: {}, // 纯动态：登录后由 provider.models 从 /v1/models 拉取
      ...was,
    }
  },
  auth: {
    provider: "duanyan",
    icon: ICON,
    maxConcurrency: 4, // 单账号并发上限，防触发平台限流；用户在供应商设置里可覆盖
    methods: [
      {
        type: "api",
        label: SIGN_IN_LABEL,
        placeholder: "在 discovery.intern-ai.org.cn 的控制台生成 API key",
        // 多账号备注名：回答自动存进 metadata.email，宿主用它给账号命名
        // （命名优先级 accountId → metadata.email），列表里一眼分清哪个 key 是谁；
        // 不填则宿主用 key 尾几位命名。同备注名再次登录会替换原账号。
        prompts: [
          {
            type: "text",
            key: "email",
            message: "账号备注名（可选，多账号时便于区分，如：公司号）",
            placeholder: "留空则用 key 尾几位命名",
          },
          {
            // 网页 token：控制台 Cookie 里的 uaa-token（API key 打不开控制台
            // 接口）。存 metadata.webToken，usage 钩子用它显示墨点余额
            type: "text",
            key: "webToken",
            message: "网页 token（可选，用于墨点余额看板）",
            placeholder: "登录控制台后从 Cookie 复制 uaa-token 的值；留空则只统计本机用量",
          },
        ],
      },
      {
        // 浏览器弹窗登录：API key 仍必填（对话用它），网页 token 由 SSO
        // 弹窗流自动取回——宿主保存时把 success 结果里的 key 落成账号、
        // metadata 并进账号元数据，与手动粘贴 webToken 的账号同构，
        // 聊天与 usage 钩子零改动
        type: "oauth",
        label: "书生端砚账号（浏览器）",
        prompts: [
          {
            type: "text",
            key: "key",
            message: "API key（必填，用于对话请求）",
            placeholder: "在 discovery.intern-ai.org.cn 的控制台生成 API key 并粘贴",
          },
          {
            type: "text",
            key: "email",
            message: "账号备注名（可选，多账号时便于区分，如：公司号）",
            placeholder: "留空则用 key 尾几位命名",
          },
        ],
        authorize(inputs) {
          return beginBrowserSignIn(inputs)
        },
      },
    ],
    loader: makeLoader(OPENAI_BASE),
    // 用量概览看板（Magpie 的 auth.usage，OpenCode 不调用）：见文件头。
    // 有网页 token → 平台真数据（墨点余额 + 5h/7d 窗口 + 本月用量）；
    // 没有、过期或网络失败 → 落回本机 usage.jsonl 台账统计。token 过期
    // 只在卡片报错，不标 signIn: expired——API key 还有效，聊天不受影响。
    // key 有效性顺带用 /v1/models 探一次，401/403 才标记账号重新登录。
    async usage(getAuth) {
      const auth = await getAuth()
      if (auth?.type !== "api" || typeof auth.key !== "string" || !auth.key) {
        return { error: "未登录", signIn: "kept" }
      }
      const alive = await listRemoteModelIds(auth.key)
      if (alive.unauthorized) return { error: "书生端砚 API key 已失效，请重新登录", signIn: "expired" }
      const now = new Date()
      const user = typeof auth.metadata?.email === "string" ? auth.metadata.email : ""
      const webToken = typeof auth.metadata?.webToken === "string" ? auth.metadata.webToken.trim() : ""
      let tokenExpired = false
      if (webToken) {
        const monthBegin = dateStr(new Date(now.getFullYear(), now.getMonth(), 1))
        const [balance, summary, packages] = await Promise.all([
          consoleGet("/api/tokenplan/v1/credits/balance", webToken),
          consoleGet(`/api/tokenplan/v1/usage/summary?start_date=${monthBegin}&end_date=${dateStr(now)}&model=all`, webToken),
          creditPackages(webToken),
        ])
        if (balance.expired || summary.expired) tokenExpired = true
        if (balance.ok) {
          const windows = consoleWindows(balance.data, summary.ok ? summary.data : null, packages)
          if (windows.length) return { plan: "API key", user, windows, signIn: "kept" }
        }
      }
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
      const who = accountMatcher(auth)
      const rows = monthRows(who.id, who.match, monthStart)
      const out = { plan: "API key", user, windows: usageWindows(rows, now), signIn: "kept" }
      if (tokenExpired) {
        out.error = "网页 token 已过期，重新登录账号并更新网页 token 后可显示墨点余额（聊天不受影响）"
      }
      return out
    },
  },
  provider: {
    id: "duanyan",
    models: makeModelsHook(),
  },
})

/**
 * 测试辅助（对象不是函数，宿主不会把它当插件调用）：浏览器登录的内部
 * 构造器带端口/时限注入，测试不真绑 8081、不真开浏览器、不真联网。
 */
export const _internal = {
  ssoPopupUrl,
  startBrowserLogin,
  beginBrowserSignIn,
}

