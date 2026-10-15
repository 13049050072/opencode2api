const $ = (selector) => document.querySelector(selector),
  $$ = (selector) => [...document.querySelectorAll(selector)];
// Text is authored in Simplified Chinese and stays the fallback for every locale
// without a dictionary entry; window.O2I18N only replaces what it can translate.
const t = (original, key, ...args) => window.O2I18N.t(original, key, ...args);
window.O2I18N.init();
let csrf = "",
  config = null,
  monitorData = null,
  debugData = null,
  lastPlayground = null,
  logEvents = [],
  eventSource = null,
  paused = false,
  monitorTimer = null,
  logRenderPending = false,
  toastTimer = null;
const pages = {
  availability: ["13", "免费模型可用性", "每小时探测，手动控制的模型不受影响。"],
  rotation: ["12", "模型轮转", "共享当前模型、故障切换与尝试记录。"],
  overview: ["01", "运行桌面", "最近一小时、进程累计与当前资源状态。"],
  guide: ["02", "首次运行", "用六个检查点完成从配置到首个请求。"],
  access: ["03", "接入手册", "Chat、Responses、Anthropic 与 SDK 示例。"],
  usage: ["04", "Token 用量", "覆盖率、每分钟趋势、模型排行与 Tier 分布。"],
  playground: ["05", "Playground", "三种入口协议共用真实 Gateway 路由与诊断。"],
  diagnostics: ["06", "路由诊断", "Metadata、模型资格与每一次上游尝试。"],
  config: ["07", "配置中心", "验证后原子保存，并热应用可变字段。"],
  logs: ["08", "事件日志", "来自进程内 Ring Buffer 的结构化 SSE。"],
  account: ["09", "账号安全", "更新后撤销全部管理 Session。"],
  "model-quotas": ["10", "模型与额度", "可用模型、共享套餐剩余额度与重置时间。"],
  "api-keys": ["11", "API Key 管理", "给每个调用方独立的访问密钥。"],
};
const pageMeta = (page) => [
  pages[page][0],
  t(pages[page][1], `page.${page}.title`),
  t(pages[page][2], `page.${page}.sub`),
];
function renderPageHeader(page) {
  const meta = pageMeta(page);
  $("#page-index").textContent = t("Section {0}", "page.section", meta[0]);
  $("#page-title").textContent = meta[1];
  $("#page-sub").textContent = meta[2];
}
async function api(path, options = {}) {
  options.headers = { ...(options.headers || {}), Accept: "application/json" };
  if (options.body) options.headers["Content-Type"] = "application/json";
  if (csrf && !["GET", "HEAD"].includes(options.method || "GET"))
    options.headers["X-CSRF-Token"] = csrf;
  const response = await fetch(path, options);
  if (response.status === 401) {
    showLogin();
    throw new Error(t("登录已失效", "error.session"));
  }
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `HTTP ${response.status}`);
  return data;
}
function toast(message, bad = false) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.toggle("bad-toast", bad);
  node.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.add("hidden"), 3600);
}
function showLogin() {
  csrf = "";
  $("#app").classList.add("hidden");
  $("#login").classList.remove("hidden");
  if (eventSource) eventSource.close();
  eventSource = null;
  clearInterval(monitorTimer);
  clearInterval(quotaTimer);
  clearCreatedKey();
  $("#api-key-value").value = "";
}
async function enterConsole(session) {
  csrf = session.csrf_token;
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");
  await loadConfig();
  await Promise.all([refreshMonitor(), loadDebugModels()]);
  clearInterval(monitorTimer);
  monitorTimer = setInterval(refreshMonitor, 3000);
  connectLogs();
  openPage(pages[location.hash.slice(1)] ? location.hash.slice(1) : "overview");
}
async function boot() {
  try {
    await enterConsole(await api("/api/auth/session"));
  } catch (_) {
    showLogin();
  }
}
$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#login-error").textContent = "";
  try {
    const session = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: $("#login-user").value, password: $("#login-pass").value }),
    });
    $("#login-pass").value = "";
    await enterConsole(session);
  } catch (error) {
    $("#login-error").textContent = error.message;
  }
});
$("#logout").onclick = async () => {
  try {
    await api("/api/auth/logout", { method: "POST", body: "{}" });
  } finally {
    showLogin();
  }
};
function openPage(page) {
  if (!pages[page]) return;
  history.replaceState(null, "", `#${page}`);
  clearInterval(quotaTimer);
  if (page !== "api-keys") clearCreatedKey();
  $$(".nav button").forEach((button) =>
    button.classList.toggle("active", button.dataset.page === page),
  );
  $$(".page").forEach((node) => node.classList.toggle("hidden", node.id !== `page-${page}`));
  renderPageHeader(page);
  if (page === "access") renderAccessExamples();
  if (page === "usage") renderUsage();
  if (page === "model-quotas") {
    loadModelQuotas();
    quotaTimer = setInterval(() => {
      if (!document.hidden) loadModelQuotas();
    }, 60000);
  }
  if (page === "rotation") loadRotation();
  if (page === "availability") loadAvailability();
  if (page === "api-keys") loadAPIKeys();
  if (page === "playground" && !debugData) loadDebugModels();
  if (page === "diagnostics") {
    loadDebugModels();
    renderDiagnostics();
  }
}
$$(".nav button").forEach((button) => (button.onclick = () => openPage(button.dataset.page)));
async function loadConfig() {
  config = await api("/api/config");
  fillConfig(config);
  renderAccessExamples();
}
function fillConfig(value) {
  $("#c-listen").value = value.listen;
  $("#c-prefer").value = value.prefer;
  $("#c-web-listen").value = value.webui.listen;
  $("#c-session").value = value.webui.session_ttl_minutes;
  $("#c-web-enabled").checked = value.webui.enabled;
  $("#c-anonymous").checked = !!value.anonymous;
  $("#c-proxyfile").value = value.proxyfile;
  $("#c-up-zen").value = value.upstream.zen;
  $("#c-up-go").value = value.upstream.go;
  $("#c-attempts").value = value.retry.max_attempts;
  $("#c-timeout").value = value.retry.timeout_seconds;
  $("#c-refresh").value = value.models.refresh_seconds;
  $("#c-protocols").value = JSON.stringify(value.models.protocols || {}, null, 2);
  $("#c-free-only").checked = !!value.models.free_only;
  const reasoning = value.reasoning || {};
  $("#c-reasoning-effort").value = reasoning.effort || "";
  $("#c-reasoning-by-model").value = JSON.stringify(reasoning.effort_by_model || {}, null, 2);
  $("#c-idle").value = value.performance.max_idle_conns;
  $("#c-idle-host").value = value.performance.max_idle_conns_per_host;
  $("#c-max-host").value = value.performance.max_conns_per_host;
  $("#c-idle-timeout").value = value.performance.idle_conn_timeout_seconds;
  $("#c-connect").value = value.performance.connect_timeout_seconds;
  $("#c-cooldown").value = value.performance.failure_cooldown_seconds;
  $("#c-attempt-timeout").value = value.performance.attempt_timeout_seconds;
  $("#c-first-event-timeout").value = value.performance.first_event_timeout_seconds || 0;
  $("#c-level").value = value.logging.level;
  $("#c-ring").value = value.logging.ring_size;
  $("#c-dump-bodies").checked = !!value.logging.dump_request_bodies;
  ["server_keys", "zen_keys", "go_keys", "proxies"].forEach(renderChips);
  renderRestartNotice(value);
}
function renderRestartNotice(value) {
  const notice = $("#restart-notice");
  if (value.restart_required_fields?.length) {
    notice.textContent = t(
      `已保存但尚未生效：${value.restart_required_fields.join(", ")}。当前 API ${value.effective.listen}、WebUI ${value.effective.webui_listen}。请重启进程。`,
      "config.restartNotice",
      value.restart_required_fields.join(", "),
      value.effective.listen,
      value.effective.webui_listen,
    );
    notice.classList.remove("hidden");
  } else notice.classList.add("hidden");
}
function renderChips(name) {
  const host = $(`#${name}-chips`);
  host.replaceChildren();
  (config[name] || []).forEach((item) => {
    const chip = document.createElement("span"),
      text = document.createElement("span"),
      remove = document.createElement("button");
    chip.className = "chip";
    chip.dataset.id = item.id;
    text.textContent = item.display;
    remove.type = "button";
    remove.title = t("移除", "common.remove");
    remove.textContent = "×";
    remove.onclick = () => chip.remove();
    chip.append(text, remove);
    host.appendChild(chip);
  });
}
function secretInputs(name) {
  const kept = [...$(`#${name}-chips`).children].map((node) => ({ id: node.dataset.id }));
  const added = $(`#${name}-new`)
    .value.split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => ({ value }));
  return kept.concat(added);
}
const number = (id) => Number($(id).value);
$("#config-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const update = {
      listen: $("#c-listen").value,
      server_keys: secretInputs("server_keys"),
      zen_keys: secretInputs("zen_keys"),
      go_keys: secretInputs("go_keys"),
      anonymous: $("#c-anonymous").checked,
      proxies: secretInputs("proxies"),
      proxyfile: $("#c-proxyfile").value,
      prefer: $("#c-prefer").value,
      upstream: { zen: $("#c-up-zen").value, go: $("#c-up-go").value },
      retry: { max_attempts: number("#c-attempts"), timeout_seconds: number("#c-timeout") },
      models: {
        refresh_seconds: number("#c-refresh"),
        protocols: JSON.parse($("#c-protocols").value || "{}"),
        free_only: $("#c-free-only").checked,
      },
      reasoning: {
        effort: $("#c-reasoning-effort").value,
        effort_by_model: JSON.parse($("#c-reasoning-by-model").value || "{}"),
      },
      performance: {
        max_idle_conns: number("#c-idle"),
        max_idle_conns_per_host: number("#c-idle-host"),
        max_conns_per_host: number("#c-max-host"),
        idle_conn_timeout_seconds: number("#c-idle-timeout"),
        connect_timeout_seconds: number("#c-connect"),
        failure_cooldown_seconds: number("#c-cooldown"),
        attempt_timeout_seconds: number("#c-attempt-timeout"),
        first_event_timeout_seconds: number("#c-first-event-timeout"),
      },
      logging: {
        level: $("#c-level").value,
        ring_size: number("#c-ring"),
        dump_request_bodies: $("#c-dump-bodies").checked,
      },
      webui: {
        enabled: $("#c-web-enabled").checked,
        listen: $("#c-web-listen").value,
        username: config.webui.username,
        session_ttl_minutes: number("#c-session"),
      },
    };
    const result = await api("/api/config", { method: "PUT", body: JSON.stringify(update) });
    config = result.config;
    ["server_keys", "zen_keys", "go_keys", "proxies"].forEach(
      (name) => ($(`#${name}-new`).value = ""),
    );
    fillConfig(config);
    await loadDebugModels();
    toast(
      result.result.restart_required
        ? t(
            `已应用；${result.result.restart_fields.join(", ")} 需重启`,
            "toast.config.restart",
            result.result.restart_fields.join(", "),
          )
        : t("配置已保存并立即应用", "toast.config.saved"),
    );
  } catch (error) {
    toast(error.message, true);
  }
});
$("#reload-config").onclick = async () => {
  try {
    const result = await api("/api/config/reload", { method: "POST", body: "{}" });
    await loadConfig();
    await loadDebugModels();
    toast(
      result.restart_required
        ? t("磁盘配置已重载，监听字段需重启", "toast.config.reloadedRestart")
        : t("磁盘配置已重载", "toast.config.reloaded"),
    );
  } catch (error) {
    toast(error.message, true);
  }
};
$("#reveal").onclick = async () => {
  const password = prompt(t("请再次输入管理密码", "config.revealPrompt"));
  if (password === null) return;
  try {
    const values = await api("/api/config/reveal", {
      method: "POST",
      body: JSON.stringify({ password }),
    });
    $("#modal-content").textContent = JSON.stringify(values, null, 2);
    $("#modal").classList.remove("hidden");
  } catch (error) {
    toast(error.message, true);
  }
};
$("#modal-close").onclick = () => {
  $("#modal").classList.add("hidden");
  $("#modal-content").textContent = "";
};
$("#account-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/account", {
      method: "PUT",
      body: JSON.stringify({
        current_password: $("#a-current").value,
        username: $("#a-user").value,
        new_password: $("#a-new").value,
      }),
    });
    toast(t("账号已更新，请重新登录", "toast.account.updated"));
    setTimeout(showLogin, 800);
  } catch (error) {
    toast(error.message, true);
  }
});
function appendCell(row, value, className = "") {
  const cell = document.createElement("td");
  cell.textContent = String(value);
  if (className) cell.className = className;
  row.appendChild(cell);
}
function emptyRow(host, columns, message = t("暂无数据", "common.empty")) {
  const row = document.createElement("tr"),
    cell = document.createElement("td");
  cell.colSpan = columns;
  cell.className = "empty";
  cell.textContent = message;
  row.appendChild(cell);
  host.appendChild(row);
}
function renderResources(resources) {
  const proxies = $("#proxy-table");
  proxies.replaceChildren();
  (resources.proxies || []).forEach((proxy) => {
    const row = document.createElement("tr");
    appendCell(row, proxy.address);
    appendCell(
      row,
      proxy.healthy ? t("正常", "state.healthy") : t("不可用", "state.unavailable"),
      `status ${proxy.healthy ? "ok" : "bad"}`,
    );
    appendCell(
      row,
      `Z ${proxy.zen_keys} · G ${proxy.go_keys} · A ${proxy.anonymous ? t("开", "common.on") : t("关", "common.off")}`,
    );
    proxies.appendChild(row);
  });
  if (!proxies.children.length) emptyRow(proxies, 3);
  const keys = $("#key-table");
  keys.replaceChildren();
  if (resources.anonymous) {
    const row = document.createElement("tr");
    appendCell(row, "anonymous");
    appendCell(row, "zen");
    appendCell(row, t("已启用", "state.enabled"), "status ok");
    keys.appendChild(row);
  }
  (resources.keys || []).forEach((key) => {
    const row = document.createElement("tr");
    appendCell(row, key.id);
    appendCell(row, key.tier);
    appendCell(
      row,
      key.cooldown_until ? t("冷却中", "state.cooling") : t("可用", "state.available"),
      `status ${key.cooldown_until ? "warn" : "ok"}`,
    );
    keys.appendChild(row);
  });
  if (!keys.children.length) emptyRow(keys, 3);
}
function renderBreakdowns(metrics) {
  const host = $("#breakdowns");
  host.replaceChildren();
  [
    [t("端点", "breakdown.endpoint"), metrics.endpoints],
    [t("状态码", "breakdown.status"), metrics.statuses],
    [t("模型", "breakdown.model"), metrics.models],
    ["Tier", metrics.tiers],
  ].forEach(([title, data]) => {
    const block = document.createElement("div"),
      heading = document.createElement("h3"),
      table = document.createElement("table"),
      body = document.createElement("tbody");
    heading.textContent = title;
    table.className = "table";
    Object.entries(data || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .forEach(([key, value]) => {
        const row = document.createElement("tr");
        appendCell(row, key);
        appendCell(row, value);
        body.appendChild(row);
      });
    if (!body.children.length) emptyRow(body, 2, t("暂无请求", "breakdown.empty"));
    table.appendChild(body);
    block.append(heading, table);
    host.appendChild(block);
  });
}
function renderGuide() {
  if (!config || !monitorData) return;
  const resources = monitorData.resources,
    models = resources.models || {},
    modelDescription = models.stale
      ? t("目录来自{0}快取，等待背景刷新。", "guide.models.cached", models.cache_source || "磁盘")
      : t("上游目录已完成首次刷新且有可暴露模型。", "guide.models.ready");
  const checks = [
    [t("登录管理端", "guide.step.login"), t("当前 Session 已通过服务端验证。", "guide.step.login.desc"), true],
    [
      t("配置本地 Key", "guide.step.serverkey"),
      t("客户端使用 Server Key 访问 Gateway。", "guide.step.serverkey.desc"),
      (config.server_keys || []).length > 0,
    ],
    [
      t("选择上游通道", "guide.step.upstream"),
      t("至少有 Zen / Go Key，或启用匿名通道。", "guide.step.upstream.desc"),
      (config.zen_keys || []).length + (config.go_keys || []).length > 0 || config.anonymous,
    ],
    [
      t("检查 Proxy", "guide.step.proxy"),
      t("至少一个代理节点健康。", "guide.step.proxy.desc"),
      (resources.proxies || []).some((proxy) => proxy.healthy),
    ],
    [t("等待模型目录", "guide.step.models"), modelDescription, models.exposed > 0 && !!models.updated_at],
    [
      t("复制接入示例", "guide.step.access"),
      t("进入接入手册，替换模型与 YOUR_API_KEY。", "guide.step.access.desc"),
      true,
    ],
  ];
  const host = $("#guide-steps");
  host.replaceChildren();
  checks.forEach(([title, description, done]) => {
    const node = document.createElement("article"),
      heading = document.createElement("h3"),
      copy = document.createElement("p"),
      state = document.createElement("div");
    node.className = "guide-step";
    heading.textContent = title;
    copy.textContent = description;
    state.className = `step-state ${done ? "ok" : "warn"}`;
    state.textContent = done ? t("✓ 已就绪", "guide.done") : t("○ 待处理", "guide.todo");
    node.append(heading, copy, state);
    host.appendChild(node);
  });
}
const formatTokens = (value) => Number(value || 0).toLocaleString();
function renderUsage() {
  if (!monitorData) return;
  const usage = monitorData.usage?.last_hour || {},
    tokens = usage.tokens || {};
  $("#u-coverage").textContent = `${((usage.coverage || 0) * 100).toFixed(1)}%`;
  $("#u-total").textContent = formatTokens(tokens.total_tokens);
  $("#u-cached").textContent = formatTokens(tokens.cached_tokens);
  $("#u-reasoning").textContent = formatTokens(tokens.reasoning_tokens);
  const trend = $("#usage-trend"),
    series = monitorData.metrics?.series || [],
    maximum = Math.max(1, ...series.map((point) => point.total_tokens || 0));
  trend.replaceChildren();
  series.forEach((point) => {
    const bar = document.createElement("div");
    bar.className = "trend-bar";
    bar.style.height = `${Math.max(2, Math.round(((point.total_tokens || 0) / maximum) * 100))}%`;
    bar.title = `${new Date(point.minute).toLocaleTimeString()} · input ${formatTokens(point.input_tokens)} · output ${formatTokens(point.output_tokens)} · total ${formatTokens(point.total_tokens)}`;
    trend.appendChild(bar);
  });
  const models = $("#usage-models");
  models.replaceChildren();
  Object.entries(usage.models || {})
    .sort((a, b) => (b[1].total_tokens || 0) - (a[1].total_tokens || 0))
    .slice(0, 15)
    .forEach(([model, value]) => {
      const row = document.createElement("tr");
      appendCell(row, model);
      appendCell(row, formatTokens(value.input_tokens));
      appendCell(row, formatTokens(value.output_tokens));
      appendCell(row, formatTokens(value.total_tokens));
      models.appendChild(row);
    });
  if (!models.children.length) emptyRow(models, 4, t("尚无 Token 用量", "usage.empty.models"));
  const tiers = $("#usage-tiers"),
    tierEntries = Object.entries(usage.tiers || {}).sort(
      (a, b) => (b[1].total_tokens || 0) - (a[1].total_tokens || 0),
    ),
    tierTotal = Math.max(1, ...tierEntries.map(([, value]) => value.total_tokens || 0));
  tiers.replaceChildren();
  tierEntries.forEach(([tier, value]) => {
    const row = document.createElement("div"),
      name = document.createElement("strong"),
      track = document.createElement("div"),
      fill = document.createElement("div"),
      amount = document.createElement("span");
    row.className = "tier-row";
    name.textContent = tier;
    track.className = "tier-track";
    fill.className = "tier-fill";
    fill.style.width = `${Math.round(((value.total_tokens || 0) / tierTotal) * 100)}%`;
    amount.className = "mono";
    amount.textContent = formatTokens(value.total_tokens);
    track.appendChild(fill);
    row.append(name, track, amount);
    tiers.appendChild(row);
  });
  if (!tierEntries.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = t("尚无 Tier 用量", "usage.empty.tiers");
    tiers.appendChild(empty);
  }
}
function renderFacts(selector, entries) {
  const host = $(selector);
  host.replaceChildren();
  entries.forEach(([label, value, tone]) => {
    const fact = document.createElement("dl"),
      term = document.createElement("dt"),
      detail = document.createElement("dd");
    fact.className = "fact";
    term.textContent = label;
    detail.textContent = value ?? "—";
    if (tone) detail.className = tone;
    fact.append(term, detail);
    host.appendChild(fact);
  });
}
function renderPlayKeys() {
  const select = $("#play-key");
  if (!select) return;
  const selected = select.value;
  select.replaceChildren();
  const auto = document.createElement("option");
  auto.value = "auto";
  auto.textContent = t("自动路由（匿名 / Tier 回退 / Key 轮询）", "playground.key.auto");
  select.appendChild(auto);
  const keys = debugData?.keys || {};
  [
    ["zen", "Zen Keys"],
    ["go", "Go Keys"],
  ].forEach(([tier, label]) => {
    const items = keys[tier] || [];
    if (!items.length) return;
    const group = document.createElement("optgroup");
    group.label = label;
    items.forEach((item) => {
      const option = document.createElement("option");
      option.value = `${tier}:${item.id}`;
      const cooling = item.cooldown_until
        ? t(
            ` · 冷却至 ${new Date(item.cooldown_until).toLocaleTimeString()}`,
            "playground.key.cooling",
            new Date(item.cooldown_until).toLocaleTimeString(),
          )
        : "";
      option.textContent = `${tier.toUpperCase()} · ${item.display} · ${item.id}${cooling}`;
      group.appendChild(option);
    });
    select.appendChild(group);
  });
  if (selected && [...select.options].some((option) => option.value === selected))
    select.value = selected;
  else select.value = "auto";
}
async function loadDebugModels() {
  try {
    debugData = await api("/api/debug/models");
    if (debugData.last_inference) lastPlayground = debugData.last_inference;
    const select = $("#play-model"),
      selected = select.value;
    select.replaceChildren();
    (debugData.models || []).forEach((item) => {
      const option = document.createElement("option");
      option.value = item.model;
      option.textContent = item.model;
      select.appendChild(option);
    });
    if (selected && [...select.options].some((option) => option.value === selected))
      select.value = selected;
    renderPlayKeys();
    if (!$("#play-request").value.trim()) resetPlayTemplate();
    renderDiagnostics();
  } catch (error) {
    toast(error.message, true);
  }
}
function playgroundTemplate() {
  const protocol = $("#play-protocol").value,
    model = $("#play-model").value || "YOUR_MODEL",
    prompt = t("用一句话说明这个模型的能力。", "playground.samplePrompt");
  if (protocol === "responses") return { model, input: prompt };
  if (protocol === "anthropic")
    return {
      model,
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    };
  return { model, messages: [{ role: "user", content: prompt }] };
}
function resetPlayTemplate() {
  $("#play-request").value = JSON.stringify(playgroundTemplate(), null, 2);
}
$("#play-protocol").addEventListener("change", resetPlayTemplate);
$("#play-model").addEventListener("change", () => {
  try {
    const request = JSON.parse($("#play-request").value);
    request.model = $("#play-model").value;
    $("#play-request").value = JSON.stringify(request, null, 2);
  } catch (_) {
    resetPlayTemplate();
  }
});
$("#play-reset").onclick = resetPlayTemplate;
function displayPlayground(result) {
  lastPlayground = result;
  const keyTest = result.key_test
    ? {
        usable: t("Key 可用", "play.key.usable"),
        rejected: t("Key 被拒绝", "play.key.rejected"),
        rate_limited: t("Key 已被接受但受到限流", "play.key.rateLimited"),
        upstream_error: t("上游异常，无法判定 Key", "play.key.upstreamError"),
        transport_error: t("网络或代理异常，无法判定 Key", "play.key.transportError"),
        unavailable: t("Key 或运行时不可用", "play.key.unavailable"),
        request_error: t("请求未成功", "play.key.requestError"),
      }[result.key_test] || result.key_test
    : "";
  $("#play-state").textContent = result.ok
    ? t(`请求成功 · HTTP {0}`, "play.state.ok", result.http_status)
    : t(`请求失败 · HTTP {0}`, "play.state.failed", result.http_status);
  $("#play-state").className = `section-caption ${result.ok ? "ok" : "bad"}`;
  const route = result.route || {},
    eligibility = route.anonymous_eligibility || {},
    selected = result.selected_key,
    routeLabel = route.tier
      ? `${route.tier} / ${route.anonymous ? "anonymous" : route.key_id || "key"}`
      : t("未路由", "play.route.none");
  renderFacts("#play-facts", [
    [t("HTTP 状态", "play.httpStatus"), result.http_status, result.ok ? "ok" : "bad"],
    [t("耗时", "common.duration"), `${result.duration_ms} ms`],
    ["Request ID", result.request_id || "—"],
    [
      t("测试模式", "play.mode"),
      selected
        ? t(`指定 ${selected.tier.toUpperCase()} Key`, "play.mode.selected", selected.tier.toUpperCase())
        : t("自动路由", "play.mode.auto"),
    ],
    [t("测试 Key", "play.testedKey"), selected ? `${selected.display} · ${selected.id}` : "—"],
    [
      t("Key 判断", "play.keyVerdict"),
      keyTest || t("自动路由未单独判定", "play.keyVerdict.none"),
      result.key_test === "usable" ? "ok" : result.key_test ? "bad" : "",
    ],
    [t("实际路由", "play.actualRoute"), routeLabel],
    [t("原生协议", "play.nativeProtocol"), route.native_protocol || "—"],
    [
      t("匿名判断", "play.anonymousVerdict"),
      t(
        `${eligibility.allowed ? "允许" : "拒绝"} · ${eligibility.source || "—"}`,
        eligibility.allowed ? "play.eligibility.allowed" : "play.eligibility.denied",
        eligibility.source || "—",
      ),
      eligibility.allowed ? "ok" : "warn",
    ],
  ]);
  $("#play-output").textContent = JSON.stringify(result.response, null, 2);
  renderDiagnostics();
}
$("#play-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  let request;
  try {
    request = JSON.parse($("#play-request").value);
  } catch (error) {
    toast(t(`请求 JSON 无效：${error.message}`, "toast.play.invalidJson", error.message), true);
    return;
  }
  const keyValue = $("#play-key").value,
    key =
      keyValue === "auto"
        ? { mode: "auto" }
        : {
            mode: "selected",
            tier: keyValue.split(":")[0],
            id: keyValue.split(":").slice(1).join(":"),
          };
  $("#play-run").disabled = true;
  $("#play-state").textContent =
    key.mode === "selected"
      ? t("指定 Key 测试进行中…", "play.state.testingKey")
      : t("Gateway 请求进行中…", "play.state.running");
  try {
    const result = await api("/api/debug/inference", {
      method: "POST",
      body: JSON.stringify({ protocol: $("#play-protocol").value, key, request }),
    });
    displayPlayground(result);
  } catch (error) {
    toast(error.message, true);
    $("#play-state").textContent = t("诊断入口请求失败", "play.state.failedToCall");
  } finally {
    $("#play-run").disabled = false;
  }
});
$("#play-copy").onclick = async () => {
  try {
    await navigator.clipboard.writeText($("#play-output").textContent);
    toast(t("原始响应已复制", "toast.play.copied"));
  } catch (_) {
    toast(t("浏览器不允许剪贴板访问", "common.clipboard"), true);
  }
};
function renderDiagnostics() {
  if (!monitorData && !debugData) return;
  const metadata = debugData?.metadata || monitorData?.resources?.metadata || {},
    last = lastPlayground || debugData?.last_inference;
  renderFacts("#metadata-facts", [
    [t("就绪", "diag.ready"), metadata.ready ? t("是", "common.yes") : t("否", "common.no"), metadata.ready ? "ok" : "warn"],
    [t("模型数", "diag.modelCount"), formatTokens(metadata.models)],
    [
      t("更新时间", "diag.updatedAt"),
      metadata.updated_at
        ? new Date(metadata.updated_at).toLocaleString()
        : t("尚未更新", "diag.notUpdated"),
    ],
    [
      t("是否过期", "diag.stale"),
      metadata.stale ? t("是", "common.yes") : t("否", "common.no"),
      metadata.stale ? "warn" : "ok",
    ],
    [
      t("下次刷新", "diag.nextRefresh"),
      metadata.next_refresh
        ? new Date(metadata.next_refresh).toLocaleString()
        : "—",
    ],
    [
      t("最近错误", "diag.lastError"),
      metadata.last_error || t("无", "common.none"),
      metadata.last_error ? "bad" : "ok",
    ],
  ]);
  renderFacts(
    "#last-playground",
    last
      ? [
          [
            t("结果", "diag.result"),
            last.ok ? t("成功", "diag.ok") : t("失败", "diag.failed"),
            last.ok ? "ok" : "bad",
          ],
          ["HTTP", last.http_status],
          [t("耗时", "common.duration"), `${last.duration_ms} ms`],
          ["Request ID", last.request_id || "—"],
          [t("模型", "common.model"), last.route?.model || "—"],
          [
            t("路由", "diag.route"),
            last.route?.tier
              ? `${last.route.tier} / ${last.route.anonymous ? "anonymous" : last.route.key_id || "key"}`
              : t("未路由", "play.route.none"),
          ],
        ]
      : [[t("状态", "diag.state"), t("尚无 Playground 追踪", "diag.noTrace")]],
  );
  renderDiagnosticModels();
  const requests = $("#upstream-requests");
  requests.replaceChildren();
  (monitorData?.upstream?.requests || [])
    .slice(-100)
    .reverse()
    .forEach((request) => {
      const row = document.createElement("tr");
      appendCell(row, new Date(request.time).toLocaleTimeString());
      appendCell(row, request.request_id);
      appendCell(row, request.model);
      appendCell(row, request.tier || "—");
      appendCell(row, request.channel);
      appendCell(row, request.key_id || "—");
      appendCell(row, request.attempts);
      const terminalResults = {
        stream_error: t("流式响应失败", "diag.streamError"),
        client_canceled: t("客户端已取消", "diag.clientCanceled"),
      };
      const result = terminalResults[request.outcome]
        ? `HTTP ${request.status} · ${terminalResults[request.outcome]}`
        : request.status || request.outcome;
      appendCell(row, result, request.success ? "ok" : "bad");
      appendCell(row, `${request.duration_ms} ms`);
      requests.appendChild(row);
    });
  if (!requests.children.length) emptyRow(requests, 9, t("尚无请求路由", "diag.noRequests"));
  const attempts = $("#upstream-attempts");
  attempts.replaceChildren();
  (monitorData?.upstream?.recent || [])
    .slice(-100)
    .reverse()
    .forEach((attempt) => {
      const row = document.createElement("tr");
      appendCell(row, new Date(attempt.time).toLocaleTimeString());
      appendCell(row, attempt.request_id);
      appendCell(row, attempt.model);
      appendCell(row, `${attempt.tier} / ${attempt.channel}`);
      appendCell(row, attempt.key_id);
      appendCell(row, attempt.proxy_node);
      appendCell(row, attempt.status || attempt.outcome, attempt.success ? "ok" : "bad");
      appendCell(row, `${attempt.duration_ms} ms`);
      attempts.appendChild(row);
    });
  if (!attempts.children.length) emptyRow(attempts, 8, t("尚无上游尝试", "diag.noAttempts"));
}
function renderDiagnosticModels() {
  const host = $("#diagnostic-models");
  if (!host || !debugData) return;
  const query = $("#diagnostic-model-search").value.trim().toLowerCase();
  host.replaceChildren();
  (debugData.models || [])
    .filter((item) => !query || item.model.toLowerCase().includes(query))
    .forEach((item) => {
      const eligibility = item.anonymous_eligibility || {},
        row = document.createElement("tr"),
        input = eligibility.input_cost,
        output = eligibility.output_cost,
        plan = [...(item.anonymous ? ["anonymous"] : []), ...(item.key_tiers || [])];
      appendCell(row, item.model);
      appendCell(row, `${item.native_protocol} · ${item.protocol_source}`);
appendCell(
        row,
        item.route_error || (plan.length ? plan.join(" → ") : "—"),
        item.route_error ? "bad" : "",
      );
      appendCell(
        row,
        eligibility.allowed ? t("允许", "common.allowed") : t("拒绝", "common.denied"),
        eligibility.allowed ? "ok" : "warn",
      );
      appendCell(row, eligibility.source || "—");
      appendCell(row, `${input == null ? "?" : input} / ${output == null ? "?" : output}`, "cost");
      host.appendChild(row);
    });
  if (!host.children.length) emptyRow(host, 6, t("没有匹配模型", "diag.noMatch"));
}
$("#diagnostic-model-search").addEventListener("input", renderDiagnosticModels);
async function refreshMonitor() {
  try {
    monitorData = await api("/api/monitor");
    const metrics = monitorData.metrics;
    $("#version").textContent = `version ${monitorData.version}`;
    $("#m-total").textContent = Number(metrics.last_hour.total || 0).toLocaleString();
    $("#m-rate").textContent = `${((metrics.last_hour.success_rate || 0) * 100).toFixed(1)}%`;
    $("#m-p95").textContent = `${metrics.last_hour.p95_ms || 0} ms`;
    $("#m-active").textContent = `${metrics.active_requests || 0} / ${metrics.active_streams || 0}`;
    renderResources(monitorData.resources);
    renderBreakdowns(metrics);
    renderGuide();
    renderUsage();
    renderDiagnostics();
  } catch (_) {}
}
$("#refresh-now").onclick = async () => {
  await Promise.all([refreshMonitor(), loadConfig(), loadDebugModels()]);
  if (location.hash === "#model-quotas") await loadModelQuotas();
  if (location.hash === "#api-keys") await loadAPIKeys();
  toast(t("状态已刷新", "toast.refreshed"));
};
function derivedAPIBase() {
  if (!config) return `${location.protocol}//${location.hostname}:8080`;
  const listen = config.effective?.listen || config.listen || ":8080";
  const bracket = listen.match(/^\[.*\]:(\d+)$/),
    plain = listen.match(/:(\d+)$/),
    port = (bracket || plain)?.[1] || "8080";
  return `${location.protocol}//${location.hostname}:${port}`;
}
function codeCard(label, text) {
  const card = document.createElement("div"),
    head = document.createElement("div"),
    title = document.createElement("span"),
    copy = document.createElement("button"),
    pre = document.createElement("pre"),
    code = document.createElement("code");
  card.className = "code-card";
  head.className = "code-head";
  title.textContent = label;
  copy.type = "button";
  copy.className = "copy";
  copy.textContent = t("复制", "common.copy");
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast(t("示例已复制", "toast.example.copied"));
    } catch (_) {
      toast(t("浏览器不允许剪贴板访问", "common.clipboard"), true);
    }
  };
  head.append(title, copy);
  code.textContent = text;
  pre.appendChild(code);
  card.append(head, pre);
  return card;
}
function renderAccessExamples() {
  if (!config) return;
  const base = derivedAPIBase(),
    model = $("#access-model")?.value.trim() || "YOUR_MODEL";
  $("#access-base-value").value = base;
  const protocols = $("#access-protocol-examples"),
    sdks = $("#access-sdk-examples");
  protocols.replaceChildren();
  sdks.replaceChildren();
  const chat = `curl ${base}/v1/chat/completions \\\n  -H "Authorization: Bearer YOUR_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"${model}","messages":[{"role":"user","content":"Hello"}]}'`;
  const responses = `curl ${base}/v1/responses \\\n  -H "Authorization: Bearer YOUR_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"${model}","input":"Hello"}'`;
  const anthropic = `curl ${base}/v1/messages \\\n  -H "x-api-key: YOUR_API_KEY" \\\n  -H "anthropic-version: 2023-06-01" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"${model}","max_tokens":512,"messages":[{"role":"user","content":"Hello"}]}'`;
  protocols.append(
    codeCard("Chat Completions", chat),
    codeCard("Responses", responses),
    codeCard("Anthropic Messages", anthropic),
  );
  const python = `from openai import OpenAI\n\nclient = OpenAI(base_url="${base}/v1", api_key="YOUR_API_KEY")\nresponse = client.chat.completions.create(\n    model="${model}",\n    messages=[{"role": "user", "content": "Hello"}],\n)\nprint(response.choices[0].message.content)`;
  const javascript = `import OpenAI from "openai";\n\nconst client = new OpenAI({\n  baseURL: "${base}/v1",\n  apiKey: "YOUR_API_KEY",\n});\nconst response = await client.responses.create({\n  model: "${model}",\n  input: "Hello",\n});\nconsole.log(response.output_text);`;
  sdks.append(
    codeCard("Python · OpenAI SDK", python),
    codeCard("JavaScript · OpenAI SDK", javascript),
  );
}
$("#access-model").addEventListener("input", renderAccessExamples);
$$("[data-scroll]").forEach(
  (button) =>
    (button.onclick = () =>
      document.getElementById(button.dataset.scroll).scrollIntoView({ behavior: "smooth" })),
);
function connectLogs() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource("/api/logs/stream");
  eventSource.addEventListener("log", (event) => {
    const item = JSON.parse(event.data);
    logEvents.push(item);
    if (logEvents.length > 2000) logEvents.shift();
    if (!paused && !logRenderPending) {
      logRenderPending = true;
      requestAnimationFrame(() => {
        logRenderPending = false;
        renderLogs();
      });
    }
  });
  eventSource.addEventListener("gap", () => toast(t("较早日志已从内存清除", "logs.gap"), true));
}
function renderLogs() {
  const level = $("#log-level").value,
    component = $("#log-component").value.toLowerCase(),
    query = $("#log-search").value.toLowerCase(),
    rows = logEvents
      .filter(
        (item) =>
          (!level || item.level === level) &&
          (!component || (item.component || "").toLowerCase().includes(component)) &&
          (!query || JSON.stringify(item).toLowerCase().includes(query)),
      )
      .slice(-500),
    host = $("#log-list");
  host.replaceChildren();
  rows.forEach((item) => {
    const row = document.createElement("div");
    row.className = "log";
    const timeNode = document.createElement("span"),
      levelNode = document.createElement("span"),
      componentNode = document.createElement("span"),
      messageNode = document.createElement("span"),
      fieldsNode = document.createElement("span");
    timeNode.className = "log-time";
    timeNode.textContent = new Date(item.time).toLocaleTimeString();
    levelNode.className =
      item.level === "error"
        ? "bad"
        : item.level === "warn"
          ? "warn"
          : item.level === "info"
            ? "ok"
            : "";
    levelNode.textContent = item.level;
    componentNode.className = "log-component";
    componentNode.textContent = item.component || "core";
    messageNode.textContent = item.message;
    fieldsNode.className = "log-fields";
    fieldsNode.textContent = JSON.stringify(item.fields || {});
    row.append(timeNode, levelNode, componentNode, messageNode, fieldsNode);
    host.appendChild(row);
  });
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = t("等待日志事件…", "logs.waiting");
    host.appendChild(empty);
  }
  host.scrollTop = host.scrollHeight;
}
["#log-level", "#log-component", "#log-search"].forEach((id) =>
  $(id).addEventListener("input", renderLogs),
);
$("#log-pause").onclick = () => {
  paused = !paused;
  $("#log-pause").textContent = paused ? t("继续", "logs.resume") : t("暂停", "logs.pause");
  if (!paused) renderLogs();
};
let quotaData = null,
  quotaTimer = null,
  quotaLoading = false,
  createdKey = "",
  apiKeysLoading = false,
  apiKeysData = null;
