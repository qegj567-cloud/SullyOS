import type {Message, MessageType} from '../types';
import {BEAUTY_PREVIEW_AVATAR} from './beautyPreviewAssets';

// Synthetic only: no DB reads, real identities, API calls, payments or app navigation.
const base = {charId:'whitebox-preview',role:'assistant' as const,timestamp:1790386860000};
const msg = (id:number,type:MessageType,content:string,metadata?:Record<string,unknown>,role:Message['role']='assistant'):Message => ({...base,id,type,content,metadata,role});
export const CHAT_TYPE_SAMPLES = {
 friend_feed_share_card:msg(30,'friend_feed_share_card','[分享好友圈帖子]',{friendFeedShare:{version:1,postId:'sample-share',authorId:'user',authorName:'小雨',text:'在小巷里找到一家很小的咖啡店。\n窗边的位置刚好留给两个人。',sharedAt:1790386860000,comments:[{id:'reply',authorId:'whitebox-preview',authorName:'小白',text:'靠窗的那个位置，先替我占着。',createdAt:1790386860000}],originalComments:[],imagesEnabled:false,imageRefs:[],imageCount:0}},'user'),
 text:msg(1,'text','欢迎回家。今天也有想和你分享的小事。'),
 image:msg(2,'image',BEAUTY_PREVIEW_AVATAR),
 emoji:msg(3,'emoji',BEAUTY_PREVIEW_AVATAR),
 voice:msg(4,'voice','晚安，明天见。',{duration:6}),
 collaboration_file:msg(5,'collaboration_file','一起整理的旅行手册.pdf',{fileName:'一起整理的旅行手册.pdf',mimeType:'application/pdf',fileSize:286720,format:'pdf'}),
 interaction:msg(6,'interaction','戳了戳'),
 transfer:msg(7,'transfer','给你买一杯热饮',{amount:25,note:'给你买一杯热饮',status:'pending'}),
 system:msg(8,'system','以下是装扮预览的虚构消息',undefined,'system'),
 social_card:msg(9,'social_card','今天的小确幸',{post:{title:'今天的小确幸',content:'在转角遇见了一家花店。',images:['🌼'],authorName:'示例作者'}}),
 chat_forward:msg(10,'chat_forward',JSON.stringify({fromUserName:'我',fromCharName:'示例角色',count:2,preview:['我：周末去看海吧。','示例角色：好，一起。'],messages:[]})),
 xhs_card:msg(11,'xhs_card','周末散步路线',{xhsNote:{title:'周末散步路线',desc:'沿着河边慢慢走。',authorName:'示例作者',likes:128}}),
 score_card:msg(12,'score_card','写给晚风的歌',{scoreCard:{title:'写给晚风的歌',genre:'民谣',lyrics:'晚风替我捎去一句晚安。',author:'示例角色'}}),
 music_card:msg(13,'music_card','一起听歌',{song:{songId:0,name:'晚风来信',artists:'示例歌手',albumPic:''},intent:'join'}),
 mcd_card:msg(14,'mcd_card','推荐菜单',{mcdCardKind:'proposal',mcdProposal:{items:[{name:'薯条'},{name:'汉堡'}]}}),
 luckin_card:msg(15,'luckin_card','下午茶',{luckinCardKind:'proposal',luckinProposal:{items:[{name:'拿铁'},{name:'可颂'}]}}),
 html_card:msg(16,'html_card','给你的小纸条',{htmlSource:'<article style="width:240px;padding:22px;background:#fff5df;border-radius:16px;box-sizing:border-box"><h3>给你的小纸条</h3><p>今天也要好好吃饭。</p></article>'}),
 news_card:msg(17,'news_card','城市书展',{title:'周末的城市书展开始了',source:'示例资讯',desc:'一起去找一本喜欢的书。'}),
 vr_card:msg(18,'vr_card','在图书馆读完了短篇小说。',{room:'library',summary:'在窗边坐了一下午。',privateWords:'下次想和你一起来。'}),
 trpg_card:msg(19,'trpg_card','一次冒险',{trpg:{gameTitle:'月光森林',partyNames:['示例角色','我'],excerpt:[{speaker:'旁白',text:'林间亮起一盏灯。'},{speaker:'示例角色',text:'跟紧我。'}]}}),
 novel_card:msg(20,'novel_card','一起写的书',{novel:{bookTitle:'海边来信',collaboratorNames:['示例角色','我'],chapters:[{index:1,summary:'故事从一封信开始。'}]}}),
 world_card:msg(21,'world_card','另一个世界的一天',{worldName:'小城',narrative:'街角的花店开门了。',statusPanel:{心情:'轻松'},phonePosts:['今天遇见了一只猫。']}),
 sim_card:msg(22,'sim_card','一段回忆',{simCard:{title:'雨后散步',theme:'日常',summary:'我们共撑一把伞，慢慢走过长街。',ending:'平凡又美好'}}),
 phone_card:msg(23,'phone_card','手机动态',{phoneCard:{kind:'app',app:'备忘录',title:'周末计划',detail:'买花、看电影，记得带伞。'}}),
 webpage_card:msg(24,'webpage_card','收藏的网页',{webpage:{title:'一份周末出行清单',description:'把喜欢的小事记下来。',url:'https://example.com',siteName:'示例网页'}}),
 theater_card:msg(25,'theater_card','一段回放',{activity:'窗边看书',slotTime:'09:30',theater:{lines:[{text:'翻开书页，又想起了你。'},{text:'“下次一起看这本。”'}]}}),
 room_card:msg(26,'room_card','给窗台的植物浇了水。',{emoji:'🌱'}),
 life_card:msg(27,'life_card','今天走了很远',{module:'exercise',summary:'散步 30 分钟',dateStr:'2026-09-26',reviewStatus:'active'}),
 group_topic_card:msg(28,'group_topic_card','群聊回忆',{groupTopicBox:{title:'周末野餐',summary:'大家约好了带上各自拿手的食物。',groupName:'朋友们',messageCount:12}}),
 friend_feed_card:msg(29,'friend_feed_card','[好友圈记录] 你评论：那我带杯子过来。',{source:'friend_feed',friendFeedComment:{postId:'preview-coffee',commentId:'preview-comment',postAuthor:'小雨',postExcerpt:'今天终于把咖啡机研究明白了。先声明：上次的焦味不算。',comment:'那我带杯子过来。焦味的那杯先留给你。'}},'system'),
} satisfies Record<MessageType, Message>;

