// ---- utils ----
const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(typeof ts === 'number' ? ts : ts);
  const now = new Date();
  const diff = (now - d) / 86400000;
  if (diff < 1) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diff < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
function formatTokens(n) {
  if (n >= 1e6) return (n/1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n/1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}
function formatCost(c) { return c ? (c < 0.01 ? '$'+c.toFixed(4) : '$'+c.toFixed(2)) : '$0'; }
function basename(p) { return (p || '').split('/').filter(Boolean).pop() || p; }
function shortModel(m) { return m ? (m.name || `${m.provider}/${m.id}`) : '—'; }

// ---- rendering ----
// Escape first, then apply the inline markdown subset. Doing it the other way
// round escapes the tags we just emitted, so `<code>` shows up as literal text.
function inlineMd(s) {
  let out = esc(s);
  out = out.replace(/`([^`]+)`/g, (_, x) => `<code>${x}</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return out.replace(/\n/g, '<br>');
}

function renderInline(text) {
  return inlineMd(text);
}

// Block-level pass: fenced code stays verbatim, "- " / "1. " become real lists,
// blank lines split paragraphs. Without this, agent answers arrive as one wall of
// <br>-separated text.
function renderBlocks(text) {
  const parts = [];
  const re = /```([\w-]*)\n([\s\S]*?)```/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    parts.push(textBlocks(text.slice(last, m.index)));
    parts.push(`<pre><code>${esc(m[2])}</code></pre>`);
    last = m.index + m[0].length;
  }
  parts.push(textBlocks(text.slice(last)));
  return parts.join('');
}

function textBlocks(t) {
  if (!t.trim()) return '';
  const out = [];
  let para = [];
  let list = null;
  const flushPara = () => {
    if (para.length) { out.push(`<p>${inlineMd(para.join('\n'))}</p>`); para = []; }
  };
  const flushList = () => {
    if (!list) return;
    const tag = list.ordered ? 'ol' : 'ul';
    out.push(`<${tag}>` + list.items.map((i) => `<li>${inlineMd(i)}</li>`).join('') + `</${tag}>`);
    list = null;
  };
  for (const line of t.split('\n')) {
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
      const ordered = !!ol;
      if (!list || list.ordered !== ordered) { flushList(); list = { ordered, items: [] }; }
      list.items.push((ul || ol)[1]);
      continue;
    }
    flushList();
    if (!line.trim()) { flushPara(); continue; }
    para.push(line);
  }
  flushList();
  flushPara();
  return out.join('');
}
// Render an ImageContent blob as an <img>. Accepts either raw base64 + mimeType
// or a pre-built dataUrl. Also tolerates external http(s) URLs (e.g. from
// tool results that return URLs).
function imageDataUrl(blk) {
  if (!blk) return '';
  if (blk.dataUrl && typeof blk.dataUrl === 'string') return blk.dataUrl;
  if (blk.data && blk.mimeType) return `data:${blk.mimeType};base64,${blk.data}`;
  if (typeof blk === 'string' && /^https?:\/\//.test(blk)) return blk;
  return '';
}
function renderImage(blk) {
  const src = imageDataUrl(blk);
  if (!src) return '';
  const alt = esc(blk.fileName || blk.name || 'image');
  return `<div class="img-block"><img src="${src}" alt="${alt}" loading="lazy" title="${alt}" /></div>`;
}

function renderContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return renderInline(content);
  if (!Array.isArray(content)) return esc(String(content));
  return content.map(blk => {
    if (blk.type === 'text') return renderBlocks(blk.text);
    if (blk.type === 'thinking') return `<div class="think">${esc(blk.thinking || '')}</div>`;
    if (blk.type === 'image') return renderImage(blk);
    if (blk.type === 'toolCall') {
      const args = typeof blk.arguments === 'string' ? blk.arguments : JSON.stringify(blk.arguments, null, 2);
      return `<div class="tool-block"><span class="name">⟳ ${esc(blk.name || 'tool')}</span><pre style="margin:6px 0 0">${esc(args)}</pre></div>`;
    }
    // fallback: stringify unknown blocks
    return `<pre>${esc(JSON.stringify(blk, null, 2))}</pre>`;
  }).join('');
}

// User messages from pi can be a string, an array of blocks, or (historically)
// an object carrying an `attachments` array of Attachment objects. Flatten all
// of those into a single renderable string of HTML.
function renderUserMessage(msg) {
  const parts = [];
  const c = msg?.content;
  if (typeof c === 'string') parts.push(renderBlocks(c));
  else if (Array.isArray(c)) parts.push(renderContent(c));
  // legacy / future: attachments array
  if (Array.isArray(msg?.attachments)) {
    for (const a of msg.attachments) {
      if (a?.type === 'image') {
        const blk = a.content && typeof a.content === 'string'
          ? { data: a.content, mimeType: a.mimeType, fileName: a.fileName }
          : a;
        parts.push(renderImage(blk));
      }
    }
  }
  return parts.join('');
}

// ---- state ----
let ws, streaming = false, streamEl = null, streamBuf = '', thinkBuf = '';
let allSessions = [], allProjects = [], allModelsCache = [], currentCwd = null;
let scopedIds = null; // null = all enabled; string[] = explicit list ("provider/id")
// Pending image attachments for the next prompt. Each: { id, mimeType, dataUrl, fileName, size }
let pendingAttachments = [];
// Count of FileReader operations currently in flight; send() awaits this reaching 0
// so that clicking Send immediately after picking a large image doesn't race.
let pendingReads = 0;
function whenReadsDone() {
  if (pendingReads <= 0) return Promise.resolve();
  return new Promise(resolve => {
    const tick = () => {
      if (pendingReads <= 0) return resolve();
      setTimeout(tick, 50);
    };
    tick();
  });
}

const messagesEl = $('#messages'), inputEl = $('#input');
const btnSend = $('#btn-send');
const composerEl = $('#composer');
const attachmentsEl = document.createElement('div');
attachmentsEl.className = 'attachments hidden';
attachmentsEl.id = 'attachments';
composerEl.insertBefore(attachmentsEl, composerEl.firstChild);
const fileInputEl = document.createElement('input');
fileInputEl.type = 'file';
fileInputEl.accept = 'image/*';
fileInputEl.multiple = true;
fileInputEl.style.display = 'none';
document.body.appendChild(fileInputEl);
const attachBtn = document.createElement('button');
attachBtn.type = 'button';
attachBtn.className = 'attach-btn';
attachBtn.title = 'Attach images (or paste/drag into the input)';
attachBtn.innerHTML = '📎';
attachBtn.setAttribute('aria-label', 'Attach images');
composerEl.appendChild(attachBtn);
const modelLabel = $('#model-label'), modelMenu = $('#model-menu'), modelPill = $('#model-pill');
const thinkingLabel = $('#thinking-label'), thinkingMenu = $('#thinking-menu'), thinkingPill = $('#thinking-pill');
const chatTitle = $('#chat-title'), chatMeta = $('#chat-meta');
const sessionsEl = $('#current-sessions');
const otherProjectsEl = $('#other-projects');
const otherToggle = $('#other-toggle'), otherCaret = $('#other-caret');
const sessSearch = $('#sess-search');
const projName = $('#proj-name'), projPath = $('#proj-path'), projSwitch = $('#proj-switch'), projMenu = $('#proj-menu'), projRow = $('#project-row');
const folderPicker = $('#folder-picker');
const footerStatus = $('#footer-status');
const ctxMenu = $('#ctx-menu');
const modalOverlay = $('#modal-overlay'), modalTitle = $('#modal-title'), modalBody = $('#modal-body'), modalActions = $('#modal-actions');

// ---- Modal helper ----
function showModal(title, bodyHtml, actions) {
  // Reset per-modal layout tweaks so every dialog starts from the narrow default.
  modalOverlay.querySelector('.modal')?.classList.remove('wide');
  modalBody.classList.remove('mm-body');
  modalTitle.textContent = title;
  modalBody.innerHTML = bodyHtml;
  modalActions.innerHTML = '';
  for (const a of actions || [{label:'OK',primary:true}]) {
    const b = document.createElement('button');
    b.textContent = a.label;
    if (a.primary) b.className = 'primary';
    b.onclick = () => { const r = a.onClick?.(modalBody); if (r !== false) closeModal(); };
    modalActions.appendChild(b);
  }
  modalOverlay.classList.remove('hidden');
  setTimeout(() => { const inp = modalBody.querySelector('input[type=text]'); inp?.focus(); inp?.select(); }, 30);
}
function closeModal() { modalOverlay.classList.add('hidden'); }
modalOverlay.addEventListener('click', e => { if (e.target === modalOverlay) closeModal(); });
// ---- message UI ----
let roundCounter = 0;

function addMessage(role, content, opts) {
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + role;
  // Anchor every user turn so the round rail can jump to it.
  if (role === 'user') wrap.dataset.round = String(roundCounter++);
  let bodyHtml;
  if (content && typeof content === 'object' && !Array.isArray(content) && content.role) {
    // Caller passed a full message object (m.role, m.content).
    if (content.role === 'user') bodyHtml = renderUserMessage(content);
    else bodyHtml = renderContent(content.content);
  } else {
    bodyHtml = renderContent(content);
  }
  if (opts?.classList) for (const cl of opts.classList) wrap.classList.add(cl);
  const msgObj = (content && typeof content === 'object' && content.role) ? content : null;
  wrap.innerHTML = `
    <div class="role-row">
      <div class="avatar">${role === 'user' ? 'Y' : 'π'}</div>
      <div class="who">${role === 'user' ? 'You' : 'π'}</div>
    </div>
    <div class="body">${bodyHtml}</div>`;
  if (msgObj) wrap._src = msgObj;
  if (role === 'assistant') wrap.appendChild(msgFooter(wrap, msgObj));
  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return wrap.querySelector('.body');
}
// Footer under every assistant message: copy, like/dislike (UI only), and what
// produced it — model, tokens, wall time.
function msgFooter(wrap, msg) {
  const f = document.createElement('div');
  f.className = 'msg-foot';
  const model = msg?.model || msg?.modelId || '';
  const usage = msg?.usage || {};
  const bits = [];
  if (model) bits.push(esc(String(model)));
  if (usage.input || usage.output) {
    bits.push(`${((usage.input || 0) + (usage.output || 0)).toLocaleString()} tok`);
  }
  const copy = document.createElement('button');
  copy.className = 'mf-btn';
  copy.title = '复制这条消息';
  copy.textContent = '⧉';
  copy.onclick = async () => {
    const text = wrap.querySelector('.body')?.innerText || '';
    try { await navigator.clipboard.writeText(text); copy.textContent = '✓'; }
    catch { copy.textContent = '×'; }
    setTimeout(() => (copy.textContent = '⧉'), 1400);
  };

  const up = document.createElement('button');
  up.className = 'mf-btn';
  up.title = '有帮助';
  up.textContent = '▲';
  const down = document.createElement('button');
  down.className = 'mf-btn';
  down.title = '没帮助';
  down.textContent = '▼';
  const vote = (el, other) => (ev) => {
    ev.stopPropagation();
    const on = el.classList.toggle('on');
    if (on) other.classList.remove('on');
  };
  up.onclick = vote(up, down);
  down.onclick = vote(down, up);

  f.appendChild(copy);
  f.appendChild(up);
  f.appendChild(down);
  if (bits.length) {
    const meta = document.createElement('span');
    meta.className = 'mf-meta';
    meta.innerHTML = bits.join(' · ');
    f.appendChild(meta);
  }
  return f;
}

function beginStream() {
  if (streamEl) return;
  streaming = true; btnSend.disabled = true;
  footerStatus.innerHTML = '<span class="dot"></span>thinking…';
  streamBuf = ''; thinkBuf = '';
  streamEl = addMessage('assistant', '');
}
function updateStreamText(t) {
  streamBuf += t || '';
  if (!streamEl) return;
  let html = '';
  if (thinkBuf) html += `<div class="think">${esc(thinkBuf)}</div>`;
  html += renderInline(streamBuf);
  streamEl.innerHTML = html;
  messagesEl.scrollTop = messagesEl.scrollHeight;
}
function updateStreamThink(t) {
  thinkBuf += t || '';
  if (!streamEl) return;
  const el = streamEl.querySelector('.think') || (() => {
    const d = document.createElement('div'); d.className = 'think'; streamEl.insertBefore(d, streamEl.firstChild); return d;
  })();
  el.textContent = thinkBuf;
}
function endStream() {
  streaming = false; btnSend.disabled = false;
  footerStatus.textContent = '';
  streamEl = null; streamBuf = ''; thinkBuf = '';
}

