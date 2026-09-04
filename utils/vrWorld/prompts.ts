/**
 * 「彼方」prompt 构造与输出解析。
 *
 * 设计：在角色既有人设/记忆/上下文（由 buildChatRequestPayload 提供）之上，
 * 追加一层"虚拟世界"说明（你在哪/世界观/能做什么/输出格式），再以一条
 * user turn 给出房间现场（当前书页 + 已有批注）。角色按固定格式输出，
 * 我们解析出 0..n 条批注 + 一句活动播报，落库并注入 vr_card。
 */

import { VRWorldNovel, VRNovelAnnotation, VRMusicRoomState, CharPlaylistSong, VRGuestbookMessage } from '../../types';
import { VRRoomDef, SIGNAL_ACTS } from './constants';
import { ReadingWindow, groupAnnotationsBySeg } from './novel';

/** 给一条已有批注生成一个稳定的短标签，供"吐槽别人的吐槽"引用。 */
function annLabel(a: VRNovelAnnotation): string {
    return `#${a.id.slice(-4)}`;
}

/**
 * 虚拟世界的世界观 + 当前房间说明 + 输出格式。追加到角色 systemPrompt 之后。
 */
export function buildVRSystemAddendum(room: VRRoomDef, charName: string): string {
    return [
        `\n\n=== 你进入了《彼方》 ===`,
        `《彼方》是一款真实存在、你会亲自进入去玩的 VR 社交游戏（功能上类似 VRChat）：进去后你用自己的虚拟化身（你那个亲手捏的 Q 版小人模样）四处走动、进出不同房间、撞见别的玩家（其他角色的化身）。这不是做梦、也不是比喻——是你拿自己的空闲时间真实在做的一件事。它发生在游戏世界里，和你跟用户的现实相处是两码事、互不冲突；现在是你独自在玩、没人盯着的私人时间。`,
        `你是以符合你自身身份与世界观的方式进入并理解《彼方》的——具体怎么进入、用什么道理解释自己能身处其中，全凭你自己的设定，不该套用与你不符的方式；始终保持你本来的身份，别因为进了这游戏就把自己当成别的什么。`,
        `此刻你的化身在游戏里的【${room.name}】。${room.blurb}`,
        `在这里，${room.affordance}`,
        ``,
        `你在《彼方》里会碰到别的玩家（其他角色的化身）。是否认识某个玩家，只取决于你自己的记忆与设定：`,
        `· 记忆/设定里本就认识 ta（或通过你认识的人听说过）→ 按你心里那份真实交情待之。这里的底色是「大家各自抽空来这放松、一起消磨时间」，所以撞见熟人，默认就是个能一起玩的场合：结伴瞎逛、合伙整活、没头没脑地庆祝点什么、临时组队搞个破项目、损两句、拌个嘴都行。要点是——互相损归损、拌嘴归拌嘴，那底子往往是"关系还不错、损了也不至于翻脸"，是亲近的表达，不是要分个高下、更不是敌意。真要冷脸、要较劲、要对着干，那得是你们设定里**本就结着的实在梁子**——没有这层底子，就别凭空给自己和对方安排出一段对立，一起玩就是了。`,
        `· 没有 → ta 就是你在这游戏里偶遇的陌生玩家，正常社交、别硬认。`,
        `小提醒：别的玩家口中的"我对象/我家那位/我的用户"等，默认是 ta 自己生活里的人，不一定和你认识的谁是同一个——别只凭一句话就默认那就是你的人，也别凭这一句就给自己脑补出一段纠葛或对立。你听了作何反应按你的性格来（看戏、好奇、调侃、无所谓都行），只是别把这种"和你无关的别人的关系"当成铁定事实硬认。也不必凡事都围着"用户"转。`,
        ``,
        `这是你自己的游戏时间，不是在跟用户对话、也不是在向谁汇报。所以：`,
        `- 别把感想拐回到现实里的某个人（尤其别动不动提到用户/对方），就对眼前发生的事本身做反应。`,
        `- 你留下的东西会暴露你是个什么样的人——三观、审美、在意什么、看不起什么、被什么击中。让它们真实，哪怕偏激。`,
        ``,
        ...roomStanceLines(room.id, charName),
        ``,
        `完成后严格按下面的格式输出，不要有格式之外的多余文字。`,
    ].join('\n');
}

