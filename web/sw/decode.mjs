const ASCII=new TextDecoder("windows-1252");
const WINDOWS_1252_NATIVE=ASCII.decode(Uint8Array.of(0x80))==="€";
const WINDOWS_1252_C1="\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178";
function decodeWindows1252(payload){const chunks=[];for(let offset=0;offset<payload.length;offset+=8192){const end=Math.min(offset+8192,payload.length),codes=[];for(let index=offset;index<end;index+=1){const byte=payload[index];codes.push(byte>=0x80&&byte<=0x9f?WINDOWS_1252_C1.charCodeAt(byte-0x80):byte)}chunks.push(String.fromCharCode(...codes))}return chunks.join("")}
function transportLabel(contentType){const match=String(contentType??"").match(/(?:^|;)\s*charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s;]+))/i);return match?.[1]??match?.[2]??match?.[3]??null}
function metaLabel(bytes){
  const source=ASCII.decode(bytes.subarray(0,Math.min(bytes.length,1024)));
  for(let offset=0;offset<source.length;){
    const start=source.indexOf("<",offset);if(start<0)break;
    if(source.startsWith("<!--",start)){const end=source.indexOf("-->",start+4);offset=end<0?source.length:end+3;continue}
    if(!/^<meta(?:[\s/>])/i.test(source.slice(start))){offset=start+1;continue}
    let quote="",end=start+5;
    for(;end<source.length;end++){const character=source[end];if(quote){if(character===quote)quote=""}else if(character==='"'||character==="'")quote=character;else if(character===">")break}
    if(end===source.length)break;
    const tag=source.slice(start,end+1),direct=tag.match(/\bcharset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'=<>`]+))/i);
    if(direct)return direct[1]??direct[2]??direct[3];
    const equiv=/\bhttp-equiv\s*=\s*(?:"\s*content-type\s*"|'\s*content-type\s*'|content-type\b)/i.test(tag),content=tag.match(/\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i);
    if(equiv&&content){const nested=transportLabel(content[1]??content[2]??content[3]);if(nested)return nested}
    offset=end+1;
  }
  return null
}
function decoderFor(label){let normalized;try{normalized=new TextDecoder(label).encoding}catch{throw new DOMException("Unsupported document encoding","EncodingError")}if(normalized==="replacement")throw new DOMException("Unsupported document encoding","EncodingError");return normalized}
function bomEncoding(bytes){if(bytes.length>=3&&bytes[0]===0xef&&bytes[1]===0xbb&&bytes[2]===0xbf)return{label:"utf-8",offset:3,source:"bom"};if(bytes.length>=2&&bytes[0]===0xff&&bytes[1]===0xfe)return{label:"utf-16le",offset:2,source:"bom"};if(bytes.length>=2&&bytes[0]===0xfe&&bytes[1]===0xff)return{label:"utf-16be",offset:2,source:"bom"};return null}
function declaredEncoding(bytes,contentType){let label=transportLabel(contentType),source=label?"transport":"meta";if(!label)label=metaLabel(bytes);if(!label){label="windows-1252";source="default"}return{label,offset:0,source}}
function normalizeHTMLDecoding(label,source){let encoding=decoderFor(label);if(source!=="bom"&&(encoding==="utf-16le"||encoding==="utf-16be"))encoding="utf-8";return encoding==="x-user-defined"?"windows-1252":encoding}
function decodePayload(payload,encoding){if(encoding==="windows-1252"&&!WINDOWS_1252_NATIVE)return{text:decodeWindows1252(payload),replacement:false};try{return{text:new TextDecoder(encoding,{fatal:true}).decode(payload),replacement:false}}catch{return{text:new TextDecoder(encoding).decode(payload),replacement:true}}}
export function decodeHTML(input,contentType=""){const bytes=input instanceof Uint8Array?input:new Uint8Array(input),selection=bomEncoding(bytes)??declaredEncoding(bytes,contentType),encoding=normalizeHTMLDecoding(selection.label,selection.source),decoded=decodePayload(bytes.subarray(selection.offset),encoding);return Object.freeze({...decoded,encoding_used:encoding,source:selection.source})}