// Track the most recent user bubble we optimistically appended so we can remove
// it if the server rejects the prompt (model doesn't support images, etc.).
let lastUserBubble = null;
function handlePromptError(message) {
  // Remove optimistic user bubble if present so it doesn't look like a real
  // (ghost) message that pi never saw.
  if (lastUserBubble && lastUserBubble.parentNode) lastUserBubble.remove();
  lastUserBubble = null;
  // Put the attachments back so the user can retry / switch model without
  // having to paste/drag the images again.
  if (lastAttemptAttachments && lastAttemptAttachments.length) {
    pendingAttachments = lastAttemptAttachments.slice();
    renderAttachments();
  }
  // Restore the text the user typed so they don't lose it.
  if (lastAttemptText && !inputEl.value) { inputEl.value = lastAttemptText; autoGrow(); }
  lastAttemptText = ''; lastAttemptAttachments = null;
  endStream();
  showErrorToast(String(message));
  // Re-sync stats/session list.
  refreshSessions(); refreshStats();
}
let lastAttemptText = '';
let lastAttemptAttachments = null;
function showToast(message, ok = false) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = message;
  t.classList.toggle('ok', !!ok);
  t.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.remove('show'), ok ? 3000 : 6000);
}
function showErrorToast(message) { showToast(message, false); }

// ---- REST ----
async function jget(p) { const r = await fetch(p); if (!r.ok) throw new Error(await r.text()); return r.json(); }
async function jpost(p, b) {
  const r = await fetch(p, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(b||{}) });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// ---- WS ----
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = ev => {
    const e = JSON.parse(ev.data);
    switch (e.type) {
      case 'hello': refreshAll(); break;
      case 'project_switched': currentCwd = e.cwd; refreshAll(); messagesEl.innerHTML = ''; break;
      // RPC command response (for prompt/steer/fork/etc).
      // success:false means the prompt was rejected server-side (e.g. model does not
      // support images, streaming conflict, bad args) — surface to the user.
      case 'response': {
        if (e.success === false && e.command === 'prompt') {
          handlePromptError(e.error || 'Prompt rejected');
        }
        break;
      }
      // Server-side caught error (rpc.send promise rejection path in index.ts).
      case 'error': {
        handlePromptError(e.message || e.error || 'Unknown error');
        break;
      }
      case 'agent_start':
        // Prompt was accepted — clear retry state, keep the optimistic bubble.
        lastAttemptText = ''; lastAttemptAttachments = null; lastUserBubble = null;
        beginStream(); break;
      case 'message_update': {
        const d = e.delta || e.assistantMessageEvent;
        if (!d) break;
        if (d.type === 'text_delta') updateStreamText(d.delta);
        else if (d.type === 'thinking_delta') updateStreamThink(d.delta);
        else if (d.type === 'error') {
          handlePromptError(d.error?.message || d.error || d.reason || 'Generation error');
        }
        break;
      }
      case 'tool_execution_end': {
        // Tool results can include image content (read-image, screenshots, etc.).
        // Append inline so images appear live without a full reload.
        const result = e.result;
        const images = Array.isArray(result?.content) ? result.content.filter(b => b && b.type === 'image') : [];
        if (images.length) {
          const wrap = document.createElement('div');
          wrap.className = 'msg tool-result';
          wrap.innerHTML = `<div class="body"><div class="tool-block"><span class="name">⟳ ${esc(e.toolName || 'tool')} result</span></div>${renderContent(images)}</div>`;
          messagesEl.appendChild(wrap);
          messagesEl.scrollTop = messagesEl.scrollHeight;
        }
        break;
      }
      case 'message_end':
        if (e.message?.role === 'assistant') {
          // Surface provider/runtime errors returned as an assistant message
          // with stopReason "error" — e.g. image-too-small from Volcengine.
          if (e.message.stopReason === 'error' && e.message.errorMessage) {
            handlePromptError(e.message.errorMessage);
            break;
          }
          if (streamEl) {
            streamEl.innerHTML = renderContent(e.message.content);
            messagesEl.scrollTop = messagesEl.scrollHeight;
          } else addMessage('assistant', e.message.content);
          // Clear retry state on a successful assistant turn too.
          lastAttemptText = ''; lastAttemptAttachments = null; lastUserBubble = null;
          endStream();
        }
        refreshSessions(); break;
      case 'tool_start': {
        const d = document.createElement('div');
        d.className = 'msg';
        d.innerHTML = `<div class="body"><div class="tool-block"><span class="name">⟳ ${esc(e.toolName)}</span></div></div>`;
        messagesEl.appendChild(d); messagesEl.scrollTop = messagesEl.scrollHeight;
        break;
      }
      case 'agent_settled': endStream(); refreshSessions(); refreshStats(); break;
      case 'compaction_start': footerStatus.textContent = 'Compacting context…'; break;
      case 'compaction_end': footerStatus.textContent = 'Context compacted'; setTimeout(()=>footerStatus.textContent='', 2500); refreshStats(); break;
      case 'thinking_level_changed': thinkingLabel.textContent = e.level || ''; break;
      case 'session_start': refreshAll(); messagesEl.innerHTML = ''; break;
      case 'exported': footerStatus.textContent = 'Exported to ' + (e.path||'file'); setTimeout(()=>footerStatus.textContent='', 4000); break;
      case 'session_name': chatTitle.textContent = e.name || 'New chat'; break;
    }
  };
  ws.onclose = () => { footerStatus.textContent = 'reconnecting…'; setTimeout(connect, 1500); };
  ws.onerror = () => {};
}

// ---- data loaders ----
async function refreshAll() { await Promise.all([refreshStats(), refreshModels(), refreshSessions(), renderAllMessages()]); }

