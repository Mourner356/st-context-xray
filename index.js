/* ============================================================
 * Context X-Ray v0.3.0
 * SillyTavern 上下文成本审计 + 正则死规则与冲突检测 + 悬浮窗
 *
 * 新增功能：
 * - 正则冲突检测（5种类型）
 * - 🌸 悬浮窗界面
 * - 世界书详情展示
 * ============================================================ */

const VERSION = '0.3.0';
const LOG = `[Context X-Ray v${VERSION}]`;

const api = {};

const state = {
    wiEntries: [],
    wiStamp: 0,
    snapshot: null,
    presetAudit: null,
    regexAudit: null,
    regexConflicts: null,  // 新增：冲突检测结果
    busy: false,
    /* 一键关闭相关 */
    selected: new Set(),
    confirmArmed: false,
    confirmTimer: null,
    lastUndo: null,
    lastUndoTime: 0,
    /* 悬浮窗相关 */
    floatVisible: false,
    floatPos: { x: window.innerWidth - 120, y: window.innerHeight - 120 },
    dragging: null,
};

/* ---------- 工具函数 ---------- */

function esc(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function fmt(n) { return Number(n || 0).toLocaleString('en-US'); }
function pct(part, total) { return total ? ((part / total) * 100).toFixed(1) : '0.0'; }

function bar(ratio, width = 12) {
    const filled = Math.min(width, Math.max(0, Math.round(ratio * width)));
    return '█'.repeat(filled) + '·'.repeat(width - filled);
}

function normText(s) { return typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : ''; }

function msgText(m) {
    if (!m) return '';
    const c = m.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
        return c.map(p => (typeof p === 'string' ? p : (p && p.text) || '')).join('\n');
    }
    return '';
}

function tk(s) {
    try {
        const n = api.getTokenCount(s || '');
        return typeof n === 'number' ? n : 0;
    } catch { return 0; }
}

function yieldFrame() { return new Promise(r => setTimeout(r, 0)); }

function subst(s) {
    if (typeof s !== 'string') return '';
    try { return api.substituteParams ? api.substituteParams(s) : s; }
    catch { return s; }
}

function toast(msg, ms = 1800) {
    const el = document.createElement('div');
    el.className = 'cx-toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), ms);
}

/* ---------- API 解析 ---------- */

async function resolveApi() {
    const errs = [];

    try {
        const m = await import('../../../../script.js');
        api.eventSource = m.eventSource;
        api.event_types = m.event_types;
        api.characters = m.characters;
        api.saveSettingsDebounced = m.saveSettingsDebounced;
    } catch (e) { errs.push(`script.js: ${e.message}`); }

    try {
        const m = await import('../../../extensions.js');
        api.extension_settings = m.extension_settings;
        api.getContext = m.getContext;
    } catch (e) { errs.push(`extensions.js: ${e.message}`); }

    try {
        const m = await import('../../../tokenizers.js');
        api.getTokenCount = m.getTokenCount;
    } catch (e) { errs.push(`tokenizers.js: ${e.message}`); }

    try {
        const m = await import('../../../openai.js');
        api.oai_settings = m.oai_settings;
    } catch (e) { errs.push(`openai.js: ${e.message}`); }

    try {
        const m = await import('../../../world-info.js');
        api.parseRegexFromString = m.parseRegexFromString;
    } catch (e) { errs.push(`world-info.js: ${e.message}`); }

    try {
        const ctx = api.getContext && api.getContext();
        if (ctx && typeof ctx.substituteParams === 'function') {
            api.substituteParams = ctx.substituteParams;
        }
        if (ctx && typeof ctx.saveSettingsDebounced === 'function' && !api.saveSettingsDebounced) {
            api.saveSettingsDebounced = ctx.saveSettingsDebounced;
        }
    } catch (e) { errs.push(`getContext(): ${e.message}`); }

    return errs;
}

/* ---------- 预设相关（与 v0.2.0 相同） ---------- */

function enabledInfo() {
    const out = { set: null, source: 'prompts.enabled', orderTotal: 0 };
    try {
        const po = api.oai_settings && api.oai_settings.prompt_order;
        if (!Array.isArray(po) || !po.length) return out;

        const ctx = api.getContext && api.getContext();
        const chid = ctx ? ctx.characterId : undefined;

        let entry = po.find(x => x && String(x.character_id) === String(chid));
        if (!entry) entry = po.find(x => x && Array.isArray(x.order) && x.order.length);
        if (!entry || !Array.isArray(entry.order)) return out;

        out.orderTotal = entry.order.length;
        const set = new Set();
        let hasFlag = false;

        for (const it of entry.order) {
            if (!it) continue;
            const id = typeof it === 'string' ? it : it.identifier;
            if (!id) continue;
            if (typeof it === 'object' && 'enabled' in it) {
                hasFlag = true;
                if (it.enabled) set.add(id);
            } else {
                set.add(id);
            }
        }

        if (set.size) {
            out.set = set;
            out.source = hasFlag
                ? 'prompt_order.enabled'
                : 'prompt_order（无 enabled 字段，按在列即启用）';
        }
    } catch (e) { console.warn(LOG, 'enabledInfo 失败', e); }
    return out;
}

function isEnabled(p, info) {
    if (info.set) return info.set.has(p.identifier);
    return p.enabled !== false;
}

async function auditPreset(onProgress) {
    const prompts = (api.oai_settings && api.oai_settings.prompts) || [];
    if (!prompts.length) return { error: 'oai_settings.prompts 为空' };

    const info = enabledInfo();
    const on = [], off = [];
    let markerCount = 0, emptyCount = 0;

    for (let i = 0; i < prompts.length; i++) {
        const p = prompts[i];
        if (!p) continue;
        if (p.marker) { markerCount += 1; continue; }

        const raw = typeof p.content === 'string' ? p.content : '';
        if (!raw.trim()) { emptyCount += 1; continue; }

        const tokens = tk(subst(raw));
        const row = {
            name: p.name || p.identifier || '(未命名)',
            tokens,
            depth: p.injection_position === 1 ? p.injection_depth : null,
        };

        if (isEnabled(p, info)) on.push(row);
        else off.push(row);

        if (i % 25 === 24) {
            await yieldFrame();
            if (onProgress) onProgress(i + 1, prompts.length);
        }
    }

    on.sort((a, b) => b.tokens - a.tokens);
    off.sort((a, b) => b.tokens - a.tokens);

    return {
        total: prompts.length,
        enabledCount: on.length,
        disabledCount: off.length,
        markerCount, emptyCount,
        enabledTokens: on.reduce((s, r) => s + r.tokens, 0),
        disabledTokens: off.reduce((s, r) => s + r.tokens, 0),
        enabledSource: info.source,
        orderTotal: info.orderTotal,
        on, off,
    };
}

/* ---------- 正则编译校验 ---------- */

function tryCompile(find) {
    if (typeof find !== 'string' || !find.trim()) {
        return { ok: false, reason: 'empty' };
    }
    if (typeof api.parseRegexFromString === 'function') {
        try {
            const r = api.parseRegexFromString(find);
            if (r instanceof RegExp) return { ok: true, regex: r };
        } catch { /* 落到下面再试 */ }
    }
    try {
        const r = new RegExp(find);
        return { ok: true, regex: r };
    } catch (e) {
        return { ok: false, reason: 'invalid', msg: e.message };
    }
}

/* ---------- 正则冲突检测 ---------- */

