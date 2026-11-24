/* global fetch, FormData, localStorage, location, window, document, setTimeout, clearInterval, setInterval */
const TOKEN_KEY = 'collab.token';
const state = {
  token: localStorage.getItem(TOKEN_KEY) ?? '',
  me: null,
  board: null,
  projectId: null,
  featureId: null,
  ctx: null,
  signed: new Map(),
  timer: null,
  busy: false,
};

const $ = (selector) => document.querySelector(selector);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'value') node.value = value;
    else if (key === 'checked' || key === 'selected' || key === 'disabled') node[key] = Boolean(value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.hidden = true; }, 3200);
}

async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const finalHeaders = { ...headers };
  if (state.token) finalHeaders.authorization = `Bearer ${state.token}`;
  let payload = body;
  if (body !== undefined && !(body instanceof FormData)) {
    finalHeaders['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const response = await fetch(path, { method, headers: finalHeaders, body: payload });
  if (response.status === 401 && state.token) {
    logout(false);
    throw new Error('登录已失效，请重新注册/输入 token');
  }
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const data = await response.json();
      if (data?.error) message = data.error;
    } catch {
      // keep status
    }
    throw new Error(message);
  }
  return response.json();
}

function setSession(token) {
  state.token = token;
  localStorage.setItem(TOKEN_KEY, token);
}

function logout(showLogin = true) {
  state.token = '';
  state.me = null;
  state.board = null;
  state.ctx = null;
  state.projectId = null;
  state.featureId = null;
  state.signed.clear();
  localStorage.removeItem(TOKEN_KEY);
  clearInterval(state.timer);
  state.timer = null;
  if (showLogin) showLogin();
}

function showLogin(message = '') {
  $('#app').hidden = true;
  $('#login').hidden = false;
  const error = $('#login-error');
  if (message) {
    error.textContent = message;
    error.hidden = false;
  } else {
    error.hidden = true;
  }
}

function showApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#me').textContent = state.me ? `${state.me.name}${state.me.role ? ` · ${state.me.role}` : ''}` : '';
  startPolling();
}

