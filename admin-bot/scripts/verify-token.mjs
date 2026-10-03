export async function verifyToken({token,clientToken,username,fetcher=fetch}){
 if(!token||token===clientToken)throw new Error('A separate ADMIN_BOT_TOKEN is required');
 const r=await fetcher('https://api.telegram.org/bot'+token+'/getMe',{method:'POST',signal:AbortSignal.timeout(20000)});
 const value=await r.json();
 if(!r.ok||!value.ok||!value.result?.is_bot)throw new Error('Telegram rejected the administrative bot token');
 if(username&&String(value.result.username||'').toLowerCase()!==username.replace(/^@/,'').toLowerCase())throw new Error('ADMIN_BOT_TOKEN belongs to a different bot');
 return value.result.username;
}
