import { DEFAULT_SETTINGS, newPart, type Job, type Result, type Part, type Ring } from '../model';
import { bounds, normalizeJob, normalizeRing } from '../geometry/normalize';

export type ImportReview = { document: Job; warnings: string[]; issues?:string[]; layers?:string[] };
export function record(value: unknown): Record<string,unknown> {
  if(!value || typeof value!=='object' || Array.isArray(value)) throw Error('Expected an object.');
  return value as Record<string,unknown>;
}
export function number(value: unknown): number {
  if(typeof value!=='number' || !Number.isFinite(value)) throw Error('Expected a finite number.');
  return value;
}
export function localize(part: Part): Part {
  const [x,y]=bounds(part.outer);
  const shift=(ring: Ring): Ring=>ring.map(p=>[p[0]-x,p[1]-y]);
  return {...part,outer:shift(part.outer),holes:part.holes.map(shift)};
}
export function importSparrow(text: string,fileName: string,scale: number): ImportReview {
  if(!Number.isFinite(scale) || scale<=0) throw Error('Choose a positive millimeter scale.');
  const input=record(JSON.parse(text));
  if(typeof input.name!=='string' || !Array.isArray(input.items)) throw Error('Expected a sparrow ExtSPInstance with name and items.');
  const ids=new Set<number>();
  const parts=input.items.map(raw=>{
    const item=record(raw),shape=record(item.shape),id=number(item.id);
    if(!Number.isSafeInteger(id) || id<0 || ids.has(id)) throw Error('sparrow item IDs must be unique nonnegative safe integers.');
    ids.add(id);
    let outer: Ring,holes: Ring[]=[];
    const scaled=(ring: unknown): Ring=>normalizeRing(ring).map(p=>[p[0]*scale,p[1]*scale]);
    if(shape.type==='simple_polygon') outer=scaled(shape.data);
    else if(shape.type==='polygon') {
      const data=record(shape.data);
      outer=scaled(data.outer);
      if(data.inner!==undefined && !Array.isArray(data.inner)) throw Error('Polygon inner contours must be an array.');
      holes=((data.inner ?? []) as unknown[]).map(scaled);
    } else if(shape.type==='rectangle') {
      const d=record(shape.data),x=number(d.x_min),y=number(d.y_min),w=number(d.width),h=number(d.height);
      if(w<=0 || h<=0) throw Error('Rectangle dimensions must be positive.');
      outer=scaled([[x,y],[x+w,y],[x+w,y+h],[x,y+h]]);
    } else throw Error(`Item ${id}: ${String(shape.type)} is unsupported. Disjoint JSON items cannot be split without changing demand.`);
    const orientations=item.allowed_orientations;
    if(orientations!==undefined && orientations!==null && (!Array.isArray(orientations) || !orientations.length || !orientations.every(a=>typeof a==='number' && Number.isFinite(a)))) throw Error(`Item ${id}: allowed_orientations must be omitted for free rotation or a nonempty degree list.`);
    return localize({...newPart(outer,`Part ${id}`),holes,quantity:number(item.demand),priority:item.priority===undefined?0:number(item.priority),
      source:{format:'sparrow',fileName,entityId:String(id)},
      rotations: orientations==null?{kind:'continuous'}:{kind:'discrete',degrees:orientations as number[]}});
  });
  return {document:normalizeJob({name:input.name,parts,settings:{...DEFAULT_SETTINGS,materialWidthMm:number(input.strip_height)*scale}}),
    warnings:[...(input.solution!==undefined?['Stored native solution is ignored; warm starts are not supported.']:[]),
      `One coordinate unit = ${scale} mm. Benchmark coordinates have no intrinsic manufacturing units.`,
      ...(parts.some(p=>p.holes.length)?['Holes are preserved; nesting inside holes is not supported.']:[])]};
}
export function solverInput(doc: Job, initialPlacement?: Result): string {
  if(!doc.parts.some(part=>part.quantity>0))throw Error('Add at least one copy before nesting.');
  const parts = doc.parts.filter(part=>part.quantity>0);
  const ids = new Map(parts.map((part, id) => [part.id, id]));
  const initial = initialPlacement ? {
    used_length_mm: initialPlacement.usedLengthMm,
    placements: initialPlacement.placements.map(placement => {
      const item_id = ids.get(placement.partId);
      if (item_id === undefined) throw Error('Initial placement contains a part outside the current job.');
      return { item_id, rotation: placement.angleDeg, translation: [placement.xMm, placement.yMm] };
    }),
  } : undefined;
  return JSON.stringify({name:doc.name,strip_height:doc.settings.materialWidthMm,
    initial_placement:initial,
    stock_length:initial ? doc.settings.sheetLengthMm : undefined,
    stock_geometry:doc.settings.sheetStock?.kind==='polygon'?{
      outer:doc.settings.sheetStock.outer,holes:doc.settings.sheetStock.holes,
    }:undefined,
    items:doc.parts.filter(part=>part.quantity>0).map((p,id)=>({
    id,demand:p.quantity,priority:p.priority ?? 0,allowed_orientations:p.rotations.kind==='continuous'?undefined:p.rotations.degrees,
    shape:{type:'simple_polygon',data:p.outer},
  }))});
}