function detectRegexConflicts() {
    const es = api.extension_settings || {};
    const list = Array.isArray(es.regex) ? es.regex : [];
    
    /* 只检测启用的规则 */
    const enabled = list.filter(r => r && !r.disabled);
    if (enabled.length < 2) return { conflicts: [], warnings: [] };

    const conflicts = [];
    const warnings = [];

    /* 按 placement 分组 */
    const byPlacement = new Map();
    for (const r of enabled) {
        const placements = Array.isArray(r.placement) ? r.placement : [0];
        for (const p of placements) {
            const arr = byPlacement.get(p) || [];
            arr.push(r);
            byPlacement.set(p, arr);
        }
    }

    /* 检测每个 placement 组内的冲突 */
    for (const [placement, rules] of byPlacement) {
        if (rules.length < 2) continue;

        const findMap = new Map();
        for (const r of rules) {
            const find = typeof r.findRegex === 'string' ? r.findRegex.trim() : '';
            if (!find) continue;

            const arr = findMap.get(find) || [];
            arr.push(r);
            findMap.set(find, arr);
        }

        /* 1. 完全重复 & 2. 替换冲突 */
        for (const [find, sameFind] of findMap) {
            if (sameFind.length < 2) continue;

            const replaces = new Set(sameFind.map(r => r.replaceString || ''));
            if (replaces.size === 1) {
                /* 完全重复 */
                conflicts.push({
                    type: 'duplicate',
                    severity: 'high',
                    title: `完全重复规则（相同匹配式和替换）`,
                    desc: `${sameFind.length} 条规则使用相同的 findRegex 和 replaceString`,
                    rules: sameFind.map(r => ({ 
                        id: r.id, 
                        name: r.scriptName || '(未命名)',
                        find: find.slice(0, 40),
                        replace: (r.replaceString || '').slice(0, 40) 
                    })),
                    suggestion: '保留其中一条，关闭其他条',
                });
            } else {
                /* 替换冲突 */
                conflicts.push({
                    type: 'replace_conflict',
                    severity: 'high',
                    title: `替换冲突（相同匹配式，不同替换）`,
                    desc: `${sameFind.length} 条规则匹配同一内容但替换成不同结果`,
                    rules: sameFind.map(r => ({ 
                        id: r.id, 
                        name: r.scriptName || '(未命名)',
                        find: find.slice(0, 40),
                        replace: (r.replaceString || '').slice(0, 40) 
                    })),
                    suggestion: '确定需要哪种替换结果，关闭其他条',
                });
            }
        }

        /* 3. 顺序覆盖检测 */
        for (let i = 0; i < rules.length - 1; i++) {
            const a = rules[i];
            const aReplace = a.replaceString || '';
            if (!aReplace.trim()) continue;

            for (let j = i + 1; j < rules.length; j++) {
                const b = rules[j];
                const bFind = b.findRegex || '';
                if (!bFind.trim()) continue;

                try {
                    const regex = new RegExp(bFind);
                    if (regex.test(aReplace)) {
                        conflicts.push({
                            type: 'order_override',
                            severity: 'medium',
                            title: `顺序覆盖`,
                            desc: `规则 A 的输出会被规则 B 重新匹配`,
                            rules: [
                                { id: a.id, name: a.scriptName || '(未命名)', role: '输出被覆盖' },
                                { id: b.id, name: b.scriptName || '(未命名)', role: '覆盖者' }
                            ],
                            suggestion: '检查是否有意为之，或调整执行顺序',
                        });
                    }
                } catch { /* 正则编译失败，跳过 */ }
            }
        }

        /* 4. 位置竞争 */
        if (rules.length > 3) {
            warnings.push({
                type: 'position_competition',
                severity: 'low',
                title: `位置竞争`,
                desc: `placement ${placement} 有 ${rules.length} 条启用规则，执行顺序可能不确定`,
                rules: rules.slice(0, 6).map(r => ({ 
                    id: r.id, 
                    name: r.scriptName || '(未命名)' 
                })),
                suggestion: '考虑分散到不同 placement 或合并规则',
            });
        }
    }

    /* 5. 范围包含检测 */
    for (const rules of byPlacement.values()) {
        for (let i = 0; i < rules.length - 1; i++) {
            const narrow = rules[i];
            const narrowFind = narrow.findRegex || '';
            if (narrowFind.length < 3) continue;

            for (let j = i + 1; j < rules.length; j++) {
                const wide = rules[j];
                const wideFind = wide.findRegex || '';
                if (wideFind.length >= narrowFind.length) continue;

                if (narrowFind.includes(wideFind) && wideFind.length > 1) {
                    warnings.push({
                        type: 'range_inclusion',
                        severity: 'medium',
                        title: `范围包含`,
                        desc: `宽匹配可能覆盖窄匹配的结果`,
                        rules: [
                            { id: narrow.id, name: narrow.scriptName || '(未命名)', role: '窄匹配' },
                            { id: wide.id, name: wide.scriptName || '(未命名)', role: '宽匹配' }
                        ],
                        suggestion: '确认两条规则的先后顺序是否正确',
                    });
                }
            }
        }
    }

    /* 按严重度排序 */
    const severityOrder = { high: 3, medium: 2, low: 1 };
    conflicts.sort((a, b) => severityOrder[b.severity] - severityOrder[a.severity]);
    warnings.sort((a, b) => severityOrder[b.severity] - severityOrder[a.severity]);

    return { conflicts: conflicts.concat(warnings) };
}

/* ---------- 正则审计（增强版） ---------- */

function auditRegex() {
    const es = api.extension_settings || {};
    const list = Array.isArray(es.regex) ? es.regex : [];

    const stat = {
        total: list.length,
        enabled: 0,
        disabled: 0,
        promptOnly: 0,
        markdownOnly: 0,
        both: 0,
        dead: [],
        suspect: [],
        dupFind: [],
        dupName: [],
    };

    const findSeen = new Map();
    const nameSeen = new Map();

    for (let i = 0; i < list.length; i++) {
        const r = list[i];
        if (!r) continue;

        const off = !!r.disabled;
        if (off) stat.disabled += 1; else stat.enabled += 1;

        const po = !!r.promptOnly;
        const mo = !!r.markdownOnly;
        if (po && !mo) stat.promptOnly += 1;
        else if (mo && !po) stat.markdownOnly += 1;
        else stat.both += 1;

        const name = r.scriptName || '(未命名)';
        const find = typeof r.findRegex === 'string' ? r.findRegex : '';
        const repl = typeof r.replaceString === 'string' ? r.replaceString : '';

        /* 重复检测只统计启用项 */
        if (!off) {
            if (find.trim()) {
                const arr = findSeen.get(find) || [];
                arr.push(name);
                findSeen.set(find, arr);
            }
            const na = nameSeen.get(name) || [];
            na.push(i);
            nameSeen.set(name, na);
        }

        /* 已禁用的不再列入待关闭候选 */
        if (off) continue;

        const compile = tryCompile(find);
        const placementEmpty = Array.isArray(r.placement) && r.placement.length === 0;

        let level = null, why = '';

        if (compile.reason === 'empty') {
            level = 'L1'; why = '匹配式为空';
        } else if (compile.reason === 'invalid') {
            level = 'L2'; why = `正则语法非法：${compile.msg || '编译失败'}`;
        } else if (placementEmpty) {
            level = 'L3'; why = 'placement 为空，不作用于任何位置';
        } else if (find && find === repl) {
            level = 'L4'; why = '匹配式与替换串完全相同';
        }

        if (!level) continue;

        const row = {
            id: r.id,
            index: i,
            name,
            level, why,
            findPreview: find.slice(0, 60),
            promptOnly: po,
            markdownOnly: mo,
        };

        if (level === 'L4') stat.suspect.push(row);
        else stat.dead.push(row);
    }

    for (const [find, names] of findSeen) {
        if (names.length > 1) {
            stat.dupFind.push({ find: find.slice(0, 50), names, count: names.length });
        }
    }
    for (const [name, idxs] of nameSeen) {
        if (idxs.length > 1) {
            stat.dupName.push({ name, count: idxs.length });
        }
    }

    stat.dupFind.sort((a, b) => b.count - a.count);
    stat.dupName.sort((a, b) => b.count - a.count);

    const presets = Array.isArray(es.regex_presets) ? es.regex_presets : [];
    stat.presetGroups = presets.map(p => ({
        name: (p && p.name) || '(未命名)',
        selected: !!(p && p.isSelected),
        global: Array.isArray(p && p.global) ? p.global.length : 0,
        scoped: Array.isArray(p && p.scoped) ? p.scoped.length : 0,
        preset: Array.isArray(p && p.preset) ? p.preset.length : 0,
    }));

    /* L1-L3 默认全选，L4 不选 */
    state.selected = new Set(stat.dead.map(r => r.id).filter(Boolean));

    return stat;
}

