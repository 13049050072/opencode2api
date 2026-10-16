// Page: 概览 — readiness checklist, metrics, resources and token usage.
import * as store from "../store.js";
import { $, bindTabs, el, emptyRow, formatNumber, timeOnly } from "../ui.js";

function renderChecklist() {
  const config = store.get("config");
  const monitor = store.get("monitor");
  if (!config || !monitor) return;
  const resources = monitor.resources;
  const models = resources.models || {};
  const modelDescription = models.stale
    ? "目录来自" + (models.cache_source || "磁盘") + "快取，等待后台刷新。"
    : "上游目录已完成首次刷新且有可暴露模型。";
  const checks = [
    ["配置本地 Key", "客户端使用 Server Key 访问 Gateway。", (config.server_keys || []).length > 0],
    [
      "选择上游通道",
      "至少有 Zen / Go Key，或启用匿名通道。",
      (config.zen_keys || []).length + (config.go_keys || []).length > 0 || config.anonymous,
    ],
    ["检查 Proxy", "至少一个代理节点健康。", (resources.proxies || []).some((proxy) => proxy.healthy)],
    ["等待模型目录", modelDescription, models.exposed > 0 && !!models.updated_at],
  ];
  const card = $("#overview-checklist");
  const ready = checks.every(([, , done]) => done);
  card.classList.toggle("hidden", ready);
  if (ready) return;
  const host = $("#guide-steps");
  host.replaceChildren();
  checks.forEach(([title, description, done]) => {
    host.append(
      el("article", { class: "guide-step" }, [
        el("h3", { text: title }),
        el("p", { text: description }),
        el("div", { class: `step-state ${done ? "ok" : "warn"}`, text: done ? "✓ 已就绪" : "○ 待处理" }),
      ]),
    );
  });
}

function renderResources(resources) {
  const proxies = $("#proxy-table");
  proxies.replaceChildren();
  (resources.proxies || []).forEach((proxy) => {
    proxies.append(
      el("tr", {}, [
        el("td", { text: proxy.address }),
        el("td", {
          class: `status ${proxy.healthy ? "ok" : "bad"}`,
          text: proxy.healthy ? "正常" : "不可用",
        }),
        el("td", {
          text: `Z ${proxy.zen_keys} · G ${proxy.go_keys} · A ${proxy.anonymous ? "开" : "关"}`,
        }),
      ]),
    );
  });
  if (!proxies.children.length) emptyRow(proxies, 3);
  const keys = $("#key-table");
  keys.replaceChildren();
  if (resources.anonymous) {
    keys.append(
      el("tr", {}, [
        el("td", { text: "anonymous" }),
        el("td", { text: "zen" }),
        el("td", { class: "status ok", text: "已启用" }),
      ]),
    );
  }
  (resources.keys || []).forEach((key) => {
    keys.append(
      el("tr", {}, [
        el("td", { text: key.id }),
        el("td", { text: key.tier }),
        el("td", {
          class: `status ${key.cooldown_until ? "warn" : "ok"}`,
          text: key.cooldown_until ? "冷却中" : "可用",
        }),
      ]),
    );
  });
  if (!keys.children.length) emptyRow(keys, 3);
}

