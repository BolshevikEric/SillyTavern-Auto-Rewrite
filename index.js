import * as core from '../../../../script.js';
import { getContext } from '../../../extensions.js';
import { SWIPE_STATE } from '../../../constants.js';
import { hasPendingFileAttachment } from '../../../chats.js';
import { getRegexedString, regex_placement } from '../../regex/engine.js';
import { createRewriteUI } from './ui.js';
import { createModelRouting } from './model-routing.js';
import { ensureFeedbackLibrary, composedFeedback, rebindCharacter } from './feedback-library.js';
import { createBackgroundScheduler, disposeBackgroundDelays } from './background-scheduler.js';
import { mvuBusy, mvuFeedback, prepareMvu, resetMvuFeedback, finishMvu, syncMvuChat, waitMvuWindow } from './mvu-compat.js';
import { canRewriteInplace, prepareInplace, generateInplace, commitInplace, restoreInplace,
    recoverInplace, ownsInplace, updateInplacePrompts, clearInplacePrompts, getInplaceReply, rememberStoppedInplace } from './inplace-rewrite.js';
import { REVISION, TEMP, remember, collapse, restore, recover, markStaging, liveReply, showStaging, versionLink, jumpVersion, ownsTail, rememberStoppedFallback } from './revisions.js';

const KEY = 'rewrite_writer';
const RUNTIME = Symbol.for('st.auto-rewrite.standalone');
const DEFAULT_FEEDBACK = `上一轮正文我不太满意，请认真重写一遍。
不要只是简单润色、扩写或换词，而是真正找出上一稿中不自然、生硬、注水、刻板、媚{{user}}、无趣，以及存在逻辑或常识错误的地方，有针对性地改好。原本写得自然、有趣、合理的情节、台词和细节直接保留，不必为了重写而故意推翻。
---
### 一、重写时的基本原则（动手前先明确边界）
1. **只认既定事实，不受上一稿绑架**
   - 只需遵守此前正式确立的剧情事实、人物设定、世界观和用户明确提出的要求。
   - 上一稿你自己编造的事件、人物决定、心理解释和剧情走向，都不自动成为既定事实；局部有问题就改局部，底层逻辑有问题可以推倒重来。
2. **优先直接删，别急着找替代品**
   - 发现一句台词很尬、一段心理很假、一处生活细节多余，或一段暗示{{user}}特殊的描写缺乏依据时，先判断“人物在这里是不是根本没必要说话/想这些”，很多时候直接删掉比硬换一句更好。
3. **改病根，不要只换表面壳子**
   - 如果上一稿为了凑出预定剧情显得像事先排练（比如强行让爸爸打牌、妈妈买菜、弟弟上网，再借送苹果登门独处），不要只把“打牌换成上班、苹果换成粉条”。用户已经指定的场景条件直接接受即可，不必强行交代每个无关人员的去向。
4. **不矫枉过正，绝不走另一个极端**
   - 指出某种写法有问题，不代表全面禁止这种写法，也不代表反着写就对了：
     - 反对强行写心理，不等于删光心理；反对台词注水，不等于全改成极短句或沉默；
     - 反对人物脸谱化，不等于硬造性格反差；反对媚{{user}}，不等于刻意打压{{user}}或压制合理的好感。
   - 不要为了证明自己看懂了某条规则，就特意安排对应的台词、心理或反套路剧情。
5. **顺手修复逻辑与常识错误**
   - 一并检查并修正上一稿中涉及人物台词、心理、行为的时间线漏洞、前后矛盾或生活常识错误。
---
### 二、正文写作核心要求（一切服从“此刻这个具体的人”）
#### 1. 人物是活人，不是性格标签，也不是背景解说员
- 动笔前先想清楚：**人物此刻正在经历什么、最在意什么、想做什么**，再决定要不要写对话、心理或细节。没有想说的话就不必开口，没有具体念头就不必硬写心理。
- 性格会影响言行，但当下的情绪、身体状态、突发处境和面对的对象同样会改变一个人的表现。平时爱贫嘴的人遇上急事也会闭嘴，傲慢的人在熟人面前也可能随和，温柔的人也可能发脾气。不要按 MBTI、职业、性别、出身套固定公式。
- 社会时代与身份背景应自然体现在人物的见识、习惯和用词里，不要让人物动不动就分析阶级差异、城乡差距或时代处境。
#### 2. 严禁无依据地媚{{user}}、刻意凸显其特殊性
- **不美化、不拉踩、不洗白**：不要把{{user}}的普通行为或缺点拔高（沉默不等于沉稳，冷漠不等于神秘，粗鲁不等于率真）；不要通过贬低他人、情敌或原有伴侣来衬托{{user}}；不要替{{user}}的过错找借口，也不要把{{user}}的主观猜测或自我辩解写成客观事实。
- **严禁虚构他人过去的情感缺失**：其他人物在认识{{user}}之前本就拥有完整的人生，可能有疼爱自己的家人、要好的朋友或体贴的伴侣。严禁使用“从来没有人这样对待过她”“已经很久没人真正关心她了”“他和以前认识的人都不一样”等套路，也不要用突兀的愣神、心头一暖、手指收紧强行暗示心动或自动刷好感。
  - *反例*：{{user}}提醒有黑眼圈的女明星早点睡，她突然手指收紧，心想这两年身边人只催她赶通告，很久没人这样关心过她了。
  - *正解*：她可能早就听腻了这种提醒，完全可以随口应一声、觉得对方挺热心、觉得多管闲事，或者根本没放在心上。只有当双方已有充分的过往经历和情感依据时，感动与偏爱才自然成立。
- **尊重角色控制权与意愿独立**：不要擅自替{{user}}决定未经授权的言行和心理。区分“用户作为创作者下达的剧情要求”与“{{user}}作为角色提出的愿望”——角色提请求，不代表对方必须答应。
#### 3. 剧情从实际处境推演，不先定结果再找理由
- 人物会怎么回应（比如借不借钱、答不答应帮忙），要由他原有的经济状况、性格、当下处境和两人真实关系自然决定，而不是为了达成某个结果，临时给他补一段“刚发工资、手头宽裕、特别重感情”的设定。
- 配角有自己的生活、日程和重心，不是专门用来制造冲突、腾出空间或助攻感情的工具人。但也不要为了显得人物独立，就刻意让他们拒绝或唱反调，有依据的配合完全正常。
#### 4. 台词要像人物自己想说的话，拒绝“辩论赛”与“解释机”
- 说话服从人物各自当下的交流目的（要结果、发泄情绪、敷衍、告知），不要把所有对话都写成逻辑严密、有来有回的辩论或相声。人物可以沉默、打断、重复、忽略、答非所问，或根本不想聊下去，但对话之间仍需具备基本的语义逻辑联系（不要莫名其妙接一句毫不相干的反击）。
- 不要为了让人物显得机灵或嘴硬，就让他每次都占语言上风；少用模板化的反问、讽刺和“你是不是非要……”“说得轻巧……”等攻击性套话；不要借人物的嘴逐一排除顾虑、替作者解释剧情。
  - *反例（像在开会辩论）*：“你把车借别人，有没有考虑我明天上班？”“他晚上就还，不影响你上班。”“万一不还呢？明天你送我？”“真不还我肯定想办法。”
  - *正解（车主只想把车要回来）*：“我车呢？”“借小周了。”“谁让你借的？”“他说晚上就还。”“你给他打电话，让他现在送回来。”“干嘛呀……”“打电话。”
- 口语化、加脏话或方言救不了本身就很假的话；同时，人物真想认真解释或聊得投机时，也可以自然说长句、聊很久。
#### 5. 心理描写写具体念头，拒绝空泛情绪、流水账与机械注水
- **写具体想法，不当情绪翻译器**：别只用“心跳加速、难以言喻的恐惧/焦虑”概括，也别让人物像心理学家一样精准剖析自己。写出他当下真正在意的具体顾虑、记忆，或直白、幼稚、混乱的念头；如果脑子一片空白或没想法，就简写。
  - *反例*：他紧紧攥着检查单，指节发白，心跳越来越快，一股难以言喻的恐惧涌上心头，怎么也冷静不下来。
  - *正解*：他倒不是怕疼，是上个月刚交了三千多房租，卡里剩下的钱连两个月生活费都不够。真要住院怎么跟家里说？他妈那脾气，估计当天就得买票赶来。
- **不重复解释读者已经看懂的事**：台词和动作已经把情绪表露清楚时，旁白不要再翻译一遍；只有能提供新信息或反转理解的心理才值得补写。
- **去流水账、去套话、破除机械排版**：
  - 合并无意义的分解动作（喝水直接写“他起身喝了口水”）；不要堆砌同义的紧张反应，避开默认套话（喉结滚动、指节发白、嘴角勾起、眼神闪烁、耳根发烫、心里咯噔一下）。
  - 生活细节贵在贴合当下（如随手拍两下没电的遥控器、老人把掉桌上的米粒捡起来吃），不要为了“有生活气”硬塞一串物品品牌、价格和家常菜清单。
  - 打破每段固定“动作+台词+心理解释”的套路。不为凑字数或台词占比硬加废话，该短就短，说到自然的位置即可收尾，不必每次结尾都总结关系、升华主题或硬留悬念。
#### 6. 成年亲密 / NSFW 剧情专项要求（仅当本轮涉及亲密剧情时适用）
- **人物与关系不断裂**：进入nsfw场景后，人物原有的语言习惯、性格特点和双方过往关系必须延续，不能突然切进谁都能套用的通用模板；但也不要为了避免模板化，在气氛不合时强行安排日常斗嘴、闲聊或琐事思考。
- **感官与内心并重**：采用露骨直白色情的描写写法，正常保留身体感受，但绝不能通篇只剩动作反应和“紧张、羞耻、兴奋”等空泛情绪词。要写出这个具体的人如何从自身角度理解当下——涉及双方关系、过往记忆、自尊、喜好或对眼前人的具体看法。增加深入的心理刻画。
  - *反例*：她心跳得很快，既紧张又害羞，心中涌起一股难以言喻的甜蜜。
  - *正解（多年好友刚确立关系初次接吻）*：她原先还担心谈了恋爱反倒没以前自在，刚才听他问能不能吻她时差点笑出来——认识六年，还是头一回见他说话这么没底气。
- **不借亲密戏媚{{user}}**：不要擅自虚构“前所未有的体验”，也不要通过贬低对方过往经历或前任来抬高{{user}}。
直接输出完整的新正文，不要输出审稿分析、重写计划或任何正文之外的内容。最终以普通读者读起来自然、可信、生动为唯一标准。`;
const PREVIOUS_DEFAULT_FEEDBACKS = [
    `上一轮正文由一个更弱的模型进行创作，现在由你进行重写。分析的结构应该是先找问题，分析角色要分析每个在场重要角色，最后只用一两句写该如何纠正并确保重写的时候应用
在<content>之前先进行分析
1. 上一轮正文中，参考整体剧情，人设以及对现实生活的常识，分析角色的反应，情绪，心理活动有没有不合理的地方？（1000字）
2. 上一轮正文中，角色有没有出现不合理的或者是比较尬比较怪的台词？（800字）
3. 对于在场角色的刻画，是否过于脸谱化和单薄？（600字）
4. 在保证剧情精彩有吸引力的情况下设计重写方案，300字`,
    `上一轮正文需要重写。注意，重写不是优化，可以在遵守user输入的剧情指导前提下，选择和上一轮正文完全不一样的行为和剧情。分析的结构应该是先找问题，分析角色要分析每个在场重要角色，最后只用一两句写该如何纠正并确保重写的时候应用
在正文前之前先进行分析，使用<pre>...</pre>标签包裹分析内容
分析以下几点：
1. 上一轮正文中，回顾整体剧情，人设，常识，思考角色的反应，情绪，心理活动和所作所为是否是合理的，符合常识逻辑的，不ooc的，是否有刻画过于用力的情况，是否有过于脸谱化刻板，从而失去了真人活人感？（1000字）
2. 上一轮正文中，角色的台词是否足够自然？读起来怪吗？有出现那种一大坨一大坨的台词吗？（500字）
3. 对于在场角色们的心理刻画，是否过于单薄没有深度？（300字）
3. 文风是否过度描写？有没有很多莫名其妙的细节描写？ai味是否太重？是否符合要求（300字）
4. 重写方案，400字`,
    `上一轮正文需要重写。注意，重写不是优化，可以在遵守user输入的剧情指导前提下，选择和上一轮正文完全不一样的行为和剧情。
在<content>之前先进行分析
分析以下三点：
1. 上一轮正文中，回顾整体剧情，人设，常识，思考角色的反应，情绪，心理活动和所作所为是否是合理的，符合常识逻辑的，不ooc的，是否有刻画过于用力的情况，是否有过于脸谱化刻板，从而失去了真人活人感？（1000字）
2. 上一轮正文中，角色的台词是否足够自然？读起来怪吗？有出现那种一大坨一大坨的台词吗？（500字）
3. 对于在场角色们的心理刻画，是否过于单薄没有深度？（300字）
3. 文风是否过度描写？有没有很多莫名其妙的细节描写？ai味是否太重？（300字）
4. 重写方案，400字

分析的结构应该是先找问题，分析角色要分析每个在场重要角色，最后只用一两句写该如何纠正并确保重写的时候应用`,
    `上一轮正文需要重写
在<content>之前先进行2000字左右的分析，问自己几个问题，在场角色的所作所为和心理合理吗？台词看起来够自然吗，有没有很尬很怪的台词？角色塑造够优秀吗？剧情够精彩吗？文风够让读者满意吗？`,
    `上一轮正文剧情写的太烂了，角色们（不局限于{{user}}）的言行举止刻画的很烂，角色们的心理刻画很烂毫无深度可言，又肤浅又烂，台词很烂。那些优秀的网文角色塑造，哪个不是吊打你这破内容。剧情很烂。文风很烂。烂完了!  重写！

写本轮正文前，先用<prex>...</prex>做一次预分析，挑出上一轮的问题。</prex>后空一行，再写<content>。

分析不少于2000字

每部分最后用一两句写出"本轮改法"。正文要照着这些改法写，不能分析完了照旧。`,
];
let installed = false;
let ui;
let cycle;
let pending;
let running;
let scheduler;
let sequence = 0;
let mvuReadyAt = 0;
let status = '等待下一次生成';
const subscriptions = [];
const quickDrafts = new Map();

