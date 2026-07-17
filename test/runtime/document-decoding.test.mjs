import assert from "node:assert/strict";
import test from "node:test";
import { decodeHTML } from "../../web/sw/decode.mjs";

const encode=value=>new TextEncoder().encode(value);

test("BOM overrides transport and is removed exactly once",()=>{const bytes=Uint8Array.from([0xef,0xbb,0xbf,...encode("€")]),result=decodeHTML(bytes,"text/html;charset=windows-1252");assert.deepEqual(result,{text:"€",encoding_used:"utf-8",replacement:false,source:"bom"})});
test("transport label overrides a conflicting meta",()=>{const bytes=Uint8Array.from([0x3c,0x6d,0x65,0x74,0x61,0x20,0x63,0x68,0x61,0x72,0x73,0x65,0x74,0x3d,0x75,0x74,0x66,0x2d,0x38,0x3e,0x80]),result=decodeHTML(bytes,"text/html; charset=windows-1252");assert.equal(result.text.endsWith("€"),true);assert.equal(result.encoding_used,"windows-1252");assert.equal(result.source,"transport")});
test("meta prescan and default windows-1252 follow HTML rules",()=>{const meta=Uint8Array.from([...encode("<meta charset=windows-1252>"),0x80]),sniffed=decodeHTML(meta),fallback=decodeHTML(Uint8Array.of(0x80));assert.equal(sniffed.text.endsWith("€"),true);assert.equal(sniffed.source,"meta");assert.deepEqual(fallback,{text:"€",encoding_used:"windows-1252",replacement:false,source:"default"})});
test("windows-1252 covers every byte across decoder chunk boundaries",()=>{
  const c1=[0x20ac,0x0081,0x201a,0x0192,0x201e,0x2026,0x2020,0x2021,0x02c6,0x2030,0x0160,0x2039,0x0152,0x008d,0x017d,0x008f,0x0090,0x2018,0x2019,0x201c,0x201d,0x2022,0x2013,0x2014,0x02dc,0x2122,0x0161,0x203a,0x0153,0x009d,0x017e,0x0178];
  const bytes=Uint8Array.from({length:256*33},(_,index)=>index%256);
  const expected=Array.from(bytes,byte=>String.fromCodePoint(byte>=0x80&&byte<=0x9f?c1[byte-0x80]:byte)).join("");
  const result=decodeHTML(bytes,"text/html;charset=windows-1252");
  assert.equal(result.text,expected);
  assert.equal(result.replacement,false);
  assert.equal(result.encoding_used,"windows-1252");
});
test("malformed input reports replacement without returning raw bytes",()=>{const result=decodeHTML(Uint8Array.of(0xc3,0x28),"text/html;charset=utf-8");assert.equal(result.text,"�(");assert.equal(result.replacement,true)});
test("unknown transport labels fail closed",()=>assert.throws(()=>decodeHTML(encode("x"),"text/html;charset=definitely-unknown"),error=>error.name==="EncodingError"));
test("meta prescan ignores comments and escaped markup",()=>{
  const comment=Uint8Array.from([...encode("<!-- <meta charset=utf-8> -->"),0x80]);
  const escaped=Uint8Array.from([...encode("&lt;meta charset=utf-8&gt;"),0x80]);
  for(const bytes of [comment,escaped]){
    const result=decodeHTML(bytes);
    assert.equal(result.encoding_used,"windows-1252");
    assert.equal(result.source,"default");
    assert.equal(result.text.endsWith("€"),true);
  }
});
