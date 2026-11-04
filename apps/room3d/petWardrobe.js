export const PET_HATS=[
 {id:'witch',name:'小巫师帽',description:'歪歪帽尖，偷偷施个小魔法',color:'#48415d'},
 {id:'pumpkin',name:'南瓜帽',description:'顶一颗小南瓜，出门要糖啦',color:'#d99152'},
];
export const normalizePetHat=value=>PET_HATS.some(h=>h.id===value)?value:null;
