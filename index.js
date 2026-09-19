/* ============================================================================
 * AI Input Writer — 酒馆剧情扩写扩展
 *
 * 做什么：输入一句剧情梗概（例「第二天我去了超市买东西」）
 *         → 结合当前聊天上下文 + 文风（内置 / 预设条目 / 世界书条目）+ 仿写样本
 *         → 扩写成一段可直接发送的 Input
 *         → 用户可编辑 → 一键注入酒馆输入框
 *
 * 读上下文和仿写样本时按标签清洗：默认只取 <content>…</content> 里的内容，
 * 并整块剔除 <thinking> 之类的思维链，避免 AI 把幕后笔记也学去。
 *
 * 铁律：注入 ≠ 发送。
 *       本文件不存在任何点击 #send_but、派发 Enter 键、或调用发送函数的代码。
 *       请勿在后续修改中破坏这条规则。
 *
 * 技术：原生 JS + jQuery（酒馆自带），无构建步骤。
 * 作者：北北（与咕咕协作）
 * 版本：0.4.0
 * ========================================================================== */

(function () {
    'use strict';

    const EXT_ID = 'aiiw';

    /* ========================================================================
     * 1. 默认配置
     * ====================================================================== */

    const DEFAULT_SYSTEM_PROMPT = [
        '你是 SillyTavern 的 Input 写作助手。',
        '用户会给你一句简短的剧情想法（例如「第二天我去了超市买东西」）。',
        '你的任务不是替角色回复，而是把它扩写或者转述成一段延续上文的情节或片段。',
        '',
        '必须遵守：',
        '1. 延续前文。承接前文的时间、地点、人物状态与情绪，不要另起炉灶。',
        '2. 保持用户原本的意图与行动，不擅自添加用户没有要求的重大情节。',
        '3. 严格沿用当前聊天已有的叙述人称。',
        '4. 严格遵循下面给出的文风要求。',
        '5. 长度控制在指定字数范围内。',
        '',
        '只输出 Input 正文。不要输出解释、标题、引号、代码块或任何 markdown 标记。',
    ].join('\n');

    /* 历史版本的默认提示词。仅用于「旧默认 → 新默认」的自动升级判断，
       用户自己改过的内容不会被覆盖。 */
    const LEGACY_DEFAULT_PROMPTS = [
        [
            '你是 SillyTavern 的 Input 写作助手。',
            '',
            '用户会给你一句简短的剧情想法（例如「第二天我去了超市买东西」）。',
            '你的任务不是替角色回复，而是把它扩写成一段用户可以直接发送的 Input。',
            '',
            '必须遵守：',
            '1. 延续前文。承接上一轮的时间、地点、人物状态与情绪，不要另起炉灶。',
            '2. 保持用户原本的意图与行动，不擅自添加用户没有要求的重大情节。',
            '3. 只写「我」（用户）的所作所为、所见所感。绝对不要替角色写反应、',
            '   对话或心理活动 —— 角色的反应留给模型自己演。',
            '4. 使用第一人称，或严格沿用当前聊天已有的叙述人称。',
            '5. 严格遵循下面给出的文风要求。',
            '6. 长度控制在指定字数范围内。',
            '',
            '只输出 Input 正文。不要输出解释、标题、引号、代码块或任何 markdown 标记。',
        ].join('\n'),
    ];

    const DEFAULT_STYLES = [
        { id: 's1', name: '白描',     desc: '克制简练，重动作与细节，少用形容词和感叹号。' },
        { id: 's2', name: '细腻心理', desc: '心理描写较多，注重情绪起伏与内心独白，节奏偏慢。' },
        { id: 's3', name: '文学化',   desc: '书面语，适当使用意象与修辞，句子有韵律感。' },
        { id: 's4', name: '简洁自然', desc: '口语化，短句为主，读起来轻快不费劲。' },
        { id: 's5', name: '动作强化', desc: '以行为推进剧情，少内心戏，强调画面感与身体动作。' },
    ];

    const DEFAULTS = {
        apiMode: 'tavern',      // 'tavern' = 沿用酒馆主 API | 'custom' = 自填
        endpoint: '',
        apiKey: '',
        model: '',
        temperature: 0.8,
        maxTokens: 2000,
        useProxy: false,        // 自填模式是否走酒馆 /proxy 绕开 CORS

        /* --- v0.4 新增：API 方案 ---
           把一套 endpoint/key/model/参数 存成命名方案，随时切换。
           表单改动会自动写回当前选中的方案（方案是"活"的）。 */
        apiProfiles: [],        // [{ id, name, endpoint, apiKey, model, temperature, maxTokens, useProxy }]
        activeProfile: '',      // 当前方案 id；'' = 未关联方案（表单即当前配置）
        minWords: 300,
        maxWords: 600,
        ctxMode: 'recent',      // 'none' | 'recent' | 'all'
        ctxN: 20,
        styles: DEFAULT_STYLES,
        activeStyleIds: [],
        systemPrompt: DEFAULT_SYSTEM_PROMPT,
        lastIntent: '',

        /* --- v0.2 新增 --- */
        styleTab: 'builtin',            // 'builtin' | 'preset' | 'world'
        presetName: '',                 // 选中的预设名（读取来源，不会切换你正在用的预设）
        presetPickedMap: {},            // { 预设名: [prompt块 identifier] }
        presetOnlyStyle: true,          // 只看「文风相关」条目
        worldBook: '',                  // 选中的世界书
        worldPickedMap: {},             // { 世界书名: [条目 uid] }
        worldEnabledOnly: true,         // 只看启用中的条目
        mimicEnabled: false,            // 是否启用仿写样本
        mimicFloor: -1,                 // 楼层号（= chat 数组索引 = mesid）

        /* --- v0.3 新增：内容清洗 ---
           预设常让模型把思维链写进 <thinking> 之类的标签，正文放进 <content>。
           不清洗的话，AI 会把思维链也一起当正文学过去。 */
        ctxClean: true,
        ctxKeepTags: 'content',
        ctxDropTags: 'thinking, think, reasoning, analysis, cot, thought, scratchpad, details, 思维链, 思考过程',
    };

    /* 内容清洗的出厂值，供「恢复默认」用 */
    const DEFAULT_CLEAN_KEEP = DEFAULTS.ctxKeepTags;
    const DEFAULT_CLEAN_DROP = DEFAULTS.ctxDropTags;

    /* 上下文裁剪阈值 */
    const PER_MSG_LIMIT = 800;      // 单条消息最多取多少字
    const TOTAL_LIMIT = 12000;      // 上下文字符总数上限
    const STYLE_CHAR_LIMIT = 12000; // 文风素材（预设/世界书条目）总字数上限

    /* 列表渲染上限，防止超大预设/世界书把面板卡死 */
    const MAX_PRESET_ROWS = 400;
    const MAX_WORLD_ROWS = 300;

    /* 「文风相关」条目的识别关键词（命中条目名或内容即算） */
    const STYLE_KEYWORDS = [
        'writing_style', 'writing style', '文风', '风格', '文笔', '笔法',
        '写法', '叙述', '语感', '修辞', '行文', '散文', '描写',
    ];

    /* ========================================================================
     * 2. 运行时状态
     * ====================================================================== */

    const state = {
        panel: 'closed',    // 'open' | 'minimized' | 'closed'
        busy: false,
        abort: null,        // 自填模式的 AbortController
    };

    /** 数据源缓存：预设条目 / 世界书条目 / 世界书名单 / 楼层列表 */
    const cache = {
        presetPrompts: {},      // { 预设名: [条目] }
        worldEntries: {},       // { 世界书名: [条目] }
        worldbooks: null,       // [{ id, label }]
        floors: null,           // [{ id, name, text, isUser, hidden }]
        presetFiltered: null,   // { total, truncated } 当前筛选结果规模
        worldFiltered: null,
        loading: false,
    };

    let cfg = null;         // 配置对象，指向 extensionSettings[EXT_ID]

    /* ========================================================================
     * 3. 基础工具
     * ====================================================================== */

    function getCtx() {
        try {
            if (typeof SillyTavern !== 'undefined' && typeof SillyTavern.getContext === 'function') {
                return SillyTavern.getContext();
            }
        } catch (e) { /* 酒馆尚未就绪，忽略 */ }
        return null;
    }

    function deepClone(o) {
        return JSON.parse(JSON.stringify(o));
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /** 统计字数：中日韩字符按字计，其余按词计。适合中文 RP 场景。 */
    function countWords(text) {
        const t = String(text || '').trim();
        if (!t) return 0;
        const CJK = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g;
        const cjk = (t.match(CJK) || []).length;
        const rest = t.replace(CJK, ' ').split(/\s+/).filter(Boolean).length;
        return cjk + rest;
    }

    /** 取一条消息的正文。兼容酒馆原生 `mes` 与酒馆助手的 `message`。 */
    function getMessageText(m) {
        if (!m) return '';
        if (typeof m.mes === 'string' && m.mes) return m.mes;
        if (m.message != null) return String(m.message);
        if (Array.isArray(m.swipes) && typeof m.swipe_id === 'number'
            && typeof m.swipes[m.swipe_id] === 'string') {
            return m.swipes[m.swipe_id];
        }
        return '';
    }

    function isUserMessage(m) {
        return m && (m.is_user === true || m.role === 'user');
    }

    /** 把多行文本压成单行摘要 */
    function oneLine(s, limit) {
        const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
        return t.length > limit ? t.slice(0, limit) + '…' : t;
    }

    /** 安全地展开酒馆宏（{{getvar::x}} 之类）。失败就返回原文。 */
    function substitute(text) {
        const t = String(text == null ? '' : text);
        if (!t) return '';
        const ctx = getCtx();
        try {
            if (ctx && typeof ctx.substituteParams === 'function') {
                return String(ctx.substituteParams(t));
            }
        } catch (e) { /* 宏里有未定义的变量等，忽略 */ }
        return t;
    }

    /** 转义正则特殊字符 —— 用户能在设置里自填标签名，必须防注入 */
    function escapeReg(s) {
        return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /** 把「content, thinking」这类输入解析成干净的标签名数组 */
    function parseTagList(s) {
        return String(s || '')
            .split(/[,，;；\s]+/)
            .map(function (x) { return x.trim().replace(/^<\/?/, '').replace(/>$/, ''); })
            .filter(Boolean);
    }

    /* ---------------------------------------------------------------
     * 内容清洗：只留叙事正文
     *
     * 规则按顺序执行：
     *   1. 整块剔除「剔除标签」（含标签本身）；只有开标签没有闭标签时，
     *      视为输出被截断，直接丢到文末
     *   2. 若命中「保留标签」，只取标签内部的内容
     *   3. 清掉残留的 HTML 类标签
     *   4. 收敛空白
     *
     * 关掉清洗（设置里取消勾选）时原样返回。
     * ------------------------------------------------------------- */

    function cleanMessageText(raw) {
        let t = String(raw == null ? '' : raw);
        if (!t.trim()) return '';
        if (!cfg) return t.trim();                        // 配置还没就绪，原样返回
        if (cfg.ctxClean === false) return t.trim();      // 用户关掉了清洗

        const keepTags = parseTagList(cfg.ctxKeepTags);
        const dropTags = parseTagList(cfg.ctxDropTags);

        // 1. 整块剔除
        dropTags.forEach(function (tag) {
            const e = escapeReg(tag);
            // 成对标签
            t = t.replace(new RegExp('<' + e + '(?:\\s[^>]*)?>[\\s\\S]*?<\\/' + e + '\\s*>', 'gi'), '');
            // 自闭合标签
            t = t.replace(new RegExp('<' + e + '(?:\\s[^>]*)?\\/>', 'gi'), '');
            // 只剩开标签（多半是输出被截断）→ 从这里开始全部丢掉
            const m = t.match(new RegExp('<' + e + '(?:\\s[^>]*)?>', 'i'));
            if (m && m.index >= 0) t = t.slice(0, m.index);
        });

        // 2. 只保留指定标签内的内容
        if (keepTags.length) {
            const chunks = [];
            keepTags.forEach(function (tag) {
                const e = escapeReg(tag);
                const re = new RegExp('<' + e + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + e + '\\s*>', 'gi');
                let m;
                while ((m = re.exec(t)) !== null) {
                    if (m[1] && m[1].trim()) chunks.push(m[1].trim());
                }
            });
            if (chunks.length) {
                t = chunks.join('\n\n');
            } else {
                // 兜底：标签没闭合，取开标签之后的部分
                for (let i = 0; i < keepTags.length; i++) {
                    const m = t.match(new RegExp('<' + escapeReg(keepTags[i]) + '(?:\\s[^>]*)?>', 'i'));
                    if (m) { t = t.slice(m.index + m[0].length); break; }
                }
            }
        }

        // 3. 残留标签
        t = t.replace(/<\/?[a-zA-Z][a-zA-Z0-9_:.-]*(?:\s[^>]*)?\/?>/g, '');

        // 4. 收敛空白
        t = t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');

        return t.trim();
    }

    /* ========================================================================
     * 4. 配置读写
     * ====================================================================== */

    function loadConfig() {
        const ctx = getCtx();
        if (!ctx) return false;

        if (!ctx.extensionSettings || typeof ctx.extensionSettings !== 'object') {
            ctx.extensionSettings = {};
        }

        const saved = ctx.extensionSettings[EXT_ID] || {};
        cfg = Object.assign(deepClone(DEFAULTS), saved);

        // 数组字段单独兜底
        if (!Array.isArray(cfg.styles) || cfg.styles.length === 0) {
            cfg.styles = deepClone(DEFAULT_STYLES);
        }
        if (!Array.isArray(cfg.activeStyleIds)) {
            cfg.activeStyleIds = [];
        }
        // 清掉已被删除的风格 id
        const validIds = cfg.styles.map(s => s.id);
        cfg.activeStyleIds = cfg.activeStyleIds.filter(id => validIds.includes(id));

        // map 字段兜底
        if (!cfg.presetPickedMap || typeof cfg.presetPickedMap !== 'object') cfg.presetPickedMap = {};
        if (!cfg.worldPickedMap || typeof cfg.worldPickedMap !== 'object') cfg.worldPickedMap = {};

        // API 方案兜底
        if (!Array.isArray(cfg.apiProfiles)) cfg.apiProfiles = [];
        cfg.apiProfiles = cfg.apiProfiles.filter(p => p && typeof p === 'object' && p.id);
        if (typeof cfg.activeProfile !== 'string') cfg.activeProfile = '';
        // 选中的方案已被删掉 → 退回"未关联"
        if (cfg.activeProfile && !cfg.apiProfiles.some(p => p.id === cfg.activeProfile)) {
            cfg.activeProfile = '';
        }

        /* 旧默认提示词 → 新默认：只在用户没自己改过时自动升级 */
        const cur = String(cfg.systemPrompt || '').trim();
        if (LEGACY_DEFAULT_PROMPTS.some(t => t.trim() === cur)) {
            cfg.systemPrompt = DEFAULT_SYSTEM_PROMPT;
        }

        ctx.extensionSettings[EXT_ID] = cfg;
        return true;
    }

    function saveConfig() {
        const ctx = getCtx();
        if (!ctx || !cfg) return;
        ctx.extensionSettings[EXT_ID] = cfg;
        if (typeof ctx.saveSettingsDebounced === 'function') {
            ctx.saveSettingsDebounced();
        }
    }

    /* ========================================================================
     * 5. 数据源 A：预设条目
     *
     *      走 preset manager：同步、按名取，不会切换你正在用的预设。
     *      依据：public/scripts/preset-manager.js — getCompletionPresetByName()
     * ====================================================================== */

    function getPresetManagerSafe() {
        const ctx = getCtx();
        if (!ctx || typeof ctx.getPresetManager !== 'function') return null;
        try {
            return ctx.getPresetManager('openai') || null;
        } catch (e) {
            return null;
        }
    }

    /** 列出所有 Chat Completion 预设名 */
    function listPresetNames() {
        const pm = getPresetManagerSafe();
        if (pm && typeof pm.getPresetList === 'function') {
            try {
                const list = pm.getPresetList();
                const names = list && list.preset_names;
                if (Array.isArray(names)) return names.slice();
                if (names && typeof names === 'object') return Object.keys(names);
            } catch (e) { /* 继续走 DOM 兜底 */ }
        }
        // 兜底：读预设下拉框
        const out = [];
        const sel = document.getElementById('settings_preset_openai');
        if (sel) {
            for (let i = 0; i < sel.options.length; i++) out.push(sel.options[i].textContent);
        }
        return out;
    }

    /** 当前正在使用的预设名 */
    function getCurrentPresetName() {
        const pm = getPresetManagerSafe();
        if (pm && typeof pm.getSelectedPresetName === 'function') {
            try { return pm.getSelectedPresetName() || ''; } catch (e) { /* 忽略 */ }
        }
        const sel = document.getElementById('settings_preset_openai');
        if (sel && sel.selectedIndex >= 0) return sel.options[sel.selectedIndex].textContent;
        return '';
    }

    /** 取某个预设的 prompt 块原始数组 */
    function getRawPrompts(presetName) {
        const ctx = getCtx();
        if (!presetName) {
            return (ctx && ctx.chatCompletionSettings && Array.isArray(ctx.chatCompletionSettings.prompts))
                ? ctx.chatCompletionSettings.prompts
                : [];
        }
        const pm = getPresetManagerSafe();
        if (pm && typeof pm.getCompletionPresetByName === 'function') {
            try {
                const preset = pm.getCompletionPresetByName(presetName);
                if (preset && Array.isArray(preset.prompts)) return preset.prompts;
            } catch (e) { /* 忽略 */ }
        }
        // 兜底：如果请求的就是当前预设，用 chatCompletionSettings
        if (presetName === getCurrentPresetName()) {
            return (ctx && ctx.chatCompletionSettings && Array.isArray(ctx.chatCompletionSettings.prompts))
                ? ctx.chatCompletionSettings.prompts
                : [];
        }
        return [];
    }

    /** 把原始 prompt 数组整理成面板用的条目列表 */
    function normalizePrompts(rawList) {
        const out = [];
        for (let i = 0; i < rawList.length; i++) {
            const p = rawList[i];
            if (!p || typeof p !== 'object') continue;
            const content = String(p.content == null ? '' : p.content);
            const name = String(p.name || '').trim();
            // 空内容的多半是分隔条，跳过
            if (!content.trim()) continue;
            // identifier 缺失时用「索引 + 名字」造一个稳定的键
            const id = String(p.identifier || ('#' + i + ':' + name));
            out.push({
                id: id,
                name: name || ('未命名条目 ' + (i + 1)),
                content: content,
                chars: content.length,
                systemPrompt: p.system_prompt === true,
                styleFlag: looksLikeStyle(name, content),
            });
        }
        return out;
    }

    function looksLikeStyle(name, content) {
        const hay = (String(name || '') + '\n' + String(content || '').slice(0, 2000)).toLowerCase();
        return STYLE_KEYWORDS.some(function (k) {
            return hay.indexOf(String(k).toLowerCase()) !== -1;
        });
    }

    /** 加载（带缓存）某个预设的条目列表 */
    function loadPresetEntries(presetName, force) {
        const key = presetName || '__current__';
        if (!force && cache.presetPrompts[key]) return cache.presetPrompts[key];
        const list = normalizePrompts(getRawPrompts(presetName));
        cache.presetPrompts[key] = list;
        return list;
    }

    /* ========================================================================
     * 6. 数据源 B：世界书条目
     *
     *      名单：POST /api/worldinfo/list（见 src/endpoints/worldinfo.js:39）
     *      内容：ctx.loadWorldInfo(fileId)（前端带缓存）
     * ====================================================================== */

    async function fetchWorldbookNames() {
        if (cache.worldbooks) return cache.worldbooks;

        const ctx = getCtx();
        const headers = (ctx && typeof ctx.getRequestHeaders === 'function')
            ? ctx.getRequestHeaders() : {};

        try {
            const res = await fetch('/api/worldinfo/list', {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({}),
                cache: 'no-cache',
            });
            if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data) && data.length) {
                    cache.worldbooks = data.map(function (x) {
                        const id = String(x.file_id || x.name || '');
                        return { id: id, label: id };
                    }).filter(function (x) { return x.id; });
                    return cache.worldbooks;
                }
            }
        } catch (e) { /* 走 DOM 兜底 */ }

        // 兜底：读酒馆世界书面板的 select
        const out = [];
        const sel = document.getElementById('world_info');
        if (sel) {
            for (let i = 0; i < sel.options.length; i++) {
                const name = sel.options[i].textContent.trim();
                if (name) out.push({ id: name, label: name });
            }
        }
        cache.worldbooks = out;
        return out;
    }

    /** 把一本世界书整理成条目列表 */
    function normalizeWorldEntries(data) {
        const out = [];
        const entries = data && data.entries;
        if (!entries || typeof entries !== 'object') return out;

        Object.keys(entries).forEach(function (uid) {
            const e = entries[uid];
            if (!e || typeof e !== 'object') return;
            const content = String(e.content == null ? '' : e.content);
            if (!content.trim()) return;

            let keys = [];
            if (Array.isArray(e.key)) keys = e.key.map(String);
            else if (typeof e.key === 'string' && e.key) keys = [e.key];

            const comment = String(e.comment || e.name || '').trim();
            out.push({
                uid: String(uid),
                name: comment || (keys.length ? keys.join(', ') : ('条目 ' + uid)),
                content: content,
                keys: keys,
                constant: e.constant === true,
                disabled: e.disable === true,
                chars: content.length,
                styleFlag: looksLikeStyle(comment, content),
            });
        });

        // 启用的排前面，再按字数短的排前面（方便扫）
        out.sort(function (a, b) {
            if (a.disabled !== b.disabled) return a.disabled ? 1 : -1;
            return a.chars - b.chars;
        });
        return out;
    }

    async function loadWorldEntries(bookName, force) {
        if (!bookName) return [];
        if (!force && cache.worldEntries[bookName]) return cache.worldEntries[bookName];

        const ctx = getCtx();
        if (!ctx || typeof ctx.loadWorldInfo !== 'function') return [];

        let data = null;
        try {
            data = await ctx.loadWorldInfo(bookName);
        } catch (e) { /* 忽略 */ }

        const list = normalizeWorldEntries(data);
        cache.worldEntries[bookName] = list;
        return list;
    }

    /* ========================================================================
     * 7. 数据源 C：聊天楼层
     *      chat 数组索引 === mesid，也就是酒馆助手说的「楼层号」。
     * ====================================================================== */

    function listFloors() {
        const ctx = getCtx();
        const chat = ctx && Array.isArray(ctx.chat) ? ctx.chat : null;
        if (!chat) return [];

        const out = [];
        for (let i = 0; i < chat.length; i++) {
            const m = chat[i];
            const raw = getMessageText(m).trim();
            if (!raw) continue;
            if (m.is_system === true || m.role === 'system') continue;

            // 清洗掉思维链等标签；清洗后为空就回退原文，避免楼层凭空消失
            const clean = cleanMessageText(raw);

            out.push({
                id: i,
                name: m.name || (isUserMessage(m) ? '我' : '角色'),
                text: clean || raw,
                rawLen: raw.length,
                cleaned: clean !== raw,
                isUser: isUserMessage(m),
                hidden: m.is_hidden === true,
            });
        }
        return out;
    }

    function refreshFloors() {
        cache.floors = listFloors();
        return cache.floors;
    }

    /* ========================================================================
     * 8. 面板 DOM
     * ====================================================================== */

    function panelHtml() {
        return `
<div class="aiiw-mask"></div>
<div class="aiiw-box">

  <header class="aiiw-header">
    <span class="aiiw-title">AI Input Writer</span>
    <div class="aiiw-hbtns">
      <span id="aiiw-minimize" class="aiiw-icon-btn" title="最小化（让出聊天区）">⌄</span>
      <span id="aiiw-close" class="aiiw-icon-btn" title="关闭">✕</span>
    </div>
  </header>

  <div class="aiiw-body">

    <!-- ============ 意图 + 参数 ============ -->
    <section class="aiiw-card">
      <h4 class="aiiw-card-title">我想写的是</h4>
      <textarea id="aiiw-intent" class="aiiw-input"
        placeholder="例：第二天我去了超市买东西"></textarea>

      <div class="aiiw-line">
        <span class="aiiw-line-label">字数</span>
        <input id="aiiw-min" class="aiiw-input aiiw-num" type="number" min="0" step="50">
        <span class="aiiw-line-label">—</span>
        <input id="aiiw-max" class="aiiw-input aiiw-num" type="number" min="0" step="50">
        <select id="aiiw-len-preset" class="aiiw-input">
          <option value="100-200">100-200</option>
          <option value="200-400">200-400</option>
          <option value="300-600">300-600</option>
          <option value="500-800">500-800</option>
          <option value="800-1200">800-1200</option>
          <option value="custom">自定义</option>
        </select>
      </div>

      <div class="aiiw-line">
        <span class="aiiw-line-label">上下文</span>
        <select id="aiiw-ctx-mode" class="aiiw-input">
          <option value="none">不使用</option>
          <option value="recent">最近 N 条</option>
          <option value="all">全部</option>
        </select>
        <input id="aiiw-ctx-n" class="aiiw-input aiiw-num" type="number" min="1" step="1">
        <span id="aiiw-ctx-n-label" class="aiiw-line-label">条</span>
      </div>

      <div class="aiiw-actions">
        <button id="aiiw-generate" class="aiiw-btn">生成 Input</button>
      </div>
    </section>

    <!-- ============ 文风来源 ============ -->
    <section class="aiiw-card">
      <h4 class="aiiw-card-title">文风来源</h4>

      <div class="aiiw-tabs">
        <div class="aiiw-tab" data-tab="builtin">内置风格</div>
        <div class="aiiw-tab" data-tab="preset">预设条目</div>
        <div class="aiiw-tab" data-tab="world">世界书条目</div>
      </div>

      <!-- 内置风格 -->
      <div class="aiiw-tabpane" data-pane="builtin">
        <div class="aiiw-pane-tools">
          <span id="aiiw-style-add" class="aiiw-mini">新建风格</span>
        </div>
        <div id="aiiw-style-list"></div>
      </div>

      <!-- 预设条目 -->
      <div class="aiiw-tabpane aiiw-hidden" data-pane="preset">
        <div class="aiiw-line">
          <span class="aiiw-line-label">预设</span>
          <select id="aiiw-preset-sel" class="aiiw-input aiiw-grow"></select>
          <span id="aiiw-preset-reload" class="aiiw-icon-btn" title="重新读取这个预设">⟳</span>
        </div>
        <div class="aiiw-line">
          <input id="aiiw-preset-search" class="aiiw-input aiiw-grow"
            placeholder="搜索条目名或内容">
          <label class="aiiw-check aiiw-nowrap">
            <input id="aiiw-preset-onlystyle" type="checkbox">
            <span>只看文风</span>
          </label>
          <span id="aiiw-preset-clear" class="aiiw-mini">清空</span>
        </div>
        <div id="aiiw-preset-list" class="aiiw-entry-list"></div>
        <div id="aiiw-preset-stat" class="aiiw-hint"></div>
      </div>

      <!-- 世界书条目 -->
      <div class="aiiw-tabpane aiiw-hidden" data-pane="world">
        <div class="aiiw-line">
          <span class="aiiw-line-label">世界书</span>
          <select id="aiiw-world-sel" class="aiiw-input aiiw-grow"></select>
          <span id="aiiw-world-reload" class="aiiw-icon-btn" title="重新读取这本书">⟳</span>
        </div>
        <div class="aiiw-line">
          <input id="aiiw-world-search" class="aiiw-input aiiw-grow"
            placeholder="搜索备注、关键词或内容">
          <label class="aiiw-check aiiw-nowrap">
            <input id="aiiw-world-enabled" type="checkbox">
            <span>只看启用中</span>
          </label>
          <span id="aiiw-world-clear" class="aiiw-mini">清空</span>
        </div>
        <div id="aiiw-world-list" class="aiiw-entry-list"></div>
        <div id="aiiw-world-stat" class="aiiw-hint"></div>
      </div>
    </section>

    <!-- ============ 仿写样本 ============ -->
    <section class="aiiw-card">
      <div class="aiiw-card-head">
        <h4 class="aiiw-card-title">仿写样本</h4>
        <label class="aiiw-check">
          <input id="aiiw-mimic-on" type="checkbox">
          <span>启用</span>
        </label>
      </div>
      <div class="aiiw-line">
        <select id="aiiw-mimic-floor" class="aiiw-input aiiw-grow"></select>
        <span id="aiiw-mimic-reload" class="aiiw-icon-btn" title="刷新楼层列表">⟳</span>
      </div>
      <div id="aiiw-mimic-preview" class="aiiw-hint"></div>
    </section>

    <!-- ============ 生成结果 ============ -->
    <section class="aiiw-card">
      <h4 class="aiiw-card-title">生成结果</h4>

      <div id="aiiw-error" class="aiiw-hidden"></div>

      <textarea id="aiiw-result" class="aiiw-input"
        placeholder="生成的内容会出现在这里，可以自由编辑"></textarea>

      <div class="aiiw-line aiiw-between">
        <span id="aiiw-count">当前字数：0</span>
        <span id="aiiw-generating">正在生成……</span>
      </div>

      <div class="aiiw-actions">
        <button id="aiiw-regen" class="aiiw-btn aiiw-btn-ghost">重新生成</button>
        <button id="aiiw-inject" class="aiiw-btn">注入 Input</button>
      </div>
    </section>

    <span id="aiiw-settings-toggle" class="aiiw-mini">设置</span>

    <div id="aiiw-settings">

      <!-- 内容清洗 -->
      <section class="aiiw-card">
        <h4 class="aiiw-card-title">内容清洗</h4>
        <label class="aiiw-check">
          <input id="aiiw-clean-on" type="checkbox">
          <span>读上下文与仿写样本时，剔除思维链等无关内容</span>
        </label>
        <div class="aiiw-line">
          <span class="aiiw-line-label">只保留</span>
          <input id="aiiw-clean-keep" class="aiiw-input aiiw-grow" placeholder="content">
          <span class="aiiw-line-label">标签里的内容</span>
        </div>
        <div class="aiiw-line">
          <span class="aiiw-line-label">剔除</span>
          <input id="aiiw-clean-drop" class="aiiw-input aiiw-grow"
            placeholder="thinking, reasoning, ……">
        </div>
        <div class="aiiw-line">
          <span id="aiiw-clean-reset" class="aiiw-mini">恢复默认</span>
        </div>
        <p class="aiiw-note">
          多个标签用逗号分隔，写成 <code>&lt;content&gt;</code> 也认。
          「只保留」留空则整段原文都用；楼层里找不到这些标签时，也会原样读取。
        </p>
      </section>

      <!-- API -->
      <section class="aiiw-card">
        <h4 class="aiiw-card-title">API</h4>
        <select id="aiiw-set-apimode" class="aiiw-input">
          <option value="tavern">沿用酒馆当前主 API（零配置、无跨域）</option>
          <option value="custom">自填 API（OpenAI 兼容）</option>
        </select>

        <div id="aiiw-custom-block">
          <div class="aiiw-line">
            <span class="aiiw-line-label">方案</span>
            <select id="aiiw-profile-sel" class="aiiw-input aiiw-grow"></select>
            <span id="aiiw-profile-save" class="aiiw-mini">存为新方案</span>
            <span id="aiiw-profile-del" class="aiiw-mini">删除</span>
          </div>

          <div class="aiiw-line">
            <span class="aiiw-line-label">Endpoint</span>
            <input id="aiiw-set-endpoint" class="aiiw-input aiiw-grow"
              placeholder="例：https://api.deepseek.com/chat/completions">
          </div>
          <div class="aiiw-line">
            <span class="aiiw-line-label">API Key</span>
            <input id="aiiw-set-apikey" class="aiiw-input aiiw-grow" type="password">
          </div>
          <div class="aiiw-line">
            <span class="aiiw-line-label">Model</span>
            <input id="aiiw-set-model" class="aiiw-input aiiw-grow"
              placeholder="例：deepseek-chat">
            <select id="aiiw-model-sel" class="aiiw-input aiiw-grow aiiw-hidden"></select>
            <span id="aiiw-fetch-models" class="aiiw-mini">取模型</span>
          </div>
          <div class="aiiw-line">
            <span class="aiiw-line-label">Temperature</span>
            <input id="aiiw-set-temp" class="aiiw-input aiiw-num" type="number" step="0.1" min="0" max="2">
            <span class="aiiw-line-label">Max Tokens</span>
            <input id="aiiw-set-maxtokens" class="aiiw-input aiiw-num" type="number" step="100" min="100">
          </div>
          <div class="aiiw-line">
            <span id="aiiw-test-api" class="aiiw-mini">测试连接</span>
            <span id="aiiw-test-result" class="aiiw-test"></span>
          </div>
          <label class="aiiw-check">
            <input id="aiiw-set-proxy" type="checkbox">
            <span>走酒馆代理（绕开浏览器跨域限制）</span>
          </label>
          <p class="aiiw-note">
            Endpoint 要填<b>完整请求地址</b>（到 <code>/chat/completions</code>），不是只填域名。
            多数 API（含 DeepSeek 官方）允许浏览器直接访问，所以<b>先别勾上面这项，直接试</b>。
            只有提示跨域失败时，才需要开启酒馆代理：把酒馆 config.yaml 里的
            <code>enableCorsProxy</code> 改成 <code>true</code>（或加启动参数 <code>--corsProxy</code>），
            重启酒馆后再勾上。
          </p>
        </div>
      </section>

      <!-- System Prompt -->
      <section class="aiiw-card">
        <div class="aiiw-card-head">
          <h4 class="aiiw-card-title">System Prompt</h4>
          <span id="aiiw-sysprompt-reset" class="aiiw-mini">恢复默认</span>
        </div>
        <textarea id="aiiw-set-sysprompt" class="aiiw-input aiiw-sysprompt"></textarea>
      </section>

    </div>

  </div>
</div>`;
    }

    function ensurePanel() {
        if (document.getElementById('aiiw-panel')) return;   // 单实例，防重复初始化
        const el = document.createElement('div');
        el.id = 'aiiw-panel';
        el.className = 'aiiw-hidden';
        el.innerHTML = panelHtml();
        document.body.appendChild(el);

        if (!document.getElementById('aiiw-minibar')) {
            const bar = document.createElement('div');
            bar.id = 'aiiw-minibar';
            bar.title = 'AI Input Writer（点击展开）';
            bar.innerHTML = '<i class="fa-solid fa-pen-fancy"></i>';
            document.body.appendChild(bar);
        }
    }

    function ensureMenuEntry() {
        let tries = 0;
        const timer = setInterval(function () {
            tries += 1;
            const menu = document.getElementById('extensionsMenu');

            if (menu && !document.getElementById('aiiw-menu-entry')) {
                const btn = document.createElement('div');
                btn.id = 'aiiw-menu-entry';
                btn.className = 'list-group-item flex-container flex-gap-10 interactable';
                btn.innerHTML = '<div class="fa-solid fa-pen-fancy"></div><div>AI 剧情扩写</div>';
                btn.addEventListener('click', function () { openPanel(); });
                menu.appendChild(btn);
                clearInterval(timer);
                return;
            }

            // 已经在菜单里，或等太久就放弃
            if (document.getElementById('aiiw-menu-entry') || tries > 120) {
                clearInterval(timer);
            }
        }, 500);
    }

    /* ========================================================================
     * 9. 三态切换：open / minimized / closed
     *     只切显隐，绝不销毁 DOM —— 保证用户输入和草稿不丢。
     * ====================================================================== */

    function setPanelState(next) {
        state.panel = next;
        const panel = document.getElementById('aiiw-panel');
        const bar = document.getElementById('aiiw-minibar');
        if (!panel || !bar) return;

        if (next === 'open') {
            panel.classList.remove('aiiw-hidden');
            bar.classList.remove('aiiw-visible');
            applyMobileViewport();
        } else if (next === 'minimized') {
            panel.classList.add('aiiw-hidden');
            bar.classList.add('aiiw-visible');
            resetViewportOverride(panel);
        } else {
            panel.classList.add('aiiw-hidden');
            bar.classList.remove('aiiw-visible');
            resetViewportOverride(panel);
        }
    }

    /* ---- 移动端软键盘适配 ----
       手机键盘弹起时，visualViewport 会变矮，而 position:fixed 的面板高度
       仍按 layout viewport 算，结果就是输入框被键盘盖住。
       这里把面板高度跟随视觉视口走。桌面浏览器上等于什么都不做。 */
    function isNarrowScreen() {
        return window.innerWidth <= 768 || window.innerHeight <= 520;
    }

    function resetViewportOverride(panel) {
        if (!panel) return;
        panel.style.top = '';
        panel.style.bottom = '';
        panel.style.height = '';
    }

    function applyMobileViewport() {
        const panel = document.getElementById('aiiw-panel');
        if (!panel) return;

        const vv = window.visualViewport;
        if (!vv || !isNarrowScreen() || state.panel !== 'open') {
            resetViewportOverride(panel);
            return;
        }

        panel.style.top = vv.offsetTop + 'px';
        panel.style.bottom = 'auto';
        panel.style.height = vv.height + 'px';
    }

    function setupMobileViewport() {
        const vv = window.visualViewport;
        if (!vv) return;
        vv.addEventListener('resize', applyMobileViewport);
        vv.addEventListener('scroll', applyMobileViewport);
        window.addEventListener('orientationchange', function () {
            setTimeout(applyMobileViewport, 200);
        });
    }

    function openPanel() {
        setPanelState('open');
        syncUiToConfig();
        renderStyleList();
        renderTabs();
        refreshPresetSource();
        refreshWorldSource();
        refreshMimicSource();
        updateCountDisplay();
        const intent = document.getElementById('aiiw-intent');
        if (intent) intent.focus();
    }

    /* ========================================================================
     * 10. 渲染：标签页
     * ====================================================================== */

    function renderTabs() {
        const tab = cfg ? cfg.styleTab : 'builtin';
        document.querySelectorAll('#aiiw-panel .aiiw-tab').forEach(function (el) {
            el.classList.toggle('aiiw-active', el.dataset.tab === tab);
        });
        document.querySelectorAll('#aiiw-panel .aiiw-tabpane').forEach(function (el) {
            el.classList.toggle('aiiw-hidden', el.dataset.pane !== tab);
        });
    }

    /* ========================================================================
     * 11. 渲染：内置风格
     * ====================================================================== */

    function renderStyleList() {
        const box = document.getElementById('aiiw-style-list');
        if (!box || !cfg) return;

        if (cfg.styles.length === 0) {
            box.innerHTML = '<div class="aiiw-hint">还没有风格。点上面的「+ 新建风格」建一条。</div>';
            return;
        }

        box.innerHTML = cfg.styles.map(function (s) {
            const checked = cfg.activeStyleIds.includes(s.id) ? ' checked' : '';
            return '<label class="aiiw-style-item" title="' + escapeHtml(s.desc) + '">'
                + '<input type="checkbox" class="aiiw-style-cb" data-id="' + escapeHtml(s.id) + '"' + checked + '>'
                + '<span>' + escapeHtml(s.name) + '</span>'
                + '<span class="aiiw-del" data-id="' + escapeHtml(s.id) + '" title="删除这条风格">✕</span>'
                + '</label>';
        }).join('');
    }

    function addStyle() {
        const name = window.prompt('风格名称（例：冷淡克制）');
        if (!name || !name.trim()) return;
        const desc = window.prompt('风格描述（会直接发给 AI）\n例：克制、细腻，心理描写较多，少用感叹号。', '');
        if (desc === null) return;

        cfg.styles.push({
            id: 's' + Date.now().toString(36),
            name: name.trim(),
            desc: String(desc || '').trim(),
        });
        saveConfig();
        renderStyleList();
    }

    function deleteStyle(id) {
        const target = cfg.styles.find(s => s.id === id);
        if (!target) return;
        if (!window.confirm('删除风格「' + target.name + '」？')) return;
        cfg.styles = cfg.styles.filter(s => s.id !== id);
        cfg.activeStyleIds = cfg.activeStyleIds.filter(x => x !== id);
        saveConfig();
        renderStyleList();
    }

    /* ========================================================================
     * 12. 渲染：预设条目
     * ====================================================================== */

    function refreshPresetSource() {
        if (!cfg) return;
        const sel = document.getElementById('aiiw-preset-sel');
        if (!sel) return;

        const names = listPresetNames();
        const current = getCurrentPresetName();

        if (names.length === 0) {
            // 读不到预设列表也能用：退化成「当前正在用的预设」
            cfg.presetName = '';
            saveConfig();
            sel.innerHTML = '<option value="">（当前预设）</option>';
            const only0 = document.getElementById('aiiw-preset-onlystyle');
            if (only0) only0.checked = !!cfg.presetOnlyStyle;
            renderPresetList();
            return;
        }

        // 首次：默认选当前正在用的预设
        if (!cfg.presetName || names.indexOf(cfg.presetName) === -1) {
            cfg.presetName = (current && names.indexOf(current) !== -1) ? current : names[0];
            saveConfig();
        }

        sel.innerHTML = names.map(function (n) {
            const mark = (n === current) ? '（当前使用中）' : '';
            return '<option value="' + escapeHtml(n) + '">' + escapeHtml(n + mark) + '</option>';
        }).join('');
        sel.value = cfg.presetName;

        const only = document.getElementById('aiiw-preset-onlystyle');
        if (only) only.checked = !!cfg.presetOnlyStyle;

        renderPresetList();
    }

    function getPresetPicked() {
        if (!cfg) return [];
        const key = cfg.presetName || '';
        if (!Array.isArray(cfg.presetPickedMap[key])) cfg.presetPickedMap[key] = [];
        return cfg.presetPickedMap[key];
    }

    function renderPresetList() {
        if (!cfg) return;
        const box = document.getElementById('aiiw-preset-list');
        const stat = document.getElementById('aiiw-preset-stat');
        if (!box) return;

        const all = loadPresetEntries(cfg.presetName, false);

        if (all.length === 0) {
            box.innerHTML = '<div class="aiiw-hint">这个预设里没有可用的提示词条目（或读不到）。</div>';
            if (stat) stat.textContent = '';
            return;
        }

        const q = String((document.getElementById('aiiw-preset-search') || {}).value || '').trim().toLowerCase();
        const onlyStyle = !!(document.getElementById('aiiw-preset-onlystyle') || {}).checked;

        let rows = all.filter(function (e) {
            if (onlyStyle && !e.styleFlag) return false;
            if (q) {
                const hay = (e.name + '\n' + e.content).toLowerCase();
                if (hay.indexOf(q) === -1) return false;
            }
            return true;
        });

        const total = rows.length;
        const truncated = rows.length > MAX_PRESET_ROWS;
        if (truncated) rows = rows.slice(0, MAX_PRESET_ROWS);

        const picked = getPresetPicked();

        if (total === 0) {
            box.innerHTML = '<div class="aiiw-hint">没有匹配的条目。'
                + (onlyStyle ? '可以试试取消勾选「只看文风类」，或者换个搜索词。' : '换个搜索词试试。')
                + '</div>';
        } else {
            box.innerHTML = rows.map(function (e) {
                return entryRowHtml({
                    kind: 'preset',
                    key: e.id,
                    name: e.name,
                    meta: e.chars + ' 字' + (e.systemPrompt ? ' · system' : ''),
                    content: e.content,
                    checked: picked.indexOf(e.id) !== -1,
                    badge: e.styleFlag ? '文风' : '',
                });
            }).join('');
        }

        cache.presetFiltered = { total: total, truncated: truncated };
        updatePresetStat();
    }

    /** 只更新统计行，不重渲染列表（勾选时用，避免滚动位置丢失） */
    function updatePresetStat() {
        const stat = document.getElementById('aiiw-preset-stat');
        if (!stat || !cfg) return;
        const f = cache.presetFiltered;
        if (!f) { stat.textContent = ''; return; }
        const picked = getPresetPicked();

        let others = 0;
        Object.keys(cfg.presetPickedMap).forEach(function (n) {
            if (n === (cfg.presetName || '')) return;
            const ids = cfg.presetPickedMap[n];
            if (Array.isArray(ids) && ids.length) others += 1;
        });

        stat.textContent = '共 ' + f.total + ' 条'
            + (f.truncated ? '（只显示前 ' + MAX_PRESET_ROWS + ' 条，用搜索缩小范围）' : '')
            + ' · 本预设已勾选 ' + picked.length + ' 条 / 约 ' + countPresetPickedChars() + ' 字'
            + (others ? ' · 另有 ' + others + ' 个预设的勾选也会一起生效' : '');
    }

    function countPresetPickedChars() {
        const picked = getPresetPicked();
        const all = cache.presetPrompts[cfg.presetName || '__current__'] || [];
        let n = 0;
        all.forEach(function (e) { if (picked.indexOf(e.id) !== -1) n += e.chars; });
        return n;
    }

    /* ========================================================================
     * 13. 渲染：世界书条目
     * ====================================================================== */

    async function refreshWorldSource() {
        if (!cfg) return;
        const sel = document.getElementById('aiiw-world-sel');
        if (!sel) return;

        sel.innerHTML = '<option value="">读取中……</option>';
        const books = await fetchWorldbookNames();

        if (books.length === 0) {
            sel.innerHTML = '<option value="">（没读到世界书）</option>';
            setEntryListHtml('aiiw-world-list',
                '<div class="aiiw-hint">读不到世界书列表。</div>');
            return;
        }

        if (!cfg.worldBook || !books.some(function (b) { return b.id === cfg.worldBook; })) {
            // 优先默认选中当前聊天绑定的世界书
            const ctx = getCtx();
            const bound = ctx && ctx.chatMetadata ? ctx.chatMetadata.world_info : '';
            cfg.worldBook = (bound && books.some(function (b) { return b.id === bound; }))
                ? bound : books[0].id;
            saveConfig();
        }

        sel.innerHTML = books.map(function (b) {
            return '<option value="' + escapeHtml(b.id) + '">' + escapeHtml(b.label) + '</option>';
        }).join('');
        sel.value = cfg.worldBook;

        const cb = document.getElementById('aiiw-world-enabled');
        if (cb) cb.checked = !!cfg.worldEnabledOnly;

        await renderWorldList();
    }

    function getWorldPicked() {
        if (!cfg) return [];
        const key = cfg.worldBook || '';
        if (!Array.isArray(cfg.worldPickedMap[key])) cfg.worldPickedMap[key] = [];
        return cfg.worldPickedMap[key];
    }

    async function renderWorldList() {
        if (!cfg) return;
        const box = document.getElementById('aiiw-world-list');
        const stat = document.getElementById('aiiw-world-stat');
        if (!box) return;

        box.innerHTML = '<div class="aiiw-hint">读取条目中……</div>';

        const all = await loadWorldEntries(cfg.worldBook, false);
        if (!cfg) return;   // 异步期间可能已卸载

        if (all.length === 0) {
            box.innerHTML = '<div class="aiiw-hint">这本书没有可用的条目。</div>';
            if (stat) stat.textContent = '';
            return;
        }

        const q = String((document.getElementById('aiiw-world-search') || {}).value || '').trim().toLowerCase();
        const enabledOnly = !!(document.getElementById('aiiw-world-enabled') || {}).checked;

        let rows = all.filter(function (e) {
            if (enabledOnly && e.disabled) return false;
            if (q) {
                const hay = (e.name + '\n' + e.keys.join(' ') + '\n' + e.content).toLowerCase();
                if (hay.indexOf(q) === -1) return false;
            }
            return true;
        });

        const total = rows.length;
        const truncated = rows.length > MAX_WORLD_ROWS;
        if (truncated) rows = rows.slice(0, MAX_WORLD_ROWS);

        const picked = getWorldPicked();

        if (total === 0) {
            box.innerHTML = '<div class="aiiw-hint">没有匹配的条目。'
                + (enabledOnly ? '可以试试取消勾选「只看启用中」，或者换个搜索词。' : '换个搜索词试试。')
                + '</div>';
        } else {
            box.innerHTML = rows.map(function (e) {
                const meta = e.chars + ' 字'
                    + (e.constant ? ' · 常驻' : '')
                    + (e.disabled ? ' · 已禁用' : '')
                    + (e.keys.length ? ' · 键：' + oneLine(e.keys.join('/'), 24) : '');
                return entryRowHtml({
                    kind: 'world',
                    key: e.uid,
                    name: e.name,
                    meta: meta,
                    content: e.content,
                    checked: picked.indexOf(e.uid) !== -1,
                    dim: e.disabled,
                });
            }).join('');
        }

        cache.worldFiltered = { total: total, truncated: truncated };
        updateWorldStat();
    }

    /** 只更新统计行，不重渲染列表（勾选时用，避免滚动位置丢失） */
    function updateWorldStat() {
        const stat = document.getElementById('aiiw-world-stat');
        if (!stat || !cfg) return;
        const f = cache.worldFiltered;
        if (!f) { stat.textContent = ''; return; }
        const picked = getWorldPicked();
        const all = cache.worldEntries[cfg.worldBook] || [];
        let chars = 0;
        all.forEach(function (e) { if (picked.indexOf(e.uid) !== -1) chars += e.chars; });

        // 其他书上的勾选也会一起生效，明确告诉用户一句
        let otherBooks = 0;
        Object.keys(cfg.worldPickedMap).forEach(function (b) {
            if (b === cfg.worldBook) return;
            const uids = cfg.worldPickedMap[b];
            if (Array.isArray(uids) && uids.length) otherBooks += 1;
        });

        stat.textContent = '共 ' + f.total + ' 条'
            + (f.truncated ? '（只显示前 ' + MAX_WORLD_ROWS + ' 条，用搜索缩小范围）' : '')
            + ' · 本书已勾选 ' + picked.length + ' 条 / 约 ' + chars + ' 字'
            + (otherBooks ? ' · 另有 ' + otherBooks + ' 本书的勾选也会一起生效' : '');
    }

    /* ---------- 条目行（预设 / 世界书共用） ---------- */

    function entryRowHtml(o) {
        const cls = 'aiiw-entry' + (o.dim ? ' aiiw-dim' : '');
        const badge = o.badge
            ? '<span class="aiiw-badge">' + escapeHtml(o.badge) + '</span>'
            : '';
        return '<div class="' + cls + '">'
            + '<label class="aiiw-entry-head">'
            +   '<input type="checkbox" class="aiiw-entry-cb" data-kind="' + escapeHtml(o.kind)
            +     '" data-key="' + escapeHtml(o.key) + '"' + (o.checked ? ' checked' : '') + '>'
            +   '<span class="aiiw-entry-name">' + escapeHtml(o.name) + '</span>'
            +   badge
            +   '<span class="aiiw-entry-meta">' + escapeHtml(o.meta) + '</span>'
            + '</label>'
            + '<div class="aiiw-entry-preview">' + escapeHtml(oneLine(o.content, 400)) + '</div>'
            + '</div>';
    }

    function setEntryListHtml(id, html) {
        const box = document.getElementById(id);
        if (box) box.innerHTML = html;
    }

    /* ========================================================================
     * 14. 渲染：仿写样本楼层
     * ====================================================================== */

    function refreshMimicSource() {
        if (!cfg) return;
        const sel = document.getElementById('aiiw-mimic-floor');
        if (!sel) return;

        const floors = refreshFloors();
        const on = document.getElementById('aiiw-mimic-on');
        if (on) on.checked = !!cfg.mimicEnabled;

        if (floors.length === 0) {
            sel.innerHTML = '<option value="-1">（当前聊天还没有消息）</option>';
            updateMimicPreview();
            return;
        }

        // 默认选最后一条 AI 回复（跳过隐藏楼层，隐藏的多半不是用户想学的那条）
        if (cfg.mimicFloor == null || cfg.mimicFloor < 0
            || !floors.some(function (f) { return f.id === cfg.mimicFloor; })) {
            const rev = floors.slice().reverse();
            const lastAI = rev.find(function (f) { return !f.isUser && !f.hidden; })
                || rev.find(function (f) { return !f.hidden; });
            cfg.mimicFloor = lastAI ? lastAI.id : floors[floors.length - 1].id;
            saveConfig();
        }

        sel.innerHTML = floors.map(function (f) {
            const tag = f.isUser ? '我' : f.name;
            const hid = f.hidden ? '[隐藏] ' : '';
            return '<option value="' + f.id + '">'
                + '#' + f.id + '  ' + escapeHtml(tag) + '：'
                + escapeHtml(oneLine(f.text, 26))
                + (f.hidden ? ' [隐藏]' : '')
                + '</option>';
        }).join('');
        sel.value = String(cfg.mimicFloor);

        updateMimicPreview();
    }

    function getMimicFloor() {
        if (!cfg || cfg.mimicFloor == null || cfg.mimicFloor < 0) return null;
        const floors = cache.floors || refreshFloors();
        return floors.find(function (f) { return f.id === cfg.mimicFloor; }) || null;
    }

    function updateMimicPreview() {
        const box = document.getElementById('aiiw-mimic-preview');
        if (!box || !cfg) return;

        if (!cfg.mimicEnabled) {
            box.textContent = '未启用。启用后 AI 只学选中楼层的语感，不抄它的内容。';
            return;
        }

        const f = getMimicFloor();
        if (!f) {
            box.textContent = '还没选楼层。';
            return;
        }

        const len = f.text.length;
        const note = (f.cleaned && f.rawLen > len)
            ? '清洗掉 ' + (f.rawLen - len) + ' 字，剩 ' + len + ' 字'
            : len + ' 字';

        box.textContent = '样本 #' + f.id
            + (f.hidden ? '（隐藏楼层）' : '')
            + '（' + note + '）：'
            + oneLine(f.text, 90);
    }

    /* ========================================================================
     * 15. 字数统计显示
     * ====================================================================== */

    function updateCountDisplay() {
        const el = document.getElementById('aiiw-count');
        if (!el || !cfg) return;

        const text = (document.getElementById('aiiw-result') || {}).value || '';
        const n = countWords(text);
        const lo = Number(cfg.minWords) || 0;
        const hi = Number(cfg.maxWords) || 0;

        let cls = '';
        let note = '';

        if (n === 0) {
            cls = '';
            note = '尚未生成';
        } else if (hi > 0 && n > hi) {
            cls = 'aiiw-high';
            note = '超出上限';
        } else if (lo > 0 && n < lo) {
            cls = 'aiiw-low';
            note = '低于下限';
        } else {
            cls = 'aiiw-ok';
            note = '范围内';
        }

        el.className = cls;
        el.textContent = '当前字数：' + n + '  ·  目标 ' + lo + ' - ' + hi + '  ·  ' + note;
    }

    /* ========================================================================
     * 16. 错误提示 / 忙碌状态
     * ====================================================================== */

    function showError(msg) {
        const el = document.getElementById('aiiw-error');
        if (!el) return;
        el.textContent = String(msg || '');
        el.classList.remove('aiiw-hidden');
    }

    function clearError() {
        const el = document.getElementById('aiiw-error');
        if (!el) return;
        el.textContent = '';
        el.classList.add('aiiw-hidden');
    }

    function setBusy(busy) {
        state.busy = busy;
        ['aiiw-generate', 'aiiw-regen', 'aiiw-inject'].forEach(function (id) {
            const el = document.getElementById(id);
            if (el) el.disabled = busy;
        });
        const tip = document.getElementById('aiiw-generating');
        if (tip) tip.classList.toggle('aiiw-visible', busy);
    }

    /* ========================================================================
     * 17. 上下文收集
     * ====================================================================== */

    function collectContext() {
        if (!cfg || cfg.ctxMode === 'none') return '';

        const ctx = getCtx();
        if (!ctx || !Array.isArray(ctx.chat)) return '';

        // 先过滤出有效消息
        const cleaned = [];
        for (let i = 0; i < ctx.chat.length; i++) {
            const m = ctx.chat[i];
            if (m.is_system === true) continue;
            if (m.is_hidden === true) continue;
            if (m.role === 'system') continue;
            // 清洗在过滤之后做：清洗前为空的楼层直接跳过
            const raw = getMessageText(m).trim();
            if (!raw) continue;
            const text = cleanMessageText(raw);
            if (!text) continue;
            cleaned.push({
                name: m.name || (isUserMessage(m) ? '我' : '角色'),
                text: text,
            });
        }
        if (cleaned.length === 0) return '';

        // 再取最近 N 条（先过滤再切片）
        let picked = cleaned;
        if (cfg.ctxMode !== 'all') {
            const n = Math.max(1, Number(cfg.ctxN) || 20);
            picked = cleaned.slice(-n);
        }

        // 单条截断
        picked = picked.map(function (m) {
            return {
                name: m.name,
                text: m.text.length > PER_MSG_LIMIT
                    ? m.text.slice(0, PER_MSG_LIMIT) + '…'
                    : m.text,
            };
        });

        // 总长上限，超出从最旧的丢
        let total = picked.reduce(function (n, m) {
            return n + m.name.length + m.text.length + 4;
        }, 0);
        while (total > TOTAL_LIMIT && picked.length > 1) {
            const removed = picked.shift();
            total -= (removed.name.length + removed.text.length + 4);
        }

        return picked.map(function (m) {
            return m.name + ': ' + m.text;
        }).join('\n\n');
    }

    /* ========================================================================
     * 18. Prompt 组装
     * ====================================================================== */

    /* 生成前确保勾选的数据源已经加载好。
       场景：用户上次勾了条目，重开酒馆后直奔「生成」——那时缓存是空的，
       勾选的条目会静默丢失。这里补上。 */
    async function ensureStyleSourcesLoaded() {
        if (!cfg) return;
        // 预设条目：同步就能取到，所有勾过的预设都过一遍
        Object.keys(cfg.presetPickedMap).forEach(function (name) {
            loadPresetEntries(name, false);
        });
        loadPresetEntries(cfg.presetName, false);

        // 世界书条目：所有勾过条目的书都要读
        const books = Object.keys(cfg.worldPickedMap).filter(function (b) {
            const uids = cfg.worldPickedMap[b];
            return Array.isArray(uids) && uids.length > 0;
        });
        const jobs = books
            .filter(function (b) { return !cache.worldEntries[b]; })
            .map(function (b) {
                return loadWorldEntries(b, false).catch(function () { return []; });
            });
        if (jobs.length) {
            try { await Promise.all(jobs); } catch (e) { /* 拿不到就当没勾，不阻塞生成 */ }
        }
    }

    /** 汇总当前勾选的全部文风来源 */
    function collectStyleSelections() {
        const parts = [];

        // A. 内置风格
        const builtin = cfg.styles.filter(function (s) {
            return cfg.activeStyleIds.includes(s.id);
        });
        builtin.forEach(function (s) {
            parts.push({ label: '内置风格「' + s.name + '」', content: String(s.desc || '').trim() });
        });

        // B. 预设条目（所有勾过条目的预设都会生效，不只是当前浏览的这一本）
        Object.keys(cfg.presetPickedMap).forEach(function (presetName) {
            const ids = cfg.presetPickedMap[presetName];
            if (!Array.isArray(ids) || ids.length === 0) return;
            const all = loadPresetEntries(presetName, false);
            all.forEach(function (e) {
                if (ids.indexOf(e.id) !== -1) {
                    parts.push({
                        label: '预设「' + (presetName || '当前预设') + '」条目「' + e.name + '」',
                        content: substitute(e.content),
                        heavy: true,
                    });
                }
            });
        });

        // C. 世界书条目（所有勾过条目的世界书都会生效，不只是当前这本）
        Object.keys(cfg.worldPickedMap).forEach(function (book) {
            const uids = cfg.worldPickedMap[book];
            if (!Array.isArray(uids) || uids.length === 0) return;
            const all = cache.worldEntries[book] || [];
            all.forEach(function (e) {
                if (uids.indexOf(e.uid) !== -1) {
                    parts.push({
                        label: '世界书「' + book + '」条目「' + e.name + '」',
                        content: substitute(e.content),
                        heavy: true,
                    });
                }
            });
        });

        return parts.filter(function (p) { return p.content; });
    }

    function buildStyleSection() {
        const all = collectStyleSelections();
        if (all.length === 0) return '';

        // 太长就按顺序砍尾，别把上下文撑爆
        const picked = [];
        let chars = 0;
        let dropped = 0;
        all.forEach(function (p) {
            if (chars + p.content.length > STYLE_CHAR_LIMIT) { dropped += 1; return; }
            picked.push(p);
            chars += p.content.length;
        });
        if (picked.length === 0) {
            picked.push(all[0]);
            chars = all[0].content.length;
            dropped = all.length - 1;
        }

        const blocks = picked.map(function (p) {
            if (!p.heavy) {
                return '· ' + p.label + '：' + p.content;
            }
            return '· ' + p.label + '：\n' + p.content;
        });

        let text = blocks.join('\n\n');
        text += '\n\n严格按上述文风写作。若多条要求冲突，以位置更靠前的为准，不要让它们互相抵消。';

        if (dropped > 0) {
            text += '\n（注：另有 ' + dropped + ' 条文风素材太长被省略了，请以已给出的为准。）';
        } else if (chars > 6000) {
            text += '\n（注：本次文风要求较长，请优先保证语感一致，不必逐条复述要求。）';
        }
        return '【文风要求】\n' + text;
    }

    function buildMimicSection() {
        if (!cfg.mimicEnabled) return '';
        const f = getMimicFloor();
        if (!f) return '';

        return '【仿写样本】\n'
            + '下面这段文字是用户指定的语感范本（来自当前聊天）。请学习它的句式节奏、用词习惯、'
            + '描写密度与标点风格，写出风格一致但内容全新的文字。\n'
            + '不要复用范本里的情节、人物名或原句。\n\n'
            + '--- 范本开始 ---\n'
            + f.text
            + '\n--- 范本结束 ---';
    }

    function buildSystemPrompt() {
        let sys = String(cfg.systemPrompt || DEFAULT_SYSTEM_PROMPT).trim();
        if (cfg.ctxMode === 'none') {
            sys += '\n\n本次没有提供聊天上下文，请只根据用户的想法扩写。';
        }
        if (cfg.mimicEnabled) {
            sys += '\n\n本次提供了一段仿写范本，只学它的语感，不要抄它的内容。';
        }
        return sys;
    }

    function buildUserPrompt(intent) {
        const parts = [];

        const ctxText = collectContext();
        if (ctxText) {
            parts.push('【当前剧情上下文】\n' + ctxText);
        }

        const mimic = buildMimicSection();
        if (mimic) parts.push(mimic);

        const style = buildStyleSection();
        if (style) parts.push(style);

        parts.push('【字数要求】\n' + cfg.minWords + ' - ' + cfg.maxWords + ' 字');
        parts.push('【我的想法】\n' + intent);

        return parts.join('\n\n');
    }

    /* ========================================================================
     * 19. 生成：两种模式
     * ====================================================================== */

    /** 模式 A：沿用酒馆当前主 API。零配置、无跨域、不写聊天记录。 */
    async function genViaTavern(sys, usr) {
        const ctx = getCtx();
        if (!ctx || typeof ctx.generateRaw !== 'function') {
            throw new Error('当前酒馆版本没有可用的 generateRaw，请改用「自填 API」模式。');
        }
        // 保证输出长度够用（中文 1 字约 1.5~2 token）
        const need = Math.ceil((Number(cfg.maxWords) || 600) * 2.5);
        const responseLength = Math.max(Number(cfg.maxTokens) || 0, need);

        const out = await ctx.generateRaw({
            systemPrompt: sys,
            prompt: usr,
            responseLength: responseLength,
        });
        return out;
    }

    /* ========================================================================
     * API 方案 · 取模型 · 测试连接
     *
     *   取模型：  GET {endpoint 去掉 /chat/completions}/models
     *   测试连接：先试 /models（免费、快，同时验证地址和 Key）；
     *            接口不提供 /models 时，退回发一次最小对话请求（max_tokens 8）
     *   方案：    endpoint / key / model / 参数 存成命名方案；
     *            表单改动自动写回当前方案（方案是「活」的，不用再点一次保存）
     * ====================================================================== */

    /** 从 Endpoint 推导模型列表地址：把结尾的 /chat/completions 换成 /models */
    function modelsEndpoint(ep) {
        let e = String(ep == null ? '' : ep).trim().replace(/\/+$/, '');
        if (!e) return '';
        if (/\/chat\/completions$/i.test(e)) return e.replace(/\/chat\/completions$/i, '/models');
        if (/\/completions$/i.test(e)) return e.replace(/\/completions$/i, '/models');
        return e + '/models';
    }

    /** 按当前设置决定直连还是走酒馆代理 */
    function apiUrl(url) {
        return (cfg && cfg.useProxy) ? '/proxy/' + url : url;
    }

    /** 带超时的 fetch（浏览器对 CORS 失败只会给一个笼统的 TypeError，所以统一包装） */
    async function fetchWithTimeout(url, options, timeoutMs) {
        const ctrl = new AbortController();
        const timer = setTimeout(function () { ctrl.abort(); }, timeoutMs || 30000);
        try {
            return await fetch(url, Object.assign({}, options || {}, { signal: ctrl.signal }));
        } finally {
            clearTimeout(timer);
        }
    }

    function describeFetchError(err) {
        if (err && err.name === 'AbortError') return '请求超时。';
        const raw = err && err.message ? err.message : String(err);
        return '请求发不出去 —— 可能是地址写错、跨域被拦，或网络不通。（' + raw + '）';
    }

    /** 勾了代理却拿到 404，八成是酒馆的 enableCorsProxy 还没开 */
    function proxyDisabledHint(status) {
        if (cfg && cfg.useProxy && status === 404) {
            return '　【勾了「走酒馆代理」却收到 404】通常是酒馆的 CORS 代理没开：'
                + '把 config.yaml 里的 enableCorsProxy 改成 true 后重启酒馆。'
                + '如果地址本身写错了也会是 404，两个都看一眼。';
        }
        return '';
    }

    /* ---------------- 方案管理 ---------------- */

    function listProfiles() {
        return (cfg && Array.isArray(cfg.apiProfiles)) ? cfg.apiProfiles : [];
    }

    function findProfile(id) {
        return listProfiles().find(function (p) { return p.id === id; }) || null;
    }

    /** 从当前配置读出一套 API 参数 */
    function readApiForm() {
        return {
            endpoint: String(cfg.endpoint || ''),
            apiKey: String(cfg.apiKey || ''),
            model: String(cfg.model || ''),
            temperature: Number(cfg.temperature) || 0.8,
            maxTokens: Number(cfg.maxTokens) || 2000,
            useProxy: !!cfg.useProxy,
        };
    }

    /** 表单改动 → 写回当前选中的方案（仅当关联了方案时） */
    function syncActiveProfile() {
        if (!cfg || !cfg.activeProfile) return;
        const p = findProfile(cfg.activeProfile);
        if (!p) return;
        Object.assign(p, readApiForm());
        saveConfig();
    }

    function renderProfileSelect() {
        const sel = document.getElementById('aiiw-profile-sel');
        if (!sel || !cfg) return;

        let html = '<option value="">（当前配置 · 未关联方案）</option>';
        listProfiles().forEach(function (p) {
            html += '<option value="' + escapeHtml(p.id) + '">' + escapeHtml(p.name) + '</option>';
        });
        sel.innerHTML = html;
        sel.value = cfg.activeProfile || '';
        if (sel.value !== (cfg.activeProfile || '')) sel.value = '';

        const del = document.getElementById('aiiw-profile-del');
        if (del) del.style.display = cfg.activeProfile ? '' : 'none';
    }

    /** 把某个方案的内容填进表单 */
    function applyProfile(id) {
        if (!cfg) return;
        const p = findProfile(id);
        cfg.activeProfile = p ? id : '';

        if (p) {
            cfg.endpoint = p.endpoint || '';
            cfg.apiKey = p.apiKey || '';
            cfg.model = p.model || '';
            cfg.temperature = (p.temperature != null) ? p.temperature : 0.8;
            cfg.maxTokens = (p.maxTokens != null) ? p.maxTokens : 2000;
            cfg.useProxy = !!p.useProxy;
        }
        saveConfig();

        setValue('aiiw-set-endpoint', cfg.endpoint);
        setValue('aiiw-set-apikey', cfg.apiKey);
        setValue('aiiw-set-temp', cfg.temperature);
        setValue('aiiw-set-maxtokens', cfg.maxTokens);
        setChecked('aiiw-set-proxy', cfg.useProxy);
        resetModelPick(cfg.model);
        clearTestResult();
        renderProfileSelect();
    }

    function onSaveProfile() {
        if (!cfg) return;
        const form = readApiForm();
        if (!form.endpoint.trim()) {
            setTestResult('✗ 先填 Endpoint 再存方案。', 'err');
            return;
        }
        const suggested = form.model || ('方案 ' + (listProfiles().length + 1));
        let name;
        try {
            name = window.prompt('给这套 API 配置起个名字：', suggested);
        } catch (e) {
            name = suggested;   // 极少数环境禁用了 prompt，退回建议名
        }
        if (name == null) return;
        const trimmed = String(name).trim();
        if (!trimmed) return;

        const p = Object.assign({
            id: 'p' + Date.now() + Math.random().toString(36).slice(2, 6),
            name: trimmed,
        }, form);
        cfg.apiProfiles.push(p);
        cfg.activeProfile = p.id;
        saveConfig();
        renderProfileSelect();
        setTestResult('已存为「' + trimmed + '」', 'ok');
    }

    function onDeleteProfile() {
        if (!cfg || !cfg.activeProfile) return;
        const p = findProfile(cfg.activeProfile);
        if (!p) return;
        try {
            if (!window.confirm('删除方案「' + p.name + '」？\n当前填的这套配置会保留，只是不再关联方案。')) return;
        } catch (e) { /* 环境不支持 confirm：用户既然点了删除，就按确认处理 */ }
        const removing = cfg.activeProfile;
        cfg.apiProfiles = listProfiles().filter(function (x) { return x.id !== removing; });
        cfg.activeProfile = '';
        saveConfig();
        renderProfileSelect();
        clearTestResult();
    }

    /* ---------------- 取模型 ---------------- */

    /** 收起模型下拉，回到手动输入 */
    function resetModelPick(modelValue) {
        const input = document.getElementById('aiiw-set-model');
        const sel = document.getElementById('aiiw-model-sel');
        const btn = document.getElementById('aiiw-fetch-models');
        if (input) {
            input.classList.remove('aiiw-hidden');
            if (modelValue != null) input.value = modelValue;
        }
        if (sel) {
            sel.classList.add('aiiw-hidden');
            sel.innerHTML = '';
        }
        if (btn) btn.textContent = '取模型';
    }

    /** GET {base}/models */
    async function fetchModelList() {
        if (!cfg) throw new Error('扩展还没初始化完。');
        const ep = String(cfg.endpoint || '').trim();
        if (!ep) throw new Error('先填 Endpoint。');
        if (!String(cfg.apiKey || '').trim()) throw new Error('先填 API Key。');

        let res;
        try {
            res = await fetchWithTimeout(apiUrl(modelsEndpoint(ep)), {
                method: 'GET',
                headers: { 'Authorization': 'Bearer ' + String(cfg.apiKey).trim() },
            }, 30000);
        } catch (err) {
            throw new Error(describeFetchError(err));
        }

        if (res.status === 401 || res.status === 403) {
            const e = new Error('API Key 无效或没有权限（HTTP ' + res.status + '）。');
            e.status = res.status;
            throw e;
        }
        if (!res.ok) {
            const e = new Error('这个接口没有返回模型列表（HTTP ' + res.status + '）。'
                + proxyDisabledHint(res.status));
            e.status = res.status;
            throw e;
        }

        let data;
        try {
            data = await res.json();
        } catch (e) {
            const err = new Error('模型接口返回的不是合法 JSON。');
            err.status = 200;
            throw err;
        }

        const raw = (data && (data.data || data.models || data.result)) || [];
        const ids = [];
        if (Array.isArray(raw)) {
            raw.forEach(function (m) {
                const id = (typeof m === 'string') ? m : (m && (m.id || m.name));
                if (id) ids.push(String(id));
            });
        }
        if (!ids.length) {
            const e = new Error('接口连上了，但它没返回任何模型。');
            e.status = 200;
            throw e;
        }
        return ids.sort();
    }

    async function onFetchModels() {
        const btn = document.getElementById('aiiw-fetch-models');
        const sel = document.getElementById('aiiw-model-sel');
        const input = document.getElementById('aiiw-set-model');
        if (!btn || !sel || !input || !cfg) return;
        if (btn.dataset.busy === '1') return;
        btn.dataset.busy = '1';
        btn.textContent = '拉取中…';

        try {
            const models = await fetchModelList();

            let options = models.map(function (m) {
                return '<option value="' + escapeHtml(m) + '">' + escapeHtml(m) + '</option>';
            }).join('');
            options += '<option value="">✎ 手动输入</option>';
            sel.innerHTML = options;

            // 当前 model 在列表里就沿用，否则取第一个
            let pick = models.indexOf(String(cfg.model || '').trim());
            if (pick === -1) pick = 0;
            sel.value = models[pick];

            cfg.model = models[pick];
            input.value = models[pick];
            syncActiveProfile();
            saveConfig();

            sel.classList.remove('aiiw-hidden');
            input.classList.add('aiiw-hidden');
            btn.textContent = models.length + ' 个模型';
            clearTestResult();
        } catch (err) {
            btn.textContent = '取模型';
            setTestResult('✗ ' + (err && err.message ? err.message : String(err)), 'err');
        } finally {
            btn.dataset.busy = '0';
        }
    }

    /* ---------------- 测试连接 ---------------- */

    function setTestResult(text, kind) {
        const el = document.getElementById('aiiw-test-result');
        if (!el) return;
        el.textContent = text || '';
        el.className = 'aiiw-test' + (kind ? ' aiiw-' + kind : '');
    }

    function clearTestResult() {
        setTestResult('', '');
    }

    /** 最小对话请求：验证 endpoint + key + model 三者都对 */
    async function testMinimalChat() {
        const model = String(cfg.model || '').trim();
        if (!model) throw new Error('先填 Model。');

        let res;
        try {
            res = await fetchWithTimeout(apiUrl(String(cfg.endpoint).trim()), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + String(cfg.apiKey).trim(),
                },
                body: JSON.stringify({
                    model: model,
                    messages: [{ role: 'user', content: 'hi' }],
                    max_tokens: 8,
                    stream: false,
                }),
            }, 45000);
        } catch (err) {
            throw new Error(describeFetchError(err));
        }

        if (res.status === 401 || res.status === 403) {
            throw new Error('API Key 无效或没有权限（HTTP ' + res.status + '）。');
        }
        if (!res.ok) {
            let extra = '';
            try {
                const j = await res.json();
                if (j && j.error && j.error.message) extra = '：' + j.error.message;
            } catch (e) { /* 响应体不是 JSON，忽略 */ }
            throw new Error('对话接口返回 HTTP ' + res.status + extra + proxyDisabledHint(res.status));
        }
        return true;
    }

    async function testConnection() {
        if (!cfg) throw new Error('扩展还没初始化完。');
        if (!String(cfg.endpoint || '').trim()) throw new Error('先填 Endpoint。');
        if (!String(cfg.apiKey || '').trim()) throw new Error('先填 API Key。');

        try {
            const models = await fetchModelList();
            return '✓ 连接正常，这个接口有 ' + models.length + ' 个模型可用。';
        } catch (err) {
            const st = err && err.status;
            if (st === 401 || st === 403) throw err;        // Key 的问题，重试也没用
            if (st && st >= 400 && st < 500) {              // 接口不提供 /models → 退回真实对话
                await testMinimalChat();
                return '✓ 连接正常（该接口不提供模型列表）。';
            }
            throw err;
        }
    }

    async function onTestApi() {
        const btn = document.getElementById('aiiw-test-api');
        if (!btn || btn.dataset.busy === '1') return;
        btn.dataset.busy = '1';
        setTestResult('测试中…', '');
        try {
            setTestResult(await testConnection(), 'ok');
        } catch (err) {
            setTestResult('✗ ' + (err && err.message ? err.message : String(err)), 'err');
        } finally {
            btn.dataset.busy = '0';
        }
    }

    /** 模式 B：自填 OpenAI 兼容 API。可走酒馆 /proxy 绕开 CORS。 */
    async function genViaCustom(sys, usr) {
        if (!cfg.endpoint || !cfg.endpoint.trim()) throw new Error('请先在「设置」里填写 API Endpoint。');
        if (!cfg.apiKey || !cfg.apiKey.trim()) throw new Error('请先在「设置」里填写 API Key。');
        if (!cfg.model || !cfg.model.trim()) throw new Error('请先在「设置」里填写 Model。');

        const url = cfg.useProxy ? '/proxy/' + cfg.endpoint.trim() : cfg.endpoint.trim();

        const ctrl = new AbortController();
        state.abort = ctrl;
        const timer = setTimeout(function () { ctrl.abort(); }, 120000);

        let res;
        try {
            res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + cfg.apiKey.trim(),
                },
                body: JSON.stringify({
                    model: cfg.model.trim(),
                    messages: [
                        { role: 'system', content: sys },
                        { role: 'user', content: usr },
                    ],
                    temperature: Number(cfg.temperature) || 0.8,
                    max_tokens: Number(cfg.maxTokens) || 2000,
                    stream: false,
                }),
                signal: ctrl.signal,
            });
        } catch (err) {
            if (err && err.name === 'AbortError') {
                throw new Error('请求超时（超过 120 秒）。');
            }
            const raw = err && err.message ? err.message : String(err);
            throw new Error(
                '请求在浏览器这一层就没发出去。常见三种原因，按顺序排查：\n'
                + '1) Endpoint 写错或写不全 —— 必须是完整地址，到 /chat/completions 结尾；\n'
                + '2) 该 API 不允许浏览器直连（跨域）—— 把酒馆 config.yaml 的 enableCorsProxy 改成 true，'
                + '重启酒馆后再勾选「走酒馆代理」；\n'
                + '3) 网络不通 —— 手机所在网络访问不到这个地址。\n'
                + '原始错误：' + raw
            );
        } finally {
            clearTimeout(timer);
            state.abort = null;
        }

        if (!res.ok) {
            if (res.status === 404 && cfg.useProxy) {
                throw new Error(
                    '酒馆的 CORS 代理没有开启。\n'
                    + '请在酒馆根目录的 config.yaml 里设置 enableCorsProxy: true（或用 --corsProxy 启动），然后重启酒馆。'
                );
            }
            if (res.status === 401 || res.status === 403) {
                throw new Error('API Key 无效或没有权限（HTTP ' + res.status + '）。');
            }
            if (res.status === 429) {
                throw new Error('请求过于频繁，请稍后重试（HTTP 429）。');
            }
            if (res.status >= 500) {
                throw new Error('API 服务端错误（HTTP ' + res.status + '）。');
            }
            throw new Error('API 请求失败（HTTP ' + res.status + '）。');
        }

        let data;
        try {
            data = await res.json();
        } catch (e) {
            throw new Error('AI 返回的数据格式无法识别（不是合法 JSON）。');
        }

        const text = data && data.choices && data.choices[0]
            && data.choices[0].message && data.choices[0].message.content;

        if (!text || !String(text).trim()) {
            throw new Error('AI 没有返回有效内容。');
        }
        return text;
    }

    /** 清理模型输出：去代码块包裹、去开场客套、去整体引号。不做机械截断。 */
    function cleanOutput(raw) {
        let t = String(raw == null ? '' : raw).trim();

        // 去掉最外层 ``` 包裹
        const fence = t.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/);
        if (fence) t = fence[1].trim();

        // 去掉开场客套（只在开头、且后面紧跟换行或冒号时才动）
        t = t.replace(/^(好的|明白了|没问题|以下是|这是)[^\n]{0,20}[:：]\s*\n?/, '');

        // 去掉整体包裹的成对引号
        if (/^["“「『][\s\S]*["”」』]$/.test(t)) {
            t = t.slice(1, -1).trim();
        }

        return t.trim();
    }

    async function generate() {
        if (state.busy) return;
        if (!cfg) return;

        const intentEl = document.getElementById('aiiw-intent');
        const intent = (intentEl ? intentEl.value : '').trim();
        if (!intent) {
            showError('请先写下你想写的内容，一句话就够了。');
            return;
        }

        clearError();
        setBusy(true);

        // 记住发起时的聊天，生成回来时比对
        const ctx0 = getCtx();
        let chatIdAtStart = null;
        try {
            chatIdAtStart = ctx0 && typeof ctx0.getCurrentChatId === 'function'
                ? ctx0.getCurrentChatId() : null;
        } catch (e) { /* 忽略 */ }

        try {
            await ensureStyleSourcesLoaded();

            const sys = buildSystemPrompt();
            const usr = buildUserPrompt(intent);

            const raw = cfg.apiMode === 'custom'
                ? await genViaCustom(sys, usr)
                : await genViaTavern(sys, usr);

            const text = cleanOutput(raw);

            if (!text) {
                throw new Error('AI 没有返回有效内容。');
            }

            const resultEl = document.getElementById('aiiw-result');
            if (resultEl) resultEl.value = text;
            updateCountDisplay();

            // 生成期间用户换了聊天 → 提醒
            const ctx1 = getCtx();
            let chatIdNow = null;
            try {
                chatIdNow = ctx1 && typeof ctx1.getCurrentChatId === 'function'
                    ? ctx1.getCurrentChatId() : null;
            } catch (e) { /* 忽略 */ }

            if (chatIdAtStart && chatIdNow && chatIdAtStart !== chatIdNow) {
                showError('提示：生成期间聊天发生了切换，这段结果可能和当前剧情对不上。');
            }
        } catch (err) {
            showError(err && err.message ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    /* ========================================================================
     * 20. 注入输入框
     *
     *      只写值 + 派发 input 事件。绝不点发送按钮、绝不派发 Enter。
     *      依据：酒馆自己的 slash-commands.js 就是这么同步输入框的。
     * ====================================================================== */

    function injectToInput() {
        const resultEl = document.getElementById('aiiw-result');
        const text = resultEl ? resultEl.value : '';

        if (!text || !text.trim()) {
            showError('结果区是空的，没有内容可以注入。');
            return;
        }

        const target = document.getElementById('send_textarea');
        if (!target) {
            showError('找不到酒馆的输入框（#send_textarea）。');
            return;
        }

        target.value = text;
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.focus();

        clearError();

        /* 注意：此处绝不调用 $('#send_but').click() 或任何发送函数。
           用户需要自己按发送。 */
    }

    /* ========================================================================
     * 21. UI ↔ 配置同步
     * ====================================================================== */

    function setValue(id, val) {
        const el = document.getElementById(id);
        if (el) el.value = val;
    }

    function setChecked(id, val) {
        const el = document.getElementById(id);
        if (el) el.checked = !!val;
    }

    function syncUiToConfig() {
        if (!cfg) return;

        setValue('aiiw-intent', cfg.lastIntent || '');
        setValue('aiiw-min', cfg.minWords);
        setValue('aiiw-max', cfg.maxWords);
        setValue('aiiw-ctx-n', cfg.ctxN);
        setValue('aiiw-ctx-mode', cfg.ctxMode);

        // 字数预设联动
        const preset = document.getElementById('aiiw-len-preset');
        if (preset) {
            const key = cfg.minWords + '-' + cfg.maxWords;
            const has = Array.prototype.some.call(preset.options, function (o) { return o.value === key; });
            preset.value = has ? key : 'custom';
        }

        syncCtxNLimit();

        setValue('aiiw-set-apimode', cfg.apiMode);
        setValue('aiiw-set-endpoint', cfg.endpoint);
        setValue('aiiw-set-apikey', cfg.apiKey);
        setValue('aiiw-set-model', cfg.model);
        setValue('aiiw-set-temp', cfg.temperature);
        setValue('aiiw-set-maxtokens', cfg.maxTokens);
        setChecked('aiiw-set-proxy', cfg.useProxy);
        resetModelPick(cfg.model);
        renderProfileSelect();
        setValue('aiiw-set-sysprompt', cfg.systemPrompt);

        setChecked('aiiw-preset-onlystyle', cfg.presetOnlyStyle);
        setChecked('aiiw-world-enabled', cfg.worldEnabledOnly);
        setChecked('aiiw-mimic-on', cfg.mimicEnabled);

        setChecked('aiiw-clean-on', cfg.ctxClean !== false);
        setValue('aiiw-clean-keep', cfg.ctxKeepTags || '');
        setValue('aiiw-clean-drop', cfg.ctxDropTags || '');

        syncCustomBlockVisibility();
        renderTabs();
    }

    function syncCustomBlockVisibility() {
        const block = document.getElementById('aiiw-custom-block');
        const mode = (document.getElementById('aiiw-set-apimode') || {}).value;
        if (block) block.style.display = (mode === 'custom') ? 'flex' : 'none';
    }

    function syncCtxNLimit() {
        const mode = (document.getElementById('aiiw-ctx-mode') || {}).value;
        const nEl = document.getElementById('aiiw-ctx-n');
        const label = document.getElementById('aiiw-ctx-n-label');
        const show = (mode === 'recent');
        if (nEl) nEl.style.display = show ? '' : 'none';
        if (label) label.style.display = show ? '' : 'none';
    }

    /* ========================================================================
     * 22. 事件绑定
     * ====================================================================== */

    function bindEvents() {
        const root = document.getElementById('aiiw-panel');
        if (!root || root.dataset.aiiwBound === '1') return;
        root.dataset.aiiwBound = '1';

        const q = function (id) { return document.getElementById(id); };

        /* --- 面板开关 --- */
        root.querySelector('.aiiw-mask').addEventListener('click', function () {
            // 点遮罩不关闭，避免误触丢草稿。用户用右上角按钮关。
        });
        q('aiiw-minimize').addEventListener('click', function () { setPanelState('minimized'); });
        q('aiiw-close').addEventListener('click', function () { setPanelState('closed'); });

        const minibar = document.getElementById('aiiw-minibar');
        if (minibar) {
            minibar.addEventListener('click', function () { openPanel(); });
        }

        /* --- 意图输入：实时记住 --- */
        q('aiiw-intent').addEventListener('input', function () {
            if (cfg) { cfg.lastIntent = this.value; saveConfig(); }
        });

        /* --- 字数 --- */
        function onLenChange() {
            if (!cfg) return;
            cfg.minWords = Math.max(0, Number(q('aiiw-min').value) || 0);
            cfg.maxWords = Math.max(0, Number(q('aiiw-max').value) || 0);
            saveConfig();
            updateCountDisplay();
        }
        q('aiiw-min').addEventListener('change', onLenChange);
        q('aiiw-max').addEventListener('change', onLenChange);

        q('aiiw-len-preset').addEventListener('change', function () {
            if (this.value === 'custom') return;
            const parts = this.value.split('-');
            q('aiiw-min').value = parts[0];
            q('aiiw-max').value = parts[1];
            onLenChange();
        });

        /* --- 上下文 --- */
        q('aiiw-ctx-mode').addEventListener('change', function () {
            if (cfg) { cfg.ctxMode = this.value; saveConfig(); }
            syncCtxNLimit();
        });
        q('aiiw-ctx-n').addEventListener('change', function () {
            if (cfg) { cfg.ctxN = Math.max(1, Number(this.value) || 20); saveConfig(); }
        });

        /* --- 标签页 --- */
        root.querySelector('.aiiw-tabs').addEventListener('click', function (e) {
            const tab = e.target.closest('.aiiw-tab');
            if (!tab || !cfg) return;
            cfg.styleTab = tab.dataset.tab;
            saveConfig();
            renderTabs();
        });

        /* --- 内置风格 --- */
        q('aiiw-style-list').addEventListener('click', function (e) {
            const del = e.target.closest('.aiiw-del');
            if (del) {
                e.preventDefault();
                deleteStyle(del.dataset.id);
            }
        });
        q('aiiw-style-list').addEventListener('change', function (e) {
            if (!e.target.classList.contains('aiiw-style-cb')) return;
            const id = e.target.dataset.id;
            if (!cfg) return;
            if (e.target.checked) {
                if (!cfg.activeStyleIds.includes(id)) cfg.activeStyleIds.push(id);
            } else {
                cfg.activeStyleIds = cfg.activeStyleIds.filter(function (x) { return x !== id; });
            }
            saveConfig();
        });
        q('aiiw-style-add').addEventListener('click', addStyle);

        /* --- 预设条目 --- */
        q('aiiw-preset-sel').addEventListener('change', function () {
            if (!cfg) return;
            cfg.presetName = this.value;
            saveConfig();
            renderPresetList();
        });
        q('aiiw-preset-reload').addEventListener('click', function () {
            if (!cfg) return;
            delete cache.presetPrompts[cfg.presetName || '__current__'];
            loadPresetEntries(cfg.presetName, true);
            renderPresetList();
        });
        q('aiiw-preset-search').addEventListener('input', renderPresetList);
        q('aiiw-preset-onlystyle').addEventListener('change', function () {
            if (cfg) { cfg.presetOnlyStyle = this.checked; saveConfig(); }
            renderPresetList();
        });
        q('aiiw-preset-clear').addEventListener('click', function () {
            if (!cfg) return;
            cfg.presetPickedMap[cfg.presetName || ''] = [];
            saveConfig();
            renderPresetList();
        });

        /* --- 世界书条目 --- */
        q('aiiw-world-sel').addEventListener('change', function () {
            if (!cfg) return;
            cfg.worldBook = this.value;
            saveConfig();
            renderWorldList();
        });
        q('aiiw-world-reload').addEventListener('click', function () {
            if (!cfg) return;
            delete cache.worldEntries[cfg.worldBook];
            renderWorldList();
        });
        q('aiiw-world-search').addEventListener('input', renderWorldList);
        q('aiiw-world-enabled').addEventListener('change', function () {
            if (cfg) { cfg.worldEnabledOnly = this.checked; saveConfig(); }
            renderWorldList();
        });
        q('aiiw-world-clear').addEventListener('click', function () {
            if (!cfg) return;
            cfg.worldPickedMap[cfg.worldBook || ''] = [];
            saveConfig();
            renderWorldList();
        });

        /* --- 条目勾选（预设 + 世界书，事件委托） --- */
        function onEntryToggle(e) {
            const cb = e.target.closest('.aiiw-entry-cb');
            if (!cb || !cfg) return;
            const kind = cb.dataset.kind;
            const key = cb.dataset.key;

            if (kind === 'preset') {
                const arr = getPresetPicked();
                const i = arr.indexOf(key);
                if (cb.checked && i === -1) arr.push(key);
                if (!cb.checked && i !== -1) arr.splice(i, 1);
                saveConfig();
                updatePresetStat();      // 只更新统计，保住列表滚动位置
            } else if (kind === 'world') {
                const arr = getWorldPicked();
                const i = arr.indexOf(key);
                if (cb.checked && i === -1) arr.push(key);
                if (!cb.checked && i !== -1) arr.splice(i, 1);
                saveConfig();
                updateWorldStat();
            }
        }
        q('aiiw-preset-list').addEventListener('change', onEntryToggle);
        q('aiiw-world-list').addEventListener('change', onEntryToggle);

        /* --- 条目预览展开（点预览区切换） --- */
        function onEntryPreviewClick(e) {
            const prev = e.target.closest('.aiiw-entry-preview');
            if (!prev) return;
            const row = prev.closest('.aiiw-entry');
            if (row) row.classList.toggle('aiiw-open');
        }
        q('aiiw-preset-list').addEventListener('click', onEntryPreviewClick);
        q('aiiw-world-list').addEventListener('click', onEntryPreviewClick);

        /* --- 仿写样本 --- */
        q('aiiw-mimic-on').addEventListener('change', function () {
            if (!cfg) return;
            cfg.mimicEnabled = this.checked;
            saveConfig();
            updateMimicPreview();
        });
        q('aiiw-mimic-floor').addEventListener('change', function () {
            if (!cfg) return;
            cfg.mimicFloor = Number(this.value);
            saveConfig();
            updateMimicPreview();
        });
        q('aiiw-mimic-reload').addEventListener('click', function () {
            refreshMimicSource();
        });

        /* --- 生成 / 注入 --- */
        q('aiiw-generate').addEventListener('click', generate);
        q('aiiw-regen').addEventListener('click', generate);
        q('aiiw-inject').addEventListener('click', injectToInput);

        q('aiiw-result').addEventListener('input', updateCountDisplay);

        /* --- 内容清洗 --- */
        function onCleanChange() {
            if (!cfg) return;
            cfg.ctxClean = q('aiiw-clean-on').checked;
            cfg.ctxKeepTags = q('aiiw-clean-keep').value.trim();
            cfg.ctxDropTags = q('aiiw-clean-drop').value.trim();
            saveConfig();
            refreshMimicSource();      // 让仿写预览立刻反映新规则
        }
        q('aiiw-clean-on').addEventListener('change', onCleanChange);
        q('aiiw-clean-keep').addEventListener('change', onCleanChange);
        q('aiiw-clean-drop').addEventListener('change', onCleanChange);

        q('aiiw-clean-reset').addEventListener('click', function () {
            if (!cfg) return;
            cfg.ctxClean = true;
            cfg.ctxKeepTags = DEFAULT_CLEAN_KEEP;
            cfg.ctxDropTags = DEFAULT_CLEAN_DROP;
            saveConfig();
            setChecked('aiiw-clean-on', true);
            setValue('aiiw-clean-keep', DEFAULT_CLEAN_KEEP);
            setValue('aiiw-clean-drop', DEFAULT_CLEAN_DROP);
            refreshMimicSource();
        });

        /* --- 设置区折叠 --- */
        q('aiiw-settings-toggle').addEventListener('click', function () {
            const box = q('aiiw-settings');
            if (box) box.classList.toggle('aiiw-open');
        });

        /* --- 设置字段 --- */
        function bindText(id, key, isNum, touchApi) {
            const el = q(id);
            if (!el) return;
            el.addEventListener('change', function () {
                if (!cfg) return;
                cfg[key] = isNum ? Number(this.value) : this.value;
                if (touchApi) clearTestResult();   // 地址/密钥/模型改了就作废上一次测试结果
                syncActiveProfile();
                saveConfig();
            });
        }
        bindText('aiiw-set-endpoint', 'endpoint', false, true);
        bindText('aiiw-set-apikey', 'apiKey', false, true);
        bindText('aiiw-set-model', 'model', false, true);
        bindText('aiiw-set-temp', 'temperature', true, true);
        bindText('aiiw-set-maxtokens', 'maxTokens', true, true);
        bindText('aiiw-set-sysprompt', 'systemPrompt');

        /* --- API 方案 --- */
        q('aiiw-profile-sel').addEventListener('change', function () {
            applyProfile(this.value);
        });
        q('aiiw-profile-save').addEventListener('click', onSaveProfile);
        q('aiiw-profile-del').addEventListener('click', onDeleteProfile);

        /* --- 取模型 --- */
        q('aiiw-fetch-models').addEventListener('click', onFetchModels);
        q('aiiw-model-sel').addEventListener('change', function () {
            if (!cfg) return;
            if (this.value === '') {          // ✎ 手动输入
                resetModelPick(cfg.model);
                const input = q('aiiw-set-model');
                if (input) input.focus();
                return;
            }
            cfg.model = this.value;
            setValue('aiiw-set-model', this.value);
            clearTestResult();
            syncActiveProfile();
            saveConfig();
        });

        /* --- 测试连接 --- */
        q('aiiw-test-api').addEventListener('click', onTestApi);

        q('aiiw-sysprompt-reset').addEventListener('click', function () {
            if (!cfg) return;
            if (!window.confirm('把 System Prompt 恢复成默认内容？你现在的修改会丢。')) return;
            cfg.systemPrompt = DEFAULT_SYSTEM_PROMPT;
            saveConfig();
            setValue('aiiw-set-sysprompt', DEFAULT_SYSTEM_PROMPT);
        });

        q('aiiw-set-apimode').addEventListener('change', function () {
            if (!cfg) return;
            cfg.apiMode = this.value;
            saveConfig();
            syncCustomBlockVisibility();
        });

        q('aiiw-set-proxy').addEventListener('change', function () {
            if (!cfg) return;
            cfg.useProxy = this.checked;
            syncActiveProfile();
            saveConfig();
            clearTestResult();
        });

        /* 生成期间切聊天：切回来后把楼层列表刷新一下 */
        const ctx = getCtx();
        if (ctx && ctx.eventSource && ctx.eventTypes && ctx.eventTypes.CHAT_CHANGED) {
            try {
                ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, function () {
                    cache.floors = null;
                    if (state.panel === 'open') refreshMimicSource();
                });
            } catch (e) { /* 忽略 */ }
        }
    }

    /* ========================================================================
     * 23. 启动
     * ====================================================================== */

    function init() {
        ensurePanel();
        bindEvents();
        setupMobileViewport();
        ensureMenuEntry();      // 独立于酒馆上下文，可立即开始轮询

        // 等酒馆上下文就绪后再读配置、填 UI
        let tries = 0;
        const timer = setInterval(function () {
            tries += 1;
            if (getCtx()) {
                clearInterval(timer);
                if (loadConfig()) {
                    syncUiToConfig();
                    renderStyleList();
                    updateCountDisplay();
                }
            } else if (tries > 100) {
                clearInterval(timer);
                console.warn('[AI Input Writer] 等待酒馆上下文超时，扩展未完成初始化。');
            }
        }, 300);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    /* 暴露到全局，方便在控制台手动检查（不涉及任何敏感数据） */
    window.AIIW = {
        open: function () { openPanel(); },
        close: function () { setPanelState('closed'); },
        minimize: function () { setPanelState('minimized'); },
        getConfig: function () { return cfg; },
        /* 调试用：看看当前会拼出什么 prompt（不含 API Key） */
        previewPrompt: function (intent) {
            if (!cfg) return null;
            return {
                system: buildSystemPrompt(),
                user: buildUserPrompt(String(intent || cfg.lastIntent || '(空)')),
            };
        },
        /* 调试用：列出读到的数据源 */
        probe: function () {
            return {
                presetNames: listPresetNames(),
                currentPreset: getCurrentPresetName(),
                worldbooks: cache.worldbooks,
                floors: (cache.floors || refreshFloors()).length,
            };
        },
        /* 调试用：看某条楼层清洗前后分别长什么样 */
        cleanPreview: function (floorId) {
            const floors = cache.floors || refreshFloors();
            const f = floors.find(function (x) { return x.id === Number(floorId); });
            if (!f) return null;
            return { beforeLen: f.rawLen, afterLen: f.text.length, after: f.text };
        },
        /* 调试用：直接测一段文本的清洗结果 */
        clean: function (text) { return cleanMessageText(String(text || '')); },
    };

})();