/* ---------- 写入操作（与 v0.2.0 相同） ---------- */

function backupJson() {
    const es = api.extension_settings || {};
    return JSON.stringify({
        tool: 'Context X-Ray',
        version: VERSION,
        exportedAt: new Date().toISOString(),
        note: '仅备份 extension_settings.regex。恢复方式见 README。',
        count: Array.isArray(es.regex) ? es.regex.length : 0,
        regex: es.regex || [],
    }, null, 2);
}

function exportBackup() {
    const text = backupJson();
    try {
        const blob = new Blob([text], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `regex-backup-${Date.now()}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 3000);
        toast('备份已下载');
        return true;
    } catch (e) {
        console.warn(LOG, '下载失败，转剪贴板', e);
        navigator.clipboard?.writeText(text)
            .then(() => toast('下载不可用，备份已复制到剪贴板', 2600))
            .catch(() => {
                console.log(text);
                toast('备份已打印到 Console', 2600);
            });
        return false;
    }
}

function closeSelected() {
    const list = (api.extension_settings && api.extension_settings.regex) || [];
    if (!Array.isArray(list) || !list.length) return 0;

    const undo = [];
    let changed = 0;

    for (const r of list) {
        if (!r || !r.id || !state.selected.has(r.id)) continue;
        if (r.disabled) continue;
        undo.push({ id: r.id, disabled: r.disabled });
        r.disabled = true;
        changed += 1;
    }

    if (changed) {
        state.lastUndo = undo;
        state.lastUndoTime = Date.now();
        try {
            api.saveSettingsDebounced();
        } catch (e) {
            console.error(LOG, 'saveSettingsDebounced 调用失败', e);
        }
        console.log(LOG, `已关闭 ${changed} 条正则`, undo.map(u => u.id));
    }
    return changed;
}

function undoLast() {
    if (!state.lastUndo || !state.lastUndo.length) return 0;

    const list = (api.extension_settings && api.extension_settings.regex) || [];
    const map = new Map(state.lastUndo.map(u => [u.id, u.disabled]));
    let restored = 0;

    for (const r of list) {
        if (!r || !r.id || !map.has(r.id)) continue;
        r.disabled = map.get(r.id);
        restored += 1;
    }

    if (restored) {
        try { api.saveSettingsDebounced(); }
        catch (e) { console.error(LOG, 'saveSettingsDebounced 调用失败', e); }
        console.log(LOG, `已还原 ${restored} 条正则`);
    }
    state.lastUndo = null;
    return restored;
}

/* ---------- 来源索引与快照分析（与 v0.2.0 相同） ---------- */

function buildIndex() {
    const idx = { wi: [], card: [], preset: [], history: [] };

    for (const e of state.wiEntries) {
        const n = normText(e && e.content);
        if (n.length < 12) continue;
        idx.wi.push({
            label: (e.comment || `WI#${e.uid}`) + (e.world ? ` · ${e.world}` : ''),
            norm: n,
        });
    }

    try {
        const ctx = api.getContext && api.getContext();
        const chars = (ctx && ctx.characters) || api.characters || [];
        const chid = ctx && ctx.characterId;
        const c = chars && chars[chid];
        if📦 生成内容（续 · index.js 后半部分）

接上文，`buildIndex()` 未写完，从这里继续。**下面这段直接拼在上一段代码末尾**，构成完整的 `index.js`。

```javascript
/* ---------- 来源索引（接上文 buildIndex）---------- */

function buildIndex() {
    const idx = { wi: [], card: [], preset: [], history: [] };

    for (const e of state.wiEntries) {
        const n = normText(e && e.content);
        if (n.length < 12) continue;
        idx.wi.push({
            label: (e.comment || `WI#${e.uid}`) + (e.world ? ` · ${e.world}` : ''),
            norm: n,
        });
    }

    try {
        const ctx = api.getContext && api.getContext();
        const chars = (ctx && ctx.characters) || api.characters || [];
        const chid = ctx && ctx.characterId;
        const c = chars && chars[chid];
        if (c) {
            const d = c.data || {};
            const fields = [
                ['description', c.description || d.description],
                ['personality', c.personality || d.personality],
                ['scenario', c.scenario || d.scenario],
                ['mes_example', c.mes_example || d.mes_example],
                ['first_mes', c.first_mes || d.first_mes],
            ];
            for (const [k, v] of fields) {
                const n = normText(subst(v));
                if (n.length < 12) continue;
                idx.card.push({ label: `角色卡 · ${k}`, norm: n });
            }
        }
    } catch (e) { console.warn(LOG, '角色卡索引失败', e); }

    try {
        const prompts = (api.oai_settings && api.oai_settings.prompts) || [];
        const info = enabledInfo();
        for (const p of prompts) {
            if (!p || p.marker) continue;
            if (!isEnabled(p, info)) continue;
            const n = normText(subst(p.content));
            if (n.length < 12) continue;
            idx.preset.push({ label: p.name || p.identifier, norm: n });
        }
    } catch (e) { console.warn(LOG, '预设索引失败', e); }

    try {
        const ctx = api.getContext && api.getContext();
        const chat = (ctx && ctx.chat) || [];
        const start = Math.max(0, chat.length - 120);
        for (let i = start; i < chat.length; i++) {
            const n = normText(chat[i] && chat[i].mes);
            if (n.length < 8) continue;
            idx.history.push({ label: `楼层 #${i}`, norm: n });
        }
    } catch (e) { console.warn(LOG, '历史索引失败', e); }

    for (const k of Object.keys(idx)) {
        idx[k].sort((a, b) => b.norm.length - a.norm.length);
    }
    return idx;
}

/* ---------- 快照分析 ---------- */

async function analyze(chatArr) {
    const idx = buildIndex();
    const buckets = { wi: 0, card: 0, preset: 0, history: 0, other: 0 };
    const hitMap = new Map();
    const wiHit = new Map();   // 世界书逐条命中量
    let total = 0;

    for (let i = 0; i < chatArr.length; i++) {
        const text = msgText(chatArr[i]);
        const mTokens = tk(text);
        total += mTokens;

        let remain = normText(text);
        let claimed = 0;

        const groups = [
            ['wi', idx.wi],
            ['card', idx.card],
            ['preset', idx.preset],
            ['history', idx.history],
        ];

        for (const [bucket, list] of groups) {
            for (const src of list) {
                if (!remain || src.norm.length > remain.length) continue;
                const at = remain.indexOf(src.norm);
                if (at === -1) continue;

                const t = tk(src.norm);
                buckets[bucket] += t;
                claimed += t;

                const key = `${bucket}|${src.label}`;
                const prev = hitMap.get(key);
                if (prev) { prev.tokens += t; prev.count += 1; }
                else hitMap.set(key, { bucket, label: src.label, tokens: t, count: 1 });

                if (bucket === 'wi') {
                    wiHit.set(src.label, (wiHit.get(src.label) || 0) + t);
                }

                remain = remain.slice(0, at) + ' ' + remain.slice(at + src.norm.length);
            }
        }

        buckets.other += Math.max(0, mTokens - claimed);
        if (i % 8 === 7) await yieldFrame();
    }

    const hits = Array.from(hitMap.values()).sort((a, b) => b.tokens - a.tokens);

    return {
        time: new Date().toLocaleTimeString(),
        msgCount: chatArr.length,
        total, buckets, hits,
        wiActivated: state.wiEntries.length,
        wiHit,
    };
}