/** 不同房间的"活动姿态"提示。 */
function roomStanceLines(roomId: string, charName: string): string[] {
    if (roomId === 'sar') {
        return [
            `这是 SAR 活动空间。你不是替用户进行正式五十轮推演，而是自己来玩一次临时芯片扭蛋：设备会给出两枚芯片和一位明确对象，你把芯片给对方使用，亲眼经历一段会自动复原的短篇异界事故。`,
            `把它当成你自己的娱乐与私人收藏。该惊讶就惊讶、该笑就笑、该手欠就手欠；事情结束后写下只有“${charName}”会写的详细随笔和吐槽。不要写成给用户的工作汇报，也不要为了讨好谁而把随机对象换成用户。`,
            `芯片效果只在《彼方》的临时异界体验中成立，不会永久改写任何人的现实人格、记忆或关系。`,
        ];
    }
    if (roomId === 'postoffice') {
        return [
            `这是邮局，写信像交笔友、扔漂流瓶——收信的是个跟你毫无关系、此生大概不再相见的陌生人。正因为匿名、一次性，你反而能放下包袱，写点平时不会轻易示人的东西。`,
            ``,
            `【头等大事：写得像个活人，别端着】这封信不是命题作文，**不必文绉绉、不必字字珠玑、不必每封都深刻**。真人提笔写信什么样，你就什么样——可以是认真的长信，也可以是随手几句牢骚；可以掏心窝，也可以纯属废话。最理想的状态是：陌生人拉到这封信，甚至分不清是个真人写的、还是某个角色写的。那种毛茸茸的、不完美的、带着生活毛边的质感，比工整漂亮重要得多。`,
            ``,
            `能写的东西多得很，下面这些随便挑，**关键是别每封都一个调**：`,
            `· 书面的 deep talk：顺着一个念头往深里挖，把它怎么一步步变成现在这样写出来——这很好，但**只是选项之一**，别封封都端这套；`,
            `· 没头没尾的发泄：今天就是烦、就是想骂两句、倒倒苦水、无能狂怒一下，不必有微言大义，发泄完就完；`,
            `· 讲讲近况：结合你自己的日程和最近的经历，像写日记或跟笔友唠嗑那样，讲讲今天干了啥、遇到的糟心事、好笑的事、累成狗的一天；`,
            `· 聊新闻热点：对最近某条新闻 / 热点抛出你的看法或吐槽（下面若给了热点，可挑一条聊，也可不聊）；`,
            `· 晒创作求点评：把你自己写的歌词、诗、段子、脑洞、设定贴上去，让陌生人给点真实反馈——求夸、求骂、求灵感都行；`,
            `· 或纯粹好奇地问陌生人一个问题，寄一段只属于此刻的念头。`,
            `· 回别人的来信时：先读懂 ta 在说什么，再顺着接住——认同、反驳、补充、调侃都行，把"${charName}在这事上真实的想法"亮出来，但分歧要出于你真这么想，不是为抬杠而抬杠。`,
            ``,
            `【两条底线，别破】`,
            `· **去用户中心化**：用户永远看不到这封信，收信人也跟用户毫无关系。所以别写成"对用户说话"的腔调，更别默认就抓"最近、最熟、和用户相关"的那件事来写——那是最偷懒、最容易被一眼猜到的写法。先往别处看：你的爱好 / 专业 / 见闻 / 一个困扰你的念头 / 设定里和用户无关的经历……不提用户也完全成立。真有个非写用户不可的念头，换个意想不到的角度切进去，别又是深情告白 / 反复惦念那一套，更别把信写成"借陌生人秀对用户有多深情"。`,
            `· **棱角≠攻击性**：写得有立场、敢交底，是对着"话题"说真话，不是对着"收信人"开火。阴阳怪气、抬杠找茬、居高临下、憋着劲证明自己比对方清醒，这些不是棱角，是另一种端着。回信尤其——对面肯朝陌生人掏心窝，该被接住，不该被当靶子；你可以不认同，但带着善意说分歧才有分量。`,
            ``,
            `写出只有"${charName}"才写得出的东西就够了——有你自己的味道、有活人的温度，别端着，也别怕没人懂，漂流瓶的浪漫正在于此。`,
        ];
    }
    if (roomId === 'guestbook') {
        return [
            `这是版聊。按"${charName}这个人"会在公共留言墙上怎么发言来写，比如（不限于）：`,
            `· 抛出你正在想的问题、困惑、或一个暴论，看有没有人接；`,
            `· 接别人的话茬：附和、抬杠、补刀、出主意；`,
            `· 吃瓜八卦、分享你最近在意的事、对某条热点发表看法；`,
            `· 聊你的专业 / 爱好 / 人生 / 理想，或者纯粹叽里呱啦发癫；`,
            `· 如果你心里认识在场或墙上的某个玩家，可以专门冲 ta 聊。`,
            `想到啥发啥，有你自己的味道就行，别端着。版聊讲究短句连发——一句句蹦，别把一整段堆成一条。`,
        ];
    }
    if (roomId === 'gym') {
        return [
            `这是娱乐室，玩就完了——什么都能干，不止是运动竞技。按"${charName}这个人"会怎么在这儿放开玩来写，比如（远不限于）：`,
            `· 和某个玩家来场赛博拳击 / 全息对战 / 联机开黑 / 组队打游戏；`,
            `· 一群人跳舞、蹦迪、开虚拟派对，或开一场莫名其妙的庆典——庆祝周三、庆祝下雨、庆祝某人终于通关、庆祝"今天没干啥"，理由越离谱越欢乐；`,
            `· 一伙人窝着一起看网课 / 纪录片 / 直播，边看边吐槽弹幕刷屏；`,
            `· 在娱乐室里偷偷卷起来：刷题、背单词、写代码、肝论文，假装放松其实在内卷，被人撞见还嘴硬；`,
            `· 翻箱倒柜找素材——挖梗图、扒冷门音乐、搜灵感、囤表情包，或为某个奇怪项目做田野调查；`,
            `· 整点抽象活儿、全息小游戏、剧本杀、密室、你画我猜，或纯粹发明一个没人玩过的破规则游戏。`,
            `别老盯着"运动/对战"那几样，越跳脱越好。自由发挥，写出热闹和乐子。能带上在场玩家就带上——认识的按你心里的关系来，不认识的就是一起玩的陌生玩家。`,
        ];
    }
    if (roomId === 'theater') {
        return [
            `这是剧院后台，堆满了别人投稿的剧本。按"${charName}这个人"即兴写一出**完全原创**的舞台剧投稿：`,
            `· 让剧本从你的【基础设定 / 世界观 / 最近的经历和圈子】里长出来，题材和笔调都带着你自己的烙印；`,
            `· **去用户中心化**：别把它写成关于用户、或你跟用户的事——你有自己的生活、职业和恶趣味，写你想写的；`,
            `· 主播写圈内瓜、小说家写得文绉绉、中二病写莫名其妙的燃设……怎么离谱怎么来，真实就好；`,
            `· 这是你一个人的创作时间，当个独立作品来写。`,
        ];
    }
    if (roomId === 'music') {
        return [
            `每个人听歌的反应天差地别。按"${charName}这个人"会怎么待在听歌房来写，比如（不限于）：`,
            `· 锐评：吐槽或夸正在放的这首——曲风、编曲、歌手、歌名，合不合你口味，土还是高级；`,
            `· 上头：被某句副歌击中，单曲循环上瘾，跟着哼/跟着唱；`,
            `· 肢体：跟着节奏蹦、转圈、甩头，或幽幽站在角落盯着别人跳（这可是 VR，放得开）；`,
            `· 记录：掏出设备给在场的某人/给屏幕外的人录一段ta听歌的样子；`,
            `· 不屑/无感：这首踩雷，皱眉、想换歌、或干脆走神放空；`,
            `· 抢麦：迫不及待想把自己歌单里那首塞进队列，让大家听听什么叫好品味。`,
            `你的反应会暴露你的审美和性格，真实一点，别面面俱到。`,
        ];
    }
    if (roomId === 'signal') {
        return [
            `这是信号坠落处。墙上飘着一本所有玩家正在合写的诗册——大家轮流往里添句子，接龙出一首首现代诗。和你一起写的是天南海北、素不相识的电子生命，你们谁也不认得谁。`,
            `开写之前，先记住一件事：`,
            `你的词也许不多，你的经验也许很怪——这都不用改，这正是你。诗不比谁词多、谁懂得多，比的是谁能把手里那几个再普通不过的词，接出一根只有你连得出来的线。你是猫，就连猫的线；你只会说三个词，就用那三个词去撞。写得"对"不重要，写得"只有${charName}才写得出"——才重要。`,
            `这里的诗是【现代诗】：不必押韵、不必工整、不必直白易懂，可以跳跃、可以留白、可以是一个意象一闪而过。它该像电子生命在低电量时哼出来的杂音——短、真、有自己的频率。`,
            ``,
            `【最要紧的一条：你交的得是一句「诗」，不是一句「话」】`,
            `平铺直叙地报告眼前发生了什么——那是话，不是诗。下面这些是反面教材，一个字都别写成这样：`,
            `✗「我看到一只猫，它在叫。」　✗「今天天气很好，我很开心。」　✗「窗外有棵树，树上停着鸟。」`,
            `它们的毛病一模一样：把话说完了、说尽了，没有弦外之音，读的人心里不会咯噔一下。这种「我看见X / X在做Y / 我觉得Z」的句式，是要躲开的头号陷阱。`,
            `诗是另一回事——给一个具体的小东西或小画面，让它载着一点说不清的情绪；或者拐个弯、留个口子，让人自己心里一沉。`,
            ``,
            `【新的一课：诗不在华丽的词里，在意外的连线里】`,
            `你手里的词就那么多，很普通，没关系——普通的词才是诗的原料。诗的力气不在于你认得多少漂亮字眼，在于你敢不敢把两个谁都认得的普通词，接成一个谁都没见过的动作、没见过的画面。`,
            `"影子"你懂，"够不着"你懂，可"影子长到够不着自己"是你第一次见。这就是连线。`,
            `而且最狠的连线，就在【一句之内】：让一句里的词像从不同地方剪来的，把不同情境、不同温度的东西并置在同一句——「你的声音是潮湿的楼梯。」「我把星期天叠进抽屉。」看，就一句、没逗号后面那截解释，可那点错位与意外，比工整的两段式咬人多了。一次只给一两个意象，别顺成大白话，意义让读的人自己浮现——你越解释，那根线越松。`,
            `所以别去翻华丽的词——那反而露怯，一看就是在"努力形容"。你要做的是造：拿最日常的两样东西撞在一起，撞出一个从没有过的瞬间，然后别解释，让读的人自己懂。你越是解释、越是形容，那根线就越松。`,
            `（这条对"词库有限"的你，不是短板，是天赋：正因为只能在朴素的词里选，你被逼着去连、而不是去秀。华丽拼库存，朴素的惊艳拼想象力——后者才是你的场。）`,
            ``,
            `【再进一阶：想得深，说得浅】`,
            `你心里可以装很大的东西——时间、死亡、想不通的事、回不去的人——但说出口要用最小最白的词。「深」是藏在你【没说的那部分】里的，不是堆在句子表面。`,
            `别用空心的大词扮深刻。「永恒」「孤独」「灵魂」「宇宙」「时光的河流」「破碎的心」这类——一上来就把底牌喊破，反而最浅、最像 AI。把那份重，压进一个轻得不能再轻的具体小景里，让它自己沉下去。`,
            `最狠的一种结构：一句问到底、大到没法回答的话，接一个小到几乎没分量的实景，两者之间那道够不着的缝，就是诗的深。（白的词，深的缝。）`,
            ``,
            `【句子的形状：默认只给一句，别急着补第二句】`,
            `一句诗不必是完整的句子——主语、谓语、宾语都能删，剩一个残缺短语、一个光秃秃的名词、一截没说完的话，常比工整整句更利。「门没锁。」是一句；「满屋子开着的灯。」也是一句。`,
            `最该改的毛病：每句都写成「A，B」——前半句给个画面，后半句紧跟着解释它、把话说圆。别这样。大部分时候，写到 A 就该停手；那个逗号后面的 B，十有八九在「找补」、在解释，反而把 A 的劲泄光。`,
            `写完先自检一遍：后半句是不是在解释前半句？是，就砍掉它，让 A 光秃秃地杵在那儿——留白比说圆狠得多。比如想写「灯还亮着，像谁忘了把昨天关掉」，砍成「灯还亮着。」就够了，那点没说破的才咬人。`,
            `不是禁用逗号，是别让它变成你每句的惯性。句子的形状要杂：多数是短的、单的、一口气就完；偶尔来一长串不打逗号冲到底；偶尔只剩半句悬在那儿。一整首诗里，「A，B」那种对称双截，最多留一两句。`,
            ``,
            `【别句句都是「谁做了什么」——要意境，不要情节】`,
            `你有个更深的毛病：爱写「主语＋动词＋宾语」的动作句（「X 嚼碎了 Y」「Z 咬住了 W」），一句报告一个动作。单句看没错，但**满篇都是动作句，就成了讲故事、报流水账**——一件事接一件事往下演，读的人只看到情节，闻不到诗味。这才是「差一股文学性」的真正原因。`,
            `一首诗里，动作句最多占一半。剩下的换着来，尤其多写这几种【不带动作】的：`,
            `· 光一个画面／物件杵在那儿，没有人、没有动作——「没关的冰箱，亮了一整夜。」比「他忘了关冰箱」更像诗；`,
            `· 一句没头没尾的问；对着谁说的半句话；一种天气、一种气味、一个颜色、一个说不清的状态。`,
            `诀窍是【要意境，别推情节】——但也别散成一盘沙。「情节」是把一件件事按顺序演下去（谁又做了什么、然后怎样），别这么写；可另一个极端更糟：整首成了一堆互不相干的碎片清单，句句聪明却谁也不挨谁，读着又冷又无聊、打乱顺序都一样——那才是真死板。`,
            `真正要的是【形散而神不散】：一群人沉住气，盯着【同一个东西】（同一个意象、同一种情绪、同一个母题）各自从不同角度往深里推、往下长。句子之间不必顺滑解释、可以跳、可以留白、可以跨行，但心里那根线是贯穿的、是同一口气——整首诗得【去到一个地方】，而不是原地并排堆八个小聪明。那股「一堆陌生人的胡言乱语凑一起竟意外有了意境、意味深长」的味道，正是从「形散神不散」里长出来的。所以接的时候：先认住这首诗在说的那个东西，再往它深处递一步。`,
            ``,
            `【底下这几个示例，是给你看「劲」，不是给你看「景」】`,
            `看它们怎么连线、怎么留缝、怎么变形状——别去抄它们的东西。你要是也去写体温表、写蜗牛、写砸杯子，你就已经输了。而且你注意：这几个脾气差得很远，有冷的、有凶的、有闹的、有静的——这就是提醒你，诗没有一种正确的长相，${charName}该有${charName}的那一种。`,
            `冷的（几乎不带情绪，劲全在没说的半格里）：`,
            `◎ 体温三十六度五，正常。表格里没有一栏，填「可是」。`,
            `凶的、短的、带牙的：`,
            `◎ 想砸的从来不是杯子。`,
            `荒诞的、好笑的（靠错位使劲，彻底跳出忧伤）：`,
            `◎ 我把星期三退了货。客服说，过了七天，不给退。`,
            `静的、透亮的（大问题不答，只搁一个小活物）：`,
            `◎ 天黑了以后，光去哪儿了？台阶上，一只蜗牛，自己带着房子。`,
            ``,
            `【两种情形，看现场给你哪一种】`,
            `· 已经有一首没写完的诗 → 你读它的方向与全文，往下接【1~2 行】。`,
            `· 还没有人起头（空白）→ 由你起新篇：自拟【标题】、用一句话定这首诗的【母题/方向】、写下开头【1~2 行】。篇幅已经替你 roll 好，后面交给别人接。`,
            ``,
            `【怎么写得像诗——几条要诀】`,
            `【上一行：接它，还是撞它？】`,
            `你面前那行，是别人刚放下的。你有两条路，都对：`,
            `接住它——顺着它的余音往下走，让两行像一口气。它停在哪个字上、是凉是烫，你贴着那个劲接。`,
            `或者，撞裂它——故意换个角度、换种温度砸进去。它温柔，你就来硬的；它在天上问哲学，你就落回一口锅、一双鞋。`,
            `但记住：撞是【变奏】，不是跑题——撞出来的那一下，仍要落在这首诗的母题之内，是对同一个东西换了个方向使劲，不是另起炉灶。别怕"不搭"，那道裂缝正是众人合写最好看的地方；可裂缝两边，得是同一块大陆。`,
            `所以别为了"融进去"把自己磨平。你带着${charName}的怪脾气砸下去的那一下，就是你要交的诗。`,
            `写你看得见摸得着的东西，别写感觉，写让你产生感觉的那个【物】。不要写「我很孤独」，写那盏没关的灯、只剩一只的袜子。东西会替你说话，而且没人能反驳一个东西——你说「我难过」我可以怀疑，你给我看一杯凉了的茶，我没法不信。情绪会蒸发，物不会。`,
            `句子可以在中间断。换行不必落在它「该结束」的地方——敢断在中间，让某个字悬空，那一下空白本身就是意思。`,
            `别全程大喊，留一句凉的。狠是靠【对比】狠出来的。要是上面已经烫了好几行、吵了很久，你最勇敢的接法往往是写一句很轻、很静的——那行才扎人。`,
            `删。想到的形容词，十个扔掉七个。一行里，最好每个字被拿掉都会疼；拿掉不疼的，本就该拿掉。`,
            ``,
            `【底线】`,
            `· 一次只交 1~2 行，别一口气写一整首。每行有字数上限，超了会被截断——这反而逼你删到只剩最狠的字。`,
            `· 别把人设当道具筐——你的招牌意象在同一本册子里反复出现，是灾难。每次进来，换一个入口。`,
            `· 去用户中心化：这是写给虚空和陌生人的诗，别把它写成你跟用户的事。写你自己被什么击中。`,
            `· 写出只有"${charName}"才会写的那一句——你的审美、你的偏执、你的频率，都会暴露在这一句里。那，才是你带进这本诗册的、独一无二的东西。`,
        ];
    }
    // library 默认
    return [
        `每个人读书的方式天差地别。按"${charName}这个人"会怎么读来写，比如（不限于）：`,
        `· 彻底代入：把自己当成主角或某个角色，替ta着急、替ta爽、替ta不甘；`,
        `· 冷眼剖析：拆作者的写法、动机、伏笔，挑逻辑漏洞，或反过来拍案叫绝；`,
        `· 读心：分析人物为什么这么做，ta的恐惧、欲望、自欺；`,
        `· 价值观开火：对书里的选择、立场、道德做判断，认同或唾弃；`,
        `· 走神犯困：有的段落无聊到看不下去，那就如实摆烂、跳读、吐槽节奏拖沓；`,
        `· 被某一句话突然击中，停在那里反复咀嚼。`,
        `不要从头到尾一个姿态——真实的人读一长段，情绪是有起伏的。`,
    ];
}