async function renderAllMessages() {
  try {
    const [data, modelsData] = await Promise.all([
      jget('/api/messages'),
      jget('/api/models').catch(() => ({ models: [] })),
    ]);
    const list = (data.messages || []).filter(m => m && m.role !== 'toolResult');
    messagesEl.innerHTML = '';
    roundCounter = 0;

    if (list.length === 0) onboardingMode = false;
    if (list.length === 0) {
      // Nothing to show and no model to run: onboarding beats suggestions.
      if (!(modelsData.models || []).length) {
        renderNoModelState();
        return;
      }
      // empty state
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.innerHTML = `
        <h1>Hi, I'm π</h1>
        <p>Your coding agent in the browser. Pick a suggestion or start typing below.</p>
        <div class="suggestions">
          <div class="suggestion"><div class="label">🔍 探索代码库</div><div class="desc">总结当前项目的代码结构和架构</div></div>
          <div class="suggestion"><div class="label">🐛 修复 Bug</div><div class="desc">诊断并修复代码中的错误</div></div>
          <div class="suggestion"><div class="label">✨ 新增功能</div><div class="desc">实现新功能并编写测试</div></div>
          <div class="suggestion"><div class="label">📝 代码审查</div><div class="desc">分析现有代码并给出改进建议</div></div>
        </div>`;
      messagesEl.appendChild(empty);
      empty.querySelectorAll('.suggestion').forEach((el, i) => {
        const prompts = [
          '请简单介绍一下当前项目的代码结构',
          '帮我找出项目里可能存在的 bug',
          '给这个项目添加一个新功能',
          '审查一下最近改动的代码'
        ];
        el.onclick = () => {
          inputEl.value = prompts[i];
          autoGrow();
          inputEl.focus();
        };
      });
      return;
    }

    let firstUser = '';
    for (const m of list) {
      if (m.role === 'toolResult') {
        // Tool results can carry image content (e.g. read-image, screenshots).
        // Render them inline as a tool-flavoured bubble so images show up in chat.
        const hasImage = Array.isArray(m.content) && m.content.some(b => b.type === 'image');
        if (hasImage) {
          const toolWrap = document.createElement('div');
          toolWrap.className = 'msg tool-result';
          toolWrap.innerHTML = `<div class="body"><div class="tool-block"><span class="name">⟳ ${esc(m.toolName || 'tool')} result</span></div>${renderContent(m.content)}</div>`;
          messagesEl.appendChild(toolWrap);
        }
        continue;
      }
      if (!firstUser && m.role === 'user') {
        const c = m.content;
        firstUser = typeof c === 'string' ? c : (Array.isArray(c) ? (c.find(b=>b.type==='text')?.text||'') : '');
      }
      if (m.role === 'user' || m.role === 'assistant') addMessage(m.role, m);
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
    renderRoundRail();
    if (chatTitle.textContent === 'New chat' && firstUser) {
      const t = firstUser.replace(/\s+/g,' ').trim().slice(0, 80);
      chatTitle.textContent = t; document.title = t.slice(0, 50) + ' · π';
    }
  } catch {}
}

// ---- round rail: one tick per user turn, click to jump, highlight what is in view ----
const roundRail = document.getElementById('round-rail');
let roundTicks = [];

function renderRoundRail() {
  if (!roundRail) return;
  const turns = [...messagesEl.querySelectorAll('.msg.user')];
  roundRail.innerHTML = '';
  roundTicks = [];
  if (turns.length < 2) { roundRail.classList.remove('show'); return; }

  const total = Math.max(1, messagesEl.scrollHeight);
  turns.forEach((el, i) => {
    const tick = document.createElement('div');
    tick.className = 'round-tick';
    const c = el.querySelector('.body')?.textContent || '';
    tick.title = `${i + 1}. ${c.replace(/\s+/g, ' ').trim().slice(0, 80)}`;
    tick.onclick = () => {
      el.scrollIntoView({ block: 'start', behavior: 'smooth' });
      // offset for the sticky topbar
      messagesEl.scrollTop -= 12;
    };
    roundRail.appendChild(tick);
    roundTicks.push({ el, tick });
  });
  // Ticks grow with the turn's share of the conversation, so long answers get
  // more rail than one-liners.
  turns.forEach((el, i) => {
    const next = turns[i + 1];
    const span = ((next ? next.offsetTop : total) - el.offsetTop) / total;
    roundTicks[i].tick.style.height = Math.max(2, Math.round(span * 320)) + 'px';
  });
  roundRail.classList.add('show');
  updateActiveRound();
}

function updateActiveRound() {
  if (!roundTicks.length) return;
  const top = messagesEl.scrollTop + 40;
  let active = 0;
  for (let i = 0; i < roundTicks.length; i++) {
    if (roundTicks[i].el.offsetTop <= top) active = i;
  }
  roundTicks.forEach((t, i) => t.tick.classList.toggle('active', i === active));
}

messagesEl.addEventListener('scroll', () => {
  updateActiveRound();
  if (messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 40) {
    // remember: at the bottom we always want the latest turn highlighted
  }
}, { passive: true });

async function refreshStats() {
  try {
    const s = await jget('/api/stats');
    applyStats(s);
  } catch (e) {
    // fallback: use /api/state
    try {
      const st = await jget('/api/state');
      applyStats({ cwd: st.cwd, model: st.model, thinkingLevel: st.thinkingLevel, sessionName: st.sessionName, messages:{total:0}, tokens:{total:0}, cost:0, contextUsage:null });
    } catch (e2) { console.warn(e2); }
  }
}
function applyStats(s) {
  currentCwd = s.cwd || currentCwd;
  if (s.cwd) {
    projName.textContent = basename(s.cwd) || '~';
    projPath.textContent = s.cwd;
    projPath.title = s.cwd;
  }
  if (s.sessionName) { chatTitle.textContent = s.sessionName; document.title = s.sessionName + ' · π'; }
  chatMeta.innerHTML = '';
  const add = (l,v,t) => { if (v==null || v==='') return; const sp=document.createElement('span'); sp.innerHTML=`<b>${esc(l)}:</b> ${esc(v)}`; if (t) sp.title=t; chatMeta.appendChild(sp); };
  add('msgs', s.messages?.total);
  if (s.contextUsage?.contextWindow) {
    const pct = Math.round(s.contextUsage.percent ?? (s.contextUsage.tokens||0)/s.contextUsage.contextWindow*100);
    add('ctx', pct+'%', `${formatTokens(s.contextUsage.tokens||0)}/${formatTokens(s.contextUsage.contextWindow)} tokens`);
  }
  add('tokens', s.tokens ? formatTokens(s.tokens.total) : '0');
  add('cost', formatCost(s.cost));
  if (s.model) modelLabel.textContent = shortModel(s.model);
  if (s.thinkingLevel) thinkingLabel.textContent = s.thinkingLevel;
  footerStatus.textContent = '';
}

// A fresh install has no provider yet — every message would fail, so the first
// thing the page says is how to add one. Keys stay on this machine.
let onboardingMode = false;

function renderNoModelState() {
  // A first-run user has no files to browse; the tool panel just squeezes the
  // onboarding copy into a narrow column.
  onboardingMode = true;
  setWorkbar(false);
  const empty = document.createElement('div');
  empty.className = 'empty-state onboard';
  empty.innerHTML = `
    <h1>先配一个模型</h1>
    <p>pi-web 需要一个模型服务商才能干活。key 只写进本机的 <code>models.json</code>，不会上传到任何地方。</p>
    <div class="onboard-actions">
      <button class="primary" id="ob-config">配置模型</button>
      <button id="ob-refresh">已配好，刷新</button>
    </div>
    <p class="onboard-hint">支持 OpenAI 兼容 / Anthropic Messages / Google 等协议，本地 Ollama、vLLM 也可以。</p>`;
  messagesEl.appendChild(empty);
  empty.querySelector('#ob-config').onclick = () => openModelManager();
  empty.querySelector('#ob-refresh').onclick = () => refreshAll();
}

async function refreshModels() {
  try {
    const data = await jget('/api/models');
    allModelsCache = data.models || [];
    scopedIds = data.scopedIds ?? null;
    renderModelMenu();
  } catch {}
}
async function rpcSetModel(provider, id) {
  await jpost('/api/model', { provider, id });
}
function modelFullId(m) { return m.provider + '/' + m.id; }
function isModelEnabled(m) {
  if (scopedIds === null) return true;
  return scopedIds.includes(modelFullId(m));
}
async function setModelEnabled(m, enabled) {
  if (scopedIds === null && enabled) return;
  if (scopedIds === null) {
    scopedIds = allModelsCache.map(modelFullId).filter(id => id !== modelFullId(m));
  }
  const id = modelFullId(m);
  if (enabled && !scopedIds.includes(id)) scopedIds = [...scopedIds, id];
  else if (!enabled) scopedIds = scopedIds.filter(x => x !== id);
  if (scopedIds.length >= allModelsCache.length) scopedIds = null;
  await jpost('/api/scoped-models', scopedIds === null ? { all: true } : { ids: scopedIds });
  renderModelMenu();
}
function renderModelMenu() {
  modelMenu.innerHTML = '';

  // Determine which models to show: scoped if set, otherwise all
  const enabled = scopedIds === null ? allModelsCache : allModelsCache.filter(isModelEnabled);

  // Search input
  const searchWrap = document.createElement('div');
  searchWrap.style.cssText = 'padding:8px 10px 4px';
  const search = document.createElement('input');
  search.type = 'text'; search.placeholder = 'Search models…';
  search.style.cssText = 'width:100%;padding:7px 10px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:12px;outline:none;box-sizing:border-box';
  searchWrap.appendChild(search);
  modelMenu.appendChild(searchWrap);

  const listEl = document.createElement('div');
  modelMenu.appendChild(listEl);

  function renderList(q) {
    listEl.innerHTML = '';
    const needle = (q||'').toLowerCase();
    const byProv = {};
    for (const m of enabled) {
      if (needle && !m.id.toLowerCase().includes(needle) && !m.name.toLowerCase().includes(needle) && !m.provider.toLowerCase().includes(needle)) continue;
      (byProv[m.provider] = byProv[m.provider] || []).push(m);
    }
    const prefer = ['volcengine','doubao'];
    const entries = Object.entries(byProv).sort((a,b) => {
      const ia=prefer.indexOf(a[0]),ib=prefer.indexOf(b[0]);
      if(ia>=0&&ib>=0)return ia-ib;if(ia>=0)return-1;if(ib>=0)return1;
      return a[0].localeCompare(b[0]);
    });
    for (const [prov, list] of entries) {
      const hdr = document.createElement('div'); hdr.className='popup-item proj-hd'; hdr.textContent=prov; listEl.appendChild(hdr);
      for (const m of list) {
        const d = document.createElement('div');
        const cur = shortModel(m) === modelLabel.textContent;
        d.className = 'popup-item' + (cur ? ' active' : '');
        d.innerHTML = `<span>${esc(m.name)}</span>${m.reasoning?'<span class="badge">✦</span>':''}${cur?'<span style="color:var(--accent);font-size:11px">✓</span>':''}`;
        d.onclick = async () => {
          await rpcSetModel(m.provider, m.id); modelLabel.textContent = shortModel(m); modelMenu.classList.add('hidden'); refreshStats();
        };
        listEl.appendChild(d);
      }
    }
    if (!listEl.children.length) { const n=document.createElement('div');n.className='popup-item';n.style.color='var(--text-3)';n.textContent=needle?'No matches':'No models enabled';listEl.appendChild(n); }
    // Footer: manage link (always visible)
    if (!needle) {
      const sep = document.createElement('div'); sep.style.cssText='height:1px;background:var(--border);margin:4px 0'; listEl.appendChild(sep);
      const manage = document.createElement('div');
      manage.className = 'popup-item';
      manage.style.color = 'var(--text-3)';
      manage.innerHTML = `<span>⚙ Manage model scope…</span>`;
      manage.onclick = () => {
        modelMenu.classList.add('hidden');
        showModal('Model scope', `<p style="margin:0 0 8px">Choose which models appear in the picker. This setting is shared with the TUI (same list used for Ctrl+P cycling).</p><p style="margin:0 0 10px;color:var(--text-3);font-size:12px">Currently <b style="color:var(--accent)">${scopedIds===null?allModelsCache.length:scopedIds.length}</b> model(s) enabled.</p><p style="margin:0;color:var(--text-3);font-size:12px">To change the list, use <code style="background:var(--bg);padding:1px 6px;border-radius:4px">/scoped-models</code> in the TUI and press Ctrl+S to save. Your selection will appear here automatically.</p>`);
      };
      listEl.appendChild(manage);
    }
  }
  renderList('');
  search.addEventListener('input', () => renderList(search.value));
  search.addEventListener('keydown', e => { e.stopPropagation(); if(e.key==='Escape')modelMenu.classList.add('hidden'); });
  setTimeout(()=>search.focus(),30);
}
function refreshModelsFromCache(models) {
  allModelsCache = models;
  renderModelMenu();
}

const THINK_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
async function refreshThinkingMenu() {
  try {
    const s = await jget('/api/state');
    thinkingMenu.innerHTML = '';
    for (const lv of THINK_LEVELS) {
      const d = document.createElement('div');
      d.className = 'popup-item' + (s.thinkingLevel === lv ? ' active' : '');
      d.textContent = lv;
      d.onclick = async () => { await jpost('/api/thinking', { level: lv }); thinkingLabel.textContent = lv; thinkingMenu.classList.add('hidden'); };
      thinkingMenu.appendChild(d);
    }
  } catch {}
}

// ---- session list ----
const SESS_CACHE_KEY = 'pi-web:sessions:v1';
function applySessionsData(sessions, projects, current) {
  allSessions = sessions; allProjects = projects; currentCwd = current;

  // current project card
  const curProj = projects.find(p => p.cwd === currentCwd);
  if (curProj) {
    projName.textContent = basename(curProj.cwd);
    projPath.textContent = curProj.cwd;
  }

  // current project's sessions
  const q = (sessSearch.value || '').toLowerCase();
  const curSessions = sessions
    .filter(s => s.cwd === currentCwd)
    .filter(s => !q || (s.name || s.firstMessage || '').toLowerCase().includes(q) || basename(s.cwd).toLowerCase().includes(q))
    .sort((a,b) => b.updated - a.updated);
  sessionsEl.innerHTML = '';
  let bucket = null;
  for (const s of curSessions) {
    const b = dayBucket(s.updated);
    if (b !== bucket) {
      bucket = b;
      const label = document.createElement('div');
      label.className = 'sess-group';
      label.textContent = b;
      sessionsEl.appendChild(label);
    }
    sessionsEl.appendChild(renderSessItem(s));
  }

  // other projects
  const others = projects.filter(p => p.cwd !== currentCwd);
  otherProjectsEl.innerHTML = '';
  otherToggle.style.display = others.length ? '' : 'none';
  for (const p of others) {
    const n = p.count ?? sessions.filter(s => s.cwd === p.cwd).length;
    const d = document.createElement('div');
    d.className = 'other-proj-item';
    d.innerHTML = `<span>📁 ${esc(basename(p.cwd))}</span><span class="count">${n}</span>`;
    d.title = p.cwd;
    d.onclick = async () => {
      await jpost('/api/project/switch', { cwd: p.cwd });
    };
    otherProjectsEl.appendChild(d);
  }
}
const SESS_PAGE = 60;
let sessTotal = 0;
let sessLoadingMore = false;

async function refreshSessions() {
  try {
    // Cold-start: paint from localStorage instantly if available, then refresh from network.
    try {
      const cached = JSON.parse(localStorage.getItem(SESS_CACHE_KEY) || 'null');
      if (cached && Array.isArray(cached.sessions) && Array.isArray(cached.projects)) {
        sessTotal = cached.total ?? cached.sessions.length;
        applySessionsData(cached.sessions, cached.projects, cached.current || currentCwd);
      }
    } catch {}

    const { projects, current } = await jget('/api/projects');
    const { sessions, total } = await jget(
      `/api/sessions?limit=${SESS_PAGE}&offset=0&cwd=${encodeURIComponent(current)}`,
    );
    sessTotal = total ?? sessions.length;
    try {
      localStorage.setItem(SESS_CACHE_KEY, JSON.stringify({ sessions, projects, current, total: sessTotal, at: Date.now() }));
    } catch {}
    applySessionsData(sessions, projects, current);
  } catch {}
}

// Sidebar pages: 60 rows up front, the rest appended when the list is scrolled.
async function loadMoreSessions() {
  if (sessLoadingMore) return;
  if (allSessions.length >= sessTotal) return;
  sessLoadingMore = true;
  try {
    const { sessions } = await jget(
      `/api/sessions?limit=${SESS_PAGE}&offset=${allSessions.length}&cwd=${encodeURIComponent(currentCwd)}`,
    );
    if (!sessions.length) { sessTotal = allSessions.length; return; }
    allSessions = [...allSessions, ...sessions];
    applySessionsData(allSessions, allProjects, currentCwd);
  } catch {}
  finally { sessLoadingMore = false; }
}

sessionsEl.addEventListener('scroll', () => {
  if (sessionsEl.scrollTop + sessionsEl.clientHeight >= sessionsEl.scrollHeight - 80) loadMoreSessions();
}, { passive: true });

function relTime(ms) {
  const diff = Date.now() - (ms || 0);
  const min = diff / 60000;
  if (min < 1) return '刚刚';
  if (min < 60) return `${Math.floor(min)}分钟前`;
  const h = min / 60;
  if (h < 24) return `${Math.floor(h)}小时前`;
  const d = h / 24;
  if (d < 30) return `${Math.floor(d)}天前`;
  if (d < 365) return `${Math.floor(d / 30)}个月前`;
  return `${Math.floor(d / 365)}年前`;
}

function dayBucket(ms) {
  const d = new Date(ms || 0);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return '今天';
  const yd = new Date(now.getTime() - 86400000);
  if (d.toDateString() === yd.toDateString()) return '昨天';
  const days = (now - d) / 86400000;
  if (days < 7) return '最近 7 天';
  if (days < 30) return '最近 30 天';
  return '更早';
}

function renderSessItem(s) {
  const d = document.createElement('div');
  d.className = 'sess-item' + (s.isCurrent ? ' active' : '');
  const title = s.name || s.firstMessage || '(untitled)';
  d.innerHTML = `
    <div class="sess-name">${esc(title)}<span class="sess-time">${relTime(s.updated)}</span></div>
    ${s.lastMessage && s.lastMessage !== s.firstMessage ? `<div class="sess-preview">${esc(s.lastMessage).slice(0, 80)}</div>` : ''}
    <div class="more-btn" title="More">⋮</div>`;
  d.onclick = async (ev) => {
    if (ev.target.classList.contains('more-btn')) return;
    if (s.isCurrent) return;
    await jpost('/api/sessions/switch', { file: s.file });
    messagesEl.innerHTML = '';
    endStream();
    setTimeout(() => refreshAll(), 1500);
  };
  d.querySelector('.more-btn').onclick = ev => {
    ev.stopPropagation();
    openCtxMenu(ev.target, s);
  };
  return d;
}

function openCtxMenu(anchor, s) {
  ctxMenu.innerHTML = `
    <div class="ctx-item" data-act="rename">重命名</div>
    <div class="ctx-item danger" data-act="delete">删除</div>`;
  const r = anchor.getBoundingClientRect();
  ctxMenu.style.left = (r.left - 140) + 'px';
  ctxMenu.style.top = (r.bottom + 4) + 'px';
  ctxMenu.classList.remove('hidden');
  $$('.ctx-item', ctxMenu).forEach(el => {
    el.onclick = async () => {
      ctxMenu.classList.add('hidden');
      const title = s.name || s.firstMessage || s.file;
      if (el.dataset.act === 'rename') {
        showModal('重命名会话', `<input id="rn-input" type="text" value="${esc(s.name || s.firstMessage || '')}">`, [
          { label: '取消' },
          { label: '保存', primary: true, onClick: async () => {
              const v = document.getElementById('rn-input')?.value?.trim();
              if (v) { await jpost('/api/sessions/rename', { file: s.file, name: v }); refreshSessions(); refreshStats(); }
            } },
        ]);
      } else if (el.dataset.act === 'delete') {
        showModal('删除会话', `删除「${esc(title)}」？文件会被移到废纸篓。`, [
          { label: '取消' },
          { label: '删除', primary: true, onClick: async () => {
              await jpost('/api/sessions/delete', { file: s.file });
              refreshSessions();
            } },
        ]);
      }
    };
  });
}

// ---- file tree context menu: zip / unzip / copy path ----
function fmtBytes(n) {
  if (n < 1024) return n + 'B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'KB';
  return (n / 1024 / 1024).toFixed(1) + 'MB';
}

function openTreeMenu(ev, node) {
  const isZip = !node.isDir && /\.zip$/i.test(node.name);
  ctxMenu.innerHTML = `
    <div class="ctx-item" data-act="zip">压缩为 .zip</div>
    ${isZip ? '<div class="ctx-item" data-act="unzip">解压到同名目录</div>' : ''}
    <div class="ctx-item" data-act="copy">复制路径</div>`;
  ctxMenu.style.left = Math.min(ev.clientX, window.innerWidth - 200) + 'px';
  ctxMenu.style.top = Math.min(ev.clientY, window.innerHeight - 150) + 'px';
  ctxMenu.classList.remove('hidden');
  const rel = node.abs.slice(currentCwd.length + 1) || node.name;
  ctxMenu.querySelectorAll('.ctx-item').forEach(el => {
    el.onclick = async () => {
      ctxMenu.classList.add('hidden');
      const act = el.dataset.act;
      if (act === 'copy') {
        try { await navigator.clipboard.writeText(node.abs); showToast('已复制路径', true); } catch { showErrorToast(node.abs); }
        return;
      }
      if (act === 'zip') {
        showToast(`正在压缩 ${node.name} …`, true);
        try {
          const r = await jpost('/api/fs/zip', { path: rel });
          await reloadTree();
          showToast(`已生成 ${r.file.split('/').pop()}（${r.count} 个文件，${fmtBytes(r.bytes)}）`, true);
        } catch (e) { showErrorToast('压缩失败：' + (e.message || e)); }
        return;
      }
      if (act === 'unzip') {
        showToast(`正在解压 ${node.name} …`, true);
        try {
          const r = await jpost('/api/fs/unzip', { path: rel });
          await reloadTree();
          showToast(`已解压到 ${r.dir.split('/').pop()}/（${r.count} 个文件）`, true);
        } catch (e) { showErrorToast('解压失败：' + (e.message || e)); }
      }
    };
  });
}

// ---- project picker popup ----
async function openProjectMenu() {
  await refreshSessions();
  projMenu.innerHTML = '';

  // Actions
  const actOpen = document.createElement('div');
  actOpen.className = 'ctx-item';
  actOpen.innerHTML = '📂 <span style="margin-left:6px">Open existing folder…</span>';
  actOpen.onclick = () => { projMenu.classList.add('hidden'); folderPicker.click(); };
  projMenu.appendChild(actOpen);

  const actNew = document.createElement('div');
  actNew.className = 'ctx-item';
  actNew.innerHTML = '＋ <span style="margin-left:6px">New blank project…</span>';
  actNew.onclick = async () => {
    projMenu.classList.add('hidden');
    const home = currentCwd.startsWith('/Users/') ? currentCwd.split('/').slice(0,3).join('/') : (currentCwd || '/');
    showModal('New project', `<p style="margin:0 0 4px;color:var(--text-3);font-size:12px">Absolute path to create the new project folder:</p><input type="text" id="newproj-input" value="${esc(home + '/')}" placeholder="/path/to/new-project" />`, [
      { label: 'Cancel' },
      { label: 'Create & open', primary: true, onClick: body => {
        const p = body.querySelector('#newproj-input').value.trim();
        if (p) { jpost('/api/project/create', { path: p }).then(() => { messagesEl.innerHTML = ''; setTimeout(refreshAll, 1500); }).catch(e => showModal('Error', `<p>${esc(e.message)}</p>`)); }
      }}
    ]);
  };
  projMenu.appendChild(actNew);

  const sep = document.createElement('div'); sep.className = 'popup-sep'; projMenu.appendChild(sep);

  let count = 0;
  for (const p of allProjects) {
    if (p.cwd === currentCwd) continue;
    count++;
    const d = document.createElement('div');
    d.className = 'ctx-item';
    d.style.flexDirection = 'column';
    d.style.alignItems = 'flex-start';
    d.innerHTML = `<div style="width:100%;display:flex;justify-content:space-between;gap:8px;align-items:center"><span style="font-weight:600">📁 ${esc(basename(p.cwd))}</span><span style="color:var(--text-3);font-weight:400;font-size:10.5px">${p.count}</span></div><div style="font-size:10.5px;color:var(--text-3);font-family:ui-monospace,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;width:100%;margin-top:2px">${esc(p.cwd)}</div>`;
    d.onclick = async () => {
      await jpost('/api/project/switch', { cwd: p.cwd });
      projMenu.classList.add('hidden');
      messagesEl.innerHTML = '';
      setTimeout(refreshAll, 1500);
    };
    projMenu.appendChild(d);
  }
  if (count === 0) {
    const d = document.createElement('div');
    d.className = 'ctx-item'; d.style.color = 'var(--text-3)'; d.style.cursor = 'default';
    d.textContent = 'No other projects';
    projMenu.appendChild(d);
  }
  const r = projRow.getBoundingClientRect();
  projMenu.style.left = r.left + 'px';
  projMenu.style.top = (r.bottom + 6) + 'px';
  projMenu.style.minWidth = Math.max(r.width, 300) + 'px';
  projMenu.classList.remove('hidden');
}
projRow.addEventListener('click', e => { e.stopPropagation(); openProjectMenu(); });
projSwitch.addEventListener('click', e => { e.stopPropagation(); openProjectMenu(); });

// Folder picker handling
folderPicker.addEventListener('change', async () => {
  const files = folderPicker.files;
  if (!files || !files.length) return;
  const first = files[0];
  let folderPath = first.path || '';
  if (!folderPath) {
    folderPath = prompt('Enter the absolute path to the selected folder:');
    if (!folderPath) return;
  } else {
    // strip trailing filename
    const parts = folderPath.split('/'); parts.pop();
    folderPath = parts.join('/');
  }
  try {
    await jpost('/api/project/open', { cwd: folderPath });
    messagesEl.innerHTML = '';
    setTimeout(refreshAll, 1500);
  } catch (e) { alert('Failed to open folder: ' + e.message); }
  folderPicker.value = '';
});

// ---- events ----
modelPill.addEventListener('click', e => { e.stopPropagation(); modelMenu.classList.toggle('hidden'); thinkingMenu.classList.add('hidden'); if (!modelMenu.classList.contains('hidden')) refreshModels(); });
thinkingPill.addEventListener('click', e => { e.stopPropagation(); thinkingMenu.classList.toggle('hidden'); modelMenu.classList.add('hidden'); refreshThinkingMenu(); });

$('#composer').addEventListener('submit', async ev => {
  ev.preventDefault();
  // Wait for any in-flight FileReader (large files picked right before pressing Send).
  await whenReadsDone();
  const text = inputEl.value.trim();
  if ((!text && pendingAttachments.length === 0) || !ws || ws.readyState !== 1) return;
  hideSlashMenu();
  if (text.startsWith('/') && pendingAttachments.length === 0) {
    const r = await jpost('/api/slash', { command: text }).catch(e => ({ error: e.message }));
    if (r?.error) { footerStatus.textContent = r.error; setTimeout(()=>footerStatus.textContent='', 3000); inputEl.value=''; autoGrow(); return; }
    handleSlashResult(r);
    inputEl.value = ''; autoGrow();
    return;
  }
  // Render user bubble with text + attachments inline, then send with images.
  const userContent = buildUserContent(text, pendingAttachments);
  lastUserBubble = addMessage('user', userContent);
  lastAttemptText = text;
  lastAttemptAttachments = pendingAttachments.length ? pendingAttachments.slice() : null;
  const images = pendingAttachments.map(a => ({ type: 'image', dataUrl: a.dataUrl, mimeType: a.mimeType, fileName: a.fileName }));
  // Pre-flight: if current model doesn't accept image input, fail fast locally
  // instead of waiting for the RPC round-trip (which is silent on old builds).
  const curModel = await getCurrentModelCached();
  if (images.length && curModel && Array.isArray(curModel.input) && !curModel.input.includes('image')) {
    handlePromptError(`当前模型 ${curModel.provider}/${curModel.id} 不支持图片输入，请切换到多模态/视觉模型后再发图。`);
    return;
  }
  ws.send(JSON.stringify({ type: 'prompt', text, images: images.length ? images : undefined }));
  inputEl.value = '';
  pendingAttachments = [];
  renderAttachments();
  autoGrow();
});

// Best-effort lookup of the currently selected model from our cached list +
// the /api/state endpoint so we can do client-side capability checks.
async function getCurrentModelCached() {
  try {
    const st = await jget('/api/state');
    const m = st?.model;
    if (m) return m;
  } catch {}
  return allModelsCache.find(m => shortModel(m) === modelLabel.textContent) || null;
}

// Build a user-content array (text/image blocks) suitable for addMessage() so
// the user bubble mirrors exactly what was sent.
function buildUserContent(text, attachments) {
  const blocks = [];
  if (text) blocks.push({ type: 'text', text });
  for (const a of attachments) blocks.push({ type: 'image', dataUrl: a.dataUrl, mimeType: a.mimeType, fileName: a.fileName });
  return blocks;
}

// ---- image attachments UI ----
function renderAttachments() {
  attachmentsEl.innerHTML = '';
  if (!pendingAttachments.length) { attachmentsEl.classList.add('hidden'); return; }
  attachmentsEl.classList.remove('hidden');
  for (const a of pendingAttachments) {
    const chip = document.createElement('div');
    chip.className = 'attach-chip';
    chip.innerHTML = `
      <img src="${a.dataUrl}" alt="${esc(a.fileName || 'image')}" />
      <button type="button" class="attach-remove" title="Remove">×</button>
      <div class="attach-name">${esc(a.fileName || 'image')}</div>`;
    chip.querySelector('.attach-remove').onclick = (e) => {
      e.stopPropagation(); e.preventDefault();
      pendingAttachments = pendingAttachments.filter(x => x.id !== a.id);
      renderAttachments();
    };
    attachmentsEl.appendChild(chip);
  }
}

function addAttachmentFromFile(file) {
  if (!file || !file.type?.startsWith('image/')) return Promise.resolve(false);
  pendingReads++;
  return new Promise(resolve => {
    const reader = new FileReader();
    const finish = (ok) => { pendingReads--; resolve(ok); };
    reader.onload = () => {
      pendingAttachments.push({
        id: 'att_' + Math.random().toString(36).slice(2, 9),
        mimeType: file.type || 'image/png',
        dataUrl: String(reader.result || ''),
        fileName: file.name || 'image',
        size: file.size || 0,
      });
      renderAttachments();
      finish(true);
    };
    reader.onerror = () => finish(false);
    reader.readAsDataURL(file);
  });
}

attachBtn.addEventListener('click', () => fileInputEl.click());
fileInputEl.addEventListener('change', async () => {
  for (const f of Array.from(fileInputEl.files || [])) await addAttachmentFromFile(f);
  fileInputEl.value = '';
  inputEl.focus();
});

// Paste images from clipboard. Bind to the composer container only — the
// event bubbles up from the <textarea> and the attachment strip, so a single
// handler covers every paste target inside the box and we don't double-add.
composerEl.addEventListener('paste', async (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  let handled = false;
  for (const it of items) {
    if (it.kind === 'file' && it.type?.startsWith('image/')) {
      const f = it.getAsFile();
      if (f) handled = (await addAttachmentFromFile(f)) || handled;
    }
  }
  if (handled) { e.preventDefault(); inputEl.focus(); }
});

// Drag & drop images onto the composer / messages area.
function addDropTargets(el) {
  el.addEventListener('dragover', (e) => {
    if (Array.from(e.dataTransfer?.types || []).includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; el.classList.add('drag-over'); }
  });
  el.addEventListener('dragleave', (e) => { if (e.target === el) el.classList.remove('drag-over'); });
  el.addEventListener('drop', async (e) => {
    el.classList.remove('drag-over');
    const files = Array.from(e.dataTransfer?.files || []);
    if (!files.length) return;
    e.preventDefault();
    for (const f of files) await addAttachmentFromFile(f);
    inputEl.focus();
  });
}
addDropTargets(composerEl);
addDropTargets(messagesEl);

function handleSlashResult(r) {
  if (!r) return;
  switch (r.action) {
    case 'rpc':
    case 'prompt':
      // e.g. /compact /new /fork /clone → action already taken server-side; client reacts to events
      if (r.command === 'new' || r.command === 'clear') { messagesEl.innerHTML=''; chatTitle.textContent='New chat'; document.title='New chat · π'; footerStatus.textContent=''; }
      if (r.command === 'compact') footerStatus.textContent = 'Compacting…';
      refreshAll();
      break;
    case 'switchedModel':
      modelLabel.textContent = shortModel(r.model); refreshStats();
      break;
    case 'setThinking':
      thinkingLabel.textContent = r.level;
      break;
    case 'renamed':
      chatTitle.textContent = r.name; document.title = r.name + ' · π'; refreshSessions();
      break;
    case 'showRename':
      openRenameDialog(); break;
    case 'showModelPicker':
      allModelsCache = r.models;
      refreshModelsFromCache(r.models);
      modelMenu.classList.remove('hidden'); break;
    case 'showThinkingPicker':
      thinkingPill.click(); break;
    case 'showHelp':
      showHelpFromServer(); break;
    case 'exported':
      footerStatus.textContent = 'Exported: ' + r.path; setTimeout(()=>footerStatus.textContent='',4000); break;
    case 'tuiOnly':
      footerStatus.textContent = r.message; setTimeout(()=>footerStatus.textContent='', 4000); break;
    case 'newSession':
      messagesEl.innerHTML=''; chatTitle.textContent='New chat'; document.title='New chat · π'; footerStatus.textContent=''; refreshAll(); break;
  }
}

// ---- slash autocomplete ----
let allCommandsCache = [];
const slashMenu = document.createElement('div');
slashMenu.className = 'popup-menu slash-ac';
slashMenu.style.cssText = 'position:absolute;min-width:320px;max-height:300px;overflow-y:auto;z-index:300';
document.body.appendChild(slashMenu);
let slashActiveIdx = -1;

inputEl.addEventListener('input', () => {
  autoGrow();
  const v = inputEl.value;
  if (v.startsWith('/')) updateSlashMenu(v);
  else hideSlashMenu();
});
inputEl.addEventListener('keydown', e => {
  if (!slashMenu.classList.contains('hidden')) {
    const items = slashMenu.querySelectorAll('.slash-item');
    if (e.key === 'ArrowDown') { e.preventDefault(); slashActiveIdx = Math.min(slashActiveIdx+1, items.length-1); updateSlashActive(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); slashActiveIdx = Math.max(slashActiveIdx-1, 0); updateSlashActive(); }
    else if (e.key === 'Tab' || e.key === 'Enter') {
      const it = items[slashActiveIdx]; if (it) { e.preventDefault(); it.click(); }
    } else if (e.key === 'Escape') { hideSlashMenu(); }
  }
});
inputEl.addEventListener('blur', () => setTimeout(hideSlashMenu, 150));

function hideSlashMenu() { slashMenu.classList.add('hidden'); slashActiveIdx = -1; }
function updateSlashActive() {
  slashMenu.querySelectorAll('.slash-item').forEach((el,i) => el.classList.toggle('active', i===slashActiveIdx));
  const a = slashMenu.querySelector('.slash-item.active'); if (a) a.scrollIntoView({block:'nearest'});
}
async function updateSlashMenu(v) {
  if (!allCommandsCache.length) {
    try { const { commands } = await jget('/api/commands'); allCommandsCache = commands; }
    catch { return; }
  }
  const q = v.slice(1).toLowerCase();
  const kw = q.split(/\s+/)[0] || '';
  const scored = [];
  for (const c of allCommandsCache) {
    const n = c.name.toLowerCase();
    if (kw && !n.includes(kw) && !(c.description||'').toLowerCase().includes(kw)) continue;
    let score = 0;
    if (n === kw) score = 1000;
    else if (n.startsWith(kw)) score = 100;
    else if (n.includes(kw)) score = 50;
    else if ((c.description||'').toLowerCase().includes(kw)) score = 10;
    scored.push({ c, score });
  }
  scored.sort((a,b) => b.score - a.score);
  const filtered = scored.map(s => s.c);
  if (!filtered.length) { hideSlashMenu(); return; }
  slashMenu.innerHTML = '';
  const sourceBadge = { builtin: '', extension: '<span class="src-tag ext">ext</span>', prompt: '<span class="src-tag pr">prompt</span>', skill: '<span class="src-tag sk">skill</span>' };
  filtered.slice(0, 30).forEach((c, i) => {
    const d = document.createElement('div');
    d.className = 'slash-item popup-item';
    if (c.webSupport === 'tui-only') d.classList.add('tui-only');
    d.innerHTML = `<span class="cmd-name">/${esc(c.name)}</span>${c.argumentHint?`<span class="arg-hint">${esc(c.argumentHint)}</span>`:''}${sourceBadge[c.source]||''}<span class="cmd-desc">${esc(c.description||'')}</span>`;
    d.onmousedown = e => e.preventDefault();
    d.onclick = () => {
      inputEl.value = '/' + c.name + (c.argumentHint ? ' ' : '');
      inputEl.focus(); autoGrow();
      hideSlashMenu();
      if (!c.argumentHint) { $('#composer').requestSubmit(); } else {
        // place cursor at end
        const len = inputEl.value.length; inputEl.setSelectionRange(len, len);
      }
    };
    slashMenu.appendChild(d);
  });
  // position at input caret
  const r = inputEl.getBoundingClientRect();
  slashMenu.style.left = r.left + 'px';
  slashMenu.style.bottom = (window.innerHeight - r.top + 6) + 'px';
  slashMenu.style.top = 'auto';
  slashMenu.classList.remove('hidden');
  slashActiveIdx = 0; updateSlashActive();
}

async function showHelpFromServer() {
  if (!allCommandsCache.length) { try { const {commands} = await jget('/api/commands'); allCommandsCache = commands; } catch {} }
  const groups = {};
  for (const c of allCommandsCache) {
    if (c.webSupport === 'tui-only') continue;
    const g = groups[c.source] || (groups[c.source] = []);
    g.push(c);
  }
  const srcLabel = { builtin: 'Built-in', extension: 'Extensions', prompt: 'Prompt templates', skill: 'Skills' };
  let html = '';
  for (const [src, list] of Object.entries(groups)) {
    html += `<div style="font-size:11px;color:var(--text-3);margin:10px 0 4px;letter-spacing:.5px;text-transform:uppercase;font-weight:600">${srcLabel[src]||src}</div><ul class="help-list">`;
    for (const c of list) html += `<li><span class="cmd">/${esc(c.name)}${c.argumentHint?' '+esc(c.argumentHint):''}</span><span class="desc">${esc(c.description||'')}</span></li>`;
    html += '</ul>';
  }
  showModal('Slash commands', html);
}
function openRenameDialog() {
  const cur = chatTitle.textContent.trim();
  showModal('Rename chat', `<p style="margin:0 0 4px;color:var(--text-3);font-size:12px">Enter a new title for this session:</p><input type="text" id="rename-input" value="${esc(cur === 'New chat' ? '' : cur)}" placeholder="Session title…" />`, [
    { label: 'Cancel' },
    { label: 'Rename', primary: true, onClick: body => {
      const v = body.querySelector('#rename-input').value.trim();
      if (v) { jpost('/api/sessions/rename', { name: v }).then(() => { chatTitle.textContent = v; document.title = v + ' · π'; refreshSessions(); }); }
    }}
  ]);
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (ws && ws.readyState === 1 && streaming) ws.send(JSON.stringify({ type: 'abort' }));
    ctxMenu.classList.add('hidden'); modelMenu.classList.add('hidden'); thinkingMenu.classList.add('hidden'); projMenu.classList.add('hidden');
  }
});
document.addEventListener('click', e => {
  if (!e.target.closest('.more-btn') && !e.target.closest('.ctx-menu')) ctxMenu.classList.add('hidden');
  if (!e.target.closest('#model-pill') && !e.target.closest('#model-menu')) modelMenu.classList.add('hidden');
  if (!e.target.closest('#thinking-pill') && !e.target.closest('#thinking-menu')) thinkingMenu.classList.add('hidden');
  if (!e.target.closest('#project-row') && !e.target.closest('#proj-menu')) projMenu.classList.add('hidden');
});

