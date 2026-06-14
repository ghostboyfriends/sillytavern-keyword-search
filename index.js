/* 关键词搜索 Keyword Search for SillyTavern  v1.1.0
 * 搜索范围：当前预设 / 世界书 / 当前角色卡 / 当前聊天 / 全部角色卡 / 全部聊天
 * 数据访问统一走 SillyTavern.getContext()，跨版本相对稳定。
 */

const EXT_ID = 'keyword-search';
const ctx = () => SillyTavern.getContext();

/* ============================================================
 * 数据访问层（多路探测 + 降级）
 * 字段名各版本偶有差异，跑不出来时按 F12 里 SillyTavern.getContext()
 * 看到的真实字段名微调下面几行即可。
 * ========================================================== */

// 当前对话补全预设的条目（Prompt Manager 的 prompts 数组）
function getPresetPrompts() {
    const c = ctx();
    const oai = c.chatCompletionSettings || (typeof window !== 'undefined' && window.oai_settings) || c.oai_settings;
    if (oai && Array.isArray(oai.prompts)) return oai.prompts;
    console.warn(`[${EXT_ID}] 没找到预设 prompts，请检查 getContext().chatCompletionSettings`);
    return [];
}

// 全部世界书条目（遍历所有 lorebook）
async function getWorldInfoEntries() {
    const c = ctx();
    const names = (typeof c.getWorldInfoNames === 'function' ? c.getWorldInfoNames() : null)
        || c.world_names || (typeof window !== 'undefined' && window.world_names) || [];
    const loader = c.loadWorldInfo || (typeof window !== 'undefined' && window.loadWorldInfo);
    const out = [];
    if (!loader || !names.length) {
        if (!loader) console.warn(`[${EXT_ID}] 没找到 loadWorldInfo，世界书搜索不可用`);
        return out;
    }
    for (const name of names) {
        try {
            const data = await loader(name);
            const entries = (data && data.entries) ? data.entries : {};
            for (const uid of Object.keys(entries)) {
                const e = entries[uid];
                const keys = [].concat(e.key || [], e.keysecondary || []);
                const title = e.comment || (keys.length ? keys.join(', ') : `#${uid}`);
                out.push({ title: `${name} · ${title}`, content: `${e.content || ''}` });
            }
        } catch (err) {
            console.warn(`[${EXT_ID}] 世界书读取失败: ${name}`, err);
        }
    }
    return out;
}

// 把一个角色对象拆成可搜索的字段
function characterToItems(ch) {
    if (!ch) return [];
    const d = ch.data || {};
    const fields = [
        ['描述 description', ch.description ?? d.description],
        ['性格 personality', ch.personality ?? d.personality],
        ['场景 scenario', ch.scenario ?? d.scenario],
        ['开场白 first_mes', ch.first_mes ?? d.first_mes],
        ['对话示例 mes_example', ch.mes_example ?? d.mes_example],
        ['创作笔记 creator_notes', d.creator_notes],
        ['系统提示 system_prompt', d.system_prompt],
        ['历史后指令 post_history', d.post_history_instructions],
    ];
    return fields
        .filter(([, v]) => v && `${v}`.trim())
        .map(([label, v]) => ({ title: `${ch.name} · ${label}`, content: `${v}` }));
}

// 当前角色卡
function getCharacterFields() {
    const c = ctx();
    return characterToItems(c.characters && c.characters[c.characterId]);
}

// 全部角色卡（浅加载的角色需先 unshallow 才有正文）
async function getAllCharacterFields(onProgress) {
    const c = ctx();
    const chars = c.characters || [];
    const out = [];
    for (let i = 0; i < chars.length; i++) {
        try {
            if (chars[i] && chars[i].shallow && typeof c.unshallowCharacter === 'function') {
                await c.unshallowCharacter(i);
            }
        } catch (e) {
            console.warn(`[${EXT_ID}] 角色卡加载失败 #${i}`, e);
        }
        out.push(...characterToItems(c.characters[i]));
        onProgress && onProgress(i + 1, chars.length);
    }
    return out;
}

// 当前聊天记录
function getChatMessages() {
    const c = ctx();
    const chat = c.chat || [];
    return chat.map((m, i) => ({
        title: `#${i} ${m.is_user ? (c.name1 || 'You') : (m.name || 'Char')}`,
        content: `${m.mes || ''}`,
    }));
}

