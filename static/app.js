const state = {
  token: localStorage.getItem("psl_token") || "",
  user: null,
  catalog: null,
  editMode: false,
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
    return `<img src="${escapeHtml(product.image_url)}" alt="${escapeHtml(product.code)}" data-lightbox-src="${escapeHtml(product.image_url)}" onerror="this.closest('.product-visual').classList.add('empty'); this.remove();" />`;
  }
  return `<div class="placeholder-robot"><span></span><strong>${escapeHtml(product.code.slice(0, 2))}</strong></div>`;
}

function openLightbox(imgEl) {
  const overlay = $("#lightboxOverlay");
  const image = $("#lightboxImage");
  image.src = imgEl.dataset.lightboxSrc || imgEl.src;
  image.alt = imgEl.alt;
  overlay.removeAttribute("hidden");
}

function closeLightbox() {
  $("#lightboxOverlay").setAttribute("hidden", "");
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
  const signedIn = Boolean(state.user);
  const canEdit = signedIn && state.editMode;
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
  document.body.classList.toggle("editing-mode", canEdit);
  const colCount = Math.max(products.length, 1);
  let html = "";
  html += `<thead>`;
  html += `<tr><th class="corner intro-label" colspan="3">产品类型</th>${productGroups.map((group) => `<th class="product-cell product-group-cell" colspan="${group.products.length}" style="--span:${group.products.length}"><div class="product-series">${escapeHtml(group.name)}</div></th>`).join("")}</tr>`;
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
  // Reset to login tab
  $("#loginDialog").showModal();
  $$(".login-tab").forEach(t => t.classList.toggle("active", t.dataset.tab === "login"));
  $("#loginForm").classList.remove("hidden");
  $("#registerForm").classList.add("hidden");
}

function showMain() {
  $("#loginDialog").close();
  $("#mainView").classList.remove("hidden");
  updateAuthUI();
}

function updateAuthUI() {
  const signedIn = Boolean(state.user);
  $("#loginBtn").classList.toggle("hidden", signedIn);
  $("#avatarBtn").classList.toggle("hidden", !signedIn);
  if (signedIn) {
    const initial = (state.user.display_name || state.user.username || "?")[0];
    $("#avatarInitial").textContent = initial;
    // Show/hide admin entry
    $("#adminEntryBtn").classList.toggle("hidden", state.user.role !== "admin");
    // Show/hide data manage entry (visible for all logged-in users)
    $("#dataManageBtn").classList.toggle("hidden", false);
    // Update data manage label based on editMode
    updateDataManageLabel();
    closeAvatarMenu();
  } else {
    state.editMode = false;
    document.body.classList.remove("editing-mode");
  }
}