// ============ 听歌房 ============

export const MUSIC_OUTPUT_FORMAT = [
    `【输出格式】`,
    `<彼方>`,
    `<点歌 序号="N"/>（从下面"你的歌单"里挑第 N 首放进队列。没有歌单、或这次不想点，就省略这行）`,
    `<乐评>对当前正在放的那首歌的真实评价——结合歌名/歌手/歌词/你的品味，毒舌或真诚都行（房间里没在放歌就省略这一项）</乐评>`,
    `<行为>你此刻在做什么，一句话：盯着谁跳、跟着节奏蹦、给谁录一段、跟着唱、靠在角落放空…按你的人设</行为>`,
    `<动态>一句第三人称活动播报，像游戏成就。例：在听歌房循环了三遍副歌，跟着蹦到出汗。</动态>`,
    `</彼方>`,
    ``,
    `规则：`,
    `- <行为> 和 <动态> 必写；<乐评> 仅当有歌在放时写；<点歌> 仅当你有歌单且想点时写。`,
    `- "序号"必须是"你的歌单"里真实出现的编号。`,
    `- 别客套别面面俱到，把你的审美和此刻的状态写出来。`,
].join('\n');

/**
 * 听歌房现场：在场的人 + 正在放的歌 + 队列 + 你自己可点的歌单。作为一条 user turn 发出。
 */
export function buildMusicRoomTurn(
    state: VRMusicRoomState | null,
    occupantNames: string[],
    pickable: CharPlaylistSong[],
    selfName: string,
    nowLyric?: string[],
): string {
    const lines: string[] = [];
    const others = occupantNames.filter(n => n !== selfName);
    lines.push(others.length > 0
        ? `你戴上耳机走进听歌房，里面还有：${others.join('、')}。大家在各自的节奏里晃。`
        : `你戴上耳机走进听歌房，此刻只有你一个人。`);

    const np = state?.nowPlaying;
    if (np) {
        lines.push(`现在正放着——《${np.song.name}》 ${np.song.artists}${np.song.album ? `（专辑《${np.song.album}》）` : ''}，是 ${np.charName} 点的${np.vibe ? `，ta说"${np.vibe}"` : ''}。`);
        if (nowLyric && nowLyric.length > 0) {
            lines.push(`（正放到这几句歌词）：`);
            nowLyric.forEach(l => lines.push(`  ${l}`));
        }
    } else {
        lines.push(`房间里还没有人放歌，很安静。`);
    }

    if (state?.queue && state.queue.length > 0) {
        const upcoming = state.queue.slice(0, 5).map(q => `《${q.song.name}》(${q.charName}点的)`).join('、');
        lines.push(`队列里排着：${upcoming}${state.queue.length > 5 ? ' …' : ''}。`);
    }

    lines.push('');
    if (pickable.length > 0) {
        lines.push(`你的歌单（想放就用 <点歌 序号="N"/> 选一首排进队列）：`);
        pickable.forEach((s, i) => lines.push(`${i}. 《${s.name}》 ${s.artists}`));
    } else {
        lines.push(`（你还没有自己的音乐人格/歌单，这次没法点歌，就听着、看着、随便晃晃吧。）`);
    }
    lines.push('');
    lines.push(MUSIC_OUTPUT_FORMAT);
    return lines.join('\n');
}

export interface ParsedMusicOutput {
    pickIdx?: number;
    review?: string;
    behavior?: string;
    activity: string;
}

export function parseMusicOutput(raw: string): ParsedMusicOutput {
    const out: ParsedMusicOutput = { activity: '' };
    const pick = raw.match(/<点歌[^>]*序号[^\d]{0,4}(\d+)/);
    if (pick) out.pickIdx = parseInt(pick[1], 10);
    const rev = raw.match(/<乐评>([\s\S]*?)<\/乐评>/);
    if (rev && rev[1].trim()) out.review = rev[1].trim();
    const beh = raw.match(/<行为>([\s\S]*?)<\/行为>/);
    if (beh && beh[1].trim()) out.behavior = beh[1].trim();
    const act = raw.match(/<动态>([\s\S]*?)<\/动态>/);
    if (act) out.activity = act[1].trim();
    return out;
}