function autoGrow() {
  inputEl.style.height = 'auto'; inputEl.style.height = Math.min(200, inputEl.scrollHeight) + 'px';
}
inputEl.addEventListener('input', autoGrow);
inputEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#composer').requestSubmit(); }
});

sessSearch.addEventListener('input', refreshSessions);

// ---- lightbox for chat images ----
let lightboxEl = null;
function openLightbox(src, alt) {
  closeLightbox();
  lightboxEl = document.createElement('div');
  lightboxEl.className = 'lightbox';
  lightboxEl.innerHTML = `<img src="${src}" alt="${esc(alt||'image')}" />`;
  lightboxEl.addEventListener('click', closeLightbox);
  document.body.appendChild(lightboxEl);
}
function closeLightbox() {
  if (lightboxEl) { lightboxEl.remove(); lightboxEl = null; }
}
document.addEventListener('keydown', e => { if (e.key === 'Escape' && lightboxEl) closeLightbox(); });
messagesEl.addEventListener('click', e => {
  const img = e.target.closest('.img-block img');
  if (img && img.closest('.msg.user') === null) openLightbox(img.src, img.alt);
});
otherToggle.addEventListener('click', () => {
  otherProjectsEl.classList.toggle('hidden');
  otherCaret.textContent = otherProjectsEl.classList.contains('hidden') ? '▸' : '▾';
});
$('#btn-new').addEventListener('click', async () => {
  await jpost('/api/session/new');
  messagesEl.innerHTML = ''; endStream(); chatTitle.textContent = 'New chat';
  setTimeout(refreshAll, 1200);
});

