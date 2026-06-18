/* 关键词搜索 Keyword Search for SillyTavern  v1.1.0
 * 搜索范围：当前预设 / 世界书 / 当前角色卡 / 当前聊天 / 全部角色卡 / 全部聊天
 * 数据访问统一走 SillyTavern.getContext()，跨版本相对稳定。
 */

const EXT_ID = 'keyword-search';
const ctx = () => SillyTavern.getContext();

/* ============================================================
 * 持久化存储（历史记录 / 上次搜索状态，存进酒馆扩展设置）
 * ========================================================== */

const HISTORY_MAX = 10;

function getStore() {
    const c = ctx();
    const root = c.extensionSettings || c.extension_settings;
    if (!root) return null;
    if (!root[EXT_ID]) root[EXT_ID] = {};
    return root[EXT_ID];
}

function saveStore() {
    try {
        const save = ctx().saveSettingsDebounced;
        if (typeof save === 'function') save();
    } catch (e) { /* ignore */ }
}

function getHistory() {
    const s = getStore();
    return (s && Array.isArray(s.history)) ? s.history : [];
}

function addHistory(q) {
    const s = getStore();
    if (!s) return;
    let h = Array.isArray(s.history) ? s.history.filter(x => x !== q) : [];
    h.unshift(q);
    s.history = h.slice(0, HISTORY_MAX);
    saveStore();
}

function removeHistory(q) {
    const s = getStore();
    if (!s) return;
    s.history = (s.history || []).filter(x => x !== q);
    saveStore();
}

function clearHistory() {
    const s = getStore();
    if (!s) return;
    s.history = [];
    saveStore();
}

function saveLastState(query, scopes, opts) {
    const s = getStore();
    if (!s) return;
    s.last = { query, scopes, opts };
    saveStore();
}

function getLastState() {
    const s = getStore();
    return s ? s.last : null;
}

// 上次搜索结果（仅本会话内存，不持久化——结果可能过时且体积大）
let kwLastGroups = null;
let kwLastQuery = '';
let kwLastOpts = { caseSensitive: false, regex: false };

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
                out.push({ title: `${name} · ${title}`, content: `${e.content || ''}`, jump: { type: 'wi', book: name, uid } });
            }
        } catch (err) {
            console.warn(`[${EXT_ID}] 世界书读取失败: ${name}`, err);
        }
    }
    return out;
}

// 把一个角色对象拆成可搜索的字段。withJump=true 时附带跳转信息（仅当前角色用）
function characterToItems(ch, withJump) {
    if (!ch) return [];
    const d = ch.data || {};
    const fields = [
        ['description', '描述 description', ch.description ?? d.description],
        ['personality', '性格 personality', ch.personality ?? d.personality],
        ['scenario', '场景 scenario', ch.scenario ?? d.scenario],
        ['first_mes', '开场白 first_mes', ch.first_mes ?? d.first_mes],
        ['mes_example', '对话示例 mes_example', ch.mes_example ?? d.mes_example],
        ['creator_notes', '创作笔记 creator_notes', d.creator_notes],
        ['system_prompt', '系统提示 system_prompt', d.system_prompt],
        ['post_history', '历史后指令 post_history', d.post_history_instructions],
    ];
    return fields
        .filter(([, , v]) => v && `${v}`.trim())
        .map(([key, label, v]) => {
            const item = { title: `${ch.name} · ${label}`, content: `${v}` };
            if (withJump) item.jump = { type: 'char', field: key };
            return item;
        });
}

// 当前角色卡
function getCharacterFields() {
    const c = ctx();
    return characterToItems(c.characters && c.characters[c.characterId], true);
}

