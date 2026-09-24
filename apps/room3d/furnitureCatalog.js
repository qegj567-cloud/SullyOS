import {KITCHEN_CAPABILITIES,KITCHEN_LABELS} from './kitchenActivities.js';
import {BATH_ACTIONS} from './bathroom.js';
// Browsing taxonomy is separate from placement surfaces and interaction contracts.
import {isMirror} from './mirror.js';
export const ROOM_CATEGORIES={living:'客厅',gaming:'电竞',kitchen:'厨房',bathroom:'浴室',bedroom:'卧室'};
export const USE_CATEGORIES={seating:'桌椅沙发',bedding:'床铺寝具',storage:'柜子收纳',kitchen:'厨房用品',bathroom:'卫浴用品',appliances:'家用电器',gaming:'电脑娱乐',lighting:'灯具照明',decor:'装饰摆件',plants:'花草绿植',textiles:'地毯布艺',pets:'宠物用品',outdoor:'户外庭院',special:'特殊设施'};
const groups={
 seating:'show_spa_stool show_study_desk show_study_tea_table show_study_pouf show_kitchen_island show_kitchen_bench show_living_sofa show_living_table show_living_pouf show_bedroom_pouf desk worktable chair sofa table pouf petal_sofa petal_armchair daisy_table gaming_desk gaming_chair dining_table dining_chair bath_stool bedroom_vanity bedroom_stool bedroom_bench bedroom_desk_chair',
 bedding:'show_bed loft bedroom_bunk bedroom_loft bedroom_single_bed bedroom_double_bed',
 storage:'kitchen_ref_rack kitchen_ref_trolley show_spa_chest show_study_shelf show_study_tower show_living_console show_wardrobe show_bedroom_low_shelf show_bedroom_dresser show_bedroom_bench bookcase tank nightstand high_shelf left_shelf media_cabinet gaming_display gaming_drawers gaming_organizer bath_cart bath_hamper bath_towel_rack bath_linen_cabinet bedroom_wardrobe bedroom_nightstand bedroom_dresser bedroom_jewelry_box',
 kitchen:'kitchen_ref_window kitchen_ref_prep kitchen_ref_hood kitchen_ref_shelves kitchen_ref_breakfast kitchenware_coffee kitchenware_pot kitchenware_board kitchenware_tools kitchenware_spices kitchenware_plates kitchenware_rail kitchenware_settings suite_tea_tray show_kitchen_counter show_kitchen_range kitchen_bin kitchen_cart kitchen_sink kitchen_spice_shelf kitchen_appliance_shelf kitchen_range kitchen_fridge kitchen_island kitchen_fruit_bowl kitchen_cat_jar tea_mug daisy_mug daisy_cookies dining_napkins',
 bathroom:'show_spa_bucket bath_vanity bath_shower bath_washer bath_detergent bath_tub bath_tray bath_soap bath_toilet',
 appliances:'small_television',
 gaming:'little_console little_controller gaming_monitors gaming_keyboard gaming_mouse gaming_speaker gaming_racing gaming_microphone gaming_headphones gaming_webcam gaming_controller_dock gaming_pc gaming_maimai',
 lighting:'show_spa_lantern pendant bedside jelly_lamp gaming_lamp gaming_light bedroom_floor_lamp bedroom_table_lamp',
 decor:'suite_dressing_mirror suite_floor_mirror suite_window_spa suite_window_study suite_window_kitchen suite_window_living suite_window_bedroom suite_art_moon suite_art_botanical suite_art_abstract suite_wall_shelf suite_books_plant porthole open_book left_gallery back_gallery daisy_books wooden_window gaming_notepad gaming_phone_stand bedroom_brushes bedroom_perfume bedroom_brush_cup bedroom_rabbit bedroom_jelly bedroom_turtle bedroom_stationery bedroom_pillow_plush bedroom_alarm bedroom_mirror bedroom_scent',
 plants:'suite_plant_large suite_plant_small corner_plant wall_plant plant small_plant trailing_plant monstera daisy_vase dining_vase',
 textiles:'kitchen_ref_runner kitchen_ref_mat suite_rug_grid suite_rug_border rug bath_mat bath_folded_towels',
 pets:'show_cat_tree pet_bowls',outdoor:'',special:'show_spa_pool aquarium',
};
export const USE_BY_ID=Object.fromEntries(Object.entries(groups).flatMap(([category,ids])=>ids.split(' ').filter(Boolean).map(id=>[id,category])));
for(const [category,ids]of Object.entries({pets:'cat_tree',seating:'sofa',appliances:'television',decor:'window wall_shelf clock bookcase_top tea_tray books',storage:'console bookcase record_cabinet',plants:'tree console_plant',textiles:'rug'}))for(const id of ids.split(' '))USE_BY_ID['living_ref_'+id]=category;
for(const [category,ids]of Object.entries({decor:'window memo wall_shelves headphone_board',appliances:'printer_set',plants:'cabinet_plants',lighting:'floor_light task_lamp',storage:'cart',textiles:'rug entry_mat'}))for(const id of ids.split(' '))USE_BY_ID['study_ref_'+id]=category;
for(const [category,ids]of Object.entries({storage:'sideboard dresser bench wardrobe nightstand',seating:'flower_pouf tea_table',lighting:'floor_lamp bedside_top',textiles:'rug entry_mat',decor:'wardrobe_top sideboard_top dresser_top sleeping_cat tea wall_rack moon_art photo_string window sill_garden bin'}))for(const id of ids.split(' '))USE_BY_ID['bedroom_ref_'+id]=category;
const bedroomIds=new Set('loft nightstand bedside corner_plant'.split(' '));
const gamingIds=new Set(['desk','worktable','chair']);
export function furnitureRoom(a){return ROOM_CATEGORIES[a.collection]?a.collection:bedroomIds.has(a.id)?'bedroom':gamingIds.has(a.id)?'gaming':'living';}
export function furnitureUse(a){return USE_BY_ID[a.id]||(a.beds?.length?'bedding':a.seats?.length?'seating':a.holdable?'decor':a.waterable?'plants':'decor');}
export function matchesFurniture(a,mode,category){return a.id!=='shell'&&!a.building&&(category==='all'||(mode==='room'?furnitureRoom(a):furnitureUse(a))===category);}
// Only advertised capabilities already wired to real actions. Combo requirements
// are explicit; an old model resembling a chair/bed doesn't acquire a preset.
export function furnitureActions(a){
 const actions=[];const kitchen=KITCHEN_CAPABILITIES[a.id];if(KITCHEN_LABELS[kitchen])actions.push(KITCHEN_LABELS[kitchen]);
 if(BATH_ACTIONS[a.id])actions.push(BATH_ACTIONS[a.id].label);
 if(isMirror(a))actions.push('臭美','穿搭（同房间需衣柜）');
 if(a.seats?.length)actions.push('坐坐');if(a.beds?.length)actions.push('躺下休息');if(a.holdable)actions.push('抱抱');
 if(a.surface==='floor'&&a.waterable===true)actions.push('浇水');if(a.appliance==='fridge')actions.push('开关冰箱');
 const kind={race:'玩赛车（需配座椅）',rhythm:'玩圆环音游',computer:'玩电脑',stream:'直播'}[a.activity?.kind];if(kind)actions.push(kind);
 if(a.id==='gaming_desk')actions.push('玩电脑 / 直播（需配设备和座椅）');
 if(a.dining)actions.push('吃饭（需配餐椅）');
 return actions;
}

for(const [category,ids]of Object.entries({decor:'towel_shelf toilet_shelf botanical window towel_hooks robe laundry_top cabinet_top',plants:'hanging_plant trailing_plant shower_plant',textiles:'shower_mat bath_mat flower_mat slippers',storage:'basket'}))for(const id of ids.split(' '))USE_BY_ID['bathroom_ref_'+id]=category;