// 全部聊天记录（遍历所有角色 + 群组，逐文件从后端拉取）
async function getAllChatItems(onProgress) {
    const c = ctx();
    const headers = typeof c.getRequestHeaders === 'function' ? c.getRequestHeaders() : {};
    const chars = c.characters || [];
    const groups = c.groups || [];
    const total = chars.length + groups.length;
    let done = 0;
    const out = [];

    const flatten = (arr, dropFirst) => {
        const list = Array.isArray(arr) ? arr.slice() : [];
        if (dropFirst && list.length) list.shift(); // 单人聊天首项是元数据
        return list.map(m => (m && m.mes ? `${m.mes}` : '')).filter(Boolean).join('\n');
    };

    // 角色聊天
    for (const ch of chars) {
        if (ch && ch.avatar) {
            try {
                const listResp = await fetch('/api/characters/chats', {
                    method: 'POST', headers,
                    body: JSON.stringify({ avatar_url: ch.avatar }),
                });
                if (listResp.ok) {
                    const data = await listResp.json();
                    const files = (data && data.error) ? [] : Object.values(data);
                    // 同一角色的多个聊天文件并行拉取
                    await Promise.all(files.map(async (f) => {
                        const fileName = `${f.file_name}`.replace(/\.jsonl$/, '');
                        try {
                            const r = await fetch('/api/chats/get', {
                                method: 'POST', headers, cache: 'no-cache',
                                body: JSON.stringify({ ch_name: ch.name, file_name: fileName, avatar_url: ch.avatar }),
                            });
                            if (r.ok) {
                                const text = flatten(await r.json(), true);
                                if (text.trim()) out.push({ title: `${ch.name} · ${fileName}`, content: text });
                            }
                        } catch (e) { console.warn(`[${EXT_ID}] 取聊天失败`, ch.name, fileName, e); }
                    }));
                }
            } catch (e) { console.warn(`[${EXT_ID}] 列聊天失败`, ch.name, e); }
        }
        onProgress && onProgress(++done, total);
    }

    // 群组聊天
    for (const g of groups) {
        const files = Array.isArray(g.chats) ? g.chats : [];
        await Promise.all(files.map(async (fileName) => {
            try {
                const r = await fetch('/api/chats/group/get', {
                    method: 'POST', headers, cache: 'no-cache',
                    body: JSON.stringify({ id: fileName }),
                });
                if (r.ok) {
                    const text = flatten(await r.json(), false);
                    if (text.trim()) out.push({ title: `[群] ${g.name} · ${fileName}`, content: text });
                }
            } catch (e) { console.warn(`[${EXT_ID}] 取群聊失败`, g.name, fileName, e); }
        }));
        onProgress && onProgress(++done, total);
    }
    return out;
}

/* ============================================================
 * 搜索引擎
 * ========================================================== */

function buildRegex(query, { caseSensitive, regex }) {
    const flags = caseSensitive ? 'g' : 'gi';
    if (regex) return new RegExp(query, flags);
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(escaped, flags);
}

function scan(items, query, opts) {
    let re;
    try { re = buildRegex(query, opts); }
    catch (e) { throw new Error('正则表达式无效: ' + e.message); }

    const results = [];
    let total = 0;
    for (const item of items) {
        const text = item.content || '';
        re.lastIndex = 0;
        let m, count = 0;
        const snippets = [];
        while ((m = re.exec(text)) !== null) {
            count++;
            if (m.index === re.lastIndex) re.lastIndex++; // 防零宽匹配死循环
            if (snippets.length < 3) {
                const s = Math.max(0, m.index - 40);
                const e = Math.min(text.length, m.index + m[0].length + 40);
                snippets.push({
                    before: text.slice(s, m.index),
                    match: m[0],
                    after: text.slice(m.index + m[0].length, e),
                    truncStart: s > 0,
                    truncEnd: e < text.length,
                });
            }
        }
        if (count > 0) {
            total += count;
            results.push({ title: item.title, count, snippets });
        }
    }
    results.sort((a, b) => b.count - a.count);
    return { results, total };
}