setInterval(() => { if (!streaming) { refreshStats(); refreshSessions(); } }, 5000);

// ===================== CODEx-STYLE WORK AREA =====================
const workbar = document.getElementById('workbar');
const workTabsList = document.getElementById('work-tabs-list');
const workContent = document.getElementById('work-content');
const workEmpty = document.getElementById('work-empty');
const workTreeEl = document.getElementById('work-tree');
const workResize = document.getElementById('work-resize');
const rbToggle = document.getElementById('rb-toggle');

const treeRoot = document.getElementById('tree-root');
const treeSearch = document.getElementById('tree-search');
const treeReload = document.getElementById('tree-reload');

const newtabMenu = document.getElementById('newtab-menu');
const newtabAdd = document.getElementById('work-tab-add');

// ---- Resize handle ----
(function setupResize() {
  let dragging = false;
  let startX = 0, startW = 0;
  const DEFAULT_W = 680, MIN_W = 360, MAX_W = Math.max(window.innerWidth * 0.8, 800);
  workResize.addEventListener('mousedown', (e) => {
    dragging = true;
    startX = e.clientX;
    const cssW = getComputedStyle(document.body).getPropertyValue('--workbar-w').trim();
    startW = cssW ? parseFloat(cssW) : workbar.getBoundingClientRect().width;
    workResize.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = startX - e.clientX; // dragging left → wider
    let w = startW + dx;
    w = Math.max(MIN_W, Math.min(MAX_W, w));
    document.body.style.setProperty('--workbar-w', w + 'px');
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    workResize.classList.remove('dragging');
    document.body.style.cursor = '';
  });
})();