// 该角色绑定的世界书条目（内嵌 character_book + data.extensions.world + charLore 附加书）
async function getCharBoundWorldItems(ch) {
    if (!ch) return [];
    const c = ctx();
    const out = [];
    const bookNames = new Set();
    const d = ch.data || {};
    if (d.extensions && d.extensions.world) bookNames.add(d.extensions.world);
    try {
        const wiMod = await import('/scripts/world-info.js');
        const fileName = `${ch.avatar || ''}`.replace(/\.[^.]+$/, '');
        const lore = (wiMod && wiMod.world_info && Array.isArray(wiMod.world_info.charLore))
            ? wiMod.world_info.charLore.find(x => x.name === fileName) : null;
        if (lore && Array.isArray(lore.extraBooks)) lore.extraBooks.forEach(n => bookNames.add(n));
    } catch (e) { console.warn(`[${EXT_ID}] 读取 charLore 失败`, e); }
    // 命名世界书（可跳转）
    const loader = c.loadWorldInfo || (typeof window !== 'undefined' && window.loadWorldInfo);
    if (loader) {
        for (const name of bookNames) {
            try {
                const data = await loader(name);
                const entries = (data && data.entries) ? data.entries : {};
                for (const uid of Object.keys(entries)) {
                    const e = entries[uid];
                    const keys = [].concat(e.key || [], e.keysecondary || []);
                    const title = e.comment || (keys.length ? keys.join(', ') : `#${uid}`);
                    out.push({ title: `${name} · ${title}`, content: `${e.content || ''}`, jump: { type: 'wi', book: name, uid } });
                }
            } catch (e) { console.warn(`[${EXT_ID}] 角色世界书读取失败: ${name}`, e); }
        }
    }
    // 内嵌 character_book（无独立世界书可跳，仅展示）
    const emb = d.character_book && d.character_book.entries;
    if (emb) {
        const list = Array.isArray(emb) ? emb : Object.values(emb);
        for (const e of list) {
            if (!e) continue;
            const keys = [].concat(e.keys || e.key || []);
            const title = e.comment || (keys.length ? keys.join(', ') : '(内嵌条目)');
            out.push({ title: `内嵌 · ${title}`, content: `${e.content || ''}` });
        }
    }
    return out;
}