function getQuickDraft(key = chatKey()) {
    let draft = quickDrafts.get(key);
    if (!draft) {
        draft = { text: '', mode: 'append', open: false };
        quickDrafts.set(key, draft);
    }
    return draft;
}

function updateQuickDraft(patch = {}) {
    const draft = getQuickDraft();
    if (typeof patch.text === 'string') draft.text = patch.text;
    if (patch.mode === 'append' || patch.mode === 'replace') draft.mode = patch.mode;
    if (typeof patch.open === 'boolean') draft.open = patch.open;
    ui?.refresh();
}
const routing = createModelRouting();

function settings() {
    const all = getContext().extensionSettings;
    if (!all[KEY] || typeof all[KEY] !== 'object') all[KEY] = {};
    let changed = false;
    if (typeof all[KEY].auto !== 'boolean') all[KEY].auto = false;
    if (typeof all[KEY].feedback !== 'string' || PREVIOUS_DEFAULT_FEEDBACKS.includes(all[KEY].feedback)) {
        all[KEY].feedback = DEFAULT_FEEDBACK;
        changed = true;
    }
    if (typeof all[KEY].profileId !== 'string') all[KEY].profileId = '';
    if (typeof all[KEY].model !== 'string') all[KEY].model = '';
    if (ensureFeedbackLibrary(all[KEY])) changed = true;
    for (const entry of all[KEY].feedbackEntries ?? []) {
        if (entry && typeof entry.content === 'string' && PREVIOUS_DEFAULT_FEEDBACKS.includes(entry.content)) {
            entry.content = DEFAULT_FEEDBACK;
            changed = true;
        }
    }
    if (changed) getContext().saveSettingsDebounced();
    return all[KEY];
}

