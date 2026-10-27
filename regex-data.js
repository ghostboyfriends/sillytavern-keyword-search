import { replaceText } from './safe-data.js';

export const REGEX_SCOPES = [
    { key: 'regexGlobal', scope: 'global', type: 'GLOBAL', label: '全局正则', icon: 'fa-globe' },
    { key: 'regexPreset', scope: 'preset', type: 'PRESET', label: '预设正则', icon: 'fa-sliders' },
    { key: 'regexCharacter', scope: 'character', type: 'SCOPED', label: '角色卡正则', icon: 'fa-user' },
];
const clone = value => structuredClone(value);

export function createRegexStore({ getContext, presetStore, loadEngine = () => import('/scripts/extensions/regex/engine.js') }) {
    function identity(scope, engine) {
        const c = getContext();
        if (scope === 'global') {
            const root = c.extensionSettings || c.extension_settings;
            if (!root) return null;
            return { root, key: 'global', label: '全局' };
        }
        if (scope === 'character') {
            const character = c.characters?.[c.characterId];
            if (!character?.avatar) return null;
            return { root: character, key: character.avatar, label: character.name || character.avatar };
        }
        const api = engine.getCurrentPresetAPI?.() || c.mainApi || c.main_api;
        const manager = api && c.getPresetManager?.(api);
        const name = engine.getCurrentPresetName?.() || manager?.getSelectedPresetName?.();
        if (!api || !manager || !name) return null;
        return { root: manager, key: JSON.stringify([api, name]), api, name, label: name };
    }

    async function availability() {
        try {
            const engine = await loadEngine();
            return Object.fromEntries(REGEX_SCOPES.map(s => [s.key,
                Number.isFinite(engine.SCRIPT_TYPES?.[s.type]) && typeof engine.getScriptsByType === 'function' &&
                typeof engine.saveScriptsByType === 'function']));
        } catch {
            return Object.fromEntries(REGEX_SCOPES.map(s => [s.key, false]));
        }
    }

    async function collect(scopes) {
        if (!REGEX_SCOPES.some(s => scopes[s.key])) return [];
        const engine = await loadEngine();
        if (typeof engine.getScriptsByType !== 'function' || typeof engine.saveScriptsByType !== 'function') {
            throw new Error('酒馆缺少按来源读写正则脚本的接口，请更新酒馆后使用此范围。');
        }
        const groups = [];
        for (const definition of REGEX_SCOPES) {
            if (!scopes[definition.key]) continue;
            const type = engine.SCRIPT_TYPES?.[definition.type];
            if (!Number.isFinite(type)) throw new Error(`此酒馆版本不支持${definition.label}，未混用其他来源。`);
            const owner = identity(definition.scope, engine);
            if (!owner) continue; // No selected character/preset: no targets in that region.
            const scripts = engine.getScriptsByType(type, { allowedOnly: false });
            if (!Array.isArray(scripts)) throw new Error(`${definition.label}数据无效。`);
            const binding = { definition, type, owner, engine, snapshot: JSON.stringify(scripts) };
            if (definition.scope === 'preset' && owner.api === 'openai') binding.presetBinding = presetStore.capture();
            const items = scripts.flatMap((script, index) => {
                if (!script || typeof script.replaceString !== 'string') return [];
                return [{ source: 'regex', key: script.id || `index:${index}`, regexIndex: index,
                    regexScope: definition.scope, regexBinding: binding, ownerLabel: owner.label,
                    title: script.scriptName || '(未命名正则)', text: script.replaceString,
                    originalScript: clone(script), disabled: !!script.disabled }];
            });
            groups.push({ ...definition, ownerLabel: owner.label, items });
        }
        return groups;
    }

    function assertCurrent(binding) {
        const current = identity(binding.definition.scope, binding.engine);
        const scripts = binding.engine.getScriptsByType(binding.type, { allowedOnly: false });
        if (!current || current.key !== binding.owner.key || current.root !== binding.owner.root ||
            JSON.stringify(scripts) !== binding.snapshot) {
            throw new Error(`${binding.definition.label}或所属对象在查找后发生了变化，请重新查找；未覆盖该来源。`);
        }
        if (binding.presetBinding) presetStore.assertCurrent(binding.presetBinding);
        return scripts;
    }

    async function replaceTargets(regexTargets, presetTargets, query, replacement, opts) {
        const groups = new Map();
        for (const target of regexTargets) {
            if (!target.regexBinding) throw new Error('正则替换目标缺少来源信息，请重新查找。');
            if (!groups.has(target.regexBinding)) groups.set(target.regexBinding, []);
            groups.get(target.regexBinding).push(target);
        }
        let presetBinding = presetTargets[0]?.presetBinding;
        if (presetTargets.some(t => t.presetBinding !== presetBinding)) throw new Error('预设目标不一致，请重新查找。');
        const staged = [];
        let presetDone = 0;
        for (const [binding, targets] of groups) {
            const original = assertCurrent(binding);
            const scripts = clone(original);
            let done = 0;
            for (const target of targets) {
                const script = scripts[target.regexIndex];
                if (!script || script.replaceString !== target.text || JSON.stringify(script) !== JSON.stringify(target.originalScript)) {
                    throw new Error('正则脚本在查找后发生了变化，请重新查找。');
                }
                const edit = replaceText(script.replaceString, query, replacement, opts);
                script.replaceString = edit.value;
                done += edit.count;
            }
            if (binding.presetBinding) {
                if (presetBinding && (presetBinding.settings !== binding.presetBinding.settings ||
                    presetBinding.name !== binding.presetBinding.name || presetBinding.snapshot !== binding.presetBinding.snapshot)) {
                    throw new Error('预设正文与正则目标不属于同一份预设，请重新查找。');
                }
                presetBinding ||= binding.presetBinding;
                presetDone += done;
            }
            staged.push({ binding, scripts, done });
        }
        let next;
        if (presetBinding) {
            next = await presetStore.payload(presetBinding);
            for (const target of presetTargets) {
                const script = presetBinding.settings.prompts[target.presetIndex];
                if (!script || script.identifier !== target.key || String(script.content) !== target.text) {
                    throw new Error('预设条目已变化，请重新查找。');
                }
                const edit = replaceText(script.content, query, replacement, opts);
                next.prompts[target.presetIndex].content = edit.value;
                presetDone += edit.count;
            }
            for (const item of staged) if (item.binding.presetBinding) next.extensions.regex_scripts = item.scripts;
        }
        // Revalidate every region after async serialization, before any write.
        for (const item of staged) assertCurrent(item.binding);
        if (presetBinding) presetStore.assertCurrent(presetBinding);
        let done = 0;
        try {
            // Prompt content and OpenAI preset regexes share ONE complete save.
            if (presetDone) { await presetStore.commit(presetBinding, next); done += presetDone; }
            for (const item of staged) {
                if (item.binding.presetBinding || !item.done) continue;
                assertCurrent(item.binding);
                const result = await item.binding.engine.saveScriptsByType(item.scripts, item.binding.type);
                if (result === false || result?.ok === false) throw new Error(`${item.binding.definition.label}保存失败。`);
                done += item.done;
            }
        } catch (error) {
            error.completed = done;
            throw error;
        }
        return { done, presetDirty: presetDone > 0 };
    }

    function readTarget(target) {
        const scripts = assertCurrent(target.regexBinding);
        return clone(scripts[target.regexIndex]);
    }

    return { availability, collect, assertCurrent, replaceTargets, readTarget };
}
