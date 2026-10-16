// Page: 诊断 — request testing, routing, ledgers and the live event stream.
import { api } from "../api.js";
import { loadDebugModels } from "../data.js";
import * as logstream from "../logstream.js";
import * as store from "../store.js";
import {
  $,
  bindTabs,
  copyText,
  el,
  emptyRow,
  formatNumber,
  renderFacts,
  timeOnly,
  toast,
} from "../ui.js";

const keyTestLabels = {
  usable: "Key 可用",
  rejected: "Key 被拒绝",
  rate_limited: "Key 已被接受但受到限流",
  upstream_error: "上游异常，无法判定 Key",
  transport_error: "网络或代理异常，无法判定 Key",
  unavailable: "Key 或运行时不可用",
  request_error: "请求未成功",
};

function playgroundTemplate() {
  const protocol = $("#play-protocol").value;
  const model = $("#play-model").value || "YOUR_MODEL";
  if (protocol === "responses") return { model, input: "用一句话说明这个模型的能力。" };
  if (protocol === "anthropic")
    return {
      model,
      max_tokens: 512,
      messages: [{ role: "user", content: "用一句话说明这个模型的能力。" }],
    };
  return { model, messages: [{ role: "user", content: "用一句话说明这个模型的能力。" }] };
}

function resetTemplate() {
  $("#play-request").value = JSON.stringify(playgroundTemplate(), null, 2);
}

function renderKeys() {
  const select = $("#play-key");
  const selected = select.value;
  select.replaceChildren();
  select.append(el("option", { value: "auto", text: "自动路由（匿名 / Tier 回退 / Key 轮询）" }));
  const keys = store.get("debug")?.keys || {};
  for (const [tier, label] of [
    ["zen", "Zen Keys"],
    ["go", "Go Keys"],
  ]) {
    const items = keys[tier] || [];
    if (!items.length) continue;
    const group = el("optgroup", { label });
    for (const item of items) {
      const cooling = item.cooldown_until
        ? ` · 冷却至 ${new Date(item.cooldown_until).toLocaleTimeString("zh-CN", { hour12: false })}`
        : "";
      group.append(
        el("option", {
          value: `${tier}:${item.id}`,
          text: `${tier.toUpperCase()} · ${item.display} · ${item.id}${cooling}`,
        }),
      );
    }
    select.append(group);
  }
  if (selected && [...select.options].some((option) => option.value === selected)) select.value = selected;
  else select.value = "auto";
}

function renderModels() {
  const select = $("#play-model");
  const selected = select.value;
  select.replaceChildren();
  (store.get("debug")?.models || []).forEach((item) => {
    select.append(el("option", { value: item.model, text: item.model }));
  });
  if (selected && [...select.options].some((option) => option.value === selected)) select.value = selected;
  if (!$("#play-request").value.trim()) resetTemplate();
  renderKeys();
}

function showResult(result) {
  const keyTest = result.key_test ? keyTestLabels[result.key_test] || result.key_test : "";
  const state = $("#play-state");
  state.textContent = result.ok
    ? `请求成功 · HTTP ${result.http_status}`
    : `请求失败 · HTTP ${result.http_status}`;
  state.className = `section-caption ${result.ok ? "ok" : "bad"}`;
  const route = result.route || {};
  const eligibility = route.anonymous_eligibility || {};
  const selected = result.selected_key;
  const routeLabel = route.tier
    ? `${route.tier} / ${route.anonymous ? "anonymous" : route.key_id || "key"}`
    : "未路由";
  renderFacts($("#play-facts"), [
    ["HTTP 状态", result.http_status, result.ok ? "ok" : "bad"],
    ["耗时", `${result.duration_ms} ms`],
    ["Request ID", result.request_id || "—"],
    ["测试模式", selected ? `指定 ${selected.tier.toUpperCase()} Key` : "自动路由"],
    ["测试 Key", selected ? `${selected.display} · ${selected.id}` : "—"],
    [
      "Key 判断",
      keyTest || "自动路由未单独判定",
      result.key_test === "usable" ? "ok" : result.key_test ? "bad" : "",
    ],
    ["实际路由", routeLabel],
    ["原生协议", route.native_protocol || "—"],
    [
      "匿名判断",
      `${eligibility.allowed ? "允许" : "拒绝"} · ${eligibility.source || "—"}`,
      eligibility.allowed ? "ok" : "warn",
    ],
  ]);
  $("#play-output").textContent = JSON.stringify(result.response, null, 2);
}