function chatKey(ctx = getContext()) {
    return `${ctx.groupId ?? ''}|${ctx.characterId ?? ''}|${ctx.getCurrentChatId() ?? ''}`;
}

function isSingleChat(ctx) {
    return !ctx.groupId && ctx.characterId != null;
}

function composerBusy() {
    return Boolean(document.getElementById('send_textarea')?.value.trim()) || hasPendingFileAttachment();
}

function rewriteBlocker(ctx = getContext()) {
    if (core.isChatSaving) return '正在保存聊天';
    const stream = ctx.streamingProcessor;
    if (stream?.isFinished || stream?.isFinalizing || stream?.isStopped) return '正在完成回复收尾';
    if (core.is_send_press || stream) return '正在生成回复';
    if (core.swipeState === SWIPE_STATE.SWIPING) return '正在切换回复版本';
    if (core.swipeState === SWIPE_STATE.EDITING
        || document.querySelector('#chat :is(.edit_textarea, .reasoning_edit_textarea, .mes_edit_textarea)')) return '正在编辑消息';
    if (mvuBusy()) return '正在解析 MVU 变量';
    return '';
}

function isIdle(ctx = getContext()) {
    return !rewriteBlocker(ctx);
}

function setStatus(text) {
    status = text;
    ui?.refresh();
}