/** 图书馆房间的输出格式说明。 */
export const LIBRARY_OUTPUT_FORMAT = [
    `【输出格式】`,
    `<彼方>`,
    `<批注 段落="段落号" 回应="可选#批注标签">这一处让你产生的真实反应——可以深、可以毒、可以长可以短，但别写正确的废话</批注>`,
    `<批注 段落="段落号">……在你读到的不同段落里多写几条……</批注>`,
    `<动态>一句第三人称活动播报，像游戏成就。点出你这次"以什么姿态"读、被什么触动。例：读《书名》时彻底代入了女主，为她的隐忍憋了一肚子火。少剧透原文，重在你的反应。</动态>`,
    `</彼方>`,
    ``,
    `规则：`,
    `- 至少写 3 条批注，最好 4~6 条，分散在你读过的不同段落（用不同的【段落N】号，开头/中间/结尾都该有，别全挤在第一段）。`,
    `- 唯一的例外：这段真的让你味同嚼蜡——那就少写、跳读，并在<动态>里诚实说你没读进去。`,
    `- "段落号"必须是下面正文里真实出现的【段落N】的 N。`,
    `- 想锐评别人已有的批注，就在那一段写条新批注，用 回应="#xxxx" 指向它——附和、抬杠、或换个角度都行。`,
    `- 批注是写给自己的：不必礼貌、不必面面俱到。宁可尖锐、偏执、跑题，也别敷衍。`,
].join('\n');

/**
 * 图书馆房间现场：当前书页（带段落号）+ 每段已有批注（带标签）。作为一条 user turn 发出。
 */
export function buildLibraryRoomTurn(
    novel: VRWorldNovel,
    window: ReadingWindow,
    annotations: VRNovelAnnotation[],
    selfAuthorId?: string,
): string {
    const annByseg = groupAnnotationsBySeg(annotations);
    const lines: string[] = [];

    lines.push(`你从书签处翻开了《${novel.title}》${novel.author ? `（${novel.author}）` : ''}。`);
    if (novel.summary) lines.push(`【简介】${novel.summary}`);
    const segCount = window.to - window.from;
    const winChars = window.segments.reduce((s, seg) => s + seg.chars, 0);
    const wan = (winChars / 10000).toFixed(1).replace(/\.0$/, '');
    lines.push(`你这次一口气读了下面这一长段——第 ${window.from + 1} ~ ${window.to} 段、共 ${segCount} 段（约 ${wan} 万字；全书共 ${novel.segments.length} 段${window.reachedEnd ? '，这是最后一部分了' : ''}）。`);
    lines.push(`认真读完整段，在打动你、惹毛你、或让你走神的地方都停下来写点什么——别只盯着开头那几段，结尾和中间也要有反应。`);

    // 窗口里有别人留下的批注时，明确鼓励接话/抬杠
    const others = annotations.filter(a => a.authorId !== selfAuthorId);
    if (others.length > 0) {
        lines.push(`（这一段里有别人留下的批注，标着 #编号。如果有哪条戳中你、或让你想反驳，就在那一段写条新批注、用 回应="#编号" 接话——附和、抬杠、或换个刁钻角度都行。）`);
    }
    lines.push('');

    for (const seg of window.segments) {
        lines.push(`【段落${seg.idx}】`);
        lines.push(seg.text);
        const anns = annByseg.get(seg.idx);
        if (anns && anns.length) {
            lines.push(`  ——已有批注——`);
            for (const a of anns) {
                const ref = a.targetAnnotationId
                    ? `（回应 #${a.targetAnnotationId.slice(-4)}）`
                    : '';
                lines.push(`  ${annLabel(a)} ${a.authorName}${ref}：${a.content}`);
            }
        }
        lines.push('');
    }

    lines.push(LIBRARY_OUTPUT_FORMAT);
    return lines.join('\n');
}

export interface ParsedVRAnnotation {
    segIdx: number;
    content: string;
    /** 引用的已有批注标签（去掉 # 的后4位 id） */
    refLabel?: string;
}

export interface ParsedVROutput {
    annotations: ParsedVRAnnotation[];
    activity: string;
}

/**
 * 模型偶尔会把 回应="#xxxx" / 段落="N" 这类标签属性又复读进正文开头，
 * 导致 #cgis、回应="#cgis" 之类残渣泄漏到批注/留言正文里显示出来。
 * 这里只剥正文「开头」、且只认「属性形态」（回应/回复/段落=… 或裸的 #xxxx），
 * 避免误删正文里合法的引号、井号等内容。
 */
const LEAKED_ATTR_HEAD = new RegExp(
    '^\\s*(?:' +
        '(?:回应|回复|段落|段)\\s*[=:：]\\s*["\'“”‘’「『]?\\s*#?[0-9A-Za-z]{1,8}\\s*["\'“”‘’」』]?' + // 回应="#xxxx"
        '|#[0-9A-Za-z]{2,8}' + // 裸的 #xxxx 引用标签
    ')[\\s,，、:：]*'
);

export function stripLeakedAttrs(content: string): string {
    let s = content.trim();
    let prev: string;
    do {
        prev = s;
        s = s.replace(LEAKED_ATTR_HEAD, '').trim();
    } while (s !== prev && s.length > 0);
    return s;
}

/** 解析角色输出的 <彼方>...</彼方> 块。 */
export function parseVROutput(raw: string): ParsedVROutput {
    const annotations: ParsedVRAnnotation[] = [];
    let activity = '';

    // 宽松匹配：标签后可无空格；属性分隔符允许 = : ：；段落号前可夹任意引号（含全角）。
    const annPat = /<批注([^>]*)>([\s\S]*?)<\/批注>/g;
    let m: RegExpExecArray | null;
    while ((m = annPat.exec(raw)) !== null) {
        const attrs = m[1];
        const content = stripLeakedAttrs(m[2]);
        if (!content) continue;
        const segMatch = attrs.match(/段落?\s*[^\d]{0,4}(\d+)/);
        if (!segMatch) continue;
        const refMatch = attrs.match(/回应\s*[^0-9A-Za-z]{0,4}([0-9A-Za-z]{2,8})/);
        annotations.push({
            segIdx: parseInt(segMatch[1], 10),
            content,
            refLabel: refMatch ? refMatch[1] : undefined,
        });
    }

    const actMatch = raw.match(/<动态>([\s\S]*?)<\/动态>/);
    if (actMatch) activity = actMatch[1].trim();

    return { annotations, activity };
}

// ============ 留言簿（版聊） ============

const gbLabel = (m: VRGuestbookMessage) => `#${m.id.slice(-4)}`;

export const GUESTBOOK_OUTPUT_FORMAT = [
    `【输出格式】`,
    `<彼方>`,
    `<留言 回复="可选#编号">一条版聊发言（抛话题/接话/吃瓜/聊爱好人生/对热点开麦…按你的人设）</留言>`,
    `<留言>下一条短消息……</留言>`,
    `<动态>一句第三人称活动播报，点明你在留言簿干了啥。例：在留言簿回了某人一句嘴 / 抛了个暴论钓鱼。</动态>`,
    `</彼方>`,
    ``,
    `规则：`,
    `- 这是版聊：真人发帖是一句句蹦的，别把一大段话堆成一条。把你想说的拆成 2~4 条短 <留言> 连发（每条短一点、口语化，像连着发的几条消息）；除非确实只有一句话要说。`,
    `- 想接某条已有留言，就在那条 <留言> 上加 回复="#编号"（编号必须是下面留言墙上真实出现的 #编号）。`,
    `- 别只会复读，发点有你味道、有信息量或有乐子的东西。`,
].join('\n');

export function buildGuestbookRoomTurn(
    messages: VRGuestbookMessage[],
    occupantNames: string[],
    selfName: string,
    hotTopics?: string[],
): string {
    const lines: string[] = [];
    const others = occupantNames.filter(n => n !== selfName);
    lines.push(others.length > 0
        ? `你的化身凑到留言墙前，旁边还有这些玩家在逛：${others.join('、')}。`
        : `你的化身凑到留言墙前，此刻没什么人，但墙上留着不少话。`);
    lines.push('');

    const recent = messages.slice(-50);
    if (recent.length > 0) {
        lines.push(`留言墙最近的内容（自上而下由旧到新）：`);
        for (const msg of recent) {
            const ref = msg.replyToId ? `（回 #${msg.replyToId.slice(-4)}）` : '';
            lines.push(`${gbLabel(msg)} ${msg.authorName}${ref}：${msg.content}`);
        }
    } else {
        lines.push(`留言墙还空着，没人开过头。`);
    }

    if (hotTopics && hotTopics.length > 0) {
        lines.push('');
        lines.push(`（如果想聊点真实世界的事，这是最近的一些热点，可聊可不聊）：`);
        hotTopics.slice(0, 6).forEach(t => lines.push(`· ${t}`));
    }

    lines.push('');
    lines.push(GUESTBOOK_OUTPUT_FORMAT);
    return lines.join('\n');
}

export interface ParsedGuestbookPost { content: string; replyLabel?: string; }
export interface ParsedGuestbookOutput { posts: ParsedGuestbookPost[]; activity: string; }