async function run(event) {
  event.preventDefault();
  let request;
  try {
    request = JSON.parse($("#play-request").value);
  } catch (error) {
    toast(`请求 JSON 无效：${error.message}`, true);
    return;
  }
  const keyValue = $("#play-key").value;
  const key =
    keyValue === "auto"
      ? { mode: "auto" }
      : { mode: "selected", tier: keyValue.split(":")[0], id: keyValue.split(":").slice(1).join(":") };
  $("#play-run").disabled = true;
  $("#play-state").textContent =
    key.mode === "selected" ? "指定 Key 测试进行中…" : "Gateway 请求进行中…";
  try {
    store.set(
      "lastPlayground",
      await api("/api/debug/inference", {
        method: "POST",
        body: JSON.stringify({ protocol: $("#play-protocol").value, key, request }),
      }),
    );
  } catch (error) {
    toast(error.message, true);
    $("#play-state").textContent = "诊断入口请求失败";
  } finally {
    $("#play-run").disabled = false;
  }
}

function renderRequests() {
  const host = $("#upstream-requests");
  host.replaceChildren();
  (store.get("monitor")?.upstream?.requests || [])
    .slice(-100)
    .reverse()
    .forEach((request) => {
      const terminal = { stream_error: "流式响应失败", client_canceled: "客户端已取消" };
      const result = terminal[request.outcome]
        ? `HTTP ${request.status} · ${terminal[request.outcome]}`
        : request.status || request.outcome;
      host.append(
        el("tr", {}, [
          el("td", { class: "mono", text: timeOnly(request.time) }),
          el("td", { class: "mono", text: request.request_id }),
          el("td", { text: request.model }),
          el("td", { text: request.tier || "—" }),
          el("td", { text: request.channel }),
          el("td", { text: request.key_id || "—" }),
          el("td", { class: "num", text: request.attempts }),
          el("td", { class: request.success ? "ok" : "bad", text: result }),
          el("td", { class: "num", text: `${request.duration_ms} ms` }),
        ]),
      );
    });
  if (!host.children.length) emptyRow(host, 9, "尚无请求路由");
}

function renderAttempts() {
  const host = $("#upstream-attempts");
  host.replaceChildren();
  (store.get("monitor")?.upstream?.recent || [])
    .slice(-100)
    .reverse()
    .forEach((attempt) => {
      host.append(
        el("tr", {}, [
          el("td", { class: "mono", text: timeOnly(attempt.time) }),
          el("td", { class: "mono", text: attempt.request_id }),
          el("td", { text: attempt.model }),
          el("td", { text: `${attempt.tier} / ${attempt.channel}` }),
          el("td", { text: attempt.key_id }),
          el("td", { text: attempt.proxy_node }),
          el("td", { class: attempt.success ? "ok" : "bad", text: attempt.status || attempt.outcome }),
          el("td", { class: "num", text: `${attempt.duration_ms} ms` }),
        ]),
      );
    });
  if (!host.children.length) emptyRow(host, 8, "尚无上游尝试");
}

