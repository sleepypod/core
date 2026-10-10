# Shared loaders for eval.py and feat2.py: Watch labels per minute from
# records.csv (parse.py) and pod vitals + movement from poddb/biometrics.db.
import sqlite3, csv, math
from datetime import datetime, timedelta, timezone
LA=timezone(timedelta(hours=-7))
c=sqlite3.connect('poddb/biometrics.db')
def p(s): return datetime.strptime(s, '%Y-%m-%d %H:%M:%S %z')
rows=[r for r in csv.DictReader(open('records.csv'))]
M={'AsleepCore':'light','AsleepDeep':'deep','AsleepREM':'rem','Awake':'wake'}
wl={}
for r in rows:
    if 'Watch' in r['source'] and r['type']=='SleepAnalysis':
        v=M.get(r['value'].replace('HKCategoryValueSleepAnalysis',''))
        if not v: continue
        t=p(r['start']).replace(second=0); e=p(r['end'])
        while t<e: wl[int(t.timestamp())//60]=v; t+=timedelta(minutes=1)
nights={'10-08':('left',datetime(2026,10,9,2,0,tzinfo=LA),datetime(2026,10,9,8,20,tzinfo=LA)),
        '10-09':('left',datetime(2026,10,10,3,10,tzinfo=LA),datetime(2026,10,10,11,5,tzinfo=LA))}
STAGES=('wake','light','deep','rem')
def bucket5(t): return math.floor(t/300+0.5)*300  # JS Math.round(ts / 300_000) * 300_000
def rows_for(side,a,b):
    """One dict per vitals row. `mov` is that minute's movement row; `mov5` is
    what classifySleepStages (src/lib/sleep-stages.ts) looks up: the last
    movement row whose rounded 5-minute bucket matches the vitals row's."""
    v=c.execute("select timestamp,heart_rate,hrv,breathing_rate from vitals where side=? and timestamp between ? and ? order by timestamp",(side,a.timestamp(),b.timestamp())).fetchall()
    mv=c.execute("select timestamp,total_movement from movement where side=? and timestamp between ? and ? order by timestamp",(side,a.timestamp(),b.timestamp())).fetchall()
    m={int(t)//60:x for t,x in mv}
    m5={bucket5(t):x for t,x in mv}
    out=[]
    for t,hr,hrv,br in v:
        k=int(t)//60
        out.append(dict(t=t,k=k,hr=hr,hrv=hrv,br=br,mov=m.get(k),mov5=m5.get(bucket5(t)),w=wl.get(k)))
    return out
