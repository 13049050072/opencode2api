// Page: 模型轮转 — sota/sweet alias groups, ordering, manual switch and attempts.
import { api, hasSession } from "../api.js";
import { $, el, emptyRow, localTime, toast } from "../ui.js";

const reasons = {
  success: "成功",
  client_canceled: "调用方取消",
  quota_or_rate_limit: "额度不足 / 限流",
  transport_error: "连接错误",
  first_output_timeout: "首个输出超时",
  stream_error: "输出中断",
  response_read_error: "读取响应失败",
  response_conversion_error: "响应解析或转换失败",
  request_conversion_error: "请求转换失败",
  upstream_error: "上游错误",
};

let data = null;
let dirty = false;

// The persisted rotation state serializes nil maps and slices as JSON null;
// normalize them before anything renders against them.
function normalize(value) {
  for (const group of value.groups || []) {
    group.order = group.order || [];
    group.available = group.available || {};
    group.paused = group.paused || {};
    group.switches = group.switches || [];
  }
  value.attempts = value.attempts || [];
  return value;
}

async function load() {
  try {
    const value = await api("/api/rotation");
    if (!hasSession()) return;
    data = normalize(value);
    dirty = false;
    render();
  } catch (error) {
    toast(error.message, true);
  }
}

function renderGroup(group) {
  const aliasInput = el("input", {
    id: `rotation-alias-${group.id}`,
    value: group.alias,
    required: true,
    maxlength: 64,
  });
  aliasInput.addEventListener("input", () => {
    group.alias = aliasInput.value;
    dirty = true;
  });
  const table = el("table", { class: "table" }, [
    el("thead", {}, [
      el("tr", {}, ["顺序", "模型", "状态 / 恢复时间", "操作"].map((text) => el("th", { text }))),
    ]),
  ]);
  const body = el("tbody");
  table.append(body);
  group.order.forEach((model, index) => {
    const row = el("tr", {}, [
      el("td", { class: "num", text: String(index + 1) }),
      el("td", { class: "mono", text: model }),
    ]);
    const until = group.paused[model];
    const paused = until && new Date(until) > new Date();
    row.append(
      el("td", {
        text: !group.available[model]
          ? "已下架 / 暂不可用"
          : paused
            ? `暂停至 ${localTime(until)}`
            : model === group.current
              ? "当前使用"
              : "可用",
      }),
    );
    const actions = el("div", { class: "rotation-actions" });
    for (const [text, delta] of [
      ["上移", -1],
      ["下移", 1],
    ]) {
      const button = el("button", {
        type: "button",
        class: "btn btn-sm btn-ghost",
        text,
        "aria-label": `${model} ${text}`,
        disabled: index + delta < 0 || index + delta >= group.order.length,
      });
      button.addEventListener("click", () => {
        [group.order[index], group.order[index + delta]] = [
          group.order[index + delta],
          group.order[index],
        ];
        data.first_output_seconds = Number($("#rotation-timeout").value);
        dirty = true;
        render();
      });
      actions.append(button);
    }
    const select = el("button", {
      type: "button",
      class: "btn btn-sm btn-ghost",
      text: "设为当前",
      "aria-label": `使用 ${model}`,
      disabled: !group.available[model],
    });
    select.addEventListener("click", async () => {
      select.disabled = true;
      try {
        const result = normalize(
          await api("/api/rotation/current", {
            method: "POST",
            body: JSON.stringify({ group: group.id, model }),
          }),
        );
        // Keep unsaved alias/order edits while refreshing operational state.
        for (const item of data.groups) {
          const live = result.groups.find((entry) => entry.id === item.id);
          Object.assign(item, { current: live.current, paused: live.paused, switches: live.switches });
        }
        data.persistence_error = result.persistence_error;
        render();
        toast("当前模型已切换");
      } catch (error) {
        select.disabled = false;
        toast(error.message, true);
      }
    });
    actions.append(select);
    row.append(el("td", {}, [actions]));
    body.append(row);
  });
  if (!group.order.length) emptyRow(body, 4, "等待 Go 模型目录");
  const recent = el("div", { class: "rotation-switches" }, [el("h3", { text: "最近切换" })]);
  for (const item of (group.switches || []).slice(-5).reverse()) {
    recent.append(
      el("p", {
        text: `${localTime(item.time)} · ${item.from} → ${item.to} · ${reasons[item.reason] || item.reason}`,
      }),
    );
  }
  if (!group.switches?.length) recent.append(el("p", { text: "尚无切换记录" }));
  return el("section", { class: "section rotation-group" }, [
    el("h2", { class: "section-title", text: group.id === "sota" ? "SOTA" : "甜点" }),
    el("div", { class: "field" }, [
      el("label", { for: `rotation-alias-${group.id}`, text: "调用别名" }),
      aliasInput,
    ]),
    el("p", {
      class: "rotation-current",
      text: `当前模型：${group.current || "等待可用模型"}`,
    }),
    el("div", { class: "table-wrap" }, [table]),
    recent,
  ]);
}

function render() {
  $("#rotation-status").textContent =
    data.persistence_error || "状态已更新 · 两组独立轮转，所有调用方共享当前位置。";
  $("#rotation-timeout").value = data.first_output_seconds;
  const host = $("#rotation-groups");
  host.replaceChildren();
  for (const group of data.groups) host.append(renderGroup(group));
  const attempts = $("#rotation-attempts");
  attempts.replaceChildren();
  for (const item of (data.attempts || []).slice().reverse()) {
    attempts.append(
      el("tr", {}, [
        el("td", { class: "mono", text: localTime(item.time) }),
        el("td", { class: "mono", text: item.request }),
        el("td", { text: item.alias }),
        el("td", { class: "mono", text: item.model }),
        el("td", { class: "num", text: String(item.number) }),
        el("td", { text: reasons[item.outcome] || item.outcome }),
      ]),
    );
  }
  if (!data.attempts?.length) emptyRow(attempts, 6, "调用分组别名后显示最近 100 次尝试");
}

async function save(event) {
  event.preventDefault();
  if (!data) return;
  const button = $("#rotation-save");
  button.disabled = true;
  try {
    const body = { first_output_seconds: Number($("#rotation-timeout").value) };
    for (const group of data.groups) body[group.id] = { alias: group.alias.trim(), order: group.order };
    data = normalize(await api("/api/rotation", { method: "PUT", body: JSON.stringify(body) }));
    dirty = false;
    render();
    toast("模型轮转配置已保存并生效");
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

export default {
  id: "rotation",
  title: "模型轮转",
  sub: "共享当前模型、故障切换与尝试记录。",
  init() {
    $("#rotation-refresh").addEventListener("click", () => {
      if (dirty) {
        toast("有未保存的修改，请先保存后刷新", true);
        return;
      }
      load();
    });
    $("#rotation-timeout").addEventListener("input", () => {
      dirty = true;
    });
    $("#rotation-form").addEventListener("submit", save);
  },
  show: load,
};