function renderMetadata() {
  const monitor = store.get("monitor");
  const debug = store.get("debug");
  const metadata = debug?.metadata || monitor?.resources?.metadata || {};
  renderFacts($("#metadata-facts"), [
    ["就绪", metadata.ready ? "是" : "否", metadata.ready ? "ok" : "warn"],
    ["模型数", formatNumber(metadata.models)],
    ["更新时间", metadata.updated_at ? new Date(metadata.updated_at).toLocaleString("zh-CN", { hour12: false }) : "尚未更新"],
    ["是否过期", metadata.stale ? "是" : "否", metadata.stale ? "warn" : "ok"],
    ["下次刷新", metadata.next_refresh ? new Date(metadata.next_refresh).toLocaleString("zh-CN", { hour12: false }) : "—"],
    ["最近错误", metadata.last_error || "无", metadata.last_error ? "bad" : "ok"],
  ]);
}

function renderRouteModels() {
  const debug = store.get("debug");
  const host = $("#diagnostic-models");
  if (!host || !debug) return;
  const query = $("#diagnostic-model-search").value.trim().toLowerCase();
  host.replaceChildren();
  (debug.models || [])
    .filter((item) => !query || item.model.toLowerCase().includes(query))
    .forEach((item) => {
      const eligibility = item.anonymous_eligibility || {};
      const plan = [...(item.anonymous ? ["anonymous"] : []), ...(item.key_tiers || [])];
      host.append(
        el("tr", {}, [
          el("td", { class: "mono", text: item.model }),
          el("td", { text: `${item.native_protocol} · ${item.protocol_source}` }),
          el("td", {
            class: item.route_error ? "bad" : "",
            text: item.route_error || (plan.length ? plan.join(" → ") : "—"),
          }),
          el("td", { class: eligibility.allowed ? "ok" : "warn", text: eligibility.allowed ? "允许" : "拒绝" }),
          el("td", { text: eligibility.source || "—" }),
          el("td", {
            class: "num",
            text: `${eligibility.input_cost == null ? "?" : eligibility.input_cost} / ${
              eligibility.output_cost == null ? "?" : eligibility.output_cost
            }`,
          }),
        ]),
      );
    });
  if (!host.children.length) emptyRow(host, 6, "没有匹配模型");
}

let activeTab = "playground";

function renderLedger() {
  renderRequests();
  renderAttempts();
}

function renderRoute() {
  renderMetadata();
  renderRouteModels();
}

export default {
  id: "diagnostics",
  title: "诊断",
  sub: "请求测试、路由资格与运行流水。",
  init() {
    bindTabs($("#page-diagnostics"), (id) => {
      activeTab = id;
      logstream.setVisible(id === "logs");
      if (id === "playground") {
        if (!store.get("debug")) loadDebugModels();
        renderModels();
      }
      if (id === "ledger") renderLedger();
      if (id === "route") renderRoute();
    });
    logstream.bind();
    $("#play-protocol").addEventListener("change", resetTemplate);
    $("#play-model").addEventListener("change", () => {
      try {
        const request = JSON.parse($("#play-request").value);
        request.model = $("#play-model").value;
        $("#play-request").value = JSON.stringify(request, null, 2);
      } catch {
        resetTemplate();
      }
    });
    $("#play-reset").addEventListener("click", resetTemplate);
    $("#play-form").addEventListener("submit", run);
    $("#play-copy").addEventListener("click", () => copyText($("#play-output").textContent, "原始响应已复制"));
    $("#diagnostic-model-search").addEventListener("input", renderRouteModels);
    store.on("debug", () => {
      renderModels();
      renderRoute();
    });
    store.on("monitor", () => {
      renderLedger();
      renderMetadata();
    });
    store.on("lastPlayground", (value) => {
      if (value) showResult(value);
    });
  },
  show() {
    if (!store.get("debug")) loadDebugModels();
    renderModels();
    renderLedger();
    renderRoute();
    if (activeTab === "logs") logstream.setVisible(true);
  },
  hide() {
    logstream.setVisible(false);
  },
  refresh() {
    if (activeTab === "logs") logstream.render();
  },
};