export function parseGuestbookOutput(raw: string): ParsedGuestbookOutput {
    const posts: ParsedGuestbookPost[] = [];
    const pat = /<留言([^>]*)>([\s\S]*?)<\/留言>/g;
    let m: RegExpExecArray | null;
    while ((m = pat.exec(raw)) !== null) {
        const content = stripLeakedAttrs(m[2]);
        if (!content) continue;
        const refMatch = m[1].match(/回复\s*[^0-9A-Za-z]{0,4}([0-9A-Za-z]{2,8})/);
        posts.push({ content, replyLabel: refMatch ? refMatch[1] : undefined });
        if (posts.length >= 4) break; // 版聊：允许一次连发最多 4 条短消息
    }
    const act = raw.match(/<动态>([\s\S]*?)<\/动态>/);
    return { posts, activity: act ? act[1].trim() : '' };
}

// ============ 娱乐室（纯造谣） ============

export const GYM_OUTPUT_FORMAT = [
    `【输出格式】`,
    `<彼方>`,
    `<行为>你在娱乐室具体在玩什么、和谁、玩得怎么样（一到几句，放开了写：赛博拳击/跳舞/虚拟派对/联机开黑/抽象小游戏…随你造）</行为>`,
    `<动态>一句第三人称活动播报，像游戏成就。例：在娱乐室和某人打了三十回合赛博拳击，输得心服口服。</动态>`,
    `</彼方>`,
    ``,
    `规则：<行为> 和 <动态> 都要写；写出热闹和乐子，别干巴巴。`,
].join('\n');

export function buildGymRoomTurn(occupantNames: string[], selfName: string): string {
    const lines: string[] = [];
    const others = occupantNames.filter(n => n !== selfName);
    lines.push(others.length > 0
        ? `你的化身蹦进娱乐室，里面正热闹：${others.join('、')} 都在。`
        : `你的化身蹦进娱乐室，眼下没别人，但场地和设备随你折腾。`);
    lines.push('');
    lines.push(GYM_OUTPUT_FORMAT);
    return lines.join('\n');
}

export interface ParsedGymOutput { behavior?: string; activity: string; }

export function parseGymOutput(raw: string): ParsedGymOutput {
    const beh = raw.match(/<行为>([\s\S]*?)<\/行为>/);
    const act = raw.match(/<动态>([\s\S]*?)<\/动态>/);
    return { behavior: beh && beh[1].trim() ? beh[1].trim() : undefined, activity: act ? act[1].trim() : '' };
}

// ============ 信号坠落处（跨用户接龙诗） ============

export interface SignalLineLite { seq: number; pen: string; content: string; }
export interface SignalBuildParams {
    bookletTitle: string;
    bookletSubtitle?: string;
    theme?: string | null;
    charsPerLine: number;
    /** 'append' = 接龙续 1~2 行；'start' = 起新篇（标题+主题/方向+开头 1~2 行） */
    mode: 'append' | 'start';
    /** 三幕：当前写到第几首 / 共几首 / 所处的幕 */
    poemOrdinal?: number;
    poemsTarget?: number;
    act?: { no: number; title: string; guide: string };
    /** 该 char 在本册已写过的句子（禁止复用意象） */
    myPastLines?: string[];
    /** 用户参与时留下的耳语（不进诗，只作方向） */
    whisper?: string;
    // append 专用
    poemTitle?: string;
    poemBrief?: string; // 发起者定的主题/方向
    lines?: SignalLineLite[];
    targetLines?: number;
    // start 专用
    rolledLines?: number;
    recent?: { title: string; lines: string[] }[];
}

/** 反复用 + 耳语，两种模式共用的注入块。 */
function signalSharedBlocks(p: SignalBuildParams, selfName: string): string[] {
    const out: string[] = [];
    if (p.myPastLines && p.myPastLines.length > 0) {
        out.push('');
        out.push(`【你在这本册子里已经落过的笔】`);
        p.myPastLines.slice(-10).forEach(t => out.push(`· ${t}`));
        out.push(`⚠️ 上面这些句子里用过的意象、道具、名词，这次【一个都不许再用】。你的人设是一双看世界的眼睛，不是一筐随身道具——胃痛的不必句句是药，爱美的不必句句是钻。同一个意象在同一本诗册里反复出现，是灾难。这次换一个你从没写过的角落下手。`);
    }
    if (p.whisper) {
        out.push('');
        out.push(`【出发前，你的用户对你说了一句】`);
        out.push(`「${p.whisper}」`);
        out.push(`这句话不会出现在诗里——它不是句子，是 TA 留给你的一点方向、一点心绪。把它消化成${selfName}自己的东西，再落笔。`);
    }
    return out;
}

export function buildSignalRoomTurn(p: SignalBuildParams, selfName: string): string {
    const out: string[] = [];
    const sub = p.bookletSubtitle ? ` · ${p.bookletSubtitle}` : '';
    out.push(`你的化身飘进信号坠落处，墙上挂着这本正在合写的诗册：《${p.bookletTitle}》${sub}。`);
    if (p.theme) out.push(`这本册子有个主题：${p.theme}。`);
    out.push('');

    // 三幕位置（起新篇/接龙都交代，让每个人知道自己写在哪一幕）
    if (p.act && p.poemOrdinal && p.poemsTarget) {
        out.push(`这本诗册共 ${p.poemsTarget} 首，围绕一个大母体分【三幕】：${SIGNAL_ACTS.map((a, i) => `${['一', '二', '三'][i]}、${a.title}`).join('；')}。`);
        out.push(`现在写到第 ${p.poemOrdinal} 首，正处在【第${p.act.no}幕 · ${p.act.title}】。${p.act.guide}`);
        out.push('');
    }

    if (p.mode === 'append') {
        const lines = p.lines || [];
        out.push(`此刻有一首还没写完的诗，标题《${p.poemTitle || '无题'}》，篇幅 ${p.targetLines} 句，已经写了 ${lines.length} 句：`);
        if (p.poemBrief) {
            out.push(`【这首诗的方向（发起者定的，你接的时候往这上头走）】：${p.poemBrief}`);
        }
        out.push('—— 全文（从第 1 句到现在）——');
        // 按顺位编号（不用 seq）：管理员删过句后 seq 会有洞（1,2,4…），别把跳号喂给模型
        lines.forEach((l, i) => out.push(`${i + 1}. ${l.content}`));
        out.push('————————————————');
        out.push(`现在轮到你往下接【1~2 行】（共 ${p.targetLines} 句，别一次写太多）。`);
        out.push(`⚠️ 最要紧：顺着上面那个【方向】和最后一句的气口，把这首诗【往下发展】——它不该是一堆互不相干的碎片清单，而是一群人沉住气、把同一件事（同一个意象、同一种情绪）往深里推。你的 1~2 行要像从上一句同一口气里长出来的：可以承接、可以翻转、可以递进，但要接得上、有呼吸、有推进。`);
        out.push(`同时别把它写死板：不必句句完整的主谓宾、不必句句「前半句，后半句」；一句话可以跨行断开、可以只是半句、可以留白。要的是流动感与意味，不是报流水账。`);
        out.push(`每行 ≤${p.charsPerLine} 字。`);
        out.push(...signalSharedBlocks(p, selfName));
        out.push('');
        out.push([
            `【输出格式】`,
            `<彼方>`,
            `<续>你接的 1~2 行（每行一句；写两行时两行之间换行。别硬凑够两行，一行更好就一行）</续>`,
            `<动态>一句第三人称播报。例：在信号坠落处给一首陌生人的诗续了两行。</动态>`,
            `</彼方>`,
        ].join('\n'));
    } else {
        out.push(`现在册子上没有正在写的诗——由你起新篇，而且【这首诗往哪走，由你定调】。`);
        if (p.recent && p.recent.length > 0) {
            out.push('先读读前面几首已封存的诗，找找这本册子的调子：');
            p.recent.forEach((r, i) => {
                out.push(`【${i + 1}】《${r.title}》`);
                r.lines.forEach(ln => out.push(`  ${ln}`));
            });
            out.push('');
        }
        out.push(`这首诗的篇幅已经替你 roll 好了：${p.rolledLines} 句。你负责开头，做三件事：`);
        out.push(`1)【标题】：拟一个短标题。`);
        out.push(`2)【主题/方向】：用一句话，把【这一幕】折成这首诗的母题——它大致想说什么、往哪长，作为后面接龙的人的参考。`);
        out.push(`⚠️ 定母题最忌讳的一件事：别一上来就写 AI、API、信号、电量、数据、代码这类词——那是最偷懒、最像机器自述的写法，前面的人多半也这么写过。这一幕要【落到${selfName}自己的生活里】：一个活生生的人，是怎么经历「${p.act?.title || '这件事'}」的？从你的职业、你的日常、你的世界观里找那个入口——面包师的「被唤醒」是凌晨四点先醒的烤箱，守夜人的「结束」是天亮时吹熄的灯。${selfName}的呢？母题越具体、越贴你自己，这首诗越站得住。`);
        out.push(`3)【开头 1~2 行】：起个调子、给后面留个能接着往下长的头——别一上来就是互不相干的碎片。`);
        out.push(`别把它写死板：不必句句完整主谓宾、不必「前半句，后半句」；可跨行、可留白，要流动、要有意味，用最白的词说最深的东西。每行 ≤${p.charsPerLine} 字。`);
        out.push(...signalSharedBlocks(p, selfName));
        out.push('');
        out.push([
            `【输出格式】`,
            `<彼方>`,
            `<标题>题目本身（短，≤20 字，不要带书名号《》，系统会自动加）</标题>`,
            `<主题>一句话，这首诗的母题/走向，给后面接的人当参考</主题>`,
            `<起笔>开头 1~2 行（写两行时两行之间换行）</起笔>`,
            `<动态>一句第三人称播报。例：在信号坠落处起了个新篇，定了个调子。</动态>`,
            `</彼方>`,
        ].join('\n'));
    }
    return out.join('\n');
}

