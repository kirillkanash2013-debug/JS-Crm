// Admin UI knows only the narrow platform API; it has no client DB binding.
export function createAdminBot({tg,api}){
 const send=(id,text,buttons)=>tg('sendMessage',{chat_id:id,text:String(text).slice(0,4000),...(buttons?{reply_markup:{inline_keyboard:buttons}}:{})});
 const loadText=s=>{
  const totals=(s.usage||[]).reduce((a,u)=>{for(const k of ['jobs','failed','jobMs','containerCalls','containerMs','reports'])a[k]=(a[k]||0)+(u[k]||0);return a;},{});
  return 'Нагрузка JS Control\nАктивные задания: '+s.activeJobs+'\nКонтейнерные запросы: '+s.activeContainerCalls+'\nОтчеты Keitaro: '+(s.activeReports||0)+'\nОжидают разрешения: '+s.waiting+'\nСамое долгое ожидание: '+Math.round((s.oldestWaitMs||0)/1000)+' с\n\nПоследние 90 дней:\nЗаданий: '+totals.jobs+' · ошибок: '+totals.failed+'\nВремя заданий: '+Math.round(totals.jobMs/1000)+' с\nКонтейнерных запросов: '+totals.containerCalls+'\nВремя контейнерных запросов: '+Math.round(totals.containerMs/1000)+' с\n\nВремя запросов не равно оплачиваемому CPU/простоевому времени. Фактическую память и CPU сверяем с мониторингом Cloudflare.';
 };
 async function clients(actor,cursor=''){
  const r=await api(actor,'clients',{cursor});const rows=r.clients||[];
  return send(actor,'Клиенты\n'+(rows.map(c=>c.name+' · '+c.plan+' · до '+c.paidUntil).join('\n')||'Клиентов пока нет.'),[...rows.map(c=>[{text:c.name.slice(0,50),callback_data:'client:'+c.id}]),...(r.nextCursor?[[{text:'Далее',callback_data:'clients:'+r.nextCursor}]]:[])]);
 }
 async function client(actor,id){const c=await api(actor,'client',{tenantId:id});return send(actor,'Клиент: '+c.name+'\nID: '+c.id+'\nПодписка: '+c.plan+' · '+c.status+'\nОплачен до: '+c.paidUntil+'\nПодключений: '+c.socials+'/'+c.socialLimit+'\n\nЛичное сообщение:\n/message '+c.id+' текст',[[{text:'Использование ресурсов',callback_data:'usage:'+c.id}],[{text:'Ошибки',callback_data:'errors:'+c.id}],[{text:'Клиенты',callback_data:'clients:'}]]);}
 async function preview(actor,tenantId,text){const d=await api(actor,'message/preview',{tenantId,text});return send(actor,'Предпросмотр\nПолучатель: '+(tenantId==='*'?'все клиенты с включенными объявлениями':tenantId)+'\n\n'+d.body+'\n\nБез подтверждения сообщение не отправится. Срок подтверждения — 10 минут.',[[{text:'Подтвердить отправку',callback_data:'confirm:'+d.id}],[{text:'Отмена',callback_data:'cancel:'+d.id}]]);}
 const handle=async update=>{
  const q=update.callback_query,m=update.message,actor=String(q?.from?.id||m?.from?.id||'');
  if(q){await tg('answerCallbackQuery',{callback_query_id:q.id});const data=String(q.data||'');
   if(data.startsWith('clients:'))return clients(actor,data.slice(8));
   if(data.startsWith('client:'))return client(actor,data.slice(7));
   if(data.startsWith('usage:'))return send(actor,loadText(await api(actor,'load',{tenantId:data.slice(6)})));
   if(data.startsWith('confirm:')){const r=await api(actor,'message/confirm',{id:data.slice(8)});return send(actor,r.state==='queued'?'Объявление поставлено в очередь. Проверка: /delivery '+r.id:'Сообщение отправлено.');}
   if(data.startsWith('cancel:')){const r=await api(actor,'message/cancel',{id:data.slice(7)});return send(actor,r.cancelled?'Отправка отменена.':'Этот предпросмотр уже подтверждён или отменён.');}
   if(data.startsWith('errors:'))return send(actor,JSON.stringify((await api(actor,'load',{tenantId:data.slice(7)})).usage?.map(u=>({day:u.day,errors:u.errors||{}})),null,2));
   return;
  }
  const text=String(m?.text||'').trim();
  if(text==='/history')return send(actor,JSON.stringify(await api(actor,'history',{}),null,2));
  if(text==='/clients')return clients(actor);
  if(text==='/load')return send(actor,loadText(await api(actor,'load',{})));
  if(text.startsWith('/client '))return client(actor,text.slice(8).trim());
  if(text.startsWith('/delivery '))return send(actor,JSON.stringify(await api(actor,'message/status',{id:text.slice(10).trim()}),null,2));
  const msg=/^\/message\s+([A-Za-z0-9-]+)\s+([\s\S]+)$/.exec(text);if(msg)return preview(actor,msg[1],msg[2]);
  if(text.startsWith('/broadcast '))return preview(actor,'*',text.slice(11));
  return send(actor,'Управление JS Control\n/clients — клиенты и подписки\n/load — общая нагрузка\n/history — история административных отправок\n/client ID — карточка клиента\n/message ID текст — личное сообщение\n/broadcast текст — объявление всем\n/delivery ID — состояние объявления\n\nСообщения требуют отдельного подтверждения. Связки и ключи клиентов здесь недоступны.');
 };
 return async update=>{try{return await handle(update);}catch(e){const actor=String(update.callback_query?.from?.id||update.message?.from?.id||'');return send(actor,e.code==='delivery_unknown'?'Результат доставки неизвестен. Проверьте его перед новой отправкой.':'Операция не выполнена или уже обработана. Проверьте настройку сервиса и состояние отправки.');}};
}