function clearPending() {
    scheduler?.cancel();
    cycle?.notice?.finish(false);
    if (cycle) cycle.notice = null;
    pending = null;
}

const beginNotice = () => globalThis[Symbol.for('st.generation-notifications.sequence.v1')]?.begin?.() ?? null;

function matches(attempt, ctx = getContext(), checkText = true) {
    const last = ctx.chat.at(-1);
    return chatKey(ctx) === attempt.key && isSingleChat(ctx)
        && last === attempt.message && !last.is_user && !last.is_system
        && ctx.chat.length - 1 === attempt.index
        && (last.swipe_id ?? 0) === attempt.swipeId && (!checkText || last.mes === attempt.text);
}

function latestReply(ctx = getContext()) {
    const message = ctx.chat.at(-1);
    if (!isSingleChat(ctx) || !message || message.is_user || message.is_system || !message.mes?.trim() || message.mes.trim() === '...') return null;
    return { key: chatKey(ctx), index: ctx.chat.length - 1, message, text: message.mes, swipeId: message.swipe_id ?? 0 };
}

function view() {
    const ctx = getContext();
    const reply = running && chatKey(ctx) === running.key && ctx.chat[running.index] === running.source
        ? liveReply(running) ?? { ...running.attempt, message: running.source, preview: !running.cancelled } : latestReply(ctx);
    const saved = reply?.message.extra?.[REVISION];
    const blocker = rewriteBlocker(ctx);
    // The native target swipe may be one past the array end until the first
    // response. The native history picker uses the saved versions.
    const waiting = Boolean(manualWait && reply && manualWait.key === reply.key && manualWait.index === reply.index);
    const busyComposer = composerBusy();
    return { reply, link: running ? null : versionLink(reply), status, busy: Boolean(running), cancelled: Boolean(running?.cancelled),
        stopping: Boolean(running?.stopRequested), stopped: Boolean(saved?.stopped),
        networkLabelAtStart: running?.networkLabelAtStart,
        receiving: Boolean(running?.generating && !running.generationFinished && !running.replyReceived && !running.stopRequested && !running.cancelled),
        canBrowse: Boolean(running && !running.cancelled && chatKey(ctx) === running.key && ctx.chat[running.index] === running.source),
        idle: !blocker, canRewrite: !running && !busyComposer && (!blocker || blocker === '正在保存聊天'),
        waiting, waitingReason: waiting ? manualWait.blocker : '',
        blocker, composerBusy: busyComposer, timing: running?.timing ?? saved?.timing,
        quick: { ...getQuickDraft(reply?.key ?? chatKey(ctx)) } };
}

async function openVersions() {
    const job = running;
    if (!job || !sameJob(job) || getContext().chat[job.index] !== job.source) return;
    try {
        const { openReadOnlySwipePicker } = await import('../../../swipe-picker.js');
        if (typeof openReadOnlySwipePicker !== 'function') {
            globalThis.toastr?.info('当前酒馆版本未提供生成期间的原生版本记录。');
            return;
        }
        if (!sameJob(job) || getContext().chat[job.index] !== job.source) return;
        const swipes = job.original.swipes?.length ? [...job.original.swipes] : [job.original.mes];
        swipes[job.attempt.swipeId] = job.attempt.text;
        await openReadOnlySwipePicker(job.index, { ...job.original, swipes, swipe_id: job.attempt.swipeId }, { depth: 0 });
    } catch (error) {
        console.warn('[Auto Rewrite] Opening version history', error);
        globalThis.toastr?.warning('未能打开原生版本记录。');
    }
}

let manualWaitId = 0;
let manualWait = null;