const localTime = (value) =>
  value
    ? new Date(value).toLocaleString(window.O2I18N.dateLocale(), { hour12: false })
    : "—";

function clearCreatedKey() {
  createdKey = "";
  $("#api-key-env").textContent = "";
  $("#api-key-created").classList.add("hidden");
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast(t("已复制", "toast.copied"));
  } catch {
    toast(t("浏览器未允许复制，请手动选中复制", "toast.copyDenied"), true);
  }
}

async function loadModelQuotas() {
  if (quotaLoading) return;
  quotaLoading = true;
  $("#quota-refresh").disabled = true;
  $("#quota-refresh").textContent = t("读取中…", "quotas.loading");
  try {
    const value = await api("/api/model-quotas");
    if (!csrf) return;
    quotaData = value;
    const select = $("#quota-account"),
      selected = select.value;
    select.replaceChildren();
    for (const account of value.accounts || []) {
      const option = document.createElement("option");
      option.value = account.id;
      option.textContent = `Go Key ${account.display}`;
      select.appendChild(option);
    }
    if ([...select.options].some((option) => option.value === selected)) select.value = selected;
    if (!select.options.length)
      select.appendChild(new Option(t("尚未配置 Go Key", "quotas.noKey"), ""));
    renderModelQuotas();
  } catch (error) {
    $("#quota-status").textContent = t(
      `查询失败：${error.message}。已有显示仅为上次查询结果。`,
      "quotas.queryFailed",
      error.message,
    );
  } finally {
    quotaLoading = false;
    $("#quota-refresh").disabled = false;
    $("#quota-refresh").textContent = t("刷新额度", "quotas.refresh");
  }
}

