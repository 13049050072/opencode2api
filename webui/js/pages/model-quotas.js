// Page: 模型与额度 — Go quota windows and free model availability.
import { api, hasSession } from "../api.js";
import { loadDebugModels } from "../data.js";
import { $, bindTabs, copyText, el, emptyRow, localTime } from "../ui.js";

const windows = [
  ["rolling", "5 小时窗口"],
  ["weekly", "每周窗口"],
  ["monthly", "每月窗口"],
];

let data = null;
let timer = null;
let loading = false;
let activeTab = "quota";

async function load() {
  if (loading) return;
  loading = true;
  $("#quota-refresh").disabled = true;
  $("#quota-refresh").textContent = "读取中…";
  try {
    const value = await api("/api/model-quotas");
    if (!hasSession()) return;
    data = value;
    const select = $("#quota-account");
    const selected = select.value;
    select.replaceChildren();
    for (const account of value.accounts || []) {
      select.append(el("option", { value: account.id, text: `Go Key ${account.display}` }));
    }
    if ([...select.options].some((option) => option.value === selected)) select.value = selected;
    if (!select.options.length) select.append(el("option", { value: "", text: "尚未配置 Go Key" }));
    render();
  } catch (error) {
    $("#quota-status").textContent = `查询失败：${error.message}。已有显示仅为上次查询结果。`;
  } finally {
    loading = false;
    $("#quota-refresh").disabled = false;
    $("#quota-refresh").textContent = "刷新额度";
  }
}

function render() {
  if (!data) return;
  const account = (data.accounts || []).find((item) => item.id === $("#quota-account").value);
  const stale = account?.status === "stale";
  const cards = $("#quota-cards");
  cards.replaceChildren();
  $("#quota-status").textContent = !account
    ? "请先在配置中心添加 OpenCode Go Key。"
    : account.error
      ? `${account.error}${stale ? "；下方显示上次成功数据，当前额度未知。" : "；当前额度未知。"}`
      : "已连接 OpenCode · 共享套餐额度。多个 Key 的额度不相加。";
  $("#quota-updated").textContent = account?.fetched_at
    ? `${stale ? "上次成功查询" : "额度更新时间"}：${localTime(account.fetched_at)} · 缓存 60 秒 · 来源：OpenCode Go /v1/usage`
    : "";
  for (const [id, label] of windows) {
    const item = account?.windows?.[id];
    const progress = el("progress", { max: 100, "aria-label": `${label}剩余额度` });
    progress.value = item ? item.remaining_percent : 0;
    cards.append(
      el("div", { class: `quota-card${item?.remaining_percent < 20 ? " quota-low" : ""}` }, [
        el("h3", { text: label }),
        el("div", { class: "quota-value", text: item ? `≈ ${item.remaining_percent}%` : "未知" }),
        progress,
        el("div", {
          class: "quota-reset",
          text: item
            ? `${stale ? "历史剩余" : "剩余"} · ${item.status === "rate-limited" ? "已限额 · " : ""}重置于 ${localTime(item.resets_at)}`
            : "等待上游额度数据",
        }),
      ]),
    );
  }
  const query = $("#quota-model-search").value.trim().toLowerCase();
  const allModels = data.models || [];
  const models = allModels.filter((model) => model.id.toLowerCase().includes(query));
  $("#quota-model-count").textContent = `${models.length} / ${allModels.length}`;
  const catalog = data.catalog;
  $("#quota-catalog-status").textContent = `${catalog?.stale ? "模型目录暂未更新，显示缓存 · " : ""}目录更新时间：${localTime(catalog?.updated_at)}`;
  const host = $("#quota-models");
  host.replaceChildren();
  for (const model of models) {
    const copy = el("button", { class: "btn btn-sm btn-ghost", text: "复制名称" });
    copy.addEventListener("click", () => copyText(model.id));
    const row = el("tr", {}, [
      el("td", { class: "mono", text: model.id }),
      el("td", {
        text:
          { chat: "Chat Completions", responses: "Responses", anthropic: "Messages" }[model.protocol] ||
          model.protocol,
      }),
    ]);
    for (const [id] of windows) {
      const item = account?.windows?.[id];
      row.append(
        el("td", {
          class: "num",
          text: item ? `≈ ${item.remaining_percent}%${stale ? "（历史）" : ""}` : "未知",
        }),
      );
    }
    row.append(el("td", {}, [copy]));
    host.append(row);
  }
  if (!models.length)
    emptyRow(host, 6, allModels.length ? "没有匹配的模型" : "模型目录尚未就绪，请稍后刷新");
}

