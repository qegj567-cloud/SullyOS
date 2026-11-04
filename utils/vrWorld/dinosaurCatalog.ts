import type { DinoPaint, GardenPropKind, GardenProp, GardenMap } from './dinosaurTypes';
export const DINO_CATALOG = [
  {id:'tyrannosaurus',name:'霸王龙',nickname:'莓莓',body:'#cd8f8b',accent:'#e8d9ba',fact:'霸王龙有两根手指。眼前这只用橡皮泥捏成，手还是有一点短。'},
  {id:'triceratops',name:'三角龙',nickname:'小角',body:'#85a6b2',accent:'#f3e5c9',fact:'三角龙是植食恐龙，三只角和大颈盾让它很好认。这只的角也是软软的橡皮泥。'},
  {id:'stegosaurus',name:'剑龙',nickname:'曲奇',body:'#c9b477',accent:'#c18a89',fact:'剑龙背上有两排骨板，尾巴还有尖刺。橡皮泥背板很像一排饼干。'},
  {id:'brachiosaurus',name:'腕龙',nickname:'薄荷',body:'#87b3a5',accent:'#e8d9ba',fact:'腕龙的前肢比后肢长，肩膀因此更高。这根脖子是艾文慢慢搓出来的。'},
  {id:'velociraptor',name:'迅猛龙',nickname:'小灰',body:'#aaa5b2',accent:'#e8d9ba',fact:'伶盗龙常被叫作迅猛龙，它有羽毛，也没有电影里那么大。模型脚上留了弯弯的小爪。'},
  {id:'spinosaurus',name:'棘龙',nickname:'葡萄',body:'#9685a6',accent:'#786889',fact:'棘龙有长吻和高高的背帆。我们对它如何在水里活动的认识还在更新。'},
  {id:'ankylosaurus',name:'甲龙',nickname:'栗子',body:'#b6a18c',accent:'#a48f7b',fact:'甲龙身披骨甲，尾端有骨锤。这只身上的小疙瘩是一颗颗按上去的。'},
  {id:'parasaurolophus',name:'副栉龙',nickname:'桃桃',body:'#d3a6a4',accent:'#e8d9ba',fact:'副栉龙有向后伸出的中空头冠，与发声有关。它是鸭嘴龙类的一员。'},
  {id:'pteranodon',name:'无齿翼龙',nickname:'风筝',body:'#a5bac5',accent:'#ddd2b9',fact:'翼龙是会飞的爬行动物，并不属于恐龙。艾文还是让它加入了这盒橡皮泥模型。'},
  {id:'plesiosaur',name:'蛇颈龙',nickname:'泡泡',body:'#95b6c8',accent:'#dddcca',fact:'蛇颈龙是海生爬行动物，也不属于恐龙。四只桨状鳍很适合摆在浅水旁边。'},
  {id:'dinosaur-egg',name:'恐龙蛋',nickname:'咕噜',body:'#e5dcc5',accent:'#98ad8b',fact:'一个橡皮泥小蛋。“孵化”是箱庭的揭晓小游戏，里面也是橡皮泥模型。'},
  {id:'dinosaur-fossil',name:'恐龙骨架',nickname:'小骨',body:'#dfd2b4',accent:'#aa967b',fact:'这是一副用橡皮泥拼出的骨架模型。真实化石与橡皮泥的成分和来历都不一样。'},
  {id:'aiven-chimera',name:'？？？',nickname:'？？？',body:'#b784b5',accent:'#9ebdc9',fact:'霸王龙的身体、三角龙的角、剑龙的骨板、腕龙的脖子。发现于 SAR 活动室水域。艾文：「不知道是什么。」「所以不用纠正。」'},
  {id:'halloween-dinosaur',name:'万圣小恐龙',nickname:'小恶魔',body:'#42364f',accent:'#9a83af',fact:'艾文在万圣夜送来的黑紫色小恐龙，背着一对小恶魔翅膀。看起来乖乖的。'},
] as const;
export const dinoDefinition=(id:string)=>DINO_CATALOG.find(d=>d.id===id);
export const defaultDinoPaint=(id:string):DinoPaint=>{const d=dinoDefinition(id)||DINO_CATALOG[0];return {body:d.body,accent:d.accent};};
export const DINO_PALETTES = [
  {name:'草莓奶',body:'#d69a9f',accent:'#f3ddba'}, {name:'薄荷糖',body:'#87b5a4',accent:'#e5d6ae'},
  {name:'蓝莓酪',body:'#9295bf',accent:'#dab2c2'}, {name:'小奶油',body:'#dec48e',accent:'#b38488'},
  {name:'雨天蓝',body:'#8dabbc',accent:'#e8e0ce'}, {name:'可可豆',body:'#aa8a72',accent:'#e5c9a2'},
];
export const PROP_LABELS:Record<GardenPropKind,string>={tree:'小树',rock:'小石头',tent:'小帐篷',stump:'木桩',volcano:'火山',fence:'栅栏',sign:'路牌',house:'玩具小屋',picnic:'野餐垫',puddle:'小水洼',flowers:'花丛'};
export const PROP_RADIUS:Record<GardenPropKind,number>={tree:.43,rock:.42,tent:.65,stump:.35,volcano:.9,fence:.55,sign:.26,house:.6,picnic:.65,puddle:.65,flowers:.46};
/** Ground mats and the small perch support a dinosaur; other solid scenery blocks placement. */
export const GARDEN_FLOOR_PROPS:readonly GardenPropKind[]=['picnic','puddle','flowers','stump'];
export const PROP_ACTIVITIES:Record<GardenPropKind,string>={tree:'够一够树叶',rock:'靠着歇一会儿',tent:'在门口蜷起来睡觉',stump:'爬上去放哨',volcano:'装饰 · 探险小景',fence:'装饰 · 围出小院',sign:'装饰 · 指个方向',house:'装饰 · 一间小屋',picnic:'守着饼干吃点心',puddle:'踩水玩',flowers:'低头闻花，花朵轻晃'};
export const DEFAULT_PROPS:GardenProp[]=[
  {id:'tree-a',kind:'tree',x:-3.25,z:-3.35,rotation:0},{id:'tree-b',kind:'tree',x:-2.15,z:-3.55,rotation:.6},
  {id:'tent-a',kind:'tent',x:-1.05,z:-3.3,rotation:.2},{id:'rock-a',kind:'rock',x:3.15,z:1.7,rotation:0},
  {id:'stump-a',kind:'stump',x:-3.25,z:.1,rotation:0},{id:'sign-a',kind:'sign',x:-3.05,z:3.5,rotation:0},
  {id:'picnic-a',kind:'picnic',x:-1.3,z:1.9,rotation:0},{id:'flowers-a',kind:'flowers',x:0,z:-.6,rotation:0},
];
export const createGardenMaps = (): GardenMap[] => [
  {id:'grassland',name:'溪边草原',theme:'grassland',artVersion:3,props:DEFAULT_PROPS.map(p=>({...p})).concat([{id:'grass-house',kind:'house',x:3.15,z:-2.8,rotation:-.3}])},
  {id:'coast',name:'贝壳海岸',theme:'coast',artVersion:3,props:[
    {id:'coast-tree',kind:'tree',x:-3.2,z:-1.8,rotation:0},{id:'coast-palm',kind:'tree',x:-2.15,z:-3.5,rotation:.7},
    {id:'coast-house',kind:'house',x:-2.95,z:.3,rotation:.15},{id:'coast-rock',kind:'rock',x:.3,z:3.3,rotation:.2},
    {id:'coast-sign',kind:'sign',x:-3.2,z:3.6,rotation:0}]},
  {id:'volcano',name:'火山探险',theme:'volcano',artVersion:3,props:[
    {id:'volcano-main',kind:'volcano',x:-2.8,z:-3,rotation:0},{id:'volcano-rock',kind:'rock',x:-1.4,z:-3.4,rotation:.4},
    {id:'volcano-tent',kind:'tent',x:3.1,z:-2.8,rotation:-.3},{id:'volcano-sign',kind:'sign',x:-3.2,z:3.4,rotation:0},
    {id:'volcano-stump',kind:'stump',x:-3.25,z:0,rotation:0},{id:'volcano-stone',kind:'rock',x:3.25,z:2.6,rotation:0}]},
];