/* ---------- 世界书详情 ---------- */

function buildWiDetail() {
    const rows = [];
    const snap = state.snapshot;

    for (const e of state.wiEntries) {
        if (!e) continue;
        const label = (e.comment || `WI#${e.uid}`) + (e.world ? ` · ${e.world}` : '');
        const content = typeof e.content === 'string' ? e.content : '';

        let trigger = '关键词';
        if (e.constant) trigger = '常驻';
        else if (e.vectorized) trigger = '向量';
        else if (e.decorators && String(e.decorators).includes('@@activate')) trigger = '强制';

        rows.push({
            label,
            world: e.world || '—',
            comment: e.comment || '(无备注)',
            uid: e.uid,
            tokens: tk(content),
            matched: snap && snap.wiHit ? (snap.wiHit.get(label) || 0) : null,
            keys: Array.isArray(e.key) ? e.key : [],
            keysecondary: Array.isArray(e.keysecondary) ? e.keysecondary : [],
            trigger,
            constant: !!e.constant,
            vectorized: !!e.vectorized,
            order: typeof e.order === 'number' ? e.order : null,
            depth: typeof e.depth === 'number' ? e.depth : null,
            position: typeof e.position === 'number' ? e.position : null,
            probability: e.useProbability ? e.probability : null,
            sticky: e.sticky || 0,
            cooldown: e.cooldown || 0,
            group: e.group || '',
            preview: content.slice(0, 90),
        });
    }

    rows.sort((a, b) => b.tokens - a.tokens);

    return {
        count: rows.length,
        totalTokens: rows.reduce((s, r) => s + r.tokens, 0),
        constantCount: rows.filter(r => r.constant).length,
        vectorCount: rows.filter(r => r.vectorized).length,
        worlds: Array.from(new Set(rows.map(r => r.world))),
        rows,
    };
}

/* ---------- 事件挂载 ---------- */

function hookEvents() {
    if (!api.eventSource || !api.event_types) {
        console.warn(LOG, 'eventSource 不可用，跳过事件挂载');
        return;
    }

    api.eventSource.on(api.event_types.WORLD_INFO_ACTIVATED, (entries) => {
        try {
            state.wiEntries = Array.isArray(entries) ? entries.slice() : [];
            state.wiStamp = Date.now();
            renderAll('wi');
        } catch (e) { console.warn(LOG, 'WI 捕获失败', e); }
    });

    api.eventSource.on(api.event_types.CHAT_COMPLETION_PROMPT_READY, (payload) => {
        try {
            if (!payload || payload.dryRun) return;
            const arr = Array.isArray(payload.chat) ? payload.chat.slice() : null;
            if (!arr || !arr.length) return;

            setTimeout(async () => {
                if (state.busy) return;
                state.busy = true;
                try {
                    state.snapshot = await analyze(arr);
                    renderAll('snapshot');
                    renderAll('wi');
                    console.log(LOG, '快照已更新', state.snapshot.total, 'tokens');
                } catch (e) {
                    console.error(LOG, '分析失败', e);
                } finally {
                    state.busy = false;
                }
            }, 0);
        } catch (e) { console.warn(LOG, 'PROMPT_READY 处理失败', e); }
    });

    console.log(LOG, '事件已挂载');
}

/* ---------- 渲染：常量 ---------- */

const BUCKET_LABEL = {
    preset: '预设条目', wi: '世界书', card: '角色卡',
    history: '聊天历史', other: '未识别',
};
const HIT_LABEL = { preset: '预设', wi: '世界书', card: '角色卡', history: '历史' };
const SEV_LABEL = { high: '高', medium: '中', low: '低' };

/* 同一份 HTML 要渲染到面板和悬浮窗两处 */
function paint(kind, html) {
    document.querySelectorAll(`[data-cx-slot="${kind}"]`).forEach(el => {
        el.innerHTML = html;
    });
}

/* ---------- 渲染：快照 ---------- */

function htmlSnapshot() {
    const s = state.snapshot;
    if (!s) return `<div class="cx-empty">还没有数据。发一条消息即可采集。</div>`;

    const order = ['preset', 'history', 'wi', 'card', 'other'];
    const rows = order.map(k => {
        const v = s.buckets[k] || 0;
        return `<tr>
            <td class="cx-name">${esc(BUCKET_LABEL[k])}</td>
            <td class="cx-num">${fmt(v)}</td>
            <td class="cx-bar">${bar(v / (s.total || 1))}</td>
            <td class="cx-num">${pct(v, s.total)}%</td>
        </tr>`;
    }).join('');

    const topHits = s.hits.slice(0, 15).map((h, i) => `<tr>
        <td class="cx-idx">${i + 1}</td>
        <td class="cx-name">
            <span class="cx-tag cx-tag-${h.bucket}">${esc(HIT_LABEL[h.bucket] || h.bucket)}</span>
            ${esc(h.label)}${h.count > 1 ? ` <span class="cx-dim">×${h.count}</span>` : ''}
        </td>
        <td class="cx-num">${fmt(h.tokens)}</td>
        <td class="cx-num">${pct(h.tokens, s.total)}%</td>
    </tr>`).join('');

    return `
        <div class="cx-head">
            第 ${s.msgCount} 条消息 · 合计 <b>${fmt(s.total)}</b> tokens
            <span class="cx-dim">（${esc(s.time)} · 激活世界书 ${s.wiActivated} 条）</span>
        </div>
        <table class="cx-table">${rows}</table>
        <div class="cx-note">
            分项由内容匹配推算，分词非线性叠加，各项之和与总数会有偏差。
            「未识别」通常是酒馆运行时拼接的格式包装、注入指令或宏展开差异。
        </div>
        <div class="cx-subhead">单项成本排行 Top 15</div>
        <table class="cx-table cx-rank">${topHits || '<tr><td class="cx-empty">无匹配项</td></tr>'}</table>
    `;
}

/* ---------- 渲染：预设 ---------- */

function htmlPreset() {
    const a = state.presetAudit;
    if (!a) return `<div class="cx-empty">点上方按钮开始审计。</div>`;
    if (a.error) return `<div class="cx-empty">${esc(a.error)}</div>`;

    const top = a.on.slice(0, 20).map((r, i) => `<tr>
        <td class="cx-idx">${i + 1}</td>
        <td class="cx-name">${esc(r.name)}${r.depth !== null ? ` <span class="cx-dim">@${r.depth}</span>` : ''}</td>
        <td class="cx-num">${fmt(r.tokens)}</td>
        <td class="cx-num">${pct(r.tokens, a.enabledTokens)}%</td>
    </tr>`).join('');

    const fatOff = a.off.slice(0, 8).map(r =>
        `<tr><td class="cx-name">${esc(r.name)}</td><td class="cx-num">${fmt(r.tokens)}</td></tr>`
    ).join('');

    return `
        <div class="cx-head">
            启用 <b>${a.enabledCount}</b> / 共 ${a.total} 条 ·
            合计 <b>${fmt(a.enabledTokens)}</b> tokens
        </div>
        <div class="cx-note">
            启用判定来源：${esc(a.enabledSource)}${a.orderTotal ? ` · 排序表 ${a.orderTotal} 项` : ''}<br>
            占位符 ${a.markerCount} 条（运行时填充，不计入）· 空内容 ${a.emptyCount} 条 ·
            禁用 ${a.disabledCount} 条，囤积 <b>${fmt(a.disabledTokens)}</b> tokens（未发送）
        </div>
        <div class="cx-subhead">启用条目成本排行 Top 20</div>
        <table class="cx-table cx-rank">${top || '<tr><td class="cx-empty">无启用条目</td></tr>'}</table>
        <div class="cx-subhead">禁用条目里最占体积的</div>
        <table class="cx-table cx-rank">${fatOff || '<tr><td class="cx-empty">无</td></tr>'}</table>
    `;
}