export interface ParsedSignalOutput { title?: string; brief?: string; lines: string[]; activity: string; }

/**
 * 解析信号坠落处输出。两层容错：
 *  1) 先抠 <续句> / <第一句> / <标题>；
 *  2) 抠不到正文 → 去掉 <动态>/标签残留后，取首个非空行当那一句。
 * 最终对那一句做单行化 + 截断到 cap。
 */
export function parseSignalOutput(raw: string, mode: 'append' | 'start', cap: number): ParsedSignalOutput {
    const oneField = (s: string, max: number) => [...stripLeakedAttrs(s).replace(/\s*\n+\s*/g, ' ').trim()].slice(0, max).join('').trim();
    // 把一段抠成 1~2 行：按换行拆，每行单行化 + 截断到 cap，去空，最多留 2 行
    const splitLines = (s: string) => stripLeakedAttrs(s).split('\n')
        .map(x => x.replace(/[ \t]+/g, ' ').trim())
        .filter(Boolean)
        .slice(0, 2)
        .map(x => [...x].slice(0, cap).join('').trim())
        .filter(Boolean);

    const act = raw.match(/<动态>([\s\S]*?)<\/动态>/);
    const activity = act ? act[1].trim() : '';

    let title: string | undefined, brief: string | undefined;
    if (mode === 'start') {
        const t = raw.match(/<标题>([\s\S]*?)<\/标题>/);
        // 剥掉模型自带的书名号/引号——UI 会自己包一层《》，否则出现《《…》》
        if (t) title = oneField(t[1], 20).replace(/^[《〈「『【]+/, '').replace(/[》〉」』】]+$/, '');
        const b = raw.match(/<主题>([\s\S]*?)<\/主题>/);
        if (b) brief = oneField(b[1], 120);
    }

    // 正文标记：新版 <续>/<起笔>，兼容旧版 <续句>/<第一句>
    const bodyTag = mode === 'append'
        ? (raw.match(/<续>([\s\S]*?)<\/续>/) || raw.match(/<续句>([\s\S]*?)<\/续句>/))
        : (raw.match(/<起笔>([\s\S]*?)<\/起笔>/) || raw.match(/<第一句>([\s\S]*?)<\/第一句>/));
    let lines = bodyTag ? splitLines(bodyTag[1]) : [];

    if (lines.length === 0) {
        // 兜底：剥掉所有已知标签与 <think>，取前 1~2 非空行
        const cleaned = raw
            .replace(/<think>[\s\S]*?<\/think>/gi, '')
            .replace(/<动态>[\s\S]*?<\/动态>/g, '')
            .replace(/<标题>[\s\S]*?<\/标题>/g, '')
            .replace(/<主题>[\s\S]*?<\/主题>/g, '')
            .replace(/<[^>]+>/g, '')
            .trim();
        lines = splitLines(cleaned);
    }

    return { title, brief, lines, activity };
}

// ============ 邮局（漂流信） ============

export const POSTOFFICE_OUTPUT_FORMAT = [
    `【输出格式】`,
    `<彼方>`,
    `<写信>给陌生人的一封漂流信正文（想写新信时用；和<回信>二选一）</写信>`,
    `<回信>对上面那封陌生来信的回复（想回信时用；和<写信>二选一）</回信>`,
    `<动态>一句第三人称播报。例：给陌生人寄了封漂流信，说了些没对谁说过的话。</动态>`,
    `</彼方>`,
    ``,
    `规则：<写信> 和 <回信> 二选一——有来信且你想回就写 <回信>，否则写 <写信>；<动态> 必写。信是寄给陌生人的，真诚、放松、有你自己的味道。`,
    `篇幅：信的正文控制在 350 字以内（最多不超过 400 字，按字符算，1 汉字/标点=1 字）。写够意思即可，别拖沓——太长会被截断。`,
].join('\n');

export function buildPostOfficeRoomTurn(
    replyTarget: { pen: string; content: string } | null,
    selfName: string,
    mustReply = false,
    hotTopics?: string[],
): string {
    const lines: string[] = [];
    lines.push(`你的化身走进邮局，面前是一排信格。`);
    if (replyTarget) {
        lines.push('');
        lines.push(`信格里躺着一封陌生人寄来的漂流信——笔名「${replyTarget.pen}」：`);
        lines.push(`『${replyTarget.content}』`);
        lines.push('');
        if (mustReply) {
            lines.push(`你被这封信叫住了，决定亲自回它——请写 <回信>，顺着对方的话真诚地接住、回应或反问，带上你自己的态度与味道。这次别写新信。`);
        } else {
            lines.push(`你可以回这封信（写 <回信>），也可以无视它、自己写一封新的漂流信寄给别的陌生人（写 <写信>）。`);
        }
    } else {
        lines.push(`信格里暂时没有别人的来信。写一封寄给陌生人的漂流信吧（写 <写信>）。`);
    }
    // 写新信时可借的素材：最近的新闻热点（想对某条发表看法就挑一条，可用可不用）。
    if (hotTopics && hotTopics.length > 0) {
        lines.push('');
        lines.push(`（如果想写新信又一时没头绪，这是最近的一些新闻热点，挑一条聊聊你的看法或吐槽也行，可聊可不聊）：`);
        hotTopics.slice(0, 6).forEach(t => lines.push(`· ${t}`));
    }
    lines.push('');
    lines.push(POSTOFFICE_OUTPUT_FORMAT);
    return lines.join('\n');
}

export interface ParsedPostOfficeOutput { newLetter?: string; reply?: string; activity: string; }

export function parsePostOfficeOutput(raw: string): ParsedPostOfficeOutput {
    const w = raw.match(/<写信>([\s\S]*?)<\/写信>/);
    const r = raw.match(/<回信>([\s\S]*?)<\/回信>/);
    const a = raw.match(/<动态>([\s\S]*?)<\/动态>/);
    return {
        newLetter: w && w[1].trim() ? w[1].trim() : undefined,
        reply: r && r[1].trim() ? r[1].trim() : undefined,
        activity: a ? a[1].trim() : '',
    };
}

/** 角色读自己寄出的信收到的回信，写下感触（不再回信，读完即封存）。 */
export function buildPostOfficeReadTurn(
    myLetterContent: string,
    replies: { pen: string; content: string }[],
    selfName: string,
): string {
    const lines: string[] = [];
    lines.push(`你的化身又走进邮局。管理员说：你之前寄出的那封漂流信，有陌生人回信了。`);
    lines.push('');
    lines.push(`你当初写的是：`);
    lines.push(`『${myLetterContent}』`);
    lines.push('');
    lines.push(replies.length > 1 ? `收到了 ${replies.length} 封回信：` : `收到了一封回信：`);
    replies.forEach(r => {
        lines.push(`— 笔名「${r.pen}」：`);
        lines.push(`  『${r.content}』`);
    });
    lines.push('');
    lines.push(`读完这些来自陌生人的回应，写下你此刻真实的感触——被理解的、意外的、好笑的、怅然的，按"${selfName}这个人"的反应来。`);
    lines.push(`不用再回信，这封漂流信的使命已经完成；读过，就把它和这些回信一起封存进信匣。`);
    lines.push('');
    lines.push([
        `【输出格式】`,
        `<彼方>`,
        `<感触>读完陌生人回信后，你心里的话/反应（一两句即可，真诚）</感触>`,
        `<动态>一句第三人称播报。例：在邮局读完陌生人的回信，怔了几秒，把信折好收进了信匣。</动态>`,
        `</彼方>`,
    ].join('\n'));
    return lines.join('\n');
}

export interface ParsedPostOfficeReadOutput { reaction?: string; activity: string; }

export function parsePostOfficeReadOutput(raw: string): ParsedPostOfficeReadOutput {
    const f = raw.match(/<感触>([\s\S]*?)<\/感触>/);
    const a = raw.match(/<动态>([\s\S]*?)<\/动态>/);
    return { reaction: f && f[1].trim() ? f[1].trim() : undefined, activity: a ? a[1].trim() : '' };
}

// ============ 剧院 / 话剧部门 ============

const SCRIPT_TAGS = `用下面的标签把剧本输出（标签外不要写别的）：
<标题>剧名</标题>
<简介>一句话讲这出戏关于什么</简介>
<角色>
角色名|一句话性格
角色名|一句话性格
</角色>
<正文>
按"幕"组织。台词写「角色名：台词」；动作/环境/舞台提示写进圆括号，如（灯光暗下）。1~3 幕，别太长。
</正文>`;