function renderModelQuotas() {
  if (!quotaData) return;
  const account = quotaData.accounts.find((item) => item.id === $("#quota-account").value);
  const stale = account?.status === "stale";
  const cards = $("#quota-cards");
  cards.replaceChildren();
  $("#quota-status").textContent = !account
    ? t("请先在配置中心添加 OpenCode Go Key。", "quotas.addKeyFirst")
    : account.error
      ? stale
        ? t("{0}；下方显示上次成功数据，当前额度未知。", "quotas.staleError", account.error)
        : t("{0}；当前额度未知。", "quotas.error", account.error)
      : t("已连接 OpenCode · 共享套餐额度。多个 Key 的额度不相加。", "quotas.connected");
  $("#quota-updated").textContent = account?.fetched_at
    ? t(
        `${stale ? "上次成功查询" : "额度更新时间"}：${localTime(account.fetched_at)} · 缓存 60 秒 · 来源：OpenCode Go /v1/usage`,
        stale ? "quotas.lastSuccess" : "quotas.updated",
        localTime(account.fetched_at),
      )
    : "";
  const windows = [
    ["rolling", t("5 小时窗口", "quotas.window.hour")],
    ["weekly", t("每周窗口", "quotas.window.week")],
    ["monthly", t("每月窗口", "quotas.window.month")],
  ];
  for (const [id, label] of windows) {
    const item = account?.windows?.[id];
    const card = document.createElement("div"),
      heading = document.createElement("h3"),
      value = document.createElement("div"),
      progress = document.createElement("progress"),
      reset = document.createElement("div");
    card.className = `quota-card${item?.remaining_percent < 20 ? " quota-low" : ""}`;
    heading.textContent = label;
    value.className = "quota-value";
    value.textContent = item ? `≈ ${item.remaining_percent}%` : t("未知", "common.unknown");
    progress.max = 100;
    if (item) progress.value = item.remaining_percent;
    else progress.value = 0;
    progress.setAttribute("aria-label", t("{0}剩余额度", "quotas.window.aria", label));
    reset.className = "quota-reset";
    reset.textContent = item
      ? `${stale ? t("历史剩余", "quotas.remainingHistory") : t("剩余", "quotas.remaining")} · ${
          item.status === "rate-limited" ? t("已限额 · ", "quotas.rateLimited") : ""
        }${t("重置于 {0}", "quotas.resetsAt", localTime(item.resets_at))}`
      : t("等待上游额度数据", "quotas.waiting");
    card.append(heading, value, progress, reset);
    cards.appendChild(card);
  }
  const query = $("#quota-model-search").value.trim().toLowerCase();
  const models = quotaData.models.filter((model) => model.id.toLowerCase().includes(query));
  $("#quota-model-count").textContent = `${models.length} / ${quotaData.models.length}`;
  const catalog = quotaData.catalog;
  $("#quota-catalog-status").textContent =
    `${catalog?.stale ? t("模型目录暂未更新，显示缓存 · ", "quotas.catalogStale") : ""}${t(
      `目录更新时间：${localTime(catalog?.updated_at)}`,
      "quotas.catalogUpdated",
      localTime(catalog?.updated_at),
    )}`;
  const host = $("#quota-models");
  host.replaceChildren();
  for (const model of models) {
    const row = document.createElement("tr");
    appendCell(row, model.id, "mono");
    appendCell(
      row,
      { chat: "Chat Completions", responses: "Responses", anthropic: "Messages" }[model.protocol] ||
        model.protocol,
    );
    for (const [id] of windows) {
      const item = account?.windows?.[id];
      appendCell(
        row,
        item ? `≈ ${item.remaining_percent}%${stale ? t("（历史）", "quotas.history") : ""}` : t("未知", "common.unknown"),
      );
    }
    const cell = document.createElement("td"),
      button = document.createElement("button");
    button.className = "ghost";
    button.textContent = t("复制名称", "quotas.copyName");
    button.onclick = () => copyText(model.id);
    cell.appendChild(button);
    row.appendChild(cell);
    host.appendChild(row);
  }
  if (!models.length)
    emptyRow(
      host,
      6,
      quotaData.models.length
        ? t("没有匹配的模型", "diag.noMatch")
        : t("模型目录尚未就绪，请稍后刷新", "quotas.catalogPending"),
    );
}
$("#quota-refresh").onclick = loadModelQuotas;
$("#quota-account").onchange = renderModelQuotas;
$("#quota-model-search").oninput = renderModelQuotas;