/* ---------- 渲染：世界书详情 ---------- */

function htmlWi() {
    const d = buildWiDetail();
    if (!d.count) {
        return `<div class="cx-empty">
            还没捕获到激活条目。发一条消息，触发一次世界书扫描。
        </div>`;
    }

    const rows = d.rows.map((r, i) => {
        const keys = r.keys.slice(0, 5).map(k => `<code>${esc(k)}</code>`).join(' ');
        const sec = r.keysecondary.length
            ? `<div class="cx-why">次要关键词：${r.keysecondary.slice(0, 4).map(k => esc(k)).join(' / ')}</div>`
            : '';
        const meta = [];
        if (r.order !== null) meta.push(`order ${r.order}`);
        if (r.position !== null) meta.push(`pos ${r.position}`);
        if (r.depth !== null) meta.push(`depth ${r.depth}`);
        if (r.probability !== null) meta.push(`概率 ${r.probability}%`);
        if (r.sticky) meta.push(`sticky ${r.sticky}`);
        if (r.cooldown) meta.push(`cd ${r.cooldown}`);
        if (r.group) meta.push(`组 ${esc(r.group)}`);

        return `<tr>
            <td class="cx-idx">${i + 1}</td>
            <td class="cx-name">
                <span class="cx-trig cx-trig-${r.constant ? 'const' : (r.vectorized ? 'vec' : 'key')}">${esc(r.trigger)}</span>
                ${esc(r.comment)}
                <div class="cx-why">${esc(r.world)} · uid ${r.uid}${meta.length ? ' · ' + meta.join(' · ') : ''}</div>
                ${keys ? `<div class="cx-why">命中键：${keys}</div>` : ''}
                ${sec}
                <div class="cx-code">${esc(r.preview)}${r.preview.length >= 90 ? '…' : ''}</div>
            </td>
            <td class="cx-num">${fmt(r.tokens)}</td>
            <td class="cx-num">${r.matched === null ? '—' : fmt(r.matched)}</td>
        </tr>`;
    }).join('');

    return `
        <div class="cx-head">
            本轮激活 <b>${d.count}</b> 条 · 内容合计 <b>${fmt(d.totalTokens)}</b> tokens
        </div>
        <div class="cx-note">
            常驻 ${d.constantCount} 条 · 向量 ${d.vectorCount} 条 ·
            来自 ${d.worlds.length} 本世界书：${esc(d.worlds.join(' / '))}<br>
            「原始」是条目自身内容的 token；「实际」是在本次 payload 里匹配到的量。
            两者不等通常因为条目被格式包装或被截断。
        </div>
        <table class="cx-table cx-rank">
            <tr>
                <th class="cx-idx">#</th>
                <th class="cx-name">条目</th>
                <th class="cx-num">原始</th>
                <th class="cx-num">实际</th>
            </tr>
            ${rows}
        </table>
    `;
}

/* ---------- 渲染：正则 ---------- */

function deadRowHtml(r) {
    const checked = state.selected.has(r.id) ? 'checked' : '';
    const cb = r.id
        ? `<input type="checkbox" class="cx-cb" data-id="${esc(r.id)}" ${checked}>`
        : '<span class="cx-dim">—</span>';
    const scope = r.promptOnly ? '发送' : (r.markdownOnly ? '显示' : '双向');
    return `<tr>
        <td class="cx-cbcell">${cb}</td>
        <td class="cx-name">
            <span class="cx-lv cx-lv-${r.level}">${r.level}</span>
            ${esc(r.name)}
            <div class="cx-why">${esc(r.why)} · 作用于${scope}</div>
            ${r.findPreview ? `<div class="cx-code">${esc(r.findPreview)}</div>` : ''}
        </td>
    </tr>`;
}

function conflictHtml(c, gi) {
    const ruleRows = c.rules.map(r => {
        const checked = state.selected.has(r.id) ? 'checked' : '';
        const cb = r.id
            ? `<input type="checkbox" class="cx-cb" data-id="${esc(r.id)}" ${checked}>`
            : '<span class="cx-dim">—</span>';
        const extra = [];
        if (r.role) extra.push(esc(r.role));
        if (r.find) extra.push(`匹配 <code>${esc(r.find)}</code>`);
        if (r.replace !== undefined && r.replace !== '') extra.push(`替换 <code>${esc(r.replace)}</code>`);
        return `<tr>
            <td class="cx-cbcell">${cb}</td>
            <td class="cx-name">
                ${esc(r.name)}
                ${extra.length ? `<div class="cx-why">${extra.join(' · ')}</div>` : ''}
            </td>
        </tr>`;
    }).join('');

    /* 高危冲突提供"保留第一条、关掉其余"的快捷键 */
    const quick = (c.type === 'duplicate' || c.type === 'replace_conflict') && c.rules.length > 1
        ? `<button class="menu_button cx-mini" data-cx-keepfirst="${gi}">保留第一条，勾选其余</button>`
        : '';

    return `
        <div class="cx-conflict cx-sev-${c.severity}">
            <div class="cx-conflict-head">
                <span class="cx-sev">${SEV_LABEL[c.severity]}</span>
                ${esc(c.title)}
            </div>
            <div class="cx-why">${esc(c.desc)}</div>
            <table class="cx-table cx-dead">${ruleRows}</table>
            <div class="cx-why cx-sugg">建议：${esc(c.suggestion)}</div>
            ${quick ? `<div class="cx-actions">${quick}</div>` : ''}
        </div>
    `;
}

