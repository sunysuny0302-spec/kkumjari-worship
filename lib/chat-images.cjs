'use strict';
const LIMIT=160*1024;
function invalid(){throw Object.assign(new Error('이미지는 JPEG 형식으로 최대 3장, 장당 160KB까지 첨부할 수 있어요.'),{status:400});}
function dimensions(b){
 let i=2;
 while(i+1<b.length){
  if(b[i++]!==255)continue;
  while(i<b.length&&b[i]===255)i++;
  if(i>=b.length)return null;
  const m=b[i++];if(m===0xda||m===0xd9)break;
  if(m===0xd8||m===1||(m>=0xd0&&m<=0xd7))continue;
  if(i+2>b.length)return null;
  const len=b.readUInt16BE(i);if(len<2||i+len>b.length)return null;
  if([0xc0,0xc1,0xc2].includes(m)){if(len<8)return null;return{h:b.readUInt16BE(i+3),w:b.readUInt16BE(i+5)};}
  i+=len;
 }
 return null;
}
function validateImages(value){
 if(value==null)return[];if(!Array.isArray(value)||value.length>3)invalid();
 return value.map(s=>{
  if(typeof s!=='string'||s.length>220000||!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(s))invalid();
  const encoded=s.slice(23),b=Buffer.from(encoded,'base64');
  if(b.toString('base64')!==encoded||b.length>LIMIT||b.length<10||b[0]!==255||b[1]!==216||b.at(-2)!==255||b.at(-1)!==217)invalid();
  const d=dimensions(b);if(!d||d.w<1||d.h<1||d.w>1600||d.h>1600)invalid();return s;
 });
}
function summary(item){const{images,expiresAt,...rest}=item;return{...rest,imageCount:Array.isArray(images)?images.length:0};}
module.exports={validateImages,summary};