// ---- Open/close whole workbar ----
function setWorkbar(open) {
  workbar.classList.toggle('open', open);
  document.body.classList.toggle('work-open', open);
  rbToggle.classList.toggle('active', open);
  if (open && tabs.length === 0) {
    // show empty tool list
  }
}
rbToggle.addEventListener('click', () => setWorkbar(!workbar.classList.contains('open')));

// ---- Tabs state ----
// Each tab: { id, kind:'file'|'terminal'|'browser', title, icon, paneEl, data }
let tabs = [];
let activeTabId = null;
let tabIdSeq = 1;

function uid() { return 't' + (tabIdSeq++); }

function createPane(kind) {
  const el = document.createElement('div');
  el.className = 'work-pane';
  el.dataset.kind = kind;
  return el;
}

function updateTreeVisibility() {
  // Show file tree only when there's an active file tab
  const activeTab = tabs.find(t => t.id === activeTabId);
  const hasFile = activeTab && activeTab.kind === 'file';
  workbar.classList.toggle('no-tree', !hasFile);
}

function activateTab(id) {
  activeTabId = id;
  tabs.forEach(t => {
    t.el.classList.toggle('active', t.id === id);
    t.paneEl.classList.toggle('active', t.id === id);
  });
  workEmpty.style.display = tabs.length === 0 ? '' : 'none';
  updateTreeVisibility();
  // focus appropriate input
  const t = tabs.find(x => x.id === id);
  if (t) {
    if (t.kind === 'terminal') setTimeout(() => t.data.input?.focus(), 30);
    if (t.kind === 'file') setTimeout(() => t.data.textarea?.focus(), 30);
    if (t.kind === 'browser') setTimeout(() => t.data.url?.focus(), 30);
  }
}

function closeTab(id) {
  const idx = tabs.findIndex(t => t.id === id);
  if (idx < 0) return;
  const t = tabs[idx];
  // teardown
  if (t.kind === 'terminal') {
    try { t.data.ws?.close(); } catch {}
  }
  t.paneEl.remove();
  t.el.remove();
  tabs.splice(idx, 1);
  // update active file highlight
  if (t.kind === 'file') {
    const stillOpen = tabs.find(x => x.kind === 'file' && x.data.abs === t.data.abs);
    highlightActiveFile(stillOpen ? stillOpen.data.abs : null);
  }
  if (activeTabId === id) {
    const next = tabs[idx] || tabs[idx - 1];
    activateTab(next ? next.id : null);
  }
  if (tabs.length === 0) {
    workEmpty.style.display = '';
    updateTreeVisibility();
  } else {
    updateTreeVisibility();
  }
}

function renderTab(t) {
  const el = document.createElement('button');
  el.className = 'work-tab';
  el.innerHTML = `<span class="wt-ico">${t.icon}</span><span class="wt-name">${esc(t.title)}</span><span class="wt-close" title="Close">✕</span>`;
  el.addEventListener('click', (e) => {
    if (e.target.classList.contains('wt-close')) return;
    activateTab(t.id);
  });
  el.querySelector('.wt-close').addEventListener('click', (e) => {
    e.stopPropagation();
    if (t.kind === 'file' && t.data.dirty) {
      if (!confirm(`"${t.title}" has unsaved changes, close anyway?`)) return;
    }
    closeTab(t.id);
  });
  return el;
}

function addTab(tab) {
  tab.id = uid();
  tab.paneEl = createPane(tab.kind);
  workContent.appendChild(tab.paneEl);
  tab.el = renderTab(tab);
  workTabsList.appendChild(tab.el);
  tabs.push(tab);
  activateTab(tab.id);
  workEmpty.style.display = 'none';
  return tab;
}

// ---- New-tab menu ----
newtabAdd.addEventListener('click', (e) => {
  e.stopPropagation();
  const r = newtabAdd.getBoundingClientRect();
  newtabMenu.style.left = (r.left - 120) + 'px';
  newtabMenu.style.top = (r.bottom + 4) + 'px';
  newtabMenu.classList.remove('hidden');
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#newtab-menu') && !e.target.closest('#work-tab-add')) {
    newtabMenu.classList.add('hidden');
  }
});
function handleToolPick(kind) {
  newtabMenu.classList.add('hidden');
  if (kind === 'terminal') openTerminalTab();
  else if (kind === 'browser') openBrowserTab();
  else if (kind === 'file') {
    // Show file tree for user to pick a file (even though no file tab is open yet)
    ensureTreeLoaded();
    workbar.classList.remove('no-tree');
    treeSearch.focus();
  }
}
newtabMenu.querySelectorAll('.ctx-item').forEach(item => {
  item.addEventListener('click', () => handleToolPick(item.dataset.kind));
});
workEmpty.querySelectorAll('.tool-item').forEach(item => {
  item.addEventListener('click', () => handleToolPick(item.dataset.kind));
});

// ============ FILE TABS (editor with line numbers) ============
function openFileTab(rel, abs) {
  // If already open, just activate
  const existing = tabs.find(t => t.kind === 'file' && t.data.abs === abs);
  if (existing) { activateTab(existing.id); return; }
  const name = (abs.split('/').pop() || rel);
  const tab = addTab({ kind: 'file', title: name, icon: fileIcon(name) });
  tab.data = { rel, abs, name, dirty: false, textarea: null, gutter: null };
  // Build pane content
  tab.paneEl.innerHTML = `
    <div class="edit-bar">
      <div class="edit-crumbs">${crumbsHtml(abs)}</div>
    </div>
    <div class="edit-body">
      <div class="edit-gutter"></div>
      <textarea class="edit-textarea" spellcheck="false"></textarea>
    </div>
    <div class="edit-status">
      <span class="edit-status-path">${esc(abs)}</span>
      <span class="sep"></span>
      <span class="edit-status-state">ready</span>
    </div>`;
  const textarea = tab.paneEl.querySelector('.edit-textarea');
  const gutter = tab.paneEl.querySelector('.edit-gutter');
  const state = tab.paneEl.querySelector('.edit-status-state');
  tab.data.textarea = textarea;
  tab.data.gutter = gutter;
  // fetch file
  state.textContent = 'loading…';
  jget('/api/fs/read?path=' + encodeURIComponent(rel)).then(data => {
    textarea.value = data.content;
    updateGutter(textarea, gutter);
    state.textContent = 'UTF-8';
  }).catch(e => {
    textarea.value = '// Error: ' + e.message;
    state.textContent = 'error';
  });
  const update = () => {
    updateGutter(textarea, gutter);
    if (!tab.data.dirty) {
      tab.data.dirty = true;
      tab.el.querySelector('.wt-name').textContent = name + ' •';
      state.textContent = 'modified';
    }
    // sync scroll
    gutter.scrollTop = textarea.scrollTop;
  };
  textarea.addEventListener('input', update);
  textarea.addEventListener('scroll', () => { gutter.scrollTop = textarea.scrollTop; });
  textarea.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); saveFileTab(tab); }
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = textarea.selectionStart, en = textarea.selectionEnd;
      textarea.value = textarea.value.slice(0, s) + '  ' + textarea.value.slice(en);
      textarea.selectionStart = textarea.selectionEnd = s + 2;
      update();
    }
  });
  highlightActiveFile(abs);
}
function saveFileTab(tab) {
  const state = tab.paneEl.querySelector('.edit-status-state');
  state.textContent = 'saving…';
  jpost('/api/fs/write', { path: tab.data.rel, content: tab.data.textarea.value }).then(() => {
    tab.data.dirty = false;
    tab.el.querySelector('.wt-name').textContent = tab.data.name;
    state.textContent = 'saved · UTF-8';
    setTimeout(() => { if (!tab.data.dirty) state.textContent = 'UTF-8'; }, 1500);
  }).catch(e => { state.textContent = 'error: ' + e.message; });
}
function updateGutter(textarea, gutter) {
  const lines = textarea.value.split('\n').length;
  let s = '';
  for (let i = 1; i <= lines; i++) s += i + '\n';
  gutter.textContent = s;
}
function crumbsHtml(abs) {
  const parts = abs.split('/').filter(Boolean);
  const fname = parts.pop();
  return parts.map((p, i) => `<span>${esc(p)}</span>`).join(' <span style="color:var(--text-3);margin:0 2px">/</span> ') + ' <span style="color:var(--text-3);margin:0 2px">/</span> <b>' + esc(fname) + '</b>';
}
function highlightActiveFile(abs) {
  treeRoot.querySelectorAll('.tree-row.active-file').forEach(r => r.classList.remove('active-file'));
  if (!abs) return;
  const row = treeRoot.querySelector(`.tree-row[data-abs="${CSS.escape(abs)}"]`);
  if (row) {
    row.classList.add('active-file');
    // expand parents
    let p = row.parentElement;
    while (p && p !== treeRoot) {
      if (p.classList.contains('tree-children')) p.classList.add('shown');
      if (p.classList.contains('tree-children')) {
        const parentRow = p.previousElementSibling;
        if (parentRow && parentRow.classList.contains('tree-row')) parentRow.classList.add('expanded');
      }
      p = p.parentElement;
    }
    row.scrollIntoView({ block: 'nearest' });
  }
}