function htmlRegex() {
    const a = state.regexAudit;
    if (!a) return `<div class="cx-empty">点上方按钮开始审计。</div>`;

    const cf = state.regexConflicts;
    const conflicts = (cf && cf.conflicts) || [];

    const deadRows = a.dead.map(deadRowHtml).join('');
    const suspectRows = a.suspect.map(deadRowHtml).join('');
    const conflictBlocks = conflicts.map((c, i) => conflictHtml(c, i)).join('');

    const highN = conflicts.filter(c => c.severity === 'high').length;
    const medN = conflicts.filter(c => c.severity === 'medium').length;
    const lowN = conflicts.filter(c => c.severity === 'low').length;

    const dupName = a.dupName.slice(0, 6).map(d =>
        `<li>${esc(d.name)} <span class="cx-dim">×${d.count}</span></li>`
    ).join('');

    const groups = (a.presetGroups || []).map(g => `<tr>
        <td class="cx-name">${esc(g.name)}${g.selected ? ' <span class="cx-dim">（当前）</span>' : ''}</td>
        <td class="cx-num">${g.global}</td>
        <td class="cx-num">${g.scoped}</td>
        <td class="cx-num">${g.preset}</td>
    </tr>`).join('');

    const selCount = state.selected.size;
    const canUndo = !!(state.lastUndo && state.lastUndo.length);

    return `
        <div class="cx-head">共 <b>${a.total}</b> 条 · 启用 ${a.enabled} · 禁用 ${a.disabled}</div>
        <table class="cx-table">
            <tr><td class="cx-name">仅影响发送 promptOnly</td><td class="cx-num">${a.promptOnly}</td></tr>
            <tr><td class="cx-name">仅影响显示 markdownOnly</td><td class="cx-num">${a.markdownOnly}</td></tr>
            <tr><td class="cx-name">双向生效</td><td class="cx-num">${a.both}</td></tr>
        </table>

        <div class="cx-subhead">规则冲突（高 ${highN} · 中 ${medN} · 低 ${lowN}）</div>
        ${conflicts.length
            ? `<div class="cx-note">
                   只检测启用规则，按 placement 分组比对。勾选要关闭的那条，
                   下方批量关闭区一起执行。
               </div>${conflictBlocks}`
            : '<div class="cx-empty">没有检出冲突。</div>'}

        <div class="cx-subhead">死规则（L1–L3，共 ${a.dead.length} 条）</div>
        ${a.dead.length
            ? `<table class="cx-table cx-dead">${deadRows}</table>`
            : '<div class="cx-empty">没有检出，正则很干净。</div>'}

        ${a.suspect.length ? `
            <div class="cx-subhead">需你判断（L4，共 ${a.suspect.length} 条）</div>
            <div class="cx-note">
                匹配式与替换串相同。有时是刻意用来锁定文本不被后续规则改动，默认不勾选。
            </div>
            <table class="cx-table cx-dead">${suspectRows}</table>
        ` : ''}

        <div class="cx-danger">
            <div class="cx-danger-title">批量关闭</div>
            <div class="cx-note">
                只把 <code>disabled</code> 置为 true，不删除规则，随时可在酒馆正则界面手动开回。
                执行前建议先导出备份。
            </div>
            <div class="cx-actions">
                <button data-cx-act="selDead" class="menu_button">全选 L1–L3</button>
                <button data-cx-act="selNone" class="menu_button">取消全选</button>
                <button data-cx-act="backup" class="menu_button">导出备份</button>
            </div>
            <div class="cx-actions">
                <button data-cx-act="close" class="menu_button cx-btn-danger">
                    关闭选中项（${selCount}）
                </button>
                <button data-cx-act="undo" class="menu_button" ${canUndo ? '' : 'disabled'}>
                    撤销上次操作
                </button>
            </div>
            <div class="cx-note cx-warn">
                改动后酒馆正则界面不会自动刷新，需刷新页面才能看到新状态。
                另外别在改完后立刻切换正则预设，那会整组覆盖 <code>extension_settings.regex</code>。
            </div>
        </div>

        ${dupName ? `<div class="cx-subhead">重复命名（提示）</div><ul class="cx-list">${dupName}</ul>` : ''}

        <div class="cx-subhead">正则预设分组</div>
        <table class="cx-table cx-rank">
            <tr><th class="cx-name">分组</th><th class="cx-num">global</th><th class="cx-num">scoped</th><th class="cx-num">preset</th></tr>
            ${groups || '<tr><td class="cx-empty">无</td></tr>'}
        </table>
        <div class="cx-note">
            本工具只处理全局正则 <code>extension_settings.regex</code>。
            角色卡内嵌的 scoped 正则、白名单字段一律不动。
        </div>
    `;
}

/* ---------- 统一渲染入口 ---------- */

function renderAll(which) {
    if (!which || which === 'snapshot') paint('snapshot', htmlSnapshot());
    if (!which || which === 'preset') paint('preset', htmlPreset());
    if (!which || which === 'wi') paint('wi', htmlWi());
    if (!which || which === 'regex') paint('regex', htmlRegex());
}

/* ---------- 纯文本报告 ---------- */

function textReport() {
    const L = [];
    L.push(`Context X-Ray v${VERSION} · ${new Date().toLocaleString()}`);
    L.push('');

    const s = state.snapshot;
    if (s) {
        L.push(`【上下文快照】消息 ${s.msgCount} 条 · 合计 ${fmt(s.total)} tokens`);
        for (const k of ['preset', 'history', 'wi', 'card', 'other']) {
            const v = s.buckets[k] || 0;
            L.push(`  ${BUCKET_LABEL[k]}  ${fmt(v)}  ${pct(v, s.total)}%`);
        }
        L.push('  单项排行:');
        s.hits.slice(0, 15).forEach((h, i) => {
            L.push(`    ${i + 1}. [${HIT_LABEL[h.bucket] || h.bucket}] ${h.label}  ${fmt(h.tokens)}`);
        });
    } else {
        L.push('【上下文快照】暂无数据');
    }
    L.push('');

    const d = buildWiDetail();
    if (d.count) {
        L.push(`【世界书详情】激活 ${d.count} 条 · ${fmt(d.totalTokens)} tokens`);
        L.push(`  常驻 ${d.constantCount} · 向量 ${d.vectorCount} · 来源 ${d.worlds.join(' / ')}`);
        d.rows.forEach((r, i) => {
            L.push(`    ${i + 1}. [${r.trigger}] ${r.comment} (${r.world}) 原始 ${fmt(r.tokens)}${r.matched !== null ? ` / 实际 ${fmt(r.matched)}` : ''}`);
        });
    } else {
        L.push('【世界书详情】暂无激活条目');
    }
    L.push('');

    const a = state.presetAudit;
    if (a && !a.error) {
        L.push(`【预设审计】启用 ${a.enabledCount}/${a.total} · ${fmt(a.enabledTokens)} tokens`);
        L.push(`  判定来源: ${a.enabledSource}`);
        L.push(`  占位符 ${a.markerCount} · 空内容 ${a.emptyCount} · 禁用 ${a.disabledCount}（囤积 ${fmt(a.disabledTokens)}）`);
        a.on.slice(0, 20).forEach((r, i) => {
            L.push(`    ${i + 1}. ${r.name}  ${fmt(r.tokens)}  ${pct(r.tokens, a.enabledTokens)}%`);
        });
    } else {
        L.push('【预设审计】未执行');
    }
    L.push('');

    const g = state.regexAudit;
    if (g) {
        L.push(`【正则审计】共 ${g.total} · 启用 ${g.enabled} · 禁用 ${g.disabled}`);
        L.push(`  promptOnly ${g.promptOnly} · markdownOnly ${g.markdownOnly} · 双向 ${g.both}`);
        L.push(`  死规则 L1-L3: ${g.dead.length} 条`);
        g.dead.forEach(r => L.push(`    [${r.level}] ${r.name} — ${r.why}`));
        L.push(`  需判断 L4: ${g.suspect.length} 条`);
        g.suspect.forEach(r => L.push(`    [L4] ${r.name}`));

        const cf = state.regexConflicts;
        const cs = (cf && cf.conflicts) || [];
        L.push(`  冲突: ${cs.length} 组`);
        cs.forEach((c, i) => {
            L.push(`    ${i + 1}. [${SEV_LABEL[c.severity]}] ${c.title} — ${c.desc}`);
            c.rules.forEach(r => L.push(`         · ${r.name}${r.role ? ` (${r.role})` : ''}`));
            L.push(`         建议: ${c.suggestion}`);
        });
    } else {
        L.push('【正则审计】未执行');
    }

    return L.join('\n');
}

/* ---------- 交互：确认按钮状态 ---------- */

function resetConfirm() {
    state.confirmArmed = false;
    if (state.confirmTimer) {
        clearTimeout(state.confirmTimer);
        state.confirmTimer = null;
    }
    document.querySelectorAll('[data-cx-act="close"]').forEach(btn => {
        btn.textContent = `关闭选中项（${state.selected.size}）`;
        btn.classList.remove('cx-btn-armed');
    });
}

function syncCloseLabel() {
    if (state.confirmArmed) return;
    document.querySelectorAll('[data-cx-act="close"]').forEach(btn => {
        btn.textContent = `关闭选中项（${state.selected.size}）`;
    });
}

/* ---------- 交互：全局事件委托 ---------- */

