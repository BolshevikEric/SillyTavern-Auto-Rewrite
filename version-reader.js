import { messageFormatting } from '../../../../script.js';
import { getContext } from '../../../extensions.js';
import { REVISION, keyOf } from './revisions.js';

// Reading a saved version never changes the native streaming swipe or variables.
export function createVersionReader(onChange) {
    let session, root, body, messageElement, scrollLease;
    const covered = new Set();

    function restoreScroll() {
        if (!scrollLease) return;
        const { settings, value } = scrollLease;
        if (settings.auto_scroll_chat_to_bottom === false) {
            settings.auto_scroll_chat_to_bottom = value;
            getContext().saveSettingsDebounced();
        }
        scrollLease = null;
    }

    function close(follow = false) {
        const current = session && keyOf(getContext()) === session.key;
        session = null;
        root?.remove(); root = null; body = null;
        messageElement?.classList.remove('auto-rewrite-reading'); messageElement = null;
        for (const element of covered) element.classList.remove('auto-rewrite-reader-covered');
        covered.clear();
        restoreScroll();
        if (follow && current) {
            const viewport = document.getElementById('chat');
            if (viewport) viewport.scrollTop = viewport.scrollHeight;
        }
        onChange();
    }

    function mount() {
        const element = document.querySelector(`#chat > .mes[mesid="${session.index}"]`);
        const block = element?.querySelector('.mes_block');
        if (!block) return;
        if (element !== messageElement) {
            messageElement?.classList.remove('auto-rewrite-reading');
            messageElement = element;
        }
        element.classList.add('auto-rewrite-reading');
        if (root.parentElement !== block) {
            const text = block.querySelector('.mes_text');
            if (text) text.before(root); else block.append(root);
        }
        for (const native of block.querySelectorAll('.mes_text, .mes_reasoning_details, .mes_img, .mes_media')) {
            if (!root.contains(native)) {
                native.classList.add('auto-rewrite-reader-covered');
                covered.add(native);
            }
        }
        // Native tool continuations and the legacy path can have temporary floors.
        // Keep their real DOM intact so native streaming and plugins still own it.
        for (const candidate of document.querySelectorAll('#chat > .mes')) {
            if (Number(candidate.getAttribute('mesid')) > session.index) {
                candidate.classList.add('auto-rewrite-reader-covered');
                covered.add(candidate);
            }
        }
    }

    function paint(align = true) {
        const version = session.versions[session.selected];
        const text = typeof version.displayText === 'string' && version.displayText ? version.displayText : version.text;
        try {
            body.innerHTML = messageFormatting(text, session.name, false, false,
                session.index === 0 ? -1 : session.index);
            body.classList.remove('auto-rewrite-reader-plain');
        } catch (error) {
            console.warn('[Auto Rewrite] Version formatting', error);
            body.textContent = text;
            body.classList.add('auto-rewrite-reader-plain');
        }
        root.querySelector('[data-counter]').textContent = `${session.selected + 1} / ${session.versions.length}`;
        root.querySelector('[data-prev]').disabled = session.selected === 0;
        root.querySelector('[data-next]').disabled = session.selected === session.versions.length - 1;
        const label = session.selected === session.sourceSwipe ? '原稿' : '历史版本';
        root.querySelector('[data-version-label]').textContent = label;
        mount();
        if (align) {
            const viewport = document.getElementById('chat');
            if (viewport && root.isConnected) {
                viewport.scrollTop += root.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 10;
            }
        }
    }

    function page(step) {
        if (!session) return;
        const next = Math.max(0, Math.min(session.versions.length - 1, session.selected + step));
        if (next === session.selected) return;
        session.selected = next;
        paint();
    }

    function open(state) {
        if (!state?.versions.length) return;
        if (session) close();
        session = { ...state, selected: Math.max(0, Math.min(state.versions.length - 1, state.sourceSwipe)) };
        root = document.createElement('section');
        root.className = 'auto-rewrite-reader';
        root.setAttribute('role', 'region');
        root.setAttribute('aria-label', '重写时查看其他版本');
        root.tabIndex = -1;
        root.innerHTML = `<div class="auto-rewrite-reader-heading">
            <span class="auto-rewrite-reader-title" data-version-label></span>
            <div class="auto-rewrite-reader-controls">
                <div class="auto-rewrite-reader-pager" role="group" aria-label="正文版本翻页">
                    <button type="button" data-prev aria-label="上一版"><i class="fa-solid fa-chevron-left" aria-hidden="true"></i></button>
                    <span data-counter aria-live="polite"></span>
                    <button type="button" data-next aria-label="下一版"><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button>
                </div>
                <button type="button" class="auto-rewrite-reader-return" data-return>回到重写</button>
            </div>
        </div><div class="auto-rewrite-reader-body"></div>`;

        // SillyTavern scopes message CSS to .mes_text. Keep that class inside
        // the shadow tree so streaming and message plugins still find only the live body.
        const shadow = root.querySelector('.auto-rewrite-reader-body').attachShadow({ mode: 'open' });
        const nativeStyles = document.createElement('link');
        nativeStyles.rel = 'stylesheet';
        nativeStyles.href = new URL('../../../../style.css', import.meta.url).href;
        const previewStyles = document.createElement('style');
        previewStyles.textContent = `
            .mes_text { white-space: normal; }
            .mes_text.auto-rewrite-reader-plain { white-space: pre-wrap; }
            .mes_text q::before, .mes_text q::after { content: none; }
        `;
        body = document.createElement('div');
        body.className = 'mes_text';
        shadow.append(nativeStyles, previewStyles, body);

        root.querySelector('[data-prev]').addEventListener('click', () => page(-1));
        root.querySelector('[data-next]').addEventListener('click', () => page(1));
        root.querySelector('[data-return]').addEventListener('click', () => close(true));
        root.addEventListener('keydown', event => {
            const target = event.composedPath()[0];
            if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
                || (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]'))) return;
            if (!['ArrowLeft', 'ArrowRight', 'Escape'].includes(event.key)) return;
            event.preventDefault(); event.stopPropagation();
            if (event.key === 'Escape') close(true);
            else page(event.key === 'ArrowLeft' ? -1 : 1);
        });
        const settings = getContext().powerUserSettings;
        if (settings?.auto_scroll_chat_to_bottom === true) {
            scrollLease = { settings, value: true };
            settings.auto_scroll_chat_to_bottom = false;
        }
        paint();
        root.focus({ preventScroll: true });
        onChange();
    }

    function sync(view) {
        if (!session) return;
        const ctx = getContext();
        const message = ctx.chat[session.index];
        if (keyOf(ctx) !== session.key || !message || view.cancelled
            || ctx.chat.slice(session.index + 1).some(candidate => candidate.is_user)
            || (message !== session.source && message.extra?.[REVISION]?.id !== session.id)
            || (view.readerId && view.readerId !== session.id)
            || (!view.busy && view.reply?.index !== session.index)) {
            close(); return;
        }
        mount();
        const back = root.querySelector('[data-return]');
        const text = view.busy ? '回到重写' : '查看重写稿';
        if (back.textContent !== text) back.textContent = text;
    }

    return { open, close, sync, isOpen: () => Boolean(session), dispose: () => close() };
}