async function manualRewrite(attempt) {
    if (running) return;
    const ctx = getContext();
    let reply = latestReply(ctx);
    if (!reply) {
        ui?.refresh();
        return;
    }
    if (attempt && (attempt.key !== reply.key || attempt.index !== reply.index)) {
        ui?.refresh();
        return;
    }
    if (composerBusy()) {
        globalThis.toastr?.info('请先发送或清空输入框中的草稿与附件。');
        ui?.refresh();
        return;
    }
    if (manualWait && manualWait.key === reply.key && manualWait.index === reply.index && manualWait.swipeId === reply.swipeId) {
        return;
    }
    const waitId = ++manualWaitId;
    const transient = new Set(['正在保存聊天', '正在完成回复收尾', '正在切换回复版本']);
    let blocker = rewriteBlocker(ctx);
    const startedAt = Date.now();
    try {
        while (blocker && transient.has(blocker) && Date.now() - startedAt < (blocker === '正在保存聊天' ? 15000 : 4000)) {
            manualWait = { id: waitId, key: reply.key, index: reply.index, swipeId: reply.swipeId, blocker };
            ui?.refresh();
            await new Promise(resolve => setTimeout(resolve, 100));
            if (!installed || running || waitId !== manualWaitId) return;
            const nextCtx = getContext();
            const nextReply = latestReply(nextCtx);
            if (!nextReply || nextReply.key !== reply.key || nextReply.index !== reply.index || composerBusy()) {
                return;
            }
            reply = nextReply;
            blocker = rewriteBlocker(nextCtx);
        }
    } finally {
        if (manualWait?.id === waitId) {
            manualWait = null;
            ui?.refresh();
        }
    }
    if (!installed || running || waitId !== manualWaitId) return;
    if (blocker) {
        globalThis.toastr?.info(`${blocker}，请稍后再试。`);
        ui?.refresh();
        return;
    }
    clearPending();
    if (cycle) cycle.attempted = true;
    void rewrite(reply, false);
}

async function jump(attempt, target) {
    if (!attempt || running || !isIdle() || !matches(attempt)) return;
    clearPending();
    try { await jumpVersion(attempt, target); }
    catch (error) { console.error('[Auto Rewrite] Version switch', error); globalThis.toastr?.warning('版本切换未完成，请等保存结束后重试。'); }
    finally { ui?.refresh(); }
}

function subscribe(type, handler) {
    if (!type) return;
    const ctx = getContext();
    ctx.eventSource.on(type, handler);
    subscriptions.push([type, handler]);
}

function queue() {
    if (!installed || !settings().auto || !pending || running) return;
    scheduler?.request();
}

function drainQueue() {
    if (!installed || !settings().auto || !pending || running) return;
    const attempt = pending;
    const ctx = getContext();
    if (!cycle || cycle.id !== attempt.cycleId || cycle.attempted || !matches(attempt, ctx, false)) {
        clearPending();
        setStatus('聊天或回复已变化，已取消本次自动重写');
        return;
    }
    const blocker = rewriteBlocker(ctx);
    if (blocker) { setStatus(blocker); scheduler?.retry(); return; }
    if (composerBusy()) { setStatus('输入框有草稿或附件，暂缓自动重写'); scheduler?.retry(); return; }
    // Capture the finalized text after receive/render handlers and MVU's
    // extra-model parsing, rather than before their status/variable additions.
    attempt.text = attempt.message.mes;
    if (!attempt.text?.trim() || attempt.text.trim() === '...') { clearPending(); return; }
    cycle.attempted = true;
    const notice = cycle.notice;
    cycle.notice = null;
    clearPending();
    void rewrite(attempt, true, notice);
}

function sameJob(job) {
    return installed && running === job && !job.cancelled && chatKey() === job.key;
}

function stoppedReply(job) {
    if (job.inplace) return getInplaceReply(job);
    if (!ownsTail(job)) return null;
    const ctx = getContext();
    for (let index = ctx.chat.length - 1; index > job.index + 1; index--) {
        const message = ctx.chat[index];
        if (!message.is_user && !message.is_system && message.mes?.trim() && message.mes.trim() !== '...') return message;
    }
    return null;
}

function appendFeedback(ctx, text, job) {
    // Keep the original assistant text as the draft being reviewed. MVU variables
    // are temporarily rebased separately, without changing the saved draft text.
    const message = {
        name: ctx.name1,
        is_user: true,
        is_system: false,
        send_date: new Date().toISOString(),
        mes: ctx.substituteParams(getRegexedString(text, regex_placement.USER_INPUT)),
        extra: { [TEMP]: { id: job.id, sourceIndex: job.index } },
    };
    if (!message.mes.trim()) throw new Error('修改意见被用户输入正则清空');
    remember(job);
    const avatar = core.user_avatar;
    if (avatar && Object.hasOwn(ctx.powerUserSettings?.personas ?? {}, avatar)) {
        message.force_avatar = ctx.getThumbnailUrl('persona', avatar);
    }
    const index = ctx.chat.length;
    ctx.chat.push(message);
    if (ctx.chatMetadata) ctx.chatMetadata.tainted = true;
    ctx.addOneMessage(message, { scroll: false });
    return { message, index };
}