// ============ TERMINAL TAB ============
function openTerminalTab() {
  const tab = addTab({ kind: 'terminal', title: '终端', icon: '⌨' });
  tab.data = { ws: null, buf: '', input: null };
  tab.paneEl.innerHTML = `
    <div class="term-pane-bar">
      <button class="fs-btn" data-act="clear" title="Clear">⌫</button>
      <button class="fs-btn" data-act="restart" title="Restart">⟳</button>
      <span class="lbl">${esc(currentCwd || 'shell')}</span>
    </div>
    <div class="term-pane-output"></div>
    <div class="term-pane-input-row">
      <span class="term-pane-prompt">$</span>
      <input class="term-pane-input" spellcheck="false" placeholder="输入命令…" />
    </div>`;
  const out = tab.paneEl.querySelector('.term-pane-output');
  const inp = tab.paneEl.querySelector('.term-pane-input');
  const lbl = tab.paneEl.querySelector('.lbl');
  tab.data.input = inp;

  function append(s) {
    tab.data.buf += s;
    if (tab.data.buf.length > 200000) tab.data.buf = tab.data.buf.slice(-200000);
    out.textContent = tab.data.buf;
    out.scrollTop = out.scrollHeight;
  }
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/pty`);
    tab.data.ws = ws;
    ws.onopen = () => { append('π terminal • type a command and press Enter\r\n'); if (currentCwd) ws.send(JSON.stringify({ type: 'term_cd', path: currentCwd })); };
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.type === 'term_data') append(m.data);
      else if (m.type === 'term_exit') append(`\r\n[process exited with code ${m.code}]`);
    };
    ws.onclose = () => append('\r\n[disconnected – click ⟳ to restart]\r\n');
  }
  connect();
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = inp.value;
      append(v + '\r\n');
      if (tab.data.ws?.readyState === 1) tab.data.ws.send(JSON.stringify({ type: 'term_input', data: v + '\n' }));
      inp.value = '';
    } else if (e.key === 'c' && e.ctrlKey) {
      if (tab.data.ws?.readyState === 1) tab.data.ws.send(JSON.stringify({ type: 'term_input', data: '\x03' }));
      append('^C\r\n');
    } else if (e.key === 'l' && e.ctrlKey) {
      tab.data.buf = ''; out.textContent = '';
    }
  });
  tab.paneEl.querySelector('[data-act=clear]').onclick = () => { tab.data.buf = ''; out.textContent = ''; };
  tab.paneEl.querySelector('[data-act=restart]').onclick = () => { try { tab.data.ws?.close(); } catch {} setTimeout(connect, 200); };
  tab.data.lbl = lbl;
}

// ============ BROWSER TAB (embedded iframe with optional sync to pi's shared Chromium) ============
function openBrowserTab(initialUrl) {
  const tab = addTab({ kind: 'browser', title: '浏览器', icon: '🌐' });
  tab.data = {};
  tab.paneEl.innerHTML = `
    <div class="br-pane-bar">
      <button class="fs-btn" data-act="back" title="Back">←</button>
      <button class="fs-btn" data-act="fwd" title="Forward">→</button>
      <button class="fs-btn" data-act="reload" title="Reload">⟳</button>
      <input class="br-pane-url" spellcheck="false" placeholder="输入 URL 或搜索词，按回车打开" />
      <button class="fs-btn" data-act="go" title="Go">➤</button>
      <button class="fs-btn" data-act="home" title="Home">⌂</button>
      <div class="br-sync" title="在 pi 共享浏览器中打开此 URL（供 AI 用 browser_* 工具操作）">
        <label><input type="checkbox" data-act="sync" /> 同步到 π</label>
      </div>
    </div>
    <div class="br-pane-framewrap">
      <iframe class="br-pane-frame" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals allow-presentation allow-storage-access-by-user-activation"></iframe>
      <div class="br-pane-blocked hidden">
        <div class="br-blocked-ico">🔒</div>
        <div class="br-blocked-title">此页面不允许嵌入</div>
        <div class="br-blocked-sub">网站设置了 X-Frame-Options 或 CSP 禁止在 iframe 中显示。</div>
        <button class="br-blocked-btn" data-act="open-external">在新窗口打开</button>
        <button class="br-blocked-btn" data-act="open-shared">在 π 共享浏览器中打开</button>
      </div>
    </div>`;
  const urlInput = tab.paneEl.querySelector('.br-pane-url');
  const frame = tab.paneEl.querySelector('.br-pane-frame');
  const blocked = tab.paneEl.querySelector('.br-pane-blocked');
  const syncCb = tab.paneEl.querySelector('[data-act=sync]');

  function normalize(u) {
    u = (u || '').trim();
    if (!u) return '';
    if (/^https?:\/\//.test(u)) return u;
    if (/^localhost(:\d+)?(\/|$)/.test(u) || /^127\.0\.0\.1(:\d+)?(\/|$)/.test(u)) return 'http://' + u;
    if (/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(\/|$)/.test(u)) return 'https://' + u;
    return 'https://www.google.com/search?q=' + encodeURIComponent(u);
  }
  function setTitleFromUrl(u) {
    tab.title = u.replace(/^https?:\/\//, '').slice(0, 30) || '浏览器';
    tab.el.querySelector('.wt-name').textContent = tab.title;
  }
  function nav(u) {
    const target = normalize(u);
    if (!target) return;
    urlInput.value = target;
    blocked.classList.add('hidden');
    frame.classList.remove('hidden');
    frame.src = target;
    setTitleFromUrl(target);
    if (syncCb.checked) {
      jpost('/api/browser', { action: 'navigate_tab', url: target }).catch(()=>{});
    }
  }

  tab.paneEl.querySelector('[data-act=go]').onclick = () => nav(urlInput.value);
  urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); nav(urlInput.value); } });
  tab.paneEl.querySelector('[data-act=reload]').onclick = () => { try { frame.src = frame.src; } catch {} };
  tab.paneEl.querySelector('[data-act=home]').onclick = () => nav('about:blank');
  tab.paneEl.querySelector('[data-act=back]').onclick = () => { try { frame.contentWindow.history.back(); } catch {} };
  tab.paneEl.querySelector('[data-act=fwd]').onclick = () => { try { frame.contentWindow.history.forward(); } catch {} };
  tab.paneEl.querySelector('[data-act=open-external]').onclick = () => { if (frame.src) window.open(frame.src, '_blank'); };
  tab.paneEl.querySelector('[data-act=open-shared]').onclick = () => {
    jpost('/api/browser', { action: 'navigate_tab', url: frame.src || urlInput.value }).catch(e => alert(e.message));
  };

  // Detect X-Frame-Options / CSP blocking: iframe won't fire load in that case.
  // We use a timeout + load event to detect.
  let loadTimer = null;
  frame.addEventListener('load', () => {
    clearTimeout(loadTimer);
    blocked.classList.add('hidden');
    try { urlInput.value = frame.contentWindow.location.href; setTitleFromUrl(frame.contentWindow.location.href); } catch (e) { /* cross-origin */ }
  });
  frame.addEventListener('error', () => {
    clearTimeout(loadTimer);
    frame.classList.add('hidden');
    blocked.classList.remove('hidden');
  });

  tab.data.nav = nav;
  if (initialUrl) nav(initialUrl);
}

// ============ FILE TREE ============
const IGNORED = new Set(['node_modules', '.git', '__pycache__', '.DS_Store', '.next', 'dist', 'build', '.venv', 'venv', '.tox', '.cache', '.pi', 'site-packages', '.idea', '.vscode', '.pytest_cache', '.mypy_cache']);
let treeData = null; // { name, abs, isDir, children, ignored }
let treeLoadedCwd = null;

async function ensureTreeLoaded() {
  if (treeData && treeLoadedCwd === currentCwd) return;
  treeLoadedCwd = currentCwd;
  await reloadTree();
}

async function reloadTree() {
  treeRoot.innerHTML = '<div style="padding:12px;color:var(--text-3);font-size:11px">loading…</div>';
  try {
    treeData = await walkTree(currentCwd, true, 2);
    renderTreeRoot();
  } catch (e) {
    treeRoot.innerHTML = `<div style="padding:12px;color:var(--err);font-size:11px">${esc(e.message)}</div>`;
  }
}

function fileIcon(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const base = name.toLowerCase();
  if (base === 'readme.md' || base === 'readme') return 'M';
  const map = { js:'JS', ts:'TS', jsx:'⚛', tsx:'⚛', mjs:'JS', cjs:'JS', py:'PY', rs:'RS', go:'GO', rb:'RB', java:'J', kt:'KT', swift:'SW', json:'{}', yaml:'{}', yml:'{}', toml:'{}', md:'M', txt:'T', html:'◇', css:'#', scss:'#', less:'#', png:'🖼', jpg:'🖼', jpeg:'🖼', gif:'🖼', svg:'🖼', webp:'🖼', lock:'🔒', sh:'$_', bash:'$_', zsh:'$_', env:'⚙' };
  return map[ext] || '·';
}

async function walkTree(dir, root = false, depth = 0) {
  const name = root ? dir.split('/').pop() || dir : dir.split('/').pop();
  const node = { name, abs: dir, isDir: true, children: [], ignored: false };
  if (depth < 0 || IGNORED.has(name) && !root) { node.ignored = true; return node; }
  try {
    const entries = await (await fetch('/api/fs/list?path=' + encodeURIComponent(root ? '' : dir.slice(currentCwd.length + 1)))).json();
    const list = entries.entries || [];
    for (const e of list) {
      const abs = dir + '/' + e.name;
      if (e.isDir) {
        const child = await walkTree(abs, false, depth - 1);
        node.children.push(child);
      } else {
        node.children.push({ name: e.name, abs, isDir: false, ignored: IGNORED.has(e.name) });
      }
    }
    node.children.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  } catch {}
  return node;
}

function renderTreeRoot() {
  treeRoot.innerHTML = '';
  if (!treeData) return;
  // root: show children directly, with indent
  const container = document.createElement('div');
  renderTreeNode(treeData, container, 4, true);
  treeRoot.appendChild(container);
}

function renderTreeNode(node, parent, pad, isRoot = false) {
  if (isRoot) {
    // render children directly at pad=0
    for (const c of node.children) {
      renderTreeNode(c, parent, 4, false);
    }
    return;
  }
  const row = document.createElement('div');
  row.className = 'tree-row ' + (node.isDir ? 'dir' : 'file') + (node.ignored ? ' file-ignored' : '');
  row.style.setProperty('--tree-pad', pad + 'px');
  row.dataset.abs = node.abs;
  row.innerHTML = `<span class="tree-caret">${node.isDir ? '▸' : ''}</span><span class="tree-ico">${node.isDir ? '📁' : fileIcon(node.name)}</span><span class="tree-name">${esc(node.name)}</span>`;
  parent.appendChild(row);
  let childContainer = null;
  if (node.isDir) {
    childContainer = document.createElement('div');
    childContainer.className = 'tree-children';
    parent.appendChild(childContainer);
  }
  row.addEventListener('contextmenu', (ev) => { ev.preventDefault(); ev.stopPropagation(); openTreeMenu(ev, node); });
  row.addEventListener('click', async (e) => {
    if (node.isDir) {
      // toggle expand
      const expanded = !childContainer.classList.contains('shown');
      childContainer.classList.toggle('shown', expanded);
      row.classList.toggle('expanded', expanded);
      // lazy load deeper when expanding and not yet populated fully
      if (expanded && childContainer.children.length === 0) {
        const deeper = await walkTree(node.abs, false, 2);
        for (const c of deeper.children) renderTreeNode(c, childContainer, pad + 12, false);
      }
    } else {
      // open file tab
      const rel = node.abs.slice(currentCwd.length + 1);
      openFileTab(rel, node.abs);
    }
  });
  if (node.isDir) {
    for (const c of node.children) {
      renderTreeNode(c, childContainer, pad + 12, false);
    }
  }
}

// search filter
treeSearch.addEventListener('input', () => {
  const q = treeSearch.value.toLowerCase().trim();
  filterTree(treeRoot, q);
});
function filterTree(root, q) {
  const rows = root.querySelectorAll('.tree-row');
  if (!q) {
    rows.forEach(r => { r.style.display = ''; });
    root.querySelectorAll('.tree-children').forEach(c => c.classList.remove('shown'));
    return;
  }
  // show all matching rows + all ancestors
  rows.forEach(r => r.style.display = 'none');
  rows.forEach(r => {
    const name = r.querySelector('.tree-name').textContent.toLowerCase();
    if (name.includes(q)) {
      r.style.display = '';
      // show parents
      let p = r.parentElement;
      while (p && p !== root) {
        if (p.classList.contains('tree-children')) p.classList.add('shown');
        if (p.classList.contains('tree-children')) {
          const prev = p.previousElementSibling;
          if (prev && prev.classList.contains('tree-row')) { prev.style.display = ''; prev.classList.add('expanded'); }
        }
        p = p.parentElement;
      }
    }
  });
}

treeReload.addEventListener('click', reloadTree);

// Sync on project switch
let _lastWorkCwd = currentCwd;
setInterval(() => {
  if (currentCwd !== _lastWorkCwd) {
    _lastWorkCwd = currentCwd;
    // reload tree
    treeData = null;
    if (workbar.classList.contains('open')) ensureTreeLoaded();
    // cd terminal tabs
    for (const t of tabs) {
      if (t.kind === 'terminal' && t.data.ws?.readyState === 1) {
        t.data.ws.send(JSON.stringify({ type: 'term_cd', path: currentCwd }));
        if (t.data.lbl) t.data.lbl.textContent = currentCwd;
      }
    }
    // close file tabs pointing to old cwd? keep them but update relative? simplest: close.
    for (const t of tabs.slice()) {
      if (t.kind === 'file' && !t.data.abs.startsWith(currentCwd + '/') && t.data.abs !== currentCwd) {
        closeTab(t.id);
      }
    }
  }
}, 800);

// ---- Model manager (Settings) ----
// Reads/writes <agentDir>/models.json, the same file pi uses. Bring your own key:
// nothing here goes through a control plane, so a fresh install only needs a URL + key.
const API_PROTOCOLS = [
  'openai-completions', 'openai-responses', 'anthropic-messages',
  'google-generative-ai', 'xai-responses',
];

$('#settings-btn')?.addEventListener('click', openModelManager);

async function openModelManager() {
  showModal('模型管理', '<div class="mm-empty">加载中…</div>', [{ label: '关闭' }]);
  modalOverlay.querySelector('.modal')?.classList.add('wide');
  modalBody.classList.add('mm-body');
  await mmList();
}

async function mmList() {
  let data;
  try {
    data = await jget('/api/providers');
  } catch (e) {
    modalBody.innerHTML = `<div class="mm-err">读取失败：${esc(String(e?.message || e))}</div>`;
    return;
  }
  const list = data.providers || [];
  modalBody.innerHTML = `
    <div class="mm-hint">配置存在 <code>${esc(data.path || '')}</code>，只保存在本机。</div>
    <div class="mm-list">${list.length ? list.map(mmRow).join('') : '<div class="mm-empty">还没有 provider，点下面添加。</div>'}</div>
    <button class="mm-btn mm-add" data-act="add">+ 添加 Provider</button>`;
  modalBody.onclick = async (ev) => {
    const btn = ev.target.closest('button[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const id = ev.target.closest('[data-id]')?.dataset.id;
    if (act === 'add') return mmForm(null);
    if (act === 'edit') return mmForm(list.find(p => p.id === id));
    if (act === 'del') {
      showModal('确认删除', `删除 provider <b>${esc(id)}</b>？它的模型配置和保存的 key 都会一并移除。`, [
        { label: '取消' },
        { label: '删除', primary: true, onClick: async () => {
            try { await jpost('/api/providers', { id, delete: true }); } catch (e) { console.error(e); }
            openModelManager();
          } },
      ]);
      return;
    }
    if (act === 'test') {
      const label = btn.textContent;
      btn.disabled = true;
      btn.textContent = '测试中…';
      try {
        const r = await jpost('/api/providers/test', { id });
        btn.classList.toggle('ok', !!r.ok);
        btn.textContent = r.ok ? `通 ${r.status} · ${r.ms}ms` : `失败 ${r.status || ''}`;
        if (!r.ok) btn.title = String(r.error || '');
      } catch (e) {
        btn.textContent = '失败';
        btn.title = String(e?.message || e);
      }
      setTimeout(() => { btn.disabled = false; btn.textContent = label; }, 3500);
    }
  };
}

function mmRow(p) {
  const keyLine = p.hasKey
    ? `key ${esc(p.keyMasked)}`
    : '<span class="mm-warn">未设置 key</span>';
  return `<div class="mm-row" data-id="${esc(p.id)}">
    <div class="mm-main">
      <div class="mm-name">${esc(p.name)}<span class="mm-badge">${esc(p.api)}</span></div>
      <div class="mm-sub">${esc(p.baseUrl || '未设置 baseUrl')}</div>
      <div class="mm-sub">${p.models.length} 个模型 · ${keyLine}</div>
    </div>
    <div class="mm-acts">
      <button data-act="test">测试</button>
      <button data-act="edit">编辑</button>
      <button data-act="del" class="danger">删除</button>
    </div>
  </div>`;
}

// Protocol identifiers shown as product names; the identifier is still what gets
// written to models.json, the label only spares the reader the schema spelling.
const PROTOCOL_LABELS = {
  'openai-completions': 'OpenAI 兼容 (/chat/completions)',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic Messages',
  'google-generative-ai': 'Google Generative AI',
  'xai-responses': 'xAI Responses',
};

// Capacities are stored as numbers but read as people say them (256K = 256000).
function formatCapacity(n) {
  if (n == null || n === '') return '';
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '';
  if (v >= 1e6 && v % 1e5 === 0) return `${v / 1e6}M`;
  if (v >= 1000 && v % 100 === 0) return `${v / 1000}K`;
  return String(v);
}
function parseCapacity(text) {
  const t = String(text || '').trim().toUpperCase().replace(/,/g, '');
  if (!t) return undefined;
  const m = t.match(/^([0-9.]+)\s*([KM]?)$/);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  const mult = m[2] === 'M' ? 1e6 : m[2] === 'K' ? 1e3 : 1;
  return Math.round(n * mult) || undefined;
}

// Reject a pasted `ARK_API_KEY=sk-...` shell line before it becomes a broken key.
function keyProblem(key) {
  const v = String(key || '').trim();
  if (!v) return '';
  if (/^[A-Z][A-Z0-9_]*=[^=]/.test(v)) return '看起来是整行环境变量，只填 = 右边那一段';
  if (/[\s]/.test(v)) return 'Key 里不能有空格或换行';
  if (/^["'`].*["'`]$/.test(v)) return '不要带引号，只填 key 本身';
  return '';
}

