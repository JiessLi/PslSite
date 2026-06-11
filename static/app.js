const state = {
  token: localStorage.getItem("psl_token") || "",
  user: null,
  catalog: null,
  filters: { q: "", series: "", tag: "", parameterId: "", min: "", max: "" },
  selection: { anchor: null, focus: null },
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function authHeaders(extra = {}) {
  return {
    ...extra,
    Authorization: `Bearer ${state.token}`,
  };
}

async function api(path, options = {}) {
  const headers = options.body instanceof FormData
    ? authHeaders(options.headers || {})
    : authHeaders({ "Content-Type": "application/json", ...(options.headers || {}) });
  const response = await fetch(path, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function showMessage(text, type = "ok") {
  const node = $("#message");
  node.textContent = text;
  node.dataset.type = type;
  if (text) setTimeout(() => {
    if (node.textContent === text) node.textContent = "";
  }, 3200);
}

function roleCanEdit() {
  return Boolean(state.user);
}

function roleIsAdmin() {
  return state.user && state.user.role === "admin";
}

function productValue(productId, parameterId) {
  return state.catalog.values[`${productId}:${parameterId}`]?.display_value || "";
}

function productSearchBlob(product) {
  const values = state.catalog.parameters.map((param) => productValue(product.id, param.id)).join(" ");
  return `${product.code} ${product.name} ${product.series} ${product.tag} ${product.manufacturer} ${values}`.toLowerCase();
}

function filteredProducts() {
  if (!state.catalog) return [];
  const q = state.filters.q.trim().toLowerCase();
  const min = state.filters.min === "" ? null : Number(state.filters.min);
  const max = state.filters.max === "" ? null : Number(state.filters.max);
  return state.catalog.products.filter((product) => {
    if (state.filters.series && product.series !== state.filters.series) return false;
    if (state.filters.tag && product.tag !== state.filters.tag) return false;
    if (q && !productSearchBlob(product).includes(q)) return false;
    if (state.filters.parameterId) {
      const value = state.catalog.values[`${product.id}:${state.filters.parameterId}`]?.numeric_value;
      if (min !== null && (value === undefined || value === null || value < min)) return false;
      if (max !== null && (value === undefined || value === null || value > max)) return false;
    }
    return true;
  });
}

function groupRows() {
  const groupsById = new Map(state.catalog.groups.map((group) => [group.id, { ...group, parameters: [] }]));
  state.catalog.parameters.forEach((parameter) => {
    const group = groupsById.get(parameter.group_id);
    if (group) group.parameters.push(parameter);
  });
  return Array.from(groupsById.values()).filter((group) => group.parameters.length);
}

function renderFilters() {
  const series = $("#seriesFilter");
  const tag = $("#tagFilter");
  const param = $("#paramFilter");
  series.innerHTML = `<option value="">全部系列</option>${state.catalog.filters.series.map((item) => `<option>${escapeHtml(item)}</option>`).join("")}`;
  tag.innerHTML = `<option value="">全部标签</option>${state.catalog.filters.tags.map((item) => `<option>${escapeHtml(item)}</option>`).join("")}`;
  const filterable = state.catalog.parameters.filter((item) => item.filterable);
  param.innerHTML = `<option value="">不按参数范围</option>${filterable.map((item) => `<option value="${item.id}">${escapeHtml(item.group_name)} / ${escapeHtml(item.name)}${item.unit ? ` (${escapeHtml(item.unit)})` : ""}</option>`).join("")}`;
  series.value = state.filters.series;
  tag.value = state.filters.tag;
  param.value = state.filters.parameterId;
}

function productImage(product) {
  if (product.image_url) {
    return `<img src="${escapeHtml(product.image_url)}" alt="${escapeHtml(product.code)}" onerror="this.closest('.product-visual').classList.add('empty'); this.remove();" />`;
  }
  return `<div class="placeholder-robot"><span></span><strong>${escapeHtml(product.code.slice(0, 2))}</strong></div>`;
}

function groupProductsByFirstRow(products) {
  const groups = [];
  const byName = new Map();
  products.forEach((product) => {
    const key = product.series || "-";
    if (!byName.has(key)) {
      const group = { name: key, products: [] };
      byName.set(key, group);
      groups.push(group);
    }
    byName.get(key).products.push(product);
  });
  return groups;
}

function renderTable() {
  if (!state.catalog) return;
  const productGroups = groupProductsByFirstRow(filteredProducts());
  const products = productGroups.flatMap((group) => group.products);
  const canEdit = roleCanEdit();
  $("#summary").textContent = `当前显示 ${products.length} / ${state.catalog.products.length} 个型号，${state.catalog.parameters.length} 个参数项`;
  const drawerMeta = $("#drawerMeta");
  if (drawerMeta) {
    const activeFilters = [
      state.filters.q,
      state.filters.series,
      state.filters.tag,
      state.filters.parameterId,
      state.filters.min,
      state.filters.max,
    ].filter(Boolean).length;
    drawerMeta.textContent = activeFilters
      ? `${activeFilters} 个筛选条件 · 当前 ${products.length} 个型号`
      : `未启用筛选 · 当前 ${products.length} 个型号`;
  }
  const colCount = Math.max(products.length, 1);
  let html = "";
  html += `<thead>`;
  html += `<tr><th class="corner intro-label" colspan="3">产品名称</th>${productGroups.map((group) => `<th class="product-cell product-group-cell" colspan="${group.products.length}" style="--span:${group.products.length}"><div class="product-series">${escapeHtml(group.name)}</div></th>`).join("")}</tr>`;
  html += `<tr><th class="sticky-left intro-label" colspan="3">产品图例</th>${products.map((product) => `<th class="product-cell"><div class="product-visual">${productImage(product)}</div></th>`).join("")}</tr>`;
  html += `<tr><th class="sticky-left intro-label" colspan="3">产品名称</th>${products.map((product) => `<th class="product-cell"><button class="linkish" data-edit-product="${product.id}">${escapeHtml(product.name)}</button></th>`).join("")}</tr>`;
  html += `<tr><th class="sticky-left intro-label" colspan="3">产品型号</th>${products.map((product) => `<th class="product-cell code">${escapeHtml(product.code)}</th>`).join("")}</tr>`;
  html += `</thead><tbody>`;
  if (!products.length) {
    html += `<tr><td class="empty-row" colspan="${colCount + 3}">没有符合条件的产品</td></tr>`;
  }
  let valueRowIndex = 0;
  groupRows().forEach((group) => {
    group.parameters.forEach((param, index) => {
      html += `<tr>`;
      if (index === 0) html += `<th class="sticky-left group-col group-name" rowspan="${group.parameters.length}">${escapeHtml(group.name)}</th>`;
      html += `<th class="sticky-left param-col param-name">${escapeHtml(param.name)}</th>`;
      html += `<td class="sticky-left unit-col unit">${escapeHtml(param.unit || "-")}</td>`;
      products.forEach((product, productIndex) => {
        const value = productValue(product.id, param.id);
        html += `<td class="value-cell ${canEdit ? "editable" : ""}" data-row="${valueRowIndex}" data-col="${productIndex}" data-product-id="${product.id}" data-parameter-id="${param.id}" title="${escapeHtml(value)}">${escapeHtml(value || "-")}</td>`;
      });
      html += `</tr>`;
      valueRowIndex += 1;
    });
  });
  html += `</tbody>`;
  $("#selectionTable").innerHTML = html;
}

async function loadCatalog() {
  state.catalog = await api("/api/catalog");
  renderFilters();
  renderTable();
  $$(".role-edit").forEach((item) => item.classList.toggle("hidden", !roleCanEdit()));
  $$(".role-admin").forEach((item) => item.classList.toggle("hidden", !roleIsAdmin()));
  updateAuthUI();
}

async function restoreSession() {
  if (!state.token) {
    state.user = null;
    showMain();
    await loadCatalog();
    return;
  }
  try {
    const data = await api("/api/me");
    state.user = data.user || null;
    if (!state.user) {
      localStorage.removeItem("psl_token");
      state.token = "";
    }
    showMain();
    await loadCatalog();
  } catch (error) {
    localStorage.removeItem("psl_token");
    state.token = "";
    state.user = null;
    showMain();
    await loadCatalog();
  }
}

function showLogin() {
  $("#loginView").classList.remove("hidden");
}

function showMain() {
  $("#loginView").classList.add("hidden");
  $("#mainView").classList.remove("hidden");
  updateAuthUI();
}

function updateAuthUI() {
  const signedIn = Boolean(state.user);
  $("#userBadge").textContent = signedIn
    ? `${state.user.display_name} · ${state.user.role}`
    : "访客模式 · 成本已隐藏";
  $("#loginBtn").classList.toggle("hidden", signedIn);
  $("#logoutBtn").classList.toggle("hidden", !signedIn);
}

function openProductDialog(product = null) {
  const form = $("#productForm");
  form.reset();
  $("#productDialogTitle").textContent = product ? "编辑产品" : "新增产品";
  form.id.value = product?.id || "";
  form.code.value = product?.code || "";
  form.code.disabled = Boolean(product);
  form.name.value = product?.name || "";
  form.series.value = product?.series || "";
  form.tag.value = product?.tag || "";
  form.manufacturer.value = product?.manufacturer || "";
  form.sort_order.value = product?.sort_order || "";
  form.image_url.value = product?.image_url || "";
  $("#productDialog").showModal();
}

function openParameterDialog(parameter = null) {
  const form = $("#paramForm");
  form.reset();
  $("#paramDialogTitle").textContent = parameter ? "编辑参数" : "新增参数";
  form.id.value = parameter?.id || "";
  form.group_name.value = parameter?.group_name || "";
  form.name.value = parameter?.name || "";
  form.unit.value = parameter?.unit || "";
  form.data_type.value = parameter?.data_type || "text";
  form.sort_order.value = parameter?.sort_order || "";
  form.filterable.checked = Boolean(parameter?.filterable);
  $("#paramDialog").showModal();
}

async function saveProduct() {
  const form = $("#productForm");
  const data = Object.fromEntries(new FormData(form).entries());
  data.sort_order = Number(data.sort_order || 0);
  if (form.id.value) {
    await api(`/api/products/${form.id.value}`, { method: "PUT", body: JSON.stringify(data) });
  } else {
    await api("/api/products", { method: "POST", body: JSON.stringify(data) });
  }
  $("#productDialog").close();
  await loadCatalog();
  showMessage("产品已保存");
}

async function saveParameter() {
  const form = $("#paramForm");
  const data = Object.fromEntries(new FormData(form).entries());
  data.filterable = form.filterable.checked;
  data.sort_order = Number(data.sort_order || 0);
  if (data.id) {
    await api(`/api/parameters/${data.id}`, { method: "PUT", body: JSON.stringify(data) });
  } else {
    await api("/api/parameters", { method: "POST", body: JSON.stringify(data) });
  }
  $("#paramDialog").close();
  await loadCatalog();
  if ($("#templateDialog").open) renderTemplateList();
  showMessage("参数已保存");
}

async function editValue(cell) {
  if (!roleCanEdit() || !cell.classList.contains("editable")) return;
  const oldValue = cell.textContent === "-" ? "" : cell.textContent;
  const value = window.prompt("修改参数值", oldValue);
  if (value === null) return;
  await api(`/api/values/${cell.dataset.productId}/${cell.dataset.parameterId}`, {
    method: "PUT",
    body: JSON.stringify({ display_value: value }),
  });
  const key = `${cell.dataset.productId}:${cell.dataset.parameterId}`;
  state.catalog.values[key] = {
    product_id: Number(cell.dataset.productId),
    parameter_id: Number(cell.dataset.parameterId),
    display_value: value,
    numeric_value: Number.isFinite(Number(value)) ? Number(value) : null,
  };
  renderTable();
  showMessage("参数值已更新");
}

async function editValueInline(cell) {
  if (!roleCanEdit() || !cell.classList.contains("editable")) return;
  if (cell.querySelector(".cell-editor")) return;

  const oldValue = cell.textContent === "-" ? "" : cell.textContent;
  const originalHtml = cell.innerHTML;
  const input = document.createElement("input");
  input.className = "cell-editor";
  input.value = oldValue;
  input.setAttribute("aria-label", "编辑参数值");

  cell.classList.add("editing");
  cell.innerHTML = "";
  cell.appendChild(input);
  input.focus();
  input.select();

  let finished = false;
  const cancel = () => {
    if (finished) return;
    finished = true;
    cell.classList.remove("editing", "saving");
    cell.innerHTML = originalHtml;
  };
  const save = async () => {
    if (finished) return;
    finished = true;
    const value = input.value.trim();
    if (value === oldValue) {
      cell.classList.remove("editing", "saving");
      cell.innerHTML = originalHtml;
      return;
    }
    cell.classList.add("saving");
    try {
      await api(`/api/values/${cell.dataset.productId}/${cell.dataset.parameterId}`, {
        method: "PUT",
        body: JSON.stringify({ display_value: value }),
      });
      const key = `${cell.dataset.productId}:${cell.dataset.parameterId}`;
      state.catalog.values[key] = {
        product_id: Number(cell.dataset.productId),
        parameter_id: Number(cell.dataset.parameterId),
        display_value: value,
        numeric_value: Number.isFinite(Number(value)) ? Number(value) : null,
      };
      renderTable();
      showMessage("参数值已更新");
    } catch (error) {
      cell.classList.remove("editing", "saving");
      cell.innerHTML = originalHtml;
      showMessage(error.message, "error");
    }
  };

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      save();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  });
  input.addEventListener("blur", () => save());
}

function cellPoint(cell) {
  return {
    row: Number(cell.dataset.row),
    col: Number(cell.dataset.col),
  };
}

function setSelection(anchorCell, focusCell = anchorCell) {
  if (!roleCanEdit() || !anchorCell || !focusCell) return;
  state.selection.anchor = cellPoint(anchorCell);
  state.selection.focus = cellPoint(focusCell);
  renderSelection();
}

function clearSelection() {
  state.selection.anchor = null;
  state.selection.focus = null;
  renderSelection();
}

function selectedBounds() {
  const { anchor, focus } = state.selection;
  if (!anchor || !focus) return null;
  return {
    rowMin: Math.min(anchor.row, focus.row),
    rowMax: Math.max(anchor.row, focus.row),
    colMin: Math.min(anchor.col, focus.col),
    colMax: Math.max(anchor.col, focus.col),
  };
}

function renderSelection() {
  $$(".value-cell.selected, .value-cell.selection-anchor").forEach((cell) => {
    cell.classList.remove("selected", "selection-anchor");
  });
  const bounds = selectedBounds();
  if (!bounds) return;
  $$(".value-cell.editable").forEach((cell) => {
    const row = Number(cell.dataset.row);
    const col = Number(cell.dataset.col);
    if (row >= bounds.rowMin && row <= bounds.rowMax && col >= bounds.colMin && col <= bounds.colMax) {
      cell.classList.add("selected");
    }
  });
  const anchor = state.selection.anchor;
  const anchorCell = $(`.value-cell.editable[data-row="${anchor.row}"][data-col="${anchor.col}"]`);
  if (anchorCell) anchorCell.classList.add("selection-anchor");
}

function parseClipboardTable(text) {
  return text
    .replace(/\r/g, "")
    .split("\n")
    .filter((line, index, lines) => line.length || index < lines.length - 1)
    .map((line) => line.split("\t"));
}

function selectionToClipboardTable() {
  const bounds = selectedBounds();
  if (!bounds) return "";
  const rows = [];
  for (let r = bounds.rowMin; r <= bounds.rowMax; r++) {
    const rowValues = [];
    for (let c = bounds.colMin; c <= bounds.colMax; c++) {
      const cell = $(`.value-cell.editable[data-row="${r}"][data-col="${c}"]`);
      rowValues.push(cell ? (cell.textContent === "-" ? "" : cell.textContent) : "");
    }
    rows.push(rowValues.join("\t"));
  }
  return rows.join("\n");
}

async function deleteSelection() {
  if (!roleCanEdit()) return;
  const bounds = selectedBounds();
  if (!bounds) return;
  const cells = [];
  for (let r = bounds.rowMin; r <= bounds.rowMax; r++) {
    for (let c = bounds.colMin; c <= bounds.colMax; c++) {
      const cell = $(`.value-cell.editable[data-row="${r}"][data-col="${c}"]`);
      if (cell && cell.textContent !== "-" && cell.textContent !== "") {
        cells.push(cell);
      }
    }
  }
  if (!cells.length) return;
  cells.forEach((cell) => cell.classList.add("saving"));
  try {
    await Promise.all(cells.map((cell) =>
      api(`/api/values/${cell.dataset.productId}/${cell.dataset.parameterId}`, {
        method: "PUT",
        body: JSON.stringify({ display_value: "" }),
      }).then(() => {
        const key = `${cell.dataset.productId}:${cell.dataset.parameterId}`;
        state.catalog.values[key] = {
          product_id: Number(cell.dataset.productId),
          parameter_id: Number(cell.dataset.parameterId),
          display_value: "",
          numeric_value: null,
        };
      })
    ));
    renderTable();
    showMessage(`已清空 ${cells.length} 个单元格`);
  } catch (error) {
    cells.forEach((cell) => cell.classList.remove("saving"));
    showMessage(error.message, "error");
  }
}

async function pasteIntoSelection(text) {
  if (!roleCanEdit()) return;
  const data = parseClipboardTable(text);
  if (!data.length || !data[0].length) return;
  const bounds = selectedBounds();
  if (!bounds) return;
  const startRow = bounds.rowMin;
  const startCol = bounds.colMin;
  const updates = [];
  data.forEach((rowValues, rowOffset) => {
    rowValues.forEach((value, colOffset) => {
      const cell = $(`.value-cell.editable[data-row="${startRow + rowOffset}"][data-col="${startCol + colOffset}"]`);
      if (!cell) return;
      const oldValue = cell.textContent === "-" ? "" : cell.textContent;
      const nextValue = value.trim();
      if (nextValue === oldValue) return;
      updates.push({ cell, value: nextValue });
    });
  });
  if (!updates.length) return;
  updates.forEach(({ cell }) => cell.classList.add("saving"));
  try {
    await Promise.all(updates.map(({ cell, value }) => api(`/api/values/${cell.dataset.productId}/${cell.dataset.parameterId}`, {
      method: "PUT",
      body: JSON.stringify({ display_value: value }),
    }).then(() => {
      const key = `${cell.dataset.productId}:${cell.dataset.parameterId}`;
      state.catalog.values[key] = {
        product_id: Number(cell.dataset.productId),
        parameter_id: Number(cell.dataset.parameterId),
        display_value: value,
        numeric_value: Number.isFinite(Number(value)) ? Number(value) : null,
      };
    })));
    renderTable();
    showMessage(`已粘贴 ${updates.length} 个单元格`);
  } catch (error) {
    updates.forEach(({ cell }) => cell.classList.remove("saving"));
    showMessage(error.message, "error");
  }
}

async function submitUpload() {
  const file = $("#uploadFile").files[0];
  if (!file) {
    showMessage("请先选择文件", "error");
    return;
  }
  const form = new FormData();
  form.append("file", file);
  const result = await api("/api/upload", { method: "POST", body: form });
  $("#uploadDialog").close();
  await loadCatalog();
  showMessage(`导入完成：${result.summary.values || 0} 个参数值`);
}

async function loadAudit() {
  const data = await api("/api/audit");
  $("#auditList").innerHTML = data.logs.map((log) => `
    <article class="audit-item">
      <strong>${escapeHtml(log.action)}</strong>
      <span>${escapeHtml(log.target)} · ${escapeHtml(log.display_name || "系统")} · ${escapeHtml(log.created_at)}</span>
      <code>${escapeHtml(log.detail)}</code>
    </article>
  `).join("") || `<p class="muted">暂无修改记录</p>`;
  $("#auditDialog").showModal();
}

async function loadUsers() {
  const data = await api("/api/users");
  $("#usersList").innerHTML = data.users.map((user) => `
    <article class="user-item">
      <div>
        <strong>${escapeHtml(user.display_name)}</strong>
        <span>${escapeHtml(user.username)} · ${escapeHtml(user.role)}</span>
      </div>
      <div class="user-actions">
        <button type="button" data-edit-user="${user.id}">编辑</button>
        <button type="button" data-delete-user="${user.id}" ${state.user.id === user.id ? "disabled" : ""}>删除</button>
      </div>
    </article>
  `).join("");
  $("#usersList").dataset.users = JSON.stringify(data.users);
  if (!$("#usersDialog").open) $("#usersDialog").showModal();
}

function renderTemplateList() {
  const groups = groupRows();
  $("#templateList").innerHTML = groups.map((group) => `
    <section class="template-group">
      <h3>${escapeHtml(group.name)}</h3>
      ${group.parameters.map((parameter) => `
        <article class="template-item">
          <div>
            <strong>${escapeHtml(parameter.name)}</strong>
            <span>${escapeHtml(parameter.unit || "-")} · ${escapeHtml(parameter.data_type || "text")} · ${parameter.filterable ? "可筛选" : "不可筛选"} · #${escapeHtml(parameter.sort_order || 0)}</span>
          </div>
          <div class="template-actions">
            <button type="button" data-edit-param="${parameter.id}">编辑</button>
            <button type="button" data-delete-param="${parameter.id}">删除</button>
          </div>
        </article>
      `).join("")}
    </section>
  `).join("") || `<p class="muted">暂无参数模板</p>`;
}

function openTemplateDialog() {
  renderTemplateList();
  $("#templateDialog").showModal();
}

async function saveUser() {
  const form = $("#userForm");
  const data = Object.fromEntries(new FormData(form).entries());
  if (!data.password && !data.id) {
    showMessage("新增用户需要填写密码", "error");
    return;
  }
  const method = data.id ? "PUT" : "POST";
  const path = data.id ? `/api/users/${data.id}` : "/api/users";
  await api(path, { method, body: JSON.stringify(data) });
  form.reset();
  await loadUsers();
  showMessage("用户已保存");
}

function bindEvents() {
  let isSelecting = false;
  $("#loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
      const data = await api("/api/login", { method: "POST", body: JSON.stringify(payload), headers: {} });
      state.token = data.token;
      state.user = data.user;
      localStorage.setItem("psl_token", state.token);
      showMain();
      await loadCatalog();
    } catch (error) {
      showMessage(error.message, "error");
      alert(error.message);
    }
  });
  $("#loginBtn").addEventListener("click", () => showLogin());
  $("#guestBtn").addEventListener("click", () => showMain());
  $("#logoutBtn").addEventListener("click", async () => {
    await api("/api/logout", { method: "POST", body: JSON.stringify({}) }).catch(() => {});
    localStorage.removeItem("psl_token");
    state.token = "";
    state.user = null;
    showMain();
    await loadCatalog();
  });
  $("#refreshBtn").addEventListener("click", () => loadCatalog().then(() => showMessage("已刷新")));
  $("#addProductBtn").addEventListener("click", () => openProductDialog());
  $("#uploadBtn").addEventListener("click", () => $("#uploadDialog").showModal());
  $("#auditBtn").addEventListener("click", () => loadAudit().catch((error) => showMessage(error.message, "error")));
  $("#usersBtn").addEventListener("click", () => loadUsers().catch((error) => showMessage(error.message, "error")));
  $("#templateBtn").addEventListener("click", () => openTemplateDialog());
  $("#templateAddParamBtn").addEventListener("click", () => openParameterDialog());
  $("#closeProductBtn").addEventListener("click", () => $("#productDialog").close());
  $("#cancelProductBtn").addEventListener("click", () => $("#productDialog").close());
  $("#closeParamBtn").addEventListener("click", () => $("#paramDialog").close());
  $("#cancelParamBtn").addEventListener("click", () => $("#paramDialog").close());
  $("#closeAuditBtn").addEventListener("click", () => $("#auditDialog").close());
  $("#closeUsersBtn").addEventListener("click", () => $("#usersDialog").close());
  $("#closeTemplateBtn").addEventListener("click", () => $("#templateDialog").close());
  $("#saveProductBtn").addEventListener("click", () => saveProduct().catch((error) => showMessage(error.message, "error")));
  $("#saveParamBtn").addEventListener("click", () => saveParameter().catch((error) => showMessage(error.message, "error")));
  $("#saveUserBtn").addEventListener("click", () => saveUser().catch((error) => showMessage(error.message, "error")));
  $("#submitUploadBtn").addEventListener("click", () => submitUpload().catch((error) => showMessage(error.message, "error")));
  $("#usersList").addEventListener("click", async (event) => {
    const edit = event.target.closest("[data-edit-user]");
    const remove = event.target.closest("[data-delete-user]");
    const users = JSON.parse($("#usersList").dataset.users || "[]");
    if (edit) {
      const user = users.find((item) => item.id === Number(edit.dataset.editUser));
      const form = $("#userForm");
      form.id.value = user.id;
      form.username.value = user.username;
      form.username.disabled = true;
      form.display_name.value = user.display_name;
      form.role.value = user.role;
      form.password.value = "";
    }
    if (remove && window.confirm("确认删除该用户？")) {
      await api(`/api/users/${remove.dataset.deleteUser}`, { method: "DELETE" });
      await loadUsers();
      showMessage("用户已删除");
    }
  });
  $("#userForm").addEventListener("reset", () => {
    $("#userForm").username.disabled = false;
  });
  $("#templateList").addEventListener("click", async (event) => {
    const edit = event.target.closest("[data-edit-param]");
    const remove = event.target.closest("[data-delete-param]");
    if (edit) {
      const parameter = state.catalog.parameters.find((item) => item.id === Number(edit.dataset.editParam));
      openParameterDialog(parameter);
    }
    if (remove && window.confirm("确认删除该参数模板？对应参数值也会删除。")) {
      await api(`/api/parameters/${remove.dataset.deleteParam}`, { method: "DELETE" });
      await loadCatalog();
      if ($("#templateDialog").open) renderTemplateList();
      showMessage("参数模板已删除");
    }
  });
  $("#selectionTable").addEventListener("mousedown", (event) => {
    const cell = event.target.closest(".value-cell.editable");
    if (!cell || event.button !== 0) return;
    if (event.target.closest(".cell-editor")) return;
    event.preventDefault();
    if (event.shiftKey && state.selection.anchor) {
      const anchorCell = $(`.value-cell.editable[data-row="${state.selection.anchor.row}"][data-col="${state.selection.anchor.col}"]`);
      setSelection(anchorCell || cell, cell);
    } else {
      setSelection(cell);
    }
    isSelecting = true;
  });
  $("#selectionTable").addEventListener("mouseover", (event) => {
    if (!isSelecting) return;
    const cell = event.target.closest(".value-cell.editable");
    if (cell) {
      const anchorCell = $(`.value-cell.editable[data-row="${state.selection.anchor.row}"][data-col="${state.selection.anchor.col}"]`);
      setSelection(anchorCell || cell, cell);
    }
  });
  document.addEventListener("mouseup", () => {
    isSelecting = false;
  });
  document.addEventListener("keydown", (event) => {
    const editingInput = event.target.closest && event.target.closest("input, textarea, select");
    // Delete / Backspace — batch clear selected cells
    if ((event.key === "Delete" || event.key === "Backspace") && !editingInput) {
      if (!state.selection.anchor) return;
      event.preventDefault();
      deleteSelection();
    }
  });

  // Copy — handled via native copy event (not keydown) so event.clipboardData works
  document.addEventListener("copy", (event) => {
    if (event.target.closest && event.target.closest("input, textarea, select")) return;
    if (!state.selection.anchor) return;
    const text = selectionToClipboardTable();
    if (!text) return;
    event.clipboardData.setData("text/plain", text);
    event.preventDefault();
    showMessage("已复制选取的单元格");
  });

  // Cut — copy to clipboard then delete
  document.addEventListener("cut", (event) => {
    if (event.target.closest && event.target.closest("input, textarea, select")) return;
    if (!state.selection.anchor) return;
    if (!roleCanEdit()) return;
    const text = selectionToClipboardTable();
    if (!text) return;
    event.clipboardData.setData("text/plain", text);
    event.preventDefault();
    deleteSelection();
  });

  // Paste — handled via native paste event so event.clipboardData works
  document.addEventListener("paste", (event) => {
    if (event.target.closest && event.target.closest("input, textarea, select")) return;
    if (!roleCanEdit()) return;
    const text = event.clipboardData?.getData("text/plain") || "";
    if (!text || !state.selection.anchor) return;
    event.preventDefault();
    pasteIntoSelection(text);
  });
  $("#selectionTable").addEventListener("dblclick", (event) => {
    const cell = event.target.closest(".value-cell");
    if (cell) editValueInline(cell).catch((error) => showMessage(error.message, "error"));
  });
  $("#selectionTable").addEventListener("click", (event) => {
    const editButton = event.target.closest("[data-edit-product]");
    if (editButton && roleCanEdit()) {
      const product = state.catalog.products.find((item) => item.id === Number(editButton.dataset.editProduct));
      openProductDialog(product);
      return;
    }
  });
  [
    ["searchInput", "q"],
    ["seriesFilter", "series"],
    ["tagFilter", "tag"],
    ["paramFilter", "parameterId"],
    ["minFilter", "min"],
    ["maxFilter", "max"],
  ].forEach(([id, key]) => {
    $(`#${id}`).addEventListener("input", (event) => {
      state.filters[key] = event.target.value;
      renderTable();
    });
  });
}

bindEvents();
restoreSession();
