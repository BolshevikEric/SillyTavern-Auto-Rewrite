import { getContext } from '../../../extensions.js';
import { REVISION, keyOf } from './revisions.js';

const FOLD_ATTR = 'data-ar-pre-folded';
const UNCLOSED_DOUBLE_PRE_RE = /<pre\b[^>]*>([\s\S]*?)<pre\b[^>]*>/i;
const CLOSED_PRE_RE = /<\/pre>/i;
const PRE_TAG_RE = /<pre\b[^>]*>([\s\S]*?)(?:<\/pre>|(?=<pre\b)|$)/gi;

function countChars(text) {
    return String(text ?? '').replace(/\s+/g, '').length;
}

function formatChars(count) {
    if (!count) return '';
    return `${count.toLocaleString('zh-CN')} 字`;
}

function isCodeBlockPre(pre) {
    if (!(pre instanceof HTMLElement)) return true;
    // Standard Markdown fenced code blocks render as <pre><code class="...">...</code></pre>.
    // Keep those intact so rewrite folding never hides ordinary code snippets.
    const children = [...pre.children];
    return children.length === 1 && children[0].tagName === 'CODE'
        && !pre.childNodes.some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
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

export function createPreFoldManager({ getSettings, getActiveJob }) {
    const expandedState = new Map();
    const textObservers = new Map();
    let disposed = false;
    let scheduled = false;

    const stateKey = (chatKey, index, swipeId, blockIndex) => `${chatKey}|${index}|${swipeId}|${blockIndex}`;

    const setCardExpanded = (card, expanded) => {
        card.dataset.expanded = String(expanded);
        const toggle = card.querySelector('.auto-rewrite-pre-toggle');
        const hint = card.querySelector('.auto-rewrite-pre-hint');
        const panel = card.querySelector('.auto-rewrite-pre-panel');
        if (toggle) toggle.setAttribute('aria-expanded', String(expanded));
        if (hint) hint.textContent = expanded ? '点击收回' : '点击展开';
        if (panel) {
            panel.setAttribute('aria-hidden', String(!expanded));
            panel.inert = !expanded;
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

    const restoreAll = () => {
        for (const card of document.querySelectorAll('#chat > .mes .auto-rewrite-pre-fold')) {
            unwrapCard(card);
        }
        for (const obs of textObservers.values()) obs.disconnect();
        textObservers.clear();
    };

    const observeMesText = (mesNode, mesText) => {
        if (!mesText || textObservers.has(mesText)) return;
        let syncing = false;
        const observer = new MutationObserver(() => {
            if (disposed || syncing) return;
            syncing = true;
            queueMicrotask(() => {
                syncing = false;
                if (!disposed && mesNode.isConnected) syncMessageNode(mesNode);
            });
        });
        observer.observe(mesText, { childList: true, subtree: true, characterData: true });
        textObservers.set(mesText, observer);
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
            card.dataset.streaming = String(nextStreaming);
            icon.className = nextStreaming
                ? 'fa-solid fa-circle-notch fa-spin'
                : 'fa-solid fa-wand-magic-sparkles';
            title.textContent = nextStreaming ? '正在生成重写分析' : '重写思考与分析';
            const formatted = formatChars(nextChars);
            count.textContent = formatted;
            count.hidden = !formatted;
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

        observeMesText(mesNode, mesText);

        const currentKey = keyOf(ctx);
        const swipeId = message?.swipe_id ?? 0;
        const isStreaming = Boolean(activeJob && !activeJob.cancelled && !activeJob.generationFinished
            && (activeJob.inplace ? index === activeJob.index : index > activeJob.index + 1));

        // First clean up any raw <pre>...<pre> nesting before folding.
        for (const rawPre of [...mesText.querySelectorAll('pre')]) {
            if (rawPre.closest('.auto-rewrite-pre-fold') || isCodeBlockPre(rawPre)) continue;
            unwrapNestedDoublePre(rawPre, message?.mes);
        }

        const blocks = [...mesText.querySelectorAll('pre')].filter(pre => {
            if (pre.closest('.auto-rewrite-pre-fold')) return true;
            return !isCodeBlockPre(pre);
        });

        blocks.forEach((pre, blockIndex) => {
            const key = stateKey(currentKey, index, swipeId, blockIndex);
            const chars = countChars(pre.textContent);
            const isTailOpen = isStreaming && blockIndex === blocks.length - 1
                && !pre.nextElementSibling
                && !CLOSED_PRE_RE.test(message?.mes ?? '');
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
    };

    const syncChat = () => {
        if (disposed) return;
        const settings = getSettings();
        if (!settings.foldPre) {
            restoreAll();
            return;
        }
        for (const mesNode of document.querySelectorAll('#chat > .mes')) {
            syncMessageNode(mesNode);
        }
        // Prune observers for detached DOM nodes.
        for (const [node, obs] of textObservers) {
            if (!node.isConnected) {
                obs.disconnect();
                textObservers.delete(node);
            }
        }
    };

    const scheduleSync = () => {
        if (disposed || scheduled) return;
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
            restoreAll();
            expandedState.clear();
        },
    };
}