function renderBreakdowns(metrics) {
  const host = $("#breakdowns");
  host.replaceChildren();
  [
    ["端点", metrics.endpoints],
    ["状态码", metrics.statuses],
    ["模型", metrics.models],
    ["Tier", metrics.tiers],
  ].forEach(([title, data]) => {
    const body = el("tbody");
    Object.entries(data || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .forEach(([key, value]) => {
        body.append(el("tr", {}, [el("td", { text: key }), el("td", { class: "num", text: value })]));
      });
    if (!body.children.length) emptyRow(body, 2, "暂无请求");
    host.append(
      el("div", { class: "breakdown" }, [
        el("h3", { text: title }),
        el("div", { class: "table-wrap" }, [el("table", { class: "table" }, [body])]),
      ]),
    );
  });
}

function renderSummary(monitor) {
  const metrics = monitor.metrics;
  $("#m-total").textContent = formatNumber(metrics.last_hour.total);
  $("#m-rate").textContent = `${((metrics.last_hour.success_rate || 0) * 100).toFixed(1)}%`;
  $("#m-p95").textContent = `${metrics.last_hour.p95_ms || 0} ms`;
  $("#m-active").textContent = `${metrics.active_requests || 0} / ${metrics.active_streams || 0}`;
  renderResources(monitor.resources);
  renderBreakdowns(metrics);
}

function renderTrend(metrics) {
  const trend = $("#usage-trend");
  const series = metrics?.series || [];
  const maximum = Math.max(1, ...series.map((point) => point.total_tokens || 0));
  trend.replaceChildren();
  series.forEach((point) => {
    const bar = el("div", { class: "trend-bar" });
    bar.style.height = `${Math.max(2, Math.round(((point.total_tokens || 0) / maximum) * 100))}%`;
    bar.title = `${timeOnly(point.minute)} · input ${formatNumber(point.input_tokens)} · output ${formatNumber(point.output_tokens)} · total ${formatNumber(point.total_tokens)}`;
    trend.append(bar);
  });
  $("#usage-trend-meta").textContent = series.length
    ? `峰值 ${formatNumber(maximum)} tokens / 分钟 · 近 ${series.length} 分钟`
    : "尚无趋势数据";
}

function renderUsageModels(usage) {
  const host = $("#usage-models");
  host.replaceChildren();
  Object.entries(usage.models || {})
    .sort((a, b) => (b[1].total_tokens || 0) - (a[1].total_tokens || 0))
    .slice(0, 15)
    .forEach(([model, value]) => {
      host.append(
        el("tr", {}, [
          el("td", { class: "mono", text: model }),
          el("td", { class: "num", text: formatNumber(value.input_tokens) }),
          el("td", { class: "num", text: formatNumber(value.output_tokens) }),
          el("td", { class: "num", text: formatNumber(value.total_tokens) }),
        ]),
      );
    });
  if (!host.children.length) emptyRow(host, 4, "尚无 Token 用量");
}

function renderTiers(usage) {
  const host = $("#usage-tiers");
  const entries = Object.entries(usage.tiers || {}).sort(
    (a, b) => (b[1].total_tokens || 0) - (a[1].total_tokens || 0),
  );
  const total = Math.max(1, ...entries.map(([, value]) => value.total_tokens || 0));
  host.replaceChildren();
  entries.forEach(([tier, value]) => {
    const fill = el("div", { class: "tier-fill" });
    fill.style.width = `${Math.round(((value.total_tokens || 0) / total) * 100)}%`;
    host.append(
      el("div", { class: "tier-row" }, [
        el("strong", { text: tier }),
        el("div", { class: "tier-track" }, [fill]),
        el("span", { class: "tier-value", text: formatNumber(value.total_tokens) }),
      ]),
    );
  });
  if (!entries.length) host.append(el("div", { class: "empty", text: "尚无 Tier 用量" }));
}

function renderUsage(monitor) {
  const usage = monitor.usage?.last_hour || {};
  const tokens = usage.tokens || {};
  $("#u-coverage").textContent = `${((usage.coverage || 0) * 100).toFixed(1)}%`;
  $("#u-total").textContent = formatNumber(tokens.total_tokens);
  $("#u-cached").textContent = formatNumber(tokens.cached_tokens);
  $("#u-reasoning").textContent = formatNumber(tokens.reasoning_tokens);
  renderTrend(monitor.metrics);
  renderUsageModels(usage);
  renderTiers(usage);
}

function render() {
  renderChecklist();
  const monitor = store.get("monitor");
  if (!monitor) return;
  renderSummary(monitor);
  renderUsage(monitor);
}

export default {
  id: "overview",
  title: "概览",
  sub: "运行指标、Token 用量与资源状态。",
  init() {
    bindTabs($("#page-overview"));
    store.on("monitor", render);
    store.on("config", renderChecklist);
  },
  show: render,
};