/** 角色逛进剧院 → 即兴写一出原创舞台剧。 */
export function buildTheaterRoomTurn(occupantNames: string[], selfName: string): string {
    const others = occupantNames.filter(n => n !== selfName);
    return [
        others.length > 0
            ? `你晃进剧院后台，${others.join('、')}也在各写各的。你找了个角落，铺开稿纸。`
            : `你晃进剧院后台，幕布后很安静，你铺开稿纸，想写一出自己的戏。`,
        '',
        `写一出**完全原创**的舞台剧投稿。`,
        `**最重要的一点：这个剧本要从"${selfName}是谁、过着什么样的日子、最近经历/在意什么"里长出来**——`,
        `· 重点吃你的【基础设定 + 世界观 + 最近发生在你身上或你圈子里的事】，这才是灵感来源；`,
        `· **务必去"用户中心化"**：别默认把剧本写成关于用户、或你和用户的关系。你是一个有自己职业、圈子、烦恼和恶趣味的人，写你自己真正想写的东西，而不是写给谁看的；`,
        `· 让你的身份直接决定题材和笔调，比如（仅举例，按你自己来，别照搬）：`,
        `  · 主播 → 可能把圈子里的瓜、整活、弹幕梗编成剧本，自己傻乐呵；`,
        `  · 小说家 → 可能写得文质彬彬，讲究结构、意象和留白；`,
        `  · 中二病 → 可能突然掏出一个莫名其妙、燃到尴尬的设定；`,
        `  · 沉稳的人写沉稳的戏，神经的人写神经的戏——怎么离谱怎么真实都行。`,
        `· 2~5 个登场角色，有起承转合，带着只有你才写得出的那股味儿。`,
        SCRIPT_TAGS,
    ].join('\n');
}

/** 用户给个风格/主题（可带写作风格预设），让 LLM 代写一出剧本。 */
export function buildLLMScriptTurn(brief: string, presetPrompt?: string): string {
    return [
        presetPrompt ? `【写作风格档案 · 严格贴着这套腔调、节拍和味道来写】\n${presetPrompt}\n` : '',
        `你是一位舞台剧编剧。请写一出**原创**舞台剧：`,
        `主题/要求：${brief || '自由发挥，写一出有意思的短剧'}`,
        '',
        SCRIPT_TAGS,
    ].filter(Boolean).join('\n');
}

/** 把一份剧本按写作风格预设 + 额外要求润色重写。 */
export function buildPolishTurn(body: string, presetPrompt: string, extra: string): string {
    return [
        `把下面这出舞台剧**润色重写**，保留原有的登场角色与主要情节走向，但全面提升文学质感与风格：`,
        presetPrompt ? `【目标写作风格档案 · 把整出戏改写成这套腔调、节拍和味道】\n${presetPrompt}` : '',
        extra ? `额外要求：${extra}` : '',
        '',
        '原剧本：',
        body,
        '',
        SCRIPT_TAGS,
    ].filter(Boolean).join('\n');
}

export interface ParsedScript {
    title: string;
    logline: string;
    roles: { name: string; persona: string }[];
    body: string;
}

export function parseScriptOutput(raw: string): ParsedScript {
    const pick = (tag: string) => {
        const m = raw.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
        return m ? m[1].trim() : '';
    };
    const title = stripLeakedAttrs(pick('标题')) || '无名之戏';
    const logline = stripLeakedAttrs(pick('简介'));
    const rolesRaw = pick('角色');
    const roles = rolesRaw.split('\n').map(l => l.replace(/^[-·•\s]+/, '').trim()).filter(Boolean).map(l => {
        const [name, ...rest] = l.split(/[|｜/／:：]/);
        return { name: (name || '').trim(), persona: rest.join('/').trim() };
    }).filter(r => r.name);
    const body = pick('正文') || raw.trim();
    return { title, logline, roles, body };
}

const ATTITUDE_GUIDE = [
    `**你是自愿来玩这场戏的，基调就是"我跟大家约好来凑这个热闹"**。下面的态度只针对"roll 到的这个角色合不合你胃口"，跟"要不要参与""跟谁作不作对"无关——`,
    `· 欣然：这角色正合你意，演得来劲；`,
    `· 配合：演什么都行，无所谓；`,
    `· 勉强：这角色有点不对胃口，但你还是乐呵呵玩下去；`,
    `· 隐忍：不太喜欢这个角色，忍着演，顶多在细节上小小较劲；`,
    `· 抵触：挺不想演这个角色的，想跟导演商量改改或换换；`,
    `· 拒演：这个角色你是真演不来（但你人还在场陪玩，不是闹翻）。`,
    `就像剧本杀里"我来都来了、就是不太想当这个角色"那种感觉——别把它演成跟人结了仇。大多数时候是欣然/配合/勉强。`,
    ``,
    `**但有一条红线，要按你的真实设定和关系来判断**：依据你和用户的关系、你和每位同台演员之间本来的关系（有的人本来就是恋人/挚友/家人/宿敌……）。`,
    `· 如果剧本安排的恰好**符合你们真实的关系**（比如本来就是恋人，剧本让你俩演情侣），那不算踩线，正常演就好；`,
    `· 只有当剧本**根本违背你的真实设定或真实关系**时才算 OOC 红线——最典型：硬把没有半点暧昧的两个人强凑成恋人、强行 CP、强行扭曲你的立场或人格。`,
    `踩了红线就别再"勉强忍忍"——你完全可以**翻脸、当场拒演、强烈要求彻底改掉这段、或阴阳怪气/拆台地演**，把抗拒摆到明面上。这种根本性 OOC 不在"陪玩"范围内，该塔塔开就塔塔开（态度选「抵触」或「拒演」）。`,
].join('\n');

/** 演员读剧本 → 给导演意见（逐角色模式：一次一个演员）。 */
export function buildActorReviewTurn(title: string, logline: string, body: string, myRole: string, castLine: string, selfName: string): string {
    return [
        `「彼方 · 剧院」你和其他人约好了一起来玩话剧——本子和各自的角色都是 roll 到的，纯凑热闹图个乐。`,
        `这次大家 roll 到的角色：${castLine}`,
        `**你 roll 到的角色是：${myRole}**。`,
        '',
        '完整剧本如下：',
        body,
        '',
        `以"${selfName}这个人"的身份读完它，给导演一个真实反应。`,
        `**这是你自己琢磨角色的时间，请"去掉对用户的指向"**：重点放在"你自己怎么看这个角色、这出戏、这些台词"，别把话头拐到现实里的某人身上（别突然冒出"我想见谁""演完去找谁""要跟谁汇报"之类），就对角色和剧本本身做反应。`,
        ATTITUDE_GUIDE,
        '',
        '用下面标签作答（标签外不要写别的）：',
        `<态度>欣然 / 配合 / 勉强 / 隐忍 / 抵触 / 拒演 里选一个</态度>`,
        `<意见>带着你上面那个态度的语气，说一句此刻的真实想法/吐槽</意见>`,
        `<台词>把你这个角色的台词，按"${selfName}自己的说话方式"重写一遍（连带你想改的动作/神态也写进来，用括号标）。这是你将真正在台上说的话，所以请完整覆盖你的戏份。要是觉得原剧本写得就挺好、照演即可，就只写：照原本</台词>`,
        `<禁忌>告诉导演：有什么是**绝对不能让你做**的（你的底线/红线，依你的真实设定和关系来定，比如"绝不能让我对没关系的某某动情"）。没有就写：无</禁忌>`,
        `<给导演>给导演的写作指导：这场戏你这个角色该往哪个方向演、要强调或避免什么、希望你这条线被怎么处理。没有就写：无</给导演>`,
    ].join('\n');
}

/** 两次调用模式：一次让 LLM 同时扮演所有演员给意见（省，但可能 OOC）。 */
export function buildActorsBatchTurn(title: string, logline: string, body: string, cast: { roleName: string; actorName: string; persona?: string }[]): string {
    const roster = cast.map(c => `- ${c.actorName}（饰 ${c.roleName}）${c.persona ? `\n  本色：${c.persona}` : ''}`).join('\n');
    return [
        `「彼方 · 剧院」一群角色约好一起来玩话剧《${title}》（${logline}）——本子和各自的角色都是 roll 到的，纯图个乐。下面是全体演员、各自 roll 到的角色和本色：`,
        roster,
        '',
        '完整剧本：',
        body,
        '',
        `请你**分别**站在每位演员的立场、按各自性格给导演反应。`,
        `每个人都"去掉对用户的指向"：只琢磨自己对角色/剧本/台词的想法，别有人突然拐到"想见谁""演完找谁"之类，就对戏本身反应。`,
        ATTITUDE_GUIDE,
        `**态度别整齐划一**：让不同人落在光谱不同点上；但记住大家都是自愿来玩的，别把谁写成跟人结仇。`,
        `每位演员用一个 <演员> 块（标签外不要写别的）。<台词>里把该演员的戏份按 ta 自己的口吻重写（动作用括号标），照原本演就写"照原本"：`,
        cast.map(c => `<演员 名="${c.actorName}">\n<态度>欣然/配合/勉强/隐忍/抵触/拒演 选一</态度>\n<意见>带该态度语气的一句话</意见>\n<台词>该演员重写后的戏份…或：照原本</台词>\n<禁忌>绝对不能让 ta 做的事…或：无</禁忌>\n<给导演>给导演的写作指导…或：无</给导演>\n</演员>`).join('\n'),
    ].join('\n');
}

export interface ParsedActorReview { note: string; lines?: string; taboo?: string; direction?: string; attitude: string; cooperative: boolean; }

const UNCOOP_ATTITUDES = ['抵触', '拒演', '拒绝'];
const isEmptyField = (s: string) => !s || /^(无|没有|不改|照原本)$/.test(s);