function age(value) {
  if (!value) return '?';
  const delta = Date.now() - Date.parse(value);
  if (!Number.isFinite(delta) || delta < 0) return value;
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function statusClass(value) {
  if (value === 'done') return 'ok';
  if (value === 'blocked') return 'danger';
  if (value === 'idle') return '';
  return 'accent';
}

function badge(text, cls = '') {
  return el('span', { class: `badge ${cls}`.trim(), text });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function inlineMarkdown(line) {
  return escapeHtml(line)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

function renderMarkdown(source) {
  const lines = String(source).split(/\r?\n/);
  const html = [];
  let inCode = false;
  let inList = false;
  const closeList = () => {
    if (inList) {
      html.push('</ul>');
      inList = false;
    }
  };
  for (const line of lines) {
    if (line.startsWith('```')) {
      if (inCode) {
        html.push('</code></pre>');
        inCode = false;
      } else {
        closeList();
        html.push('<pre><code>');
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      html.push(`${escapeHtml(line)}\n`);
      continue;
    }
    if (/^#{1,3}\s/.test(line)) {
      closeList();
      const level = line.match(/^#+/)[0].length;
      html.push(`<h${level}>${inlineMarkdown(line.replace(/^#{1,3}\s/, ''))}</h${level}>`);
      continue;
    }
    if (/^\s*[-*]\s/.test(line)) {
      if (!inList) {
        html.push('<ul>');
        inList = true;
      }
      html.push(`<li>${inlineMarkdown(line.replace(/^\s*[-*]\s/, ''))}</li>`);
      continue;
    }
    closeList();
    if (line.trim() === '') {
      continue;
    }
    html.push(`<p>${inlineMarkdown(line)}</p>`);
  }
  closeList();
  if (inCode) html.push('</code></pre>');
  return html.join('\n');
}

async function signedUrl(artifactId) {
  const cached = state.signed.get(artifactId);
  if (cached && cached.expiresAt - Date.now() > 60000) return cached.url;
  const { url, expiresAt } = await api(`/api/artifacts/${encodeURIComponent(artifactId)}/url`);
  state.signed.set(artifactId, { url, expiresAt: expiresAt ?? Date.now() + 9 * 60 * 1000 });
  return url;
}

async function signedText(artifactId) {
  const url = await signedUrl(artifactId);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`读取产物失败：HTTP ${response.status}`);
  return response.text();
}

function startPolling() {
  clearInterval(state.timer);
  state.timer = setInterval(async () => {
    if (!state.token || state.busy) return;
    try {
      await refreshBoard(true);
      if (state.featureId) await refreshContext(true);
    } catch {
      // polling failure should not disrupt the page
    }
  }, 15000);
}

async function refreshBoard(quiet = false) {
  const board = await api('/api/board');
  state.board = board;
  if (!state.projectId && board.projects.length) {
    state.projectId = board.projects[0].id;
  }
  if (state.projectId && !board.projects.some((project) => project.id === state.projectId)) {
    state.projectId = board.projects[0]?.id ?? null;
  }
  const project = board.projects.find((item) => item.id === state.projectId);
  const features = project?.features ?? [];
  if (state.featureId && !features.some((feature) => feature.id === state.featureId)) {
    state.featureId = features[0]?.id ?? null;
  }
  if (!state.featureId && features.length) state.featureId = features[0].id;
  renderSidebar();
  if (state.featureId) {
    await refreshContext(quiet);
  } else {
    renderDetail();
  }
}

function renderSidebar() {
  const projectWrap = $('#projects');
  projectWrap.replaceChildren();
  const projects = state.board?.projects ?? [];
  if (!projects.length) {
    projectWrap.append(el('div', { class: 'muted', text: '还没有项目。项目 / feature 由 Agent 或 CLI 创建。' }));
  }
  for (const project of projects) {
    const active = project.id === state.projectId;
    const button = el(
      'button',
      { class: `project-item${active ? ' active' : ''}`, type: 'button', onClick: () => selectProject(project.id) },
      el('span', { class: 'name', text: project.name }),
      el('span', { class: 'meta', text: `${project.id} · ${project.features.length} feature(s)${project.owner ? ` · ${project.owner}` : ''}` }),
    );
    projectWrap.append(button);
  }
  const project = projects.find((item) => item.id === state.projectId);
  const featureWrap = $('#features');
  featureWrap.replaceChildren();
  if (!project) {
    featureWrap.append(el('div', { class: 'muted', text: '先选择项目。' }));
    return;
  }
  if (!project.features.length) {
    featureWrap.append(el('div', { class: 'muted', text: '这个项目还没有 feature。' }));
  }
  for (const feature of project.features) {
    const button = el(
      'button',
      { class: `feature-item${feature.id === state.featureId ? ' active' : ''}`, type: 'button', onClick: () => selectFeature(feature.id) },
      el('span', { class: 'title', text: `${feature.id} · ${feature.title}` }),
      el('span', {
        class: 'meta',
        text: `${feature.statuses.length} 状态 · ${feature.artifactCount} 产物 · ${feature.openQuestions} 问题`,
      }),
    );
    featureWrap.append(button);
  }
}

function selectProject(projectId) {
  state.projectId = projectId;
  const project = state.board?.projects.find((item) => item.id === projectId);
  state.featureId = project?.features[0]?.id ?? null;
  state.ctx = null;
  renderSidebar();
  if (state.featureId) void refreshContext(false);
  else renderDetail();
}

function selectFeature(featureId) {
  state.featureId = featureId;
  state.ctx = null;
  renderSidebar();
  void refreshContext(false);
}

async function refreshContext(quiet = false) {
  if (!state.featureId) {
    renderDetail();
    return;
  }
  const ctx = await api(`/api/features/${encodeURIComponent(state.featureId)}/context`);
  state.ctx = ctx;
  renderDetail();
}

function renderDetail() {
  const detail = $('#detail');
  detail.replaceChildren();
  const ctx = state.ctx;
  if (!ctx) {
    detail.append(el('div', { class: 'empty', text: '选择一个 feature 查看。' }));
    return;
  }
  const feature = ctx.feature;
  const project = ctx.project;
  const statuses = ctx.statuses ?? [];

  const head = el(
    'div',
    { class: 'feature-head' },
    el(
      'div',
      {},
      el('h1', { text: `${feature.id} · ${feature.title}` }),
      el('div', { class: 'sub', text: `${project?.name ?? feature.projectId} · ${feature.repos?.join(', ') || '未指定仓库'} · ${feature.owner ?? '?'}` }),
    ),
    el(
      'div',
      { class: 'badges' },
      ...statuses.map((status) => badge(`${status.member} · ${status.state}`, statusClass(status.state))),
      feature.openQuestions ? badge(`${feature.openQuestions} 个未决问题`, 'warn') : null,
    ),
  );
  detail.append(head);

  if (feature.brief) {
    detail.append(el('section', { class: 'panel' }, el('h2', { text: '目标 / 非目标' }), el('div', { class: 'brief', text: feature.brief })));
  }

  detail.append(renderArtifacts(ctx));

  const grid = el('div', { class: 'grid2' });
  grid.append(renderMembers(ctx), renderQuestions(ctx));
  detail.append(grid, renderEvents(ctx));
}

function renderMembers(ctx) {
  const panel = el('section', { class: 'panel' }, el('h2', { text: '成员状态' }));
  const wrap = el('div', { class: 'members' });
  if (!ctx.statuses?.length) wrap.append(el('div', { class: 'muted', text: '还没有人更新状态。' }));
  for (const status of ctx.statuses ?? []) {
    const row = el(
      'div',
      { class: 'member' },
      el('div', {}, el('div', { class: 'name', text: `${status.member}${status.role ? ` · ${status.role}` : ''}` }), el('div', { class: 'state', text: status.state })),
      el('div', { class: 'muted', text: age(status.updatedAt) }),
      status.focus ? el('div', { class: 'focus', text: status.focus }) : null,
      status.blocker ? el('div', { class: 'blocker', text: `阻塞：${status.blocker}` }) : null,
      status.stale ? el('div', { class: 'stale', text: '状态可能已过期' }) : null,
    );
    wrap.append(row);
  }
  panel.append(wrap);
  return panel;
}

function renderArtifacts(ctx) {
  const panel = el('section', { class: 'panel' }, el('h2', { text: '设计 / 报告产物' }));
  const list = el('div', { class: 'artifacts' });
  const artifacts = ctx.artifacts ?? [];
  if (!artifacts.length) {
    list.append(el('div', { class: 'muted', text: '还没有产物。上传图片、HTML 或 Markdown，另一边的 agent 就能看到摘要。' }));
  }
  for (const artifact of artifacts) list.append(artifactCard(artifact));
  panel.append(list);
  return panel;
}

function artifactCard(artifact) {
  const card = el('div', { class: 'artifact' });
  card.append(
    el(
      'div',
      { class: 'artifact-head' },
      el('div', {}, el('div', { class: 'name', text: artifact.filename }), el('div', { class: 'meta', text: `${artifact.kind} · v${artifact.version} · ${artifact.author} · ${age(artifact.createdAt)}` })),
      el('div', { class: 'muted', text: `${(artifact.size / 1024).toFixed(1)} KB` }),
    ),
  );
  card.append(el('div', { class: 'artifact-summary', text: artifact.summary }));
  const body = el('div', { class: 'artifact-body' });
  card.append(body);

  if (artifact.mime?.startsWith('image/')) {
    const image = el('img', { alt: artifact.filename });
    body.append(image);
    void signedUrl(artifact.id).then((url) => { image.src = url; }).catch((error) => {
      body.append(el('div', { class: 'error', text: error.message }));
    });
    return card;
  }
  if (artifact.mime === 'text/markdown') {
    const view = el('div', { class: 'markdown', text: '读取中…' });
    body.append(view);
    void signedText(artifact.id).then((text) => { view.innerHTML = renderMarkdown(text); }).catch((error) => {
      view.textContent = error.message;
    });
    return card;
  }
  if (artifact.mime === 'text/html') {
    const preview = el('button', { class: 'small', type: 'button', text: '打开 HTML 预览' });
    const source = el('button', { class: 'small secondary', type: 'button', text: '查看源码' });
    const frameHost = el('div');
    preview.addEventListener('click', async () => {
      const url = await signedUrl(artifact.id);
      window.open(url, '_blank', 'noopener');
    });
    source.addEventListener('click', async () => {
      frameHost.replaceChildren(el('div', { class: 'muted', text: '读取中…' }));
      try {
        const text = await signedText(artifact.id);
        frameHost.replaceChildren(el('pre', { class: 'raw', text }));
      } catch (error) {
        frameHost.replaceChildren(el('div', { class: 'error', text: error.message }));
      }
    });
    body.append(el('div', { class: 'toolbar' }, preview, source), frameHost);
    return card;
  }
  const link = el('a', { href: '#', class: 'small', text: '下载 / 打开' });
  link.addEventListener('click', async (event) => {
    event.preventDefault();
    const url = await signedUrl(artifact.id);
    window.open(url, '_blank', 'noopener');
  });
  body.append(link);
  return card;
}

function renderQuestions(ctx) {
  const panel = el('section', { class: 'panel' }, el('h2', { text: '问题' }));
  const list = el('div', { class: 'questions' });
  const questions = ctx.questions ?? [];
  if (!questions.length) list.append(el('div', { class: 'muted', text: '还没有问题。有分歧就留一个问题，不要自己替对方做决定。' }));
  for (const question of questions) {
    const item = el('div', { class: `question ${question.status}` });
    item.append(el('div', { class: 'qmeta', text: `${question.author} · ${age(question.createdAt)}${question.status === 'answered' ? ` · ${question.answeredByName}` : ''}` }));
    item.append(el('div', { class: 'q', text: question.text }));
    if (question.status === 'open') {
      item.append(el('div', { class: 'muted', text: '等待 Agent 回答' }));
    } else {
      item.append(el('div', { class: 'answer' }, el('div', { class: 'alabel', text: '回答' }), el('div', { text: question.answer })));
    }
    list.append(item);
  }
  panel.append(list);
  return panel;
}

function renderEvents(ctx) {
  const panel = el('section', { class: 'panel' }, el('h2', { text: '最近变更' }));
  const list = el('div', { class: 'events' });
  const events = (ctx.events ?? []).slice(-15).reverse();
  if (!events.length) list.append(el('div', { class: 'muted', text: '暂无变更。' }));
  for (const event of events) {
    const payload = event.payload?.summary ?? event.payload?.text ?? event.payload?.note ?? event.payload?.state ?? '';
    list.append(el('div', { text: `#${event.id} ${event.type}${payload ? ` · ${payload}` : ''} · ${age(event.createdAt)}` }));
  }
  panel.append(list);
  return panel;
}

function bindUi() {
  $('#token-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const token = new FormData(event.currentTarget).get('token').trim();
    if (!token) return;
    setSession(token);
    try {
      const { member } = await api('/api/me');
      state.me = member;
      showApp();
      await refreshBoard(false);
    } catch (error) {
      logout();
      showLogin(error.message);
    }
  });

  $('#logout').addEventListener('click', () => logout());
}

void boot();
