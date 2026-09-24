export const ROOM_PALETTES={
 sage:{name:'原木黑白绿',wall:'#f0e6d5',floor:'#c8b295',trim:'#725849',body:'#eee3ce',accent:'#858d67',soft:'#b3ba99',dark:'#393e33',light:'#eee9d8'},
 lilac:{name:'原木白紫',wall:'#f0eaf2',floor:'#ccb79f',trim:'#a08672',body:'#f3eee9',accent:'#a394bd',soft:'#cec1df',dark:'#5d536c',light:'#eadbff'},
 blush:{name:'原木粉白',wall:'#f8f0ed',floor:'#d0b69b',trim:'#ad8d76',body:'#fff6f1',accent:'#e7c9d0',soft:'#f3e2e6',dark:'#8b747b',light:'#ffefed'},
 aqua:{name:'原木水色蓝',wall:'#eff5f5',floor:'#cbbda7',trim:'#998976',body:'#f6f9f7',accent:'#bfd8df',soft:'#deedf0',dark:'#738b95',light:'#eafaff'},
 cyber:{name:'电竞黑白紫',wall:'#eeedf2',floor:'#d9d9e0',trim:'#292832',body:'#f3f2f7',accent:'#a38acb',soft:'#cec0e3',dark:'#292832',light:'#cfb6f1',wood:'#f0eff4',woodDark:'#30303a',warmDetail:'#b9bac4'},
};
// Material names, not image sampling: plants, natural wood, glass and fixtures
// keep their authored colors. Registered per-material controls survive sharing.
export function paletteRole(name,assetId=''){
 if((/^kitchen_ref_(mat|runner)$/.test(assetId)&&name==='charcoal')||(assetId==='show_kitchen_bench'&&name==='showroom-cream'))return 'accent';
 if(name==='woodLight')return 'wood';
 if(/^(walnut|showroom-walnut)$/.test(name))return 'woodDark';
 if(/^(gold|rope)$/.test(name))return 'warmDetail';
 if(/^(kitchen-accent|sage|showroom-sage|showroom-lavender|lavender|blush|pink|bath-accent|bath-towel|bath-cream|gaming-accent|study-sage|study-green|pillow-left)$/.test(name))return 'accent';
 if(name==='pillow-right'||name==='kitchen-pink')return 'soft';
 if(/^(porcelain|kitchen-cream|kitchen-ceramic|cream|paper|showroom-cream|gaming-shell|study-cream|study-shelf|study-paper|bath-shell)$/.test(name))return 'body';
 if(/^(charcoal|kitchen-dark|ink|showroom-charcoal|study-shell|gaming-graphite|gaming-rubber|gaming-screen|gaming-metal)$/.test(name))return 'dark';
 if(/^(gaming-led|gaming-mint|gaming-arcade-cyan)$/.test(name))return 'light';
 return null;
}
export function applyRoomPalette(room,key,catalog){
 const palette=ROOM_PALETTES[key];if(!palette)throw Error('找不到这套精装配色');
 for(const part of ['wall','floor','trim'])room[part]=palette[part];
 for(const i of room.items){if(i.stored)continue;const a=catalog.find(a=>a.id===i.assetId);if(!a?.paletteMaterials?.length)continue;
  const colors={...i.materialColors};
  for(const name of a.paletteMaterials){const role=paletteRole(name,a.id);if(!role)continue;
   if(palette[role])colors[name]=role==='wood'&&/table|desk/.test(a.id)&&key==='cyber'?palette.dark:palette[role];
   else delete colors[name]; // Switching back restores authored natural wood.
  }
  i.materialColors=colors;
 }
 return room;
}