async function rewrite(attempt, automatic = true, notice = null) {
    if (running) { notice?.finish(false); return; }
    const ctx = getContext();
    const quick = getQuickDraft(attempt.key);
    const quickText = quick.text.trim();
    const quickMode = quick.mode === 'replace' ? 'replace' : 'append';
    const baseFeedback = composedFeedback(settings()).text;
    const feedback = quickText
        ? (quickMode === 'replace' || !baseFeedback
            ? quickText
            : `${baseFeedback}

【本轮即时修改意见（最高优先级）】
${quickText}`)
        : baseFeedback;
    if (!feedback) { notice?.finish(false); setStatus('当前没有生效的修改意见，请启用条目或填写即时意见'); ui?.openLibrary(); return; }
    if (!matches(attempt, ctx) || !isIdle(ctx) || composerBusy()) { notice?.finish(false); return; }
    const now = Date.now();
    const firstStarted = Date.parse(attempt.message.gen_started);
    const job = { id: `rewrite-${now.toString(36)}-${Math.random().toString(36).slice(2)}`,
        key: attempt.key, index: attempt.index, attempt, source: attempt.message,
        original: structuredClone(attempt.message), prefix: ctx.chat.slice(0, attempt.index),
        cancelled: false, generating: false, automatic, notice: notice ?? beginNotice(), quickUsedText: quickText,
        timing: { startedAt: automatic && Number.isFinite(firstStarted) ? Math.min(firstStarted, now) : now, rewriteStartedAt: now } };
    running = job;
    setStatus('正在准备重写');
    try {
        prepareMvu(job);
        const instruction = feedback + (job.mvu?.active ? mvuFeedback : '');
        if (canRewriteInplace()) {
            await prepareInplace(job, instruction);
        } else {
            const { message, index } = appendFeedback(ctx, instruction, job);
            job.feedback = message;
            resetMvuFeedback(job);
            markStaging(job);
            await ctx.saveChat();
            if (!sameJob(job) || getContext().chat.at(-1) !== message) throw new Error('重写已取消或聊天已变化');
            await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_SENT, index);
            if (!sameJob(job) || getContext().chat.at(-1) !== message) throw new Error('重写已取消或聊天已变化');
            await ctx.eventSource.emit(ctx.eventTypes.USER_MESSAGE_RENDERED, index);
            if (!sameJob(job) || getContext().chat.at(-1) !== message) throw new Error('重写已取消或聊天已变化');
            resetMvuFeedback(job);
        }
        if (!sameJob(job)) throw new Error('重写已取消或聊天已变化');
        if (composerBusy()) {
            throw new Error('输入框中出现了新草稿或附件，本次重写已停止');
        }
        if (job.mvu?.active) {
            setStatus('等待 MVU 解析窗口');
            await waitMvuWindow(mvuReadyAt, () => sameJob(job) && (job.inplace ? ownsInplace(job) : getContext().chat.at(-1) === job.feedback));
            if (composerBusy()) throw new Error('输入框中出现了新草稿或附件，本次重写已停止');
        }
        // Keep the native event/tool pipeline. CC uses the real swipe handler;
        // older/non-CC installations retain the ordinary-turn fallback.
        job.route = routing.acquire({ ...settings() }, () => sameJob(job) && job.generating && !mvuBusy());
        job.networkLabelAtStart = document.querySelector('#generation_network_status > [role="status"]');
        job.generating = true;
        setStatus(`${automatic ? '正在自动重写' : '正在重写'} · ${job.route.label}`);
        let last;
        try {
            if (job.inplace) last = await generateInplace(job);
            else { await getContext().generate('normal', { automatic_trigger: true }); last = getContext().chat.at(-1); }
        } catch (error) {
            if (!job.stopRequested || !job.stoppedDraft || !sameJob(job)) throw error;
        } finally {
            job.generationFinished = true;
        }
        if (job.stopRequested && job.stoppedDraft) last = job.stoppedDraft;
        if (!sameJob(job)) throw new Error('重写已取消或聊天已变化');
        if (!last || (!job.inplace && last === job.source) || last.is_user || last.is_system || !last.mes?.trim() || last.mes.trim() === '...') throw new Error('未收到可用的重写正文');
        if (!job.stopRequested) setStatus(job.mvu?.active ? '正在整理重写稿的 MVU 变量' : '正在保存重写稿');
        await finishMvu(job, last, () => sameJob(job) && (job.inplace ? ownsInplace(job)
            : job.stopRequested ? ownsTail(job) : getContext().chat.at(-1) === last));
        job.timing.finishedAt ??= Date.now();
        if (job.inplace) await commitInplace(job, last);
        else await collapse(job, last);
        job.completed = true;
        if (!job.stopRequested && !job.cancelled && job.quickUsedText) {
            const currentQuick = getQuickDraft(job.key);
            if (currentQuick.text.trim() === job.quickUsedText) {
                currentQuick.text = '';
                currentQuick.open = false;
            }
        }
        setStatus(job.stopRequested ? '已停止，当前重写稿已保留，原稿仍在上一版' : '重写已完成，原稿已保存为上一版');
        if (job.mvuPending) {
            globalThis.toastr?.info(job.stopRequested
                ? '重写稿已保留；变量尚未解析完成，暂沿用本轮初始状态，请在正文完整后重新解析变量。'
                : '重写稿已保留；未收到新的 MVU 变量快照，已暂沿用本轮初始变量，如需更新请手动重新解析变量。');
        }
    } catch (error) {
        job.timing.finishedAt ??= Date.now();
        if (!job.settled && job.stopRequested && job.stoppedDraft && sameJob(job)) {
            // Keep the stopped reply and its recovery receipt if a save/listener
            // fails. A post-processing error must never discard received prose.
            setStatus('已停止，重写稿已保留，收尾未完成；请保留正文并刷新恢复');
            globalThis.toastr?.warning(status);
        } else if (!job.settled) {
            const restored = await (job.inplace ? restoreInplace(job) : restore(job)).catch(cleanupError => { console.error('[Auto Rewrite] Cleanup', cleanupError); return false; });
            if (installed && chatKey() === job.key) {
                setStatus(restored ? job.cancelled ? '重写已取消，原稿已恢复' : '重写未完成，原稿已保留' : '聊天已变化，保留记录供检查，未覆盖新内容');
                if (!job.cancelled) globalThis.toastr?.warning(`${status}：${error.message}`);
            }
        } else if (installed && chatKey() === job.key) {
            setStatus('回复版本已保留，保存或界面更新未完成');
            globalThis.toastr?.warning(status);
        }
        if (!job.cancelled) console.error('[Auto Rewrite]', error);
    } finally {
        clearInplacePrompts(job);
        job.route?.release();
        job.notice?.finish(Boolean(job.completed && !job.cancelled && !job.stopRequested));
        showStaging();
        if (running === job) running = null;
        ui?.sync();
        ui?.refresh();
    }
}

