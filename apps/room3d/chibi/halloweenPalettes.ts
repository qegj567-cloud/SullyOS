export const halloweenPaletteKeys=['orange','purple','green','gold'] as const;
export function halloweenPalette(outfit:string,id:string):Record<string,string>|undefined {
 const colors=id==='midnight'?(outfit==='shorts'?['#25252c','#202026','#494951','#686875']:['#16151d','#22212b','#80818c','#c5c7d1']):id==='crimson'?['#711a30','#191720','#9a3448','#c69f61']:id==='moonlight'?['#3c648b','#202a48','#8dbdc6','#cadbe6']:undefined;
 return colors?Object.fromEntries(halloweenPaletteKeys.map((key,i)=>[key,colors[i]])):undefined;
}