function bindDelegates() {
    /* 勾选框：两处界面共用同一份 state.selected */
    document.addEventListener('change', (ev) => {
        const cb = ev.target.closest && ev.target.closest('.cx-cb');
        if (!cb) return;
        const id = cb.dataset.id;
        if (!id) return;
        if (cb.checked) state.selected.add(id);
        else state.selected.delete(id);
        /* 同步另一处界面里同 id 的勾选框 */
        document.querySelectorAll(`.cx-cb[data-id="${CSS.escape(id)}"]`).forEach(o => {
            if (o !== cb) o.checked = cb.checked;
        });
        resetConfirm();
    });

    document.addEventListener('click', async (ev) => {
        /* 保留第一条，勾选其余 */
        const kf = ev.target.closest && ev.target.closest('[data-cx-keepfirst]');
        if (kf) {
            const gi = Number(kf.dataset.cxKeepfirst);
            const cf = state.regexConflicts;
            const c = cf && cf.conflicts && cf.conflicts[gi];
            if (c) {
                c.rules.slice(1).forEach(r => { if (r.id) state.selected.add(r.id); });
                if (c.rules[0] && c.rules[0].id) state.selected.delete(c.rules[0].id);
                renderAll('regex');
                toast(`已勾选 ${c.rules.length - 1} 条`);
            }
            return;
        }

        const btn = ev.target.closest && ev.target.closest('[data-cx-act]');
        if (!btn) return;
        const act = btn.dataset.cxAct;

        if (act === 'runPreset') {
            if (state.busy) { toast('正在忙，稍等'); return; }
            state.busy = true;
            const progs = document.querySelectorAll('[data-cx-slot="presetProg"]');
            try {
                state.presetAudit = await auditPreset((done, all) => {
                    progs.forEach(p => { p.textContent = `${done} / ${all}`; });
                });
                progs.forEach(p => { p.textContent = ''; });
                renderAll('preset');
                toast('预设审计完成');
            } catch (e) {
                console.error(LOG, e);
                toast('审计失败，看 Console');
            } finally { state.busy = false; }
            return;
        }

        if (act === 'runRegex') {
            try {
                state.regexAudit = auditRegex();
                state.regexConflicts = detectRegexConflicts();
                renderAll('regex');
                const n = state.regexConflicts.conflicts.length;
                toast(`死规则 ${state.regexAudit.dead.length} 条 · 冲突 ${n} 组`, 2400);
            } catch (e) {
                console.error(LOG, e);
                toast('审计失败，看 Console');
            }
            return;
        }

        if (act === 'selDead') {
            const a = state.regexAudit;
            if (!a) return;
            state.selected = new Set(a.dead.map(r => r.id).filter(Boolean));
            renderAll('regex');
            toast(`已选 ${state.selected.size} 条`);
            return;
        }

        if (act === 'selNone') {
            state.selected.clear();
            renderAll('regex');
            return;
        }

        if (act === 'backup') { exportBackup(); return; }

        if (act === 'close') {
            const n = state.selected.size;
            if (!n) { toast('没有选中任何规则'); return; }

            if (!state.confirmArmed) {
                state.confirmArmed = true;
                document.querySelectorAll('[data-cx-act="close"]').forEach(b => {
                    b.textContent = `再点一次确认关闭 ${n} 条`;
                    b.classList.add('cx-btn-armed');
                });
                state.confirmTimer = setTimeout(resetConfirm, 5000);
                return;
            }

            resetConfirm();
            const changed = closeSelected();
            state.regexAudit = auditRegex();
            state.regexConflicts = detectRegexConflicts();
            renderAll('regex');
            toast(changed ? `已关闭 ${changed} 条，刷新页面可见` : '没有需要改动的规则', 2600);
            return;
        }

        if (act === 'undo') {
            const n = undoLast();
            state.regexAudit = auditRegex();
            state.regexConflicts = detectRegexConflicts();
            renderAll('regex');
            toast(n ? `已还原 ${n} 条` : '没有可撤销的操作', 2400);
            return;
        }

        if (act === 'copy') {
            const text = textReport();
            try {
                await navigator.clipboard.writeText(text);
                toast('报告已复制');
            } catch {
                console.log(text);
                toast('剪贴板不可用，已打印到 Console');
            }
            return;
        }

        if (act === 'log') {
            console.log(textReport());
            toast('已打印到 Console');
            return;
        }

        if (act === 'openFloat') { showWindow(); return; }
        if (act === 'closeWin') { hideWindow(); return; }
        if (act === 'minWin') { hideWindow(); toast('已收起，点 🌸 可重新打开'); return; }

        if (act === 'tab') {
            const tab = btn.dataset.cxTab;
            const win = document.getElementById('cx_window');
            if (!win || !tab) return;
            win.querySelectorAll('[data-cx-act="tab"]').forEach(b => {
                b.classList.toggle('cx-tab-on', b.dataset.cxTab === tab);
            });
            win.querySelectorAll('[data-cx-page]').forEach(p => {
                p.style.display = (p.dataset.cxPage === tab) ? '' : 'none';
            });
            return;
        }
    });
}

/* ---------- 悬浮球与窗口 ---------- */

function panelBody(prefix) {
    /* prefix 用于区分两处 slot，避免 id 冲突；slot 用 data 属性而非 id */
    return `
        <div class="cx-section">
            <div class="cx-section-title">上下文快照</div>
            <div class="cx-hint">发一条消息自动采集，预览请求会被跳过。</div>
            <div data-cx-slot="snapshot"></div>
        </div>

        <div class="cx-section">
            <div class="cx-section-title">世界书详情</div>
            <div class="cx-hint">列出本轮实际激活的每一条，含触发方式与关键词。</div>
            <div data-cx-slot="wi"></div>
        </div>

        <div class="cx-section">
            <div class="cx-section-title">预设成本审计</div>
            <div class="cx-actions">
                <button data-cx-act="runPreset" class="menu_button">开始审计</button>
                <span data-cx-slot="presetProg" class="cx-dim"></span>
            </div>
            <div data-cx-slot="preset"></div>
        </div>

        <div class="cx-section">
            <div class="cx-section-title">正则审计与清理</div>
            <div class="cx-actions">
                <button data-cx-act="runRegex" class="menu_button">开始审计</button>
            </div>
            <div data-cx-slot="regex"></div>
        </div>

        <div class="cx-actions cx-footer">
            <button data-cx-act="copy" class="menu_button">复制纯文本报告</button>
            <button data-cx-act="log" class="menu_button">打印到 Console</button>
        </div>
    `;
}

function buildBall() {
    if (document.getElementById('cx_ball')) return;

    const ball = document.createElement('div');
    ball.id = 'cx_ball';
    ball.className = 'cx-ball';
    ball.setAttribute('role', 'button');
    ball.setAttribute('tabindex', '0');
    ball.setAttribute('aria-label', '打开上下文审计');
    ball.title = '上下文审计（可拖动）';
    ball.textContent = '🌸';

    const st = loadBallPos();
    ball.style.left = `${st.x}px`;
    ball.style.top = `${st.y}px`;

    document.body.appendChild(ball);

    makeDraggable(ball, ball, {
        onTap: () => { state.floatVisible ? hideWindow() : showWindow(); },
        onEnd: (x, y) => saveBallPos(x, y),
    });

    ball.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            state.floatVisible ? hideWindow() : showWindow();
        }
    });
}