async function loadAPIKeys() {
  if (apiKeysLoading) return;
  apiKeysLoading = true;
  $("#api-key-refresh").disabled = true;
  try {
    const data = await api("/api/api-keys");
    if (csrf) {
      apiKeysData = data.keys;
      renderAPIKeys(data.keys);
    }
  } catch (error) {
    $("#api-key-status").textContent = t(`读取失败：${error.message}`, "apikeys.loadFailed", error.message);
  } finally {
    apiKeysLoading = false;
    $("#api-key-refresh").disabled = false;
  }
}

async function mutateAPIKey(id, method, body, button) {
  button.disabled = true;
  try {
    const data = await api(`/api/api-keys/${encodeURIComponent(id)}`, {
      method,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!csrf) return;
    apiKeysData = data.keys;
    renderAPIKeys(data.keys);
    await loadConfig();
    toast(t("已保存并立即生效", "toast.apikeys.saved"));
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

function renderAPIKeys(keys) {
  $("#api-key-count").textContent = t(`${keys.length} 个`, "apikeys.count", keys.length);
  $("#api-key-status").textContent = t(
    `${keys.filter((key) => key.enabled).length} 个已启用`,
    "apikeys.enabledCount",
    keys.filter((key) => key.enabled).length,
  );
  const host = $("#api-key-list");
  host.replaceChildren();
  for (const key of keys) {
    const row = document.createElement("tr");
    appendCell(row, key.name);
    appendCell(row, key.display, "mono");
    appendCell(
      row,
      key.enabled ? t("已启用", "state.enabled") : t("已停用", "state.disabled"),
      key.enabled ? "status ok" : "status warn",
    );
    const usage = key.usage || {},
      summary = (value = {}) =>
        `${formatTokens(value.requests)} ${t("次", "apikeys.times")} · ${formatTokens(value.total_tokens)} tokens`;
    appendCell(row, `${summary(usage.last_hour)} / ${summary(usage.lifetime)}`);
    appendCell(
      row,
      key.created_at ? localTime(key.created_at) : t("已有配置", "apikeys.col.legacy"),
    );
    const cell = document.createElement("td"),
      actions = document.createElement("div");
    actions.className = "key-actions";
    for (const [label, action] of [
      [
        t("重命名", "apikeys.rename"),
        (button) => {
          const name = prompt(t("密钥名称", "apikeys.namePrompt"), key.name);
          if (name !== null) mutateAPIKey(key.id, "PATCH", { name }, button);
        },
      ],
      [
        key.enabled ? t("停用", "apikeys.disable") : t("启用", "apikeys.enable"),
        (button) => mutateAPIKey(key.id, "PATCH", { enabled: !key.enabled }, button),
      ],
      [
        t("删除", "apikeys.delete"),
        (button) => {
          if (
            confirm(
              t(
                `删除“${key.name}”后，使用它的应用将无法继续访问。确定删除？`,
                "apikeys.confirmDelete",
                key.name,
              ),
            )
          )
            mutateAPIKey(key.id, "DELETE", null, button);
        },
      ],
    ]) {
      const button = document.createElement("button");
      button.className = "ghost";
      button.textContent = label;
      button.onclick = () => action(button);
      actions.appendChild(button);
    }
    cell.appendChild(actions);
    row.appendChild(cell);
    host.appendChild(row);
  }
  if (!keys.length) emptyRow(host, 6, t("暂无 API Key", "apikeys.empty"));
}
$("#api-key-form").onsubmit = async (event) => {
  event.preventDefault();
  const button = $("#api-key-create");
  button.disabled = true;
  try {
    const data = await api("/api/api-keys", {
      method: "POST",
      body: JSON.stringify({ name: $("#api-key-name").value, value: $("#api-key-value").value }),
    });
    if (!csrf) return;
    createdKey = data.key;
    apiKeysData = data.keys;
    const goModels = debugData?.models?.filter((item) => item.available_go) || [];
    const model =
      goModels.find((item) => item.model === "glm-5.3-flash")?.model ||
      goModels[0]?.model ||
      "YOUR_MODEL";
    $("#api-key-env").textContent =
      `OPENAI_API_KEY=${data.key}\nOPENAI_BASE_URL=${derivedAPIBase()}/v1\nOPENAI_MODEL=${model}`;
    $("#api-key-created").classList.remove("hidden");
    $("#api-key-form").reset();
    renderAPIKeys(data.keys);
    await loadConfig();
    toast(t("API Key 已创建", "toast.apikeys.created"));
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
};
$("#api-key-refresh").onclick = loadAPIKeys;
$("#api-key-dismiss").onclick = clearCreatedKey;
$("#api-key-copy").onclick = () => copyText(createdKey);
$("#api-key-copy-env").onclick = () => copyText($("#api-key-env").textContent);
let rotationData = null,
  rotationDirty = false;
const rotationReasons = {
  success: t("成功", "rotation.reason.success"),
  client_canceled: t("调用方取消", "rotation.reason.clientCanceled"),
  quota_or_rate_limit: t("额度不足 / 限流", "rotation.reason.quota"),
  transport_error: t("连接错误", "rotation.reason.transport"),
  first_output_timeout: t("首个输出超时", "rotation.reason.firstOutputTimeout"),
  stream_error: t("输出中断", "rotation.reason.streamError"),
  response_read_error: t("读取响应失败", "rotation.reason.readError"),
  response_conversion_error: t("响应解析或转换失败", "rotation.reason.conversionError"),
  request_conversion_error: t("请求转换失败", "rotation.reason.requestConversion"),
  upstream_error: t("上游错误", "rotation.reason.upstreamError"),
};
async function loadRotation() {
  try {
    const value = await api("/api/rotation");
    if (!csrf) return;
    rotationData = value;
    rotationDirty = false;
    renderRotation();
  } catch (error) {
    toast(error.message, true);
  }
}
function renderRotation() {
  const state = rotationData;
  $("#rotation-status").textContent =
    state.persistence_error ||
    t("状态已更新 · 两组独立轮转，所有调用方共享当前位置。", "rotation.status");
  $("#rotation-timeout").value = state.first_output_seconds;
  const host = $("#rotation-groups");
  host.replaceChildren();
  for (const group of state.groups) {
    const section = document.createElement("div");
    section.className = "section";
    const title = document.createElement("h2");
    title.textContent = group.id === "sota" ? "SOTA" : t("甜点", "rotation.sweet");
    const label = document.createElement("label");
    label.textContent = t("调用别名", "rotation.aliasLabel");
    label.htmlFor = `rotation-alias-${group.id}`;
    const input = document.createElement("input");
    input.id = label.htmlFor;
    input.value = group.alias;
    input.required = true;
    input.maxLength = 64;
    input.oninput = () => {
      group.alias = input.value;
      rotationDirty = true;
    };
    const field = document.createElement("div");
    field.className = "field";
    field.append(label, input);
    const current = document.createElement("p");
    current.className = "mono";
    current.textContent = t(
      `当前模型：${group.current || "等待可用模型"}`,
      "rotation.current",
      group.current || t("等待可用模型", "rotation.waitingModel"),
    );
    const table = document.createElement("table");
    table.className = "table";
    const header = document.createElement("tr");
    for (const text of [
      t("顺序", "rotation.col.order"),
      t("模型", "common.model"),
      t("状态 / 恢复时间", "rotation.col.state"),
      t("操作", "common.action"),
    ]) {
      const th = document.createElement("th");
      th.textContent = text;
      header.append(th);
    }
    const thead = document.createElement("thead");
    thead.append(header);
    table.append(thead);
    const tbody = document.createElement("tbody");
    table.append(tbody);
    group.order.forEach((model, index) => {
      const row = document.createElement("tr");
      appendCell(row, String(index + 1));
      appendCell(row, model, "mono");
      const until = group.paused[model],
        paused = until && new Date(until) > new Date();
      appendCell(
        row,
        !group.available[model]
          ? t("已下架 / 暂不可用", "rotation.unavailable")
          : paused
            ? t(`暂停至 ${localTime(until)}`, "rotation.pausedUntil", localTime(until))
            : model === group.current
              ? t("当前使用", "rotation.inUse")
              : t("可用", "state.available"),
      );
      const actions = document.createElement("td");
      actions.className = "rotation-actions";
      for (const [text, delta] of [
        [t("上移", "rotation.moveUp"), -1],
        [t("下移", "rotation.moveDown"), 1],
      ]) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "ghost";
        button.textContent = text;
        button.setAttribute("aria-label", `${model} ${text}`);
        button.disabled = index + delta < 0 || index + delta >= group.order.length;
        button.onclick = () => {
          [group.order[index], group.order[index + delta]] = [
            group.order[index + delta],
            group.order[index],
          ];
          state.first_output_seconds = Number($("#rotation-timeout").value);
          rotationDirty = true;
          renderRotation();
        };
        actions.append(button);
      }
      const select = document.createElement("button");
      select.type = "button";
      select.className = "ghost";
      select.textContent = t("设为当前", "rotation.setCurrent");
      select.disabled = !group.available[model];
      select.setAttribute("aria-label", t(`使用 ${model}`, "rotation.useModel", model));
      select.onclick = async () => {
        select.disabled = true;
        try {
          const result = await api("/api/rotation/current", {
            method: "POST",
            body: JSON.stringify({ group: group.id, model }),
          });
          // Keep unsaved alias/order edits while refreshing operational state.
          for (const item of state.groups) {
            const live = result.groups.find((x) => x.id === item.id);
            Object.assign(item, {
              current: live.current,
              paused: live.paused,
              switches: live.switches,
            });
          }
          state.persistence_error = result.persistence_error;
          renderRotation();
          toast(t("当前模型已切换", "toast.rotation.switched"));
        } catch (error) {
          select.disabled = false;
          toast(error.message, true);
        }
      };
      actions.append(select);
      row.append(actions);
      tbody.append(row);
    });
    if (!group.order.length) emptyRow(tbody, 4, t("等待 Go 模型目录", "rotation.waitingCatalog"));
    const wrap = document.createElement("div");
    wrap.className = "table-wrap";
    wrap.append(table);
    const recent = document.createElement("div");
    recent.className = "rotation-switches";
    const caption = document.createElement("h3");
    caption.textContent = t("最近切换", "rotation.recentSwitches");
    recent.append(caption);
    for (const item of (group.switches || []).slice(-5).reverse()) {
      const line = document.createElement("p");
      line.textContent = `${localTime(item.time)} · ${item.from} → ${item.to} · ${rotationReasons[item.reason] || item.reason}`;
      recent.append(line);
    }
    if (!group.switches?.length) {
      const line = document.createElement("p");
      line.textContent = t("尚无切换记录", "rotation.noSwitches");
      recent.append(line);
    }
    section.append(title, field, current, wrap, recent);
    host.append(section);
  }
  const attempts = $("#rotation-attempts");
  attempts.replaceChildren();
  for (const item of (state.attempts || []).slice().reverse()) {
    const row = document.createElement("tr");
    for (const value of [
      localTime(item.time),
      item.request,
      item.alias,
      item.model,
      String(item.number),
      rotationReasons[item.outcome] || item.outcome,
    ])
      appendCell(row, value);
    attempts.append(row);
  }
  if (!state.attempts?.length)
    emptyRow(attempts, 6, t("调用分组别名后显示最近 100 次尝试", "rotation.attemptsEmpty"));
}
$("#rotation-refresh").onclick = () => {
  if (rotationDirty) {
    toast(t("有未保存的修改，请先保存后刷新", "toast.rotation.dirty"), true);
    return;
  }
  loadRotation();
};
$("#rotation-timeout").oninput = () => {
  rotationDirty = true;
};
$("#rotation-form").onsubmit = async (event) => {
  event.preventDefault();
  if (!rotationData) return;
  const button = $("#rotation-save");
  button.disabled = true;
  try {
    const body = { first_output_seconds: Number($("#rotation-timeout").value) };
    for (const group of rotationData.groups)
      body[group.id] = { alias: group.alias.trim(), order: group.order };
    rotationData = await api("/api/rotation", { method: "PUT", body: JSON.stringify(body) });
    rotationDirty = false;
    renderRotation();
    toast(t("模型轮转配置已保存并生效", "toast.rotation.saved"));
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
};
boot();

let availabilityData = null;

async function loadAvailability() {
  try {
    availabilityData = await api("/api/models/availability");
    renderAvailability();
  } catch (error) {
    $("#availability-error").textContent = error.message;
  }
}

function renderAvailability() {
  const data = availabilityData;
  if (!data) return;
  $("#availability-error").textContent = "";
  $("#availability-models").replaceChildren();
  for (const item of data.models) {
    const row = document.createElement("tr");
    const date = (value) =>
      value && !value.startsWith("0001-")
        ? new Date(value).toLocaleString()
        : t("待探测", "availability.pending");
    for (const value of [
      item.model,
      item.disabled ? t("已禁用", "state.disabled") : t("已启用", "state.enabled"),
      [item.channel, item.reason].filter(Boolean).join(" / ") || t("待探测", "availability.pending"),
      item.manual ? t("手动", "availability.manual") : t("自动", "availability.auto"),
      item.auto_effort?.effort
        ? `${item.auto_effort.effort}（${date(item.effort_checked_at)}）`
        : t("未验证", "availability.unverified"),
      date(item.checked_at),
      item.manual
        ? t("手动控制，不自动探测", "availability.manualControl")
        : date(item.next_check),
    ]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    const cell = document.createElement("td");
    const button = document.createElement("button");
    button.textContent = t("恢复启用", "availability.restore");
    button.disabled = !item.disabled;
    button.onclick = async () => {
      button.disabled = true;
      toggle.disabled = true;
      try {
        await api("/api/models/restore", {
          method: "POST",
          body: JSON.stringify({ model: item.model }),
        });
        await loadAvailability();
        await loadDebugModels();
      } catch (error) {
        $("#availability-error").textContent = error.message;
        button.disabled = !item.disabled;
        toggle.disabled = false;
      }
    };
    cell.append(button);
    const toggle = document.createElement("button");
    toggle.className = "ghost";
    toggle.textContent = item.manual
      ? t("切回自动", "availability.switchAuto")
      : t("切为手动", "availability.switchManual");
    toggle.onclick = async () => {
      button.disabled = true;
      toggle.disabled = true;
      try {
        await api("/api/models/manual", {
          method: "POST",
          body: JSON.stringify({ model: item.model, manual: !item.manual }),
        });
        await loadAvailability();
        await loadDebugModels();
      } catch (error) {
        $("#availability-error").textContent = error.message;
        button.disabled = !item.disabled;
        toggle.disabled = false;
      }
    };
    cell.append(toggle);
    row.append(cell);
    $("#availability-models").append(row);
  }
  if (!data.models.length)
    $("#availability-error").textContent = t(
      "当前模型目录中没有符合免费资格的模型。",
      "availability.noneEligible",
    );
}
$("#availability-refresh").onclick = loadAvailability;

// Re-render the text produced by JavaScript after the interface language changes.
// Static markup is already handled by O2I18N.apply() through the data-i18n hooks.
window.O2I18N.onChange(() => {
  const page = location.hash.slice(1) || "overview";
  if (pages[page]) renderPageHeader(page);
  $("#log-pause").textContent = paused ? t("继续", "logs.resume") : t("暂停", "logs.pause");
  if (!$("#quota-refresh").disabled) $("#quota-refresh").textContent = t("刷新额度", "quotas.refresh");
  if (monitorData) {
    renderResources(monitorData.resources);
    renderBreakdowns(monitorData.metrics);
  }
  if (config) renderRestartNotice(config);
  renderGuide();
  renderUsage();
  if (lastPlayground) displayPlayground(lastPlayground);
  renderDiagnostics();
  renderLogs();
  renderAccessExamples();
  renderPlayKeys();
  if (quotaData) renderModelQuotas();
  if (apiKeysData) renderAPIKeys(apiKeysData);
  if (rotationData) renderRotation();
  renderAvailability();
  // Chip removal buttons carry a tooltip; keep it without rebuilding the list,
  // so pending unsaved removals survive a language switch.
  $$(".chips .chip button").forEach((button) => (button.title = t("移除", "common.remove")));
});