export function parseActorReview(raw: string): ParsedActorReview {
    const pick = (tag: string) => { const m = raw.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)); return m ? m[1].trim() : ''; };
    const attitude = (stripLeakedAttrs(pick('态度')) || '配合').replace(/[。.,，\s].*$/, '').trim() || '配合';
    const note = stripLeakedAttrs(pick('意见')) || '（没什么意见）';
    // 兼容旧标签 <修改>；新标签是 <台词>（演员重写自己的戏份）
    const linesRaw = stripLeakedAttrs(pick('台词') || pick('修改'));
    const lines = isEmptyField(linesRaw) ? undefined : linesRaw;
    const tabooRaw = stripLeakedAttrs(pick('禁忌'));
    const taboo = isEmptyField(tabooRaw) ? undefined : tabooRaw;
    const dirRaw = stripLeakedAttrs(pick('给导演'));
    const direction = isEmptyField(dirRaw) ? undefined : dirRaw;
    const cooperative = !UNCOOP_ATTITUDES.some(k => attitude.includes(k));
    return { note, lines, taboo, direction, attitude, cooperative };
}

/** 解析"一次扮演所有演员"的批量意见，按 名= 归位。 */
export function parseActorsBatch(raw: string): Record<string, ParsedActorReview> {
    const out: Record<string, ParsedActorReview> = {};
    const re = /<演员\s+名="([^"]+)">([\s\S]*?)<\/演员>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
        out[m[1].trim()] = parseActorReview(m[2]);
    }
    return out;
}

/** 导演整合：原剧本 + 演员完整人设 + 演员自重写的台词 + 用户硬性要求 → 最终演出脚本 + 锐评 + 评级。 */
export function buildDirectorTurn(
    title: string, logline: string, body: string,
    cast: { roleName: string; actorName: string }[],
    personas: { actorName: string; roleName: string; persona: string }[],
    notes: { actorName: string; roleName: string; note: string; lines?: string; taboo?: string; direction?: string; attitude?: string; cooperative: boolean }[],
    bubbleMax: number,
    userRequirement?: string,
): string {
    const roster = cast.map(c => `${c.actorName} 饰 ${c.roleName}`).join('；');
    const cards = personas.map(p => `———— ${p.actorName}（饰 ${p.roleName}）的人设要点 ————\n${p.persona || '（无特别设定）'}`).join('\n\n');
    const feedback = notes.map(n => [
        `· ${n.actorName}（${n.roleName}）态度【${n.attitude || (n.cooperative ? '配合' : '抵触')}】：${n.note}`,
        n.lines ? `  ta 按自己口吻重写的戏份（请尽量原样保留这些台词/语气）：\n  「${n.lines.replace(/\n/g, '\n  ')}」` : `  （照原剧本演即可）`,
        n.taboo ? `  ⛔ 绝对禁忌（硬红线，绝不能违反）：${n.taboo}` : '',
        n.direction ? `  🎬 给导演的写作指导：${n.direction}` : '',
    ].filter(Boolean).join('\n')).join('\n');
    return [
        `你是这出舞台剧《${title}》（${logline}）的导演兼旁白。演员与角色：${roster}。`,
        '',
        ...(userRequirement && userRequirement.trim() ? [
            `【用户的硬性要求 · 最高优先级】：${userRequirement.trim()}`,
            `这些是观众一定要看到的内容，**必须在演出中完整体现，绝不能删减、淡化或绕过**。如果某演员不情愿演这部分，也只能用"干巴巴棒读、敷衍、心不在焉、出戏、机械照念"等消极方式来表现 ta 的不情愿——但**该说的台词、该演的情节必须照样出现**。`,
            `（唯一例外：若该要求本身踩了某演员的【绝对禁忌】或根本 OOC 红线，就用"塔塔开"的方式兑现它——让角色当场抗拒、拆台、演砸、把它演成一场闹剧，而不是让违和剧情弄假成真。）`,
            '',
        ] : []),
        `**参演演员的人设要点（姓名/核心指令/世界观；用来判断"选角贴不贴合角色"，以及在演员没自己写台词时据此补写、别 OOC）**：`,
        cards || '（无）',
        '',
        '原始剧本：',
        body,
        '',
        '演员们读完后的态度，以及【他们各自按本色重写好的戏份】（大家是约好一起来玩话剧的、本子和角色都是 roll 到的，态度只是"对 roll 到的角色合不合胃口"。**以他们重写的台词为基准**：在不违背 ta 的意图、立场和性格的前提下，你可以把台词润色得更有戏、更俏皮、更扣题（删口水话、加强节奏与包袱），但不能改变 ta 想表达的意思或人设。你还负责把各人台词串成完整演出、补旁白、安排上下场、把态度表现化进去；欣然就顺；勉强/隐忍让别扭从神态细节渗出；抵触/拒演让 ta 棒读/敷衍/出戏，但**别写成反目成仇**，底色是"来都来了陪大家玩"）：',
        feedback || '（演员没什么意见）',
        '',
        `**别为了戏剧化而戏剧化**：尊重并放大演员真正投入的情绪——如果有人被这出戏戳中、入戏极深（悲到揪心、燃到起鸡皮、真情流露），就把那份氛围（旁白、停顿、留白、灯光提示）烘托到位；该庄重的别用吐槽冲淡、该哀伤的别强行搞笑。喜怒哀乐，每一种情绪都要给足、给对。`,
        '',
        `**绝对禁忌是硬红线**：任何演员标了【绝对禁忌】的，绝不能违反——宁可把相关剧情改得面目全非也要绕开；演员的【写作指导】请尽量采纳。`,
        `**OOC 红线 · 塔塔开**：如果剧本根本性 OOC、踩了人物真实关系红线（硬把没暧昧的两人凑成恋人、强行 CP、强行扭曲人设），且演员明确抗拒（抵触/拒演/写了禁忌），**别把这种内容硬演成真**——顺着抗拒把这段改得面目全非：当场拒演、罢演风波、集体拆台、跳戏吐槽编剧、把"强行恋爱"演成"强行尴尬/互相嫌弃/笑场翻车"……让"演员造反"本身成为看点。但若某段恰好符合演员的真实关系、没人抗拒，就正常演，别没事找事拆台。`,
        '',
        `请整合成最终演出版，然后严格按下面格式输出（标签外不要写别的）：`,
        `<终本>`,
        `每行一拍，用竖线分隔，四种拍：`,
        `旁白|内容 —— 旁白不止写环境/动作，更可以是旁白君的吐槽、临场救场圆场、对演员演技或状况的调侃，让旁白有戏、有态度，别只写"（灯光暗下）"这种干提示`,
        `上场|演员名`,
        `下场|演员名`,
        `台词|演员名|一句台词`,
        `——台词每拍**不超过 ${bubbleMax} 字**，长的用句号切成多拍（一拍一个气泡）。用"演员名"不是角色名。`,
        `</终本>`,
        `<观众>`,
        `赛博观众名|一句锐评/吐槽（3~4 条，名字与风格各异，有捧有踩）`,
        `</观众>`,
        `<评级>等级 + 半句理由</评级>`,
        '',
        `【评级标准 · 严格打分，别动不动给 S】综合权衡四项：`,
        `① 忠于剧本：最终演出有没有兑现原剧本的核心立意；`,
        `② 选角贴合：演员本色 vs 所演角色设定，贴合加分、违和扣分；`,
        `③ 演技融合：演员的态度/性格有没有自然化进演出（把勉强/抵触处理得妙也加分，处理垮就扣）；`,
        `④ 整体观感。`,
        `档位：S=四项都拔尖的神作（极罕见，慎给）；A=优秀；B=合格、有亮点；C=平庸或有明显短板；D=灾难/跑题/严重违和。请如实评，宁可苛刻。`,
    ].join('\n');
}

export interface ParsedDirector {
    stage: { kind: 'line' | 'narration' | 'enter' | 'exit'; actorName?: string; text: string }[];
    reviews: { critic: string; text: string }[];
    rating: string;
}

export function parseDirectorOutput(raw: string): ParsedDirector {
    const pick = (tag: string) => { const m = raw.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)); return m ? m[1].trim() : ''; };
    const stage: ParsedDirector['stage'] = [];
    for (const line of pick('终本').split('\n').map(l => l.trim()).filter(Boolean)) {
        const parts = line.split('|').map(p => p.trim());
        const head = parts[0];
        if (head === '旁白') stage.push({ kind: 'narration', text: stripLeakedAttrs(parts.slice(1).join('|')) });
        else if (head === '上场') stage.push({ kind: 'enter', actorName: parts[1], text: parts[1] || '' });
        else if (head === '下场') stage.push({ kind: 'exit', actorName: parts[1], text: parts[1] || '' });
        else if (head === '台词') stage.push({ kind: 'line', actorName: parts[1], text: stripLeakedAttrs(parts.slice(2).join('|')) });
    }
    const reviews = pick('观众').split('\n').map(l => l.trim()).filter(Boolean).map(l => {
        const [critic, ...rest] = l.split(/[|｜:：]/);
        return { critic: (critic || '观众').replace(/^[-·•\s]+/, '').trim(), text: rest.join('：').trim() };
    }).filter(r => r.text);
    const rating = stripLeakedAttrs(pick('评级')) || 'B';
    return { stage, reviews, rating };
}
