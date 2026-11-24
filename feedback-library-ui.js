import { bindingContext, bindingCatalog, composedFeedback, sortedEntries, matchEntry,
    presetKey, entryId, normalizeEntry, moveEntry } from './feedback-library.js';

const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
};
const contextLabel = context => `预设：${context.preset?.name || '未选择'}　·　角色：${context.character?.name || '未选择'}`;

export function createFeedbackLibraryUI({ getSettings, createMenu, onChange, onOpen }) {
    const summaries = new Set();
    const menu = createMenu();
    let dialog, selected, query = '', filter = 'all', lastDeleted;
    let listSignature, bindingsSignature, disposed = false, mobileView = 'list';
    const isMobile = () => globalThis.matchMedia?.('(max-width: 700px)').matches ?? false;
    function setMobileView(view) {
        mobileView = view === 'editor' ? 'editor' : 'list';
        if (!dialog) return;
        dialog.dataset.mobileView = mobileView;
        if (mobileView === 'editor') {
            const editorWrap = dialog.querySelector('.auto-rewrite-library-editor-wrap');
            if (editorWrap) editorWrap.scrollTop = 0;
            if (isMobile()) {
                const options = dialog.querySelector('.auto-rewrite-entry-options');
                if (options) options.open = false;
            }
        }
    }
    const entries = () => getSettings().feedbackEntries;
    const current = () => entries().find(entry => entry.id === selected);
    const persist = () => { onChange(); sync(); };

    function summary() {
        const root = el('section', 'auto-rewrite-library-summary');
        root.dataset.feedbackLibrary = '';
        root.innerHTML = `<div class="auto-rewrite-library-summary-heading"><div><i class="fa-solid fa-book-bookmark" aria-hidden="true"></i><b>修改意见仓库</b><span class="auto-rewrite-library-count" data-count></span></div><button type="button" class="auto-rewrite-library-manage"><i class="fa-solid fa-sliders" aria-hidden="true"></i>打开仓库</button></div>
            <div class="auto-rewrite-library-active" data-active></div>
            <details class="auto-rewrite-library-preview"><summary>预览修改意见</summary><p class="auto-rewrite-library-context" data-context></p><pre data-preview></pre></details>`;
        root.querySelector('button').addEventListener('click', () => open());
        summaries.add(root);
        updateSummary(root, composedFeedback(getSettings()));
        return root;
    }

    function updateSummary(root, composition) {
        const signature = JSON.stringify([contextLabel(composition.context), composition.entries.map(entry => [entry.id, entry.name, entry.order])]);
        if (root.dataset.signature !== signature) {
            root.dataset.signature = signature;
            root.querySelector('[data-count]').textContent = `${composition.entries.length} 条生效`;
            root.querySelector('[data-context]').textContent = contextLabel(composition.context);
            const active = root.querySelector('[data-active]');
            active.replaceChildren(...composition.entries.map(entry => {
                const button = el('button', 'auto-rewrite-library-active-chip');
                button.type = 'button';
                button.textContent = entry.name || '未命名条目';
                button.addEventListener('click', () => open(entry.id));
                return button;
            }));
            if (!composition.entries.length) active.append(el('p', 'auto-rewrite-library-empty-inline', '暂无生效条目，请启用常驻条目或设置预设、角色绑定。'));
        }
        const preview = root.querySelector('[data-preview]');
        if (preview.textContent !== composition.text) preview.textContent = composition.text || '当前组合为空';
    }

    function select(id) {
        menu.close(); selected = id; bindingsSignature = null;
        if (isMobile()) setMobileView('editor');
        sync();
    }

    function add() {
        const entry = normalizeEntry({ name: '新修改意见', order: 3, always: true });
        entries().push(entry); selected = entry.id; query = ''; filter = 'all';
        if (dialog) dialog.querySelector('[data-search]').value = '';
        setMobileView('editor');
        persist();
        dialog?.querySelector('[data-name]')?.focus();
    }

    function remove() {
        const entry = current();
        if (!entry) return;
        const index = entries().indexOf(entry);
        lastDeleted = { entry, index };
        entries().splice(index, 1);
        selected = sortedEntries(getSettings())[0]?.id;
        if (isMobile()) setMobileView('list');
        persist();
    }

    function undo() {
        if (!lastDeleted) return;
        entries().splice(Math.min(lastDeleted.index, entries().length), 0, lastDeleted.entry);
        selected = lastDeleted.entry.id; lastDeleted = null; persist();
    }

    function bind(kind, value) {
        const entry = current();
        if (!entry || !value) return;
        entry.always = false;
        const key = kind === 'presets' ? presetKey : item => item.avatar;
        if (!entry[kind].some(item => key(item) === key(value))) entry[kind].push(kind === 'presets'
            ? { api: value.api, name: value.name } : { avatar: value.avatar, name: value.name });
        persist();
    }

    function chooseBinding(kind, anchor) {
        const entry = current();
        if (!entry) return;
        const catalog = bindingCatalog();
        const choices = kind === 'presets' ? catalog.presets : catalog.characters;
        const key = kind === 'presets' ? presetKey : item => item.avatar;
        const available = choices.filter(item => !entry[kind].some(bound => key(bound) === key(item)));
        if (!available.length) { globalThis.toastr?.info('没有更多可绑定项，也可先载入目标预设或角色，再绑定当前项。'); return; }
        menu.open({ anchor, items: available.map(item => ({ value: key(item), label: item.name,
            tag: kind === 'presets' ? item.label : '', sub: kind === 'characters' ? item.avatar : '' })), value: '',
        onPick: value => { const item = available.find(candidate => key(candidate) === value); if (item) bind(kind, item); } });
    }

    function exportLibrary() {
        const data = { type: 'sillytavern-auto-rewrite-feedback', version: 1, entries: entries() };
        const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
        const link = el('a'); link.href = url; link.download = 'rewrite-feedback-library.json';
        document.body.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    async function importLibrary(file) {
        if (!file) return;
        try {
            if (file.size > 10 * 1024 * 1024) throw new Error('文件超过 10 MiB，请拆分后导入。');
            const data = JSON.parse(await file.text());
            if (data?.type !== 'sillytavern-auto-rewrite-feedback' || data.version !== 1 || !Array.isArray(data.entries)
                || !data.entries.every(entry => entry && typeof entry.name === 'string' && typeof entry.content === 'string')) {
                throw new Error('请选择此插件导出的修改意见仓库 JSON 文件。');
            }
            if (disposed) return;
            const added = data.entries.map(entry => normalizeEntry({ ...entry, id: entryId() }));
            entries().push(...added); selected = added[0]?.id ?? selected;
            query = ''; filter = 'all';
            if (dialog) dialog.querySelector('[data-search]').value = '';
            persist(); globalThis.toastr?.success(`已追加导入 ${added.length} 条修改意见。`);
        } catch (error) { globalThis.toastr?.error(error.message); }
    }

    function open(id) {
        if (disposed) return;
        if (id) { selected = id; query = ''; filter = 'all'; }
        if (dialog) {
            if (id) {
                dialog.querySelector('[data-search]').value = '';
                if (isMobile()) setMobileView('editor');
            }
            sync(); dialog.focus(); return;
        }
        onOpen?.();
        selected = entries().some(entry => entry.id === selected) ? selected : sortedEntries(getSettings())[0]?.id;
        mobileView = id && selected ? 'editor' : 'list';
        listSignature = null; bindingsSignature = null;
        const shell = el('dialog', 'auto-rewrite-dialog auto-rewrite-library-dialog');
        shell.dataset.mobileView = mobileView;
        shell.setAttribute('aria-label', '修改意见仓库');
        shell.innerHTML = `<header class="auto-rewrite-library-heading"><div class="auto-rewrite-library-heading-main"><button type="button" class="auto-rewrite-library-back" data-mobile-back aria-label="返回条目列表"><i class="fa-solid fa-chevron-left" aria-hidden="true"></i><span>列表</span></button><h3 class="auto-rewrite-library-title-list">修改意见仓库</h3><h3 class="auto-rewrite-library-title-editor">编辑条目</h3></div><div class="auto-rewrite-library-heading-actions"><button type="button" data-import title="追加导入条目" aria-label="导入仓库"><i class="fa-solid fa-file-import" aria-hidden="true"></i></button><button type="button" data-export title="导出全部条目" aria-label="导出仓库"><i class="fa-solid fa-file-export" aria-hidden="true"></i></button><button type="button" class="is-primary" data-add><i class="fa-solid fa-plus" aria-hidden="true"></i>新建</button><button type="button" data-close aria-label="关闭仓库"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></div></header>
            <div class="auto-rewrite-library-layout"><aside class="auto-rewrite-library-sidebar"><div class="auto-rewrite-library-search"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i><input type="search" data-search placeholder="搜索名称或内容" aria-label="搜索修改意见"></div><div class="auto-rewrite-library-filters"><button type="button" data-filter="all">全部条目</button><button type="button" data-filter="active">当前生效</button></div><div class="auto-rewrite-library-list" data-list></div></aside>
            <main class="auto-rewrite-library-editor-wrap"><div class="auto-rewrite-library-empty" data-empty><i class="fa-solid fa-book-open" aria-hidden="true"></i><b>保存一套可复用的修改意见</b><span>创建条目，再设置常驻或预设、角色绑定。</span><button type="button" data-create-first>新建条目</button></div><div class="auto-rewrite-library-editor" data-editor>
            <div class="auto-rewrite-library-entry-heading"><input class="text_pole" type="text" data-name placeholder="条目名称" aria-label="条目名称"><label class="auto-rewrite-quick-toggle"><input type="checkbox" data-enabled><span>启用</span></label></div>
            <label class="auto-rewrite-library-content-label">修改意见<textarea class="text_pole" data-content rows="9" placeholder="写下希望这一版如何修改…" spellcheck="false"></textarea></label>
            <details open class="auto-rewrite-entry-options"><summary class="auto-rewrite-disclosure"><b>条目设置</b><span data-scope-label></span></summary>            <div class="auto-rewrite-library-entry-tools"><label>顺序<input class="text_pole" type="number" min="-9999" max="9999" step="1" data-order aria-label="注入顺序"></label><div><button type="button" data-up title="上移条目" aria-label="上移条目"><i class="fa-solid fa-arrow-up" aria-hidden="true"></i></button><button type="button" data-down title="下移条目" aria-label="下移条目"><i class="fa-solid fa-arrow-down" aria-hidden="true"></i></button><button type="button" data-duplicate title="复制条目" aria-label="复制条目"><i class="fa-regular fa-copy" aria-hidden="true"></i></button><button type="button" data-delete title="删除条目，可撤销" aria-label="删除条目"><i class="fa-regular fa-trash-can" aria-hidden="true"></i></button></div></div>
            <div class="auto-rewrite-library-scope" role="group" aria-label="生效范围"><button type="button" data-scope="always"><i class="fa-solid fa-thumbtack" aria-hidden="true"></i>常驻</button><button type="button" data-scope="bound"><i class="fa-solid fa-link" aria-hidden="true"></i>绑定预设 / 角色</button></div>
            <section class="auto-rewrite-library-bindings" data-bindings><p data-context></p><div class="auto-rewrite-library-binding-group"><div><b>预设绑定</b><span><button type="button" data-current-preset>绑定当前预设</button><button type="button" data-add-preset aria-haspopup="listbox" aria-expanded="false" title="选择更多预设" aria-label="添加预设绑定"><i class="fa-solid fa-plus" aria-hidden="true"></i></button></span></div><div class="auto-rewrite-library-binding-chips" data-presets></div></div><div class="auto-rewrite-library-binding-group"><div><b>角色绑定</b><span><button type="button" data-current-character>绑定当前角色</button><button type="button" data-add-character aria-haspopup="listbox" aria-expanded="false" title="选择更多角色" aria-label="添加角色绑定"><i class="fa-solid fa-plus" aria-hidden="true"></i></button></span></div><div class="auto-rewrite-library-binding-chips" data-characters></div></div><div class="auto-rewrite-library-match"><button type="button" data-match="any">任一绑定匹配</button><button type="button" data-match="all">预设与角色同时匹配</button></div><p data-match-help></p></section>
</details></div></main></div>
            <footer class="auto-rewrite-library-footer"><div class="auto-rewrite-library-undo" data-undo-bar hidden><span data-undo-text></span><button type="button" data-undo>撤销删除</button></div><details class="auto-rewrite-library-preview"><summary><span>当前组合预览</span><small data-composed-count></small></summary><pre data-composed></pre></details></footer><input type="file" data-file accept=".json,application/json" hidden>`;
        dialog = shell;
        const button = (selector, handler) => shell.querySelector(selector).addEventListener('click', handler);
        button('[data-close]', () => shell.close()); button('[data-add]', add); button('[data-create-first]', add);
        button('[data-mobile-back]', () => { menu.close(); setMobileView('list'); sync(); });
        button('[data-delete]', remove); button('[data-undo]', undo); button('[data-export]', exportLibrary);
        button('[data-import]', () => shell.querySelector('[data-file]').click());
        shell.querySelector('[data-file]').addEventListener('change', event => { void importLibrary(event.target.files?.[0]); event.target.value = ''; });
        button('[data-up]', () => { if (current()) { moveEntry(getSettings(), selected, -1); persist(); } });
        button('[data-down]', () => { if (current()) { moveEntry(getSettings(), selected, 1); persist(); } });
        button('[data-duplicate]', () => {
            const entry = current(); if (!entry) return;
            const copy = normalizeEntry({ ...structuredClone(entry), id: entryId(), name: `${entry.name || '未命名条目'} · 副本`, enabled: false });
            entries().splice(entries().indexOf(entry) + 1, 0, copy); selected = copy.id; persist();
        });
        button('[data-current-preset]', () => bind('presets', bindingContext().preset));
        button('[data-current-character]', () => bind('characters', bindingContext().character));
        button('[data-add-preset]', event => chooseBinding('presets', event.currentTarget));
        button('[data-add-character]', event => chooseBinding('characters', event.currentTarget));
        for (const node of shell.querySelectorAll('[data-scope]')) node.addEventListener('click', () => { const entry = current(); if (entry) { entry.always = node.dataset.scope === 'always'; persist(); } });
        for (const node of shell.querySelectorAll('[data-match]')) node.addEventListener('click', () => { const entry = current(); if (entry) { entry.match = node.dataset.match; persist(); } });
        for (const key of ['name', 'content', 'order', 'enabled']) shell.querySelector(`[data-${key}]`).addEventListener(key === 'enabled' ? 'change' : 'input', event => {
            const entry = current(); if (!entry) return;
            if (key === 'order') {
                const value = event.target.valueAsNumber;
                if (!Number.isFinite(value)) return;
                entry.order = Math.max(-9999, Math.min(9999, Math.trunc(value)));
            } else entry[key] = key === 'enabled' ? event.target.checked : event.target.value;
            persist();
        });
        shell.querySelector('[data-search]').value = query;
        shell.querySelector('[data-search]').addEventListener('input', event => { query = event.target.value; sync(); });
        for (const node of shell.querySelectorAll('[data-filter]')) node.addEventListener('click', () => { filter = node.dataset.filter; sync(); });
        let backdropPressed = false;
        const outside = event => {
            if (event.target !== shell) return false;
            const rect = shell.getBoundingClientRect();
            return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
        };
        shell.addEventListener('pointerdown', event => { backdropPressed = event.button === 0 && outside(event); });
        shell.addEventListener('pointercancel', () => { backdropPressed = false; });
        shell.addEventListener('click', event => { const close = backdropPressed && outside(event); backdropPressed = false; if (close) shell.close(); });
        shell.addEventListener('cancel', event => { if (menu.isOpen()) { event.preventDefault(); menu.close(); } });
        shell.addEventListener('close', () => { menu.close(); shell.remove(); if (dialog === shell) dialog = null; });
        if (isMobile()) {
            const options = shell.querySelector('.auto-rewrite-entry-options');
            if (options) options.open = false;
        }
        document.body.append(shell); sync(); shell.showModal();
    }

    function renderList(composition) {
        const ordered = sortedEntries(getSettings());
        const token = JSON.stringify([selected, query, filter, composition.context, ordered.map(entry =>
            [entry.id, entry.name, entry.order, matchEntry(entry, composition.context), entry.enabled, entry.always, query ? entry.content : ''])]);
        if (token === listSignature) return;
        listSignature = token;
        const list = dialog.querySelector('[data-list]'), oldScroll = list.scrollTop;
        const q = query.trim().toLocaleLowerCase();
        const visible = ordered.filter(entry => (!q || `${entry.name}\n${entry.content}`.toLocaleLowerCase().includes(q))
            && (filter !== 'active' || matchEntry(entry, composition.context).active));
        list.replaceChildren(...visible.map(entry => {
            const state = matchEntry(entry, composition.context);
            const row = el('div', 'auto-rewrite-library-row');
            row.dataset.selected = String(entry.id === selected);
            const pick = el('button', 'auto-rewrite-library-row-pick'); pick.type = 'button';
            pick.setAttribute('aria-current', entry.id === selected ? 'true' : 'false');
            pick.append(el('span', 'auto-rewrite-library-order', String(entry.order)));
            const text = el('span', 'auto-rewrite-library-row-text');
            const title = el('b', '', entry.name || '未命名条目'); title.title = entry.name;
            const status = el('small', state.active ? 'is-active' : '', state.reason);
            text.append(title, status); pick.append(text); pick.addEventListener('click', () => select(entry.id));
            const toggle = el('label', 'auto-rewrite-quick-toggle');
            const checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.checked = entry.enabled;
            checkbox.setAttribute('aria-label', `启用${entry.name || '条目'}`);
            checkbox.addEventListener('change', () => { entry.enabled = checkbox.checked; persist(); });
            toggle.append(checkbox);
            const chevron = el('i', 'fa-solid fa-chevron-right auto-rewrite-library-row-chevron');
            chevron.setAttribute('aria-hidden', 'true');
            chevron.addEventListener('click', () => select(entry.id));
            row.append(pick, toggle, chevron); return row;
        }));
        if (!visible.length) list.append(el('p', 'auto-rewrite-library-list-empty', q ? '没有找到匹配的条目' : filter === 'active' ? '当前没有生效条目' : '仓库还是空的，点击“新建”添加。'));
        list.scrollTop = oldScroll;
    }

    function renderBindings(entry) {
        const token = JSON.stringify([entry.id, entry.always, entry.presets, entry.characters]);
        if (token === bindingsSignature) return;
        bindingsSignature = token;
        for (const kind of ['presets', 'characters']) {
            const root = dialog.querySelector(`[data-${kind}]`);
            root.replaceChildren(...entry[kind].map((binding, index) => {
                const chip = el('button', 'auto-rewrite-library-binding-chip'); chip.type = 'button';
                chip.title = `${binding.name} · 点击解除绑定`;
                chip.append(el('span', '', binding.name), el('i', 'fa-solid fa-xmark'));
                chip.querySelector('i').setAttribute('aria-hidden', 'true');
                chip.setAttribute('aria-label', `解除绑定：${binding.name}`);
                chip.addEventListener('click', () => { entry[kind].splice(index, 1); persist(); });
                return chip;
            }));
            if (!entry[kind].length) root.append(el('span', 'auto-rewrite-library-unbound', kind === 'presets' ? '尚未绑定预设' : '尚未绑定角色'));
        }
    }

    function sync() {
        if (disposed) return;
        const composition = composedFeedback(getSettings());
        for (const root of summaries) {
            if (!root.isConnected) { summaries.delete(root); continue; }
            updateSummary(root, composition);
        }
        if (!dialog) return;
        const entryNow = current();
        if (!entryNow && mobileView === 'editor') mobileView = 'list';
        dialog.dataset.mobileView = mobileView;
        dialog.querySelector('[data-context]').textContent = contextLabel(composition.context);
        for (const node of dialog.querySelectorAll('[data-filter]')) node.setAttribute('aria-pressed', String(node.dataset.filter === filter));
        renderList(composition);
        const entry = current();
        dialog.querySelector('[data-empty]').hidden = Boolean(entry);
        dialog.querySelector('[data-editor]').hidden = !entry;
        if (entry) {
            for (const key of ['name', 'content', 'order']) {
                const field = dialog.querySelector(`[data-${key}]`);
                if (document.activeElement !== field) field.value = entry[key];
            }
            dialog.querySelector('[data-enabled]').checked = entry.enabled;
            dialog.querySelector('[data-scope-label]').textContent = entry.always ? '常驻' : '绑定预设 / 角色';
            for (const node of dialog.querySelectorAll('[data-scope]')) node.setAttribute('aria-pressed', String((node.dataset.scope === 'always') === entry.always));
            dialog.querySelector('[data-bindings]').hidden = entry.always;
            dialog.querySelector('[data-current-preset]').disabled = !composition.context.preset;
            dialog.querySelector('[data-current-character]').disabled = !composition.context.character;
            for (const node of dialog.querySelectorAll('[data-match]')) node.setAttribute('aria-pressed', String(node.dataset.match === entry.match));
            dialog.querySelector('[data-match-help]').textContent = entry.match === 'all'
                ? '两类都设置绑定时，预设与角色须同时匹配；只绑定一类时按该类匹配。' : '预设或角色命中任意一个绑定即可生效。';
            const ordered = sortedEntries(getSettings()), position = ordered.indexOf(entry);
            dialog.querySelector('[data-up]').disabled = position <= 0;
            dialog.querySelector('[data-down]').disabled = position >= ordered.length - 1;
            renderBindings(entry);
        }
        dialog.querySelector('[data-undo-bar]').hidden = !lastDeleted;
        if (lastDeleted) dialog.querySelector('[data-undo-text]').textContent = `已删除“${lastDeleted.entry.name || '未命名条目'}”`;
        dialog.querySelector('[data-composed-count]').textContent = `${composition.entries.length} 条生效 · ${composition.text.length} 字`;
        const preview = dialog.querySelector('[data-composed]');
        if (preview.textContent !== composition.text) preview.textContent = composition.text || '当前没有生效内容';
    }

    return { summary, open, sync, dispose() {
        disposed = true; menu.destroy(); dialog?.close(); summaries.clear();
    } };
}