function buildWindow() {
    if (document.getElementById('cx_window')) return;

    const win = document.createElement('div');
    win.id = 'cx_window';
    win.className = 'cx-window';
    win.style.display = 'none';
    win.innerHTML = `
        <div class="cx-win-bar" id="cx_win_bar">
            <span class="cx-win-title">🌸 上下文审计 v${VERSION}</span>
            <span class="cx-win-btns">
                <button data-cx-act="minWin" class="cx-win-btn" title="收起">—</button>
                <button data-cx-act="closeWin" class="cx-win-btn" title="关闭">✕</button>
            </span>
        </div>
        <div class="cx-win-tabs">
            <button data-cx-act="tab" data-cx-tab="all" class="cx-tab cx-tab-on">全部</button>
            <button data-cx-act="tab" data-cx-tab="snapshot" class="cx-tab">快照</button>
            <button data-cx-act="tab" data-cx-tab="wi" class="cx-tab">世界书</button>
            <button data-cx-act="tab" data-cx-tab="preset" class="cx-tab">预设</button>
            <button data-cx-act="tab" data-cx-tab="regex" class="cx-tab">正则</button>
        </div>
        <div class="cx-win-body cx-block">
            <div data-cx-page="all">${panelBody('win')}</div>
        </div>
    `;
    document.body.appendChild(win);

    const bar = win.querySelector('#cx_win_bar');
    makeDraggable(win, bar, { onEnd: (x, y) => saveWinPos(x, y) });

    const wp = loadWinPos();
    if (wp) {
        win.style.left = `${wp.x}px`;
        win.style.top = `${wp.y}px`;
    }
}

/* 标签页切换：把各分区从「全部」里按需显隐 */
function applyTab(tab) {
    const win = document.getElementById('cx_window');
    if (!win) return;
    const map = {
        snapshot: 'snapshot',
        wi: 'wi',
        preset: 'preset',
        regex: 'regex',
    };
    win.querySelectorAll('.cx-section').forEach(sec => {
        if (tab === 'all') { sec.style.display = ''; return; }
        const slot = sec.querySelector('[data-cx-slot]');
        const kind = slot ? slot.dataset.cxSlot : '';
        sec.style.display = (kind === map[tab]) ? '' : 'none';
    });
}

function showWindow() {
    buildWindow();
    const win = document.getElementById('cx_window');
    if (!win) return;
    win.style.display = '';
    state.floatVisible = true;
    renderAll();
    syncCloseLabel();
    clampIntoView(win);
}

function hideWindow() {
    const win = document.getElementById('cx_window');
    if (win) win.style.display = 'none';
    state.floatVisible = false;
}

/* ---------- 拖拽（指针事件，桌面与触屏通用） ---------- */

function makeDraggable(el, handle, opts = {}) {
    let sx = 0, sy = 0, ox = 0, oy = 0, moved = false, active = false;

    const down = (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        /* 点在按钮上时不拖 */
        if (e.target.closest && e.target.closest('button') && e.target !== handle) {
            if (handle.contains(e.target) && e.target.classList.contains('cx-win-btn')) return;
        }
        active = true;
        moved = false;
        const r = el.getBoundingClientRect();
        ox = r.left; oy = r.top;
        sx = e.clientX; sy = e.clientY;
        handle.setPointerCapture && handle.setPointerCapture(e.pointerId);
    };

    const move = (e) => {
        if (!active) return;
        const dx = e.clientX - sx;
        const dy = e.clientY - sy;
        if (!moved && Math.abs(dx) + Math.abs(dy) < 6) return;
        moved = true;
        el.style.left = `${ox + dx}px`;
        el.style.top = `${oy + dy}px`;
        e.preventDefault();
    };

    const up = () => {
        if (!active) return;
        active = false;
        clampIntoView(el);
        const r = el.getBoundingClientRect();
        if (moved && opts.onEnd) opts.onEnd(Math.round(r.left), Math.round(r.top));
        if (!moved && opts.onTap) opts.onTap();
    };

    handle.addEventListener('pointerdown', down);
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
}

function clampIntoView(el) {
    const r = el.getBoundingClientRect();
    const maxX = window.innerWidth - Math.min(r.width, window.innerWidth) ;
    const maxY = window.innerHeight - 40;
    let x = Math.min(Math.max(0, r.left), Math.max(0, maxX));
    let y = Math.min(Math.max(0, r.top), Math.max(0, maxY));
    el.style.left = `${Math.round(x)}px`;
    el.style.top = `${Math.round(y)}px`;
}

/* ---------- 位置持久化（localStorage，不写酒馆设置） ---------- */

const LS_BALL = 'cx_ball_pos';
const LS_WIN = 'cx_win_pos';

function loadBallPos() {
    try {
        const raw = localStorage.getItem(LS_BALL);
        if (raw) {
            const p = JSON.parse(raw);
            if (typeof p.x === 'number' && typeof p.y === 'number') return p;
        }
    } catch { /* 忽略 */ }
    return { x: Math.max(8, window.innerWidth - 68), y: Math.max(8, window.innerHeight - 150) };
}

function saveBallPos(x, y) {
    try { localStorage.setItem(LS_BALL, JSON.stringify({ x, y })); } catch { /* 忽略 */ }
}

function loadWinPos() {
    try {
        const raw = localStorage.getItem(LS_WIN);
        if (raw) {
            const p = JSON.parse(raw);
            if (typeof p.x === 'number' && typeof p.y === 'number') return p;
        }
    } catch { /* 忽略 */ }
    return null;
}

function saveWinPos(x, y) {
    try { localStorage.setItem(LS_WIN, JSON.stringify({ x, y })); } catch { /* 忽略 */ }
}

/* ---------- 扩展面板 ---------- */

function buildPanel() {
    const host = document.getElementById('extensions_settings2')
        || document.getElementById('extensions_settings');
    if (!host) return false;
    if (document.getElementById('cx_settings')) return true;

    const wrap = document.createElement('div');
    wrap.id = 'cx_settings';
    wrap.className = 'cx-block';
    wrap.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>上下文审计 v${VERSION}</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="cx-notice">
                    审计部分只读。正则批量关闭是唯一写入操作，需二次确认，可撤销。
                </div>
                <div class="cx-actions">
                    <button data-cx-act="openFloat" class="menu_button">🌸 打开悬浮窗</button>
                    <label class="cx-inline">
                        <input type="checkbox" id="cx_ball_on" checked>
                        <span>显示悬浮球</span>
                    </label>
                </div>
                ${panelBody('panel')}
            </div>
        </div>
    `;
    host.appendChild(wrap);

    const ballOn = document.getElementById('cx_ball_on');
    const saved = localStorage.getItem('cx_ball_on');
    if (saved === '0') ballOn.checked = false;
    applyBallVisible(ballOn.checked);

    ballOn.addEventListener('change', () => {
        applyBallVisible(ballOn.checked);
        try { localStorage.setItem('cx_ball_on', ballOn.checked ? '1' : '0'); } catch { /* 忽略 */ }
    });

    renderAll();
    return true;
}

function applyBallVisible(on) {
    const ball = document.getElementById('cx_ball');
    if (!ball) return;
    ball.style.display = on ? '' : 'none';
}

/* ---------- 标签页联动 ---------- */

document.addEventListener('click', (ev) => {
    const btn = ev.target.closest && ev.target.closest('[data-cx-act="tab"]');
    if (!btn) return;
    applyTab(btn.dataset.cxTab);
});

/* ---------- 启动 ---------- */

async function boot() {
    const errs = await resolveApi();
    if (errs.length) console.warn(LOG, 'API 解析有失败项', errs);

    if (typeof api.getTokenCount !== 'function') {
        console.error(LOG, 'getTokenCount 不可用，扩展无法工作');
        return;
    }
    if (typeof api.saveSettingsDebounced !== 'function') {
        console.warn(LOG, 'saveSettingsDebounced 不可用，批量关闭将无法持久化');
    }

    bindDelegates();
    hookEvents();
    buildBall();

    window.addEventListener('resize', () => {
        const ball = document.getElementById('cx_ball');
        if (ball) clampIntoView(ball);
        const win = document.getElementById('cx_window');
        if (win && win.style.display !== 'none') clampIntoView(win);
    });

    let tries = 0;
    const timer = setInterval(() => {
        tries += 1;
        if (buildPanel() || tries > 40) clearInterval(timer);
    }, 500);

    console.log(LOG, '已启动');
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { boot(); }, { once: true });
} else {
    boot();
}