function updateDataManageLabel() {
  $("#dataManageBtn").classList.toggle("active", state.editMode);
  $("#dataManageBtn").textContent = state.editMode ? "📊 数据管理 ✏" : "📊 数据管理";
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

function openProductManage() {
  $("#productManageForm").reset();
  $("#productManageForm").id.value = "";
  $("#productManageForm").code.disabled = false;
  renderProductManageList();
  $("#productManageDialog").showModal();
}

function renderProductManageList() {
  if (!state.catalog) return;
  $("#productManageList").innerHTML = state.catalog.products.map((product) => `
    <article class="user-item">
      <div>
        <strong>${escapeHtml(product.name)}</strong>
        <span>${escapeHtml(product.code)} · ${escapeHtml(product.series || "-")}</span>
      </div>
      <div class="user-actions">
        <button type="button" data-edit-product="${product.id}">编辑</button>
        <button type="button" data-delete-product="${product.id}">删除</button>
      </div>
    </article>
  `).join("") || `<p class="muted">暂无产品</p>`;
}

async function saveManageProduct() {
  const form = $("#productManageForm");
  const data = Object.fromEntries(new FormData(form).entries());
  if (!data.code.trim()) {
    showMessage("产品型号不能为空", "error");
    return;
  }
  if (data.id) {
    await api(`/api/products/${data.id}`, { method: "PUT", body: JSON.stringify(data) });
  } else {
    await api("/api/products", { method: "POST", body: JSON.stringify(data) });
  }
  form.reset();
  form.id.value = "";
  form.code.disabled = false;
  await loadCatalog();
  renderProductManageList();
  showMessage("产品已保存");
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
  if ($("#productManageDialog").open) renderProductManageList();
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

function renderTemplateList() {
  const groups = groupRows();
  $("#templateList").innerHTML = groups.map((group) => `
    <section class="template-group" data-group-id="${group.id}">
      <h3 draggable="true">
        <span class="template-group-drag-handle">⠿</span>
        ${escapeHtml(group.name)}
      </h3>
      ${group.parameters.map((parameter) => `
        <article class="template-item" draggable="true" data-param-id="${parameter.id}" data-group-id="${group.id}">
          <div class="template-item-left">
            <span class="template-drag-handle">⠿</span>
            <div>
              <strong>${escapeHtml(parameter.name)}</strong>
              <span>${escapeHtml(parameter.unit || "-")} · ${escapeHtml(parameter.data_type || "text")} · ${parameter.filterable ? "可筛选" : "不可筛选"} · #${escapeHtml(parameter.sort_order || 0)}</span>
            </div>
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

// --- Avatar menu helpers ---
function closeAvatarMenu() {
  $("#avatarMenu").classList.add("hidden");
}

function openProfile() {
  if (!state.user) return;
  const f = $("#profileForm");
  f.username.value = state.user.username;
  f.display_name.value = state.user.display_name || "";
  f.role.value = state.user.role || "";
  f.password.value = "";
  $("#profileDialog").showModal();
}

// --- Admin panel ---
function showAdminPanel() {
  $("#mainView").classList.add("hidden");
  $("#adminView").classList.remove("hidden");
  loadAdminSection("users");
}

function hideAdminPanel() {
  $("#adminView").classList.add("hidden");
  $("#mainView").classList.remove("hidden");
}

async function loadAdminUsers() {
  const selectedGroupId = $("#adminView").dataset.selectedGroup || "";
  const filterGroupId = $("#adminMemberGroupFilter")?.value || "";
  const groupData = await api("/api/user-groups");
  state.userGroups = groupData.groups;
  renderAdminGroups();
  renderAdminMemberGroupFilter(filterGroupId);
  $("#adminGroupLabel").textContent = filterGroupId
    ? `— ${(state.userGroups.find(g => String(g.id) === filterGroupId) || {}).name || ""}`
    : "";
  const data = await api("/api/users");
  state.adminUsers = data.users;
  let users = data.users;
  if (filterGroupId) {
    users = users.filter(u => String(u.group_id) === filterGroupId);
  }
  renderAdminUserList(users);
}

function renderAdminMemberGroupFilter(value = "") {
  const select = $("#adminMemberGroupFilter");
  if (!select) return;
  select.innerHTML = `<option value="">全部用户组</option>${(state.userGroups || []).map((group) => (
    `<option value="${group.id}">${escapeHtml(group.name)}</option>`
  )).join("")}`;
  select.value = value;
}

function loadAdminSection(tabName) {
  $$(".admin-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === tabName));
  $$("#adminView .admin-content").forEach((panel) => {
    panel.classList.toggle("hidden", panel.id !== `admin${tabName.charAt(0).toUpperCase() + tabName.slice(1)}Panel`);
  });
  if (tabName === "users") {
    loadAdminSubTab($("#adminUsersPanel"), "groups");
    loadAdminUsers();
  } else if (tabName === "settings") {
    loadAdminSubTab($("#adminSettingsPanel"), "storage");
    loadAdminSettings();
  } else if (tabName === "audit") {
    loadAdminAudit();
  }
}

function loadAdminSubTab(panel, subTabName) {
  if (!panel) return;
  panel.querySelectorAll(".admin-sub-tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.subTab === subTabName);
  });
  panel.querySelectorAll(".admin-sub-panel").forEach((subPanel) => {
    subPanel.classList.toggle("hidden", subPanel.id !== `adminSub${subTabName.charAt(0).toUpperCase() + subTabName.slice(1)}Panel`);
  });
}

function renderAdminGroups() {
  const groups = state.userGroups || [];
  const selected = $("#adminView").dataset.selectedGroup || "";
  $("#adminUserGroupsList").innerHTML = `
    <table class="admin-group-table">
      <colgroup>
        <col class="admin-group-name-col" />
        <col class="admin-group-note-col" />
        <col class="admin-group-count-col" />
        <col class="admin-group-actions-col" />
      </colgroup>
      <thead>
        <tr>
          <th>组名</th>
          <th>备注</th>
          <th>成员数</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        ${groups.map((group) => adminGroupRowHtml(group, { selected: String(group.id) === selected })).join("")}
        <tr class="admin-group-add-row">
          <td colspan="4"><button class="add-row-button" type="button" data-add-group-row>＋</button></td>
        </tr>
      </tbody>
    </table>
  `;
}

function adminGroupRowHtml(group, options = {}) {
  const editing = Boolean(options.editing);
  const isNew = Boolean(options.isNew);
  const selected = Boolean(options.selected);
  return `
    <tr class="admin-group-row ${selected ? "selected" : ""} ${editing ? "editing" : ""}" data-group-id="${isNew ? "" : group.id}" data-new-group="${isNew ? "1" : "0"}">
      <td><input name="name" value="${escapeHtml(group.name || "")}" placeholder="组名称" ${editing ? "" : "disabled"} /></td>
      <td><input name="description" value="${escapeHtml(group.description || "")}" placeholder="备注" ${editing ? "" : "disabled"} /></td>
      <td class="member-count">${Number(group.member_count || 0)}</td>
      <td class="group-row-actions">
        ${editing
          ? `<button class="primary" type="button" data-save-group-row>保存</button><button type="button" data-cancel-group-row>取消</button>`
          : `<button type="button" data-edit-group>编辑</button><button type="button" data-delete-group>删除</button>`}
      </td>
    </tr>
  `;
}

function setAdminGroupRowEditing(row, editing) {
  row.classList.toggle("editing", editing);
  row.querySelectorAll("input").forEach((input) => { input.disabled = !editing; });
  row.querySelector(".group-row-actions").innerHTML = editing
    ? `<button class="primary" type="button" data-save-group-row>保存</button><button type="button" data-cancel-group-row>取消</button>`
    : `<button type="button" data-edit-group>编辑</button><button type="button" data-delete-group>删除</button>`;
  if (editing) row.querySelector("input[name='name']")?.focus();
}

function restoreAdminGroupRow(row) {
  if (row.dataset.newGroup === "1") {
    renderAdminGroups();
    return;
  }
  const group = (state.userGroups || []).find((item) => String(item.id) === row.dataset.groupId);
  if (!group) return;
  row.querySelector("input[name='name']").value = group.name || "";
  row.querySelector("input[name='description']").value = group.description || "";
  setAdminGroupRowEditing(row, false);
}

function expandNewAdminGroupRow(row) {
  row.outerHTML = adminGroupRowHtml({ name: "", description: "", member_count: 0 }, { editing: true, isNew: true });
  $("#adminUserGroupsList .admin-group-row[data-new-group='1'] input[name='name']")?.focus();
}

function renderAdminUserList(users) {
  $("#adminUsersList").innerHTML = `
    <table class="admin-member-table">
      <colgroup>
        <col class="admin-member-id-col" />
        <col class="admin-member-account-col" />
        <col class="admin-member-group-col" />
        <col class="admin-member-password-col" />
        <col class="admin-member-actions-col" />
      </colgroup>
      <thead>
        <tr>
          <th>用户ID</th>
          <th>账号</th>
          <th>用户组</th>
          <th>密码</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        ${users.map((user) => adminUserRowHtml(user)).join("")}
        <tr class="admin-member-add-row">
          <td colspan="5"><button class="add-row-button" type="button" data-add-user-row>＋</button></td>
        </tr>
      </tbody>
    </table>
  `;
  $("#adminUsersList").dataset.users = JSON.stringify(users);
}

function adminGroupOptions(selectedId = "") {
  return `<option value="">未分组</option>${(state.userGroups || []).map((group) => (
    `<option value="${group.id}" ${String(group.id) === String(selectedId || "") ? "selected" : ""}>${escapeHtml(group.name)}</option>`
  )).join("")}`;
}

function formatUserId(id) {
  const number = Number(id);
  return Number.isFinite(number) ? String(number).padStart(4, "0") : "";
}

function adminUserRowHtml(user, options = {}) {
  const editing = Boolean(options.editing);
  const isNew = Boolean(options.isNew);
  const currentUserId = String(state.user?.id || "");
  return `
    <tr class="admin-member-row ${editing ? "editing" : ""}" data-user-id="${isNew ? "" : user.id}" data-new-user="${isNew ? "1" : "0"}">
      <td class="member-id">${isNew ? "" : formatUserId(user.id)}</td>
      <td><input name="username" value="${escapeHtml(user.username || "")}" placeholder="账号" ${editing && isNew ? "" : "disabled"} /></td>
      <td><select name="group_id" ${editing ? "" : "disabled"}>${adminGroupOptions(user.group_id)}</select></td>
      <td><input name="password" value="" placeholder="${isNew ? "初始密码" : "留空不修改"}" type="password" ${editing ? "" : "disabled"} /></td>
      <td class="member-row-actions">
        ${editing
          ? `<button class="primary" type="button" data-save-user-row>保存</button><button type="button" data-cancel-user-row>取消</button>`
          : `<button type="button" data-edit-user>编辑</button><button type="button" data-delete-user ${!isNew && currentUserId === String(user.id) ? "disabled" : ""}>删除</button>`}
      </td>
    </tr>
  `;
}

function setAdminUserRowEditing(row, editing) {
  row.classList.toggle("editing", editing);
  row.querySelectorAll("input, select").forEach((field) => {
    field.disabled = !editing;
  });
  row.querySelector(".member-row-actions").innerHTML = editing
    ? `<button class="primary" type="button" data-save-user-row>保存</button><button type="button" data-cancel-user-row>取消</button>`
    : `<button type="button" data-edit-user>编辑</button><button type="button" data-delete-user ${String(state.user?.id || "") === row.dataset.userId ? "disabled" : ""}>删除</button>`;
  if (editing) row.querySelector("input[name='username']")?.focus();
}

function restoreAdminUserRow(row) {
  if (row.dataset.newUser === "1") {
    renderAdminUserList(filteredAdminUsers());
    return;
  }
  const user = (state.adminUsers || []).find((item) => String(item.id) === row.dataset.userId);
  if (!user) return;
  row.querySelector("input[name='username']").value = user.username || "";
  row.querySelector("select[name='group_id']").value = user.group_id || "";
  row.querySelector("input[name='password']").value = "";
  setAdminUserRowEditing(row, false);
}

function filteredAdminUsers() {
  const filterGroupId = $("#adminMemberGroupFilter")?.value || "";
  return (state.adminUsers || []).filter((user) => !filterGroupId || String(user.group_id) === filterGroupId);
}

function expandNewAdminUserRow(row) {
  const filterGroupId = $("#adminMemberGroupFilter")?.value || "";
  row.outerHTML = adminUserRowHtml({ username: "", group_id: filterGroupId }, { editing: true, isNew: true });
  $("#adminUsersList .admin-member-row[data-new-user='1'] input[name='username']")?.focus();
}

async function saveAdminUserGroup() {
  const form = $("#adminUserGroupForm");
  const data = Object.fromEntries(new FormData(form).entries());
  if (!data.name.trim()) { showMessage("用户组名称不能为空", "error"); return; }
  const method = data.id ? "PUT" : "POST";
  const path = data.id ? `/api/user-groups/${data.id}` : "/api/user-groups";
  await api(path, { method, body: JSON.stringify(data) });
  form.reset();
  await loadAdminUsers();
  showMessage("用户组已保存");
}

async function saveAdminUser() {
  const form = $("#adminUserForm");
  const data = Object.fromEntries(new FormData(form).entries());
  if (!data.password && !data.id) { showMessage("新增用户需要填写密码", "error"); return; }
  const selectedGroup = $("#adminView").dataset.selectedGroup || "";
  if (selectedGroup) data.group_id = Number(selectedGroup);
  const method = data.id ? "PUT" : "POST";
  const path = data.id ? `/api/users/${data.id}` : "/api/users";
  await api(path, { method, body: JSON.stringify(data) });
  form.reset();
  await loadAdminUsers();
  showMessage("用户已保存");
}

async function loadAdminSettings() {
  const data = await api("/api/settings");
  const s = data.settings;
  const storageForm = $("#adminStorageForm");
  storageForm.storage_type.value = s.storage_type || "local";
  storageForm.upload_dir.value = s.upload_dir || "uploads";
  storageForm.s3_endpoint.value = s.s3_endpoint || "";
  storageForm.s3_bucket.value = s.s3_bucket || "";
  storageForm.s3_region.value = s.s3_region || "";
  storageForm.s3_access_key.value = s.s3_access_key || "";
  storageForm.s3_secret_key.value = s.s3_secret_key || "";
  storageForm.s3_custom_domain.value = s.s3_custom_domain || "";
  toggleStorageConfigGroups(storageForm.storage_type.value);

  const emailForm = $("#adminEmailForm");
  emailForm.smtp_host.value = s.smtp_host || "";
  emailForm.smtp_port.value = s.smtp_port || "";
  emailForm.smtp_user.value = s.smtp_user || "";
  emailForm.smtp_pass.value = s.smtp_pass || "";
  emailForm.smtp_sender.value = s.smtp_sender || "";
}

function toggleStorageConfigGroups(storageType) {
  const activeType = storageType === "s3" ? "s3" : "local";
  $$(".storage-config-group").forEach((group) => {
    group.classList.toggle("hidden", group.dataset.storageGroup !== activeType);
  });
}

async function loadAdminAudit() {
  const data = await api("/api/audit");
  $("#adminAuditList").innerHTML = data.logs.map(log => `
    <article class="audit-item">
      <strong>${escapeHtml(log.action)}</strong>
      <span>${escapeHtml(log.target)} · ${escapeHtml(log.display_name || "系统")} · ${escapeHtml(log.created_at)}</span>
      <code>${escapeHtml(log.detail)}</code>
    </article>
  `).join("") || `<p class="muted">暂无修改记录</p>`;
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
  $("#closeLoginBtn").addEventListener("click", () => showMain());

  // --- Login / Register tabs ---
  $$(".login-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      $$(".login-tab").forEach(t => t.classList.toggle("active", t === tab));
      $("#loginForm").classList.toggle("hidden", tab.dataset.tab !== "login");
      $("#registerForm").classList.toggle("hidden", tab.dataset.tab !== "register");
    });
  });

  // --- Send email verification code ---
  let codeCooldown = 0;
  let codeTimer = null;
  $("#sendCodeBtn").addEventListener("click", async () => {
    if (codeCooldown > 0) return;
    const email = $("#registerForm").email.value.trim();
    if (!email || !email.includes("@") || !email.includes(".")) {
      showMessage("请输入有效的邮箱地址", "error");
      return;
    }
    try {
      $("#sendCodeBtn").disabled = true;
      await api("/api/send-register-code", { method: "POST", body: JSON.stringify({ email }), headers: {} });
      showMessage("验证码已发送，请查收邮件");
      codeCooldown = 60;
      $("#sendCodeBtn").textContent = `${codeCooldown}s 后重发`;
      codeTimer = setInterval(() => {
        codeCooldown -= 1;
        if (codeCooldown <= 0) {
          clearInterval(codeTimer);
          codeTimer = null;
          $("#sendCodeBtn").textContent = "发送验证码";
          $("#sendCodeBtn").disabled = false;
        } else {
          $("#sendCodeBtn").textContent = `${codeCooldown}s 后重发`;
        }
      }, 1000);
    } catch (error) {
      showMessage(error.message, "error");
      $("#sendCodeBtn").disabled = false;
    }
  });

  // --- Register form ---
  $("#registerForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
    if (!payload.email || !payload.code || !payload.username || !payload.display_name || !payload.password) {
      showMessage("请填写所有字段", "error");
      return;
    }
    if (payload.password.length < 6) {
      showMessage("密码至少 6 位", "error");
      return;
    }
    try {
      const data = await api("/api/register", { method: "POST", body: JSON.stringify(payload), headers: {} });
      state.token = data.token;
      state.user = data.user;
      localStorage.setItem("psl_token", state.token);
      showMain();
      await loadCatalog();
      showMessage("注册成功，已自动登录");
    } catch (error) {
      showMessage(error.message, "error");
    }
  });
  // --- Avatar dropdown ---
  $("#avatarBtn").addEventListener("click", () => {
    $("#avatarMenu").classList.toggle("hidden");
  });
  document.addEventListener("click", (event) => {
    if (!$("#avatarMenu").classList.contains("hidden") && !event.target.closest("#avatarBtn") && !event.target.closest("#avatarMenu")) {
      closeAvatarMenu();
    }
  });
  // Avatar menu actions
  $("#avatarMenu").addEventListener("click", async (event) => {
    const action = event.target.closest("button")?.dataset.action;
    if (!action) return;
    closeAvatarMenu();
    if (action === "profile") openProfile();
    else if (action === "dataManage") {
      state.editMode = !state.editMode;
      updateDataManageLabel();
      document.body.classList.toggle("editing-mode", state.editMode);
      await loadCatalog();
      showMessage(state.editMode ? "数据管理已开启，表格可编辑" : "数据管理已关闭");
    }
    else if (action === "admin") showAdminPanel();
    else if (action === "logout") {
      await api("/api/logout", { method: "POST", body: JSON.stringify({}) }).catch(() => {});
      localStorage.removeItem("psl_token");
      state.token = "";
      state.user = null;
      state.editMode = false;
      document.body.classList.remove("editing-mode");
      showMain();
      await loadCatalog();
    }
  });
  // --- Profile dialog ---
  $("#closeProfileBtn").addEventListener("click", () => $("#profileDialog").close());
  $("#cancelProfileBtn").addEventListener("click", () => $("#profileDialog").close());
  $("#profileForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
    if (!payload.display_name.trim()) { showMessage("显示名不能为空", "error"); return; }
    const body = { display_name: payload.display_name.trim() };
    if (payload.password) body.password = payload.password;
    try {
      const data = await api(`/api/users/${state.user.id}`, { method: "PUT", body: JSON.stringify(body) });
      state.user.display_name = body.display_name;
      updateAuthUI();
      $("#profileDialog").close();
      showMessage("个人资料已更新");
    } catch (error) {
      showMessage(error.message, "error");
    }
  });
  // --- Admin panel ---
  $("#backToMainBtn").addEventListener("click", hideAdminPanel);
  $("#adminSidebarToggle").addEventListener("click", () => {
    const collapsed = $("#adminSidebar").classList.toggle("collapsed");
    $("#adminSidebarToggle").textContent = collapsed ? "⇥" : "⇤";
    $("#adminSidebarToggle").title = collapsed ? "展开侧栏" : "收起侧栏";
  });
  $$(".admin-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      loadAdminSection(tab.dataset.tab);
    });
  });
  $$(".admin-sub-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      loadAdminSubTab(tab.closest(".admin-content"), tab.dataset.subTab);
      if (tab.dataset.subTab === "members") loadAdminUsers();
      if (tab.dataset.subTab === "storage" || tab.dataset.subTab === "email") loadAdminSettings();
    });
  });
  $("#adminMemberGroupFilter").addEventListener("change", () => loadAdminUsers());
  // Admin user group save
  $("#adminSaveGroupBtn").addEventListener("click", () => saveAdminUserGroup().catch(e => showMessage(e.message, "error")));
  // Admin user save
  $("#adminSaveUserBtn").addEventListener("click", () => saveAdminUser().catch(e => showMessage(e.message, "error")));
  // Admin user group list: select/edit/delete
  $("#adminUserGroupsList").addEventListener("click", async (event) => {
    const add = event.target.closest("[data-add-group-row]");
    const row = event.target.closest(".admin-group-row");
    if (add) {
      expandNewAdminGroupRow(event.target.closest(".admin-group-add-row"));
      return;
    }
    if (!row) return;
    const edit = event.target.closest("[data-edit-group]");
    const save = event.target.closest("[data-save-group-row]");
    const cancel = event.target.closest("[data-cancel-group-row]");
    const remove = event.target.closest("[data-delete-group]");
    if (edit) {
      setAdminGroupRowEditing(row, true);
      return;
    }
    if (cancel) {
      restoreAdminGroupRow(row);
      return;
    }
    if (save) {
      const name = row.querySelector("input[name='name']").value.trim();
      const description = row.querySelector("input[name='description']").value.trim();
      if (!name) {
        showMessage("用户组名称不能为空", "error");
        row.querySelector("input[name='name']").focus();
        return;
      }
      const isNew = row.dataset.newGroup === "1";
      const group = (state.userGroups || []).find((item) => String(item.id) === row.dataset.groupId);
      const path = isNew ? "/api/user-groups" : `/api/user-groups/${row.dataset.groupId}`;
      const method = isNew ? "POST" : "PUT";
      await api(path, {
        method,
        body: JSON.stringify({ name, description, sort_order: group?.sort_order || 0 }),
      });
      await loadAdminUsers();
      showMessage(isNew ? "用户组已新增" : "用户组已保存");
      return;
    }
    if (remove && window.confirm("确认删除该用户组？")) {
      await api(`/api/user-groups/${row.dataset.groupId}`, { method: "DELETE" });
      $("#adminUserGroupForm").reset();
      $("#adminSaveGroupBtn").textContent = "新增用户组";
      await loadAdminUsers();
      showMessage("用户组已删除");
      return;
    }
    if (!event.target.closest("button, input")) {
      $("#adminView").dataset.selectedGroup = row.dataset.groupId;
      await loadAdminUsers();
    }
  });
  $("#adminUserGroupForm").addEventListener("reset", () => { $("#adminSaveGroupBtn").textContent = "新增用户组"; });
  // Admin user list: inline edit/delete/add
  $("#adminUsersList").addEventListener("click", async (event) => {
    const add = event.target.closest("[data-add-user-row]");
    const row = event.target.closest(".admin-member-row");
    if (add) {
      expandNewAdminUserRow(event.target.closest(".admin-member-add-row"));
      return;
    }
    if (!row) return;
    const edit = event.target.closest("[data-edit-user]");
    const save = event.target.closest("[data-save-user-row]");
    const cancel = event.target.closest("[data-cancel-user-row]");
    const remove = event.target.closest("[data-delete-user]");
    if (edit) {
      setAdminUserRowEditing(row, true);
      return;
    }
    if (cancel) {
      restoreAdminUserRow(row);
      return;
    }
    if (save) {
      const isNew = row.dataset.newUser === "1";
      const username = row.querySelector("input[name='username']").value.trim();
      const groupId = row.querySelector("select[name='group_id']").value;
      const password = row.querySelector("input[name='password']").value.trim();
      if (!username) {
        showMessage("账号不能为空", "error");
        row.querySelector("input[name='username']").focus();
        return;
      }
      if (isNew && !password) {
        showMessage("新增成员需要填写初始密码", "error");
        row.querySelector("input[name='password']").focus();
        return;
      }
      const payload = {
        username,
        display_name: username,
        group_id: groupId ? Number(groupId) : null,
      };
      if (isNew) payload.role = "viewer";
      if (password) payload.password = password;
      const path = isNew ? "/api/users" : `/api/users/${row.dataset.userId}`;
      const method = isNew ? "POST" : "PUT";
      await api(path, { method, body: JSON.stringify(payload) });
      await loadAdminUsers();
      showMessage(isNew ? "成员已新增" : "成员已保存");
      return;
    }
    if (remove && window.confirm("确认删除该用户？")) {
      await api(`/api/users/${row.dataset.userId}`, { method: "DELETE" });
      await loadAdminUsers();
      showMessage("用户已删除");
    }
  });
  $("#adminUserForm").addEventListener("reset", () => { $("#adminUserForm").username.disabled = false; });
  // Admin storage settings save
  $("#adminStorageForm").storage_type.addEventListener("change", (event) => {
    toggleStorageConfigGroups(event.target.value);
  });
  $("#adminStorageForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      await api("/api/settings", { method: "PUT", body: JSON.stringify(payload), headers: {} });
      showMessage("存储配置已保存", "success");
    } catch (error) {
      showMessage(error.message, "error");
    }
  });
  // Admin email settings save
  $("#adminEmailForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      await api("/api/settings", { method: "PUT", body: JSON.stringify(payload), headers: {} });
      showMessage("邮箱配置已保存", "success");
    } catch (error) {
      showMessage(error.message, "error");
    }
  });

  $("#refreshBtn").addEventListener("click", () => loadCatalog().then(() => showMessage("已刷新")));
  $("#addProductBtn").addEventListener("click", () => openProductManage());
  $("#uploadBtn").addEventListener("click", () => $("#uploadDialog").showModal());
  $("#templateBtn").addEventListener("click", () => openTemplateDialog());
  $("#templateAddParamBtn").addEventListener("click", () => openParameterDialog());
  $("#closeProductBtn").addEventListener("click", () => $("#productDialog").close());
  $("#cancelProductBtn").addEventListener("click", () => $("#productDialog").close());
  $("#closeParamBtn").addEventListener("click", () => $("#paramDialog").close());
  $("#cancelParamBtn").addEventListener("click", () => $("#paramDialog").close());
  $("#closeTemplateBtn").addEventListener("click", () => $("#templateDialog").close());
  $("#saveProductBtn").addEventListener("click", () => saveProduct().catch((error) => showMessage(error.message, "error")));
  $("#closeProductManageBtn").addEventListener("click", () => $("#productManageDialog").close());
  $("#saveManageProductBtn").addEventListener("click", () => saveManageProduct().catch((error) => showMessage(error.message, "error")));
  $("#productManageList").addEventListener("click", async (event) => {
    const edit = event.target.closest("[data-edit-product]");
    const remove = event.target.closest("[data-delete-product]");
    if (edit) {
      const product = state.catalog.products.find((item) => item.id === Number(edit.dataset.editProduct));
      if (product) openProductDialog(product);
    }
    if (remove && window.confirm(`确认删除产品 ${remove.closest(".user-item").querySelector("strong").textContent}？相关参数值也会一并删除。`)) {
      await api(`/api/products/${remove.dataset.deleteProduct}`, { method: "DELETE" });
      await loadCatalog();
      renderProductManageList();
      showMessage("产品已删除");
    }
  });
  $("#saveParamBtn").addEventListener("click", () => saveParameter().catch((error) => showMessage(error.message, "error")));
  $("#submitUploadBtn").addEventListener("click", () => submitUpload().catch((error) => showMessage(error.message, "error")));
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

  // --- template drag-sort (groups + parameters) ---
  let templateDragSource = null;
  let templateDragType = null; // 'group' | 'param'

  $("#templateList").addEventListener("dragstart", (event) => {
    // Check group header: drag from h3 inside .template-group
    const h3 = event.target.closest("h3");
    if (h3 && h3.closest(".template-group")) {
      const groupEl = h3.closest(".template-group");
      templateDragSource = groupEl;
      templateDragType = "group";
      groupEl.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", groupEl.dataset.groupId);
      return;
    }
    // Check parameter row: drag from .template-item (but not buttons)
    const paramEl = event.target.closest(".template-item");
    if (paramEl && !event.target.closest("button")) {
      templateDragSource = paramEl;
      templateDragType = "param";
      paramEl.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", paramEl.dataset.paramId);
      return;
    }
    event.preventDefault();
  });

  $("#templateList").addEventListener("dragend", () => {
    if (templateDragSource) templateDragSource.classList.remove("dragging");
    templateDragSource = null;
    templateDragType = null;
    $$("#templateList .drag-over").forEach((el) => el.classList.remove("drag-over"));
  });

  $("#templateList").addEventListener("dragover", (event) => {
    event.preventDefault();
    if (!templateDragType) return;
    event.dataTransfer.dropEffect = "move";
    // Clear all highlights, then set on current target
    $$("#templateList .drag-over").forEach((el) => el.classList.remove("drag-over"));
    if (templateDragType === "group") {
      const groupEl = event.target.closest(".template-group");
      if (groupEl && groupEl !== templateDragSource) groupEl.classList.add("drag-over");
    } else if (templateDragType === "param") {
      const paramEl = event.target.closest(".template-item");
      if (paramEl && paramEl !== templateDragSource && paramEl.dataset.groupId === templateDragSource.dataset.groupId) {
        paramEl.classList.add("drag-over");
      }
    }
  });

  $("#templateList").addEventListener("drop", async (event) => {
    event.preventDefault();
    if (!templateDragSource || !templateDragType) return;

    if (templateDragType === "group") {
      const target = event.target.closest(".template-group");
      if (!target || target === templateDragSource) return;
      const allGroups = $$("#templateList .template-group");
      const groupId = Number(templateDragSource.dataset.groupId);
      const targetGroupId = Number(target.dataset.groupId);
      const targetGroup = state.catalog.groups.find((g) => g.id === targetGroupId);
      const newSort = targetGroup ? targetGroup.sort_order : 10;
      try {
        await api(`/api/groups/${groupId}`, { method: "PUT", body: JSON.stringify({ sort_order: newSort }) });
        const ordered = allGroups.map((el) => Number(el.dataset.groupId));
        const movedIndex = ordered.indexOf(groupId);
        const newIndex = ordered.indexOf(targetGroupId);
        if (movedIndex >= 0) ordered.splice(movedIndex, 1);
        ordered.splice(newIndex, 0, groupId);
        await Promise.all(ordered.map((id, i) =>
          api(`/api/groups/${id}`, { method: "PUT", body: JSON.stringify({ sort_order: (i + 1) * 10 }) })
        ));
        await loadCatalog();
        renderTemplateList();
        showMessage("分组排序已保存");
      } catch (error) {
        showMessage(error.message, "error");
      }
      return;
    }

    if (templateDragType === "param") {
      const target = event.target.closest(".template-item");
      if (!target || target === templateDragSource) return;
      // Only allow drag within the same group
      if (target.dataset.groupId !== templateDragSource.dataset.groupId) return;
      const group = target.closest(".template-group");
      const siblings = Array.from(group.querySelectorAll(".template-item"));
      const paramId = Number(templateDragSource.dataset.paramId);
      const newIndex = siblings.indexOf(target);
      const targetParam = state.catalog.parameters.find((p) => p.id === Number(target.dataset.paramId));
      const newSort = targetParam ? targetParam.sort_order : (newIndex + 1) * 10;
      try {
        await api(`/api/parameters/${paramId}`, { method: "PUT", body: JSON.stringify({ sort_order: newSort }) });
        const ordered = siblings.map((el) => Number(el.dataset.paramId));
        const movedIndex = ordered.indexOf(paramId);
        if (movedIndex >= 0) ordered.splice(movedIndex, 1);
        ordered.splice(newIndex, 0, paramId);
        await Promise.all(ordered.map((id, i) =>
          api(`/api/parameters/${id}`, { method: "PUT", body: JSON.stringify({ sort_order: (i + 1) * 10 }) })
        ));
        await loadCatalog();
        renderTemplateList();
        showMessage("参数排序已保存");
      } catch (error) {
        showMessage(error.message, "error");
      }
    }
  });
  // --- end template drag-sort ---

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

  // --- Image lightbox ---
  $("#selectionTable").addEventListener("click", (event) => {
    const img = event.target.closest(".product-visual img");
    if (img) {
      event.preventDefault();
      openLightbox(img);
    }
  });
  $("#lightboxClose").addEventListener("click", closeLightbox);
  $("#lightboxOverlay").addEventListener("click", (event) => {
    if (event.target === $("#lightboxOverlay")) closeLightbox();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("#lightboxOverlay").hasAttribute("hidden")) {
      closeLightbox();
    }
  });
}

bindEvents();
restoreSession();