let mmModels = [];
let mmDraft = { id: '', name: '', baseUrl: '', api: 'openai-completions', hasKey: false, apiKey: '' };

const mmEmptyModel = () => ({ id: '', name: '', contextWindow: undefined, maxTokens: undefined });

function mmForm(p) {
  mmDraft = {
    id: p?.id || '', name: p?.name || '', baseUrl: p?.baseUrl || '',
    api: p?.api || 'openai-completions', hasKey: !!p?.hasKey, apiKey: '',
  };
  mmModels = (p?.models || []).map(m => ({
    id: m.id || '',
    name: m.name && m.name !== m.id ? m.name : '',
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
  }));
  if (!mmModels.length) mmModels = [mmEmptyModel()];
  mmRenderForm();
}

// Snapshot what is on screen so a re-render (e.g. coming back from the model picker)
// never loses what the user already typed.
function mmCollectForm() {
  for (const f of ['id', 'name', 'baseUrl', 'api', 'apiKey']) {
    const el = modalBody.querySelector(`[data-f="${f}"]`);
    if (el) mmDraft[f] = el.value;
  }
  mmCollectRows();
}

function mmRenderForm() {
  const protocolOptions = Object.entries(PROTOCOL_LABELS)
    .map(([id, label]) => `<option value="${id}" ${mmDraft.api === id ? 'selected' : ''}>${esc(label)}</option>`)
    .join('');
  const editing = !!mmDraft.hasKey || !!mmDraft.id;
  modalBody.innerHTML = `
    <div class="mm-form">
      <div class="mm-grid2">
        <label>Provider ID<input data-f="id" type="text" value="${esc(mmDraft.id)}" ${editing ? 'readonly' : ''} placeholder="openai / ollama / my-proxy"></label>
        <label>显示名<input data-f="name" type="text" value="${esc(mmDraft.name)}" placeholder="OpenAI"></label>
      </div>
      <label>Base URL<input data-f="baseUrl" type="text" value="${esc(mmDraft.baseUrl)}" placeholder="https://api.openai.com/v1"></label>
      <div class="mm-grid2">
        <label>API 协议<select data-f="api">${protocolOptions}</select></label>
        <label>API Key<input data-f="apiKey" type="password" autocomplete="off" value="${esc(mmDraft.apiKey || '')}" placeholder="${mmDraft.hasKey ? '已保存，留空不修改' : 'sk-...'}"></label>
      </div>
      <div class="mm-keyhint hidden" data-role="keyhint"></div>
      <div class="mm-models">
        <div class="mm-models-head">
          <span>模型（容量留空 = 用 provider 默认值）</span>
          <button class="mm-mini" data-act="discover">从 provider 拉取</button>
        </div>
        <div class="mm-model-rows" data-role="rows"></div>
        <button class="mm-mini" data-act="add-model">+ 添加模型</button>
      </div>
    </div>
    <div class="mm-actions">
      <button class="mm-btn primary" data-act="save">保存</button>
      <button class="mm-btn" data-act="back">返回</button>
    </div>`;
  mmRenderRows();

  const keyInput = modalBody.querySelector('[data-f="apiKey"]');
  keyInput.oninput = (ev) => {
    const hint = modalBody.querySelector('[data-role="keyhint"]');
    const msg = keyProblem(ev.target.value);
    hint.textContent = msg;
    hint.classList.toggle('hidden', !msg);
  };

  modalBody.onclick = async (ev) => {
    const btn = ev.target.closest('button[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'back') return mmList();
    if (act === 'add-model') { mmCollectForm(); mmModels.push(mmEmptyModel()); return mmRenderForm(); }
    if (act === 'rm-model') { mmCollectForm(); mmModels.splice(Number(btn.dataset.i), 1); if (!mmModels.length) mmModels = [mmEmptyModel()]; return mmRenderForm(); }
    if (act === 'discover') return mmDiscover(btn);
    if (act !== 'save') return;

    mmCollectForm();
    const id = String(mmDraft.id || '').trim();
    if (!id) {
      btn.textContent = '先填 Provider ID';
      setTimeout(() => (btn.textContent = '保存'), 1800);
      return;
    }
    const key = String(mmDraft.apiKey || '').trim();
    const bad = keyProblem(key);
    if (bad) {
      btn.textContent = bad;
      setTimeout(() => (btn.textContent = '保存'), 2400);
      return;
    }
    const body = {
      id,
      name: String(mmDraft.name || '').trim() || id,
      baseUrl: String(mmDraft.baseUrl || '').trim(),
      api: mmDraft.api,
      models: mmModels.filter(m => m.id.trim()).map(m => ({
        id: m.id.trim(),
        name: (m.name || '').trim() || m.id.trim(),
        ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
        ...(m.maxTokens ? { maxTokens: m.maxTokens } : {}),
      })),
    };
    if (key) body.apiKey = key;
    btn.disabled = true;
    btn.textContent = '保存中…';
    try { await jpost('/api/providers', body); await refreshModels(); await mmList(); }
    catch (e) { btn.disabled = false; btn.textContent = '保存失败，重试'; btn.title = String(e?.message || e); }
  };
}

function mmRenderRows() {
  const box = modalBody.querySelector('[data-role="rows"]');
  if (!box) return;
  box.innerHTML = mmModels.map((m, i) => `
    <div class="mm-model-row" data-i="${i}">
      <input data-mf="id" type="text" value="${esc(m.id)}" placeholder="模型 ID（必填）" aria-label="模型 ID ${i + 1}">
      <input data-mf="name" type="text" value="${esc(m.name || '')}" placeholder="显示名（可选）" aria-label="显示名 ${i + 1}">
      <input data-mf="contextWindow" type="text" value="${formatCapacity(m.contextWindow)}" placeholder="256K" aria-label="上下文窗口 ${i + 1}">
      <input data-mf="maxTokens" type="text" value="${formatCapacity(m.maxTokens)}" placeholder="32K" aria-label="最大输出 ${i + 1}">
      <button class="mm-mini danger" data-act="rm-model" data-i="${i}" title="删除这一行">×</button>
    </div>`).join('');
}

function mmCollectRows() {
  const box = modalBody.querySelector('[data-role="rows"]');
  if (!box) return;
  box.querySelectorAll('.mm-model-row').forEach(row => {
    const m = mmModels[Number(row.dataset.i)];
    if (!m) return;
    row.querySelectorAll('[data-mf]').forEach(inp => {
      const f = inp.dataset.mf;
      m[f] = (f === 'contextWindow' || f === 'maxTokens') ? parseCapacity(inp.value) : inp.value;
    });
  });
}

async function mmDiscover(btn) {
  mmCollectForm();
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '拉取中…';
  try {
    const r = await jpost('/api/providers/discover', {
      id: String(mmDraft.id || '').trim() || undefined,
      baseUrl: String(mmDraft.baseUrl || '').trim(),
      apiKey: String(mmDraft.apiKey || '').trim() || undefined,
    });
    btn.disabled = false;
    btn.textContent = label;
    if (!r.ok || !r.models?.length) {
      btn.textContent = r.ok ? '没返回模型' : `失败 ${r.status || ''}`;
      btn.title = String(r.error || '');
      setTimeout(() => (btn.textContent = label), 3000);
      return;
    }
    mmPickModels(r.models);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = '拉取失败';
    btn.title = String(e?.message || e);
    setTimeout(() => (btn.textContent = label), 3000);
  }
}

function mmPickModels(candidates) {
  const have = new Set(mmModels.map(m => m.id.trim()).filter(Boolean));
  const rows = candidates.map((c, i) => `
    <label class="mm-pick-row">
      <input type="checkbox" data-i="${i}" ${have.has(c.id) ? 'checked disabled' : ''}>
      <span class="mm-pick-id">${esc(c.id)}</span>
      ${c.contextWindow ? `<span class="mm-badge">${formatCapacity(c.contextWindow)}</span>` : ''}
    </label>`).join('');
  showModal(`拉到 ${candidates.length} 个模型`, `<div class="mm-picks">${rows}</div>`, [
    { label: '取消', onClick: () => mmRenderFormAfterPick() },
    { label: '导入所选', primary: true, onClick: () => {
        const picked = [...modalBody.querySelectorAll('input[type=checkbox]:checked:not([disabled])')]
          .map(el => candidates[Number(el.dataset.i)]);
        mmModels = mmModels.filter(m => m.id.trim());
        for (const c of picked) mmModels.push({ id: c.id, name: c.name || '', contextWindow: c.contextWindow, maxTokens: c.maxTokens });
        if (!mmModels.length) mmModels = [mmEmptyModel()];
        mmRenderFormAfterPick();
      } },
  ]);
}

// showModal replaced the body; re-render the editor from the retained draft.
function mmRenderFormAfterPick() {
  showModal('模型管理', '', [{ label: '关闭' }]);
  modalOverlay.querySelector('.modal')?.classList.add('wide');
  modalBody.classList.add('mm-body');
  mmRenderForm();
}

// Kick off initial tree load once currentCwd is populated
function waitForCwd() {
  if (currentCwd) { setWorkbar(!onboardingMode); updateTreeVisibility(); return; }
  setTimeout(waitForCwd, 100);
}
waitForCwd();

// Connect WebSocket (must be last so all handlers are registered)
connect();
