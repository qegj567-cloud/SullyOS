import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {expect,it,vi} from 'vitest';

it('exports readable legacy collaboration attachments and reports null blobs without losing their source rows', async()=>{
 const source=readFileSync(new URL('../context/OSContext.tsx',import.meta.url),'utf8');
 const file=ts.createSourceFile('OSContext.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 let loop:ts.ForStatement|undefined;
 const visit=(node:ts.Node)=>{if(ts.isForStatement(node)&&node.getText(file).includes('const asset = collaborationAssets[index]'))loop=node;else ts.forEachChild(node,visit);};visit(file);
 expect(loop).toBeDefined();
 const js=ts.transpileModule(loop!.getText(file),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const run=new (Object.getPrototypeOf(async()=>{}).constructor)('collaborationAssets','zip','backupData','missingAssets',js);
 const assets=[{id:'lost',blob:null},{id:'kept',blob:new Blob(['file'],{type:'image/png'}),createdAt:123}];
 const zip={fileBlob:vi.fn()},data={collaborationAssetIndex:[]},missing:any[]=[];
 await run(assets,zip,data,missing);
 expect(zip.fileBlob).toHaveBeenCalledTimes(1);
 expect(data.collaborationAssetIndex).toEqual([expect.objectContaining({id:'kept',mimeType:'image/png',size:4})]);
 expect(missing).toEqual([{id:'collaboration:lost',locations:['协同工作附件']}]);
 expect(assets[0].blob).toBeNull();expect(assets).toHaveLength(2);
});