// 该角色的全部聊天存档（按消息，点击可跳到具体楼层；非当前存档会先打开）
async function getCharacterChatItems(ch) {
    if (!ch || !ch.avatar) return [];
    const c = ctx();
    const headers = typeof c.getRequestHeaders === 'function' ? c.getRequestHeaders() : {};
    const out = [];
    try {
        const listResp = await fetch('/api/characters/chats', { method: 'POST', headers, body: JSON.stringify({ avatar_url: ch.avatar }) });
        if (listResp.ok) {
            const data = await listResp.json();
            const files = (data && data.error) ? [] : Object.values(data);
            await Promise.all(files.map(async (f) => {
                const fileName = `${f.file_name}`.replace(/\.jsonl$/, '');
                try {
                    const r = await fetch('/api/chats/get', { method: 'POST', headers, cache: 'no-cache', body: JSON.stringify({ ch_name: ch.name, file_name: fileName, avatar_url: ch.avatar }) });
                    if (r.ok) {
                        const arr = await r.json();
                        const list = Array.isArray(arr) ? arr.slice() : [];
                        if (list.length) list.shift(); // 首项是元数据
                        list.forEach((m, i) => {
                            const mes = m && m.mes ? `${m.mes}` : '';
                            if (!mes.trim()) return;
                            const who = m.is_user ? (c.name1 || 'You') : (m.name || ch.name);
                            out.push({ title: `${fileName} · #${i} ${who}`, content: mes, jump: { type: 'chatfile', file: fileName, mesid: i } });
                        });
                    }
                } catch (e) { console.warn(`[${EXT_ID}] 取该角色聊天失败`, fileName, e); }
            }));
        }
    } catch (e) { console.warn(`[${EXT_ID}] 列该角色聊天失败`, e); }
    return out;
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
        jump: { type: 'chat', mesid: i },
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
            results.push({ title: item.title, count, snippets, jump: item.jump });
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
            .map(p => ({ title: p.name || p.identifier || '(未命名条目)', content: `${p.content}`, jump: { type: 'preset', identifier: p.identifier, name: p.name } }));
        groups.push({ label: '当前预设', icon: 'fa-sliders', cat: 'preset', ...scan(items, query, opts) });
    }
    if (scopes.world) {
        onProgress && onProgress('读取世界书…');
        const items = await getWorldInfoEntries();
        groups.push({ label: '世界书', icon: 'fa-book', cat: 'wi', ...scan(items, query, opts) });
    }
    if (scopes.char) {
        const cc = ctx();
        const ch = (cc.characters || [])[cc.characterId];
        groups.push({ label: '当前角色卡', icon: 'fa-user', cat: 'char', ...scan(getCharacterFields(), query, opts) });
        onProgress && onProgress('读取角色世界书…');
        const wItems = await getCharBoundWorldItems(ch);
        if (wItems.length) groups.push({ label: '角色世界书', icon: 'fa-book', cat: 'wi', ...scan(wItems, query, opts) });
        onProgress && onProgress('扫描该角色聊天…');
        const cItems = await getCharacterChatItems(ch);
        if (cItems.length) groups.push({ label: '该角色聊天', icon: 'fa-comments', cat: 'chat', ...scan(cItems, query, opts) });
    }
    if (scopes.charAll) {
        const items = await getAllCharacterFields((d, t) => onProgress && onProgress(`加载角色卡 ${d}/${t}`));
        groups.push({ label: '全部角色卡', icon: 'fa-users', cat: 'char', ...scan(items, query, opts) });
    }
    if (scopes.chat) {
        groups.push({ label: '当前聊天', icon: 'fa-comment', cat: 'chat', ...scan(getChatMessages(), query, opts) });
    }
    if (scopes.chatAll) {
        const items = await getAllChatItems((d, t) => onProgress && onProgress(`扫描聊天 ${d}/${t}`));
        groups.push({ label: '全部聊天', icon: 'fa-comments', cat: 'chat', ...scan(items, query, opts) });
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

// 可选配色：8 套色系 + 跟随酒馆主题 + 跟随时间
const KW_DEFAULT_THEME = 'mist';

const PANEL_HTML = `
<div class="kwsearch-panel" data-theme="mist">
 <div class="kwsearch-glass">
  <div class="kwsearch-head">
    <div class="kwsearch-title"><span class="kwsearch-ic"><i class="fa-solid fa-magnifying-glass"></i></span>关键词搜索</div>
    <div class="kwsearch-sw">
      <button class="kws-dot" data-t="gold" style="background:linear-gradient(160deg,#fbe6a8,#d4a73c)" title="黑金"></button>
      <button class="kws-dot" data-t="violet" style="background:linear-gradient(160deg,#ecc4ff,#a64dff)" title="粉紫"></button>
      <button class="kws-dot" data-t="crimson" style="background:linear-gradient(135deg,#6db4ff,#ff8aa3)" title="红蓝"></button>
      <button class="kws-dot" data-t="emerald" style="background:linear-gradient(160deg,#9bf0cf,#1fae7e)" title="祖母绿"></button>
      <button class="kws-dot" data-t="ocean" style="background:linear-gradient(160deg,#a6e6fa,#1f93c9)" title="深海"></button>
      <button class="kws-dot" data-t="mist" style="background:linear-gradient(160deg,#fbfcff,#aeb8e0)" title="月白"></button>
      <button class="kws-dot" data-t="sakura" style="background:linear-gradient(160deg,#ffe1ec,#f3a8c4)" title="樱粉"></button>
      <button class="kws-dot" data-t="sunset" style="background:linear-gradient(160deg,#ffd9b3,#f2884b)" title="落日"></button>
      <button class="kws-dot kws-special" data-t="follow" title="跟随酒馆主题"><i class="fa-solid fa-palette"></i></button>
      <button class="kws-dot kws-time" data-t="auto" title="跟随时间"><i class="fa-solid fa-sun"></i></button>
      <button class="kws-close" title="关闭"><i class="fa-solid fa-xmark"></i></button>
    </div>
  </div>
  <input type="text" class="kws-input" placeholder="输入关键词，例如：女性向" />
  <div class="kwsearch-history"></div>
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
    <button class="kws-help" title="正则模式说明">?</button>
    <button class="kws-go"><i class="fa-solid fa-magnifying-glass"></i>搜索</button>
  </div>
  <div class="kwsearch-helpbox" hidden>正则模式：把关键词当成「正则表达式」来匹配，可用符号做高级/模糊搜索。例如 <code>女(性|权)</code> 同时匹配「女性」和「女权」，<code>\\d+</code> 匹配任意数字。不清楚就别勾，保持普通文字搜索即可。</div>
  <div class="kwsearch-summary"></div>
  <div class="kwsearch-tabs"></div>
  <div class="kwsearch-results"></div>
 </div>
</div>`;

const KW_NIGHT_THEME = 'ocean';
const KW_DAY_THEME = 'mist';

function getTheme() {
    const s = getStore();
    return (s && s.theme) ? s.theme : KW_DEFAULT_THEME;
}

function setTheme(key) {
    const s = getStore();
    if (s) { s.theme = key; saveStore(); }
}

function isDaytime() {
    const h = new Date().getHours();
    return h >= 6 && h < 18;
}

function resolveTheme(key) {
    if (key === 'auto') return isDaytime() ? KW_DAY_THEME : KW_NIGHT_THEME;
    return key;
}

function applyTheme(panel, key) {
    panel.setAttribute('data-theme', resolveTheme(key));
    panel.querySelectorAll('.kws-dot').forEach(d => d.classList.toggle('on', d.dataset.t === key));
    const auto = panel.querySelector('.kws-dot[data-t="auto"]');
    if (auto) {
        const day = isDaytime();
        auto.classList.toggle('day', day);
        auto.classList.toggle('night', !day);
        auto.innerHTML = `<i class="fa-solid ${day ? 'fa-sun' : 'fa-moon'}"></i>`;
    }
}

const KW_CATS = [['preset', '预设条目'], ['char', '角色卡'], ['wi', '世界书'], ['chat', '聊天记录']];

function applyTab(panel, cat) {
    panel.querySelectorAll('.kwsearch-group').forEach(g => {
        g.style.display = (cat === 'all' || g.dataset.cat === cat) ? '' : 'none';
    });
    panel.querySelectorAll('.kws-tab').forEach(t => t.classList.toggle('on', t.dataset.cat === cat));
}

function renderResults(panel, groups, query) {
    const summary = panel.querySelector('.kwsearch-summary');
    const tabsBox = panel.querySelector('.kwsearch-tabs');
    const box = panel.querySelector('.kwsearch-results');
    const grand = groups.reduce((a, g) => a + g.total, 0);
    const hits = groups.reduce((a, g) => a + g.results.length, 0);
    summary.innerHTML = `关键词 “<b>${esc(query)}</b>” 共出现 <b>${grand}</b> 次，分布在 <b>${hits}</b> 个条目中。`;

    // 只显示有结果的分组
    const shown = groups.filter(g => g.results.length > 0);

    // 分类标签卡：仅出现有结果的类别
    const present = KW_CATS.filter(([k]) => shown.some(g => g.cat === k));
    if (present.length > 0) {
        let th = `<button class="kws-tab on" data-cat="all">全部</button>`;
        for (const [k, name] of present) {
            const n = shown.filter(g => g.cat === k).reduce((a, g) => a + g.results.length, 0);
            th += `<button class="kws-tab" data-cat="${k}">${name} <span class="kws-tab-n">${n}</span></button>`;
        }
        tabsBox.innerHTML = th;
    } else {
        tabsBox.innerHTML = '';
    }

    const jumps = [];
    let html = '';
    for (const g of shown) {
        html += `<div class="kwsearch-group" data-cat="${g.cat}">
          <div class="kwsearch-group-head"><i class="fa-solid ${g.icon}"></i> ${g.label}
            <span class="kwsearch-badge">${g.total} 次 / ${g.results.length} 条</span></div>`;
        for (const r of g.results) {
            let attr = '';
            if (r.jump) {
                attr = ` data-jump="${jumps.length}" title="点击跳转到该位置"`;
                jumps.push(r.jump);
            }
            html += `<div class="kwsearch-item${r.jump ? ' kwsearch-clickable' : ''}"${attr}>
              <div class="kwsearch-item-head">
                <span class="kwsearch-title">${esc(r.title)}${r.jump ? ' <i class="fa-solid fa-arrow-right-to-bracket kwsearch-jump-icon"></i>' : ''}</span>
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
        html += `</div>`;
    }
    if (!shown.length) html = `<div class="kwsearch-empty">没有找到匹配的内容</div>`;
    box.innerHTML = html;
    panel._kwJumps = jumps;
    applyTab(panel, 'all');
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
        // 记录历史 + 上次状态 + 缓存结果
        addHistory(query);
        saveLastState(query, scopes, opts);
        kwLastGroups = groups;
        kwLastQuery = query;
        kwLastOpts = opts;
        renderHistory(panel);
    } catch (e) {
        summary.innerHTML = `<span class="kwsearch-error">${esc(e.message)}</span>`;
    } finally {
        kwSearching = false;
        goBtn.disabled = false;
    }
}

// 渲染最近搜索记录
function renderHistory(panel) {
    const box = panel.querySelector('.kwsearch-history');
    if (!box) return;
    const h = getHistory();
    if (!h.length) { box.innerHTML = ''; return; }
    let html = '<span class="kws-hist-label">最近</span>';
    for (const q of h) {
        html += `<span class="kws-hist-chip" data-q="${esc(q)}"><span class="kws-hist-q">${esc(q)}</span><i class="fa-solid fa-xmark kws-hist-del" title="删除"></i></span>`;
    }
    html += '<span class="kws-hist-clear" title="清空全部">清空</span>';
    box.innerHTML = html;
}

// 恢复勾选状态
function applyScopes(panel, scopes, opts) {
    if (scopes) {
        panel.querySelectorAll('[data-scope]').forEach(cb => {
            if (Object.prototype.hasOwnProperty.call(scopes, cb.dataset.scope)) cb.checked = !!scopes[cb.dataset.scope];
        });
    }
    if (opts) {
        const cs = panel.querySelector('.kws-case'); if (cs) cs.checked = !!opts.caseSensitive;
        const rg = panel.querySelector('.kws-regex'); if (rg) rg.checked = !!opts.regex;
    }
}

/* ---------- 跳转到关键词所在位置 ---------- */

function kwToast(msg, type) {
    try {
        if (typeof toastr !== 'undefined') (toastr[type] || toastr.info)(msg);
        else console.log(`[${EXT_ID}] ${msg}`);
    } catch (e) { /* ignore */ }
}

function waitFor(getter, timeout = 4000, interval = 80) {
    return new Promise((resolve) => {
        const start = Date.now();
        const tick = () => {
            let v;
            try { v = getter(); } catch (e) { v = null; }
            if (v) return resolve(v);
            if (Date.now() - start >= timeout) return resolve(null);
            setTimeout(tick, interval);
        };
        tick();
    });
}

function flash(el) {
    if (!el) return;
    el.classList.add('kwsearch-flash');
    setTimeout(() => el.classList.remove('kwsearch-flash'), 2000);
}

function jumpTo(jump, panel) {
    // 先关闭搜索弹窗，露出目标
    try {
        const dlg = panel.closest('dialog');
        const ok = dlg && dlg.querySelector('.popup-button-ok');
        if (ok) ok.click();
        else if (panel.closest('.kwsearch-modal')) panel.closest('.kwsearch-modal').remove();
    } catch (e) { /* ignore */ }
    setTimeout(() => {
        Promise.resolve(doJump(jump)).catch(err => {
            console.warn(`[${EXT_ID}] 跳转失败`, jump, err);
            kwToast('未能自动定位，请手动查找该条目', 'warning');
        });
    }, 300);
}

async function doJump(jump) {
    switch (jump.type) {
        case 'chat': return jumpChat(jump.mesid);
        case 'chatfile': return jumpChatFile(jump.file, jump.mesid);
        case 'wi': return jumpWorldInfo(jump.book, jump.uid);
        case 'preset': return jumpPreset(jump.identifier, jump.name);
        case 'char': return jumpChar(jump.field);
    }
}

// 确保目标楼层已渲染（懒加载/高处/隐藏楼层先补出来）
async function ensureMessageRendered(mesid) {
    const sel = `.mes[mesid="${mesid}"]`;
    let el = document.querySelector(sel);
    if (el) return el;
    // 一次性把更早的楼层全部补出来
    try {
        const m = await import('/script.js');
        if (typeof m.showMoreMessages === 'function') await m.showMoreMessages(Number.MAX_SAFE_INTEGER);
    } catch (e) { console.warn(`[${EXT_ID}] showMoreMessages 调用失败，改用按钮`, e); }
    el = document.querySelector(sel);
    if (el) return el;
    // 兜底：反复点「显示更多消息」按钮
    for (let i = 0; i < 40 && !el; i++) {
        const btn = document.getElementById('show_more_messages');
        if (!btn) break;
        btn.click();
        await waitFor(() => document.querySelector(sel) || !document.getElementById('show_more_messages'), 350);
        el = document.querySelector(sel);
    }
    return el;
}

async function jumpChat(mesid) {
    const el = await ensureMessageRendered(mesid);
    if (!el) { kwToast('没找到这条消息（可能已不在当前聊天）', 'warning'); return; }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    flash(el);
}

// 跳到该角色某个聊天存档的具体楼层（非当前存档先打开，再定位楼层）
async function jumpChatFile(file, mesid) {
    const c = ctx();
    const cur = (typeof c.getCurrentChatId === 'function') ? c.getCurrentChatId() : null;
    if (cur !== file) {
        if (typeof c.openCharacterChat !== 'function') { kwToast('未能打开该聊天存档', 'warning'); return; }
        try { await c.openCharacterChat(file); }
        catch (e) { console.warn(`[${EXT_ID}] 打开聊天存档失败`, file, e); kwToast('未能打开该聊天存档', 'warning'); return; }
        await waitFor(() => (typeof c.getCurrentChatId === 'function' ? c.getCurrentChatId() === file : true), 5000);
        await waitFor(() => document.querySelector('.mes[mesid]'), 3000); // 等新聊天渲染
    }
    if (typeof mesid === 'number') {
        const el = await ensureMessageRendered(mesid);
        if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); flash(el); return; }
    }
    kwToast('已打开该聊天存档（未定位到具体楼层）', 'info');
}

async function jumpWorldInfo(book, uid) {
    const $ = window.jQuery;
    if (!$) return;
    // 复刻 openWorldInfoEditor：打开世界书抽屉 + 选中对应书
    if (!$('#WorldInfo').is(':visible')) $('#WIDrawerIcon').trigger('click');
    const names = ctx().getWorldInfoNames ? ctx().getWorldInfoNames() : (window.world_names || []);
    const index = names.indexOf(book);
    if (index < 0) { kwToast(`没找到世界书：${book}`, 'warning'); return; }
    $('#world_editor_select').val(index).trigger('change');
    const sel = `#world_popup_entries_list [uid="${uid}"]`;
    const el = await waitFor(() => document.querySelector(sel), 5000);
    if (!el) { kwToast('已打开世界书，请在其中查找该条目', 'info'); return; }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    flash(el);
}

// 在提示词管理器列表里按 identifier 精确找条目（避开选择器转义问题）
function findPresetItem(identifier) {
    const list = document.getElementById('completion_prompt_manager_list');
    if (!list) return null;
    return Array.from(list.querySelectorAll('[data-pm-identifier]'))
        .find(el => el.getAttribute('data-pm-identifier') === identifier) || null;
}

async function jumpPreset(identifier, name) {
    // 首选：直接拿到 openai.js 的 promptManager 实例，程序化打开编辑框
    // （不依赖列表是否渲染、抽屉是否打开）
    try {
        const mod = await import('/scripts/openai.js');
        const pm = mod && mod.promptManager;
        if (pm && typeof pm.getPromptById === 'function') {
            const prompt = pm.getPromptById(identifier);
            if (prompt) {
                if (typeof pm.clearEditForm === 'function') pm.clearEditForm();
                if (typeof pm.clearInspectForm === 'function') pm.clearInspectForm();
                pm.loadPromptIntoEditForm(prompt);
                pm.showPopup();
                return;
            }
        }
    } catch (e) {
        console.warn(`[${EXT_ID}] 直接调用 promptManager 失败，改用 DOM 方式`, e);
    }

    // 兜底：找列表条目点编辑按钮
    let item = findPresetItem(identifier);
    if (!item) {
        const icon = document.getElementById('leftNavDrawerIcon');
        if (icon && icon.classList.contains('closedIcon')) icon.click();
        item = await waitFor(() => findPresetItem(identifier), 4000);
    }
    if (!item) {
        const list = document.getElementById('completion_prompt_manager_list');
        console.warn(`[${EXT_ID}] 未找到预设条目`, { identifier, listExists: !!list, itemCount: list ? list.querySelectorAll('[data-pm-identifier]').length : 0 });
        kwToast(`请在「AI 响应配置 → 提示词管理器」中查看：${name || identifier}`, 'info');
        return;
    }
    item.scrollIntoView({ behavior: 'smooth', block: 'center' });
    flash(item);
    const action = item.querySelector('.prompt-manager-edit-action') || item.querySelector('.prompt-manager-inspect-action');
    if (action) action.click();
}

const CHAR_MAIN_FIELDS = { description: '#description_textarea', first_mes: '#firstmessage_textarea' };
const CHAR_ADV_FIELDS = {
    personality: '#personality_textarea',
    scenario: '#scenario_pole, #scenario',
    mes_example: '#mes_example_textarea',
    creator_notes: '#creator_notes_textarea',
    system_prompt: '#system_prompt_textarea',
    post_history: '#post_history_instructions_textarea, #post_history_instructions',
};

// 在文本框内定位到第一处匹配：选中并滚动到那一行
function locateInField(el, query, opts) {
    if (!el || !query) return;
    try {
        const text = (el.value != null) ? el.value : '';
        let idx = -1, len = query.length;
        try {
            const re = buildRegex(query, opts || {});
            re.lastIndex = 0;
            const m = re.exec(text);
            if (m) { idx = m.index; len = m[0].length || query.length; }
        } catch (e) { idx = -1; }
        if (idx < 0) {
            const cs = opts && opts.caseSensitive;
            const hay = cs ? text : text.toLowerCase();
            const needle = cs ? query : query.toLowerCase();
            idx = hay.indexOf(needle);
            len = query.length;
        }
        if (idx < 0) return;
        el.focus();
        try { el.setSelectionRange(idx, idx + len); } catch (e) { /* ignore */ }
        const line = text.slice(0, idx).split('\n').length - 1;
        const style = getComputedStyle(el);
        let lh = parseFloat(style.lineHeight);
        if (!lh || isNaN(lh)) lh = (parseFloat(style.fontSize) || 14) * 1.4;
        el.scrollTop = Math.max(0, line * lh - el.clientHeight / 2);
    } catch (e) { console.warn(`[${EXT_ID}] 字段内定位失败`, e); }
}

async function jumpChar(field) {
    const $ = window.jQuery;
    // 主面板字段（描述 / 开场白）——必要时先打开右侧角色面板
    if (CHAR_MAIN_FIELDS[field]) {
        let el = document.querySelector(CHAR_MAIN_FIELDS[field]);
        if (!el || el.offsetParent === null) {
            const icon = document.getElementById('rightNavDrawerIcon');
            if (icon && $ && !$('#right-nav-panel').is(':visible')) icon.click();
            el = await waitFor(() => {
                const e = document.querySelector(CHAR_MAIN_FIELDS[field]);
                return (e && e.offsetParent !== null) ? e : null;
            }, 3000);
        }
        if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            flash(el);
            locateInField(el, kwLastQuery, kwLastOpts);
            return;
        }
        kwToast('请在角色面板中查看该字段', 'info');
        return;
    }
    // 高级定义弹窗字段
    const selector = CHAR_ADV_FIELDS[field];
    if (!selector) { kwToast('请在角色卡中查看该字段', 'info'); return; }
    if ($ && !$('#character_popup').hasClass('open')) $('#advanced_div').trigger('click');
    const el = await waitFor(() => {
        const e = document.querySelector(selector);
        return (e && e.offsetParent !== null) ? e : null;
    }, 3000);
    if (!el) { kwToast('已打开角色高级定义，请查找该字段', 'info'); return; }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    flash(el);
    locateInField(el, kwLastQuery, kwLastOpts);
}

function buildPanel(prefill) {
    const tmp = document.createElement('div');
    tmp.innerHTML = PANEL_HTML.trim();
    const panel = tmp.firstElementChild;
    const input = panel.querySelector('.kws-input');
    panel.querySelector('.kws-go').addEventListener('click', () => doSearch(panel));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSearch(panel); } });
    // 结果点击跳转（事件委托）
    panel.querySelector('.kwsearch-results').addEventListener('click', (e) => {
        const item = e.target.closest('.kwsearch-item[data-jump]');
        if (!item) return;
        const jumps = panel._kwJumps || [];
        const jump = jumps[Number(item.dataset.jump)];
        if (jump) jumpTo(jump, panel);
    });
    // 历史记录点击（事件委托）
    panel.querySelector('.kwsearch-history').addEventListener('click', (e) => {
        const del = e.target.closest('.kws-hist-del');
        if (del) {
            e.stopPropagation();
            const chip = del.closest('.kws-hist-chip');
            if (chip) { removeHistory(chip.dataset.q); renderHistory(panel); }
            return;
        }
        if (e.target.closest('.kws-hist-clear')) { clearHistory(); renderHistory(panel); return; }
        const chip = e.target.closest('.kws-hist-chip');
        if (chip) { input.value = chip.dataset.q; doSearch(panel); }
    });

    // 恢复上次搜索界面
    const last = getLastState();
    if (last) applyScopes(panel, last.scopes, last.opts);
    if (prefill) {
        input.value = prefill;
    } else if (kwLastQuery) {
        input.value = kwLastQuery;
    } else if (last && last.query) {
        input.value = last.query;
    }
    renderHistory(panel);
    if (!prefill && kwLastGroups) {
        renderResults(panel, kwLastGroups, kwLastQuery);
    }

    // 配色色卡切换
    panel.querySelectorAll('.kws-dot').forEach(d => {
        d.addEventListener('click', () => { setTheme(d.dataset.t); applyTheme(panel, d.dataset.t); });
    });
    applyTheme(panel, getTheme());

    // 关闭按钮
    panel.querySelector('.kws-close').addEventListener('click', () => {
        const dlg = panel.closest('dialog');
        const btn = dlg && (dlg.querySelector('.popup-button-ok') || dlg.querySelector('.popup-button-close'));
        if (btn) btn.click();
        else if (panel.closest('.kwsearch-modal')) panel.closest('.kwsearch-modal').remove();
    });

    // 正则说明 ? 开关
    const help = panel.querySelector('.kws-help');
    const helpbox = panel.querySelector('.kwsearch-helpbox');
    help.addEventListener('click', () => { helpbox.hidden = !helpbox.hidden; });

    // 分类标签卡筛选
    panel.querySelector('.kwsearch-tabs').addEventListener('click', (e) => {
        const t = e.target.closest('.kws-tab');
        if (t) applyTab(panel, t.dataset.cat);
    });

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
