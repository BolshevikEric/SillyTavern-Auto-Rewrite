import { getContext } from '../../../extensions.js';
import { REVISION, keyOf } from './revisions.js';

const FOLD_ATTR = 'data-ar-pre-folded';
const UNCLOSED_DOUBLE_PRE_RE = /<pre\b[^>]*>([\s\S]*?)<pre\b[^>]*>/i;
const CLOSED_PRE_RE = /<\/pre>/i;
const PRE_TAG_RE = /<pre\b[^>]*>([\s\S]*?)(?:<\/pre>|(?=<pre\b)|$)/gi;
const CHAT_OBSERVER_OPTIONS = { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['mesid'] };

function countChars(text) {
    return String(text ?? '').replace(/\s+/g, '').length;
}

function formatChars(count) {
    if (!count) return '';
    return `${count.toLocaleString('zh-CN')} 字`;
}

function isCodeBlockPre(pre, rawText = '') {
    if (!(pre instanceof HTMLElement)) return true;
    const children = [...pre.children];
    const hasOnlyCodeChild = children.length === 1 && children[0].tagName === 'CODE'
        && !pre.childNodes.some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
    if (!hasOnlyCodeChild) return false;
    const code = children[0];
    // Explicitly fenced Markdown blocks carry language-* / lang-* classes or come
    // from messages without raw <pre> tags. If the raw message used <pre> tags,
    // keep folding even if a post-render plugin wrapped its body in <code>.
    if (/(?:^|\s)(?:language|lang)-/i.test(code.className || '')) return true;
    if (typeof rawText === 'string' && /<pre\b/i.test(rawText)) {
        if (!/```/.test(rawText)) return false;
        const text = (pre.textContent ?? '').trim();
        if (text && extractPreSegments(rawText).some(seg => seg.trim() === text)) return false;
    }
    return true;
}

function isRewrittenMessage(message, index, activeJob) {
    if (!message || message.is_user || message.is_system) return false;
    if (message.extra?.[REVISION]) return true;
    const swipeId = message.swipe_id ?? 0;
    if (message.swipe_info?.[swipeId]?.extra?.[REVISION]) return true;
    if (!activeJob || activeJob.cancelled) return false;
    const ctx = getContext();
    if (keyOf(ctx) !== activeJob.key) return false;
    if (activeJob.inplace) return index === activeJob.index && Boolean(activeJob.generating || activeJob.nativeStarted);
    return index > activeJob.index + 1 && Boolean(activeJob.generating);
}

export function extractPreSegments(rawText) {
    if (typeof rawText !== 'string' || !/<pre\b/i.test(rawText)) return [];
    const matches = [];
    PRE_TAG_RE.lastIndex = 0;
    let match;
    while ((match = PRE_TAG_RE.exec(rawText)) !== null) {
        matches.push(match[1]);
        if (match[0].length === 0) break;
    }
    return matches;
}

function unwrapNestedDoublePre(pre, rawText) {
    // Handle prompts instructing "<pre>...<pre>" without a closing slash, which
    // causes HTML parsers to nest the entire main prose inside a child <pre>.
    if (!rawText || CLOSED_PRE_RE.test(rawText) || !UNCLOSED_DOUBLE_PRE_RE.test(rawText)) return;
    const nested = pre.querySelector(':scope > pre');
    if (!nested) return;
    const trailingNodes = [];
    let cursor = nested;
    while (cursor) {
        const next = cursor.nextSibling;
        if (cursor === nested) {
            const text = nested.textContent ?? '';
            const paragraphs = text.split(/\n{2,}/);
            for (const para of paragraphs) {
                const trimmed = para.replace(/^\n+|\n+$/g, '');
                if (!trimmed) continue;
                const p = document.createElement('p');
                const lines = trimmed.split('\n');
                lines.forEach((line, idx) => {
                    if (idx > 0) p.append(document.createElement('br'));
                    p.append(document.createTextNode(line));
                });
                trailingNodes.push(p);
            }
            nested.remove();
        } else {
            trailingNodes.push(cursor);
        }
        cursor = next;
    }
    if (trailingNodes.length && pre.parentElement) {
        const frag = document.createDocumentFragment();
        for (const node of trailingNodes) frag.append(node);
        pre.after(frag);
    }
}

function isInternalControlMutation(mutation) {
    const target = mutation.target instanceof Element ? mutation.target : mutation.target?.parentElement;
    if (!target) return true;
    if (target.closest('.auto-rewrite-pre-toggle, .auto-rewrite-pre-collapse-foot, .auto-rewrite-actions')) return true;
    if (mutation.type === 'childList') {
        const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
        if (nodes.length && nodes.every(n => n instanceof Element && n.classList.contains('auto-rewrite-actions'))) {
            return true;
        }
    }
    return false;
}

export function createPreFoldManager({ getSettings, getActiveJob }) {
    const expandedState = new Map();
    const pendingNodes = new Set();
    let chatObserver = null;
    let observedChat = null;
    let syncDepth = 0;
    let disposed = false;
    let scheduled = false;
    let frameId = null;

    const stateKey = (chatKey, index, swipeId, blockIndex) => `${chatKey}|${index}|${swipeId}|${blockIndex}`;

    const setCardExpanded = (card, expanded) => {
        const nextFlag = String(expanded);
        if (card.dataset.expanded !== nextFlag) card.dataset.expanded = nextFlag;
        const toggle = card.querySelector('.auto-rewrite-pre-toggle');
        const hint = card.querySelector('.auto-rewrite-pre-hint');
        const panel = card.querySelector('.auto-rewrite-pre-panel');
        if (toggle && toggle.getAttribute('aria-expanded') !== nextFlag) {
            toggle.setAttribute('aria-expanded', nextFlag);
        }
        const nextHint = expanded ? '点击收回' : '点击展开';
        if (hint && hint.textContent !== nextHint) hint.textContent = nextHint;
        if (panel) {
            const nextHidden = String(!expanded);
            if (panel.getAttribute('aria-hidden') !== nextHidden) panel.setAttribute('aria-hidden', nextHidden);
            if (Boolean(panel.inert) !== !expanded) panel.inert = !expanded;
        }
    };

    const unwrapCard = card => {
        const pre = card.querySelector(':scope > .auto-rewrite-pre-panel > .auto-rewrite-pre-panel-inner > pre');
        if (pre) {
            pre.classList.remove('auto-rewrite-pre-content');
            card.replaceWith(pre);
        } else {
            card.remove();
        }
    };

    const restoreMessage = mesNode => {
        const cards = mesNode?.querySelectorAll('.auto-rewrite-pre-fold');
        if (!cards?.length) return;
        for (const card of cards) unwrapCard(card);
    };

    const pauseObserver = () => {
        if (syncDepth === 0) chatObserver?.disconnect();
        syncDepth++;
    };

    const resumeObserver = () => {
        syncDepth = Math.max(0, syncDepth - 1);
        if (syncDepth === 0 && !disposed) ensureChatObserver();
    };

    const restoreAll = () => {
        pendingNodes.clear();
        pauseObserver();
        try {
            for (const card of document.querySelectorAll('#chat > .mes .auto-rewrite-pre-fold')) {
                unwrapCard(card);
            }
        } finally {
            resumeObserver();
        }
    };

    const queueNodeSync = mesNode => {
        if (disposed || !mesNode?.isConnected) return;
        pendingNodes.add(mesNode);
        if (frameId != null) return;
        frameId = requestAnimationFrame(() => {
            frameId = null;
            if (disposed) return;
            const batch = [...pendingNodes];
            pendingNodes.clear();
            for (const node of batch) {
                if (node.isConnected) syncMessageNode(node);
            }
        });
    };

    const ensureChatObserver = () => {
        if (disposed) return;
        const chat = document.getElementById('chat');
        if (!chat) {
            chatObserver?.disconnect();
            observedChat = null;
            return;
        }
        if (!chatObserver) {
            chatObserver = new MutationObserver(mutations => {
                if (disposed) return;
                let syncAll = false;
                for (const mutation of mutations) {
                    if (isInternalControlMutation(mutation)) continue;
                    if (mutation.target === observedChat) {
                        for (const node of mutation.addedNodes) {
                            if (node instanceof HTMLElement && node.matches('.mes')) queueNodeSync(node);
                            else if (node instanceof HTMLElement) syncAll = true;
                        }
                        continue;
                    }
                    if (mutation.type === 'attributes') {
                        const targetEl = mutation.target instanceof Element ? mutation.target : null;
                        const mesNode = targetEl?.matches?.('#chat > .mes') ? targetEl : targetEl?.closest?.('#chat > .mes');
                        if (mesNode) queueNodeSync(mesNode);
                        continue;
                    }
                    const targetEl = mutation.target instanceof Element ? mutation.target : mutation.target?.parentElement;
                    const mesNode = targetEl?.closest?.('#chat > .mes');
                    if (mesNode) queueNodeSync(mesNode);
                }
                if (syncAll) scheduleSync();
            });
        }
        if (observedChat !== chat) {
            chatObserver.disconnect();
            observedChat = chat;
        }
        if (syncDepth === 0) {
            chatObserver.observe(chat, CHAT_OBSERVER_OPTIONS);
        }
    };

    const buildFoldCard = ({ key, streaming, chars, pre }) => {
        const card = document.createElement('div');
        card.className = 'auto-rewrite-pre-fold';
        card.setAttribute(FOLD_ATTR, 'true');

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'auto-rewrite-pre-toggle';

        const iconWrap = document.createElement('span');
        iconWrap.className = 'auto-rewrite-pre-icon';
        const icon = document.createElement('i');
        icon.setAttribute('aria-hidden', 'true');
        iconWrap.append(icon);

        const title = document.createElement('span');
        title.className = 'auto-rewrite-pre-title';

        const count = document.createElement('span');
        count.className = 'auto-rewrite-pre-count';

        const hint = document.createElement('span');
        hint.className = 'auto-rewrite-pre-hint';

        const chevron = document.createElement('i');
        chevron.className = 'fa-solid fa-chevron-down auto-rewrite-pre-chevron';
        chevron.setAttribute('aria-hidden', 'true');

        toggle.append(iconWrap, title, count, hint, chevron);

        const panel = document.createElement('div');
        panel.className = 'auto-rewrite-pre-panel';
        const inner = document.createElement('div');
        inner.className = 'auto-rewrite-pre-panel-inner';

        pre.classList.add('auto-rewrite-pre-content');
        inner.append(pre);

        const collapseFoot = document.createElement('button');
        collapseFoot.type = 'button';
        collapseFoot.className = 'auto-rewrite-pre-collapse-foot';
        collapseFoot.innerHTML = '<i class="fa-solid fa-chevron-up" aria-hidden="true"></i><span>收回分析</span>';
        inner.append(collapseFoot);

        panel.append(inner);
        card.append(toggle, panel);

        const updateHeader = (nextStreaming, nextChars) => {
            const streamFlag = String(nextStreaming);
            if (card.dataset.streaming !== streamFlag) card.dataset.streaming = streamFlag;
            const nextIconClass = nextStreaming
                ? 'fa-solid fa-circle-notch fa-spin'
                : 'fa-solid fa-wand-magic-sparkles';
            if (icon.className !== nextIconClass) icon.className = nextIconClass;
            const nextTitle = nextStreaming ? '正在生成重写分析' : '重写思考与分析';
            if (title.textContent !== nextTitle) title.textContent = nextTitle;
            const formatted = formatChars(nextChars);
            if (count.textContent !== formatted) count.textContent = formatted;
            if (count.hidden !== !formatted) count.hidden = !formatted;
        };

        const flip = () => {
            const next = card.dataset.expanded !== 'true';
            expandedState.set(key, next);
            setCardExpanded(card, next);
        };

        toggle.addEventListener('click', event => {
            event.stopPropagation();
            flip();
        });
        collapseFoot.addEventListener('click', event => {
            event.stopPropagation();
            expandedState.set(key, false);
            setCardExpanded(card, false);
            toggle.focus({ preventScroll: true });
        });

        updateHeader(streaming, chars);
        setCardExpanded(card, expandedState.get(key) === true);
        card._updateHeader = updateHeader;
        return card;
    };

    const syncMessageNode = mesNode => {
        if (disposed || !(mesNode instanceof HTMLElement)) return;
        const mesText = mesNode.querySelector('.mes_block > .mes_text') ?? mesNode.querySelector('.mes_text');
        if (!mesText) return;

        pauseObserver();
        try {
            const settings = getSettings();
            if (!settings.foldPre) {
                restoreMessage(mesNode);
                return;
            }

            const index = Number(mesNode.getAttribute('mesid'));
            if (!Number.isInteger(index) || index < 0) return;

            const ctx = getContext();
            const message = ctx.chat?.[index];
            const activeJob = getActiveJob?.();
            if (!isRewrittenMessage(message, index, activeJob)) {
                restoreMessage(mesNode);
                return;
            }

            const rawText = message?.mes ?? '';
            const currentKey = keyOf(ctx);
            const swipeId = message?.swipe_id ?? 0;
            const isStreaming = Boolean(activeJob && !activeJob.cancelled && !activeJob.generationFinished
                && (activeJob.inplace ? index === activeJob.index : index > activeJob.index + 1));

            // First clean up any raw <pre>...<pre> nesting before folding.
            for (const rawPre of [...mesText.querySelectorAll('pre')]) {
                if (rawPre.closest('.auto-rewrite-pre-fold') || isCodeBlockPre(rawPre, rawText)) continue;
                unwrapNestedDoublePre(rawPre, rawText);
            }

            const blocks = [...mesText.querySelectorAll('pre')].filter(pre => {
                if (pre.closest('.auto-rewrite-pre-fold')) return true;
                return !isCodeBlockPre(pre, rawText);
            });

            blocks.forEach((pre, blockIndex) => {
                const key = stateKey(currentKey, index, swipeId, blockIndex);
                const chars = countChars(pre.textContent);
                const isTailOpen = isStreaming && blockIndex === blocks.length - 1
                    && !pre.nextElementSibling
                    && !CLOSED_PRE_RE.test(rawText);
                const existingCard = pre.closest('.auto-rewrite-pre-fold');
                if (existingCard) {
                    existingCard._updateHeader?.(isTailOpen, chars);
                    const wantExpanded = expandedState.get(key) === true;
                    if ((existingCard.dataset.expanded === 'true') !== wantExpanded) {
                        setCardExpanded(existingCard, wantExpanded);
                    }
                    return;
                }
                if (!pre.parentElement) return;
                const placeholder = document.createComment('auto-rewrite-pre-slot');
                pre.replaceWith(placeholder);
                const card = buildFoldCard({ key, streaming: isTailOpen, chars, pre });
                placeholder.replaceWith(card);
            });
        } finally {
            resumeObserver();
        }
    };

    const syncChat = () => {
        if (disposed) return;
        ensureChatObserver();
        const settings = getSettings();
        if (!settings.foldPre) {
            restoreAll();
            return;
        }
        pauseObserver();
        try {
            for (const mesNode of document.querySelectorAll('#chat > .mes')) {
                syncMessageNode(mesNode);
            }
        } finally {
            resumeObserver();
        }
    };

    const scheduleSync = () => {
        if (disposed) return;
        ensureChatObserver();
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
            scheduled = false;
            syncChat();
        });
    };

    const syncIndex = index => {
        if (disposed || !Number.isInteger(index)) return;
        const node = document.querySelector(`#chat > .mes[mesid="${index}"]`);
        if (node) syncMessageNode(node);
    };

    return {
        syncChat,
        scheduleSync,
        syncIndex,
        restoreAll,
        dispose() {
            disposed = true;
            if (frameId != null) {
                cancelAnimationFrame(frameId);
                frameId = null;
            }
            chatObserver?.disconnect();
            chatObserver = null;
            observedChat = null;
            pendingNodes.clear();
            for (const card of document.querySelectorAll('#chat > .mes .auto-rewrite-pre-fold')) {
                unwrapCard(card);
            }
            expandedState.clear();
        },
    };
}