const date = (value) => (value && !value.startsWith("0001-") ? localTime(value) : "待探测");

async function loadAvailability() {
  try {
    const value = await api("/api/models/availability");
    $("#availability-error").textContent = "";
    const host = $("#availability-models");
    host.replaceChildren();
    for (const item of value.models) {
      const restore = el("button", {
        type: "button",
        class: "btn btn-sm btn-ghost",
        text: "恢复启用",
        disabled: !item.disabled,
      });
      const toggle = el("button", {
        type: "button",
        class: "btn btn-sm btn-ghost",
        text: item.manual ? "切回自动" : "切为手动",
      });
      const run = async (path, body) => {
        restore.disabled = true;
        toggle.disabled = true;
        try {
          await api(path, { method: "POST", body: JSON.stringify(body) });
          await loadAvailability();
          await loadDebugModels();
        } catch (error) {
          $("#availability-error").textContent = error.message;
          restore.disabled = !item.disabled;
          toggle.disabled = false;
        }
      };
      restore.addEventListener("click", () => run("/api/models/restore", { model: item.model }));
      toggle.addEventListener("click", () =>
        run("/api/models/manual", { model: item.model, manual: !item.manual }),
      );
      host.append(
        el("tr", {}, [
          el("td", { class: "mono", text: item.model }),
          el("td", { class: item.disabled ? "warn" : "ok", text: item.disabled ? "已禁用" : "已启用" }),
          el("td", { text: [item.channel, item.reason].filter(Boolean).join(" / ") || "待探测" }),
          el("td", { text: item.manual ? "手动" : "自动" }),
          el("td", {
            text: item.auto_effort?.effort
              ? `${item.auto_effort.effort}（${date(item.effort_checked_at)}）`
              : "未验证",
          }),
          el("td", { class: "mono", text: date(item.checked_at) }),
          el("td", {
            class: "mono",
            text: item.manual ? "手动控制，不自动探测" : date(item.next_check),
          }),
          el("td", {}, [el("div", { class: "key-actions" }, [restore, toggle])]),
        ]),
      );
    }
    if (!value.models.length)
      $("#availability-error").textContent = "当前模型目录中没有符合免费资格的模型。";
  } catch (error) {
    $("#availability-error").textContent = error.message;
  }
}

function startPolling() {
  clearInterval(timer);
  timer = setInterval(() => {
    if (!document.hidden) load();
  }, 60000);
}

function stopPolling() {
  clearInterval(timer);
  timer = null;
}

export default {
  id: "model-quotas",
  title: "模型与额度",
  sub: "共享套餐额度与免费模型探测状态。",
  init() {
    bindTabs($("#page-model-quotas"), (id) => {
      activeTab = id;
      if (id === "quota") {
        load();
        startPolling();
      } else {
        stopPolling();
        loadAvailability();
      }
    });
    $("#quota-refresh").addEventListener("click", load);
    $("#quota-account").addEventListener("change", render);
    $("#quota-model-search").addEventListener("input", render);
    $("#availability-refresh").addEventListener("click", loadAvailability);
  },
  show() {
    if (activeTab === "quota") {
      load();
      startPolling();
    } else {
      loadAvailability();
    }
  },
  hide() {
    stopPolling();
  },
  refresh() {
    if (activeTab === "quota") load();
    else loadAvailability();
  },
};
