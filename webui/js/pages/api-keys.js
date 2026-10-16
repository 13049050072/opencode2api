// Page: API Key 管理 — create, rename, enable/disable and delete caller keys.
import { api, derivedAPIBase, hasSession } from "../api.js";
import { loadConfig } from "../data.js";
import * as store from "../store.js";
import { $, el, emptyRow, formatNumber, localTime, confirmDialog, copyText, promptDialog, toast } from "../ui.js";

let keysLoading = false;
let createdKey = "";

async function load() {
  if (keysLoading) return;
  keysLoading = true;
  $("#api-key-refresh").disabled = true;
  try {
    const data = await api("/api/api-keys");
    if (hasSession()) render(data.keys);
  } catch (error) {
    $("#api-key-status").textContent = `读取失败：${error.message}`;
  } finally {
    keysLoading = false;
    $("#api-key-refresh").disabled = false;
  }
}

async function mutate(id, method, body, button) {
  button.disabled = true;
  try {
    const data = await api(`/api/api-keys/${encodeURIComponent(id)}`, {
      method,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!hasSession()) return;
    render(data.keys);
    await loadConfig();
    toast("已保存并立即生效");
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

function render(keys) {
  keys = keys || [];
  $("#api-key-count").textContent = `${keys.length} 个`;
  $("#api-key-status").textContent = `${keys.filter((key) => key.enabled).length} 个已启用`;
  const host = $("#api-key-list");
  host.replaceChildren();
  for (const key of keys) {
    const usage = key.usage || {};
    const summary = (value = {}) =>
      `${formatNumber(value.requests)} 次 · ${formatNumber(value.total_tokens)} tokens`;
    const rename = el("button", { type: "button", class: "btn btn-sm btn-ghost", text: "重命名" });
    rename.addEventListener("click", async () => {
      const name = await promptDialog({
        title: "重命名 API Key",
        label: "密钥名称",
        value: key.name,
        confirmLabel: "保存",
      });
      if (name !== null) mutate(key.id, "PATCH", { name }, rename);
    });
    const toggle = el("button", {
      type: "button",
      class: "btn btn-sm btn-ghost",
      text: key.enabled ? "停用" : "启用",
    });
    toggle.addEventListener("click", () => mutate(key.id, "PATCH", { enabled: !key.enabled }, toggle));
    const remove = el("button", { type: "button", class: "btn btn-sm btn-danger", text: "删除" });
    remove.addEventListener("click", async () => {
      const ok = await confirmDialog({
        title: "删除 API Key",
        message: `删除「${key.name}」后，使用它的应用将无法继续访问。确定删除？`,
        confirmLabel: "删除",
        danger: true,
      });
      if (ok) mutate(key.id, "DELETE", null, remove);
    });
    host.append(
      el("tr", {}, [
        el("td", { text: key.name }),
        el("td", { class: "mono", text: key.display }),
        el("td", { class: `status ${key.enabled ? "ok" : "warn"}`, text: key.enabled ? "已启用" : "已停用" }),
        el("td", { text: `${summary(usage.last_hour)} / ${summary(usage.lifetime)}` }),
        el("td", { text: key.created_at ? localTime(key.created_at) : "已有配置" }),
        el("td", {}, [el("div", { class: "key-actions" }, [rename, toggle, remove])]),
      ]),
    );
  }
  if (!keys.length) emptyRow(host, 6, "暂无 API Key");
}

async function create(event) {
  event.preventDefault();
  const button = $("#api-key-create");
  button.disabled = true;
  try {
    const data = await api("/api/api-keys", {
      method: "POST",
      body: JSON.stringify({ name: $("#api-key-name").value, value: $("#api-key-value").value }),
    });
    if (!hasSession()) return;
    createdKey = data.key;
    const goModels = store.get("debug")?.models?.filter((item) => item.available_go) || [];
    const model =
      goModels.find((item) => item.model === "glm-5.3-flash")?.model ||
      goModels[0]?.model ||
      "YOUR_MODEL";
    $("#api-key-env").textContent = `OPENAI_API_KEY=${data.key}\nOPENAI_BASE_URL=${derivedAPIBase()}/v1\nOPENAI_MODEL=${model}`;
    $("#api-key-created").classList.remove("hidden");
    $("#api-key-form").reset();
    render(data.keys);
    await loadConfig();
    toast("API Key 已创建");
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

function resetCreated() {
  createdKey = "";
  $("#api-key-env").textContent = "";
  $("#api-key-created").classList.add("hidden");
  $("#api-key-value").value = "";
}

export default {
  id: "api-keys",
  title: "API Key 管理",
  sub: "给每个调用方独立的访问密钥。",
  init() {
    $("#api-key-form").addEventListener("submit", create);
    $("#api-key-refresh").addEventListener("click", load);
    $("#api-key-dismiss").addEventListener("click", resetCreated);
    $("#api-key-copy").addEventListener("click", () => copyText(createdKey));
    $("#api-key-copy-env").addEventListener("click", () => copyText($("#api-key-env").textContent));
  },
  show: load,
  refresh: load,
  reset: resetCreated,
};