async function runSearch(query, scopes, opts, onProgress) {
    const groups = [];
    if (scopes.preset) {
        const items = getPresetPrompts()
            .filter(p => !p.marker && p.content)
            .map(p => ({ title: p.name || p.identifier || '(未命名条目)', content: `${p.content}` }));
        groups.push({ label: '当前预设', icon: 'fa-sliders', ...scan(items, query, opts) });
    }
    if (scopes.world) {
        onProgress && onProgress('读取世界书…');
        const items = await getWorldInfoEntries();
        groups.push({ label: '世界书', icon: 'fa-book', ...scan(items, query, opts) });
    }
    if (scopes.char) {
        groups.push({ label: '当前角色卡', icon: 'fa-user', ...scan(getCharacterFields(), query, opts) });
    }
    if (scopes.charAll) {
        const items = await getAllCharacterFields((d, t) => onProgress && onProgress(`加载角色卡 ${d}/${t}`));
        groups.push({ label: '全部角色卡', icon: 'fa-users', ...scan(items, query, opts) });
    }
    if (scopes.chat) {
        groups.push({ label: '当前聊天', icon: 'fa-comment', ...scan(getChatMessages(), query, opts) });
    }
    if (scopes.chatAll) {
        const items = await getAllChatItems((d, t) => onProgress && onProgress(`扫描聊天 ${d}/${t}`));
        groups.push({ label: '全部聊天', icon: 'fa-comments', ...scan(items, query, opts) });
    }
    return groups;
}

/* ============================================================
 * UI
 * ========================================================== */

function esc(s) {
    return `${s}`.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* ---------- UI（使用酒馆原生弹窗渲染，移动端更稳） ---------- */

const PANEL_HTML = `
<div class="kwsearch-panel">
  <div class="kwsearch-title"><i class="fa-solid fa-magnifying-glass"></i> 关键词搜索</div>
  <input type="text" class="text_pole kws-input" placeholder="输入关键词，例如：女性向" />
  <div class="kwsearch-scopes">
    <label><input type="checkbox" data-scope="preset" checked> 当前预设</label>
    <label><input type="checkbox" data-scope="world" checked> 世界书</label>
    <label><input type="checkbox" data-scope="char"> 当前角色卡</label>
    <label><input type="checkbox" data-scope="chat"> 当前聊天</label>
  </div>
  <div class="kwsearch-scopes kwsearch-global">
    <span class="kwsearch-scope-tag">全局</span>
    <label><input type="checkbox" data-scope="charAll"> 全部角色卡</label>
    <label><input type="checkbox" data-scope="chatAll"> 全部聊天</label>
    <span class="kwsearch-hint">需扫描磁盘，较慢</span>
  </div>
  <div class="kwsearch-opts">
    <label><input type="checkbox" class="kws-case"> 区分大小写</label>
    <label><input type="checkbox" class="kws-regex"> 正则模式</label>
    <button class="menu_button kws-go">搜索</button>
  </div>
  <div class="kwsearch-summary"></div>
  <div class="kwsearch-results"></div>
</div>`;

function renderResults(panel, groups, query) {
    const summary = panel.querySelector('.kwsearch-summary');
    const box = panel.querySelector('.kwsearch-results');
    const grand = groups.reduce((a, g) => a + g.total, 0);
    const hits = groups.reduce((a, g) => a + g.results.length, 0);
    summary.innerHTML = `关键词 “<b>${esc(query)}</b>” 共出现 <b>${grand}</b> 次，分布在 <b>${hits}</b> 个条目中。`;

    let html = '';
    for (const g of groups) {
        html += `<div class="kwsearch-group">
          <div class="kwsearch-group-head"><i class="fa-solid ${g.icon}"></i> ${g.label}
            <span class="kwsearch-badge">${g.total} 次 / ${g.results.length} 条</span></div>`;
        if (!g.results.length) {
            html += `<div class="kwsearch-empty">无匹配</div>`;
        } else {
            for (const r of g.results) {
                html += `<div class="kwsearch-item">
                  <div class="kwsearch-item-head">
                    <span class="kwsearch-title">${esc(r.title)}</span>
                    <span class="kwsearch-count">×${r.count}</span>
                  </div>`;
                for (const s of r.snippets) {
                    html += `<div class="kwsearch-snip">${s.truncStart ? '…' : ''}${esc(s.before)}<mark>${esc(s.match)}</mark>${esc(s.after)}${s.truncEnd ? '…' : ''}</div>`;
                }
                if (r.count > r.snippets.length) {
                    html += `<div class="kwsearch-more">还有 ${r.count - r.snippets.length} 处未显示</div>`;
                }
                html += `</div>`;
            }
        }
        html += `</div>`;
    }
    box.innerHTML = html;
}

let kwSearching = false;

async function doSearch(panel) {
    if (kwSearching) return;
    const query = panel.querySelector('.kws-input').value.trim();
    if (!query) return;

    const scopes = {};
    panel.querySelectorAll('[data-scope]').forEach(cb => { scopes[cb.dataset.scope] = cb.checked; });
    const opts = {
        caseSensitive: panel.querySelector('.kws-case').checked,
        regex: panel.querySelector('.kws-regex').checked,
    };

    const summary = panel.querySelector('.kwsearch-summary');
    const goBtn = panel.querySelector('.kws-go');
    panel.querySelector('.kwsearch-results').innerHTML = '';
    summary.textContent = '搜索中…';
    kwSearching = true;
    goBtn.disabled = true;
    try {
        const onProgress = (stage) => { summary.textContent = `搜索中… ${stage}`; };
        const groups = await runSearch(query, scopes, opts, onProgress);
        renderResults(panel, groups, query);
    } catch (e) {
        summary.innerHTML = `<span class="kwsearch-error">${esc(e.message)}</span>`;
    } finally {
        kwSearching = false;
        goBtn.disabled = false;
    }
}

function buildPanel(prefill) {
    const tmp = document.createElement('div');
    tmp.innerHTML = PANEL_HTML.trim();
    const panel = tmp.firstElementChild;
    const input = panel.querySelector('.kws-input');
    panel.querySelector('.kws-go').addEventListener('click', () => doSearch(panel));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSearch(panel); } });
    if (prefill) input.value = prefill;
    return panel;
}

