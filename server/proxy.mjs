import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
export function publicIPv4(ip){if(isIP(ip)!==4)return false;const [a,b]=ip.split('.').map(Number);return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&b===168||a===100&&b>=64&&b<=127||a===192&&b===0||a===198&&(b===18||b===19));}
export async function publicProxy(proxy){
 if(!proxy)return undefined;const u=new URL(proxy.server);
 // Pin DNS resolution, so a client-controlled hostname cannot rebind to server LAN.
 if(!['http:','socks5:'].includes(u.protocol))throw new Error('HTTP or SOCKS5 public proxy required');
 const addresses=await lookup(u.hostname,{all:true,family:4});if(!addresses.length||addresses.some(a=>!publicIPv4(a.address)))throw new Error('Private proxies are forbidden');
 return {...proxy,server:u.protocol+'//'+addresses[0].address+':'+(u.port||'80')};
}