export interface ChatPreviewScene {id:string;label:string;messages:Message[];expanded?:boolean;voiceLoading?:boolean;voicePlaying?:boolean}
const scene=(id:string,label:string,messages:Message[],extra:Partial<ChatPreviewScene>={}):ChatPreviewScene=>({id,label,messages,...extra});
const score=(id:number,type:string,extra:Record<string,unknown>)=>msg(id,'score_card','示例分享',{scoreCard:{type,...extra}});
export const CHAT_PREVIEW_SCENES:ChatPreviewScene[] = [
 scene('conversation','普通聊天',[
  CHAT_TYPE_SAMPLES.text,
  msg(102,'text','刚才看到一朵很漂亮的云，想等你回来一起看。'),
  msg(101,'text','我也有想分享的！',undefined,'user'),
  msg(160,'text','我发现了一套很喜欢的美化，想换上试试。连着说两句，也能看看气泡和头像的间距。',undefined,'user'),
 ]),
 scene('psyche','心象 · 折叠',[msg(103,'text','回来就好。',{thinkingChain:'听到开门的声音，忽然想把刚才看到的那朵云也分享给你。这段文字只是用来检查心象排版的示例。'})]),
 scene('psyche-open','心象 · 展开',[msg(104,'text','回来就好。',{thinkingChain:'听到开门的声音，忽然想把刚才看到的那朵云也分享给你。\n\n这是一段较长的虚构文字，用来检查字号、行距、换行和展开后的阅读效果。'})],{expanded:true}),
 scene('transfer','转账 · 待接收',[CHAT_TYPE_SAMPLES.transfer]),
 ...(['accepted','returned'] as const).map((status,i)=>scene('transfer-'+status,status==='accepted'?'转账 · 已接收与回执':'转账 · 已退回与回执',[msg(110+i,'transfer','热饮',{amount:25,status,note:'给你买一杯热饮'}),msg(120+i,'transfer','回执',{amount:25,receipt:status},'user')])),
 scene('voice','语音',[msg(130,'text','<语音>晚安，明天见。</语音>'),CHAT_TYPE_SAMPLES.voice]),
 scene('voice-loading','语音 · 加载',[msg(131,'text','<语音>晚安。</语音>')],{voiceLoading:true}),
 scene('voice-playing','语音 · 播放与字幕',[msg(132,'text','<语音>晚安，明天见。</语音>')],{voicePlaying:true,expanded:true}),
 scene('reply','引用与双语',[{...msg(140,'text','%%BILINGUAL%%\n[LANG_A]明天一起看海。[/LANG_A]\n[LANG_B]Let’s see the sea tomorrow.[/LANG_B]'),replyTo:{id:0,name:'我',content:'周末有什么安排？'}}]),
 ...Object.entries(CHAT_TYPE_SAMPLES).filter(([type])=>!['text','transfer','voice'].includes(type)).map(([type,message])=>scene(type,({friend_feed_share_card:'好友圈分享',friend_feed_card:'好友圈评论',image:'图片',emoji:'表情',collaboration_file:'协同文件',interaction:'互动',system:'系统提示',social_card:'动态分享',chat_forward:'聊天转发',xhs_card:'小红书',score_card:'写歌',music_card:'音乐',mcd_card:'麦当劳',luckin_card:'瑞幸',html_card:'HTML 卡片',news_card:'资讯',vr_card:'彼方',trpg_card:'跑团',novel_card:'笔友会',world_card:'世界',sim_card:'人生体验',phone_card:'查手机',webpage_card:'网页',theater_card:'剧场',room_card:'小屋',life_card:'生活记录',group_topic_card:'群聊话题'} as Record<string,string>)[type], [message])),
 scene('quiz','答题报告',[score(150,'quiz_card',{score:9,total:10,scorePercent:90,courseTitle:'文学小测',chapterTitle:'第一章'})]),
 scene('guidebook','攻略本',[score(151,'guidebook_card',{title:'心动练习',charName:'示例角色',initialAffinity:20,finalAffinity:35,charVerdict:'今天更了解你了。',charNewInsight:'你会记住每一件小事。',rounds:5})]),
 scene('whiteday','白色情人节',[score(152,'whiteday_card',{charName:'示例角色',score:8,total:10,passed:true,finalDialogue:'这份巧克力送给你。'})]),
 scene('like520','520 卡片',[score(153,'like520_card',{title:'喜欢你的每一天',charName:'示例角色',timestamp:base.timestamp,message:'想和你一起看好多次日落。'})]),
 scene('qixi','七夕卡片',[score(154,'qixi_event_card',{title:'星月梦境',charName:'示例角色',userName:'我',summary:'一起走过星光搭成的桥。',timestamp:base.timestamp})]),
 scene('lifesim','都市人生结算',[{...score(155,'lifesim_reset_card',{title:'城市小结',summary:'又在这座城市里留下了一些回忆。',userName:'我',charName:'示例角色',participantNames:['示例角色'],mainPlotCount:3,turnCount:12}),role:'system'}]),
 scene('diary','日记卡片',[{...score(156,'diary_card',{date:'2026-09-26',userText:'今天一起散步。',charText:'记得你说路边的花很好看。',charName:'示例角色'}),role:'system'}]),
 scene('call','通话回忆',[msg(157,'system','一次愉快的通话',{source:'call-end-popup',durationSec:120,turnCount:6,keepsakeLine:'分享了今天发生的小事。'},'system')]),
 scene('schedule','日程修改回执',[]),
];
// A complete, scrollable conversation is also available, in addition to focused scenes.
CHAT_PREVIEW_SCENES.unshift(scene('all','完整聊天记录',Array.from(new Map(CHAT_PREVIEW_SCENES.flatMap(item=>item.messages).map(message=>[message.id,message])).values())));