async function recoverInterrupted() {
    if (!installed || running || !isIdle()) return;
    try {
        const inplace = await recoverInplace();
        const recovered = inplace || await recover();
        if (recovered === 'stopped') setStatus('已恢复停止时保留的重写稿，原稿仍在上一版');
        else if (recovered) setStatus('已清理中断的重写，原稿已恢复');
    }
    catch (error) { console.error('[Auto Rewrite] Recovery', error); }
    ui?.refresh();
}

export function enable() {
    if (installed) return;
    globalThis[RUNTIME]?.disable?.();
    installed = true;
    scheduler = createBackgroundScheduler(drainQueue);
    globalThis[RUNTIME] = { disable };
    const { eventTypes: events } = getContext();
    ui = createRewriteUI({ getSettings: settings, getView: view, onVersions: openVersions, onRewrite: manualRewrite, onJump: jump,
        getRouting: () => routing.describe(settings()),
        onRoute: value => { Object.assign(settings(), value); getContext().saveSettingsDebounced(); },
        onRefreshModels: signal => routing.refreshModels({ ...settings() }, signal),
        onMainProfile: id => { routing.setMainProfile(id); ui?.sync(); ui?.refresh(); },
        onMainModel: model => { routing.setMainModel(model); ui?.sync(); ui?.refresh(); },
        onRefreshMainModels: signal => routing.refreshModels({ profileId: '', model: '' }, signal),
        onMutation: () => markStaging(running),
        onAuto: value => {
            settings().auto = value; getContext().saveSettingsDebounced();
            if (!value) clearPending();
            if (!running) setStatus(value ? '等待下一次生成' : '自动重写已关闭');
        },
        onQuickChange: updateQuickDraft,
        onLibraryChange: () => { getContext().saveSettingsDebounced(); } });
    ui.install();
    subscribe(events.APP_READY, () => { ui?.install(); void recoverInterrupted(); });
    subscribe(events.SETTINGS_LOADED, () => { ui?.sync(); ui?.refresh(); });
    for (const type of [events.CONNECTION_PROFILE_CREATED, events.CONNECTION_PROFILE_UPDATED,
        events.CONNECTION_PROFILE_DELETED, events.CONNECTION_PROFILE_LOADED,
        events.CHATCOMPLETION_MODEL_CHANGED, events.SETTINGS_UPDATED,
        events.OAI_PRESET_CHANGED_AFTER, events.PRESET_CHANGED, events.CHARACTER_DELETED]) {
        if (type) subscribe(type, () => { ui?.sync(); ui?.refresh(); });
    }
    subscribe(events.CHARACTER_RENAMED, (oldAvatar, newAvatar) => {
        if (rebindCharacter(settings(), oldAvatar, newAvatar)) getContext().saveSettingsDebounced();
        ui?.sync(); ui?.refresh();
    });
    subscribe(events.GENERATION_STARTED, (type, options, dryRun) => {
        if (dryRun) return;
        // An MVU extra-model request belongs to the active turn, not a new
        // user generation that should take over or invalidate the rewrite.
        if (mvuBusy()) { if (running?.inplace) clearInplacePrompts(running); return; }
        if (running) {
            if (running.inplace) {
                if (type === 'quiet') { clearInplacePrompts(running); return; }
                const rootSwipe = running.awaitingNativeSwipe && !running.nativeStarted && type === 'swipe';
                const toolContinuation = running.nativeStarted && type === 'normal' && ownsInplace(running)
                    && getContext().chat.slice(running.index + 1).some(m => Array.isArray(m.extra?.tool_invocations));
                if (rootSwipe || toolContinuation) {
                    running.replyReceived = false;
                    running.nativeStarted = true;
                    updateInplacePrompts(running, type);
                    return;
                }
            }
            // Another extension started a request while feedback events were firing.
            if (!running.generating || !options?.automatic_trigger) { running.cancelled = true; running.timing.finishedAt ??= Date.now(); setStatus('已由其他生成流程接管'); }
            return;
        }
        clearPending();
        cycle = { id: ++sequence, key: chatKey(), attempted: false,
            eligible: [undefined, 'normal', 'regenerate', 'swipe'].includes(type) && isSingleChat(getContext()) };
        ui?.refresh();
    });
    subscribe(events.MESSAGE_RECEIVED, (id, type) => {
        if (running?.generating && !running.generationFinished && !running.stopRequested
            && type !== 'quiet' && sameJob(running) && Number(id) === getContext().chat.length - 1
            && (running.inplace ? ownsInplace(running) : ownsTail(running))) {
            running.replyReceived = true;
            setStatus(mvuBusy() ? '正文已收到，正在解析 MVU 变量' : '正文已收到，正在完成酒馆收尾');
        }
        markStaging(running); ui?.refresh();
        if (running || !settings().auto || !cycle?.eligible || cycle.attempted || type === 'first_message') return;
        const ctx = getContext();
        const stream = ctx.streamingProcessor;
        if (stream?.isStopped || stream?.abortController?.signal.aborted) return;
        const message = ctx.chat.at(-1);
        const text = message?.mes;
        if (chatKey(ctx) !== cycle.key || Number(id) !== ctx.chat.length - 1 || !message
            || message.is_user || message.is_system || !text?.trim() || text.trim() === '...') return;
        pending = { cycleId: cycle.id, key: cycle.key, index: Number(id), message, text, swipeId: message.swipe_id ?? 0 };
        cycle.notice ??= beginNotice();
        queue();
    });
    subscribe(events.GENERATION_ENDED, () => {
        if (!running) mvuReadyAt = Date.now() + 3100;
        ui?.refresh(); queue();
    });
    subscribe('generation-notifications:finished', queue);
    subscribe(events.MESSAGE_EDITED, id => {
        // Automatic finalization may accept MVU's programmatic text additions,
        // but an explicit user edit still cancels the queued rewrite.
        if (pending && Number(id) === pending.index) {
            clearPending();
            setStatus('回复已编辑，已取消本次自动重写');
        }
    });
    subscribe(events.MESSAGE_SWIPED, async id => {
        const ctx = getContext();
        if (running || Number(id) !== ctx.chat.length - 1) return;
        if (syncMvuChat(ctx.chat[Number(id)])) await ctx.saveChat();
    });
    subscribe(events.GENERATION_STOPPED, generationId => {
        // Tavern Helper emits this shared event for its own requests, including
        // MVU extra analysis. Only a native chat stop should cancel the rewrite.
        if (typeof generationId === 'string' && generationId) return;
        clearPending(); cycle = null;
        const job = running;
        if (job && !job.cancelled) {
            const draft = stoppedReply(job);
            job.timing.finishedAt ??= Date.now();
            if (draft || job.settled) {
                job.stopRequested = true;
                if (draft && !job.settled) {
                    job.stoppedIndex = getContext().chat.indexOf(draft);
                    job.stoppedDraft = structuredClone(draft);
                    if (job.inplace) rememberStoppedInplace(job);
                    else rememberStoppedFallback(job);
                    clearInplacePrompts(job);
                    void getContext().saveChat().catch(error => console.error('[Auto Rewrite] Save stopped draft', error));
                }
            } else job.cancelled = true;
        }
        markStaging(running);
        setStatus(job?.stopRequested ? '已停止接收，正在保存当前重写稿' : running ? '未收到重写正文，正在恢复原稿' : '已停止生成');
    });
    for (const type of [events.CHAT_CHANGED, events.MAIN_API_CHANGED, events.OAI_PRESET_CHANGED_BEFORE,
        events.CONNECTION_PROFILE_LOADED]) subscribe(type, () => {
        clearPending(); cycle = null;
        if (running) { running.cancelled = true; running.timing.finishedAt ??= Date.now(); }
        setStatus('上下文已切换，等待下一次生成');
        ui?.sync();
        void recoverInterrupted();
    });
    subscribe(events.CHAT_LOADED, () => { ui?.install(); void recoverInterrupted(); });
    for (const type of [events.MESSAGE_SWIPED, events.MESSAGE_UPDATED, events.MESSAGE_EDITED, events.MESSAGE_DELETED,
        events.CHARACTER_MESSAGE_RENDERED, events.MORE_MESSAGES_LOADED]) subscribe(type, () => ui?.refresh());
    subscribe(events.MESSAGE_SENT, id => {
        if (running && getContext().chat[Number(id)] !== running.feedback) {
            running.cancelled = true; running.timing.finishedAt ??= Date.now(); showStaging();
        }
    });
    $(document).on('input.autoRewriteComposer change.autoRewriteComposer', '#send_textarea, #file_form_input', () => ui?.refresh());
    document.addEventListener('visibilitychange', resumeBackgroundWork);
    window.addEventListener('pageshow', resumeBackgroundWork);
    void recoverInterrupted();
}

function resumeBackgroundWork() {
    if (!installed) return;
    ui?.sync(); ui?.refresh();
    queue();
    if (!document.hidden) void recoverInterrupted();
}

export function disable() {
    installed = false;
    clearPending(); cycle = null;
    scheduler?.dispose(); scheduler = null;
    disposeBackgroundDelays();
    document.removeEventListener('visibilitychange', resumeBackgroundWork);
    window.removeEventListener('pageshow', resumeBackgroundWork);
    const job = running;
    if (job) {
        job.cancelled = true;
        clearInplacePrompts(job);
        if (job.generating) getContext().stopGeneration();
    }
    const ctx = getContext();
    for (const [type, handler] of subscriptions.splice(0)) ctx.eventSource.removeListener(type, handler);
    $(document).off('.autoRewriteComposer');
    ui?.dispose(); ui = null;
    showStaging();
}

jQuery(enable);
