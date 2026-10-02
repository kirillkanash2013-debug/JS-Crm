// Executed on demand in the isolated world. Never reads cookies or page tokens.
export function captureVisible() {
  const u=new URL(location.href);
  const id=(u.searchParams.get("act") || "").replace(/^act_/,"");
  const text=el=>String(el.innerText || el.textContent || "").replace(/\s+/g," ").trim().slice(0,500);
  const visible=el=>el.getClientRects().length > 0;
  const tables=[];
  for(const root of [...document.querySelectorAll('[role="grid"],[role="table"],table')].filter(visible).slice(0,4)) {
    const headers=[...root.querySelectorAll('[role="columnheader"],thead th')].filter(visible).map(text).slice(0,40);
    const rows=[];
    for(const row of [...root.querySelectorAll('[role="row"],tbody tr')].filter(visible)) {
      if(row.querySelector('[role="columnheader"],thead th')) continue;
      const cells=[...row.querySelectorAll('[role="gridcell"],[role="cell"],td')].filter(visible);
      if(cells.length) rows.push(cells.slice(0,40).map(text));
      if(rows.length>=200) break;
    }
    if(headers.length || rows.length) tables.push({headers,rows});
  }
  return {accountId:id,title:document.title,tables,visibleRowCount:tables.reduce((s,t)=>s+t.rows.length,0)};
}
