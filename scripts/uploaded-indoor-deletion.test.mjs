import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {createServer} from 'vite';
let vite,OverpassTiles,EditSession;
before(async()=>{
 globalThis.window={};globalThis.location={search:'?server=osm',href:'http://localhost/?server=osm'};
 vite=await createServer({configFile:false,server:{middlewareMode:true,ws:false,watch:null},appType:'custom'});
 ({OverpassTiles}=await vite.ssrLoadModule('/src/view/overpass-tiles.ts'));
 ({EditSession}=await vite.ssrLoadModule('/src/edit/session.ts'));
});
after(async()=>{await vite.close();delete globalThis.window;delete globalThis.location;});
test('uploaded wall stays hidden after markSaved removes the session deletion and a stale snapshot arrives',()=>{
 const cache=Object.create(OverpassTiles.prototype);cache.uploaded={};
 const key='way/1344805285',wall={key,version:1,tags:{indoor:'wall'},polygons:[]};
 const session=new EditSession([wall],()=>{});
 session.editMany([{key,delete:true}]);assert.equal(session.isDeleted(key),true);
 cache.noteUploaded(new Map(),[key]);
 session.markSaved(new Map(),[key]);assert.equal(session.isDeleted(key),false);
 const stale=[wall,{...wall,key:'way/2'}];
 assert.deepEqual(stale.filter(f=>!cache.wasUploadedDeleted(f.key)).map(f=>f.key),['way/2']);
 assert.equal(cache.wasUploadedDeleted(key+'#poi'),true);
 cache.uploaded[key].at=Date.now()-25*60*60*1000;
 assert.equal(cache.wasUploadedDeleted(key),false);
});
