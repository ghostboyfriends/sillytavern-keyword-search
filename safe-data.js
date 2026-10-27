// Keep preset saves explicit: the generic PresetManager.updatePreset() cannot
// serialize Chat Completion settings and may overwrite the preset with {}.
const clone = value => structuredClone(value);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function mergeRecords(base, current) {
    const result = isRecord(base) ? clone(base) : {};
    if (!isRecord(current)) return result;
    for (const [key, value] of Object.entries(current)) {
        if (value === undefined || ['__proto__', 'constructor', 'prototype'].includes(key)) continue;
        result[key] = isRecord(value) ? mergeRecords(result[key], value) : clone(value);
    }
    return result;
}

export function replaceText(text, query, replacement, { caseSensitive = false, regex = false } = {}) {
    if (!query) throw new Error('查找内容不能为空。');
    const pattern = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(pattern, caseSensitive ? 'g' : 'gi');
    const count = (String(text).match(re) || []).length;
    re.lastIndex = 0;
    // Plain-text replacement must preserve literal $1, $&, {{match}}, etc.
    const value = String(text).replace(re, regex ? replacement : () => replacement);
    return { value, count };
}

export function createPresetStore({ getContext, loadOpenAI = () => import('/scripts/openai.js') }) {
    function settings() {
        const c = getContext();
        return c.chatCompletionSettings || c.oai_settings;
    }

    function capture() {
        const c = getContext();
        const manager = c.getPresetManager?.('openai');
        const live = settings();
        const name = manager?.getSelectedPresetName?.();
        if (!manager || manager.apiId !== 'openai' || !name || !Array.isArray(live?.prompts)) {
            throw new Error('当前对话补全预设尚未就绪，未执行保存。');
        }
        if (live.preset_settings_openai && live.preset_settings_openai !== name) {
            throw new Error('预设正在切换，请等待完成后重新查找。');
        }
        const stored = manager.getCompletionPresetByName?.(name);
        const binding = { manager, name, settings: live, stored, storedSnapshot: JSON.stringify(stored) };
        binding.snapshot = signature(binding);
        return binding;
    }

    function signature(binding) {
        return JSON.stringify({
            prompts: binding.settings.prompts,
            order: binding.settings.prompt_order,
            extensions: binding.settings.extensions,
            storedExtensions: binding.stored?.extensions,
        });
    }

    function assertCurrent(binding) {
        const current = capture();
        if (current.manager !== binding.manager || current.settings !== binding.settings ||
            current.name !== binding.name || signature(binding) !== binding.snapshot) {
            throw new Error('预设或其内容在查找后发生了变化，未覆盖任何条目；请重新查找。');
        }
    }

    async function payload(binding) {
        const openai = await loadOpenAI();
        assertCurrent(binding);
        if (typeof openai.getChatCompletionPreset !== 'function') {
            throw new Error('酒馆缺少对话补全预设序列化接口，已停止保存以保护原预设。');
        }
        const serialized = openai.getChatCompletionPreset(binding.settings);
        if (!isRecord(serialized) || !Array.isArray(serialized.prompts) || !Array.isArray(serialized.prompt_order)) {
            throw new Error('预设序列化结果缺少正文或排序，未执行保存。');
        }
        const result = isRecord(binding.stored) ? clone(binding.stored) : {};
        for (const [key, value] of Object.entries(serialized)) {
            if (value !== undefined && !['__proto__', 'constructor', 'prototype'].includes(key)) result[key] = clone(value);
        }
        // Preserve preset-bound regexes and other extension metadata, including
        // fields omitted by older serializers. An explicit [] still means [].
        result.extensions = mergeRecords(binding.stored?.extensions, binding.settings.extensions);
        if (!Array.isArray(result.prompts) || !Array.isArray(result.prompt_order)) {
            throw new Error('保存数据缺少预设正文或排序，已停止保存以保护原预设。');
        }
        return result;
    }

    async function commit(binding, next) {
        assertCurrent(binding);
        if (typeof binding.manager.savePreset !== 'function') throw new Error('酒馆缺少预设保存接口。');
        const result = await binding.manager.savePreset(binding.name, clone(next), { skipUpdate: true });
        if (result === false || result?.ok === false) throw new Error('预设保存失败；未更新内存中的预设内容。');
        // No select/change event: that would reload the preset and discard drafts.
        // A switch during the request must never publish A's changes into B.
        const current = settings();
        const sameContext = current === binding.settings &&
            binding.manager.getSelectedPresetName?.() === binding.name &&
            signature(binding) === binding.snapshot;
        if (isRecord(binding.stored) && JSON.stringify(binding.stored) === binding.storedSnapshot) {
            Object.assign(binding.stored, clone(next));
        }
        if (sameContext) {
            current.prompts = clone(next.prompts);
            current.prompt_order = clone(next.prompt_order);
            current.extensions = clone(next.extensions);
            getContext().saveSettingsDebounced?.();
        }
        return { saved: true, current: sameContext };
    }

    async function replaceTargets(targets, query, replacement, opts) {
        if (!targets.length) return { done: 0 };
        const binding = targets[0].presetBinding;
        if (!binding || targets.some(t => t.presetBinding !== binding)) throw new Error('预设替换目标不一致，请重新查找。');
        const next = await payload(binding);
        let done = 0;
        for (const target of targets) {
            const original = binding.settings.prompts[target.presetIndex];
            if (!original || original.identifier !== target.key || String(original.content) !== target.text) {
                throw new Error('预设条目已变化，请重新查找后替换。');
            }
            const edit = replaceText(original.content, query, replacement, opts);
            next.prompts[target.presetIndex].content = edit.value;
            done += edit.count;
        }
        if (done) await commit(binding, next);
        return { done };
    }

    async function saveCurrent() {
        const binding = capture();
        return commit(binding, await payload(binding));
    }

    return { capture, assertCurrent, payload, commit, replaceTargets, saveCurrent };
}
