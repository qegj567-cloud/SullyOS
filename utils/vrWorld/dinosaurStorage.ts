import { DINO_ACTIONS, type DinosaurGarden, type DinoPose, type DinoStage } from './dinosaurTypes';
import { createGardenMaps, dinoDefinition, PROP_LABELS } from './dinosaurCatalog';
import { PROP_RADIUS, GARDEN_FLOOR_PROPS } from './dinosaurCatalog';
import { DINO_GRID, snapDinoPose } from './dinosaurGrid';
import { gardenSceneryBlocked } from './dinosaurTerrain';

const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const pose = (p: any): p is DinoPose => object(p) && [p.x,p.z,p.rotation].every(Number.isFinite);
const stage = (s: any): s is DinoStage => object(s) && DINO_ACTIONS.includes(s.action) && typeof s.text==='string' && typeof s.byId==='string' && typeof s.byName==='string' && Number.isFinite(s.at);
/** Migrate the earlier single-table preview without dropping a toy, colour, or original note. */
export function readDinosaurGarden(value: unknown): DinosaurGarden {
  if(!object(value)) throw new Error('箱庭存档格式不兼容；没有覆盖原存档');
  let g = value;
  if(g.version===1 && Array.isArray(g.props) && object(g.toys) && Array.isArray(g.events)) {
    const maps=createGardenMaps(),id=g.theme==='coast'?'coast':'grassland';
    maps.find(m=>m.id===id)!.props=g.props;
    g={...g,version:2,activeMapId:id,maps,toys:Object.fromEntries(Object.entries(g.toys).map(([key,t]:[string,any])=>[key,{...t,mapId:t?.pose?id:null}])),events:g.events.map((e:any)=>({...e,mapId:id}))};
    delete g.props; delete g.theme;
  }
  const fail=()=>{throw new Error('箱庭存档格式不兼容；没有覆盖原存档，请先导出备份');};
  if(g.version!==2||!Array.isArray(g.maps)||!object(g.toys)||!Array.isArray(g.events)||typeof g.visitsEnabled!=='boolean'||!Number.isSafeInteger(g.revision)||g.revision<0) return fail();
  if(!g.maps.length||new Set(g.maps.map((m:any)=>m?.id)).size!==g.maps.length) return fail();
  for(const m of g.maps) {
    if(!object(m)||typeof m.id!=='string'||typeof m.name!=='string'||!['grassland','coast','volcano'].includes(m.theme)||!Array.isArray(m.props))return fail();
    for(const p of m.props)if(!object(p)||typeof p.id!=='string'||!Object.prototype.hasOwnProperty.call(PROP_LABELS,p.kind)||!pose(p))return fail();
  }
  if(!g.maps.some((m:any)=>m.id===g.activeMapId))return fail();
  for(const [id,t] of Object.entries(g.toys)) {
    if(!object(t)||t.catchId!==id||!dinoDefinition(t.speciesId)||typeof t.name!=='string'||typeof t.fixed!=='boolean'||!Number.isSafeInteger(t.revision)||t.revision<0||!object(t.paint)||![t.paint.body,t.paint.accent].every(c=>typeof c==='string'&&/^#[0-9a-f]{6}$/i.test(c))||!stage(t.stage)||!stage(t.userStage)||!object(t.origin)||!['fished','gift','unknown'].includes(t.origin.kind)||!Number.isFinite(t.origin.at))return fail();
    if(t.pose!==null&&(!pose(t.pose)||!g.maps.some((m:any)=>m.id===t.mapId)))return fail();
  }
  for(const e of g.events)if(!object(e)||typeof e.id!=='string'||typeof e.summary!=='string'||typeof e.actorName!=='string'||!Number.isFinite(e.at)||e.before&&(!object(e.before)||e.before.pose&& !pose(e.before.pose)||e.before.stage&&!stage(e.before.stage)))return fail();
  if(g.gridVersion!==1){
    const toys=Object.fromEntries(Object.entries(g.toys).map(([id,t]:[string,any])=>[id,{...t}]));
    for(const map of g.maps){
      const occupied=new Set<string>();
      for(const t of Object.values(toys) as any[]){if(!t.pose||t.mapId!==map.id)continue;
        const old=t.pose,cell=[...DINO_GRID].sort((a,b)=>Math.hypot(a.x-old.x,a.z-old.z)-Math.hypot(b.x-old.x,b.z-old.z)).find(c=>!occupied.has(c.id)&&!gardenSceneryBlocked(map.theme,c,.56)&&!map.props.some((p:any)=>!GARDEN_FLOOR_PROPS.includes(p.kind)&&Math.hypot(c.x-p.x,c.z-p.z)<.56+PROP_RADIUS[p.kind as keyof typeof PROP_RADIUS]));
        if(cell){t.pose=snapDinoPose({...cell,slotId:cell.id,rotation:old.rotation});occupied.add(cell.id);}
        else {t.pose=null;t.mapId=null;}
        t.revision++;
      }
    }
    g={...g,gridVersion:1,toys,revision:g.revision+1};
  }
  return g as DinosaurGarden;
}
