import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {createServer} from 'vite';
let vite,h,u,p;
before(async()=>{
 vite=await createServer({configFile:false,server:{middlewareMode:true,ws:false,watch:null},appType:'custom'});
 h=await vite.ssrLoadModule('/src/osm/heights.ts');
 u=await vite.ssrLoadModule('/src/osm/units.ts');
 p=await vite.ssrLoadModule('/src/edit/push-height.ts');
});
after(async()=>{await vite.close();});
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-6,`${a} != ${b}`);
test('parseLength understands the units from the wiki',()=>{
 near(h.parseLength('12'),12);near(h.parseLength('0.2 km'),200);near(h.parseLength('1.45 mi'),2333.5488);
 near(h.parseLength('6 nmi'),11112);near(h.parseLength('40 yd'),36.576);near(h.parseLength('40 ft'),12.192);
 near(h.parseLength(`12'5"`),3.7846);assert.equal(h.parseLength('12 abc'),undefined);
});
test('looseLength keeps units and tolerates loose values',()=>{near(h.looseLength('40 ft'),12.192);assert.equal(h.looseLength('3;4'),3);assert.ok(Number.isNaN(h.looseLength()));});
test('the unit of a tag wins over the preference',()=>{
 u.setUnitSystem('imperial');
 assert.equal(u.lengthUnitOf('12'),'m');assert.equal(u.lengthUnitOf('40 ft'),'ft');assert.equal(u.lengthUnitOf(`7'4"`),'ft');
 assert.equal(u.lengthUnitOf('6 nmi'),'m');assert.equal(u.lengthUnitOf(),'ft');assert.equal(u.writeLength(12.192),'40 ft');
 assert.equal(u.withUnit('40','ft'),'40 ft');assert.equal(u.withUnit('5 m','ft'),'5 m');
 u.setUnitSystem('metric');
 assert.equal(u.lengthUnitOf('40 ft'),'ft');assert.equal(u.writeLength(3),'3');assert.equal(u.writeLength(3.048,'40 ft'),'10 ft');
});
test('pushing a height keeps feet',()=>{assert.equal(p.pushHeightTags({height:'40 ft'},'top',3.048,'m').height,'50 ft');});