// 兜底浮层（仅当酒馆没有原生弹窗 API 时使用）
function showFallback(panel) {
    const overlay = document.createElement('div');
    overlay.className = 'kwsearch-modal';
    overlay.style.display = 'flex';
    const box = document.createElement('div');
    box.className = 'kwsearch-box';
    box.appendChild(panel);
    overlay.appendChild(box);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
}

async function openModal(prefill) {
    const c = ctx();
    const panel = buildPanel(prefill);
    if (typeof c.callGenericPopup === 'function' && c.POPUP_TYPE) {
        const promise = c.callGenericPopup(panel, c.POPUP_TYPE.TEXT, '', {
            large: true,
            wide: true,
            allowVerticalScrolling: true,
            okButton: '关闭',
            cancelButton: false,
        });
        setTimeout(() => {
            try { panel.querySelector('.kws-input').focus(); } catch (e) { /* ignore */ }
            if (prefill) doSearch(panel);
        }, 50);
        await promise;
    } else {
        showFallback(panel);
        if (prefill) doSearch(panel);
    }
}

// 在魔棒（扩展）菜单里加一个入口
function addLauncher() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('kwsearch-launcher')) return;
    const item = document.createElement('div');
    item.id = 'kwsearch-launcher';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.innerHTML = `<div class="fa-fw fa-solid fa-magnifying-glass extensionsMenuExtensionButton"></div><span>关键词搜索</span>`;
    item.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openModal(); });
    menu.appendChild(item);
}

// 斜杠命令 /kwsearch [关键词]
function registerSlash() {
    const c = ctx();
    // 新版 API
    try {
        if (c.SlashCommandParser && c.SlashCommand && typeof c.SlashCommand.fromProps === 'function') {
            c.SlashCommandParser.addCommandObject(c.SlashCommand.fromProps({
                name: 'kwsearch',
                callback: (_args, value) => { openModal(value ? `${value}`.trim() : ''); return ''; },
                helpString: '打开关键词搜索面板，可附带关键词',
            }));
            return;
        }
    } catch (e) {
        console.warn(`[${EXT_ID}] 新版斜杠命令注册失败`, e);
    }
    // 旧版兜底
    try {
        if (typeof c.registerSlashCommand === 'function') {
            c.registerSlashCommand('kwsearch', (_, value) => { openModal(value ? `${value}`.trim() : ''); return ''; }, [], '打开关键词搜索面板', true, true);
        }
    } catch (e) {
        console.warn(`[${EXT_ID}] 旧版斜杠命令注册失败`, e);
    }
}

function init() {
    registerSlash();
    // 魔棒菜单可能晚于扩展加载，轮询挂入口
    let n = 0;
    const t = setInterval(() => {
        addLauncher();
        if (document.getElementById('kwsearch-launcher') || ++n > 60) clearInterval(t);
    }, 500);
}

jQuery(() => init());
